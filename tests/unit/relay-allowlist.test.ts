import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllowlist,
  findAllowed,
  addGrant,
  removeGrant,
  listGrants,
} from "../../src/relay/allowlist.js";
import { paths } from "../../src/platform/paths.js";

describe("relay allowlist — union of mesh peers + explicit grants", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-relay-allow-"));
    process.env.NAGENT_HOME = dir;
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty when nothing is configured", async () => {
    const allow = await loadAllowlist();
    expect(allow).toEqual([]);
    expect(await listGrants()).toEqual([]);
  });

  it("loads peers from every joined net's peers.json", async () => {
    await mkdir(paths().netDir("net-alpha"), { recursive: true });
    await mkdir(paths().netDir("net-beta"), { recursive: true });
    await writeFile(paths().netPeers("net-alpha"), JSON.stringify([
      { nodeName: "alice", pubKey: "PK_ALICE", addresses: ["1.2.3.4:22"], roles: [] },
      { nodeName: "bob",   pubKey: "PK_BOB",   addresses: ["5.6.7.8:22"], roles: [] },
    ]));
    await writeFile(paths().netPeers("net-beta"), JSON.stringify([
      { nodeName: "carol", pubKey: "PK_CAROL", addresses: ["9.9.9.9:22"], roles: [] },
    ]));
    const allow = await loadAllowlist();
    expect(allow).toHaveLength(3);
    expect(allow.every((a) => a.source === "net")).toBe(true);
    const alice = allow.find((a) => a.nodeName === "alice")!;
    expect(alice.netId).toBe("net-alpha");
  });

  it("includes explicit grants alongside mesh peers", async () => {
    await mkdir(paths().netDir("net-x"), { recursive: true });
    await writeFile(paths().netPeers("net-x"), JSON.stringify([
      { nodeName: "alice", pubKey: "PK_ALICE", addresses: [], roles: [] },
    ]));
    await addGrant("guest", "PK_GUEST");
    const allow = await loadAllowlist();
    expect(allow).toHaveLength(2);
    const guest = allow.find((a) => a.nodeName === "guest")!;
    expect(guest.source).toBe("explicit");
    expect(guest.pubKey).toBe("PK_GUEST");
  });

  it("findAllowed requires both nodeName AND pubKey to match", async () => {
    await addGrant("alice", "PK_ALICE_REAL");
    const allow = await loadAllowlist();
    expect(findAllowed(allow, "alice", "PK_ALICE_REAL")?.source).toBe("explicit");
    expect(findAllowed(allow, "alice", "PK_DIFFERENT")).toBeNull();
    expect(findAllowed(allow, "bob",   "PK_ALICE_REAL")).toBeNull();
  });

  it("addGrant replaces a prior grant for the same node", async () => {
    await addGrant("alice", "PK_OLD");
    await addGrant("alice", "PK_NEW");
    const grants = await listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.pubKey).toBe("PK_NEW");
  });

  it("removeGrant returns true on hit, false on miss", async () => {
    await addGrant("alice", "PK_A");
    await addGrant("bob",   "PK_B");
    expect(await removeGrant("alice")).toBe(true);
    expect(await removeGrant("alice")).toBe(false);
    const grants = await listGrants();
    expect(grants.map((g) => g.node)).toEqual(["bob"]);
  });

  it("malformed peers.json entries are silently skipped (lenient)", async () => {
    await mkdir(paths().netDir("net-broken"), { recursive: true });
    await writeFile(paths().netPeers("net-broken"), JSON.stringify([
      { nodeName: "ok",      pubKey: "PK_OK", addresses: [], roles: [] },
      { nodeName: "",        pubKey: "PK_EMPTY", addresses: [], roles: [] },
      { nodeName: "missing", addresses: [], roles: [] },
      "not-an-object",
    ]));
    const allow = await loadAllowlist();
    expect(allow.map((a) => a.nodeName)).toEqual(["ok"]);
  });

  it("malformed allowlist.json is treated as empty + writes proceed", async () => {
    await mkdir(paths().relayDir, { recursive: true });
    await writeFile(paths().relayAllowlist, "{}"); // missing grants array
    expect(await listGrants()).toEqual([]);
    await addGrant("alice", "PK_A");
    expect(await listGrants()).toHaveLength(1);
  });

  it("requires non-empty node and pubKey on addGrant", async () => {
    await expect(addGrant("", "PK")).rejects.toThrow(/node and pubKey/);
    await expect(addGrant("alice", "")).rejects.toThrow(/node and pubKey/);
  });
});
