// Shared scaffolding for relay integration tests.
// File deliberately doesn't end in `.test.ts` so vitest won't pick it up.

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { RelayServer, type RelayServerOptions } from "../../src/relay/server.js";
import { FrameDecoder, Verb, encodeJsonFrame } from "../../src/relay/frame.js";
import { parseTypedFrame } from "../../src/relay/protocol.js";

export interface TestIdentity {
  pubB64u: string;
  privKey: KeyObject;
}

export function makeIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { pubB64u: rawPub.toString("base64url"), privKey: privateKey };
}

export async function startTestRelay(overrides: Partial<RelayServerOptions> = {}): Promise<RelayServer> {
  const srv = new RelayServer({
    port: 0,
    bind: "127.0.0.1",
    relayName: "test-relay",
    altNames: ["localhost"],
    pingIntervalMs: 60_000,
    allowlistRefreshMs: 60_000,
    log: () => { /* swallow */ },
    ...overrides,
  });
  await srv.start();
  return srv;
}

export function getRelayPort(srv: RelayServer): number {
  const anySrv = srv as unknown as { server: { address(): { port: number } } };
  return anySrv.server.address().port;
}

export function connectClient(srv: RelayServer): Promise<TLSSocket> {
  const port = getRelayPort(srv);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
    }, () => resolve(sock));
    sock.once("error", reject);
  });
}

/** Read frames from `sock` until `match` returns true; return that frame. */
export function waitFrame(
  sock: TLSSocket,
  dec: FrameDecoder,
  match: (f: NonNullable<ReturnType<typeof parseTypedFrame>>) => boolean,
  timeoutMs = 2000,
): Promise<NonNullable<ReturnType<typeof parseTypedFrame>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`waitFrame timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const ondata = (chunk: Buffer): void => {
      try {
        for (const raw of dec.push(chunk)) {
          const typed = parseTypedFrame(raw);
          if (typed && match(typed)) {
            cleanup();
            resolve(typed);
            return;
          }
        }
      } catch (err) { cleanup(); reject(err); }
    };
    const onerror = (err: Error): void => { cleanup(); reject(err); };
    function cleanup(): void {
      clearTimeout(timer);
      sock.off("data", ondata);
      sock.off("error", onerror);
    }
    sock.on("data", ondata);
    sock.on("error", onerror);
  });
}

/**
 * Run the full handshake (TLS already up): wait for CHALLENGE, sign it,
 * send REGISTER, wait for REGISTER_OK. Returns once registered.
 */
export async function doRegister(
  sock: TLSSocket,
  dec: FrameDecoder,
  nodeName: string,
  id: TestIdentity,
): Promise<void> {
  const chal = await waitFrame(sock, dec, (f) => f.verb === Verb.CHALLENGE);
  if (chal.verb !== Verb.CHALLENGE) throw new Error("expected CHALLENGE");
  const sig = edSign(null, Buffer.from(chal.payload.nonce, "base64url"), id.privKey);
  sock.write(encodeJsonFrame(Verb.REGISTER, {
    nodeName,
    pubKey: id.pubB64u,
    nonce: chal.payload.nonce,
    sig: sig.toString("base64url"),
  }));
  const ok = await waitFrame(sock, dec, (f) => f.verb === Verb.REGISTER_OK || f.verb === Verb.REGISTER_REJECT);
  if (ok.verb !== Verb.REGISTER_OK) {
    throw new Error(`expected REGISTER_OK, got ${Verb[ok.verb] ?? ok.verb}`);
  }
}
