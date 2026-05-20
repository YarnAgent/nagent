import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { dispatchSlash, slashCommands } from "../../src/cli/slash.js";
import { bootstrap } from "../../src/cli/bootstrap.js";

describe("slash dispatcher", () => {
  let dir: string;
  let cwd: string;
  const out = { log: "" as string, err: "" as string };
  const sink = {
    log: (s: string) => { out.log += s + "\n"; },
    err: (s: string) => { out.err += s + "\n"; },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-slash-"));
    cwd = await mkdtemp(join(tmpdir(), "nagent-slash-cwd-"));
    process.env.NAGENT_HOME = dir;
    process.chdir(cwd);
    out.log = "";
    out.err = "";
    // Provide identity + a default net so /project init has somewhere to land.
    await bootstrap({ skipDaemon: true, log: () => {} });
  });
  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    process.chdir(tmpdir());
    await rm(dir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("`/help` prints a non-empty index", async () => {
    await dispatchSlash("help", sink);
    expect(out.log).toMatch(/slash commands:/);
    expect(slashCommands().length).toBeGreaterThan(5);
  });

  it("`/net create` adds an active net and `/net status` reflects it", async () => {
    await dispatchSlash("net create extra", sink);
    expect(out.log).toMatch(/created net "extra"/);
    out.log = "";
    await dispatchSlash("net status", sink);
    expect(out.log).toMatch(/net: extra/);
  });

  it("`/project init` writes a .nagent marker in cwd", async () => {
    await dispatchSlash("project init proj-a", sink);
    expect(out.log).toMatch(/created project "proj-a"/);
    expect(existsSync(join(cwd, ".nagent"))).toBe(true);
  });

  it("deferred slash `/web` prints the v0.3 notice without throwing", async () => {
    const r = await dispatchSlash("web", sink);
    expect(out.log).toMatch(/not yet implemented/);
    expect(r.exitPicker).toBeFalsy();
  });

  it("unknown slash command returns an error and stays in the loop", async () => {
    const r = await dispatchSlash("wat", sink);
    expect(out.err).toMatch(/unknown slash command/);
    expect(r.exitPicker).toBeFalsy();
  });

  it("`/quit` signals exitPicker", async () => {
    const r = await dispatchSlash("quit", sink);
    expect(r.exitPicker).toBe(true);
  });
});
