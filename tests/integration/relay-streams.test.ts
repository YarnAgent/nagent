// Stream routing tests (task #28): two registered conns dial each other via
// the relay, exchange bytes opaquely, and clean up on close / disconnect.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FrameDecoder,
  Verb,
  encodeJsonFrame,
  encodeDataFrame,
  encodeCloseFrame,
} from "../../src/relay/frame.js";
import { paths } from "../../src/platform/paths.js";
import { addGrant } from "../../src/relay/allowlist.js";
import { RelayServer } from "../../src/relay/server.js";
import {
  connectClient,
  doRegister,
  makeIdentity,
  startTestRelay,
  waitFrame,
} from "./relay-helpers.js";

interface Peer {
  sock: Awaited<ReturnType<typeof connectClient>>;
  dec: FrameDecoder;
}

async function joinPeer(srv: RelayServer, name: string): Promise<Peer> {
  const id = makeIdentity();
  await addGrant(name, id.pubB64u);
  const sock = await connectClient(srv);
  const dec = new FrameDecoder();
  await doRegister(sock, dec, name, id);
  return { sock, dec };
}

describe("nagent-relay — stream routing", () => {
  let dir: string;
  let srv: RelayServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-relay-streams-"));
    process.env.NAGENT_HOME = dir;
    await mkdir(paths().relayDir, { recursive: true });
    srv = await startTestRelay();
  });

  afterEach(async () => {
    await srv.stop();
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("forwards OPEN → OPEN_OK → DATA bidirectionally → CLOSE", async () => {
    const a = await joinPeer(srv, "alice");
    const b = await joinPeer(srv, "bob");

    // Alice opens a stream to Bob with srcSid=42.
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 42, dstNodeName: "bob" }));

    // Bob sees an inbound OPEN with a relay-allocated sid and srcNodeName=alice.
    const inbound = await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.OPEN);
    if (inbound.verb !== Verb.OPEN) throw new Error("expected inbound OPEN on bob");
    expect(inbound.payload.srcNodeName).toBe("alice");
    const bobSid = inbound.payload.streamId;
    expect(bobSid).toBeGreaterThan(0);

    // Bob accepts.
    b.sock.write(encodeJsonFrame(Verb.OPEN_OK, { streamId: bobSid }));

    // Alice sees OPEN_OK echoed with her original sid.
    const aliceAck = await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_OK);
    if (aliceAck.verb !== Verb.OPEN_OK) throw new Error("expected OPEN_OK on alice");
    expect(aliceAck.payload.streamId).toBe(42);

    // Alice → Bob bytes.
    const payloadAB = Buffer.from("hello bob", "utf8");
    a.sock.write(encodeDataFrame(42, payloadAB));
    const bobData = await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.DATA);
    if (bobData.verb !== Verb.DATA) throw new Error("expected DATA on bob");
    expect(bobData.payload.streamId).toBe(bobSid);
    expect(bobData.payload.bytes.equals(payloadAB)).toBe(true);

    // Bob → Alice bytes.
    const payloadBA = Buffer.from([0xff, 0x00, 0xc0, 0xff, 0xee]);
    b.sock.write(encodeDataFrame(bobSid, payloadBA));
    const aliceData = await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.DATA);
    if (aliceData.verb !== Verb.DATA) throw new Error("expected DATA on alice");
    expect(aliceData.payload.streamId).toBe(42);
    expect(aliceData.payload.bytes.equals(payloadBA)).toBe(true);

    // Alice closes; Bob sees CLOSE with the bob-side sid.
    a.sock.write(encodeCloseFrame(42, "alice-done"));
    const bobClose = await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.CLOSE);
    if (bobClose.verb !== Verb.CLOSE) throw new Error("expected CLOSE on bob");
    expect(bobClose.payload.streamId).toBe(bobSid);
    expect(bobClose.payload.reason).toBe("alice-done");

    a.sock.destroy();
    b.sock.destroy();
  });

  it("OPEN_REJECT when destination peer is not registered", async () => {
    const a = await joinPeer(srv, "alice");
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 7, dstNodeName: "ghost" }));
    const rej = await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_REJECT);
    if (rej.verb !== Verb.OPEN_REJECT) throw new Error("expected OPEN_REJECT");
    expect(rej.payload.streamId).toBe(7);
    expect(rej.payload.reason).toMatch(/peer-not-registered/);
    a.sock.destroy();
  });

  it("OPEN_REJECT when destination equals source (self-routing)", async () => {
    const a = await joinPeer(srv, "alice");
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 1, dstNodeName: "alice" }));
    const rej = await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_REJECT);
    if (rej.verb !== Verb.OPEN_REJECT) throw new Error("expected OPEN_REJECT");
    expect(rej.payload.reason).toMatch(/self-routing/);
    a.sock.destroy();
  });

  it("OPEN_REJECT on duplicate srcSid (same conn re-uses a live streamId)", async () => {
    const a = await joinPeer(srv, "alice");
    const b = await joinPeer(srv, "bob");
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 100, dstNodeName: "bob" }));
    await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.OPEN); // settle
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 100, dstNodeName: "bob" })); // dup
    const rej = await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_REJECT);
    if (rej.verb !== Verb.OPEN_REJECT) throw new Error("expected OPEN_REJECT");
    expect(rej.payload.reason).toMatch(/duplicate srcSid/);
    a.sock.destroy();
    b.sock.destroy();
  });

  it("disconnecting one peer tears down its streams with CLOSE on the other side", async () => {
    const a = await joinPeer(srv, "alice");
    const b = await joinPeer(srv, "bob");
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 5, dstNodeName: "bob" }));
    const inbound = await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.OPEN);
    if (inbound.verb !== Verb.OPEN) throw new Error("no inbound on bob");
    b.sock.write(encodeJsonFrame(Verb.OPEN_OK, { streamId: inbound.payload.streamId }));
    await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_OK);

    // Alice yanks her conn.
    a.sock.destroy();

    // Bob receives a CLOSE for the inbound stream.
    const close = await waitFrame(b.sock, b.dec, (f) => f.verb === Verb.CLOSE);
    if (close.verb !== Verb.CLOSE) throw new Error("no close on bob");
    expect(close.payload.streamId).toBe(inbound.payload.streamId);
    expect(close.payload.reason).toMatch(/peer-disconnected/);
    b.sock.destroy();
  });

  it("can carry multiple concurrent streams between the same pair", async () => {
    const a = await joinPeer(srv, "alice");
    const b = await joinPeer(srv, "bob");

    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 1, dstNodeName: "bob" }));
    a.sock.write(encodeJsonFrame(Verb.OPEN, { streamId: 2, dstNodeName: "bob" }));

    const bobInbounds: number[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await waitFrame(b.sock, b.dec, (g) => g.verb === Verb.OPEN);
      if (f.verb !== Verb.OPEN) throw new Error("unexpected");
      bobInbounds.push(f.payload.streamId);
      b.sock.write(encodeJsonFrame(Verb.OPEN_OK, { streamId: f.payload.streamId }));
    }
    for (let i = 0; i < 2; i++) await waitFrame(a.sock, a.dec, (f) => f.verb === Verb.OPEN_OK);

    a.sock.write(encodeDataFrame(1, Buffer.from("on-stream-1")));
    a.sock.write(encodeDataFrame(2, Buffer.from("on-stream-2")));

    const seen = new Map<number, string>();
    for (let i = 0; i < 2; i++) {
      const f = await waitFrame(b.sock, b.dec, (g) => g.verb === Verb.DATA);
      if (f.verb !== Verb.DATA) throw new Error("unexpected");
      seen.set(f.payload.streamId, f.payload.bytes.toString("utf8"));
    }
    expect(seen.size).toBe(2);
    expect(new Set(seen.values())).toEqual(new Set(["on-stream-1", "on-stream-2"]));
    expect(new Set(seen.keys())).toEqual(new Set(bobInbounds));

    a.sock.destroy();
    b.sock.destroy();
  });
});
