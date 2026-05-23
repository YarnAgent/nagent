// Probe round: measure real end-to-end latency on every candidate transport.
//
// v0.5.0 (TCP-only direct probe) returned wildly different units across
// transports — direct was ~ms (TCP SYN/SYN-ACK/ACK), via-relay was ~seconds
// (full ssh-through-ssh). Selection still worked because ordering was
// preserved, but the user-facing numbers were misleading.
//
// v0.5.2 unifies on **real SSH round-trip** as the canonical metric for
// every transport. Both probes run `ssh [extra-args] <sshHost> -- true` and
// time the wall clock. That captures TCP + SSH handshake + auth + channel
// open + exec + teardown — the same cost an `nagent attach` pays at
// startup. Now `direct=0.6ms` vs `via:relay=1285ms` reads as a real
// 2000× gap, not "we measured different things".
//
// Cheap TCP-connect lives on as a fast-fail pre-check: if the peer's port
// is closed, skip the (much more expensive) SSH probe and mark unreachable.

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

const DEFAULT_TCP_TIMEOUT_MS = 1_500;
// 15 s accommodates cold SSH handshakes on slow long-haul paths (e.g. home
// network → CN cloud relay; macOS sshd's cold-start with PAM + mDNS can add
// several seconds on its own). A typical LAN/tailnet probe completes in
// under a second; this is just the upper bound.
const DEFAULT_SSH_PROBE_TIMEOUT_MS = 15_000;
const DIRECT_CONCURRENCY = 4;
const VIA_RELAY_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Public probe primitives
// ---------------------------------------------------------------------------

/**
 * Cheap TCP 3-way handshake against `host:port`. Used as a fast-fail before
 * the expensive `probeDirectSsh`. Returns connect time in ms or null on
 * failure / timeout.
 */
export function probeDirectTcp(host: string, port: number, timeoutMs = DEFAULT_TCP_TIMEOUT_MS): Promise<number | null> {
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
      done(Number(ns / 1_000n) / 1_000);
    });
    sock.once("error", () => { clearTimeout(timer); done(null); });
  });
}

/**
 * Real-latency probe: time `ssh <sshHost> -- true` end-to-end. The same
 * shape `nagent attach` uses, minus the PTY/cmd payload. Returns ms or null.
 */
export function probeDirectSsh(sshHost: string, timeoutMs = DEFAULT_SSH_PROBE_TIMEOUT_MS): Promise<number | null> {
  return timedSshExec(sshHost, [], timeoutMs);
}

/**
 * Same shape, via the ssh-jump relay. The ProxyCommand-with-nagent-identity
 * args mirror what `resolveSshTransportArgs` emits at attach time, so the
 * measurement is what users actually experience.
 */
export function probeSshJump(
  sshJumpTarget: string,
  sshHost: string,
  timeoutMs = DEFAULT_SSH_PROBE_TIMEOUT_MS,
  hostNameOverride?: string,
): Promise<number | null> {
  const nagentKey = paths().sshKey;
  const extra = [
    "-o",
    `ProxyCommand=ssh -i ${nagentKey} -o IdentitiesOnly=yes -o BatchMode=yes ` +
      `-o StrictHostKeyChecking=accept-new -W %h:%p ${sshJumpTarget}`,
  ];
  if (hostNameOverride) extra.push("-o", `HostName=${hostNameOverride}`);
  return timedSshExec(sshHost, extra, timeoutMs);
}

/** Backward-compat alias for callers that haven't switched yet. Prefer probeDirectTcp. */
export const probeDirect = probeDirectTcp;

// ---------------------------------------------------------------------------
// Probe round — runs every interval (or on `nagent path probe`)
// ---------------------------------------------------------------------------

export interface RunProbeOpts {
  netId: string;
  selfNodeName: string;
  /** Read from peers.json; if omitted, the function reads it itself. */
  peers?: Peer[];
  /** RelayClient instance whose connected relays we should poll for STATUS. */
  relayClient?: RelayClient;
  /** Names of pinned TLS relays to query. Defaults to relayClient's connected set. */
  relayNames?: string[];
  /** TCP-fast-fail timeout (ms). Default 1500. */
  tcpProbeTimeoutMs?: number;
  /** SSH-probe wall-clock timeout (ms). Default 6000. */
  sshProbeTimeoutMs?: number;
  /** Override which pinned ssh-jump relays to probe. */
  sshJumpRelays?: SshJumpPinnedRelay[];
  /** @deprecated use `tcpProbeTimeoutMs`. Kept for backward compat. */
  directTimeoutMs?: number;
  /** @deprecated use `sshProbeTimeoutMs`. Kept for backward compat. */
  sshJumpTimeoutMs?: number;
}

export async function runProbeRound(opts: RunProbeOpts): Promise<PathTable> {
  const peers =
    opts.peers ?? (await readJson<Peer[]>(paths().netPeers(opts.netId))) ?? [];
  const otherPeers = peers.filter((p) => p.nodeName !== opts.selfNodeName);

  const tcpTimeoutMs = opts.tcpProbeTimeoutMs ?? opts.directTimeoutMs ?? DEFAULT_TCP_TIMEOUT_MS;
  const sshTimeoutMs = opts.sshProbeTimeoutMs ?? opts.sshJumpTimeoutMs ?? DEFAULT_SSH_PROBE_TIMEOUT_MS;

  // ---- Direct probes (TCP fast-fail → real SSH handshake) ----
  const direct: Record<string, DirectSample> = {};
  await runWithConcurrency(otherPeers, DIRECT_CONCURRENCY, async (peer) => {
    const target = peer.addresses[0];
    if (target) {
      const { host, port } = splitHostPort(target);
      const tcpOk = await probeDirectTcp(host, port, tcpTimeoutMs);
      if (tcpOk === null) {
        direct[peer.nodeName] = { ms: null, lastFailedAt: new Date().toISOString() };
        return;
      }
    }
    const sshHost = `nagent.${peer.nodeName}`;
    const ms = await probeDirectSsh(sshHost, sshTimeoutMs);
    direct[peer.nodeName] = ms === null
      ? { ms: null, lastFailedAt: new Date().toISOString() }
      : { ms, lastOk: new Date().toISOString() };
  });

  // ---- TLS-relay STATUS pulls (v0.5; PING/PONG-based, already comparable) ----
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
        relays[name] = { myRttMs: myRtt, lastSeen: new Date().toISOString(), peers: peerMap };
      } catch {
        relays[name] = { myRttMs: myRtt, lastSeen: new Date(0).toISOString(), peers: {} };
      }
    }
  }

  // ---- ssh-jump probes (v0.5.1; real ssh-through-ssh) ----
  const sshJumpRelays = opts.sshJumpRelays
    ?? (await readPinnedRelays()).filter((r): r is SshJumpPinnedRelay => r.transport === "ssh-jump");
  if (sshJumpRelays.length > 0) {
    for (const relay of sshJumpRelays) {
      const { host, port } = parseSshTargetForTcpProbe(relay.sshTarget);
      const myRttMs = await probeDirectTcp(host, port, tcpTimeoutMs);
      const peerMap: Record<string, { ms: number | null; lastSeen: string }> = {};
      // Skip per-peer probes if the relay itself is unreachable — saves the
      // full sshProbeTimeoutMs × peerCount wait when relay is down.
      if (myRttMs !== null) {
        const pairs = otherPeers.map((p) => ({ peer: p, relay }));
        await runWithConcurrency(pairs, VIA_RELAY_CONCURRENCY, async ({ peer }) => {
          const magic = await magicDnsFor(peer.nodeName);
          const ms = await probeSshJump(relay.sshTarget, `nagent.${peer.nodeName}`, sshTimeoutMs, magic ?? undefined);
          peerMap[peer.nodeName] = ms === null
            ? { ms: null, lastSeen: new Date(0).toISOString() }
            : { ms, lastSeen: new Date().toISOString() };
        });
      } else {
        // Relay unreachable — mark all peers under it as null.
        for (const p of otherPeers) peerMap[p.nodeName] = { ms: null, lastSeen: new Date(0).toISOString() };
      }
      relays[relay.name] = { myRttMs, lastSeen: new Date().toISOString(), peers: peerMap };
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `ssh [extraArgs] <sshHost> -- true` with consistent flags
 * (BatchMode, ConnectTimeout, accept-new host keys), and time the wall
 * clock. Used by both probeDirectSsh and probeSshJump so the numbers are
 * directly comparable.
 */
function timedSshExec(sshHost: string, extraArgs: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const args = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      "-o", "StrictHostKeyChecking=accept-new",
      ...extraArgs,
      sshHost,
      "--",
      "true",
    ];
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

function parseSshTargetForTcpProbe(target: string): { host: string; port: number } {
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
