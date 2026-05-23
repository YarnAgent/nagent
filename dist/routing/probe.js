// Probe round implementation: TCP-connect each known peer + pull every
// pinned relay's STATUS_OK. Writes the result to ~/.nagent/nets/<netId>/path-table.json.
import { connect as netConnect } from "node:net";
import { spawn } from "node:child_process";
import { paths } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import { readPinnedRelays } from "../relay/pinned.js";
import { EMPTY_PATH_TABLE, } from "./index.js";
const DEFAULT_TIMEOUT_MS = 1_500;
/**
 * One-shot TCP handshake against `host:port`; returns the connect time in ms,
 * or `null` on failure or timeout.
 */
export function probeDirect(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const start = process.hrtime.bigint();
        let settled = false;
        const sock = netConnect({ host, port });
        const done = (ms) => {
            if (settled)
                return;
            settled = true;
            try {
                sock.destroy();
            }
            catch { /* */ }
            resolve(ms);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        sock.once("connect", () => {
            clearTimeout(timer);
            const ns = process.hrtime.bigint() - start;
            done(Number(ns / 1000n) / 1_000); // µs → ms with one decimal of precision via the implicit division
        });
        sock.once("error", () => { clearTimeout(timer); done(null); });
    });
}
/**
 * Run one full probe round and persist the result. Safe to call repeatedly;
 * each call overwrites path-table.json atomically.
 */
export async function runProbeRound(opts) {
    const peers = opts.peers ?? (await readJson(paths().netPeers(opts.netId))) ?? [];
    const otherPeers = peers.filter((p) => p.nodeName !== opts.selfNodeName);
    // Direct probes — bounded concurrency 8.
    const direct = {};
    await runWithConcurrency(otherPeers, 8, async (peer) => {
        const target = peer.addresses[0];
        if (!target)
            return;
        const { host, port } = splitHostPort(target);
        const ms = await probeDirect(host, port, opts.directTimeoutMs);
        direct[peer.nodeName] = ms === null
            ? { ms: null, lastFailedAt: new Date().toISOString() }
            : { ms, lastOk: new Date().toISOString() };
    });
    // Relay STATUS pulls (TLS-transport, v0.5).
    const relays = {};
    if (opts.relayClient) {
        const names = opts.relayNames ?? [];
        for (const name of names) {
            const myRtt = opts.relayClient.rttFor(name);
            try {
                const status = await opts.relayClient.fetchStatus(name, 2_000);
                const peerMap = {};
                for (const p of status.peers) {
                    if (p.node === opts.selfNodeName)
                        continue;
                    peerMap[p.node] = { ms: p.rttMs, lastSeen: p.lastSeen };
                }
                relays[name] = {
                    myRttMs: myRtt,
                    lastSeen: new Date().toISOString(),
                    peers: peerMap,
                };
            }
            catch {
                // Relay not connected / status timed out — record what we have.
                relays[name] = { myRttMs: myRtt, lastSeen: new Date(0).toISOString(), peers: {} };
            }
        }
    }
    // ssh-jump probes (v0.5.1). Each pinned ssh-jump relay × each peer:
    //   ssh -J <sshTarget> nagent.<peer> -- true   timed wall-clock.
    // The relay's own myRttMs is a TCP-connect to the relay's port 22.
    const sshJumpRelays = opts.sshJumpRelays
        ?? (await readPinnedRelays()).filter((r) => r.transport === "ssh-jump");
    if (sshJumpRelays.length > 0) {
        const sshJumpTimeoutMs = opts.sshJumpTimeoutMs ?? 6000;
        for (const relay of sshJumpRelays) {
            const { host, port } = parseSshTargetForTcpProbe(relay.sshTarget);
            const myRttMs = await probeDirect(host, port, opts.directTimeoutMs);
            const peerMap = {};
            const pairs = otherPeers.map((p) => ({ peer: p, relay }));
            await runWithConcurrency(pairs, 4, async ({ peer }) => {
                const ms = await probeSshJump(relay.sshTarget, `nagent.${peer.nodeName}`, sshJumpTimeoutMs);
                peerMap[peer.nodeName] = ms === null
                    ? { ms: null, lastSeen: new Date(0).toISOString() }
                    : { ms, lastSeen: new Date().toISOString() };
            });
            relays[relay.name] = {
                myRttMs,
                lastSeen: new Date().toISOString(),
                peers: peerMap,
            };
        }
    }
    const table = {
        ...EMPTY_PATH_TABLE,
        node: opts.selfNodeName,
        updatedAt: new Date().toISOString(),
        direct,
        relays,
    };
    await writeJson(paths().pathTable(opts.netId), table);
    return table;
}
export async function readPathTable(netId) {
    const t = await readJson(paths().pathTable(netId));
    if (!t)
        return { ...EMPTY_PATH_TABLE };
    return t;
}
/**
 * Time a `ssh -J <target> <sshHost> -- true` wall-clock round trip. Returns
 * the ms or null on failure / timeout. This is the same path the production
 * attach would take, so the measurement reflects user-experienced latency.
 */
export function probeSshJump(sshJumpTarget, sshHost, timeoutMs) {
    return new Promise((resolve) => {
        const start = process.hrtime.bigint();
        const args = [
            "-o", "BatchMode=yes",
            "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
            "-o", "StrictHostKeyChecking=accept-new",
            "-J", sshJumpTarget,
            sshHost,
            "--",
            "true",
        ];
        const child = spawn("ssh", args, { stdio: "ignore" });
        let settled = false;
        const done = (ms) => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill("SIGTERM");
            }
            catch { /* */ }
            resolve(ms);
        };
        const timer = setTimeout(() => done(null), timeoutMs + 1000);
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                const ns = process.hrtime.bigint() - start;
                done(Number(ns / 1000n) / 1_000);
            }
            else {
                done(null);
            }
        });
        child.on("error", () => { clearTimeout(timer); done(null); });
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseSshTargetForTcpProbe(target) {
    // `user@host` or `user@host:port` — strip the user, default port 22.
    const at = target.indexOf("@");
    const hostPart = at >= 0 ? target.slice(at + 1) : target;
    const colon = hostPart.lastIndexOf(":");
    if (colon < 0)
        return { host: hostPart, port: 22 };
    const host = hostPart.slice(0, colon);
    const port = Number(hostPart.slice(colon + 1));
    return { host, port: Number.isInteger(port) && port > 0 ? port : 22 };
}
function splitHostPort(s) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0)
        return { host: s, port: 22 };
    const host = s.slice(0, lastColon);
    const port = Number(s.slice(lastColon + 1));
    return { host, port: Number.isInteger(port) && port > 0 ? port : 22 };
}
async function runWithConcurrency(items, cap, fn) {
    let i = 0;
    const workers = [];
    for (let k = 0; k < Math.min(cap, items.length); k++) {
        workers.push((async () => {
            while (i < items.length) {
                const idx = i++;
                await fn(items[idx]);
            }
        })());
    }
    await Promise.all(workers);
}
//# sourceMappingURL=probe.js.map