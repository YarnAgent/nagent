import { sign as edSign, verify as edVerify, randomBytes, type KeyObject, generateKeyPairSync } from "node:crypto";
import { publicKeyFromRaw, privateKeyFromRaw } from "../ssh/identity.js";

export const INVITE_VERSION = 1;

export interface InviteAddr {
  host: string;
  port: number;
}

export interface InvitePayload {
  v: typeof INVITE_VERSION;
  netId: string;
  netName: string;
  inviteId: string;             // random; tags the one-time authorized_keys line on the issuer
  issuerNode: string;
  issuerPub: string;            // base64url raw 32 bytes
  issuerSshUser: string;
  issuerAddrs: InviteAddr[];
  oneTimePub: string;           // base64url raw 32 bytes
  oneTimePriv: string;          // base64url raw 32 bytes
  nonce: string;                // base64url
  expiresAt: string;            // ISO
  flags?: { reusable?: boolean; tags?: Record<string, string> };
}

export interface InviteToken extends InvitePayload {
  sig: string; // base64url ed25519 sig over canonical JSON(payload sans sig)
}

/** Generate a fresh one-time ed25519 keypair (raw 32-byte halves, base64url). */
export function generateOneTimeKey(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  return { pub: pubJwk.x, priv: privJwk.d };
}

export function newInviteId(): string {
  return randomBytes(8).toString("base64url");
}

export function newNonce(): string {
  return randomBytes(12).toString("base64url");
}

/** Encode + sign an invite token. The signing key must be the issuer's long-term private. */
export function encodeToken(payload: InvitePayload, issuerLongTermPriv: KeyObject): string {
  const canonical = canonicalJson(payload);
  const sigBytes = edSign(null, Buffer.from(canonical, "utf8"), issuerLongTermPriv);
  const wrapper: InviteToken = { ...payload, sig: sigBytes.toString("base64url") };
  return Buffer.from(canonicalJson(wrapper), "utf8").toString("base64url");
}

/** Decode and verify the signature. Throws on tampering, malformed, or unknown version. */
export function decodeAndVerify(token: string): InviteToken {
  let json: string;
  try {
    json = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new Error("invite: malformed token (not base64url)");
  }
  let wrapper: InviteToken;
  try {
    wrapper = JSON.parse(json) as InviteToken;
  } catch {
    throw new Error("invite: malformed token (not JSON)");
  }
  if (wrapper.v !== INVITE_VERSION) {
    throw new Error(`invite: unsupported version ${wrapper.v} (need ${INVITE_VERSION})`);
  }
  if (!wrapper.sig) throw new Error("invite: missing signature");

  const { sig, ...payload } = wrapper;
  const canonical = canonicalJson(payload);
  const issuerPubRaw = Buffer.from(payload.issuerPub, "base64url");
  if (issuerPubRaw.length !== 32) throw new Error("invite: malformed issuerPub");
  const pubKey = publicKeyFromRaw(issuerPubRaw);
  const sigBytes = Buffer.from(sig, "base64url");
  if (!edVerify(null, Buffer.from(canonical, "utf8"), pubKey, sigBytes)) {
    throw new Error("invite: signature verification failed");
  }
  return wrapper;
}

/** Throws if the token has expired (otherwise returns ms remaining). */
export function assertNotExpired(token: InviteToken, now = new Date()): number {
  const exp = Date.parse(token.expiresAt);
  if (Number.isNaN(exp)) throw new Error(`invite: bad expiresAt: ${token.expiresAt}`);
  const remaining = exp - now.getTime();
  if (remaining <= 0) throw new Error(`invite: token expired at ${token.expiresAt}`);
  return remaining;
}

/** Reconstruct the one-time SSH private key as a KeyObject (for spawning ssh). */
export function oneTimePrivKey(token: InviteToken): KeyObject {
  const priv = Buffer.from(token.oneTimePriv, "base64url");
  const pub = Buffer.from(token.oneTimePub, "base64url");
  if (priv.length !== 32 || pub.length !== 32) {
    throw new Error("invite: malformed oneTimePub/oneTimePriv");
  }
  return privateKeyFromRaw(priv, pub);
}

/** Compute a deterministic byte string for signature purposes. */
function canonicalJson(obj: unknown): string {
  // We use the JSON.stringify deterministic property as long as keys are
  // serialized in insertion order. For our payload objects we control creation
  // order in encodeToken; for verify-side we reconstruct in the same order.
  // To make this robust against future field reordering, sort keys.
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = sortKeys((x as Record<string, unknown>)[k]);
    }
    return out;
  }
  return x;
}
