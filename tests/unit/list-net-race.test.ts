import { describe, expect, it } from "vitest";
import { pickBestRelayPerPeer } from "../../src/cli/list_net.js";
import type { PathTable } from "../../src/routing/index.js";

const baseTable = (): PathTable => ({
  v: 1,
  node: "self",
  updatedAt: new Date().toISOString(),
  direct: {},
  relays: {},
});

describe("pickBestRelayPerPeer", () => {
  it("returns empty map when no relays are pinned", () => {
    const out = pickBestRelayPerPeer(null, ["alice", "bob"], []);
    expect(out.size).toBe(0);
  });

  it("falls back to the first relay name when path table is null", () => {
    const out = pickBestRelayPerPeer(null, ["alice"], ["tencent-cn", "fra-1"]);
    expect(out.get("alice")).toBe("tencent-cn");
  });

  it("falls back to the first relay name when no per-peer sample exists yet", () => {
    const table = baseTable();
    table.relays = {
      "tencent-cn": { myRttMs: 1.5, lastSeen: new Date().toISOString(), peers: {} },
    };
    const out = pickBestRelayPerPeer(table, ["alice"], ["tencent-cn"]);
    expect(out.get("alice")).toBe("tencent-cn");
  });

  it("picks the relay with the lowest measured ms when multiple have samples", () => {
    const table = baseTable();
    const now = new Date().toISOString();
    table.relays = {
      "tencent-cn": {
        myRttMs: 1.5,
        lastSeen: now,
        peers: { alice: { ms: 80, lastSeen: now } },
      },
      "fra-1": {
        myRttMs: 30,
        lastSeen: now,
        peers: { alice: { ms: 12, lastSeen: now } },
      },
    };
    const out = pickBestRelayPerPeer(table, ["alice"], ["tencent-cn", "fra-1"]);
    expect(out.get("alice")).toBe("fra-1");
  });

  it("ignores null/non-finite samples", () => {
    const table = baseTable();
    const now = new Date().toISOString();
    table.relays = {
      "tencent-cn": {
        myRttMs: 1.5,
        lastSeen: now,
        peers: { alice: { ms: null, lastSeen: now } },
      },
      "fra-1": {
        myRttMs: 30,
        lastSeen: now,
        peers: { alice: { ms: 999, lastSeen: now } },
      },
    };
    const out = pickBestRelayPerPeer(table, ["alice"], ["tencent-cn", "fra-1"]);
    expect(out.get("alice")).toBe("fra-1");
  });

  it("decides independently per peer", () => {
    const table = baseTable();
    const now = new Date().toISOString();
    table.relays = {
      "tencent-cn": {
        myRttMs: 1.5,
        lastSeen: now,
        peers: {
          alice: { ms: 12, lastSeen: now },
          bob:   { ms: 80, lastSeen: now },
        },
      },
      "fra-1": {
        myRttMs: 30,
        lastSeen: now,
        peers: {
          alice: { ms: 80, lastSeen: now },
          bob:   { ms: 12, lastSeen: now },
        },
      },
    };
    const out = pickBestRelayPerPeer(table, ["alice", "bob"], ["tencent-cn", "fra-1"]);
    expect(out.get("alice")).toBe("tencent-cn");
    expect(out.get("bob")).toBe("fra-1");
  });
});
