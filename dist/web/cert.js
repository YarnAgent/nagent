import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { createHash, X509Certificate } from "node:crypto";
import selfsigned from "selfsigned";
import { paths } from "../platform/paths.js";
const CERT_VALIDITY_DAYS = 365 * 5; // 5 years — self-signed, no rotation story yet
/**
 * Load the hub's self-signed cert from disk, generating one on first run.
 * Cert lives under ~/.nagent/web/{cert,key}.pem (mode 0600).
 *
 * Cert is RSA 2048 with the node's hostname + every reachable IP in the SAN
 * so clients can connect via either DNS-ish names or raw IPs without name
 * mismatch warnings (they'll still see the self-signed warning until they
 * `nagent web trust` the fingerprint).
 */
export async function loadOrGenerateHubCert(altNames) {
    const certPath = paths().webCert;
    const keyPath = paths().webKey;
    try {
        const cert = await fs.readFile(certPath, "utf8");
        const key = await fs.readFile(keyPath, "utf8");
        const meta = parseCertMeta(cert);
        return { cert, key, ...meta };
    }
    catch {
        return await generateAndPersist(altNames);
    }
}
async function generateAndPersist(altNames) {
    const cn = hostname() || "nagent-web";
    const attrs = [{ name: "commonName", value: cn }];
    const sanEntries = [
        { type: 2, value: cn },
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
    ];
    for (const a of altNames) {
        if (isIp(a))
            sanEntries.push({ type: 7, ip: a });
        else
            sanEntries.push({ type: 2, value: a });
    }
    const extensions = [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: sanEntries },
    ];
    const pems = await selfsigned.generate(attrs, {
        keySize: 2048,
        notAfterDate: new Date(Date.now() + CERT_VALIDITY_DAYS * 86_400_000),
        algorithm: "sha256",
        extensions,
    });
    await fs.mkdir(dirname(paths().webCert), { recursive: true, mode: 0o700 });
    await fs.writeFile(paths().webCert, pems.cert, { mode: 0o600 });
    await fs.writeFile(paths().webKey, pems.private, { mode: 0o600 });
    const meta = parseCertMeta(pems.cert);
    return { cert: pems.cert, key: pems.private, ...meta };
}
/**
 * Parse the cert PEM to extract subject + notAfter + SHA-256 fingerprint.
 * Uses Node's built-in X509Certificate so we don't need an extra parser dep.
 */
function parseCertMeta(pem) {
    const x = new X509Certificate(pem);
    return {
        fingerprint: x.fingerprint256, // already colon-separated hex
        subject: x.subject,
        notAfter: new Date(x.validToDate).toISOString(),
    };
}
function isIp(s) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes(":");
}
/**
 * Compute the same kind of fingerprint that browsers display when they show
 * a self-signed-cert warning. Used by `nagent web trust` to display + pin.
 */
export function certFingerprintSha256(pem) {
    const der = pemToDer(pem);
    const hash = createHash("sha256").update(der).digest("hex").toUpperCase();
    return hash.match(/.{2}/g).join(":");
}
function pemToDer(pem) {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/g, "")
        .replace(/-----END [^-]+-----/g, "")
        .replace(/\s+/g, "");
    return Buffer.from(body, "base64");
}
//# sourceMappingURL=cert.js.map