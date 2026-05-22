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
import { createServer as createTlsServer } from "node:tls";
import { randomBytes, verify as edVerify } from "node:crypto";
import { publicKeyFromRaw } from "../ssh/identity.js";
import { FrameDecoder, encodeJsonFrame, encodeFrame, encodePingFrame, encodeDataFrame, encodeCloseFrame, } from "./frame.js";
import { parseTypedFrame, PROTOCOL_VERSION, } from "./protocol.js";
import { loadOrGenerateRelayCert } from "./cert.js";
import { loadAllowlist, findAllowed } from "./allowlist.js";
const NONCE_BYTES = 32;
const MAX_STREAMS_PER_CONN = 64;
export class RelayServer {
    opts;
    server = null;
    conns = new Map();
    byNode = new Map();
    nextConnId = 1;
    allowlist = [];
    allowlistTimer = null;
    fingerprint = "";
    notAfter = "";
    constructor(opts) {
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
    async start() {
        const c = await loadOrGenerateRelayCert(this.opts.altNames);
        this.fingerprint = c.fingerprint;
        this.notAfter = c.notAfter;
        this.allowlist = await loadAllowlist();
        this.allowlistTimer = setInterval(() => {
            loadAllowlist().then((a) => { this.allowlist = a; }).catch(() => { });
        }, this.opts.allowlistRefreshMs);
        this.allowlistTimer.unref();
        this.server = createTlsServer({
            cert: c.cert,
            key: c.key,
            minVersion: "TLSv1.3",
            requestCert: false,
        }, (socket) => this.onConnection(socket));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.opts.port, this.opts.bind, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.opts.log(`nagent-relay: listening on ${this.opts.bind}:${port} (relayName=${this.opts.relayName})`);
        this.opts.log(`nagent-relay: fingerprint=${this.fingerprint}`);
        return { port, fingerprint: this.fingerprint, notAfter: this.notAfter };
    }
    async stop() {
        if (this.allowlistTimer) {
            clearInterval(this.allowlistTimer);
            this.allowlistTimer = null;
        }
        for (const c of this.conns.values())
            this.closeConn(c, "shutdown");
        await new Promise((resolve) => {
            if (!this.server)
                return resolve();
            this.server.close(() => resolve());
        });
        this.server = null;
    }
    /** Snapshot of currently-registered peers (used by STATUS_OK builders + CLI). */
    registeredPeers() {
        const out = [];
        for (const c of this.byNode.values()) {
            if (!c.registered)
                continue;
            out.push({
                node: c.registered.nodeName,
                rttMs: c.rttMs,
                lastSeen: c.lastSeen.toISOString(),
            });
        }
        return out.sort((a, b) => a.node.localeCompare(b.node));
    }
    onConnection(socket) {
        const id = this.nextConnId++;
        const nonce = randomBytes(NONCE_BYTES);
        const state = {
            id,
            socket,
            decoder: new FrameDecoder(),
            nonce,
            registered: null,
            rttMs: null,
            pingInflight: null,
            lastSeen: new Date(),
            pingTimer: null,
            streams: new Map(),
            outboundSidCounter: 1,
        };
        this.conns.set(id, state);
        socket.on("data", (chunk) => this.onChunk(state, chunk));
        socket.on("close", () => this.onClose(state));
        socket.on("error", (err) => this.opts.log(`relay: conn ${id} socket error: ${err.message}`));
        // Send CHALLENGE immediately so the client knows what to sign.
        this.send(state, 11 /* Verb.CHALLENGE */, Buffer.from(JSON.stringify({ nonce: nonce.toString("base64url") }), "utf8"));
    }
    onChunk(state, chunk) {
        state.lastSeen = new Date();
        let frames;
        try {
            frames = state.decoder.push(chunk);
        }
        catch (err) {
            this.opts.log(`relay: conn ${state.id} decode error: ${err.message}`);
            this.closeConn(state, "protocol-error");
            return;
        }
        for (const raw of frames) {
            let typed;
            try {
                typed = parseTypedFrame(raw);
            }
            catch (err) {
                this.opts.log(`relay: conn ${state.id} parse error: ${err.message}`);
                this.closeConn(state, "protocol-error");
                return;
            }
            if (!typed)
                continue; // forward-compat: unknown verb, ignore
            this.dispatch(state, typed).catch((err) => this.opts.log(`relay: conn ${state.id} dispatch error: ${err.message}`));
        }
    }
    async dispatch(state, frame) {
        switch (frame.verb) {
            case 1 /* Verb.REGISTER */:
                await this.handleRegister(state, frame.payload);
                return;
            case 7 /* Verb.PING */: {
                // Echo the timestamp back as a PONG so the client can measure RTT.
                const echo = Buffer.alloc(8);
                echo.writeBigUInt64BE(frame.payload.tsMicros, 0);
                this.send(state, 8 /* Verb.PONG */, echo);
                return;
            }
            case 8 /* Verb.PONG */: {
                // Our own PING came back. Compute RTT.
                if (state.pingInflight !== null && state.pingInflight === frame.payload.tsMicros) {
                    const now = nowMicros();
                    const rttUs = Number(now - state.pingInflight);
                    state.rttMs = rttUs / 1000;
                    state.pingInflight = null;
                }
                return;
            }
            case 9 /* Verb.STATUS_REQ */:
                await this.handleStatusReq(state);
                return;
            case 3 /* Verb.OPEN */:
                this.handleOpen(state, frame.payload);
                return;
            case 4 /* Verb.OPEN_OK */:
                this.handleOpenOk(state, frame.payload.streamId);
                return;
            case 132 /* Verb.OPEN_REJECT */:
                this.handleOpenReject(state, frame.payload.streamId, frame.payload.reason);
                return;
            case 5 /* Verb.DATA */:
                this.handleData(state, frame.payload.streamId, frame.payload.bytes);
                return;
            case 6 /* Verb.CLOSE */:
                this.handleCloseFrame(state, frame.payload.streamId, frame.payload.reason);
                return;
            default:
                // Unexpected for a server: REGISTER_OK / REGISTER_REJECT / STATUS_OK / CHALLENGE / OPEN_OK / OPEN_REJECT.
                // These are R→C verbs; clients shouldn't be sending them. Ignore for forward-compat.
                return;
        }
    }
    async handleRegister(state, p) {
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
        if (pubRaw.length !== 32) {
            this.rejectRegister(state, "malformed pubKey");
            return;
        }
        const sigBytes = Buffer.from(p.sig, "base64url");
        if (sigBytes.length !== 64) {
            this.rejectRegister(state, "malformed sig");
            return;
        }
        const pubKey = publicKeyFromRaw(pubRaw);
        if (!edVerify(null, state.nonce, pubKey, sigBytes)) {
            this.rejectRegister(state, "bad signature");
            return;
        }
        // Evict any prior conn for the same nodeName (last-write-wins).
        const prior = this.byNode.get(p.nodeName);
        if (prior && prior !== state)
            this.closeConn(prior, "replaced");
        state.registered = { nodeName: p.nodeName, pubKey: p.pubKey, ...(p.netId ? { netId: p.netId } : {}) };
        this.byNode.set(p.nodeName, state);
        this.send(state, 2 /* Verb.REGISTER_OK */, Buffer.from(JSON.stringify({
            relayName: this.opts.relayName,
            version: PROTOCOL_VERSION,
        }), "utf8"));
        this.opts.log(`relay: conn ${state.id} REGISTERed as ${p.nodeName}`);
        this.startPingTimer(state);
    }
    rejectRegister(state, reason) {
        this.opts.log(`relay: conn ${state.id} REGISTER rejected: ${reason}`);
        this.send(state, 130 /* Verb.REGISTER_REJECT */, Buffer.from(JSON.stringify({ reason }), "utf8"));
        this.closeConn(state, reason);
    }
    async handleStatusReq(state) {
        if (!state.registered) {
            this.opts.log(`relay: conn ${state.id} STATUS_REQ before REGISTER`);
            return;
        }
        const payload = {
            relayName: this.opts.relayName,
            peers: this.registeredPeers(),
        };
        this.send(state, 10 /* Verb.STATUS_OK */, Buffer.from(JSON.stringify(payload), "utf8"));
    }
    startPingTimer(state) {
        if (state.pingTimer)
            clearInterval(state.pingTimer);
        state.pingTimer = setInterval(() => {
            const ts = nowMicros();
            state.pingInflight = ts;
            try {
                state.socket.write(encodePingFrame(ts));
            }
            catch { /* will be cleaned by close handler */ }
        }, this.opts.pingIntervalMs);
        state.pingTimer.unref();
    }
    // -------------------------------------------------------------------------
    // Stream routing — relay maps (srcConn, srcSid) ↔ (dstConn, dstSid). Each
    // conn allocates its own streamIds; the relay picks a fresh sid in the dst
    // namespace when forwarding an OPEN. Bytes are forwarded opaquely.
    // -------------------------------------------------------------------------
    handleOpen(state, p) {
        if (!state.registered) {
            this.opts.log(`relay: conn ${state.id} OPEN before REGISTER`);
            return;
        }
        if (!p.dstNodeName) {
            this.sendOpenReject(state, p.streamId, "missing dstNodeName");
            return;
        }
        if (state.streams.size >= MAX_STREAMS_PER_CONN) {
            this.sendOpenReject(state, p.streamId, "stream-cap-exceeded");
            return;
        }
        // streamId collisions inside the same conn aren't allowed.
        if (state.streams.has(p.streamId)) {
            this.sendOpenReject(state, p.streamId, "duplicate srcSid");
            return;
        }
        const dst = this.byNode.get(p.dstNodeName);
        if (!dst) {
            this.sendOpenReject(state, p.streamId, "peer-not-registered");
            return;
        }
        if (dst === state) {
            this.sendOpenReject(state, p.streamId, "self-routing-not-allowed");
            return;
        }
        if (dst.streams.size >= MAX_STREAMS_PER_CONN) {
            this.sendOpenReject(state, p.streamId, "dst stream-cap-exceeded");
            return;
        }
        const dstSid = this.allocOutboundSid(dst);
        const stream = {
            src: state, srcSid: p.streamId,
            dst, dstSid,
            openedAt: new Date(),
            established: false,
        };
        state.streams.set(p.streamId, stream);
        dst.streams.set(dstSid, stream);
        // Forward to dst with srcNodeName populated so the receiver knows who's
        // calling. The dst conn allocates no separate sid — it reuses dstSid.
        this.send(dst, 3 /* Verb.OPEN */, Buffer.from(JSON.stringify({
            streamId: dstSid,
            srcNodeName: state.registered.nodeName,
        }), "utf8"));
    }
    handleOpenOk(state, sid) {
        const stream = state.streams.get(sid);
        if (!stream || stream.dst !== state)
            return; // ignore — OPEN_OK is dst→relay only
        stream.established = true;
        this.send(stream.src, 4 /* Verb.OPEN_OK */, Buffer.from(JSON.stringify({ streamId: stream.srcSid }), "utf8"));
    }
    handleOpenReject(state, sid, reason) {
        const stream = state.streams.get(sid);
        if (!stream || stream.dst !== state)
            return;
        this.send(stream.src, 132 /* Verb.OPEN_REJECT */, Buffer.from(JSON.stringify({
            streamId: stream.srcSid, reason,
        }), "utf8"));
        this.dropStream(stream);
    }
    handleData(state, sid, bytes) {
        const stream = state.streams.get(sid);
        if (!stream)
            return;
        const isSrc = stream.src === state;
        const peer = isSrc ? stream.dst : stream.src;
        const peerSid = isSrc ? stream.dstSid : stream.srcSid;
        try {
            peer.socket.write(encodeDataFrame(peerSid, bytes));
        }
        catch (err) {
            this.opts.log(`relay: conn ${state.id} stream ${sid} forward failed: ${err.message}`);
        }
    }
    handleCloseFrame(state, sid, reason) {
        const stream = state.streams.get(sid);
        if (!stream)
            return;
        const isSrc = stream.src === state;
        const peer = isSrc ? stream.dst : stream.src;
        const peerSid = isSrc ? stream.dstSid : stream.srcSid;
        try {
            peer.socket.write(encodeCloseFrame(peerSid, reason));
        }
        catch { /* peer may have just dropped */ }
        this.dropStream(stream);
    }
    sendOpenReject(state, sid, reason) {
        this.send(state, 132 /* Verb.OPEN_REJECT */, Buffer.from(JSON.stringify({ streamId: sid, reason }), "utf8"));
    }
    allocOutboundSid(conn) {
        // Linear probe; collisions are rare given our 64-stream cap.
        for (let i = 0; i < 0x10000; i++) {
            const sid = conn.outboundSidCounter++;
            if (conn.outboundSidCounter > 0x7fff_ffff)
                conn.outboundSidCounter = 1;
            if (!conn.streams.has(sid))
                return sid;
        }
        throw new Error("allocOutboundSid: exhausted (shouldn't happen with the per-conn cap)");
    }
    dropStream(s) {
        s.src.streams.delete(s.srcSid);
        s.dst.streams.delete(s.dstSid);
    }
    send(state, verb, payload) {
        try {
            state.socket.write(encodeFrame(verb, payload));
        }
        catch (err) {
            this.opts.log(`relay: conn ${state.id} write failed: ${err.message}`);
        }
    }
    closeConn(state, reason) {
        if (!this.conns.has(state.id))
            return;
        if (state.pingTimer) {
            clearInterval(state.pingTimer);
            state.pingTimer = null;
        }
        // Tear down all this conn's streams, notifying the peer side.
        for (const stream of [...state.streams.values()]) {
            const isSrc = stream.src === state;
            const peer = isSrc ? stream.dst : stream.src;
            const peerSid = isSrc ? stream.dstSid : stream.srcSid;
            try {
                peer.socket.write(encodeCloseFrame(peerSid, "peer-disconnected"));
            }
            catch { /* peer may have dropped too */ }
            this.dropStream(stream);
        }
        if (state.registered && this.byNode.get(state.registered.nodeName) === state) {
            this.byNode.delete(state.registered.nodeName);
        }
        this.conns.delete(state.id);
        try {
            state.socket.destroy();
        }
        catch { /* ignore */ }
        void reason;
    }
    onClose(state) {
        this.closeConn(state, "socket-closed");
    }
}
function nowMicros() {
    // Node lacks µs precision via Date; use process.hrtime.bigint() (ns) / 1000.
    return process.hrtime.bigint() / 1000n;
}
function timingSafeBufferEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
// Re-export under a top-level barrel for ergonomic imports.
export { encodeJsonFrame };
//# sourceMappingURL=server.js.map