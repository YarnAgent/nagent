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

  it("refuses peer impersonation: foreign signer cannot rotate an existing peer's pubkey", async () => {
    // Setup: issuer (signer #1) and an existing alice peer with pubkey A1.
    // Then eve (signer #2, also a trusted peer) tries to overwrite alice
    // with eve's chosen new key. This was issue #3 C1 (peer impersonation).
    const issuer = halves();
    const eve = halves();
    const aliceOld = halves();
    const attacker = halves(); // Eve's chosen replacement for alice
    await writePeers(netId, [
      peer("issuer", issuer.pubB64u),
      peer("eve", eve.pubB64u),
      peer("alice", aliceOld.pubB64u),
    ]);
    // authority.json sets issuer as the net origin; eve is NOT origin.
    const { writeJson } = await import("../../src/store/json.js");
    const { paths } = await import("../../src/platform/paths.js");
    await writeJson(paths().netAuthority(netId), { originPubKey: issuer.pubB64u, delegations: [] });

    const payload = buildGossipAdd({
      netId,
      callerPub: eve.pubB64u,
      callerNode: "eve",
      newPeer: peer("alice", attacker.pubB64u), // hijack attempt
    });
    const signed = signGossipAdd(payload, eve.rawPriv, eve.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rotate/i);

    // Alice's stored pubkey must still be A1, not the attacker's key.
    const peers = await readPeers(netId);
    expect(peers.find((p) => p.nodeName === "alice")?.pubKey).toBe(aliceOld.pubB64u);
  });

  it("allows self-rotation: an existing peer can replace their own pubkey", async () => {
    const issuer = halves();
    const aliceOld = halves();
    const aliceNew = halves();
    await writePeers(netId, [
      peer("issuer", issuer.pubB64u),
      peer("alice", aliceOld.pubB64u),
    ]);

    const payload = buildGossipAdd({
      netId,
      callerPub: aliceOld.pubB64u, // signed by alice's CURRENT key
      callerNode: "alice",
      newPeer: peer("alice", aliceNew.pubB64u),
    });
    const signed = signGossipAdd(payload, aliceOld.rawPriv, aliceOld.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);

    const peers = await readPeers(netId);
    expect(peers.find((p) => p.nodeName === "alice")?.pubKey).toBe(aliceNew.pubB64u);
  });

  it("allows origin-signed rotation (admin override)", async () => {
    const origin = halves();
    const aliceOld = halves();
    const aliceNew = halves();
    await writePeers(netId, [
      peer("origin", origin.pubB64u),
      peer("alice", aliceOld.pubB64u),
    ]);
    const { writeJson } = await import("../../src/store/json.js");
    const { paths } = await import("../../src/platform/paths.js");
    await writeJson(paths().netAuthority(netId), { originPubKey: origin.pubB64u, delegations: [] });

    const payload = buildGossipAdd({
      netId,
      callerPub: origin.pubB64u,
      callerNode: "origin",
      newPeer: peer("alice", aliceNew.pubB64u),
    });
    const signed = signGossipAdd(payload, origin.rawPriv, origin.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(true);

    const peers = await readPeers(netId);
    expect(peers.find((p) => p.nodeName === "alice")?.pubKey).toBe(aliceNew.pubB64u);
  });

  it("rotation also updates authorized_keys (fixes H2 desync)", async () => {
    const aliceOld = halves();
    const aliceNew = halves();
    await writePeers(netId, [peer("alice", aliceOld.pubB64u)]);

    // Initial add via aliceOld signing for herself (no rotation case yet).
    const initial = buildGossipAdd({
      netId,
      callerPub: aliceOld.pubB64u,
      callerNode: "alice",
      newPeer: peer("alice", aliceOld.pubB64u),
    });
    await applyGossipAdd(signGossipAdd(initial, aliceOld.rawPriv, aliceOld.rawPub));
    expect(await hasAuthorizedKeyTag("peer-alice")).toBe(true);

    // Self-rotation to the new key.
    const rotate = buildGossipAdd({
      netId,
      callerPub: aliceOld.pubB64u,
      callerNode: "alice",
      newPeer: peer("alice", aliceNew.pubB64u),
    });
    await applyGossipAdd(signGossipAdd(rotate, aliceOld.rawPriv, aliceOld.rawPub));

    // authorized_keys MUST reflect the new key, not the old one. The line
    // format is `ssh-ed25519 <base64-blob> <comment>` where blob = uint32(11)
    // "ssh-ed25519" uint32(32) <raw32-pubkey>. We rebuild what each version
    // would look like and assert exactly one peer-alice line, matching the
    // new key.
    const { sshAuthorizedKeysLine } = await import("../../src/ssh/identity.js");
    const oldLine = sshAuthorizedKeysLine(aliceOld.rawPub, "nagent-peer-alice");
    const newLine = sshAuthorizedKeysLine(aliceNew.rawPub, "nagent-peer-alice");
    const { readFile } = await import("node:fs/promises");
    const aks = await readFile(process.env.NAGENT_AUTHORIZED_KEYS_PATH!, "utf8");
    const peerLines = aks.split("\n").filter((l) => l.includes("nagent-peer-alice"));
    expect(peerLines.length).toBe(1);
    expect(peerLines[0]).toContain(newLine.split(" ")[1]); // the base64 blob
    expect(peerLines[0]).not.toContain(oldLine.split(" ")[1]);
  });

  it("rejects exact-payload replay within the freshness window (M1)", async () => {
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

    // Identical payload (same bytes, same sig) replayed within the window.
    const second = await applyGossipAdd(signed);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/replay/i);
  });

  it("rejects newPeer.nodeName with disallowed characters (M2)", async () => {
    const issuer = halves();
    const newGuy = halves();
    await writePeers(netId, [peer("issuer", issuer.pubB64u)]);

    const payload = buildGossipAdd({
      netId,
      callerPub: issuer.pubB64u,
      callerNode: "issuer",
      newPeer: peer("bob; rm -rf /", newGuy.pubB64u),
    });
    const signed = signGossipAdd(payload, issuer.rawPriv, issuer.rawPub);

    const result = await applyGossipAdd(signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nodeName/i);
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
