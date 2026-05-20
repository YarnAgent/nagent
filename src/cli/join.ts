import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  assertNotExpired,
  decodeAndVerify,
  type InviteToken,
} from "../invite/index.js";
import {
  appendAuthorizedKey,
  removeAuthorizedKey,
} from "../ssh/authorized_keys.js";
import {
  loadSshKeypair,
  opensshEd25519Pem,
  sshAuthorizedKeysLine,
} from "../ssh/identity.js";
import {
  ensureUserSshConfigInclude,
  writeHostEntry,
} from "../ssh/ssh_config.js";
import { currentReachableAddresses } from "../ssh/addresses.js";
import {
  buildGossipAdd,
  runWithConcurrency,
  sendGossipAdd,
  signGossipAdd,
} from "../gossip/index.js";
import {
  readActiveState,
  readIdentity,
  readInvites,
  readNetMeta,
  readPeers,
  writeActiveState,
  writeInvites,
  writeNetMeta,
  writePeers,
} from "../store/index.js";
import { writeJson, readJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
import type {
  InviteRecord,
  JoinAccepted,
  JoinRedeem,
  JoinRejected,
  NetMeta,
  Peer,
} from "../types/index.js";

// ----- joiner side -----

/** Decode a token and run the join handshake. Updates local state on success. */
export async function cmdJoin(tokenStr: string): Promise<void> {
  const token = decodeAndVerify(tokenStr);
  assertNotExpired(token);

  const identity = await readIdentity();
  if (!identity) throw new Error("nagent not initialized");
  const keypair = await loadSshKeypair(identity.nodeId);
  const joinerPub = keypair.rawPub.toString("base64url");

  const accepted = await sshRedeem(token, {
    v: 1,
    joinerNode: identity.nodeName,
    joinerNodeId: identity.nodeId,
    joinerPubKey: joinerPub,
    joinerSshUser: userInfo().username,
    joinerAddresses: currentReachableAddresses().map((a) => `${a.host}:${a.port}`),
  });

  // Persist net metadata.
  const netMeta: NetMeta = {
    netId: accepted.netId,
    name: accepted.netName,
    createdAt: new Date().toISOString(),
    originNode: token.issuerNode,
  };
  await writeNetMeta(netMeta);
  await writePeers(accepted.netId, accepted.peers);
  await writeJson(paths().netAuthority(accepted.netId), accepted.authority);
  await writeJson(paths().netProjects(accepted.netId), []);
  await writeActiveState({ activeNetId: accepted.netId });

  // For each peer (including issuer): authorized_keys + ssh_config.
  await ensureUserSshConfigInclude();
  for (const peer of accepted.peers) {
    if (peer.nodeName === identity.nodeName) continue; // ourselves
    await wirePeer(peer);
  }

  process.stdout.write(
    `joined net "${accepted.netName}" (${accepted.netId}) via ${token.issuerNode}\n` +
    `peers: ${accepted.peers.map((p) => p.nodeName).join(", ")}\n` +
    `try: nagent attach ${token.issuerNode}/<session-name>\n`,
  );
}

async function wirePeer(peer: Peer): Promise<void> {
  const sshUser = peer.sshUser ?? userInfo().username;
  const first = peer.addresses[0];
  if (first) {
    const [host, portStr] = splitHostPort(first);
    await writeHostEntry({
      peerName: peer.nodeName,
      host,
      ...(portStr ? { port: Number.parseInt(portStr, 10) } : {}),
      user: sshUser,
      identityFile: paths().sshKey,
    });
  }
  const rawPub = Buffer.from(peer.pubKey, "base64url");
  if (rawPub.length === 32) {
    const line = sshAuthorizedKeysLine(rawPub, `nagent-peer-${peer.nodeName}`);
    await appendAuthorizedKey({ line, tag: `peer-${peer.nodeName}` });
  }
}

function splitHostPort(addr: string): [string, string | undefined] {
  const idx = addr.lastIndexOf(":");
  if (idx > 0) return [addr.slice(0, idx), addr.slice(idx + 1)];
  return [addr, undefined];
}

async function sshRedeem(token: InviteToken, redeem: JoinRedeem): Promise<JoinAccepted> {
  // Write the one-time priv to a temp file in OpenSSH format. OpenSSH ≥ 8.x
  // rejects PKCS#8 ed25519 private keys with "Load key …: invalid format",
  // which silently falls through to publickey/password auth and fails.
  const tmpDir = await mkdtemp(join(tmpdir(), "nagent-join-"));
  const keyPath = join(tmpDir, "id_invite");
  try {
    const rawPriv = Buffer.from(token.oneTimePriv, "base64url");
    const rawPub = Buffer.from(token.oneTimePub, "base64url");
    if (rawPriv.length !== 32 || rawPub.length !== 32) {
      throw new Error("invite: malformed oneTimePub/oneTimePriv");
    }
    const pem = opensshEd25519Pem(rawPriv, rawPub, `nagent-invite-${token.inviteId}`);
    await writeFile(keyPath, pem, { mode: 0o600 });

    const firstAddr = token.issuerAddrs[0];
    if (!firstAddr) throw new Error("invite token has no issuerAddrs");
    const args = [
      "-i", keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${paths().root}/known_hosts`,
      "-o", "BatchMode=yes",
      "-p", String(firstAddr.port),
      `${token.issuerSshUser}@${firstAddr.host}`,
      // The remote command is overridden by `command=` in authorized_keys,
      // so what we pass here is informational only.
      "true",
    ];

    return await new Promise<JoinAccepted>((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "inherit"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ssh exited with code ${code} (see stderr)`));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8").trim();
        if (!body) {
          reject(new Error("issuer returned empty response"));
          return;
        }
        let parsed: JoinAccepted | JoinRejected;
        try { parsed = JSON.parse(body) as JoinAccepted | JoinRejected; }
        catch (err) { reject(new Error(`bad response from issuer: ${(err as Error).message}\n${body}`)); return; }
        if ("error" in parsed) {
          reject(new Error(`issuer rejected join: ${parsed.error}`));
          return;
        }
        resolve(parsed);
      });
      // Send the redeem request.
      child.stdin.end(JSON.stringify(redeem) + "\n");
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ----- issuer side (constrained command via authorized_keys) -----

/**
 * Read JOIN_REDEEM from stdin, validate against the invite, mutate local state
 * (authorized_keys + peers + invite record), write JOIN_ACCEPTED to stdout.
 * Never opens a daemon — pure file operations.
 */
export async function cmdJoinRespond(inviteId: string): Promise<void> {
  // Block bootstrap (we don't want to spawn a daemon).
  process.env.NAGENT_NO_BOOTSTRAP = "1";

  const redeem = await readJoinRedeemFromStdin();

  const invites = await readInvites();
  const rec = invites.find((r) => r.inviteId === inviteId);
  if (!rec) {
    return rejectAndExit(`unknown invite: ${inviteId}`);
  }
  if (rec.state !== "pending") {
    return rejectAndExit(`invite state is ${rec.state}, not pending`);
  }
  if (Date.parse(rec.expiresAt) <= Date.now()) {
    rec.state = "expired";
    await writeInvites(invites);
    await removeAuthorizedKey({ tag: `invite-${inviteId}` });
    return rejectAndExit(`invite ${inviteId} expired at ${rec.expiresAt}`);
  }

  const identity = await readIdentity();
  if (!identity) return rejectAndExit("issuer not initialized");
  const active = await readActiveState();
  if (!active.activeNetId) return rejectAndExit("issuer has no active net");
  const netMeta = await readNetMeta(active.activeNetId);
  if (!netMeta) return rejectAndExit(`issuer active net ${active.activeNetId} missing`);
  const peers = await readPeers(active.activeNetId);

  // Add joiner pubkey to issuer's authorized_keys.
  const joinerRaw = Buffer.from(redeem.joinerPubKey, "base64url");
  if (joinerRaw.length !== 32) return rejectAndExit("joinerPubKey is not 32 bytes");
  const joinerLine = sshAuthorizedKeysLine(joinerRaw, `nagent-peer-${redeem.joinerNode}`);
  await appendAuthorizedKey({ line: joinerLine, tag: `peer-${redeem.joinerNode}` });

  // Add joiner to peers if not already known.
  const existingIdx = peers.findIndex((p) => p.nodeName === redeem.joinerNode);
  const joinerPeer: Peer = {
    nodeName: redeem.joinerNode,
    pubKey: redeem.joinerPubKey,
    addresses: redeem.joinerAddresses ?? [],
    sshUser: redeem.joinerSshUser,
    roles: [],
    lastSeen: new Date().toISOString(),
  };
  if (existingIdx >= 0) peers[existingIdx] = joinerPeer;
  else peers.push(joinerPeer);
  await writePeers(active.activeNetId, peers);

  // Mark invite as redeemed, remove the one-time authorized_keys entry.
  rec.state = "redeemed";
  rec.redeemedAt = new Date().toISOString();
  rec.redeemedBy = redeem.joinerNode;
  await writeInvites(invites);
  await removeAuthorizedKey({ tag: `invite-${inviteId}` });

  // Build JOIN_ACCEPTED. Refresh the issuer's self-entry with current data
  // (the persisted entry was written at bootstrap with DER-encoded pubkey and
  // no addresses; the joiner needs raw 32-byte pubkey + reachable addrs).
  const keypair = await loadSshKeypair(identity.nodeId);
  const issuerAddrs = currentReachableAddresses().map((a) => `${a.host}:${a.port}`);
  const issuerSelfEntry: Peer = {
    nodeName: identity.nodeName,
    pubKey: keypair.rawPub.toString("base64url"),
    addresses: issuerAddrs,
    sshUser: userInfo().username,
    roles: [],
    lastSeen: new Date().toISOString(),
  };
  let finalPeers = peers.map((p) => (p.nodeName === identity.nodeName ? issuerSelfEntry : p));
  if (!finalPeers.some((p) => p.nodeName === identity.nodeName)) {
    finalPeers = [...finalPeers, issuerSelfEntry];
  }
  // Persist the corrected entry so subsequent local reads are consistent.
  await writePeers(active.activeNetId, finalPeers);

  const authority = (await readJson<unknown>(paths().netAuthority(active.activeNetId))) ?? {
    originPubKey: keypair.rawPub.toString("base64url"),
    delegations: [],
  };
  const accepted: JoinAccepted = {
    v: 1,
    netId: netMeta.netId,
    netName: netMeta.name,
    peers: finalPeers,
    authority: authority as { originPubKey: string; delegations: unknown[] },
    issuerPub: keypair.rawPub.toString("base64url"),
    issuerSshUser: userInfo().username,
    issuerAddrs,
  };

  // v0.3: wire the joiner into the issuer's own ssh_config so the issuer can
  // SSH out to the joiner (for future gossip fanouts and `attach`). Also wire
  // any existing peers we haven't entered before (heal forward).
  await ensureUserSshConfigInclude();
  for (const p of finalPeers) {
    if (p.nodeName === identity.nodeName) continue;
    await wireHostEntryForPeer(p);
  }

  // v0.3: fan out gossip-add-peer to existing peers (excluding issuer and
  // joiner) so any-to-any mesh trust is established. Bounded concurrency,
  // best-effort — failures are captured for a future heal pass, not surfaced
  // to the joiner. Errors during fanout MUST NOT block the JOIN_ACCEPTED.
  const targets = finalPeers.filter(
    (p) => p.nodeName !== identity.nodeName && p.nodeName !== redeem.joinerNode,
  );
  if (targets.length > 0) {
    const payload = buildGossipAdd({
      netId: netMeta.netId,
      callerPub: keypair.rawPub.toString("base64url"),
      callerNode: identity.nodeName,
      newPeer: joinerPeer,
    });
    const signed = signGossipAdd(payload, keypair.rawPriv, keypair.rawPub);
    await runWithConcurrency(targets, 8, async (p) => {
      try {
        await sendGossipAdd(`nagent.${p.nodeName}`, signed, { timeoutMs: 8000 });
      } catch {
        // Best-effort: a heal pass on next daemon start will retry. The
        // join itself succeeded regardless.
      }
    });
  }

  process.stdout.write(JSON.stringify(accepted) + "\n");
}

async function wireHostEntryForPeer(p: Peer): Promise<void> {
  const first = p.addresses[0];
  if (!first) return;
  const [host, portStr] = splitHostPort(first);
  await writeHostEntry({
    peerName: p.nodeName,
    host,
    ...(portStr ? { port: Number.parseInt(portStr, 10) } : {}),
    user: p.sshUser ?? userInfo().username,
    identityFile: paths().sshKey,
  });
}

async function rejectAndExit(message: string): Promise<void> {
  const r: JoinRejected = { v: 1, error: message };
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exitCode = 1;
}

async function readJoinRedeemFromStdin(): Promise<JoinRedeem> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) throw new Error("empty JOIN_REDEEM on stdin");
  const parsed = JSON.parse(body) as JoinRedeem;
  if (parsed.v !== 1) throw new Error(`unknown JOIN_REDEEM version ${parsed.v}`);
  return parsed;
}

// Unused vars guard (keeping imports stable).
void spawnSync;
void readNetMeta;
void writeNetMeta;
void readInvites;
