import { promises as fs } from "node:fs";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { paths } from "../platform/paths.js";

export interface SshKeypair {
  /** PEM-encoded private key (PKCS#8). Suitable as the `-i` argument to `ssh`. */
  privPem: string;
  /** KeyObject for `sign`/`verify`. */
  privKey: KeyObject;
  /** KeyObject for `verify`. */
  pubKey: KeyObject;
  /** Raw 32 bytes of the ed25519 private (the JWK `d` field). */
  rawPriv: Buffer;
  /** Raw 32 bytes of the ed25519 public (the JWK `x` field). */
  rawPub: Buffer;
  /** Single-line authorized_keys entry (`ssh-ed25519 <base64> nagent-<nodeId>`). */
  authorizedKeysLine: string;
}

/**
 * Load the node's long-term ed25519 keypair from `~/.nagent/ssh/nagent_ed25519`
 * and produce all formats nagent needs. Bootstrap has already created this file
 * as PEM PKCS#8 (modern OpenSSH accepts that for ed25519).
 */
export async function loadSshKeypair(nodeId: string): Promise<SshKeypair> {
  const pem = await fs.readFile(paths().sshKey, "utf8");
  const privKey = createPrivateKey({ key: pem, format: "pem" });
  const pubKey = createPublicKey(privKey);
  const privJwk = privKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = pubKey.export({ format: "jwk" }) as { x: string };
  const rawPriv = Buffer.from(privJwk.d, "base64url");
  const rawPub = Buffer.from(pubJwk.x, "base64url");
  return {
    privPem: pem,
    privKey,
    pubKey,
    rawPriv,
    rawPub,
    authorizedKeysLine: sshAuthorizedKeysLine(rawPub, `nagent-${nodeId}`),
  };
}

/**
 * Build an SSH authorized_keys / OpenSSH-format line for an ed25519 public key.
 * The blob is `uint32(11) "ssh-ed25519" uint32(32) <32-byte-pub>` base64'd.
 */
export function sshAuthorizedKeysLine(rawPub32: Buffer, comment: string): string {
  if (rawPub32.length !== 32) {
    throw new Error(`ed25519 pubkey must be 32 bytes; got ${rawPub32.length}`);
  }
  const prefix = Buffer.from("ssh-ed25519", "utf8");
  const blob = Buffer.alloc(4 + prefix.length + 4 + 32);
  let o = 0;
  blob.writeUInt32BE(prefix.length, o); o += 4;
  prefix.copy(blob, o); o += prefix.length;
  blob.writeUInt32BE(32, o); o += 4;
  rawPub32.copy(blob, o);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

/** Construct a `KeyObject` for an ed25519 raw 32-byte public key. */
export function publicKeyFromRaw(raw32: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw32.toString("base64url") },
    format: "jwk",
  });
}

/** Construct a `KeyObject` for an ed25519 raw 32-byte private key. */
export function privateKeyFromRaw(rawPriv32: Buffer, rawPub32: Buffer): KeyObject {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: rawPriv32.toString("base64url"),
      x: rawPub32.toString("base64url"),
    },
    format: "jwk",
  });
}
