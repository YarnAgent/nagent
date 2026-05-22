// Full end-to-end: a "remote" RelayClient bridges inbound streams to a local
// TCP echo server (stand-in for sshd). A "local" RelayClient runs the IPC
// server. relayDial() bridges its stdin/stdout to the IPC; bytes should
// echo from stdin → IPC → client → relay → other client → echo server →
// back the same chain → stdout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, type Server as TcpServer, type Socket as NetSocket } from "node:net";
import { PassThrough } from "node:stream";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { paths } from "../../src/platform/paths.js";
import { addGrant } from "../../src/relay/allowlist.js";
import { startTestRelay } from "./relay-helpers.js";
import { RelayClient, type PinnedRelay, type RelayClientIdentity } from "../../src/relay/client.js";
import { relayDial } from "../../src/relay/dial.js";

function makeIdentityForClient(nodeName: string): { id: RelayClientIdentity; pubB64u: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const pub = rawPub.toString("base64url");
  return {
    id: { nodeName, pubKey: pub, privateKey: privateKey as KeyObject },
    pubB64u: pub,
  };
}

function startEchoServer(): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createTcpServer((sock: NetSocket) => {
      sock.on("data", (b) => sock.write(b));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

function waitForRegistered(client: RelayClient, relayName: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      // RelayClient doesn't expose state directly; rttFor() returns null until
      // PINGed. Instead we exploit fetchStatus which only resolves once
      // registered.
      client.fetchStatus(relayName, 500).then(() => resolve()).catch((err) => {
        if (Date.now() - start > timeoutMs) reject(err);
        else setTimeout(tick, 50);
      });
    };
    setTimeout(tick, 30);
  });
}

describe("nagent-relay — end-to-end dial via two clients", () => {
  let dir: string;
  let echo: { server: TcpServer; port: number };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-relay-e2e-"));
    process.env.NAGENT_HOME = dir;
    await mkdir(paths().relayDir, { recursive: true });
    echo = await startEchoServer();
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await new Promise<void>((resolve) => echo.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("dialer bytes round-trip through the relay to the echo target and back", async () => {
    // 1. Spin up the relay.
    const srv = await startTestRelay();
    const fingerprint = await new Promise<string>((resolve) => {
      // RelayServer.start() already returned the fingerprint via its result —
      // but startTestRelay swallows it. Read from the cert on disk via a fresh
      // helper would be cleaner; for the test we re-extract.
      import("node:fs/promises").then(async (fs) => {
        const pem = await fs.readFile(paths().relayCert, "utf8");
        const { certFingerprintSha256 } = await import("../../src/relay/cert.js");
        resolve(certFingerprintSha256(pem));
      });
    });
    const port = (srv as unknown as { server: { address(): { port: number } } }).server.address().port;
    const pinned: PinnedRelay = {
      name: "test-relay",
      url: `https://127.0.0.1:${port}`,
      fingerprint,
    };

    // 2. Allowlist both ends.
    const a = makeIdentityForClient("alice");
    const b = makeIdentityForClient("bob");
    await addGrant("alice", a.pubB64u);
    await addGrant("bob", b.pubB64u);

    // 3. Spin up two RelayClients. The "remote" one (bob) points inbound to the echo server.
    const ipcAlice = join(dir, "ipc-alice.sock");
    const ipcBob = join(dir, "ipc-bob.sock");
    const cAlice = new RelayClient({
      identity: a.id,
      ipcSockPath: ipcAlice,
      log: () => { /* swallow */ },
    });
    const cBob = new RelayClient({
      identity: b.id,
      ipcSockPath: ipcBob,
      inboundTarget: { host: "127.0.0.1", port: echo.port },
      log: () => { /* swallow */ },
    });
    await cAlice.start([pinned]);
    await cBob.start([pinned]);

    // 4. Wait for both to register.
    await Promise.all([
      waitForRegistered(cAlice, "test-relay"),
      waitForRegistered(cBob, "test-relay"),
    ]);

    // 5. Run the dialer with PassThrough streams in place of stdio.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const captured: Buffer[] = [];
    stdout.on("data", (b) => captured.push(b as Buffer));

    const dialPromise = relayDial({
      ipcSockPath: ipcAlice,
      relayName: "test-relay",
      peerNodeName: "bob",
      stdin, stdout, stderr,
      openTimeoutMs: 3_000,
    });

    // Send a payload that the echo target on Bob's end will reflect.
    await new Promise((r) => setTimeout(r, 100)); // let dial header settle
    stdin.write(Buffer.from("hello relay\n", "utf8"));

    // Wait for the echo to round-trip back.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("echo timeout")), 2_000);
      stdout.on("data", () => {
        const text = Buffer.concat(captured).toString("utf8");
        if (text.includes("hello relay")) { clearTimeout(t); resolve(); }
      });
    });

    // Close stdin → dialer ends → relay-client sends CLOSE → echo conn closes.
    stdin.end();
    const code = await dialPromise;
    expect(code).toBe(0);

    await cAlice.stop();
    await cBob.stop();
    await srv.stop();
  });

  it("dialer reports OPEN_REJECT cleanly when the peer is not registered", async () => {
    const srv = await startTestRelay();
    const pem = await (await import("node:fs/promises")).readFile(paths().relayCert, "utf8");
    const { certFingerprintSha256 } = await import("../../src/relay/cert.js");
    const fingerprint = certFingerprintSha256(pem);
    const port = (srv as unknown as { server: { address(): { port: number } } }).server.address().port;
    const pinned: PinnedRelay = { name: "test-relay", url: `https://127.0.0.1:${port}`, fingerprint };

    const a = makeIdentityForClient("alice");
    await addGrant("alice", a.pubB64u);

    const ipcSockPath = join(dir, "ipc.sock");
    const c = new RelayClient({ identity: a.id, ipcSockPath, log: () => {} });
    await c.start([pinned]);
    await waitForRegistered(c, "test-relay");

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const errCaptured: Buffer[] = [];
    stderr.on("data", (b) => errCaptured.push(b as Buffer));

    const code = await relayDial({
      ipcSockPath,
      relayName: "test-relay",
      peerNodeName: "nonexistent",
      stdin, stdout, stderr,
      openTimeoutMs: 2_000,
    });
    expect(code).not.toBe(0);
    expect(Buffer.concat(errCaptured).toString("utf8")).toMatch(/peer-not-registered/);

    await c.stop();
    await srv.stop();
  });
});
