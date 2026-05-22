// nagent-relay daemon — register-only first cut (task #27).
// Stream routing (OPEN/DATA/CLOSE) lands in task #28.
//
// Lifecycle per connection:
//   1. TLS accept; allocate a 32-byte nonce; send CHALLENGE.
//   2. Wait for REGISTER. Verify nonce echo, allowlist lookup, ed25519 sig.
//   3. On success → REGISTER_OK; mark conn as registered; start PING keepalive.
//      On failure → REGISTER_REJECT then close.
//   4. Service STATUS_REQ → STATUS_OK with all registered peers + their RTTs.
//   5. PONG measures RTT for the issuing PING; updated as EWMA-like simple
//      "latest sample" for now (smoothing comes when probe layer needs it).

import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { randomBytes, verify as edVerify } from "node:crypto";
import { publicKeyFromRaw } from "../ssh/identity.js";
import {
  FrameDecoder,
  Verb,
  encodeJsonFrame,
  encodeFrame,
  encodePingFrame,
  decodeTimestampPayload,
} from "./frame.js";
import { parseTypedFrame, PROTOCOL_VERSION, type StatusOkPayload } from "./protocol.js";
import { loadOrGenerateRelayCert } from "./cert.js";
import { loadAllowlist, findAllowed, type AllowedPeer } from "./allowlist.js";

export interface RelayServerOptions {
  port: number;
  bind: string;
  relayName: string;
  /** Hostnames / IPs to embed in the cert SAN. */
  altNames?: string[];
  /** PING interval, ms. Default 30 000. */
  pingIntervalMs?: number;
  /** Allowlist refresh interval, ms. Default 60 000. */
  allowlistRefreshMs?: number;
  log?: (line: string) => void;
}

interface ConnState {
  id: number;
  socket: TLSSocket;
  decoder: FrameDecoder;
  nonce: Buffer;
  registered: { nodeName: string; pubKey: string; netId?: string } | null;
  /** Set when this conn has a node name we can route to. Keyed by nodeName. */
  rttMs: number | null;
  /** ts_micros of the most recent outbound PING we're waiting on. */
  pingInflight: bigint | null;
  lastSeen: Date;
  pingTimer: NodeJS.Timeout | null;
}

const NONCE_BYTES = 32;

export class RelayServer {
  private readonly opts: Required<RelayServerOptions>;
  private server: TlsServer | null = null;
  private conns = new Map<number, ConnState>();
  private byNode = new Map<string, ConnState>();
  private nextConnId = 1;
  private allowlist: AllowedPeer[] = [];
  private allowlistTimer: NodeJS.Timeout | null = null;
  private fingerprint = "";
  private notAfter = "";

  constructor(opts: RelayServerOptions) {
    this.opts = {
      port: opts.port,
      bind: opts.bind,
      relayName: opts.relayName,
      altNames: opts.altNames ?? [],
      pingIntervalMs: opts.pingIntervalMs ?? 30_000,
      allowlistRefreshMs: opts.allowlistRefreshMs ?? 60_000,
      log: opts.log ?? ((line) => process.stderr.write(line + "\n")),
    };
  }

  async start(): Promise<{ port: number; fingerprint: string; notAfter: string }> {
    const c = await loadOrGenerateRelayCert(this.opts.altNames);
    this.fingerprint = c.fingerprint;
    this.notAfter = c.notAfter;

    this.allowlist = await loadAllowlist();
    this.allowlistTimer = setInterval(() => {
      loadAllowlist().then((a) => { this.allowlist = a; }).catch(() => { /* keep prior */ });
    }, this.opts.allowlistRefreshMs);
    this.allowlistTimer.unref();

    this.server = createTlsServer({
      cert: c.cert,
      key: c.key,
      minVersion: "TLSv1.3",
      requestCert: false,
    }, (socket) => this.onConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.bind, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
    this.opts.log(`nagent-relay: listening on ${this.opts.bind}:${port} (relayName=${this.opts.relayName})`);
    this.opts.log(`nagent-relay: fingerprint=${this.fingerprint}`);
    return { port, fingerprint: this.fingerprint, notAfter: this.notAfter };
  }

  async stop(): Promise<void> {
    if (this.allowlistTimer) { clearInterval(this.allowlistTimer); this.allowlistTimer = null; }
    for (const c of this.conns.values()) this.closeConn(c, "shutdown");
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  /** Snapshot of currently-registered peers (used by STATUS_OK builders + CLI). */
  registeredPeers(): Array<{ node: string; rttMs: number | null; lastSeen: string }> {
    const out: Array<{ node: string; rttMs: number | null; lastSeen: string }> = [];
    for (const c of this.byNode.values()) {
      if (!c.registered) continue;
      out.push({
        node: c.registered.nodeName,
        rttMs: c.rttMs,
        lastSeen: c.lastSeen.toISOString(),
      });
    }
    return out.sort((a, b) => a.node.localeCompare(b.node));
  }

  private onConnection(socket: TLSSocket): void {
    const id = this.nextConnId++;
    const nonce = randomBytes(NONCE_BYTES);
    const state: ConnState = {
      id,
      socket,
      decoder: new FrameDecoder(),
      nonce,
      registered: null,
      rttMs: null,
      pingInflight: null,
      lastSeen: new Date(),
      pingTimer: null,
    };
    this.conns.set(id, state);

    socket.on("data", (chunk) => this.onChunk(state, chunk));
    socket.on("close", () => this.onClose(state));
    socket.on("error", (err) => this.opts.log(`relay: conn ${id} socket error: ${err.message}`));

    // Send CHALLENGE immediately so the client knows what to sign.
    this.send(state, Verb.CHALLENGE, Buffer.from(JSON.stringify({ nonce: nonce.toString("base64url") }), "utf8"));
  }

  private onChunk(state: ConnState, chunk: Buffer): void {
    state.lastSeen = new Date();
    let frames;
    try {
      frames = state.decoder.push(chunk);
    } catch (err) {
      this.opts.log(`relay: conn ${state.id} decode error: ${(err as Error).message}`);
      this.closeConn(state, "protocol-error");
      return;
    }
    for (const raw of frames) {
      let typed;
      try {
        typed = parseTypedFrame(raw);
      } catch (err) {
        this.opts.log(`relay: conn ${state.id} parse error: ${(err as Error).message}`);
        this.closeConn(state, "protocol-error");
        return;
      }
      if (!typed) continue; // forward-compat: unknown verb, ignore
      this.dispatch(state, typed).catch((err) =>
        this.opts.log(`relay: conn ${state.id} dispatch error: ${(err as Error).message}`),
      );
    }
  }

  private async dispatch(state: ConnState, frame: ReturnType<typeof parseTypedFrame> & object): Promise<void> {
    switch (frame.verb) {
      case Verb.REGISTER:
        await this.handleRegister(state, frame.payload);
        return;
      case Verb.PING: {
        // Echo the timestamp back as a PONG so the client can measure RTT.
        const echo = Buffer.alloc(8);
        echo.writeBigUInt64BE(frame.payload.tsMicros, 0);
        this.send(state, Verb.PONG, echo);
        return;
      }
      case Verb.PONG: {
        // Our own PING came back. Compute RTT.
        if (state.pingInflight !== null && state.pingInflight === frame.payload.tsMicros) {
          const now = nowMicros();
          const rttUs = Number(now - state.pingInflight);
          state.rttMs = rttUs / 1000;
          state.pingInflight = null;
        }
        return;
      }
      case Verb.STATUS_REQ:
        await this.handleStatusReq(state);
        return;
      case Verb.OPEN:
      case Verb.DATA:
      case Verb.CLOSE:
        // Stream routing comes in task #28; until then, gently no-op.
        if (state.registered) {
          this.opts.log(`relay: conn ${state.id} sent ${frame.verb} but stream routing isn't wired yet`);
        }
        return;
      default:
        // Unexpected for a server: REGISTER_OK / REGISTER_REJECT / STATUS_OK / CHALLENGE / OPEN_OK / OPEN_REJECT.
        // These are R→C verbs; clients shouldn't be sending them. Ignore for forward-compat.
        return;
    }
  }

  private async handleRegister(
    state: ConnState,
    p: { nodeName: string; pubKey: string; nonce: string; sig: string; netId?: string },
  ): Promise<void> {
    if (state.registered) {
      this.rejectRegister(state, "already registered");
      return;
    }

    // Nonce must match what we sent.
    const echoed = Buffer.from(p.nonce, "base64url");
    if (echoed.length !== NONCE_BYTES || !timingSafeBufferEqual(echoed, state.nonce)) {
      this.rejectRegister(state, "nonce mismatch");
      return;
    }

    // Allowlist lookup (refresh-on-miss in case mesh gossip just landed).
    let allowed = findAllowed(this.allowlist, p.nodeName, p.pubKey);
    if (!allowed) {
      this.allowlist = await loadAllowlist();
      allowed = findAllowed(this.allowlist, p.nodeName, p.pubKey);
    }
    if (!allowed) {
      this.rejectRegister(state, "unauthorized");
      return;
    }
    if (p.netId && allowed.netId && allowed.netId !== p.netId) {
      this.rejectRegister(state, "netId mismatch");
      return;
    }

    // ed25519 signature over the raw nonce bytes.
    const pubRaw = Buffer.from(p.pubKey, "base64url");
    if (pubRaw.length !== 32) { this.rejectRegister(state, "malformed pubKey"); return; }
    const sigBytes = Buffer.from(p.sig, "base64url");
    if (sigBytes.length !== 64) { this.rejectRegister(state, "malformed sig"); return; }
    const pubKey = publicKeyFromRaw(pubRaw);
    if (!edVerify(null, state.nonce, pubKey, sigBytes)) {
      this.rejectRegister(state, "bad signature");
      return;
    }

    // Evict any prior conn for the same nodeName (last-write-wins).
    const prior = this.byNode.get(p.nodeName);
    if (prior && prior !== state) this.closeConn(prior, "replaced");

    state.registered = { nodeName: p.nodeName, pubKey: p.pubKey, ...(p.netId ? { netId: p.netId } : {}) };
    this.byNode.set(p.nodeName, state);
    this.send(state, Verb.REGISTER_OK, Buffer.from(JSON.stringify({
      relayName: this.opts.relayName,
      version: PROTOCOL_VERSION,
    }), "utf8"));
    this.opts.log(`relay: conn ${state.id} REGISTERed as ${p.nodeName}`);

    this.startPingTimer(state);
  }

  private rejectRegister(state: ConnState, reason: string): void {
    this.opts.log(`relay: conn ${state.id} REGISTER rejected: ${reason}`);
    this.send(state, Verb.REGISTER_REJECT, Buffer.from(JSON.stringify({ reason }), "utf8"));
    this.closeConn(state, reason);
  }

  private async handleStatusReq(state: ConnState): Promise<void> {
    if (!state.registered) { this.opts.log(`relay: conn ${state.id} STATUS_REQ before REGISTER`); return; }
    const payload: StatusOkPayload = {
      relayName: this.opts.relayName,
      peers: this.registeredPeers(),
    };
    this.send(state, Verb.STATUS_OK, Buffer.from(JSON.stringify(payload), "utf8"));
  }

  private startPingTimer(state: ConnState): void {
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      const ts = nowMicros();
      state.pingInflight = ts;
      try { state.socket.write(encodePingFrame(ts)); } catch { /* will be cleaned by close handler */ }
    }, this.opts.pingIntervalMs);
    state.pingTimer.unref();
  }

  private send(state: ConnState, verb: Verb, payload: Buffer): void {
    try {
      state.socket.write(encodeFrame(verb, payload));
    } catch (err) {
      this.opts.log(`relay: conn ${state.id} write failed: ${(err as Error).message}`);
    }
  }

  private closeConn(state: ConnState, reason: string): void {
    if (!this.conns.has(state.id)) return;
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
    if (state.registered && this.byNode.get(state.registered.nodeName) === state) {
      this.byNode.delete(state.registered.nodeName);
    }
    this.conns.delete(state.id);
    try { state.socket.destroy(); } catch { /* ignore */ }
    void reason;
  }

  private onClose(state: ConnState): void {
    this.closeConn(state, "socket-closed");
  }
}

function nowMicros(): bigint {
  // Node lacks µs precision via Date; use process.hrtime.bigint() (ns) / 1000.
  return process.hrtime.bigint() / 1000n;
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// Re-export under a top-level barrel for ergonomic imports.
export { encodeJsonFrame };
