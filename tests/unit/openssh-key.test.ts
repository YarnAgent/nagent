import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opensshEd25519Pem,
  parseOpensshEd25519,
  sshAuthorizedKeysLine,
} from "../../src/ssh/identity.js";

function rawHalves(): { rawPriv: Buffer; rawPub: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const xJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const dJwk = privateKey.export({ format: "jwk" }) as { d: string };
  return {
    rawPub: Buffer.from(xJwk.x, "base64url"),
    rawPriv: Buffer.from(dJwk.d, "base64url"),
  };
}

describe("opensshEd25519Pem", () => {
  it("round-trips raw halves through PEM", () => {
    const { rawPriv, rawPub } = rawHalves();
    const pem = opensshEd25519Pem(rawPriv, rawPub, "test-comment");
    expect(pem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(pem).toMatch(/-----END OPENSSH PRIVATE KEY-----\n$/);
    const parsed = parseOpensshEd25519(pem);
    expect(parsed.rawPriv.equals(rawPriv)).toBe(true);
    expect(parsed.rawPub.equals(rawPub)).toBe(true);
  });

  it("rejects 31-byte halves", () => {
    expect(() => opensshEd25519Pem(Buffer.alloc(31), Buffer.alloc(32), "x"))
      .toThrow(/32 bytes/);
  });

  it("emits a PEM that ssh-keygen can read and that yields the matching public key", async () => {
    const probe = spawnSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    if (probe.error) return; // skip if ssh-keygen missing

    const { rawPriv, rawPub } = rawHalves();
    const dir = await mkdtemp(join(tmpdir(), "nagent-key-"));
    try {
      const path = join(dir, "id_test");
      await writeFile(path, opensshEd25519Pem(rawPriv, rawPub, "round-trip"), { mode: 0o600 });
      const out = spawnSync("ssh-keygen", ["-y", "-f", path], { encoding: "utf8" });
      expect(out.status).toBe(0);
      const expectedLine = sshAuthorizedKeysLine(rawPub, "round-trip");
      const expectedBlob = expectedLine.split(" ")[1];
      expect(out.stdout.trim().split(/\s+/)[1]).toBe(expectedBlob);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
