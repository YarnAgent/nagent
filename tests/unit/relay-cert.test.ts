import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrGenerateRelayCert, certFingerprintSha256 } from "../../src/relay/cert.js";
import { paths } from "../../src/platform/paths.js";

describe("relay cert — self-signed lifecycle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-relay-cert-"));
    process.env.NAGENT_HOME = dir;
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a cert + key on first call and persists them at 0600", async () => {
    const c = await loadOrGenerateRelayCert(["wsl26", "100.85.141.122"]);
    expect(c.cert).toMatch(/BEGIN CERTIFICATE/);
    expect(c.key).toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(c.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(new Date(c.notAfter).getTime()).toBeGreaterThan(Date.now());

    const certStat = await stat(paths().relayCert);
    const keyStat = await stat(paths().relayKey);
    // permission check is best-effort on filesystems that mask mode
    expect(certStat.mode & 0o777).toBe(0o600);
    expect(keyStat.mode & 0o777).toBe(0o600);
  });

  it("returns the existing cert on second call (no rotation)", async () => {
    const a = await loadOrGenerateRelayCert(["wsl26"]);
    const b = await loadOrGenerateRelayCert(["wsl26"]);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.cert).toBe(a.cert);
  });

  it("certFingerprintSha256 matches the X509-parsed fingerprint", async () => {
    const c = await loadOrGenerateRelayCert(["wsl26"]);
    const pem = await readFile(paths().relayCert, "utf8");
    expect(certFingerprintSha256(pem)).toBe(c.fingerprint);
  });
});
