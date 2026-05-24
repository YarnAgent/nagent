// nagent-relay client — maintains a long-lived TLS connection to each pinned
// relay, registers via the CHALLENGE/REGISTER handshake, and runs two
// services on top:
//   1. Inbound stream handler: when the relay forwards an OPEN to us, open a
//      local TCP connection (default 127.0.0.1:22) and bridge bytes opaquely.
//      The relay never sees plaintext — SSH does its own e2e auth/encrypt.
//   2. IPC server: dialers (nagent relay-dial …, the ssh ProxyCommand helper)
//      connect over a Unix socket, request "open a stream to peer P via relay
//      R", and get a transparent duplex once OPEN_OK lands.

import {
  connect as tlsConnect,
  type TLSSocket,
} from "node:tls";
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";
import { sign as edSign, type KeyObject } from "node:crypto";
import {
  FrameDecoder,
  Verb,
  encodeJsonFrame,
  encodeDataFrame,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  type Frame,
} from "./frame.js";
import { parseTypedFrame, type StatusOkPayload } from "./protocol.js";

export interface PinnedRelay {
  name: string;
  url: string;             // https://host:port
  fingerprint: string;     // SHA-256 cert fingerprint (colon-separated uppercase hex)
}

export interface RelayClientIdentity {
  nodeName: string;
  /** base64url raw 32-byte ed25519 public key */
  pubKey: string;
  /** Node KeyObject for the matching private key */
  privateKey: KeyObject;
  netId?: string;
}

export interface RelayClientOptions {
  identity: RelayClientIdentity;
  /** Local TCP target for inbound streams. Default 127.0.0.1:22. */
  inboundTarget?: { host: string; port: number };
  /** Unix socket path where the dialer connects. */
  ipcSockPath: string;
  pingIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log?: (line: string) => void;
}

interface RelayConn {
  pinned: PinnedRelay;
  socket: TLSSocket | null;
  decoder: FrameDecoder;
  state: "connecting" | "registered" | "down";
  nextSid: number;
  rttMs: number | null;
  pingInflight: bigint | null;
  pingTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  attempts: number;
  /** Inbound streams keyed by our local sid (the dst sid the relay chose). */
  inbound: Map<number, InboundBridge>;
  /** Outbound streams keyed by our local sid (we picked it). */
  outbound: Map<number, OutboundBridge>;
  /** Promises waiting for STATUS_OK replies. */
  pendingStatus: Array<(s: StatusOkPayload) => void>;
}

interface InboundBridge {
  sid: number;
  upstreamSock: NetSocket;
  srcNodeName: string;
}

interface OutboundBridge {
  sid: number;
  ipcSock: NetSocket;
  established: boolean;
  /** Bytes queued from IPC before OPEN_OK lands. */
  earlyBuffer: Buffer[];
}

const DEFAULT_INBOUND: { host: string; port: number } = { host: "127.0.0.1", port: 22 };

export class RelayClient {
  private readonly opts: Required<Omit<RelayClientOptions, "identity" | "ipcSockPath">> & {
    identity: RelayClientIdentity;
    ipcSockPath: string;
  };
  private conns = new Map<string, RelayConn>(); // by pinned.name
  private ipcServer: NetServer | null = null;
  private stopping = false;

  constructor(opts: RelayClientOptions) {
    this.opts = {
      identity: opts.identity,
      ipcSockPath: opts.ipcSockPath,
      inboundTarget: opts.inboundTarget ?? DEFAULT_INBOUND,
      pingIntervalMs: opts.pingIntervalMs ?? 30_000,
      reconnectMinMs: opts.reconnectMinMs ?? 1_000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 30_000,
      log: opts.log ?? ((line) => process.stderr.write(line + "\n")),
    };
  }

  async start(pinned: PinnedRelay[]): Promise<void> {
    await this.startIpcServer();
    for (const p of pinned) this.openRelay(p);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const c of this.conns.values()) this.dropConn(c, "shutdown");
    this.conns.clear();
    if (this.ipcServer) {
      await new Promise<void>((resolve) => this.ipcServer!.close(() => resolve()));
      this.ipcServer = null;
      try { await fs.unlink(this.opts.ipcSockPath); } catch { /* ignore */ }
    }
  }

  rttFor(relayName: string): number | null {
    return this.conns.get(relayName)?.rttMs ?? null;
  }

  fetchStatus(relayName: string, timeoutMs = 2_000): Promise<StatusOkPayload> {
    const conn = this.conns.get(relayName);
    if (!conn || conn.state !== "registered" || !conn.socket) {
      return Promise.reject(new Error(`relay "${relayName}" is not registered`));
    }
    return new Promise<StatusOkPayload>((resolve, reject) => {
      const onStatus = (s: StatusOkPayload): void => { clearTimeout(timer); resolve(s); };
      const timer = setTimeout(() => {
        const i = conn.pendingStatus.indexOf(onStatus);
        if (i >= 0) conn.pendingStatus.splice(i, 1);
        reject(new Error(`STATUS timed out for "${relayName}"`));
      }, timeoutMs);
      conn.pendingStatus.push(onStatus);
      try { conn.socket!.write(encodeJsonFrame(Verb.STATUS_REQ, {})); }
      catch (err) { clearTimeout(timer); reject(err); }
    });
  }

  // -------------------------------------------------------------------------
  // TLS dial + registration
  // -------------------------------------------------------------------------

  private openRelay(pinned: PinnedRelay): void {
    const existing = this.conns.get(pinned.name);
    if (existing) this.dropConn(existing, "reopen");
    const conn: RelayConn = {
      pinned,
      socket: null,
      decoder: new FrameDecoder(),
      state: "connecting",
      nextSid: 1,
      rttMs: null,
      pingInflight: null,
      pingTimer: null,
      reconnectTimer: null,
      attempts: 0,
      inbound: new Map(),
      outbound: new Map(),
      pendingStatus: [],
    };
    this.conns.set(pinned.name, conn);
    this.connectRelay(conn);
  }

  private connectRelay(conn: RelayConn): void {
    if (this.stopping) return;
    conn.attempts++;
    const { host, port } = parseUrl(conn.pinned.url);
    const sock = tlsConnect({
      host, port,
      rejectUnauthorized: false,
      ALPNProtocols: ["nagent-relay/1"], // informational; server doesn't gate on it
    }, () => this.onTlsConnected(conn, sock));
    sock.on("error", (err) => this.opts.log(`relay-client: ${conn.pinned.name} tls error: ${err.message}`));
    sock.on("data", (chunk) => this.onChunk(conn, chunk));
    sock.on("close", () => this.onSocketClose(conn));
    conn.socket = sock;
  }

  private onTlsConnected(conn: RelayConn, sock: TLSSocket): void {
    const peer = sock.getPeerX509Certificate();
    if (!peer) {
      this.opts.log(`relay-client: ${conn.pinned.name} no peer cert`);
      sock.destroy();
      return;
    }
    if (peer.fingerprint256.toUpperCase() !== conn.pinned.fingerprint.toUpperCase()) {
      this.opts.log(
        `relay-client: ${conn.pinned.name} FINGERPRINT MISMATCH ` +
        `(got ${peer.fingerprint256}, pinned ${conn.pinned.fingerprint})`,
      );
      sock.destroy();
      return;
    }
    // Now we wait for the CHALLENGE on socket "data".
  }

  private async sendRegister(conn: RelayConn, nonce: string): Promise<void> {
    const nonceBytes = Buffer.from(nonce, "base64url");
    const sig = edSign(null, nonceBytes, this.opts.identity.privateKey);
    conn.socket!.write(encodeJsonFrame(Verb.REGISTER, {
      nodeName: this.opts.identity.nodeName,
      pubKey: this.opts.identity.pubKey,
      nonce,
      sig: sig.toString("base64url"),
      ...(this.opts.identity.netId ? { netId: this.opts.identity.netId } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // Frame dispatch
  // -------------------------------------------------------------------------

  private onChunk(conn: RelayConn, chunk: Buffer): void {
    let frames: Frame[];
    try { frames = conn.decoder.push(chunk); }
    catch (err) {
      this.opts.log(`relay-client: ${conn.pinned.name} decode error: ${(err as Error).message}`);
      this.dropConn(conn, "decode-error");
      return;
    }
    for (const raw of frames) {
      let typed;
      try { typed = parseTypedFrame(raw); } catch (err) {
        this.opts.log(`relay-client: ${conn.pinned.name} parse error: ${(err as Error).message}`);
        continue;
      }
      if (!typed) continue;
      this.dispatch(conn, typed).catch((err) =>
        this.opts.log(`relay-client: ${conn.pinned.name} dispatch error: ${(err as Error).message}`),
      );
    }
  }

  private async dispatch(conn: RelayConn, frame: ReturnType<typeof parseTypedFrame> & object): Promise<void> {
    switch (frame.verb) {
      case Verb.CHALLENGE:
        await this.sendRegister(conn, frame.payload.nonce);
        return;
      case Verb.REGISTER_OK:
        conn.state = "registered";
        conn.attempts = 0;
        this.opts.log(`relay-client: registered with ${conn.pinned.name} as ${this.opts.identity.nodeName}`);
        this.startPingTimer(conn);
        return;
      case Verb.REGISTER_REJECT:
        this.opts.log(`relay-client: ${conn.pinned.name} REGISTER rejected: ${frame.payload.reason}`);
        this.dropConn(conn, "register-rejected");
        return;
      case Verb.PING: {
        const out = Buffer.alloc(8);
        out.writeBigUInt64BE(frame.payload.tsMicros, 0);
        try { conn.socket?.write(encodePongFrame(frame.payload.tsMicros)); } catch { /* */ }
        void out;
        return;
      }
      case Verb.PONG:
        if (conn.pingInflight !== null && conn.pingInflight === frame.payload.tsMicros) {
          const rttUs = Number(nowMicros() - conn.pingInflight);
          conn.rttMs = rttUs / 1000;
          conn.pingInflight = null;
        }
        return;
      case Verb.STATUS_OK: {
        const cb = conn.pendingStatus.shift();
        if (cb) cb(frame.payload);
        return;
      }
      case Verb.OPEN:
        await this.handleInboundOpen(conn, frame.payload.streamId, frame.payload.srcNodeName ?? "?");
        return;
      case Verb.OPEN_OK: {
        const ob = conn.outbound.get(frame.payload.streamId);
        if (!ob || ob.established) return;
        ob.established = true;
        ob.ipcSock.write(JSON.stringify({ v: 1, ok: true }) + "\n");
        for (const buf of ob.earlyBuffer) {
          try { conn.socket?.write(encodeDataFrame(ob.sid, buf)); } catch { /* */ }
        }
        ob.earlyBuffer = [];
        return;
      }
      case Verb.OPEN_REJECT: {
        const ob = conn.outbound.get(frame.payload.streamId);
        if (!ob) return;
        try { ob.ipcSock.write(JSON.stringify({ v: 1, ok: false, reason: frame.payload.reason }) + "\n"); }
        catch { /* */ }
        try { ob.ipcSock.destroy(); } catch { /* */ }
        conn.outbound.delete(frame.payload.streamId);
        return;
      }
      case Verb.DATA:
        this.handleData(conn, frame.payload.streamId, frame.payload.bytes);
        return;
      case Verb.CLOSE:
        this.handleClose(conn, frame.payload.streamId);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound stream → localhost:22 bridge
  // -------------------------------------------------------------------------

  private async handleInboundOpen(conn: RelayConn, sid: number, srcNodeName: string): Promise<void> {
    if (conn.inbound.has(sid)) return; // dup
    const upstream = netConnect(this.opts.inboundTarget.port, this.opts.inboundTarget.host, () => {
      // Connected. Tell the relay we're ready.
      try { conn.socket?.write(encodeJsonFrame(Verb.OPEN_OK, { streamId: sid })); } catch { /* */ }
    });
    const bridge: InboundBridge = { sid, upstreamSock: upstream, srcNodeName };
    conn.inbound.set(sid, bridge);

    upstream.on("data", (chunk) => {
      try { conn.socket?.write(encodeDataFrame(sid, chunk)); } catch { /* */ }
    });
    upstream.on("end", () => {
      try { conn.socket?.write(encodeCloseFrame(sid, "upstream-eof")); } catch { /* */ }
      conn.inbound.delete(sid);
    });
    upstream.on("error", (err) => {
      this.opts.log(`relay-client: inbound stream ${sid} to ${this.opts.inboundTarget.host}:${this.opts.inboundTarget.port} failed: ${err.message}`);
      try { conn.socket?.write(encodeJsonFrame(Verb.OPEN_REJECT, { streamId: sid, reason: err.message })); }
      catch { /* */ }
      conn.inbound.delete(sid);
    });
  }

  private handleData(conn: RelayConn, sid: number, bytes: Buffer): void {
    const inbound = conn.inbound.get(sid);
    if (inbound) {
      try { inbound.upstreamSock.write(bytes); } catch { /* */ }
      return;
    }
    const outbound = conn.outbound.get(sid);
    if (outbound) {
      try { outbound.ipcSock.write(bytes); } catch { /* */ }
      return;
    }
    // Stale: stream was closed already.
  }

  private handleClose(conn: RelayConn, sid: number): void {
    const inbound = conn.inbound.get(sid);
    if (inbound) {
      try { inbound.upstreamSock.end(); } catch { /* */ }
      conn.inbound.delete(sid);
      return;
    }
    const outbound = conn.outbound.get(sid);
    if (outbound) {
      try { outbound.ipcSock.end(); } catch { /* */ }
      conn.outbound.delete(sid);
    }
  }

  // -------------------------------------------------------------------------
  // IPC server — accepts dialer connections, opens outbound streams
  // -------------------------------------------------------------------------

  private async startIpcServer(): Promise<void> {
    await fs.mkdir(dirname(this.opts.ipcSockPath), { recursive: true, mode: 0o700 });
    try { await fs.unlink(this.opts.ipcSockPath); } catch { /* */ }
    this.ipcServer = createNetServer((sock) => this.handleIpcConn(sock));
    await new Promise<void>((resolve, reject) => {
      this.ipcServer!.once("error", reject);
      this.ipcServer!.listen(this.opts.ipcSockPath, () => {
        this.ipcServer!.off("error", reject);
        resolve();
      });
    });
    try { await fs.chmod(this.opts.ipcSockPath, 0o600); } catch { /* */ }
  }

  private handleIpcConn(sock: NetSocket): void {
    let header: string | null = null;
    let buf = Buffer.alloc(0);
    const onHeaderData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      header = buf.subarray(0, nl).toString("utf8");
      const remainder = buf.subarray(nl + 1);
      sock.off("data", onHeaderData);
      this.handleIpcRequest(sock, header, remainder).catch((err) => {
        try { sock.write(JSON.stringify({ v: 1, ok: false, reason: err.message }) + "\n"); } catch { /* */ }
        try { sock.destroy(); } catch { /* */ }
      });
    };
    sock.on("data", onHeaderData);
    sock.on("error", () => { /* swallow; the rest is best-effort */ });
  }

  private async handleIpcRequest(sock: NetSocket, headerLine: string, remainder: Buffer): Promise<void> {
    let header: { v: number; cmd: string; relay?: string; peer?: string };
    try { header = JSON.parse(headerLine); }
    catch (err) { throw new Error(`bad IPC header: ${(err as Error).message}`); }
    if (header.cmd !== "dial") throw new Error(`unknown IPC cmd: ${header.cmd}`);
    if (!header.relay || !header.peer) throw new Error(`IPC dial: missing relay or peer`);

    const conn = this.conns.get(header.relay);
    if (!conn || conn.state !== "registered" || !conn.socket) {
      throw new Error(`relay "${header.relay}" not registered`);
    }

    const sid = conn.nextSid++;
    const ob: OutboundBridge = { sid, ipcSock: sock, established: false, earlyBuffer: [] };
    conn.outbound.set(sid, ob);

    // If the dialer sent some bytes before our header parse completed, queue them.
    if (remainder.length) ob.earlyBuffer.push(remainder);

    // Pipe subsequent IPC bytes to the stream. While !established, buffer them.
    sock.on("data", (chunk) => {
      if (ob.established) {
        try { conn.socket?.write(encodeDataFrame(sid, chunk)); } catch { /* */ }
      } else {
        ob.earlyBuffer.push(chunk);
      }
    });
    sock.on("end", () => {
      try { conn.socket?.write(encodeCloseFrame(sid, "dialer-eof")); } catch { /* */ }
      conn.outbound.delete(sid);
    });
    sock.on("error", () => {
      try { conn.socket?.write(encodeCloseFrame(sid, "dialer-error")); } catch { /* */ }
      conn.outbound.delete(sid);
    });

    // Fire the OPEN.
    try {
      conn.socket.write(encodeJsonFrame(Verb.OPEN, { streamId: sid, dstNodeName: header.peer }));
    } catch (err) {
      conn.outbound.delete(sid);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Keepalive + reconnect
  // -------------------------------------------------------------------------

  private startPingTimer(conn: RelayConn): void {
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => {
      if (conn.state !== "registered" || !conn.socket) return;
      const ts = nowMicros();
      conn.pingInflight = ts;
      try { conn.socket.write(encodePingFrame(ts)); } catch { /* */ }
    }, this.opts.pingIntervalMs);
    conn.pingTimer.unref();
  }

  private onSocketClose(conn: RelayConn): void {
    this.dropConnButPersistEntry(conn);
    if (this.stopping) return;
    const delay = backoffDelay(conn.attempts, this.opts.reconnectMinMs, this.opts.reconnectMaxMs);
    conn.reconnectTimer = setTimeout(() => this.connectRelay(conn), delay);
    conn.reconnectTimer.unref();
  }

  private dropConn(conn: RelayConn, _reason: string): void {
    this.dropConnButPersistEntry(conn);
    this.conns.delete(conn.pinned.name);
  }

  private dropConnButPersistEntry(conn: RelayConn): void {
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
    if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
    // Tear down all open streams locally.
    for (const ib of conn.inbound.values()) {
      try { ib.upstreamSock.destroy(); } catch { /* */ }
    }
    conn.inbound.clear();
    for (const ob of conn.outbound.values()) {
      try { ob.ipcSock.destroy(); } catch { /* */ }
    }
    conn.outbound.clear();
    if (conn.socket) {
      try { conn.socket.destroy(); } catch { /* */ }
      conn.socket = null;
    }
    conn.state = "down";
    conn.decoder = new FrameDecoder();
  }
}

function backoffDelay(attempts: number, minMs: number, maxMs: number): number {
  const base = Math.min(maxMs, minMs * Math.pow(2, attempts - 1));
  const jitter = Math.floor(Math.random() * base * 0.2);
  return base + jitter;
}

function nowMicros(): bigint {
  return process.hrtime.bigint() / 1000n;
}

function parseUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : 8443 };
}
