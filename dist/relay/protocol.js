// Payload schemas + validators for the nagent-relay wire protocol (ADR-0003).
//
// Each function takes a `Buffer` payload (already extracted from the frame by
// frame.ts) and either returns a typed object or throws. We keep validation
// hand-rolled to avoid a zod runtime dep; surface is small.
import { decodeDataPayload, decodeClosePayload, decodeTimestampPayload } from "./frame.js";
export const PROTOCOL_VERSION = 1;
export function parseRegisterPayload(p) {
    const obj = parseJsonObject(p, "REGISTER");
    return {
        nodeName: requireNonEmptyString(obj, "nodeName"),
        pubKey: requireNonEmptyString(obj, "pubKey"),
        nonce: requireNonEmptyString(obj, "nonce"),
        sig: requireNonEmptyString(obj, "sig"),
        ...(typeof obj.netId === "string" && obj.netId ? { netId: obj.netId } : {}),
    };
}
export function parseRegisterOkPayload(p) {
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
export function parseRegisterRejectPayload(p) {
    const obj = parseJsonObject(p, "REGISTER_REJECT");
    return { reason: requireNonEmptyString(obj, "reason") };
}
export function parseOpenPayload(p) {
    const obj = parseJsonObject(p, "OPEN");
    const streamId = requireUint32(obj, "streamId");
    const out = { streamId };
    if (typeof obj.dstNodeName === "string" && obj.dstNodeName)
        out.dstNodeName = obj.dstNodeName;
    if (typeof obj.srcNodeName === "string" && obj.srcNodeName)
        out.srcNodeName = obj.srcNodeName;
    return out;
}
export function parseOpenOkPayload(p) {
    const obj = parseJsonObject(p, "OPEN_OK");
    return { streamId: requireUint32(obj, "streamId") };
}
export function parseOpenRejectPayload(p) {
    const obj = parseJsonObject(p, "OPEN_REJECT");
    return {
        streamId: requireUint32(obj, "streamId"),
        reason: requireNonEmptyString(obj, "reason"),
    };
}
export function parseStatusOkPayload(p) {
    const obj = parseJsonObject(p, "STATUS_OK");
    const peers = obj.peers;
    if (!Array.isArray(peers))
        throw new Error("STATUS_OK: peers must be an array");
    return {
        relayName: requireNonEmptyString(obj, "relayName"),
        peers: peers.map((raw, i) => parseStatusPeerEntry(raw, i)),
    };
}
function parseStatusPeerEntry(raw, idx) {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`STATUS_OK.peers[${idx}]: not an object`);
    }
    const obj = raw;
    const node = obj.node;
    if (typeof node !== "string" || !node)
        throw new Error(`STATUS_OK.peers[${idx}].node: missing`);
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
/**
 * Parse a raw frame into a typed message. Throws on protocol violations.
 * Returns `null` for unknown verbs — caller can log + ignore for forward
 * compatibility (we may add verbs in v0.5.x).
 */
export function parseTypedFrame(f) {
    switch (f.verb) {
        case 1 /* Verb.REGISTER */: return { verb: f.verb, payload: parseRegisterPayload(f.payload) };
        case 2 /* Verb.REGISTER_OK */: return { verb: f.verb, payload: parseRegisterOkPayload(f.payload) };
        case 130 /* Verb.REGISTER_REJECT */: return { verb: f.verb, payload: parseRegisterRejectPayload(f.payload) };
        case 3 /* Verb.OPEN */: return { verb: f.verb, payload: parseOpenPayload(f.payload) };
        case 4 /* Verb.OPEN_OK */: return { verb: f.verb, payload: parseOpenOkPayload(f.payload) };
        case 132 /* Verb.OPEN_REJECT */: return { verb: f.verb, payload: parseOpenRejectPayload(f.payload) };
        case 5 /* Verb.DATA */: return { verb: f.verb, payload: decodeDataPayload(f.payload) };
        case 6 /* Verb.CLOSE */: return { verb: f.verb, payload: decodeClosePayload(f.payload) };
        case 7 /* Verb.PING */: return { verb: f.verb, payload: { tsMicros: decodeTimestampPayload(f.payload) } };
        case 8 /* Verb.PONG */: return { verb: f.verb, payload: { tsMicros: decodeTimestampPayload(f.payload) } };
        case 9 /* Verb.STATUS_REQ */: return { verb: f.verb, payload: {} };
        case 10 /* Verb.STATUS_OK */: return { verb: f.verb, payload: parseStatusOkPayload(f.payload) };
        default: return null;
    }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function parseJsonObject(p, where) {
    let raw;
    try {
        raw = JSON.parse(p.toString("utf8"));
    }
    catch (err) {
        throw new Error(`${where}: invalid JSON: ${err.message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${where}: payload must be a JSON object`);
    }
    return raw;
}
function requireNonEmptyString(obj, key) {
    const v = obj[key];
    if (typeof v !== "string" || !v) {
        throw new Error(`missing or empty string field "${key}"`);
    }
    return v;
}
function requireUint32(obj, key) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
        throw new Error(`field "${key}" must be uint32 (got ${String(v)})`);
    }
    return v;
}
//# sourceMappingURL=protocol.js.map