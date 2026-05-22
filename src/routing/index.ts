// Path-table types + chooseTransport() — the selection algorithm consumed by
// the 4 SSH spawn sites (attach, list, gossip, web-bridge) and by `nagent
// path status` / `nagent attach --via auto`.

export type Transport =
  | { type: "direct" }
  | { type: "via"; relay: string };

export interface PathTable {
  v: 1;
  node: string;
  updatedAt: string;
  direct: Record<string, DirectSample>;
  relays: Record<string, RelaySample>;
}

export interface DirectSample {
  /** Round-trip estimate in milliseconds; null = last probe failed. */
  ms: number | null;
  lastOk?: string;
  lastFailedAt?: string;
}

export interface RelaySample {
  /** This node's measured RTT to the relay (from PING/PONG). null until first PONG. */
  myRttMs: number | null;
  /** When we last heard from this relay. */
  lastSeen: string;
  /** Relay-side measured RTT from the relay to each registered peer. */
  peers: Record<string, { ms: number | null; lastSeen: string }>;
}

export const EMPTY_PATH_TABLE: PathTable = {
  v: 1,
  node: "",
  updatedAt: new Date(0).toISOString(),
  direct: {},
  relays: {},
};

export interface ChooseTransportOpts {
  /**
   * Manual override:
   *  - "auto" or undefined: pick lowest-latency.
   *  - "direct": force direct, even if no probe yet.
   *  - "<relayName>": force routing via that named relay.
   */
  via?: string;
  /** Default 10 ms (Tailscale's choice). */
  hysteresisMs?: number;
  /**
   * If set, the choice from a previous call to `chooseTransport()`. The
   * function returns it unchanged if it's still within `hysteresisMs` of the
   * fresh best — prevents flap between near-equal paths.
   */
  stickyTo?: Transport;
}

interface Candidate {
  transport: Transport;
  /** Estimated ms; finite numbers only — nulls filtered out. */
  score: number;
}

export function chooseTransport(
  table: PathTable,
  target: string,
  opts?: ChooseTransportOpts,
): Transport {
  // Manual override beats everything.
  if (opts?.via === "direct") return { type: "direct" };
  if (opts?.via && opts.via !== "auto") {
    return { type: "via", relay: opts.via };
  }

  const candidates: Candidate[] = [];

  // Direct candidate.
  const direct = table.direct[target];
  if (direct && typeof direct.ms === "number" && Number.isFinite(direct.ms)) {
    candidates.push({ transport: { type: "direct" }, score: direct.ms });
  }

  // Each known relay.
  for (const [relayName, sample] of Object.entries(table.relays)) {
    if (sample.myRttMs === null) continue;
    const peerSample = sample.peers[target];
    if (!peerSample || peerSample.ms === null) continue;
    if (!Number.isFinite(sample.myRttMs) || !Number.isFinite(peerSample.ms)) continue;
    candidates.push({
      transport: { type: "via", relay: relayName },
      score: sample.myRttMs + peerSample.ms,
    });
  }

  // Nothing to compare → graceful fallback. We pick direct so the eventual
  // ssh failure is the right "cannot reach" signal.
  if (candidates.length === 0) return { type: "direct" };

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0]!;

  // Hysteresis: keep stickyTo if it's still within hysteresisMs of best.
  if (opts?.stickyTo) {
    const sticky = findCandidate(candidates, opts.stickyTo);
    if (sticky && sticky.score <= best.score + (opts.hysteresisMs ?? 10)) {
      return opts.stickyTo;
    }
  }

  return best.transport;
}

function findCandidate(cs: Candidate[], t: Transport): Candidate | undefined {
  return cs.find((c) => transportEqual(c.transport, t));
}

export function transportEqual(a: Transport, b: Transport): boolean {
  if (a.type === "direct" && b.type === "direct") return true;
  if (a.type === "via" && b.type === "via") return a.relay === b.relay;
  return false;
}

export function transportLabel(t: Transport): string {
  return t.type === "direct" ? "direct" : `via:${t.relay}`;
}
