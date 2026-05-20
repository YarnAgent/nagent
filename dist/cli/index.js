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
async function cmdAttach(name) {
    // Cross-node form: `nagent attach <peer>/<session>` → SSH-exec the remote nagent.
    const slash = name.indexOf("/");
    if (slash > 0) {
        const peer = name.slice(0, slash);
        const sess = name.slice(slash + 1);
        if (!peer || !sess)
            throw new Error(`attach target needs both peer and session: ${name}`);
        await attachRemote(peer, sess);
        return;
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
async function attachRemote(peer, sess) {
    const ctx = await loadContext();
    if (!ctx.activeNetId)
        throw new Error("no active net");
    const peers = (await import("../store/index.js")).readPeers;
    const list = await peers(ctx.activeNetId);
    const target = list.find((p) => p.nodeName === peer);
    if (!target)
        throw new Error(`unknown peer: ${peer} (peers: ${list.map((p) => p.nodeName).join(", ")})`);
    // The ssh_config entry `Host nagent.<peer>` is the source of truth for host/user/identity.
    // SSH joins all post-host args with spaces into a single command string the
    // remote login shell re-parses, so we do our own quoting. We invoke through
    // `bash -ilc` (interactive + login) because most nvm/mise/volta setups guard
    // their bashrc with `[ -z "$PS1" ] && return` — only an interactive shell will
    // actually source the version-manager and put `nagent` on PATH.
    const innerCmd = `nagent attach ${shellSingleQuote(sess)}`;
    const remoteCmd = `bash -ilc ${shellSingleQuote(innerCmd)}`;
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("ssh", ["-t", `nagent.${peer}`, "--", remoteCmd], { stdio: "inherit" });
    process.exit(r.status ?? 0);
}
function shellSingleQuote(s) {
    if (/^[A-Za-z0-9_.-]+$/.test(s))
        return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
async function cmdList(opts) {
    const ctx = await loadContext();
    const projectId = opts.all ? undefined : activeProjectIdFromCtx(ctx, opts);
    await withDaemon(async (client) => {
        await sendHelloAsCli(client, ctx);
        const r = await client.request({ verb: "LIST", filter: projectId ? { project: projectId } : { all: !!opts.all } });
        if (r.verb !== "LIST_RESULT")
            throw new Error("LIST failed");
        const sessions = r.sessions;
        if (sessions.length === 0) {
            process.stdout.write("(no sessions)\n");
            return;
        }
        const widths = {
            name: Math.max(4, ...sessions.map((s) => s.name.length)),
            addr: Math.max(7, ...sessions.map((s) => s.address.length)),
            proj: Math.max(7, ...sessions.map((s) => (s.project ?? "-").length)),
        };
        process.stdout.write(`${"NAME".padEnd(widths.name)}  ${"ADDRESS".padEnd(widths.addr)}  ${"PROJECT".padEnd(widths.proj)}  ATT  ROLES\n`);
        for (const s of sessions) {
            const roles = s.roles.length ? s.roles.join(",") : "-";
            process.stdout.write(`${s.name.padEnd(widths.name)}  ${s.address.padEnd(widths.addr)}  ${(s.project ?? "-").padEnd(widths.proj)}  ${String(s.attached).padStart(3)}  ${roles}\n`);
        }
    });
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
        .description("attach to an existing session")
        .action(bootstrapped(async (name) => { await cmdAttach(name); }));
    const listCmd = program
        .command("list")
        .alias("ls")
        .description("list sessions")
        .option("-p, --project <id>", "filter by project")
        .option("-a, --all", "show all projects")
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