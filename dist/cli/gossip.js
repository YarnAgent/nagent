import { userInfo } from "node:os";
import { verifyGossipAdd, } from "../gossip/index.js";
import { isReplay } from "../gossip/replay_cache.js";
import { appendAuthorizedKey, } from "../ssh/authorized_keys.js";
import { sshAuthorizedKeysLine, } from "../ssh/identity.js";
import { ensureUserSshConfigInclude, writeHostEntry, } from "../ssh/ssh_config.js";
import { preferAddress } from "../ssh/addresses.js";
import { readActiveState, readIdentity, readNetMeta, readPeers, writePeers, } from "../store/index.js";
import { readJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
const NODE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
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
    // Replay guard: if we've already applied this exact signed payload in the
    // freshness window, refuse it so an attacker can't replay it to undo a
    // legitimate rotation that landed in between. Issue #3, M1.
    if (await isReplay(signed, now.getTime())) {
        return { v: 1, ok: false, error: "replay: payload already applied within freshness window" };
    }
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
    // Validate nodeName before any further use — it flows into authorized_keys
    // tags and ssh_config Host aliases, where exotic characters would create
    // ambiguity (see issue #3, M2).
    if (!NODE_NAME_PATTERN.test(newPeer.nodeName)) {
        return { v: 1, ok: false, error: `newPeer.nodeName must match ${NODE_NAME_PATTERN.source}` };
    }
    if (newPeer.sshUser && !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(newPeer.sshUser)) {
        return { v: 1, ok: false, error: "newPeer.sshUser is not a valid POSIX username" };
    }
    if (newPeer.nodeName === identity.nodeName) {
        return { v: 1, ok: true, changed: false, echoedNodeName: identity.nodeName };
    }
    const newPubRaw = Buffer.from(newPeer.pubKey, "base64url");
    if (newPubRaw.length !== 32) {
        return { v: 1, ok: false, error: "newPeer.pubKey is not 32 bytes" };
    }
    const tag = `peer-${newPeer.nodeName}`;
    const existingIdx = peers.findIndex((p) => p.nodeName === newPeer.nodeName);
    // Rotation gate (issue #3, C1 + H2): if we already know this nodeName under
    // a different pubKey, only allow the rotation if the gossip was signed by
    //   (a) the current-on-record pubKey for that nodeName (self-rotation), OR
    //   (b) the net's origin pubKey (admin-style override from authority.json).
    // Without this, any peer could overwrite any other peer's identity entry
    // and then sign further gossip as the impersonated peer.
    if (existingIdx >= 0 && peers[existingIdx].pubKey !== newPeer.pubKey) {
        const origin = (await readJson(paths().netAuthority(active.activeNetId)))?.originPubKey;
        const isSelfRotation = signed.callerPub === peers[existingIdx].pubKey;
        const isOriginRotation = origin !== undefined && signed.callerPub === origin;
        if (!isSelfRotation && !isOriginRotation) {
            return {
                v: 1, ok: false,
                error: `refusing to rotate peer "${newPeer.nodeName}": gossip must be signed by current pubKey or net origin`,
            };
        }
    }
    // Idempotency short-circuit: matching pubKey AND matching authorized_keys
    // line means there's nothing to do.
    if (existingIdx >= 0 && peers[existingIdx].pubKey === newPeer.pubKey) {
        // Still ensure the authorized_keys entry exists (heals state-drift where
        // peers.json got ahead of authorized_keys).
        const line = sshAuthorizedKeysLine(newPubRaw, `nagent-peer-${newPeer.nodeName}`);
        await appendAuthorizedKey({ line, tag });
        return { v: 1, ok: true, changed: false, echoedNodeName: identity.nodeName };
    }
    // Always (re-)write the authorized_keys entry so peers.json and
    // authorized_keys stay consistent across rotations. appendAuthorizedKey is
    // idempotent by tag — it replaces any existing tagged line. Issue #3, H2.
    const line = sshAuthorizedKeysLine(newPubRaw, `nagent-peer-${newPeer.nodeName}`);
    await appendAuthorizedKey({ line, tag });
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
    const firstAddr = preferAddress(peerRecord.addresses);
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