// Probe round implementation: TCP-connect each known peer + pull every
// pinned relay's STATUS_OK. Writes the result to ~/.nagent/nets/<netId>/path-table.json.

import { connect as netConnect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { paths } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import type { Peer } from "../types/index.js";
import type { RelayClient } from "../relay/client.js";
import { readPinnedRelays, type SshJumpPinnedRelay } from "../relay/pinned.js";
import { magicDnsFor } from "./tailscale.js";
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
  /** Names of pinned TLS relays to query. Defaults to relayClient's connected set. */
  relayNames?: string[];
  /** Per-probe TCP timeout. */
  directTimeoutMs?: number;
  /** Per-ssh-jump-probe wall-clock timeout (ms). Default 6000. */
  sshJumpTimeoutMs?: number;
  /** Override which pinned ssh-jump relays to probe. Tests use this; in production, read from pinned-relays.json. */
  sshJumpRelays?: SshJumpPinnedRelay[];
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

  // Relay STATUS pulls (TLS-transport, v0.5).
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

  // ssh-jump probes (v0.5.1). Each pinned ssh-jump relay × each peer:
  // time a real `ssh <jump-via-ProxyCommand> <peer> -- true` round-trip.
  // The relay's own myRttMs is a TCP-connect to the relay's port 22.
  const sshJumpRelays = opts.sshJumpRelays
    ?? (await readPinnedRelays()).filter((r): r is SshJumpPinnedRelay => r.transport === "ssh-jump");
  if (sshJumpRelays.length > 0) {
    const sshJumpTimeoutMs = opts.sshJumpTimeoutMs ?? 6000;
    for (const relay of sshJumpRelays) {
      const { host, port } = parseSshTargetForTcpProbe(relay.sshTarget);
      const myRttMs = await probeDirect(host, port, opts.directTimeoutMs);
      const peerMap: Record<string, { ms: number | null; lastSeen: string }> = {};
      const pairs = otherPeers.map((p) => ({ peer: p, relay }));
      await runWithConcurrency(pairs, 4, async ({ peer }) => {
        // Prefer the Tailscale MagicDNS FQDN if we can find one — that's
        // what the relay can actually resolve. Fall back to nagent.<peer>
        // (which only works if the relay happens to have an Include for our
        // ssh_config, which it usually doesn't).
        const magic = await magicDnsFor(peer.nodeName);
        const target = magic ? `nagent.${peer.nodeName}` : `nagent.${peer.nodeName}`;
        const hostOverride = magic ?? undefined;
        const ms = await probeSshJump(relay.sshTarget, target, sshJumpTimeoutMs, hostOverride);
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

/**
 * Time a `ssh -o ProxyCommand=… <sshHost> -- true` wall-clock round trip.
 * Returns the ms or null on failure / timeout. Mirrors the production attach
 * args exactly (ProxyCommand-with-nagent-identity + optional HostName
 * override), so the measurement reflects what users actually experience.
 */
export function probeSshJump(
  sshJumpTarget: string,
  sshHost: string,
  timeoutMs: number,
  hostNameOverride?: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const nagentKey = paths().sshKey;
    const args = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o",
      `ProxyCommand=ssh -i ${nagentKey} -o IdentitiesOnly=yes -o BatchMode=yes ` +
        `-o StrictHostKeyChecking=accept-new -W %h:%p ${sshJumpTarget}`,
    ];
    if (hostNameOverride) args.push("-o", `HostName=${hostNameOverride}`);
    args.push(sshHost, "--", "true");
    const child = spawn("ssh", args, { stdio: "ignore" });
    let settled = false;
    const done = (ms: number | null): void => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* */ }
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), timeoutMs + 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const ns = process.hrtime.bigint() - start;
        done(Number(ns / 1_000n) / 1_000);
      } else {
        done(null);
      }
    });
    child.on("error", () => { clearTimeout(timer); done(null); });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSshTargetForTcpProbe(target: string): { host: string; port: number } {
  // `user@host` or `user@host:port` — strip the user, default port 22.
  const at = target.indexOf("@");
  const hostPart = at >= 0 ? target.slice(at + 1) : target;
  const colon = hostPart.lastIndexOf(":");
  if (colon < 0) return { host: hostPart, port: 22 };
  const host = hostPart.slice(0, colon);
  const port = Number(hostPart.slice(colon + 1));
  return { host, port: Number.isInteger(port) && port > 0 ? port : 22 };
}

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
