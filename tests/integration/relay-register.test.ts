// Integration test for the v0.5 relay daemon (register-only phase).
//
// Spins up a real TLS server on an ephemeral port, opens a TLS client that
// pins the server's cert, completes the CHALLENGE/REGISTER handshake with a
// freshly-generated ed25519 identity, exchanges STATUS, and verifies clean
// teardown.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import { RelayServer } from "../../src/relay/server.js";
import {
  FrameDecoder,
  Verb,
  encodeJsonFrame,
} from "../../src/relay/frame.js";
import {
  parseTypedFrame,
  PROTOCOL_VERSION,
} from "../../src/relay/protocol.js";
import { paths } from "../../src/platform/paths.js";
import { addGrant } from "../../src/relay/allowlist.js";

interface TestIdentity {
  pubB64u: string;
  privKey: KeyObject;
}

function makeIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { pubB64u: rawPub.toString("base64url"), privKey: privateKey };
}

async function startServer(relayName = "test-relay"): Promise<RelayServer> {
  const srv = new RelayServer({
    port: 0,
    bind: "127.0.0.1",
    relayName,
    altNames: ["localhost"],
    pingIntervalMs: 60_000, // disable noisy PINGs during the test
    allowlistRefreshMs: 60_000,
    log: () => { /* swallow */ },
  });
  await srv.start();
  return srv;
}

function getPort(srv: RelayServer): number {
  const anySrv = srv as unknown as { server: { address(): { port: number } } };
  return anySrv.server.address().port;
}

function connectClient(srv: RelayServer): Promise<TLSSocket> {
  const port = getPort(srv);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false, // pinning is out-of-band for the test
    }, () => resolve(sock));
    sock.once("error", reject);
  });
}

function nextFrame(sock: TLSSocket, decoder: FrameDecoder): Promise<ReturnType<typeof parseTypedFrame>> {
  return new Promise((resolve, reject) => {
    const ondata = (chunk: Buffer): void => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length === 0) return;
        sock.off("data", ondata);
        sock.off("error", onerror);
        resolve(parseTypedFrame(frames[0]!));
      } catch (err) { sock.off("data", ondata); sock.off("error", onerror); reject(err); }
    };
    const onerror = (err: Error): void => { sock.off("data", ondata); reject(err); };
    sock.on("data", ondata);
    sock.on("error", onerror);
  });
}

describe("nagent-relay — REGISTER handshake (integration)", () => {
  let dir: string;
  let srv: RelayServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-relay-srv-"));
    process.env.NAGENT_HOME = dir;
    await mkdir(paths().relayDir, { recursive: true });
    srv = await startServer();
  });

  afterEach(async () => {
    await srv.stop();
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("issues CHALLENGE on connect and accepts a valid REGISTER", async () => {
    const id = makeIdentity();
    await addGrant("alice", id.pubB64u);

    const sock = await connectClient(srv);
    const dec = new FrameDecoder();

    const challenge = await nextFrame(sock, dec);
    expect(challenge?.verb).toBe(Verb.CHALLENGE);
    if (challenge?.verb !== Verb.CHALLENGE) throw new Error("no challenge");

    const nonceBytes = Buffer.from(challenge.payload.nonce, "base64url");
    expect(nonceBytes.length).toBe(32);
    const sig = edSign(null, nonceBytes, id.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "alice",
      pubKey: id.pubB64u,
      nonce: challenge.payload.nonce,
      sig: sig.toString("base64url"),
    }));

    const ok = await nextFrame(sock, dec);
    expect(ok?.verb).toBe(Verb.REGISTER_OK);
    if (ok?.verb !== Verb.REGISTER_OK) throw new Error("no ok");
    expect(ok.payload.relayName).toBe("test-relay");
    expect(ok.payload.version).toBe(PROTOCOL_VERSION);

    expect(srv.registeredPeers().map((p) => p.node)).toEqual(["alice"]);

    sock.destroy();
  });

  it("rejects REGISTER with a bad signature", async () => {
    const id = makeIdentity();
    await addGrant("alice", id.pubB64u);
    const sock = await connectClient(srv);
    const dec = new FrameDecoder();
    const challenge = await nextFrame(sock, dec);
    if (challenge?.verb !== Verb.CHALLENGE) throw new Error("no challenge");

    // Sign garbage instead of the nonce.
    const sig = edSign(null, Buffer.from("not the nonce"), id.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "alice",
      pubKey: id.pubB64u,
      nonce: challenge.payload.nonce,
      sig: sig.toString("base64url"),
    }));

    const rej = await nextFrame(sock, dec);
    expect(rej?.verb).toBe(Verb.REGISTER_REJECT);
    if (rej?.verb !== Verb.REGISTER_REJECT) throw new Error("no reject");
    expect(rej.payload.reason).toMatch(/bad signature/);

    sock.destroy();
  });

  it("rejects REGISTER from a node not in the allowlist", async () => {
    const id = makeIdentity();
    // intentionally do NOT addGrant

    const sock = await connectClient(srv);
    const dec = new FrameDecoder();
    const challenge = await nextFrame(sock, dec);
    if (challenge?.verb !== Verb.CHALLENGE) throw new Error("no challenge");
    const nonceBytes = Buffer.from(challenge.payload.nonce, "base64url");
    const sig = edSign(null, nonceBytes, id.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "intruder",
      pubKey: id.pubB64u,
      nonce: challenge.payload.nonce,
      sig: sig.toString("base64url"),
    }));

    const rej = await nextFrame(sock, dec);
    expect(rej?.verb).toBe(Verb.REGISTER_REJECT);
    if (rej?.verb !== Verb.REGISTER_REJECT) throw new Error("no reject");
    expect(rej.payload.reason).toMatch(/unauthorized/);
    sock.destroy();
  });

  it("rejects REGISTER with a forged nonce echo", async () => {
    const id = makeIdentity();
    await addGrant("alice", id.pubB64u);
    const sock = await connectClient(srv);
    const dec = new FrameDecoder();
    await nextFrame(sock, dec); // consume challenge

    const forgedNonce = Buffer.alloc(32, 7); // all 7s
    const sig = edSign(null, forgedNonce, id.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "alice",
      pubKey: id.pubB64u,
      nonce: forgedNonce.toString("base64url"),
      sig: sig.toString("base64url"),
    }));

    const rej = await nextFrame(sock, dec);
    expect(rej?.verb).toBe(Verb.REGISTER_REJECT);
    if (rej?.verb !== Verb.REGISTER_REJECT) throw new Error("no reject");
    expect(rej.payload.reason).toMatch(/nonce mismatch/);
    sock.destroy();
  });

  it("STATUS_REQ returns currently-registered peers", async () => {
    const a = makeIdentity();
    const b = makeIdentity();
    await addGrant("alice", a.pubB64u);
    await addGrant("bob", b.pubB64u);

    // Register both.
    for (const [name, id] of [["alice", a], ["bob", b]] as const) {
      const sock = await connectClient(srv);
      const dec = new FrameDecoder();
      const chal = await nextFrame(sock, dec);
      if (chal?.verb !== Verb.CHALLENGE) throw new Error("no challenge");
      const sig = edSign(null, Buffer.from(chal.payload.nonce, "base64url"), id.privKey);
      sock.write(encodeJsonFrame(Verb.REGISTER, {
        nodeName: name, pubKey: id.pubB64u, nonce: chal.payload.nonce, sig: sig.toString("base64url"),
      }));
      const ok = await nextFrame(sock, dec);
      expect(ok?.verb).toBe(Verb.REGISTER_OK);
      // leave sockets open for the STATUS check below — give the registry
      // a tick to settle.
    }

    // Open a third conn and ask for STATUS.
    const probe = makeIdentity();
    await addGrant("probe", probe.pubB64u);
    const sock = await connectClient(srv);
    const dec = new FrameDecoder();
    const chal = await nextFrame(sock, dec);
    if (chal?.verb !== Verb.CHALLENGE) throw new Error("no challenge");
    const sig = edSign(null, Buffer.from(chal.payload.nonce, "base64url"), probe.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "probe", pubKey: probe.pubB64u, nonce: chal.payload.nonce, sig: sig.toString("base64url"),
    }));
    await nextFrame(sock, dec); // REGISTER_OK
    sock.write(encodeJsonFrame(Verb.STATUS_REQ, {}));
    const status = await nextFrame(sock, dec);
    expect(status?.verb).toBe(Verb.STATUS_OK);
    if (status?.verb !== Verb.STATUS_OK) throw new Error("no status");
    expect(status.payload.relayName).toBe("test-relay");
    expect(status.payload.peers.map((p) => p.node).sort()).toEqual(["alice", "bob", "probe"]);
    sock.destroy();
  });

  it("net-scoped peers.json is accepted as an allowlist source", async () => {
    const id = makeIdentity();
    await mkdir(paths().netDir("net-test"), { recursive: true });
    await writeFile(paths().netPeers("net-test"), JSON.stringify([
      { nodeName: "alice", pubKey: id.pubB64u, addresses: [], roles: [] },
    ]));
    // Restart the server so it re-reads the (now-populated) allowlist on
    // startup. (Or: rely on refresh-on-miss inside handleRegister.)
    const sock = await connectClient(srv);
    const dec = new FrameDecoder();
    const chal = await nextFrame(sock, dec);
    if (chal?.verb !== Verb.CHALLENGE) throw new Error("no challenge");
    const sig = edSign(null, Buffer.from(chal.payload.nonce, "base64url"), id.privKey);
    sock.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: "alice", pubKey: id.pubB64u, nonce: chal.payload.nonce, sig: sig.toString("base64url"),
    }));
    const ok = await nextFrame(sock, dec);
    expect(ok?.verb).toBe(Verb.REGISTER_OK);
    sock.destroy();
  });
});
