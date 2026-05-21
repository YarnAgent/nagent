import { sign as edSign, verify as edVerify, randomBytes, generateKeyPairSync } from "node:crypto";
import { publicKeyFromRaw, privateKeyFromRaw } from "../ssh/identity.js";
import { canonicalJson } from "../lib/canonical.js";
export const INVITE_VERSION = 1;
/** Generate a fresh one-time ed25519 keypair (raw 32-byte halves, base64url). */
export function generateOneTimeKey() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubJwk = publicKey.export({ format: "jwk" });
    const privJwk = privateKey.export({ format: "jwk" });
    return { pub: pubJwk.x, priv: privJwk.d };
}
export function newInviteId() {
    return randomBytes(8).toString("base64url");
}
export function newNonce() {
    return randomBytes(12).toString("base64url");
}
/** Encode + sign an invite token. The signing key must be the issuer's long-term private. */
export function encodeToken(payload, issuerLongTermPriv) {
    const canonical = canonicalJson(payload);
    const sigBytes = edSign(null, Buffer.from(canonical, "utf8"), issuerLongTermPriv);
    const wrapper = { ...payload, sig: sigBytes.toString("base64url") };
    return Buffer.from(canonicalJson(wrapper), "utf8").toString("base64url");
}
/** Decode and verify the signature. Throws on tampering, malformed, or unknown version. */
export function decodeAndVerify(token) {
    let json;
    try {
        json = Buffer.from(token, "base64url").toString("utf8");
    }
    catch {
        throw new Error("invite: malformed token (not base64url)");
    }
    let wrapper;
    try {
        wrapper = JSON.parse(json);
    }
    catch {
        throw new Error("invite: malformed token (not JSON)");
    }
    if (wrapper.v !== INVITE_VERSION) {
        throw new Error(`invite: unsupported version ${wrapper.v} (need ${INVITE_VERSION})`);
    }
    if (!wrapper.sig)
        throw new Error("invite: missing signature");
    const { sig, ...payload } = wrapper;
    const canonical = canonicalJson(payload);
    const issuerPubRaw = Buffer.from(payload.issuerPub, "base64url");
    if (issuerPubRaw.length !== 32)
        throw new Error("invite: malformed issuerPub");
    const pubKey = publicKeyFromRaw(issuerPubRaw);
    const sigBytes = Buffer.from(sig, "base64url");
    if (!edVerify(null, Buffer.from(canonical, "utf8"), pubKey, sigBytes)) {
        throw new Error("invite: signature verification failed");
    }
    return wrapper;
}
/** Throws if the token has expired (otherwise returns ms remaining). */
export function assertNotExpired(token, now = new Date()) {
    const exp = Date.parse(token.expiresAt);
    if (Number.isNaN(exp))
        throw new Error(`invite: bad expiresAt: ${token.expiresAt}`);
    const remaining = exp - now.getTime();
    if (remaining <= 0)
        throw new Error(`invite: token expired at ${token.expiresAt}`);
    return remaining;
}
/** Reconstruct the one-time SSH private key as a KeyObject (for spawning ssh). */
export function oneTimePrivKey(token) {
    const priv = Buffer.from(token.oneTimePriv, "base64url");
    const pub = Buffer.from(token.oneTimePub, "base64url");
    if (priv.length !== 32 || pub.length !== 32) {
        throw new Error("invite: malformed oneTimePub/oneTimePriv");
    }
    return privateKeyFromRaw(priv, pub);
}
//# sourceMappingURL=index.js.map