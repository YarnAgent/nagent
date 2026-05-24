// Pinned-relays store at ~/.nagent/relays.json.
//
// v0.5 shipped a single shape (tls + fingerprint + url). v0.5.1 introduces
// a second transport, `ssh-jump`, with its own fields. Legacy records (no
// `transport` field) load as `"tls"` for backward compat.
//
// Writes happen via the CLI (src/cli/relay.ts); reads from the daemon
// (relay-client startup), the routing layer (transport selection), and
// the CLI (list).

import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
import type { PinnedRelay as RelayClientPin } from "./client.js";

export interface TlsPinnedRelay {
  transport: "tls";
  name: string;
  url: string;          // https://host:port
  fingerprint: string;  // SHA-256 colon-separated uppercase hex
  pinnedAt: string;
}

export interface SshJumpPinnedRelay {
  transport: "ssh-jump";
  name: string;
  sshTarget: string;    // "user@host" or "user@host:port"
  pinnedAt: string;
}

export type PinnedRelayRecord = TlsPinnedRelay | SshJumpPinnedRelay;

interface PinnedRelaysFile {
  v: 1;
  relays: Record<string, RawRelayRecord>;
}

// On-disk shape — same as PinnedRelayRecord but `transport` is optional for
// legacy records and key fields are looser. We narrow when parsing.
interface RawRelayRecord {
  transport?: "tls" | "ssh-jump";
  url?: string;
  fingerprint?: string;
  sshTarget?: string;
  pinnedAt?: string;
}

/** All pinned relays (any transport). Empty array if none / file missing. */
export async function readPinnedRelays(): Promise<PinnedRelayRecord[]> {
  try {
    const raw = await fs.readFile(paths().pinnedRelays, "utf8");
    const obj = JSON.parse(raw) as PinnedRelaysFile;
    if (obj.v !== 1 || !obj.relays) return [];
    const out: PinnedRelayRecord[] = [];
    for (const [name, r] of Object.entries(obj.relays)) {
      const rec = parseRecord(name, r);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Only TLS-transport relays, shaped for the RelayClient constructor input.
 * The relay-client doesn't know how to talk ssh-jump (they're handled by
 * the routing layer at SSH spawn time, not by a long-lived connection).
 */
export async function readPinnedTlsRelays(): Promise<RelayClientPin[]> {
  const all = await readPinnedRelays();
  const out: RelayClientPin[] = [];
  for (const r of all) {
    if (r.transport === "tls") out.push({ name: r.name, url: r.url, fingerprint: r.fingerprint });
  }
  return out;
}

/** Find a pinned record by name, or null. */
export async function findPinnedRelay(name: string): Promise<PinnedRelayRecord | null> {
  const all = await readPinnedRelays();
  return all.find((r) => r.name === name) ?? null;
}

function parseRecord(name: string, r: RawRelayRecord): PinnedRelayRecord | null {
  const pinnedAt = typeof r.pinnedAt === "string" ? r.pinnedAt : new Date(0).toISOString();
  const transport: "tls" | "ssh-jump" = r.transport ?? "tls";
  if (transport === "tls") {
    if (typeof r.url !== "string" || !r.url) return null;
    if (typeof r.fingerprint !== "string" || !r.fingerprint) return null;
    return { transport: "tls", name, url: r.url, fingerprint: r.fingerprint, pinnedAt };
  }
  if (transport === "ssh-jump") {
    if (typeof r.sshTarget !== "string" || !r.sshTarget) return null;
    return { transport: "ssh-jump", name, sshTarget: r.sshTarget, pinnedAt };
  }
  return null;
}
