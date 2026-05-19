import type { BusFrame } from "../types/index.js";

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(frame: BusFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${body.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): BusFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: BusFrame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`frame too large: ${len}`);
      }
      if (this.buffer.length < HEADER_BYTES + len) break;
      const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
      this.buffer = this.buffer.subarray(HEADER_BYTES + len);
      try {
        out.push(JSON.parse(body.toString("utf8")) as BusFrame);
      } catch (err) {
        throw new Error(`invalid JSON frame: ${(err as Error).message}`);
      }
    }
    return out;
  }
}

export { HEADER_BYTES, MAX_FRAME_BYTES };
