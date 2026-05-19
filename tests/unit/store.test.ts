import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson, readJson } from "../../src/store/json.js";

describe("store json (atomic rename + perms)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing file", async () => {
    expect(await readJson(join(dir, "nope.json"))).toBeUndefined();
  });

  it("writes and reads JSON content", async () => {
    const path = join(dir, "x.json");
    await writeJson(path, { a: 1 });
    expect(await readJson(path)).toEqual({ a: 1 });
  });

  it("creates the target file with mode 0600", async () => {
    const path = join(dir, "perm.json");
    await writeJson(path, { x: "secret" });
    const s = await stat(path);
    // mask off type bits, check user-only access (0600)
    expect((s.mode & 0o777)).toBe(0o600);
  });

  it("does not leave temp files around on success", async () => {
    const path = join(dir, "y.json");
    await writeJson(path, [1, 2, 3]);
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toBe("y.json");
  });

  it("overwrites atomically", async () => {
    const path = join(dir, "z.json");
    await writeFile(path, "garbage that-is-not-json", { mode: 0o600 });
    await writeJson(path, { ok: true });
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });
});
