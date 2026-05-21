import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  buildGossipAdd,
  runWithConcurrency,
  signGossipAdd,
  verifyGossipAdd,
} from "../../src/gossip/index.js";
import type { Peer } from "../../src/types/index.js";

function fakePeerHalves(): { rawPub: Buffer; rawPriv: Buffer; pubB64u: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const d = (privateKey.export({ format: "jwk" }) as { d: string }).d;
  const rawPub = Buffer.from(x, "base64url");
  const rawPriv = Buffer.from(d, "base64url");
  return { rawPub, rawPriv, pubB64u: x };
}

function fakePeer(name: string, pub: string): Peer {
  return {
    nodeName: name,
    pubKey: pub,
    addresses: ["10.0.0.1:22"],
    sshUser: "alice",
    roles: [],
  };
}

describe("gossip signing", () => {
  it("verifies a freshly signed payload", () => {
    const issuer = fakePeerHalves();
    const newGuy = fakePeerHalves();
    const payload = buildGossipAdd({
      netId: "n-test",
      callerPub: issuer.pubB64u,
      callerNode: "alice",
      newPeer: fakePeer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);
    expect(signed.sig).toBeTruthy();
    const ok = verifyGossipAdd(signed);
    expect(ok).toEqual({ ok: true });
  });

  it("rejects a tampered payload", () => {
    const issuer = fakePeerHalves();
    const newGuy = fakePeerHalves();
    const payload = buildGossipAdd({
      netId: "n-test",
      callerPub: issuer.pubB64u,
      callerNode: "alice",
      newPeer: fakePeer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);
    const tampered = { ...signed, newPeer: fakePeer("eve", newGuy.pubB64u) };
    const ok = verifyGossipAdd(tampered);
    expect(ok.ok).toBe(false);
  });

  it("rejects a payload signed by a different key claiming to be the caller", () => {
    const issuer = fakePeerHalves();
    const attacker = fakePeerHalves();
    const newGuy = fakePeerHalves();
    const payload = buildGossipAdd({
      netId: "n-test",
      callerPub: issuer.pubB64u, // claims to be issuer
      callerNode: "alice",
      newPeer: fakePeer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, attacker.rawPriv, attacker.rawPub);
    const ok = verifyGossipAdd(signed);
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.error).toMatch(/signature/);
  });

  it("rejects a stale payload (>5 min off)", () => {
    const issuer = fakePeerHalves();
    const newGuy = fakePeerHalves();
    const payload = buildGossipAdd({
      netId: "n-test",
      callerPub: issuer.pubB64u,
      callerNode: "alice",
      newPeer: fakePeer("bob", newGuy.pubB64u),
    });
    payload.ts = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);
    const ok = verifyGossipAdd(signed);
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.error).toMatch(/stale/);
  });

  it("rejects malformed callerPub / newPeer.pubKey", () => {
    const issuer = fakePeerHalves();
    const payload = buildGossipAdd({
      netId: "n-test",
      callerPub: "AAAA", // too short
      callerNode: "alice",
      newPeer: fakePeer("bob", "BBBB"),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);
    const ok = verifyGossipAdd(signed);
    expect(ok.ok).toBe(false);
  });
});

describe("runWithConcurrency", () => {
  it("preserves item-result correspondence and respects the cap", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    const results = await runWithConcurrency(items, 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(results.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      const r = results[i];
      expect(r).toBeDefined();
      if ("result" in r!) expect(r.result).toBe(i * 2);
    }
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("captures rejections without breaking sibling work", async () => {
    const items = [1, 2, 3, 4];
    const results = await runWithConcurrency(items, 2, async (n) => {
      if (n === 2) throw new Error(`boom-${n}`);
      return n * 10;
    });
    expect(results[0]).toMatchObject({ item: 1, result: 10 });
    expect(results[1]).toMatchObject({ item: 2 });
    if (results[1] && "error" in results[1]) {
      expect(results[1].error.message).toBe("boom-2");
    } else {
      throw new Error("expected rejection at index 1");
    }
    expect(results[2]).toMatchObject({ item: 3, result: 30 });
    expect(results[3]).toMatchObject({ item: 4, result: 40 });
  });
});
