import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { bootstrap, ensureIdentity, ensureDefaultNet } from "../../src/cli/bootstrap.js";

describe("bootstrap()", () => {
  let dir: string;
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-boot-"));
    process.env.NAGENT_HOME = dir;
    lines.length = 0;
  });
  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    delete process.env.NAGENT_NO_BOOTSTRAP;
    await rm(dir, { recursive: true, force: true });
  });

  it("creates identity + default net on first run, then is silent on the second", async () => {
    await ensureIdentity(log);
    await ensureDefaultNet(log);
    expect(lines.some((l) => l.startsWith("nagent: initialized node "))).toBe(true);
    expect(lines.some((l) => l.startsWith("nagent: created default net"))).toBe(true);

    expect(existsSync(join(dir, "identity.json"))).toBe(true);
    const identity = JSON.parse(await readFile(join(dir, "identity.json"), "utf8")) as { nodeName: string };
    expect(typeof identity.nodeName).toBe("string");

    const before = lines.length;
    await ensureIdentity(log);
    await ensureDefaultNet(log);
    expect(lines.length).toBe(before);
  });

  it("respects NAGENT_NO_BOOTSTRAP=1", async () => {
    process.env.NAGENT_NO_BOOTSTRAP = "1";
    await bootstrap({ log });
    expect(lines.length).toBe(0);
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
  });

  it("ensureDaemon step is opt-out via skipDaemon", async () => {
    await bootstrap({ skipDaemon: true, log });
    expect(existsSync(join(dir, "identity.json"))).toBe(true);
    // No daemon spawn attempted.
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });
});
