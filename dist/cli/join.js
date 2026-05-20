import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { assertNotExpired, decodeAndVerify, oneTimePrivKey, } from "../invite/index.js";
import { appendAuthorizedKey, removeAuthorizedKey, } from "../ssh/authorized_keys.js";
import { loadSshKeypair, sshAuthorizedKeysLine, } from "../ssh/identity.js";
import { ensureUserSshConfigInclude, writeHostEntry, } from "../ssh/ssh_config.js";
import { currentReachableAddresses } from "../ssh/addresses.js";
import { readActiveState, readIdentity, readInvites, readNetMeta, readPeers, writeActiveState, writeInvites, writeNetMeta, writePeers, } from "../store/index.js";
import { writeJson, readJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
// ----- joiner side -----
/** Decode a token and run the join handshake. Updates local state on success. */
export async function cmdJoin(tokenStr) {
    const token = decodeAndVerify(tokenStr);
    assertNotExpired(token);
    const identity = await readIdentity();
    if (!identity)
        throw new Error("nagent not initialized");
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
    const netMeta = {
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
        if (peer.nodeName === identity.nodeName)
            continue; // ourselves
        await wirePeer(peer);
    }
    process.stdout.write(`joined net "${accepted.netName}" (${accepted.netId}) via ${token.issuerNode}\n` +
        `peers: ${accepted.peers.map((p) => p.nodeName).join(", ")}\n` +
        `try: nagent attach ${token.issuerNode}/<session-name>\n`);
}
async function wirePeer(peer) {
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
function splitHostPort(addr) {
    const idx = addr.lastIndexOf(":");
    if (idx > 0)
        return [addr.slice(0, idx), addr.slice(idx + 1)];
    return [addr, undefined];
}
async function sshRedeem(token, redeem) {
    // Write the one-time priv to a temp file (PEM PKCS#8).
    const tmpDir = await mkdtemp(join(tmpdir(), "nagent-join-"));
    const keyPath = join(tmpDir, "id_invite");
    try {
        const priv = oneTimePrivKey(token);
        const pem = priv.export({ format: "pem", type: "pkcs8" });
        await writeFile(keyPath, pem, { mode: 0o600 });
        const firstAddr = token.issuerAddrs[0];
        if (!firstAddr)
            throw new Error("invite token has no issuerAddrs");
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
        return await new Promise((resolve, reject) => {
            const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "inherit"] });
            const chunks = [];
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
                let parsed;
                try {
                    parsed = JSON.parse(body);
                }
                catch (err) {
                    reject(new Error(`bad response from issuer: ${err.message}\n${body}`));
                    return;
                }
                if ("error" in parsed) {
                    reject(new Error(`issuer rejected join: ${parsed.error}`));
                    return;
                }
                resolve(parsed);
            });
            // Send the redeem request.
            child.stdin.end(JSON.stringify(redeem) + "\n");
        });
    }
    finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}
// ----- issuer side (constrained command via authorized_keys) -----
/**
 * Read JOIN_REDEEM from stdin, validate against the invite, mutate local state
 * (authorized_keys + peers + invite record), write JOIN_ACCEPTED to stdout.
 * Never opens a daemon — pure file operations.
 */
export async function cmdJoinRespond(inviteId) {
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
    if (!identity)
        return rejectAndExit("issuer not initialized");
    const active = await readActiveState();
    if (!active.activeNetId)
        return rejectAndExit("issuer has no active net");
    const netMeta = await readNetMeta(active.activeNetId);
    if (!netMeta)
        return rejectAndExit(`issuer active net ${active.activeNetId} missing`);
    const peers = await readPeers(active.activeNetId);
    // Add joiner pubkey to issuer's authorized_keys.
    const joinerRaw = Buffer.from(redeem.joinerPubKey, "base64url");
    if (joinerRaw.length !== 32)
        return rejectAndExit("joinerPubKey is not 32 bytes");
    const joinerLine = sshAuthorizedKeysLine(joinerRaw, `nagent-peer-${redeem.joinerNode}`);
    await appendAuthorizedKey({ line: joinerLine, tag: `peer-${redeem.joinerNode}` });
    // Add joiner to peers if not already known.
    const existingIdx = peers.findIndex((p) => p.nodeName === redeem.joinerNode);
    const joinerPeer = {
        nodeName: redeem.joinerNode,
        pubKey: redeem.joinerPubKey,
        addresses: redeem.joinerAddresses ?? [],
        sshUser: redeem.joinerSshUser,
        roles: [],
        lastSeen: new Date().toISOString(),
    };
    if (existingIdx >= 0)
        peers[existingIdx] = joinerPeer;
    else
        peers.push(joinerPeer);
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
    const issuerSelfEntry = {
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
    const authority = (await readJson(paths().netAuthority(active.activeNetId))) ?? {
        originPubKey: keypair.rawPub.toString("base64url"),
        delegations: [],
    };
    const accepted = {
        v: 1,
        netId: netMeta.netId,
        netName: netMeta.name,
        peers: finalPeers,
        authority: authority,
        issuerPub: keypair.rawPub.toString("base64url"),
        issuerSshUser: userInfo().username,
        issuerAddrs,
    };
    process.stdout.write(JSON.stringify(accepted) + "\n");
}
async function rejectAndExit(message) {
    const r = { v: 1, error: message };
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exitCode = 1;
}
async function readJoinRedeemFromStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks).toString("utf8").trim();
    if (!body)
        throw new Error("empty JOIN_REDEEM on stdin");
    const parsed = JSON.parse(body);
    if (parsed.v !== 1)
        throw new Error(`unknown JOIN_REDEEM version ${parsed.v}`);
    return parsed;
}
// Unused vars guard (keeping imports stable).
void spawnSync;
void readNetMeta;
void writeNetMeta;
void readInvites;
//# sourceMappingURL=join.js.map