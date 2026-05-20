import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { paths, TMUX_SOCKET_NAME } from "../platform/paths.js";
import { encodeFrame, FrameDecoder } from "../bus/frame.js";
import { matches } from "../bus/match.js";
import { writeJson, readJson } from "../store/json.js";
import { ensureNagentRoot, readIdentity } from "../store/index.js";
const QUEUE_LIMIT = 256;
export class Daemon {
    server = null;
    clients = new Set();
    sessions = new Map();
    nodeName = "node";
    log;
    foreground;
    constructor(opts) {
        this.foreground = opts.foreground;
        this.log = opts.log ?? ((line) => {
            if (this.foreground)
                process.stderr.write(line + "\n");
        });
    }
    async start() {
        await ensureNagentRoot();
        const id = await readIdentity();
        if (id)
            this.nodeName = id.nodeName;
        await this.loadSessionsCatalog();
        await this.reconcileWithTmux();
        const sockPath = paths().socket;
        await this.removeStaleSocket(sockPath);
        this.server = createServer((socket) => this.onConnection(socket));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(sockPath, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        await fs.chmod(sockPath, 0o600).catch(() => { });
        this.log(`nagentd listening on ${sockPath} (node=${this.nodeName})`);
    }
    async stop() {
        for (const c of this.clients) {
            try {
                c.socket.destroy();
            }
            catch { }
        }
        this.clients.clear();
        await new Promise((resolve) => {
            this.server?.close(() => resolve());
        });
        this.server = null;
    }
    get nodeId() {
        return this.nodeName;
    }
    async removeStaleSocket(path) {
        try {
            await fs.unlink(path);
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    async loadSessionsCatalog() {
        const raw = await readJson(paths().sessions);
        this.sessions.clear();
        if (raw) {
            for (const s of raw)
                this.sessions.set(s.name, s);
        }
    }
    async persistSessions() {
        await writeJson(paths().sessions, [...this.sessions.values()]);
    }
    async reconcileWithTmux() {
        const live = await listTmuxSessions();
        for (const [name, meta] of this.sessions) {
            if (!live.has(`s-${meta.sessionId}`))
                this.sessions.delete(name);
        }
        await this.persistSessions();
    }
    onConnection(socket) {
        const state = {
            socket,
            decoder: new FrameDecoder(),
            subscriptions: [],
            queue: [],
            draining: false,
            droppedCount: 0,
            dropAnnounced: false,
        };
        this.clients.add(state);
        socket.on("data", (chunk) => {
            try {
                for (const frame of state.decoder.push(chunk)) {
                    this.handleFrame(state, frame).catch((err) => {
                        this.log(`handler error: ${err.message}`);
                        this.sendFrame(state, { verb: "ERROR", message: err.message });
                    });
                }
            }
            catch (err) {
                this.sendFrame(state, { verb: "ERROR", message: err.message });
                socket.destroy();
            }
        });
        socket.on("close", () => { this.clients.delete(state); });
        socket.on("error", () => { this.clients.delete(state); });
    }
    async handleFrame(state, frame) {
        switch (frame.verb) {
            case "HELLO":
                state.hello = frame;
                this.sendFrame(state, { verb: "OK" });
                return;
            case "SUBSCRIBE":
                if (!state.subscriptions.includes(frame.pattern)) {
                    state.subscriptions.push(frame.pattern);
                }
                this.sendFrame(state, { verb: "OK", echo: { subscribed: frame.pattern } });
                return;
            case "SEND":
                await this.handleSend(state, frame);
                return;
            case "LIST": {
                // Reconcile against tmux so stale catalog entries (e.g. user typed
                // `exit` in the pane and tmux killed the session) don't appear.
                await this.reconcileWithTmux();
                const result = this.listSessions(frame.filter);
                this.sendFrame(state, { verb: "LIST_RESULT", sessions: result });
                return;
            }
            case "REGISTER_ROLE": {
                const session = this.sessions.get(frame.session);
                if (!session) {
                    this.sendFrame(state, { verb: "ERROR", message: `unknown session: ${frame.session}` });
                    return;
                }
                if (!session.roles.includes(frame.role))
                    session.roles.push(frame.role);
                await this.persistSessions();
                this.sendFrame(state, { verb: "OK", echo: { session: session.name, roles: session.roles } });
                return;
            }
            case "CREATE_SESSION": {
                if (this.sessions.has(frame.name)) {
                    this.sendFrame(state, { verb: "ERROR", message: `session "${frame.name}" already exists` });
                    return;
                }
                const sessionId = randomUUID().slice(0, 8);
                const meta = {
                    sessionId,
                    name: frame.name,
                    ...(frame.projectId ? { projectId: frame.projectId } : {}),
                    createdAt: new Date().toISOString(),
                    roles: [],
                };
                this.sessions.set(frame.name, meta);
                await this.persistSessions();
                this.sendFrame(state, { verb: "SESSION_CREATED", session: meta });
                return;
            }
            case "CLOSE_SESSION": {
                // Reconcile first so "already closed via tmux" reports a clear "unknown
                // session" rather than killing a phantom and pretending it worked.
                await this.reconcileWithTmux();
                const session = this.sessions.get(frame.name);
                if (!session) {
                    this.sendFrame(state, { verb: "ERROR", message: `unknown session: ${frame.name}` });
                    return;
                }
                await killTmuxSession(`s-${session.sessionId}`);
                this.sessions.delete(frame.name);
                await this.persistSessions();
                this.sendFrame(state, { verb: "SESSION_CLOSED", name: frame.name });
                return;
            }
            default:
                this.sendFrame(state, { verb: "ERROR", message: `unsupported verb: ${frame.verb}` });
        }
    }
    async handleSend(state, frame) {
        const fromNode = state.hello?.node ?? this.nodeName;
        const fromSession = state.hello?.session ?? "cli";
        const fromAddr = `${fromNode}/${fromSession}`;
        let delivered = 0;
        for (const target of this.clients) {
            if (!target.hello)
                continue;
            // Build the subscriber's identity context.
            const ctx = {
                node: target.hello.node,
                ...(target.hello.session ? { session: target.hello.session } : {}),
                roles: this.rolesFor(target.hello.session),
            };
            // Match rule:
            //   1. SEND's `to` (as a pattern) matches subscriber's identity, OR
            //   2. SEND's `to` (as a string) equals one of the subscriber's explicit subscriptions.
            const matchedByIdentity = !!target.hello.session && matches(frame.to, ctx);
            const matchedBySubscription = target.subscriptions.includes(frame.to);
            if (!matchedByIdentity && !matchedBySubscription)
                continue;
            const recv = {
                verb: "RECV",
                from: fromAddr,
                payload: frame.payload,
                msgId: frame.msgId,
                ...(frame.replyTo ? { inReplyTo: frame.replyTo } : {}),
            };
            this.enqueue(target, recv);
            delivered++;
        }
        if (delivered === 0) {
            this.log(`bus: dropped SEND to ${frame.to} (no subscriber)`);
        }
        this.sendFrame(state, { verb: "ACK", msgId: frame.msgId });
    }
    rolesFor(sessionName) {
        if (!sessionName)
            return new Set();
        const session = this.sessions.get(sessionName);
        return new Set(session?.roles ?? []);
    }
    enqueue(target, frame) {
        if (target.queue.length >= QUEUE_LIMIT) {
            target.queue.shift();
            target.droppedCount++;
            if (!target.dropAnnounced) {
                target.dropAnnounced = true;
                target.queue.push({
                    verb: "RECV_DROPPED",
                    reason: "queue-overflow",
                    dropped: target.droppedCount,
                });
            }
        }
        target.queue.push(frame);
        this.drainQueue(target);
    }
    drainQueue(target) {
        if (target.draining)
            return;
        target.draining = true;
        const writeNext = () => {
            if (!target.queue.length) {
                target.draining = false;
                target.dropAnnounced = false;
                target.droppedCount = 0;
                return;
            }
            const frame = target.queue.shift();
            const ok = target.socket.write(encodeFrame(frame));
            if (ok) {
                setImmediate(writeNext);
            }
            else {
                target.socket.once("drain", writeNext);
            }
        };
        writeNext();
    }
    listSessions(filter) {
        const out = [];
        for (const meta of this.sessions.values()) {
            if (filter?.project && meta.projectId !== filter.project)
                continue;
            const attached = this.countAttached(meta.name);
            out.push({
                name: meta.name,
                sessionId: meta.sessionId,
                address: `${this.nodeName}/${meta.name}`,
                ...(meta.projectId ? { project: meta.projectId } : {}),
                attached,
                roles: meta.roles,
                createdAt: meta.createdAt,
            });
        }
        return out;
    }
    countAttached(sessionName) {
        let n = 0;
        for (const c of this.clients) {
            if (c.hello?.session === sessionName && !c.hello?.asCli)
                n++;
        }
        return n;
    }
    sendFrame(state, frame) {
        try {
            state.socket.write(encodeFrame(frame));
        }
        catch {
            /* socket may have closed */
        }
    }
}
async function listTmuxSessions() {
    return new Promise((resolve) => {
        const proc = spawn("tmux", ["-L", TMUX_SOCKET_NAME, "ls", "-F", "#S"], {
            stdio: ["ignore", "pipe", "ignore"],
        });
        let buf = "";
        proc.stdout?.on("data", (d) => (buf += d.toString("utf8")));
        proc.on("close", () => {
            const lines = buf.split("\n").map((l) => l.trim()).filter(Boolean);
            resolve(new Set(lines));
        });
        proc.on("error", () => resolve(new Set()));
    });
}
async function killTmuxSession(name) {
    return new Promise((resolve) => {
        const proc = spawn("tmux", ["-L", TMUX_SOCKET_NAME, "kill-session", "-t", name], { stdio: "ignore" });
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
    });
}
export async function runDaemon(opts) {
    const daemon = new Daemon(opts);
    await daemon.start();
    return new Promise((resolve) => {
        let stopping = false;
        const stop = async (sig) => {
            if (stopping)
                return;
            stopping = true;
            process.stderr.write(`nagentd: ${sig} received, shutting down\n`);
            await daemon.stop();
            resolve();
        };
        process.on("SIGINT", () => stop("SIGINT"));
        process.on("SIGTERM", () => stop("SIGTERM"));
    });
}
//# sourceMappingURL=index.js.map