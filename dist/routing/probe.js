// Probe round implementation: TCP-connect each known peer + pull every
// pinned relay's STATUS_OK. Writes the result to ~/.nagent/nets/<netId>/path-table.json.
import { connect as netConnect } from "node:net";
import { paths } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
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
    // Relay STATUS pulls.
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
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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