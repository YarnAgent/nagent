// Payload schemas + validators for the nagent-relay wire protocol (ADR-0003).
//
// Each function takes a `Buffer` payload (already extracted from the frame by
// frame.ts) and either returns a typed object or throws. We keep validation
// hand-rolled to avoid a zod runtime dep; surface is small.

import { Verb, type Frame, decodeDataPayload, decodeClosePayload, decodeTimestampPayload } from "./frame.js";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// CHALLENGE (R→C) — server-issued nonce the client must sign in REGISTER.
// ---------------------------------------------------------------------------

export interface ChallengePayload {
  /** Base64url-encoded 32 random bytes. */
  nonce: string;
}

export function parseChallengePayload(p: Buffer): ChallengePayload {
  const obj = parseJsonObject(p, "CHALLENGE");
  return { nonce: requireNonEmptyString(obj, "nonce") };
}

// ---------------------------------------------------------------------------
// REGISTER (C→R)
// ---------------------------------------------------------------------------

export interface RegisterPayload {
  /** Caller's nagent node name. Must match a peer record in the allowlist. */
  nodeName: string;
  /** Base64url-encoded raw 32-byte ed25519 public key. */
  pubKey: string;
  /** Base64url challenge nonce echoed back from a relay-issued challenge. */
  nonce: string;
  /** Base64url ed25519 signature over the raw nonce bytes. */
  sig: string;
  /** Optional net scope; if omitted, the relay's union of all nets applies. */
  netId?: string;
}

export function parseRegisterPayload(p: Buffer): RegisterPayload {
  const obj = parseJsonObject(p, "REGISTER");
  return {
    nodeName: requireNonEmptyString(obj, "nodeName"),
    pubKey: requireNonEmptyString(obj, "pubKey"),
    nonce: requireNonEmptyString(obj, "nonce"),
    sig: requireNonEmptyString(obj, "sig"),
    ...(typeof obj.netId === "string" && obj.netId ? { netId: obj.netId } : {}),
  };
}

export interface RegisterOkPayload {
  relayName: string;
  version: number;
}

export function parseRegisterOkPayload(p: Buffer): RegisterOkPayload {
  const obj = parseJsonObject(p, "REGISTER_OK");
  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`REGISTER_OK: invalid version: ${String(version)}`);
  }
  return {
    relayName: requireNonEmptyString(obj, "relayName"),
    version,
  };
}

export interface RegisterRejectPayload {
  reason: string;
}

export function parseRegisterRejectPayload(p: Buffer): RegisterRejectPayload {
  const obj = parseJsonObject(p, "REGISTER_REJECT");
  return { reason: requireNonEmptyString(obj, "reason") };
}

// ---------------------------------------------------------------------------
// OPEN / OPEN_OK / OPEN_REJECT
// ---------------------------------------------------------------------------

export interface OpenPayload {
  /** Caller-allocated stream id, scoped to the sender's connection. */
  streamId: number;
  /** Required when client sends to relay; absent when relay forwards to dst. */
  dstNodeName?: string;
  /** Optional: indicates an inbound stream from this srcNodeName (relay→dst). */
  srcNodeName?: string;
}

export function parseOpenPayload(p: Buffer): OpenPayload {
  const obj = parseJsonObject(p, "OPEN");
  const streamId = requireUint32(obj, "streamId");
  const out: OpenPayload = { streamId };
  if (typeof obj.dstNodeName === "string" && obj.dstNodeName) out.dstNodeName = obj.dstNodeName;
  if (typeof obj.srcNodeName === "string" && obj.srcNodeName) out.srcNodeName = obj.srcNodeName;
  return out;
}

export interface OpenOkPayload {
  streamId: number;
}

export function parseOpenOkPayload(p: Buffer): OpenOkPayload {
  const obj = parseJsonObject(p, "OPEN_OK");
  return { streamId: requireUint32(obj, "streamId") };
}

export interface OpenRejectPayload {
  streamId: number;
  reason: string;
}

export function parseOpenRejectPayload(p: Buffer): OpenRejectPayload {
  const obj = parseJsonObject(p, "OPEN_REJECT");
  return {
    streamId: requireUint32(obj, "streamId"),
    reason: requireNonEmptyString(obj, "reason"),
  };
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

export interface StatusPeerEntry {
  node: string;
  rttMs: number | null;
  lastSeen: string;
}

export interface StatusOkPayload {
  relayName: string;
  peers: StatusPeerEntry[];
}

export function parseStatusOkPayload(p: Buffer): StatusOkPayload {
  const obj = parseJsonObject(p, "STATUS_OK");
  const peers: unknown = obj.peers;
  if (!Array.isArray(peers)) throw new Error("STATUS_OK: peers must be an array");
  return {
    relayName: requireNonEmptyString(obj, "relayName"),
    peers: peers.map((raw, i) => parseStatusPeerEntry(raw, i)),
  };
}

function parseStatusPeerEntry(raw: unknown, idx: number): StatusPeerEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`STATUS_OK.peers[${idx}]: not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const node = obj.node;
  if (typeof node !== "string" || !node) throw new Error(`STATUS_OK.peers[${idx}].node: missing`);
  const rttMs = obj.rttMs;
  if (rttMs !== null && (typeof rttMs !== "number" || !Number.isFinite(rttMs))) {
    throw new Error(`STATUS_OK.peers[${idx}].rttMs: must be number or null`);
  }
  const lastSeen = obj.lastSeen;
  if (typeof lastSeen !== "string" || !lastSeen) {
    throw new Error(`STATUS_OK.peers[${idx}].lastSeen: missing`);
  }
  return { node, rttMs, lastSeen };
}

// ---------------------------------------------------------------------------
// DATA / CLOSE / PING / PONG — re-exported for convenience.
// ---------------------------------------------------------------------------

export { decodeDataPayload, decodeClosePayload, decodeTimestampPayload };

// ---------------------------------------------------------------------------
// Frame → typed message dispatch helper.
// ---------------------------------------------------------------------------

export type TypedFrame =
  | { verb: Verb.CHALLENGE; payload: ChallengePayload }
  | { verb: Verb.REGISTER; payload: RegisterPayload }
  | { verb: Verb.REGISTER_OK; payload: RegisterOkPayload }
  | { verb: Verb.REGISTER_REJECT; payload: RegisterRejectPayload }
  | { verb: Verb.OPEN; payload: OpenPayload }
  | { verb: Verb.OPEN_OK; payload: OpenOkPayload }
  | { verb: Verb.OPEN_REJECT; payload: OpenRejectPayload }
  | { verb: Verb.DATA; payload: { streamId: number; bytes: Buffer } }
  | { verb: Verb.CLOSE; payload: { streamId: number; reason?: string } }
  | { verb: Verb.PING; payload: { tsMicros: bigint } }
  | { verb: Verb.PONG; payload: { tsMicros: bigint } }
  | { verb: Verb.STATUS_REQ; payload: Record<string, never> }
  | { verb: Verb.STATUS_OK; payload: StatusOkPayload };

/**
 * Parse a raw frame into a typed message. Throws on protocol violations.
 * Returns `null` for unknown verbs — caller can log + ignore for forward
 * compatibility (we may add verbs in v0.5.x).
 */
export function parseTypedFrame(f: Frame): TypedFrame | null {
  switch (f.verb) {
    case Verb.CHALLENGE:       return { verb: f.verb, payload: parseChallengePayload(f.payload) };
    case Verb.REGISTER:        return { verb: f.verb, payload: parseRegisterPayload(f.payload) };
    case Verb.REGISTER_OK:     return { verb: f.verb, payload: parseRegisterOkPayload(f.payload) };
    case Verb.REGISTER_REJECT: return { verb: f.verb, payload: parseRegisterRejectPayload(f.payload) };
    case Verb.OPEN:            return { verb: f.verb, payload: parseOpenPayload(f.payload) };
    case Verb.OPEN_OK:         return { verb: f.verb, payload: parseOpenOkPayload(f.payload) };
    case Verb.OPEN_REJECT:     return { verb: f.verb, payload: parseOpenRejectPayload(f.payload) };
    case Verb.DATA:            return { verb: f.verb, payload: decodeDataPayload(f.payload) };
    case Verb.CLOSE:           return { verb: f.verb, payload: decodeClosePayload(f.payload) };
    case Verb.PING:            return { verb: f.verb, payload: { tsMicros: decodeTimestampPayload(f.payload) } };
    case Verb.PONG:            return { verb: f.verb, payload: { tsMicros: decodeTimestampPayload(f.payload) } };
    case Verb.STATUS_REQ:      return { verb: f.verb, payload: {} as Record<string, never> };
    case Verb.STATUS_OK:       return { verb: f.verb, payload: parseStatusOkPayload(f.payload) };
    default:                   return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseJsonObject(p: Buffer, where: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(p.toString("utf8"));
  } catch (err) {
    throw new Error(`${where}: invalid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: payload must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function requireNonEmptyString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`missing or empty string field "${key}"`);
  }
  return v;
}

function requireUint32(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new Error(`field "${key}" must be uint32 (got ${String(v)})`);
  }
  return v;
}
