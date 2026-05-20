import { userInfo } from "node:os";
import { verifyGossipAdd, } from "../gossip/index.js";
import { appendAuthorizedKey, hasAuthorizedKeyTag, } from "../ssh/authorized_keys.js";
import { sshAuthorizedKeysLine, } from "../ssh/identity.js";
import { ensureUserSshConfigInclude, writeHostEntry, } from "../ssh/ssh_config.js";
import { readActiveState, readIdentity, readNetMeta, readPeers, writePeers, } from "../store/index.js";
import { paths } from "../platform/paths.js";
/**
 * Apply a verified-or-not gossip-add to local state. Returns an ack or reject
 * payload — does NOT touch stdout or process.exit, so it's safe to unit-test.
 *
 * Pure file operations on `~/.nagent`: never spawns a daemon, never reaches
 * the bus. The signature check is the real authorization gate; even with a
 * legitimate SSH connection, an unsigned/invalid payload is refused.
 */
export async function applyGossipAdd(signed, now = new Date()) {
    const verified = verifyGossipAdd(signed, now);
    if (!verified.ok)
        return { v: 1, ok: false, error: `signature: ${verified.error}` };
    const identity = await readIdentity();
    if (!identity)
        return { v: 1, ok: false, error: "receiver not initialized" };
    const active = await readActiveState();
    if (!active.activeNetId)
        return { v: 1, ok: false, error: "receiver has no active net" };
    if (signed.netId !== active.activeNetId) {
        return { v: 1, ok: false, error: `netId mismatch: payload=${signed.netId} active=${active.activeNetId}` };
    }
    const netMeta = await readNetMeta(active.activeNetId);
    if (!netMeta)
        return { v: 1, ok: false, error: `receiver active net ${active.activeNetId} missing` };
    const peers = await readPeers(active.activeNetId);
    const caller = peers.find((p) => p.pubKey === signed.callerPub);
    if (!caller) {
        return { v: 1, ok: false, error: "caller pubKey not in peers.json — refuse to trust unknown signer" };
    }
    const newPeer = signed.newPeer;
    if (!newPeer.nodeName || !newPeer.pubKey) {
        return { v: 1, ok: false, error: "newPeer is missing required fields" };
    }
    if (newPeer.nodeName === identity.nodeName) {
        return { v: 1, ok: true, changed: false, echoedNodeName: identity.nodeName };
    }
    const newPubRaw = Buffer.from(newPeer.pubKey, "base64url");
    if (newPubRaw.length !== 32) {
        return { v: 1, ok: false, error: "newPeer.pubKey is not 32 bytes" };
    }
    const tag = `peer-${newPeer.nodeName}`;
    const alreadyAuthorized = await hasAuthorizedKeyTag(tag);
    const existingIdx = peers.findIndex((p) => p.nodeName === newPeer.nodeName);
    if (alreadyAuthorized && existingIdx >= 0 && peers[existingIdx].pubKey === newPeer.pubKey) {
        return { v: 1, ok: true, changed: false, echoedNodeName: identity.nodeName };
    }
    if (!alreadyAuthorized) {
        const line = sshAuthorizedKeysLine(newPubRaw, `nagent-peer-${newPeer.nodeName}`);
        await appendAuthorizedKey({ line, tag });
    }
    const peerRecord = {
        nodeName: newPeer.nodeName,
        pubKey: newPeer.pubKey,
        addresses: newPeer.addresses ?? [],
        sshUser: newPeer.sshUser ?? userInfo().username,
        roles: newPeer.roles ?? [],
        lastSeen: new Date().toISOString(),
    };
    if (existingIdx >= 0)
        peers[existingIdx] = peerRecord;
    else
        peers.push(peerRecord);
    await writePeers(active.activeNetId, peers);
    await ensureUserSshConfigInclude();
    const firstAddr = peerRecord.addresses[0];
    if (firstAddr) {
        const [host, portStr] = splitHostPort(firstAddr);
        await writeHostEntry({
            peerName: peerRecord.nodeName,
            host,
            ...(portStr ? { port: Number.parseInt(portStr, 10) } : {}),
            user: peerRecord.sshUser ?? userInfo().username,
            identityFile: paths().sshKey,
        });
    }
    return { v: 1, ok: true, changed: true, echoedNodeName: identity.nodeName };
}
/**
 * Stdin/stdout/exit-code wrapper around `applyGossipAdd`. This is what gets
 * wired into the `nagent gossip-add-peer` CLI command — receivers invoke it
 * via SSH from already-trusted callers.
 */
export async function cmdGossipAddPeer() {
    process.env.NAGENT_NO_BOOTSTRAP = "1";
    const signed = await readSignedFromStdin();
    const result = await applyGossipAdd(signed);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok)
        process.exitCode = 1;
}
async function readSignedFromStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks).toString("utf8").trim();
    if (!body)
        throw new Error("empty gossip-add payload on stdin");
    try {
        return JSON.parse(body);
    }
    catch (err) {
        throw new Error(`bad gossip-add JSON: ${err.message}`);
    }
}
function splitHostPort(addr) {
    const idx = addr.lastIndexOf(":");
    if (idx > 0)
        return [addr.slice(0, idx), addr.slice(idx + 1)];
    return [addr, undefined];
}
//# sourceMappingURL=gossip.js.map