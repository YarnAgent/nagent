const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export function encodeFrame(frame) {
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    if (body.length > MAX_FRAME_BYTES) {
        throw new Error(`frame too large: ${body.length} > ${MAX_FRAME_BYTES}`);
    }
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}
export class FrameDecoder {
    buffer = Buffer.alloc(0);
    push(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const out = [];
        while (this.buffer.length >= HEADER_BYTES) {
            const len = this.buffer.readUInt32BE(0);
            if (len > MAX_FRAME_BYTES) {
                throw new Error(`frame too large: ${len}`);
            }
            if (this.buffer.length < HEADER_BYTES + len)
                break;
            const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
            this.buffer = this.buffer.subarray(HEADER_BYTES + len);
            try {
                out.push(JSON.parse(body.toString("utf8")));
            }
            catch (err) {
                throw new Error(`invalid JSON frame: ${err.message}`);
            }
        }
        return out;
    }
}
export { HEADER_BYTES, MAX_FRAME_BYTES };
//# sourceMappingURL=frame.js.map