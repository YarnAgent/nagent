// nagent-relay client — maintains a long-lived TLS connection to each pinned
// relay, registers via the CHALLENGE/REGISTER handshake, and runs two
// services on top:
//   1. Inbound stream handler: when the relay forwards an OPEN to us, open a
//      local TCP connection (default 127.0.0.1:22) and bridge bytes opaquely.
//      The relay never sees plaintext — SSH does its own e2e auth/encrypt.
//   2. IPC server: dialers (nagent relay-dial …, the ssh ProxyCommand helper)
//      connect over a Unix socket, request "open a stream to peer P via relay
//      R", and get a transparent duplex once OPEN_OK lands.
import { connect as tlsConnect, } from "node:tls";
import { connect as netConnect, createServer as createNetServer, } from "node:net";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";
import { sign as edSign } from "node:crypto";
import { FrameDecoder, encodeJsonFrame, encodeDataFrame, encodeCloseFrame, encodePingFrame, encodePongFrame, } from "./frame.js";
import { parseTypedFrame } from "./protocol.js";
const DEFAULT_INBOUND = { host: "127.0.0.1", port: 22 };
export class RelayClient {
    opts;
    conns = new Map(); // by pinned.name
    ipcServer = null;
    stopping = false;
    constructor(opts) {
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
    async start(pinned) {
        await this.startIpcServer();
        for (const p of pinned)
            this.openRelay(p);
    }
    async stop() {
        this.stopping = true;
        for (const c of this.conns.values())
            this.dropConn(c, "shutdown");
        this.conns.clear();
        if (this.ipcServer) {
            await new Promise((resolve) => this.ipcServer.close(() => resolve()));
            this.ipcServer = null;
            try {
                await fs.unlink(this.opts.ipcSockPath);
            }
            catch { /* ignore */ }
        }
    }
    rttFor(relayName) {
        return this.conns.get(relayName)?.rttMs ?? null;
    }
    fetchStatus(relayName, timeoutMs = 2_000) {
        const conn = this.conns.get(relayName);
        if (!conn || conn.state !== "registered" || !conn.socket) {
            return Promise.reject(new Error(`relay "${relayName}" is not registered`));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = conn.pendingStatus.indexOf(resolve);
                if (i >= 0)
                    conn.pendingStatus.splice(i, 1);
                reject(new Error(`STATUS timed out for "${relayName}"`));
            }, timeoutMs);
            conn.pendingStatus.push((s) => { clearTimeout(timer); resolve(s); });
            try {
                conn.socket.write(encodeJsonFrame(9 /* Verb.STATUS_REQ */, {}));
            }
            catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    }
    // -------------------------------------------------------------------------
    // TLS dial + registration
    // -------------------------------------------------------------------------
    openRelay(pinned) {
        const existing = this.conns.get(pinned.name);
        if (existing)
            this.dropConn(existing, "reopen");
        const conn = {
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
    connectRelay(conn) {
        if (this.stopping)
            return;
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
    onTlsConnected(conn, sock) {
        const peer = sock.getPeerX509Certificate();
        if (!peer) {
            this.opts.log(`relay-client: ${conn.pinned.name} no peer cert`);
            sock.destroy();
            return;
        }
        if (peer.fingerprint256.toUpperCase() !== conn.pinned.fingerprint.toUpperCase()) {
            this.opts.log(`relay-client: ${conn.pinned.name} FINGERPRINT MISMATCH ` +
                `(got ${peer.fingerprint256}, pinned ${conn.pinned.fingerprint})`);
            sock.destroy();
            return;
        }
        // Now we wait for the CHALLENGE on socket "data".
    }
    async sendRegister(conn, nonce) {
        const nonceBytes = Buffer.from(nonce, "base64url");
        const sig = edSign(null, nonceBytes, this.opts.identity.privateKey);
        conn.socket.write(encodeJsonFrame(1 /* Verb.REGISTER */, {
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
    onChunk(conn, chunk) {
        let frames;
        try {
            frames = conn.decoder.push(chunk);
        }
        catch (err) {
            this.opts.log(`relay-client: ${conn.pinned.name} decode error: ${err.message}`);
            this.dropConn(conn, "decode-error");
            return;
        }
        for (const raw of frames) {
            let typed;
            try {
                typed = parseTypedFrame(raw);
            }
            catch (err) {
                this.opts.log(`relay-client: ${conn.pinned.name} parse error: ${err.message}`);
                continue;
            }
            if (!typed)
                continue;
            this.dispatch(conn, typed).catch((err) => this.opts.log(`relay-client: ${conn.pinned.name} dispatch error: ${err.message}`));
        }
    }
    async dispatch(conn, frame) {
        switch (frame.verb) {
            case 11 /* Verb.CHALLENGE */:
                await this.sendRegister(conn, frame.payload.nonce);
                return;
            case 2 /* Verb.REGISTER_OK */:
                conn.state = "registered";
                conn.attempts = 0;
                this.opts.log(`relay-client: registered with ${conn.pinned.name} as ${this.opts.identity.nodeName}`);
                this.startPingTimer(conn);
                return;
            case 130 /* Verb.REGISTER_REJECT */:
                this.opts.log(`relay-client: ${conn.pinned.name} REGISTER rejected: ${frame.payload.reason}`);
                this.dropConn(conn, "register-rejected");
                return;
            case 7 /* Verb.PING */: {
                const out = Buffer.alloc(8);
                out.writeBigUInt64BE(frame.payload.tsMicros, 0);
                try {
                    conn.socket?.write(encodePongFrame(frame.payload.tsMicros));
                }
                catch { /* */ }
                void out;
                return;
            }
            case 8 /* Verb.PONG */:
                if (conn.pingInflight !== null && conn.pingInflight === frame.payload.tsMicros) {
                    const rttUs = Number(nowMicros() - conn.pingInflight);
                    conn.rttMs = rttUs / 1000;
                    conn.pingInflight = null;
                }
                return;
            case 10 /* Verb.STATUS_OK */: {
                const cb = conn.pendingStatus.shift();
                if (cb)
                    cb(frame.payload);
                return;
            }
            case 3 /* Verb.OPEN */:
                await this.handleInboundOpen(conn, frame.payload.streamId, frame.payload.srcNodeName ?? "?");
                return;
            case 4 /* Verb.OPEN_OK */: {
                const ob = conn.outbound.get(frame.payload.streamId);
                if (!ob || ob.established)
                    return;
                ob.established = true;
                ob.ipcSock.write(JSON.stringify({ v: 1, ok: true }) + "\n");
                for (const buf of ob.earlyBuffer) {
                    try {
                        conn.socket?.write(encodeDataFrame(ob.sid, buf));
                    }
                    catch { /* */ }
                }
                ob.earlyBuffer = [];
                return;
            }
            case 132 /* Verb.OPEN_REJECT */: {
                const ob = conn.outbound.get(frame.payload.streamId);
                if (!ob)
                    return;
                try {
                    ob.ipcSock.write(JSON.stringify({ v: 1, ok: false, reason: frame.payload.reason }) + "\n");
                }
                catch { /* */ }
                try {
                    ob.ipcSock.destroy();
                }
                catch { /* */ }
                conn.outbound.delete(frame.payload.streamId);
                return;
            }
            case 5 /* Verb.DATA */:
                this.handleData(conn, frame.payload.streamId, frame.payload.bytes);
                return;
            case 6 /* Verb.CLOSE */:
                this.handleClose(conn, frame.payload.streamId);
                return;
            default:
                return;
        }
    }
    // -------------------------------------------------------------------------
    // Inbound stream → localhost:22 bridge
    // -------------------------------------------------------------------------
    async handleInboundOpen(conn, sid, srcNodeName) {
        if (conn.inbound.has(sid))
            return; // dup
        const upstream = netConnect(this.opts.inboundTarget.port, this.opts.inboundTarget.host, () => {
            // Connected. Tell the relay we're ready.
            try {
                conn.socket?.write(encodeJsonFrame(4 /* Verb.OPEN_OK */, { streamId: sid }));
            }
            catch { /* */ }
        });
        const bridge = { sid, upstreamSock: upstream, srcNodeName };
        conn.inbound.set(sid, bridge);
        upstream.on("data", (chunk) => {
            try {
                conn.socket?.write(encodeDataFrame(sid, chunk));
            }
            catch { /* */ }
        });
        upstream.on("end", () => {
            try {
                conn.socket?.write(encodeCloseFrame(sid, "upstream-eof"));
            }
            catch { /* */ }
            conn.inbound.delete(sid);
        });
        upstream.on("error", (err) => {
            this.opts.log(`relay-client: inbound stream ${sid} to ${this.opts.inboundTarget.host}:${this.opts.inboundTarget.port} failed: ${err.message}`);
            try {
                conn.socket?.write(encodeJsonFrame(132 /* Verb.OPEN_REJECT */, { streamId: sid, reason: err.message }));
            }
            catch { /* */ }
            conn.inbound.delete(sid);
        });
    }
    handleData(conn, sid, bytes) {
        const inbound = conn.inbound.get(sid);
        if (inbound) {
            try {
                inbound.upstreamSock.write(bytes);
            }
            catch { /* */ }
            return;
        }
        const outbound = conn.outbound.get(sid);
        if (outbound) {
            try {
                outbound.ipcSock.write(bytes);
            }
            catch { /* */ }
            return;
        }
        // Stale: stream was closed already.
    }
    handleClose(conn, sid) {
        const inbound = conn.inbound.get(sid);
        if (inbound) {
            try {
                inbound.upstreamSock.end();
            }
            catch { /* */ }
            conn.inbound.delete(sid);
            return;
        }
        const outbound = conn.outbound.get(sid);
        if (outbound) {
            try {
                outbound.ipcSock.end();
            }
            catch { /* */ }
            conn.outbound.delete(sid);
        }
    }
    // -------------------------------------------------------------------------
    // IPC server — accepts dialer connections, opens outbound streams
    // -------------------------------------------------------------------------
    async startIpcServer() {
        await fs.mkdir(dirname(this.opts.ipcSockPath), { recursive: true, mode: 0o700 });
        try {
            await fs.unlink(this.opts.ipcSockPath);
        }
        catch { /* */ }
        this.ipcServer = createNetServer((sock) => this.handleIpcConn(sock));
        await new Promise((resolve, reject) => {
            this.ipcServer.once("error", reject);
            this.ipcServer.listen(this.opts.ipcSockPath, () => {
                this.ipcServer.off("error", reject);
                resolve();
            });
        });
        try {
            await fs.chmod(this.opts.ipcSockPath, 0o600);
        }
        catch { /* */ }
    }
    handleIpcConn(sock) {
        let header = null;
        let buf = Buffer.alloc(0);
        const onHeaderData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const nl = buf.indexOf(0x0a);
            if (nl < 0)
                return;
            header = buf.subarray(0, nl).toString("utf8");
            const remainder = buf.subarray(nl + 1);
            sock.off("data", onHeaderData);
            this.handleIpcRequest(sock, header, remainder).catch((err) => {
                try {
                    sock.write(JSON.stringify({ v: 1, ok: false, reason: err.message }) + "\n");
                }
                catch { /* */ }
                try {
                    sock.destroy();
                }
                catch { /* */ }
            });
        };
        sock.on("data", onHeaderData);
        sock.on("error", () => { });
    }
    async handleIpcRequest(sock, headerLine, remainder) {
        let header;
        try {
            header = JSON.parse(headerLine);
        }
        catch (err) {
            throw new Error(`bad IPC header: ${err.message}`);
        }
        if (header.cmd !== "dial")
            throw new Error(`unknown IPC cmd: ${header.cmd}`);
        if (!header.relay || !header.peer)
            throw new Error(`IPC dial: missing relay or peer`);
        const conn = this.conns.get(header.relay);
        if (!conn || conn.state !== "registered" || !conn.socket) {
            throw new Error(`relay "${header.relay}" not registered`);
        }
        const sid = conn.nextSid++;
        const ob = { sid, ipcSock: sock, established: false, earlyBuffer: [] };
        conn.outbound.set(sid, ob);
        // If the dialer sent some bytes before our header parse completed, queue them.
        if (remainder.length)
            ob.earlyBuffer.push(remainder);
        // Pipe subsequent IPC bytes to the stream. While !established, buffer them.
        sock.on("data", (chunk) => {
            if (ob.established) {
                try {
                    conn.socket?.write(encodeDataFrame(sid, chunk));
                }
                catch { /* */ }
            }
            else {
                ob.earlyBuffer.push(chunk);
            }
        });
        sock.on("end", () => {
            try {
                conn.socket?.write(encodeCloseFrame(sid, "dialer-eof"));
            }
            catch { /* */ }
            conn.outbound.delete(sid);
        });
        sock.on("error", () => {
            try {
                conn.socket?.write(encodeCloseFrame(sid, "dialer-error"));
            }
            catch { /* */ }
            conn.outbound.delete(sid);
        });
        // Fire the OPEN.
        try {
            conn.socket.write(encodeJsonFrame(3 /* Verb.OPEN */, { streamId: sid, dstNodeName: header.peer }));
        }
        catch (err) {
            conn.outbound.delete(sid);
            throw err;
        }
    }
    // -------------------------------------------------------------------------
    // Keepalive + reconnect
    // -------------------------------------------------------------------------
    startPingTimer(conn) {
        if (conn.pingTimer)
            clearInterval(conn.pingTimer);
        conn.pingTimer = setInterval(() => {
            if (conn.state !== "registered" || !conn.socket)
                return;
            const ts = nowMicros();
            conn.pingInflight = ts;
            try {
                conn.socket.write(encodePingFrame(ts));
            }
            catch { /* */ }
        }, this.opts.pingIntervalMs);
        conn.pingTimer.unref();
    }
    onSocketClose(conn) {
        this.dropConnButPersistEntry(conn);
        if (this.stopping)
            return;
        const delay = backoffDelay(conn.attempts, this.opts.reconnectMinMs, this.opts.reconnectMaxMs);
        conn.reconnectTimer = setTimeout(() => this.connectRelay(conn), delay);
        conn.reconnectTimer.unref();
    }
    dropConn(conn, _reason) {
        this.dropConnButPersistEntry(conn);
        this.conns.delete(conn.pinned.name);
    }
    dropConnButPersistEntry(conn) {
        if (conn.pingTimer) {
            clearInterval(conn.pingTimer);
            conn.pingTimer = null;
        }
        if (conn.reconnectTimer) {
            clearTimeout(conn.reconnectTimer);
            conn.reconnectTimer = null;
        }
        // Tear down all open streams locally.
        for (const ib of conn.inbound.values()) {
            try {
                ib.upstreamSock.destroy();
            }
            catch { /* */ }
        }
        conn.inbound.clear();
        for (const ob of conn.outbound.values()) {
            try {
                ob.ipcSock.destroy();
            }
            catch { /* */ }
        }
        conn.outbound.clear();
        if (conn.socket) {
            try {
                conn.socket.destroy();
            }
            catch { /* */ }
            conn.socket = null;
        }
        conn.state = "down";
        conn.decoder = new FrameDecoder();
    }
}
function backoffDelay(attempts, minMs, maxMs) {
    const base = Math.min(maxMs, minMs * Math.pow(2, attempts - 1));
    const jitter = Math.floor(Math.random() * base * 0.2);
    return base + jitter;
}
function nowMicros() {
    return process.hrtime.bigint() / 1000n;
}
function parseUrl(url) {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? Number(u.port) : 443 };
}
//# sourceMappingURL=client.js.map