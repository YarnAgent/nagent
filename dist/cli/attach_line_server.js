import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { tmuxSessionName } from "../session/index.js";
import { paths } from "../platform/paths.js";
import { readActiveState } from "../store/index.js";
import { BusClient } from "../bus/client.js";
const TMUX = "tmux";
const TMUX_SOCKET = "nagent";
/**
 * Server-side counterpart to `nagent attach <peer>/<session> --line` on the
 * caller. Reads command lines from stdin and forwards them to the session's
 * tmux pane via `tmux send-keys`. Streams pane output (via `tmux pipe-pane`)
 * to stdout so the caller can render it above their local readline prompt.
 *
 * Run via the existing SSH peer trust — no constrained command on
 * authorized_keys is needed; the caller invokes us through bash -ilc just
 * like `nagent attach`. Auth = the peer's standing SSH access.
 */
export async function cmdAttachLineServer(sessionName) {
    // Resolve sessionName → sessionId via the local daemon.
    const sessionId = await resolveSessionId(sessionName);
    const target = tmuxSessionName(sessionId);
    // Confirm the tmux session exists on our managed socket.
    const has = spawnSync(TMUX, ["-L", TMUX_SOCKET, "has-session", "-t", target], { stdio: "ignore" });
    if (has.status !== 0) {
        process.stderr.write(`nagent attach-line: tmux session ${target} not found\n`);
        process.exit(1);
    }
    // Per-invocation fifo for pipe-pane output. We put it under
    // `~/.nagent/run/<pid>/` (owned 0700) so other local users can't read the
    // live pane stream and so the daemon's startup orphan-reaper can
    // garbage-collect leaked dirs by pid. Fifo itself is 0600. Issue #3, H4.
    const runDir = join(paths().root, "run", `attach-${process.pid}`);
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    await fs.chmod(runDir, 0o700);
    const fifoPath = join(runDir, "pane.fifo");
    const mk = spawnSync("mkfifo", ["-m", "600", fifoPath]);
    if (mk.status !== 0) {
        process.stderr.write(`nagent attach-line: mkfifo failed: ${mk.stderr.toString()}\n`);
        process.exit(1);
    }
    // Install pipe-pane: tmux writes the pane's terminal output to the fifo as
    // it appears. The `-o` flag toggles, and we pass a fresh command, so any
    // prior pipe-pane on this pane is replaced. We exit() the shell so the cat
    // is reaped if attach-line dies abruptly.
    const ppCmd = `cat > ${shellSingleQuote(fifoPath)}`;
    spawnSync(TMUX, ["-L", TMUX_SOCKET, "pipe-pane", "-t", target, "-o", ppCmd], { stdio: "ignore" });
    // Detect full-screen TUI mode and warn — the caller's readline UI can't
    // render an alternate screen sensibly.
    const altScreen = spawnSync(TMUX, ["-L", TMUX_SOCKET, "display-message", "-p", "-t", target, "#{alternate_on}"], { encoding: "utf8" }).stdout.trim();
    if (altScreen === "1") {
        process.stderr.write("nagent attach-line: warning — the remote pane is in full-screen TUI mode (vim/htop/etc.).\n" +
            "  Output may render incorrectly here. Detach the TUI on the remote, or use plain `nagent attach`.\n");
    }
    // Reader: fifo → stdout. Keep this running for the lifetime of the session.
    const fifoReader = createReadStream(fifoPath, { autoClose: false });
    fifoReader.on("error", () => { });
    fifoReader.pipe(process.stdout, { end: false });
    // Writer: stdin → tmux send-keys.
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
        // `-l` keeps the literal string from being interpreted as tmux key names.
        spawn(TMUX, ["-L", TMUX_SOCKET, "send-keys", "-t", target, "-l", line], { stdio: "ignore" });
        spawn(TMUX, ["-L", TMUX_SOCKET, "send-keys", "-t", target, "Enter"], { stdio: "ignore" });
    });
    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp)
            return;
        cleanedUp = true;
        spawnSync(TMUX, ["-L", TMUX_SOCKET, "pipe-pane", "-t", target], { stdio: "ignore" });
        // Best-effort: rm the per-pid run dir. Daemon-startup orphan reaper
        // (deferred to v0.3.x) will pick up anything we miss.
        try {
            void fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        }
        catch { /* ignore */ }
    };
    // Issue #3, H3: register cleanup on every reasonable exit path. SIGKILL is
    // unrecoverable on our side — the daemon orphan-reaper covers that case.
    process.on("exit", cleanup);
    rl.on("close", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(130); });
    process.on("SIGTERM", () => { cleanup(); process.exit(143); });
    process.on("SIGHUP", () => { cleanup(); process.exit(129); });
    process.on("SIGPIPE", () => { cleanup(); process.exit(141); });
    process.on("uncaughtException", (err) => {
        process.stderr.write(`nagent attach-line: ${err.message}\n`);
        cleanup();
        process.exit(1);
    });
}
/**
 * Resolve a session NAME to its sessionId via the local nagent daemon. We
 * spawn the daemon lazily through the standard bootstrap if it's not
 * running.
 */
async function resolveSessionId(name) {
    const active = await readActiveState();
    const client = new BusClient();
    await client.connect();
    try {
        const hello = { verb: "HELLO", node: "attach-line", asCli: true };
        const ok = await client.request(hello);
        if (ok.verb !== "OK")
            throw new Error(`HELLO failed: ${ok.verb}`);
        const r = await client.request({ verb: "LIST", filter: { all: true } });
        if (r.verb !== "LIST_RESULT")
            throw new Error("LIST failed");
        const sessions = r.sessions;
        const found = sessions.find((s) => s.name === name);
        if (!found) {
            throw new Error(`nagent attach-line: session "${name}" not found on this node` +
                (active.activeNetId ? ` (net=${active.activeNetId})` : ""));
        }
        return found.sessionId;
    }
    finally {
        client.close();
    }
}
function shellSingleQuote(s) {
    if (/^[A-Za-z0-9_.-]+$/.test(s))
        return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
//# sourceMappingURL=attach_line_server.js.map