// Self-signed TLS cert for the relay daemon at ~/.nagent/relay/{cert,key}.pem.
// Same shape as src/web/cert.ts; intentionally separate file so the two
// services have independent cert lifecycles. (A platform/selfsigned helper
// would dedupe; deferred until a third caller materializes.)

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { createHash, X509Certificate } from "node:crypto";
import selfsigned from "selfsigned";
import { paths } from "../platform/paths.js";

export interface RelayCert {
  cert: string;          // PEM
  key: string;           // PEM
  fingerprint: string;   // sha256 hex, colon-separated bytes
  subject: string;
  notAfter: string;      // ISO timestamp
}

const CERT_VALIDITY_DAYS = 365 * 5;

/**
 * Load the relay daemon's self-signed cert from disk, generating one on
 * first run. Stored under ~/.nagent/relay/{cert,key}.pem (0600).
 *
 * `altNames` should include the hostname plus every reachable IP/DNS the
 * relay is advertised on. Clients still see the self-signed warning until
 * they `nagent relay add` to pin the fingerprint — the SAN entries only
 * fix the "name mismatch" arm of the warning.
 */
export async function loadOrGenerateRelayCert(altNames: string[]): Promise<RelayCert> {
  const certPath = paths().relayCert;
  const keyPath = paths().relayKey;

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    return { cert, key, ...parseCertMeta(cert) };
  } catch {
    return await generateAndPersist(altNames);
  }
}

async function generateAndPersist(altNames: string[]): Promise<RelayCert> {
  const cn = hostname() || "nagent-relay";
  const attrs = [{ name: "commonName", value: cn }];
  const sanEntries: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
    { type: 2, value: cn },
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];
  for (const a of altNames) {
    if (isIp(a)) sanEntries.push({ type: 7, ip: a });
    else sanEntries.push({ type: 2, value: a });
  }
  const extensions = [
    { name: "basicConstraints" as const, cA: false },
    { name: "keyUsage" as const, digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage" as const, serverAuth: true },
    { name: "subjectAltName" as const, altNames: sanEntries },
  ];
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    notAfterDate: new Date(Date.now() + CERT_VALIDITY_DAYS * 86_400_000),
    algorithm: "sha256",
    extensions,
  });

  await fs.mkdir(dirname(paths().relayCert), { recursive: true, mode: 0o700 });
  await fs.writeFile(paths().relayCert, pems.cert, { mode: 0o600 });
  await fs.writeFile(paths().relayKey, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, ...parseCertMeta(pems.cert) };
}

function parseCertMeta(pem: string): { fingerprint: string; subject: string; notAfter: string } {
  const x = new X509Certificate(pem);
  return {
    fingerprint: x.fingerprint256,
    subject: x.subject,
    notAfter: new Date(x.validToDate).toISOString(),
  };
}

function isIp(s: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes(":");
}

/**
 * Compute the SHA-256 fingerprint of a PEM cert, formatted as colon-
 * separated uppercase hex bytes (matching browsers' display format).
 * Used by `nagent relay add` to display + pin.
 */
export function certFingerprintSha256(pem: string): string {
  const der = pemToDer(pem);
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}
