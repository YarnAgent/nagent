// Relay allowlist: union of every joined net's peers.json + explicit grants.
// Consulted on every REGISTER; small enough to read on each connection (a
// real high-volume deployment would cache + invalidate, but we cap dev relays
// at a few hundred peers).

import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import type { Peer } from "../types/index.js";

export interface AllowedPeer {
  nodeName: string;
  pubKey: string;
  source: "net" | "explicit";
  netId?: string; // populated when source === "net"
}

export interface ExplicitGrant {
  node: string;
  pubKey: string;
  grantedAt: string;
}

interface AllowlistFile {
  v: 1;
  grants: ExplicitGrant[];
}

const FILE_VERSION = 1 as const;

/**
 * Read every joined net's peers.json + the explicit allowlist file, returning
 * a flat list of allowed (nodeName, pubKey) tuples. The same peer may appear
 * twice (e.g. in both sources); callers should dedupe via `findAllowed`.
 */
export async function loadAllowlist(): Promise<AllowedPeer[]> {
  const out: AllowedPeer[] = [];

  // 1) Walk ~/.nagent/nets/<netId>/peers.json
  let netIds: string[] = [];
  try {
    netIds = await fs.readdir(paths().netsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const netId of netIds) {
    const peers = await readJson<Peer[]>(paths().netPeers(netId));
    if (!peers || !Array.isArray(peers)) continue;
    for (const p of peers) {
      if (typeof p.nodeName === "string" && typeof p.pubKey === "string" && p.nodeName && p.pubKey) {
        out.push({ nodeName: p.nodeName, pubKey: p.pubKey, source: "net", netId });
      }
    }
  }

  // 2) Explicit grants
  const explicit = await loadExplicit();
  for (const g of explicit.grants) {
    out.push({ nodeName: g.node, pubKey: g.pubKey, source: "explicit" });
  }

  return out;
}

/**
 * Linear lookup: returns the first matching (nodeName, pubKey) entry, or null.
 * Both fields must match — node names alone don't authorize.
 */
export function findAllowed(
  allowlist: ReadonlyArray<AllowedPeer>,
  nodeName: string,
  pubKey: string,
): AllowedPeer | null {
  for (const a of allowlist) {
    if (a.nodeName === nodeName && a.pubKey === pubKey) return a;
  }
  return null;
}

/** Add an explicit grant. Replaces any prior grant for the same nodeName. */
export async function addGrant(node: string, pubKey: string, now: Date = new Date()): Promise<ExplicitGrant> {
  if (!node || !pubKey) throw new Error("addGrant: node and pubKey are required");
  const cur = await loadExplicit();
  const next = cur.grants.filter((g) => g.node !== node);
  const entry: ExplicitGrant = { node, pubKey, grantedAt: now.toISOString() };
  next.push(entry);
  next.sort((a, b) => a.node.localeCompare(b.node));
  await writeJson(paths().relayAllowlist, { v: FILE_VERSION, grants: next } satisfies AllowlistFile);
  return entry;
}

/** Remove an explicit grant by nodeName. Returns true if something was removed. */
export async function removeGrant(node: string): Promise<boolean> {
  const cur = await loadExplicit();
  const next = cur.grants.filter((g) => g.node !== node);
  if (next.length === cur.grants.length) return false;
  await writeJson(paths().relayAllowlist, { v: FILE_VERSION, grants: next } satisfies AllowlistFile);
  return true;
}

/** Return the explicit grants only (excludes mesh-peers.json). */
export async function listGrants(): Promise<ExplicitGrant[]> {
  return (await loadExplicit()).grants;
}

async function loadExplicit(): Promise<AllowlistFile> {
  const raw = await readJson<AllowlistFile>(paths().relayAllowlist);
  if (!raw || !Array.isArray(raw.grants)) return { v: FILE_VERSION, grants: [] };
  // Lenient: keep only well-formed entries; ignore the rest. Lets us evolve
  // the schema without breaking running relays.
  const grants: ExplicitGrant[] = [];
  for (const g of raw.grants) {
    if (g && typeof g.node === "string" && typeof g.pubKey === "string" && g.node && g.pubKey) {
      grants.push({
        node: g.node,
        pubKey: g.pubKey,
        grantedAt: typeof g.grantedAt === "string" ? g.grantedAt : new Date(0).toISOString(),
      });
    }
  }
  return { v: FILE_VERSION, grants };
}
