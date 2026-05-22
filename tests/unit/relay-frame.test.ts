import { describe, it, expect } from "vitest";
import {
  Verb,
  encodeFrame,
  encodeJsonFrame,
  encodeDataFrame,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  decodeDataPayload,
  decodeClosePayload,
  decodeTimestampPayload,
  FrameDecoder,
  MAX_FRAME_BODY,
  verbName,
} from "../../src/relay/frame.js";
import {
  parseRegisterPayload,
  parseRegisterOkPayload,
  parseRegisterRejectPayload,
  parseOpenPayload,
  parseStatusOkPayload,
  parseTypedFrame,
  PROTOCOL_VERSION,
} from "../../src/relay/protocol.js";

describe("relay frame codec — encode/decode round-trips", () => {
  it("encodes and decodes a JSON frame end-to-end", () => {
    const buf = encodeJsonFrame(Verb.REGISTER_OK, { relayName: "test-relay", version: PROTOCOL_VERSION });
    const dec = new FrameDecoder();
    const frames = dec.push(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.verb).toBe(Verb.REGISTER_OK);
    const payload = parseRegisterOkPayload(frames[0]!.payload);
    expect(payload).toEqual({ relayName: "test-relay", version: PROTOCOL_VERSION });
  });

  it("DATA frame round-trips with the stream id and exact bytes", () => {
    const bytes = Buffer.from([0xff, 0x00, 0x42, 0x7f, 0x80]);
    const buf = encodeDataFrame(0xdead_beef, bytes);
    const dec = new FrameDecoder();
    const [f] = dec.push(buf);
    expect(f!.verb).toBe(Verb.DATA);
    const decoded = decodeDataPayload(f!.payload);
    expect(decoded.streamId).toBe(0xdead_beef);
    expect(decoded.bytes.equals(bytes)).toBe(true);
  });

  it("CLOSE frame round-trips with optional reason", () => {
    const buf1 = encodeCloseFrame(7);
    const buf2 = encodeCloseFrame(7, "peer-disconnected");
    const dec = new FrameDecoder();
    const [a, b] = dec.push(Buffer.concat([buf1, buf2]));
    expect(decodeClosePayload(a!.payload)).toEqual({ streamId: 7 });
    expect(decodeClosePayload(b!.payload)).toEqual({ streamId: 7, reason: "peer-disconnected" });
  });

  it("PING/PONG round-trip with bigint microsecond timestamps", () => {
    const ts = BigInt("1779440000123456");
    const buf = Buffer.concat([encodePingFrame(ts), encodePongFrame(ts)]);
    const dec = new FrameDecoder();
    const [ping, pong] = dec.push(buf);
    expect(ping!.verb).toBe(Verb.PING);
    expect(pong!.verb).toBe(Verb.PONG);
    expect(decodeTimestampPayload(ping!.payload)).toBe(ts);
    expect(decodeTimestampPayload(pong!.payload)).toBe(ts);
  });

  it("decoder reassembles frames across chunk boundaries", () => {
    const a = encodeJsonFrame(Verb.REGISTER, {
      nodeName: "alice",
      pubKey: "ZZZ",
      nonce: "n0",
      sig: "s0",
    });
    const b = encodeDataFrame(42, Buffer.from("hello world", "utf8"));
    const combined = Buffer.concat([a, b]);
    const dec = new FrameDecoder();
    // split mid-frame: first 3 bytes (less than the length prefix)
    const out: { verb: number; len: number }[] = [];
    for (const chunk of [
      combined.subarray(0, 3),
      combined.subarray(3, 8),
      combined.subarray(8, a.length + 2),
      combined.subarray(a.length + 2),
    ]) {
      for (const f of dec.push(Buffer.from(chunk))) out.push({ verb: f.verb, len: f.payload.length });
    }
    expect(out).toHaveLength(2);
    expect(out[0]!.verb).toBe(Verb.REGISTER);
    expect(out[1]!.verb).toBe(Verb.DATA);
    expect(dec.pending).toBe(0);
  });

  it("decoder rejects oversized frames with a clear error", () => {
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(MAX_FRAME_BODY + 1, 0);
    const dec = new FrameDecoder();
    expect(() => dec.push(bogus)).toThrow(/frame too large/);
  });

  it("decoder rejects zero-length body (verb byte is mandatory)", () => {
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(0, 0);
    const dec = new FrameDecoder();
    expect(() => dec.push(bogus)).toThrow(/body length must be >= 1/);
  });

  it("encodeFrame refuses payloads larger than MAX_FRAME_BODY", () => {
    const huge = Buffer.alloc(MAX_FRAME_BODY); // body would be huge.length + 1 > MAX
    expect(() => encodeFrame(Verb.DATA, huge)).toThrow(/frame too large/);
  });

  it("encodeDataFrame validates streamId range", () => {
    expect(() => encodeDataFrame(-1, Buffer.alloc(0))).toThrow(/invalid streamId/);
    expect(() => encodeDataFrame(0xffff_ffff + 1, Buffer.alloc(0))).toThrow(/invalid streamId/);
    expect(() => encodeDataFrame(1.5, Buffer.alloc(0))).toThrow(/invalid streamId/);
  });

  it("verbName labels known and unknown verbs", () => {
    expect(verbName(Verb.REGISTER)).toBe("REGISTER");
    expect(verbName(Verb.STATUS_OK)).toBe("STATUS_OK");
    expect(verbName(0x77)).toMatch(/UNKNOWN\(0x77\)/);
  });
});

describe("relay protocol parsers — payload validation", () => {
  it("parseRegisterPayload accepts a well-formed REGISTER", () => {
    const buf = Buffer.from(JSON.stringify({
      nodeName: "alice", pubKey: "k", nonce: "n", sig: "s", netId: "net1",
    }), "utf8");
    expect(parseRegisterPayload(buf)).toEqual({
      nodeName: "alice", pubKey: "k", nonce: "n", sig: "s", netId: "net1",
    });
  });

  it("parseRegisterPayload rejects missing or empty fields", () => {
    expect(() => parseRegisterPayload(Buffer.from(JSON.stringify({
      nodeName: "", pubKey: "k", nonce: "n", sig: "s",
    }), "utf8"))).toThrow(/nodeName/);
    expect(() => parseRegisterPayload(Buffer.from(JSON.stringify({
      nodeName: "a", pubKey: "k", nonce: "n",
    }), "utf8"))).toThrow(/sig/);
  });

  it("parseRegisterPayload rejects non-object JSON", () => {
    expect(() => parseRegisterPayload(Buffer.from("[]", "utf8"))).toThrow(/JSON object/);
    expect(() => parseRegisterPayload(Buffer.from("null", "utf8"))).toThrow(/JSON object/);
  });

  it("parseRegisterRejectPayload demands a reason", () => {
    expect(() => parseRegisterRejectPayload(Buffer.from("{}", "utf8"))).toThrow(/reason/);
    expect(parseRegisterRejectPayload(Buffer.from('{"reason":"unauthorized"}', "utf8")))
      .toEqual({ reason: "unauthorized" });
  });

  it("parseOpenPayload validates streamId range", () => {
    expect(() => parseOpenPayload(Buffer.from('{"streamId":-1}', "utf8"))).toThrow(/streamId/);
    expect(() => parseOpenPayload(Buffer.from('{"streamId":3.14}', "utf8"))).toThrow(/streamId/);
    expect(parseOpenPayload(Buffer.from('{"streamId":42,"dstNodeName":"bob"}', "utf8")))
      .toEqual({ streamId: 42, dstNodeName: "bob" });
  });

  it("parseStatusOkPayload accepts both null and number rttMs", () => {
    const buf = Buffer.from(JSON.stringify({
      relayName: "edge",
      peers: [
        { node: "alice", rttMs: 25.3, lastSeen: "2026-05-22T00:00:00Z" },
        { node: "bob", rttMs: null, lastSeen: "2026-05-22T00:00:00Z" },
      ],
    }), "utf8");
    const out = parseStatusOkPayload(buf);
    expect(out.relayName).toBe("edge");
    expect(out.peers).toHaveLength(2);
    expect(out.peers[0]!.rttMs).toBe(25.3);
    expect(out.peers[1]!.rttMs).toBeNull();
  });

  it("parseTypedFrame dispatches and returns null for unknown verbs", () => {
    const f1 = { verb: Verb.PING, payload: Buffer.alloc(8) };
    f1.payload.writeBigUInt64BE(BigInt(123), 0);
    const t = parseTypedFrame(f1);
    expect(t?.verb).toBe(Verb.PING);
    if (t && t.verb === Verb.PING) expect(t.payload.tsMicros).toBe(BigInt(123));

    const f2 = { verb: 0x77 as Verb, payload: Buffer.alloc(0) };
    expect(parseTypedFrame(f2)).toBeNull();
  });
});
