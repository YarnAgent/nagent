import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../../src/bus/frame.js";
import type { BusFrame } from "../../src/types/index.js";

describe("frame codec", () => {
  it("encodes then decodes a single frame", () => {
    const frame: BusFrame = { verb: "OK", echo: { hello: "world" } };
    const buf = encodeFrame(frame);
    const dec = new FrameDecoder();
    const out = dec.push(buf);
    expect(out).toEqual([frame]);
  });

  it("decodes a stream split across chunks", () => {
    const f1: BusFrame = { verb: "SEND", to: "n/a", payload: { x: 1 }, msgId: "m1", hops: 0 };
    const f2: BusFrame = { verb: "ACK", msgId: "m1" };
    const buf = Buffer.concat([encodeFrame(f1), encodeFrame(f2)]);
    const dec = new FrameDecoder();
    // Split bytes mid-frame to prove length-prefixed reassembly works.
    const mid = Math.floor(buf.length / 2);
    const left = dec.push(buf.subarray(0, mid));
    const right = dec.push(buf.subarray(mid));
    expect([...left, ...right]).toEqual([f1, f2]);
  });

  it("yields nothing when only a partial header has arrived", () => {
    const f: BusFrame = { verb: "OK" };
    const buf = encodeFrame(f);
    const dec = new FrameDecoder();
    expect(dec.push(buf.subarray(0, 2))).toEqual([]);
    expect(dec.push(buf.subarray(2))).toEqual([f]);
  });
});
