// Probe round implementation: TCP-connect each known peer + pull every
// pinned relay's STATUS_OK. Writes the result to ~/.nagent/nets/<netId>/path-table.json.

import { connect as netConnect, type Socket } from "node:net";
import { paths } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import type { Peer } from "../types/index.js";
import type { RelayClient } from "../relay/client.js";
import {
  EMPTY_PATH_TABLE,
  type PathTable,
  type DirectSample,
  type RelaySample,
} from "./index.js";

const DEFAULT_TIMEOUT_MS = 1_500;

/**
 * One-shot TCP handshake against `host:port`; returns the connect time in ms,
 * or `null` on failure or timeout.
 */
export function probeDirect(host: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let settled = false;
    const sock: Socket = netConnect({ host, port });
    const done = (ms: number | null): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      const ns = process.hrtime.bigint() - start;
      done(Number(ns / 1_000n) / 1_000); // µs → ms with one decimal of precision via the implicit division
    });
    sock.once("error", () => { clearTimeout(timer); done(null); });
  });
}

export interface RunProbeOpts {
  netId: string;
  selfNodeName: string;
  /** Read from peers.json; if omitted, the function reads it itself. */
  peers?: Peer[];
  /** RelayClient instance whose connected relays we should poll for STATUS. */
  relayClient?: RelayClient;
  /** Names of pinned relays to query. Defaults to relayClient's connected set. */
  relayNames?: string[];
  /** Per-probe TCP timeout. */
  directTimeoutMs?: number;
}

/**
 * Run one full probe round and persist the result. Safe to call repeatedly;
 * each call overwrites path-table.json atomically.
 */
export async function runProbeRound(opts: RunProbeOpts): Promise<PathTable> {
  const peers =
    opts.peers ?? (await readJson<Peer[]>(paths().netPeers(opts.netId))) ?? [];
  const otherPeers = peers.filter((p) => p.nodeName !== opts.selfNodeName);

  // Direct probes — bounded concurrency 8.
  const direct: Record<string, DirectSample> = {};
  await runWithConcurrency(otherPeers, 8, async (peer) => {
    const target = peer.addresses[0];
    if (!target) return;
    const { host, port } = splitHostPort(target);
    const ms = await probeDirect(host, port, opts.directTimeoutMs);
    direct[peer.nodeName] = ms === null
      ? { ms: null, lastFailedAt: new Date().toISOString() }
      : { ms, lastOk: new Date().toISOString() };
  });

  // Relay STATUS pulls.
  const relays: Record<string, RelaySample> = {};
  if (opts.relayClient) {
    const names = opts.relayNames ?? [];
    for (const name of names) {
      const myRtt = opts.relayClient.rttFor(name);
      try {
        const status = await opts.relayClient.fetchStatus(name, 2_000);
        const peerMap: Record<string, { ms: number | null; lastSeen: string }> = {};
        for (const p of status.peers) {
          if (p.node === opts.selfNodeName) continue;
          peerMap[p.node] = { ms: p.rttMs, lastSeen: p.lastSeen };
        }
        relays[name] = {
          myRttMs: myRtt,
          lastSeen: new Date().toISOString(),
          peers: peerMap,
        };
      } catch {
        // Relay not connected / status timed out — record what we have.
        relays[name] = { myRttMs: myRtt, lastSeen: new Date(0).toISOString(), peers: {} };
      }
    }
  }

  const table: PathTable = {
    ...EMPTY_PATH_TABLE,
    node: opts.selfNodeName,
    updatedAt: new Date().toISOString(),
    direct,
    relays,
  };

  await writeJson(paths().pathTable(opts.netId), table);
  return table;
}

export async function readPathTable(netId: string): Promise<PathTable> {
  const t = await readJson<PathTable>(paths().pathTable(netId));
  if (!t) return { ...EMPTY_PATH_TABLE };
  return t;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitHostPort(s: string): { host: string; port: number } {
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return { host: s, port: 22 };
  const host = s.slice(0, lastColon);
  const port = Number(s.slice(lastColon + 1));
  return { host, port: Number.isInteger(port) && port > 0 ? port : 22 };
}

async function runWithConcurrency<T>(items: T[], cap: number, fn: (it: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers: Promise<void>[] = [];
  for (let k = 0; k < Math.min(cap, items.length); k++) {
    workers.push((async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!);
      }
    })());
  }
  await Promise.all(workers);
}
