import { promises as fs } from "node:fs";
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { paths } from "../platform/paths.js";

export interface SshKeypair {
  /** PEM-encoded private key in OpenSSH format. Suitable as the `-i` argument to `ssh`. */
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
 * Load the node's long-term ed25519 keypair from `~/.nagent/ssh/nagent_ed25519`.
 * Modern OpenSSH only accepts its own key format for ed25519 `-i` identities; if
 * the on-disk file is the legacy PKCS#8 PEM (from v0.2 ≤ 96e2ce5), it is rewritten
 * in OpenSSH format on first read so subsequent `ssh -i` calls work.
 */
export async function loadSshKeypair(nodeId: string): Promise<SshKeypair> {
  let pem = await fs.readFile(paths().sshKey, "utf8");
  let rawPriv: Buffer;
  let rawPub: Buffer;
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    ({ rawPriv, rawPub } = parseOpensshEd25519(pem));
  } else {
    const legacyPriv = createPrivateKey({ key: pem, format: "pem" });
    const legacyPub = createPublicKey(legacyPriv);
    const dJwk = legacyPriv.export({ format: "jwk" }) as { d: string };
    const xJwk = legacyPub.export({ format: "jwk" }) as { x: string };
    rawPriv = Buffer.from(dJwk.d, "base64url");
    rawPub = Buffer.from(xJwk.x, "base64url");
    pem = opensshEd25519Pem(rawPriv, rawPub, `nagent-${nodeId}`);
    await fs.writeFile(paths().sshKey, pem, { mode: 0o600 });
  }
  return {
    privPem: pem,
    privKey: privateKeyFromRaw(rawPriv, rawPub),
    pubKey: publicKeyFromRaw(rawPub),
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

/**
 * Build an OpenSSH-format ed25519 private key PEM from raw 32-byte halves.
 * This is the only key format `ssh -i` accepts cross-platform for ed25519 —
 * PKCS#8 PEM is rejected with "invalid format" by OpenSSH ≥ 8.x on macOS.
 *
 * Layout (see PROTOCOL.key in the OpenSSH source):
 *   "openssh-key-v1\0" || str("none") || str("none") || str("") || u32(1)
 *   || str(pub_blob) || str(priv_section_padded)
 * where pub_blob = str("ssh-ed25519") || str(rawPub32)
 * and   priv_section = u32(c) u32(c) str("ssh-ed25519") str(rawPub32)
 *                     str(rawPriv32||rawPub32) str(comment), padded to 8 bytes.
 */
export function opensshEd25519Pem(
  rawPriv32: Buffer,
  rawPub32: Buffer,
  comment: string,
): string {
  if (rawPriv32.length !== 32 || rawPub32.length !== 32) {
    throw new Error(`ed25519 halves must be 32 bytes; got ${rawPriv32.length}/${rawPub32.length}`);
  }
  const str = (s: string | Buffer): Buffer => {
    const body = typeof s === "string" ? Buffer.from(s, "utf8") : s;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return Buffer.concat([head, body]);
  };
  const pubBlob = Buffer.concat([str("ssh-ed25519"), str(rawPub32)]);
  const checkint = randomBytes(4);
  const inner = Buffer.concat([
    checkint, checkint,
    str("ssh-ed25519"),
    str(rawPub32),
    str(Buffer.concat([rawPriv32, rawPub32])),
    str(comment),
  ]);
  const padLen = (8 - (inner.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  const innerPadded = Buffer.concat([inner, pad]);

  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "utf8"),
    str("none"),
    str("none"),
    str(""),
    numKeys,
    str(pubBlob),
    str(innerPadded),
  ]);
  const b64 = blob.toString("base64");
  const wrapped = (b64.match(/.{1,70}/g) ?? [b64]).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Parse an OpenSSH-format ed25519 private key PEM into raw 32-byte halves. */
export function parseOpensshEd25519(pem: string): { rawPriv: Buffer; rawPub: Buffer } {
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----\s*([\s\S]+?)\s*-----END OPENSSH PRIVATE KEY-----/);
  if (!m || !m[1]) throw new Error("openssh key: missing PEM envelope");
  const blob = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  let off = 0;
  const magic = "openssh-key-v1\0";
  if (blob.subarray(0, magic.length).toString("utf8") !== magic) {
    throw new Error("openssh key: bad magic");
  }
  off += magic.length;
  const readStr = (src: Buffer, refOff: { o: number }): Buffer => {
    if (refOff.o + 4 > src.length) throw new Error("openssh key: truncated");
    const n = src.readUInt32BE(refOff.o);
    refOff.o += 4;
    if (refOff.o + n > src.length) throw new Error("openssh key: truncated body");
    const b = src.subarray(refOff.o, refOff.o + n);
    refOff.o += n;
    return b;
  };
  const ref = { o: off };
  const cipher = readStr(blob, ref).toString("utf8");
  if (cipher !== "none") throw new Error(`openssh key: encrypted (cipher=${cipher})`);
  readStr(blob, ref); // kdfname
  readStr(blob, ref); // kdfoptions
  if (ref.o + 4 > blob.length) throw new Error("openssh key: truncated numkeys");
  const numKeys = blob.readUInt32BE(ref.o);
  ref.o += 4;
  if (numKeys !== 1) throw new Error(`openssh key: numKeys=${numKeys} not supported`);
  readStr(blob, ref); // public key blob (we read raw pub from the inner section)
  const inner = readStr(blob, ref);
  const innerRef = { o: 0 };
  innerRef.o += 4; innerRef.o += 4; // checkint1, checkint2
  const keytype = readStr(inner, innerRef).toString("utf8");
  if (keytype !== "ssh-ed25519") throw new Error(`openssh key: keytype=${keytype} not supported`);
  const rawPub = readStr(inner, innerRef);
  const combined = readStr(inner, innerRef);
  if (rawPub.length !== 32 || combined.length !== 64) {
    throw new Error(`openssh key: ed25519 fields wrong size (pub=${rawPub.length}, combined=${combined.length})`);
  }
  return { rawPriv: combined.subarray(0, 32), rawPub };
}
