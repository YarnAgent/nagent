import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  ensureNagentRoot,
  readPeers,
  writeActiveState,
  writeIdentity,
  writeNetMeta,
  writePeers,
} from "../../src/store/index.js";
import { applyGossipAdd } from "../../src/cli/gossip.js";
import {
  buildGossipAdd,
  signGossipAdd,
} from "../../src/gossip/index.js";
import { hasAuthorizedKeyTag } from "../../src/ssh/authorized_keys.js";
import { nagentSshConfigPath } from "../../src/ssh/ssh_config.js";
import type { Peer } from "../../src/types/index.js";

function halves(): { rawPub: Buffer; rawPriv: Buffer; pubB64u: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const d = (privateKey.export({ format: "jwk" }) as { d: string }).d;
  return {
    rawPub: Buffer.from(x, "base64url"),
    rawPriv: Buffer.from(d, "base64url"),
    pubB64u: x,
  };
}

function peer(name: string, pub: string, addr = "10.0.0.99:22"): Peer {
  return {
    nodeName: name,
    pubKey: pub,
    addresses: [addr],
    sshUser: "alice",
    roles: [],
  };
}

describe("applyGossipAdd (receiver-side gossip handler)", () => {
  let dir: string;
  const netId = "n-test123";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-gossip-"));
    process.env.NAGENT_HOME = dir;
    process.env.NAGENT_AUTHORIZED_KEYS_PATH = join(dir, "authorized_keys");
    await ensureNagentRoot();
    await writeIdentity({
      nodeId: "rcvr01",
      nodeName: "receiver",
      ed25519Pub: "x",
      createdAt: new Date().toISOString(),
    });
    await writeNetMeta({
      netId,
      name: "default",
      createdAt: new Date().toISOString(),
      originNode: "issuer",
    });
    await writeActiveState({ activeNetId: netId });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.NAGENT_HOME;
    delete process.env.NAGENT_AUTHORIZED_KEYS_PATH;
  });

  it("accepts a gossip from a trusted caller and writes authorized_keys + peers.json + ssh_config", async () => {
    const issuer = halves();
    const newGuy = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u, "10.0.0.1:22")]);

    const payload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob", newGuy.pubB64u, "10.0.0.2:22"),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);

    expect(await hasAuthorizedKeyTag("peer-bob")).toBe(true);
    const peers = await readPeers(netId);
    expect(peers.find((p) => p.nodeName === "bob")?.pubKey).toBe(newGuy.pubB64u);

    // ssh_config entry was written for the new peer
    const sshCfg = await readFile(nagentSshConfigPath(), "utf8");
    expect(sshCfg).toMatch(/Host\s+nagent\.bob/);
  });

  it("rejects gossip from a caller not in peers.json", async () => {
    const stranger = halves();
    const newGuy = halves();
    // peers.json has no entry matching stranger.pubB64u
    await writePeers(netId, []);

    const payload = buildGossipAdd({
      netId,
      callerPub: stranger.pubB64u,
      callerNode: "stranger",
      newPeer: peer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, stranger.rawPriv, stranger.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not in peers.json/);
    expect(await hasAuthorizedKeyTag("peer-bob")).toBe(false);
  });

  it("rejects gossip with a tampered newPeer pubkey", async () => {
    const issuer = halves();
    const honest = halves();
    const swapped = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u)]);

    const payload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob", honest.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);
    // Tamper: swap newPeer.pubKey after signing
    const tampered = {
      ...signed,
      newPeer: { ...signed.newPeer, pubKey: swapped.pubB64u },
    };

    const result = await applyGossipAdd(tampered);
    expect(result.ok).toBe(false);
    expect(await hasAuthorizedKeyTag("peer-bob")).toBe(false);
  });

  it("is idempotent — replaying the same gossip is a no-op (changed=false)", async () => {
    const issuer = halves();
    const newGuy = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u)]);

    const payload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);

    const first = await applyGossipAdd(signed);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.changed).toBe(true);

    // Replay with a fresh ts so the freshness window still accepts it
    const replayPayload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob", newGuy.pubB64u),
    });
    const replaySigned = signGossipAdd(replayPayload, issuer.rawPriv, issuer.rawPub);
    const second = await applyGossipAdd(replaySigned);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);
  });

  it("skips when newPeer is the receiver itself", async () => {
    const issuer = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u)]);

    const payload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("receiver", issuer.pubB64u), // newPeer.nodeName == identity.nodeName
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
    expect(await hasAuthorizedKeyTag("peer-receiver")).toBe(false);
  });

  it("rejects gossip for a different netId", async () => {
    const issuer = halves();
    const newGuy = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u)]);

    const payload = buildGossipAdd({
      netId: "n-other",
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/netId mismatch/);
  });
});
