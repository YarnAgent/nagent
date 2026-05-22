// Binary frame codec for the nagent-relay wire protocol (ADR-0003).
//
// Each frame on the wire:
//   [ 4 bytes BE: body length (verb + payload) ]
//   [ 1 byte:     verb ]
//   [ N bytes:    payload (verb-specific) ]
//
// The codec is dumb: it splits the wire stream into (verb, body) frames. Verb-
// specific parsing (JSON, streamId+bytes, timestamp) lives in protocol.ts.

const LENGTH_PREFIX_BYTES = 4;

// 1 MiB DATA payload + a little slack for headers + small JSON metadata frames.
// The relay daemon rejects anything bigger; we never *send* anything bigger.
export const MAX_FRAME_BODY = 1024 * 1024 + 32;

export const enum Verb {
  REGISTER         = 0x01,
  REGISTER_OK      = 0x02,
  OPEN             = 0x03,
  OPEN_OK          = 0x04,
  DATA             = 0x05,
  CLOSE            = 0x06,
  PING             = 0x07,
  PONG             = 0x08,
  STATUS_REQ       = 0x09,
  STATUS_OK        = 0x0a,
  REGISTER_REJECT  = 0x82,
  OPEN_REJECT      = 0x84,
}

const VERB_NAMES: Record<number, string> = {
  [Verb.REGISTER]: "REGISTER",
  [Verb.REGISTER_OK]: "REGISTER_OK",
  [Verb.OPEN]: "OPEN",
  [Verb.OPEN_OK]: "OPEN_OK",
  [Verb.DATA]: "DATA",
  [Verb.CLOSE]: "CLOSE",
  [Verb.PING]: "PING",
  [Verb.PONG]: "PONG",
  [Verb.STATUS_REQ]: "STATUS_REQ",
  [Verb.STATUS_OK]: "STATUS_OK",
  [Verb.REGISTER_REJECT]: "REGISTER_REJECT",
  [Verb.OPEN_REJECT]: "OPEN_REJECT",
};

export function verbName(v: number): string {
  return VERB_NAMES[v] ?? `UNKNOWN(0x${v.toString(16).padStart(2, "0")})`;
}

export interface Frame {
  verb: Verb;
  payload: Buffer;
}

/**
 * Encode a frame with `verb` and the given `payload` bytes.
 * Throws if the resulting body would exceed MAX_FRAME_BODY.
 */
export function encodeFrame(verb: Verb, payload: Buffer): Buffer {
  const bodyLen = 1 + payload.length;
  if (bodyLen > MAX_FRAME_BODY) {
    throw new Error(`frame too large: ${bodyLen} > ${MAX_FRAME_BODY}`);
  }
  const out = Buffer.alloc(LENGTH_PREFIX_BYTES + bodyLen);
  out.writeUInt32BE(bodyLen, 0);
  out.writeUInt8(verb, LENGTH_PREFIX_BYTES);
  payload.copy(out, LENGTH_PREFIX_BYTES + 1);
  return out;
}

export function encodeJsonFrame(verb: Verb, obj: unknown): Buffer {
  return encodeFrame(verb, Buffer.from(JSON.stringify(obj), "utf8"));
}

/** DATA frame: [4-byte BE streamId][raw bytes]. */
export function encodeDataFrame(streamId: number, bytes: Buffer): Buffer {
  assertStreamId(streamId);
  const body = Buffer.alloc(4 + bytes.length);
  body.writeUInt32BE(streamId, 0);
  bytes.copy(body, 4);
  return encodeFrame(Verb.DATA, body);
}

/** CLOSE frame: [4-byte BE streamId][optional JSON reason]. */
export function encodeCloseFrame(streamId: number, reason?: string): Buffer {
  assertStreamId(streamId);
  const reasonBytes = reason ? Buffer.from(JSON.stringify({ reason }), "utf8") : Buffer.alloc(0);
  const body = Buffer.alloc(4 + reasonBytes.length);
  body.writeUInt32BE(streamId, 0);
  reasonBytes.copy(body, 4);
  return encodeFrame(Verb.CLOSE, body);
}

/** PING/PONG: [8-byte BE microsecond timestamp]. */
export function encodePingFrame(tsMicros: bigint): Buffer {
  const body = Buffer.alloc(8);
  body.writeBigUInt64BE(tsMicros, 0);
  return encodeFrame(Verb.PING, body);
}

export function encodePongFrame(echoedTsMicros: bigint): Buffer {
  const body = Buffer.alloc(8);
  body.writeBigUInt64BE(echoedTsMicros, 0);
  return encodeFrame(Verb.PONG, body);
}

/** Decode DATA payload bytes (no header) into {streamId, payload}. */
export function decodeDataPayload(p: Buffer): { streamId: number; bytes: Buffer } {
  if (p.length < 4) throw new Error(`DATA payload too short: ${p.length}`);
  return { streamId: p.readUInt32BE(0), bytes: p.subarray(4) };
}

/** Decode CLOSE payload bytes (no header) into {streamId, reason?}. */
export function decodeClosePayload(p: Buffer): { streamId: number; reason?: string } {
  if (p.length < 4) throw new Error(`CLOSE payload too short: ${p.length}`);
  const streamId = p.readUInt32BE(0);
  const rest = p.subarray(4);
  if (rest.length === 0) return { streamId };
  try {
    const obj = JSON.parse(rest.toString("utf8")) as { reason?: unknown };
    return typeof obj.reason === "string" ? { streamId, reason: obj.reason } : { streamId };
  } catch {
    return { streamId };
  }
}

/** Decode PING/PONG payload into a microsecond timestamp. */
export function decodeTimestampPayload(p: Buffer): bigint {
  if (p.length !== 8) throw new Error(`PING/PONG payload must be 8 bytes, got ${p.length}`);
  return p.readBigUInt64BE(0);
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new Error(`invalid streamId: ${streamId}`);
  }
}

/**
 * Streaming frame decoder. Push incoming bytes via push(); pull complete
 * frames via the iterator. The decoder retains partial trailing bytes for
 * the next push().
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Frame[] = [];
    while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
      const bodyLen = this.buffer.readUInt32BE(0);
      if (bodyLen === 0) {
        throw new Error("invalid frame: body length must be >= 1 (verb byte required)");
      }
      if (bodyLen > MAX_FRAME_BODY) {
        throw new Error(`frame too large: ${bodyLen} > ${MAX_FRAME_BODY}`);
      }
      if (this.buffer.length < LENGTH_PREFIX_BYTES + bodyLen) break;
      const verb = this.buffer.readUInt8(LENGTH_PREFIX_BYTES) as Verb;
      const payload = Buffer.from(
        this.buffer.subarray(LENGTH_PREFIX_BYTES + 1, LENGTH_PREFIX_BYTES + bodyLen),
      );
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + bodyLen);
      out.push({ verb, payload });
    }
    return out;
  }

  get pending(): number {
    return this.buffer.length;
  }
}

export const _internal = { LENGTH_PREFIX_BYTES };
