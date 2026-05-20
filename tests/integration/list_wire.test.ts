import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Daemon } from "../../src/daemon/index.js";
import { writeIdentity } from "../../src/store/index.js";

const CLI = resolve("dist/cli/index.js");

/**
 * Wire-format guard: the cross-node `list` fanout calls `nagent list --local
 * --json` on each peer and parses the LAST non-empty stdout line as JSON
 * (because bootstrap noise may precede it). The schema is the only contract
 * between caller and remote — this test pins it down.
 */
describe("nagent list --local --json wire format", () => {
  let dir: string;
  let daemon: Daemon;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-listwire-"));
    process.env.NAGENT_HOME = dir;
    await writeIdentity({
      nodeId: "wiretest",
      nodeName: "wire-node",
      ed25519Pub: "x",
      createdAt: new Date().toISOString(),
    });
    daemon = new Daemon({ foreground: false, log: () => {} });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
    delete process.env.NAGENT_HOME;
  });

  it("emits a single JSON object with v=1, node, and sessions[]", async () => {
    const stdout = await runCli(["list", "--local", "--json"]);
    const lastLine = stdout.split(/\r?\n/).filter((l) => l.length > 0).pop();
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine!);
    expect(parsed.v).toBe(1);
    expect(parsed.node).toBe("wire-node");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(0); // fresh daemon, no sessions
  });
});

async function runCli(args: string[]): Promise<string> {
  return new Promise((resolveP, reject) => {
    // NAGENT_NO_BOOTSTRAP isn't set — the CLI will attempt to bootstrap,
    // but the daemon is already running (we started it directly), so the
    // bootstrap is a no-op.
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, NAGENT_HOME: process.env.NAGENT_HOME, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.on("close", (code) => {
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`CLI exited ${code}: ${err}`));
        return;
      }
      resolveP(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
