import { describe, expect, it } from "vitest";
import {
  chooseTransport,
  transportEqual,
  transportLabel,
  type PathTable,
} from "../../src/routing/index.js";

function table(direct: Record<string, number | null>, relays: Record<string, { myRttMs: number | null; peers: Record<string, number | null> }>): PathTable {
  const peers = (m: Record<string, number | null>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ms: v, lastSeen: "now" }]));
  return {
    v: 1,
    node: "self",
    updatedAt: "now",
    direct: Object.fromEntries(Object.entries(direct).map(([k, v]) => [k, v === null ? { ms: null } : { ms: v, lastOk: "now" }])),
    relays: Object.fromEntries(Object.entries(relays).map(([k, v]) => [k, {
      myRttMs: v.myRttMs,
      lastSeen: "now",
      peers: peers(v.peers),
    }])),
  };
}

describe("chooseTransport — path selection + hysteresis", () => {
  it("returns direct when no relays are known", () => {
    const t = table({ bob: 25 }, {});
    expect(chooseTransport(t, "bob")).toEqual({ type: "direct" });
  });

  it("returns the lowest-latency candidate (direct beats via)", () => {
    const t = table({ bob: 20 }, { east: { myRttMs: 50, peers: { bob: 50 } } });
    expect(chooseTransport(t, "bob")).toEqual({ type: "direct" });
  });

  it("returns via:<relay> when its additive score beats direct", () => {
    const t = table({ bob: 200 }, { east: { myRttMs: 30, peers: { bob: 40 } } });
    expect(chooseTransport(t, "bob")).toEqual({ type: "via", relay: "east" });
  });

  it("picks the lowest-latency relay among many", () => {
    const t = table({}, {
      east: { myRttMs: 30, peers: { bob: 40 } },   // 70
      west: { myRttMs: 100, peers: { bob: 50 } },  // 150
      central: { myRttMs: 25, peers: { bob: 25 } } // 50
    });
    expect(chooseTransport(t, "bob")).toEqual({ type: "via", relay: "central" });
  });

  it("forces direct on --via=direct regardless of path-table", () => {
    const t = table({ bob: 5000 }, { east: { myRttMs: 30, peers: { bob: 30 } } });
    expect(chooseTransport(t, "bob", { via: "direct" })).toEqual({ type: "direct" });
  });

  it("forces via:<name> on --via=<name>, even without measurement", () => {
    const t = table({ bob: 5 }, {});
    expect(chooseTransport(t, "bob", { via: "east" })).toEqual({ type: "via", relay: "east" });
  });

  it("treats --via=auto as no override", () => {
    const t = table({ bob: 20 }, {});
    expect(chooseTransport(t, "bob", { via: "auto" })).toEqual({ type: "direct" });
  });

  it("falls back to direct when nothing measured (graceful)", () => {
    const t = table({}, {});
    expect(chooseTransport(t, "bob")).toEqual({ type: "direct" });
  });

  it("skips relays with myRttMs=null (relay not yet PINGed)", () => {
    const t = table({}, { east: { myRttMs: null, peers: { bob: 5 } } });
    expect(chooseTransport(t, "bob")).toEqual({ type: "direct" });
  });

  it("skips relays that don't have the target in their peers map", () => {
    const t = table({}, { east: { myRttMs: 30, peers: { someone_else: 5 } } });
    expect(chooseTransport(t, "bob")).toEqual({ type: "direct" });
  });

  it("hysteresis: keeps stickyTo when within 10 ms of best", () => {
    const t = table({}, {
      east: { myRttMs: 50, peers: { bob: 50 } },  // 100
      west: { myRttMs: 30, peers: { bob: 65 } },  // 95
    });
    const result = chooseTransport(t, "bob", {
      stickyTo: { type: "via", relay: "east" },
      hysteresisMs: 10,
    });
    expect(result).toEqual({ type: "via", relay: "east" });
  });

  it("hysteresis: switches when sticky exceeds best+hysteresis", () => {
    const t = table({}, {
      east: { myRttMs: 50, peers: { bob: 50 } },  // 100
      west: { myRttMs: 30, peers: { bob: 50 } },  // 80 (20ms better)
    });
    const result = chooseTransport(t, "bob", {
      stickyTo: { type: "via", relay: "east" },
      hysteresisMs: 10,
    });
    expect(result).toEqual({ type: "via", relay: "west" });
  });

  it("hysteresis: stickyTo not in candidates is ignored", () => {
    const t = table({}, { east: { myRttMs: 30, peers: { bob: 30 } } });
    const result = chooseTransport(t, "bob", {
      stickyTo: { type: "via", relay: "ghost" },
    });
    expect(result).toEqual({ type: "via", relay: "east" });
  });
});

describe("transportEqual + transportLabel", () => {
  it("matches direct == direct", () => {
    expect(transportEqual({ type: "direct" }, { type: "direct" })).toBe(true);
  });
  it("matches via:X == via:X", () => {
    expect(transportEqual({ type: "via", relay: "x" }, { type: "via", relay: "x" })).toBe(true);
  });
  it("rejects via:X != via:Y", () => {
    expect(transportEqual({ type: "via", relay: "x" }, { type: "via", relay: "y" })).toBe(false);
  });
  it("rejects direct != via", () => {
    expect(transportEqual({ type: "direct" }, { type: "via", relay: "x" })).toBe(false);
  });
  it("labels match the wire-friendly form", () => {
    expect(transportLabel({ type: "direct" })).toBe("direct");
    expect(transportLabel({ type: "via", relay: "east" })).toBe("via:east");
  });
});
