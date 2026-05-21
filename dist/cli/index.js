#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureNagentRoot, readActiveState, readIdentity, } from "../store/index.js";
import { paths } from "../platform/paths.js";
import { BusClient } from "../bus/client.js";
import { runDaemon } from "../daemon/index.js";
import { findProjectMarker } from "../project/index.js";
import { checkTmuxVersion, createOrAttachTmuxSession, attachTmuxSession, tmuxSessionName, } from "../session/index.js";
import { runPicker } from "./picker.js";
import { bootstrap } from "./bootstrap.js";
import { cmdJoin, cmdJoinRespond } from "./join.js";
import { cmdGossipAddPeer } from "./gossip.js";
import { attachLine, attachMosh } from "./attach_modes.js";
import { cmdAttachLineServer } from "./attach_line_server.js";
import { cmdWebServe } from "./web.js";
import { shellSingleQuote } from "../lib/shell.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
function readPackageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
        return pkg.version;
    }
    catch {
        return "0.0.0-unknown";
    }
}
async function loadContext() {
    await ensureNagentRoot();
    const identity = await readIdentity();
    const active = await readActiveState();
    const cwdProject = await findProjectMarker(process.cwd());
    return {
        identity,
        ...(active.activeNetId ? { activeNetId: active.activeNetId } : {}),
        ...(active.activeProjectId ? { activeProjectId: active.activeProjectId } : {}),
        cwdProject,
    };
}
function activeProjectIdFromCtx(ctx, cliOpts) {
    if (cliOpts.project === false)
        return undefined;
    if (typeof cliOpts.project === "string")
        return cliOpts.project;
    if (ctx.cwdProject)
        return ctx.cwdProject.marker.projectId;
    if (ctx.activeProjectId)
        return ctx.activeProjectId;
    return undefined;
}
async function withDaemon(fn) {
    const client = new BusClient();
    try {
        await client.connect();
    }
    catch (err) {
        const e = err;
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
            throw new Error(`cannot reach nagentd on ${paths().socket}`);
        }
        throw err;
    }
    try {
        return await fn(client);
    }
    finally {
        client.close();
    }
}
async function sendHelloAsCli(client, ctx) {
    const hello = {
        verb: "HELLO",
        node: ctx.identity?.nodeName ?? "node",
        asCli: true,
        ...(process.env.NAGENT_SESSION ? { session: process.env.NAGENT_SESSION } : {}),
        ...(process.env.NAGENT_PROJECT ? { project: process.env.NAGENT_PROJECT } : {}),
    };
    const r = await client.request(hello);
    if (r.verb !== "OK")
        throw new Error(`HELLO failed: ${r.message ?? r.verb}`);
}
async function sendHelloAsSession(client, sessionName, projectId, ctx) {
    const hello = {
        verb: "HELLO",
        node: ctx.identity?.nodeName ?? "node",
        session: sessionName,
        asCli: false,
        ...(projectId ? { project: projectId } : {}),
    };
    const r = await client.request(hello);
    if (r.verb !== "OK")
        throw new Error(`HELLO failed: ${r.message ?? r.verb}`);
}
// ----- commands -----
async function cmdNew(name, opts) {
    const tmuxOk = checkTmuxVersion();
    if (!tmuxOk.ok)
        throw new Error(`tmux check failed: ${tmuxOk.reason}`);
    const ctx = await loadContext();
    const projectId = activeProjectIdFromCtx(ctx, opts);
    const meta = await withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const created = await client.request({ verb: "CREATE_SESSION", name, ...(projectId ? { projectId } : {}) });
        if (created.verb === "ERROR")
            throw new Error(created.message);
        if (created.verb !== "SESSION_CREATED")
            throw new Error(`unexpected response: ${created.verb}`);
        return created.session;
    });
    process.stdout.write(`created session "${meta.name}" (${meta.sessionId})${projectId ? ` in project ${projectId}` : ""}\n`);
    if (opts.attach !== false) {
        process.stdout.write(`detach: Ctrl-Q (or Ctrl-B d)   destroy: \`exit\` or \`nagent close\`\n`);
    }
    createOrAttachTmuxSession({
        sessionId: meta.sessionId,
        sessionDisplayName: meta.name,
        nodeName: ctx.identity?.nodeName ?? "node",
        ...(projectId ? { projectId } : {}),
        attach: opts.attach !== false,
    });
}
async function cmdAttach(name, opts) {
    // Cross-node form: `nagent attach <peer>/<session>` → SSH-exec the remote nagent.
    const slash = name.indexOf("/");
    if (slash > 0) {
        const peer = name.slice(0, slash);
        const sess = name.slice(slash + 1);
        if (!peer || !sess)
            throw new Error(`attach target needs both peer and session: ${name}`);
        if (opts.line && opts.mosh)
            throw new Error("--line and --mosh are mutually exclusive");
        await attachRemote(peer, sess, opts);
        return;
    }
    if (opts.line || opts.mosh) {
        throw new Error("--line / --mosh require a `<peer>/<session>` target");
    }
    const ctx = await loadContext();
    const entry = await withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const r = await client.request({ verb: "LIST", filter: { all: true } });
        if (r.verb !== "LIST_RESULT")
            throw new Error("LIST failed");
        const found = r.sessions.find((s) => s.name === name);
        if (!found)
            throw new Error(`unknown session: ${name}`);
        return found;
    });
    attachTmuxSession(tmuxSessionName(entry.sessionId));
}
async function attachRemote(peer, sess, opts) {
    const ctx = await loadContext();
    if (!ctx.activeNetId)
        throw new Error("no active net");
    const peers = (await import("../store/index.js")).readPeers;
    const list = await peers(ctx.activeNetId);
    const target = list.find((p) => p.nodeName === peer);
    if (!target)
        throw new Error(`unknown peer: ${peer} (peers: ${list.map((p) => p.nodeName).join(", ")})`);
    const sshHost = `nagent.${peer}`;
    if (opts.mosh) {
        await attachMosh(sshHost, sess);
        return; // attachMosh execs / exits
    }
    if (opts.line) {
        await attachLine(sshHost, sess);
        return; // attachLine never resolves; exits on remote exit
    }
    // Default mode (v0.2 behavior): ssh -t with PTY, remote runs `nagent attach`.
    const innerCmd = `nagent attach ${shellSingleQuote(sess)}`;
    const remoteCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("ssh", ["-t", sshHost, "--", remoteCmd], { stdio: "inherit" });
    process.exit(r.status ?? 0);
}
async function cmdList(opts) {
    const ctx = await loadContext();
    const projectId = opts.all ? undefined : activeProjectIdFromCtx(ctx, opts);
    const localSessions = await listLocalSessions(ctx, projectId, opts.all);
    // --local (or no active net): print only local sessions, in v0.2's table
    // shape. Used both by humans and by the fanout-RPC on each peer.
    if (opts.local || !ctx.activeNetId) {
        if (opts.json) {
            const nodeName = ctx.identity?.nodeName ?? "node";
            process.stdout.write(JSON.stringify({ v: 1, node: nodeName, sessions: localSessions }) + "\n");
            return;
        }
        printSessionsTable(localSessions, { withNode: false });
        return;
    }
    // Net-wide path: keep local rows + fan out to peers.
    const { fanoutSessionsAcrossNet } = await import("./list_net.js");
    const merged = await fanoutSessionsAcrossNet({
        activeNetId: ctx.activeNetId,
        selfNodeName: ctx.identity?.nodeName ?? "node",
        localSessions,
        projectFilter: projectId,
        includeAll: !!opts.all,
    });
    if (opts.json) {
        process.stdout.write(JSON.stringify({ v: 1, rows: merged.rows, unreachable: merged.unreachable }) + "\n");
        return;
    }
    printNetTable(merged.rows, merged.unreachable);
}
async function listLocalSessions(ctx, projectId, includeAll) {
    return withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const r = await client.request({ verb: "LIST", filter: projectId ? { project: projectId } : { all: !!includeAll } });
        if (r.verb !== "LIST_RESULT")
            throw new Error("LIST failed");
        return r.sessions;
    });
}
function printSessionsTable(sessions, opts) {
    if (sessions.length === 0) {
        process.stdout.write("(no sessions)\n");
        return;
    }
    const widths = {
        name: Math.max(4, ...sessions.map((s) => s.name.length)),
        addr: Math.max(7, ...sessions.map((s) => s.address.length)),
        proj: Math.max(7, ...sessions.map((s) => (s.project ?? "-").length)),
    };
    const nodeCol = opts.withNode ? "NODE                  " : "";
    process.stdout.write(`${nodeCol}${"NAME".padEnd(widths.name)}  ${"ADDRESS".padEnd(widths.addr)}  ${"PROJECT".padEnd(widths.proj)}  ATT  ROLES\n`);
    for (const s of sessions) {
        const roles = s.roles.length ? s.roles.join(",") : "-";
        process.stdout.write(`${s.name.padEnd(widths.name)}  ${s.address.padEnd(widths.addr)}  ${(s.project ?? "-").padEnd(widths.proj)}  ${String(s.attached).padStart(3)}  ${roles}\n`);
    }
}
function printNetTable(rows, unreachable) {
    if (rows.length === 0 && unreachable.length === 0) {
        process.stdout.write("(no sessions)\n");
        return;
    }
    const nodeWidth = Math.max(4, ...rows.map((r) => r.node.length), ...unreachable.map((n) => n.length));
    const nameWidth = Math.max(4, ...rows.map((r) => r.session.name.length));
    const addrWidth = Math.max(7, ...rows.map((r) => r.session.address.length));
    const projWidth = Math.max(7, ...rows.map((r) => (r.session.project ?? "-").length));
    process.stdout.write(`${"NODE".padEnd(nodeWidth)}  ${"NAME".padEnd(nameWidth)}  ${"ADDRESS".padEnd(addrWidth)}  ${"PROJECT".padEnd(projWidth)}  ATT  ROLES\n`);
    for (const { node, session: s } of rows) {
        const roles = s.roles.length ? s.roles.join(",") : "-";
        process.stdout.write(`${node.padEnd(nodeWidth)}  ${s.name.padEnd(nameWidth)}  ${s.address.padEnd(addrWidth)}  ${(s.project ?? "-").padEnd(projWidth)}  ${String(s.attached).padStart(3)}  ${roles}\n`);
    }
    for (const node of unreachable) {
        process.stdout.write(`${node.padEnd(nodeWidth)}  (unreachable)\n`);
    }
}
async function cmdClose(name) {
    const ctx = await loadContext();
    const target = name ?? process.env.NAGENT_SESSION;
    if (!target)
        throw new Error("`nagent close` from outside a session needs an explicit <name>");
    await withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const r = await client.request({ verb: "CLOSE_SESSION", name: target });
        if (r.verb === "ERROR")
            throw new Error(r.message);
    });
    process.stdout.write(`closed session "${target}"\n`);
}
async function cmdSend(addr, payload) {
    const ctx = await loadContext();
    let body;
    if (payload === undefined) {
        const raw = await readStdin();
        body = tryParseJson(raw);
    }
    else {
        body = tryParseJson(payload);
    }
    const msgId = randomUUID();
    await withDaemon(async (client) => {
        if (process.env.NAGENT_SESSION) {
            await sendHelloAsSession(client, process.env.NAGENT_SESSION, process.env.NAGENT_PROJECT, ctx);
        }
        else {
            await sendHelloAsCli(client, ctx);
        }
        const r = await client.request({
            verb: "SEND",
            to: addr,
            payload: body,
            msgId,
            hops: 0,
        });
        if (r.verb === "ERROR")
            throw new Error(r.message);
        if (r.verb !== "ACK")
            throw new Error(`unexpected response: ${r.verb}`);
    });
    process.stdout.write(`sent (${msgId}) to ${addr}\n`);
}
async function cmdRecv(opts) {
    const ctx = await loadContext();
    const limit = opts.count ? parseInt(opts.count, 10) : Infinity;
    const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) : 0;
    let received = 0;
    const client = new BusClient();
    await client.connect();
    try {
        if (process.env.NAGENT_SESSION) {
            await sendHelloAsSession(client, process.env.NAGENT_SESSION, process.env.NAGENT_PROJECT, ctx);
        }
        else {
            await sendHelloAsCli(client, ctx);
        }
        if (opts.subscribe) {
            const r = await client.request({ verb: "SUBSCRIBE", pattern: opts.subscribe });
            if (r.verb !== "OK")
                throw new Error(`SUBSCRIBE failed: ${r.verb}`);
        }
        await new Promise((resolve) => {
            const timer = timeoutMs > 0 ? setTimeout(() => resolve(), timeoutMs) : null;
            client.on("frame", (frame) => {
                if (frame.verb === "RECV" || frame.verb === "RECV_DROPPED") {
                    process.stdout.write(JSON.stringify(frame) + "\n");
                    received++;
                    if (received >= limit) {
                        if (timer)
                            clearTimeout(timer);
                        resolve();
                    }
                }
            });
            client.on("close", () => resolve());
        });
    }
    finally {
        client.close();
    }
}
async function cmdRegisterRole(role) {
    const ctx = await loadContext();
    const session = process.env.NAGENT_SESSION;
    if (!session)
        throw new Error("`nagent register-role` must be run inside a session (NAGENT_SESSION not set)");
    await withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const r = await client.request({ verb: "REGISTER_ROLE", session, role });
        if (r.verb === "ERROR")
            throw new Error(r.message);
    });
    process.stdout.write(`registered role "${role}" on session ${session}\n`);
}
async function cmdDaemon(opts) {
    if (!opts.foreground) {
        process.stderr.write("background daemon mode is not implemented; use --foreground\n");
        process.exit(2);
    }
    await runDaemon({ foreground: true });
}
async function cmdPickerEntry() {
    if (process.env.NAGENT_SESSION) {
        process.stderr.write(`you're attached to ${process.env.NAGENT_NODE ?? "?"}/${process.env.NAGENT_SESSION}; ` +
            `Ctrl-B d to detach, \`nagent close\` to destroy\n`);
        process.exit(1);
    }
    const ctx = await loadContext();
    await runPicker({ ctx });
}
// ----- helpers -----
async function readStdin() {
    if (process.stdin.isTTY)
        return "";
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
}
function tryParseJson(s) {
    if (!s)
        return null;
    try {
        return JSON.parse(s);
    }
    catch {
        return s;
    }
}
/**
 * Wrap an action with auto-bootstrap. Used by every subcommand except `daemon`,
 * which manages its own lifecycle.
 */
function bootstrapped(fn) {
    return async (...args) => {
        await bootstrap();
        return fn(...args);
    };
}
// ----- main -----
async function main() {
    const program = new Command();
    program
        .name("nagent")
        .description("agent net — decentralized mesh for cooperating agents (v0.1: single-node)")
        .version(readPackageVersion());
    program.action(bootstrapped(async () => {
        await cmdPickerEntry();
    }));
    program
        .command("daemon")
        .description("run nagentd (use --foreground for log visibility; auto-spawned otherwise)")
        .option("--foreground", "run in the foreground")
        .action(async (opts) => {
        // The daemon command must not auto-spawn another daemon.
        process.env.NAGENT_NO_BOOTSTRAP = "1";
        await ensureNagentRoot();
        await cmdDaemon(opts);
    });
    program
        .command("new <name>")
        .description("create a session and attach")
        .option("--no-attach", "create but don't attach (useful in scripts)")
        .option("-p, --project <id>", "tag with a specific project")
        .option("--no-project", "do not tag with a project")
        .action(bootstrapped(async (name, opts) => {
        await cmdNew(name, opts);
    }));
    program
        .command("attach <name>")
        .description("attach to an existing session (local NAME or <peer>/<session>)")
        .option("--line", "[v0.3] line-buffered shell — no per-keystroke RTT, no TUI support")
        .option("--mosh", "[v0.3] use mosh transport — predictive local echo (requires mosh on both ends)")
        .action(bootstrapped(async (name, opts) => { await cmdAttach(name, opts); }));
    // Internal — server side of `attach … --line`. Reads command lines from
    // stdin and forwards them to tmux send-keys; streams pane output to stdout.
    const attachLineCmd = program
        .command("attach-line <session>")
        .description("(internal) line-buffered attach server: stdin → tmux send-keys, pane → stdout")
        .action(bootstrapped(async (session) => { await cmdAttachLineServer(session); }));
    attachLineCmd._hidden = true;
    const listCmd = program
        .command("list")
        .alias("ls")
        .description("list sessions across the active net (use --local for v0.2 behavior)")
        .option("-p, --project <id>", "filter by project")
        .option("-a, --all", "show all projects")
        .option("--local", "list only sessions on this node (no peer fanout)")
        .option("--json", "machine-readable output (one JSON object on stdout)")
        .action(bootstrapped(async (opts) => { await cmdList(opts); }));
    void listCmd;
    program
        .command("close [name]")
        .description("close a session (default: current session)")
        .action(bootstrapped(async (name) => { await cmdClose(name); }));
    program
        .command("send <addr> [payload]")
        .description("send a message on the bus (payload from stdin if omitted)")
        .action(bootstrapped(async (addr, payload) => { await cmdSend(addr, payload); }));
    program
        .command("recv")
        .description("receive bus messages (blocks unless --count or --timeout)")
        .option("-s, --subscribe <pattern>", "additional address pattern to receive on")
        .option("-t, --timeout <ms>", "stop after N ms")
        .option("-n, --count <n>", "stop after N frames")
        .action(bootstrapped(async (opts) => { await cmdRecv(opts); }));
    program
        .command("register-role <role>")
        .description("tag the current session with a role (e.g. agent-alpha)")
        .action(bootstrapped(async (role) => { await cmdRegisterRole(role); }));
    program
        .command("join <token>")
        .description("join an existing net via an invite token")
        .action(bootstrapped(async (token) => { await cmdJoin(token); }));
    const webCmd = program.command("web").description("[v0.4] browser access to mesh sessions (nagent-web hub)");
    webCmd
        .command("serve")
        .description("start the nagent-web hub on this node (HTTPS, self-signed cert)")
        .option("--port <port>", "TCP port to listen on (default 4443; 0 = random)")
        .option("--bind <addr>", "bind address (default 0.0.0.0)")
        .action(bootstrapped(async (opts) => { await cmdWebServe(opts); }));
    // Internal — only invoked via SSH `command=` restriction during a join.
    // Marked hidden so it doesn't appear in --help noise.
    const joinRespondCmd = program
        .command("join-respond <inviteId>")
        .description("(internal) handle an inbound join redemption from stdin")
        .action(async (inviteId) => {
        process.env.NAGENT_NO_BOOTSTRAP = "1";
        await cmdJoinRespond(inviteId);
    });
    // commander v14 doesn't expose `hidden` in chained form; flip the flag directly.
    joinRespondCmd._hidden = true;
    // Internal — receives signed gossip-add-peer payloads on stdin from any
    // already-trusted peer (used by the issuer's post-redeem fanout and by
    // daemon-startup heal passes). Pure file mutation; never spawns a daemon.
    const gossipCmd = program
        .command("gossip-add-peer")
        .description("(internal) handle an inbound mesh-trust gossip from stdin")
        .action(async () => {
        process.env.NAGENT_NO_BOOTSTRAP = "1";
        await cmdGossipAddPeer();
    });
    gossipCmd._hidden = true;
    try {
        await program.parseAsync(process.argv);
    }
    catch (err) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(1);
    }
}
main().catch((err) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map