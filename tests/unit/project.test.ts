import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { findProjectMarker, writeMarkerAt } from "../../src/project/index.js";
import type { ProjectMarker } from "../../src/types/index.js";

describe("project cwd-walker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when no .nagent ancestor exists", async () => {
    const r = await findProjectMarker(dir);
    expect(r).toBeUndefined();
  });

  it("finds the .nagent marker at cwd", async () => {
    const marker: ProjectMarker = {
      version: 1,
      netId: "n-x",
      projectId: "p-x",
      projectName: "x",
      createdAt: new Date().toISOString(),
      createdByNode: "node",
    };
    await writeMarkerAt(dir, marker);
    const r = await findProjectMarker(dir);
    expect(r?.marker.projectId).toBe("p-x");
    expect(r?.dir).toBe(dir);
  });

  it("walks up to find a marker in an ancestor", async () => {
    const nested = join(dir, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    const marker: ProjectMarker = {
      version: 1,
      netId: "n-y",
      projectId: "p-y",
      projectName: "y",
      createdAt: new Date().toISOString(),
      createdByNode: "node",
    };
    await writeMarkerAt(dir, marker);
    const r = await findProjectMarker(nested);
    expect(r?.marker.projectId).toBe("p-y");
    expect(r?.dir).toBe(dir);
  });
});
