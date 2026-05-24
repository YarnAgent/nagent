import { promises as fs, existsSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { hostname } from "node:os";
import { DEFAULT_BIND, DEFAULT_PORT, loadOrGenerateWebConfig, mintToken, runHub, } from "../web/index.js";
import { paths } from "../platform/paths.js";
import { readIdentity } from "../store/index.js";
/**
 * `nagent web serve` — start the nagent-web hub. Idempotent: if a hub is
 * already running (per pidfile), prints its URL and exits 0 instead of
 * starting a second one.
 *
 * Runs in the foreground for now (background daemonization is a v0.4.1
 * polish — same story as `nagent daemon`).
 */
export async function cmdWebServe(opts) {
    const port = opts.port ? Number.parseInt(opts.port, 10) : DEFAULT_PORT;
    const bind = opts.bind ?? DEFAULT_BIND;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port: ${opts.port}`);
    }
    const existing = await readRunningHubPidfile();
    if (existing && processIsAlive(existing.pid)) {
        process.stdout.write(`web: hub already running (pid ${existing.pid}, port ${existing.port})\n` +
            `     URL: https://<this-node>:${existing.port}/\n`);
        return;
    }
    const hub = await runHub({
        port,
        bind,
        log: (line) => process.stderr.write(line + "\n"),
    });
    process.stdout.write(`nagent-web: ready\n` +
        `  URL:          ${hub.url}\n` +
        `  fingerprint:  ${hub.fingerprint}\n` +
        `  pin on a client:  nagent web trust ${hub.url}\n`);
    const shutdown = async (sig) => {
        process.stderr.write(`\nweb: received ${sig}, shutting down…\n`);
        await hub.stop();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
async function readRunningHubPidfile() {
    const path = paths().webPid;
    if (!existsSync(path))
        return null;
    try {
        const raw = await fs.readFile(path, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// ----- `nagent web stop` -----
export async function cmdWebStop() {
    const rec = await readRunningHubPidfile();
    if (!rec) {
        process.stdout.write("web: no hub running\n");
        return;
    }
    if (!processIsAlive(rec.pid)) {
        process.stdout.write(`web: stale pidfile (pid ${rec.pid} not running) — cleaning up\n`);
        await fs.unlink(paths().webPid).catch(() => undefined);
        return;
    }
    try {
        process.kill(rec.pid, "SIGTERM");
        process.stdout.write(`web: stopped hub (pid ${rec.pid})\n`);
    }
    catch (err) {
        throw new Error(`failed to stop hub pid ${rec.pid}: ${err.message}`);
    }
}
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export async function cmdWebToken(opts) {
    if (!opts.session || !opts.session.includes("/")) {
        throw new Error("usage: nagent web token --session <node>/<session> [--expires 1h] [--readonly]");
    }
    const [node, session] = splitOnce(opts.session, "/");
    if (!node || !session)
        throw new Error(`invalid --session: ${opts.session}`);
    const ttlMs = parseTtl(opts.expires) ?? DEFAULT_TOKEN_TTL_MS;
    const now = Date.now();
    const config = await loadOrGenerateWebConfig();
    const token = mintToken({ node, session, iat: now, exp: now + ttlMs, ro: !!opts.readonly }, config.hmacSecret);
    // Build the URL using the hub's known port (from pidfile) if available;
    // otherwise just print the path so the user can prepend their own hostname.
    const rec = await readRunningHubPidfile();
    const identity = await readIdentity();
    const advertisedHost = identity?.nodeName ?? hostname() ?? "localhost";
    const port = rec?.port ?? DEFAULT_PORT;
    const url = `https://${advertisedHost}:${port}/s/${encodeURIComponent(node)}/${encodeURIComponent(session)}?t=${token}`;
    process.stdout.write(url + "\n");
}
function splitOnce(s, sep) {
    const i = s.indexOf(sep);
    if (i < 0)
        return [s, ""];
    return [s.slice(0, i), s.slice(i + sep.length)];
}
function parseTtl(input) {
    if (!input)
        return undefined;
    const m = /^(\d+)([smhd])?$/.exec(input);
    if (!m)
        throw new Error(`bad --expires: ${input} (use 30s / 5m / 1h / 7d)`);
    const n = Number.parseInt(m[1], 10);
    const unit = m[2] ?? "s";
    const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return n * mult;
}
export async function cmdWebTrust(opts) {
    if (!opts.hubUrl)
        throw new Error("usage: nagent web trust <hub-url>");
    const u = new URL(opts.hubUrl);
    if (u.protocol !== "https:")
        throw new Error(`hub URL must be https:// (got ${u.protocol})`);
    const host = u.hostname;
    const port = u.port ? Number.parseInt(u.port, 10) : 4443;
    const fingerprint = await fetchCertFingerprint(host, port);
    process.stdout.write(`hub:           ${opts.hubUrl}\n`);
    process.stdout.write(`fingerprint:   ${fingerprint}\n`);
    if (!opts.yes && process.stdin.isTTY) {
        process.stdout.write(`Pin this fingerprint? Confirm 'y' and press enter: `);
        const ans = await readOneLine();
        if (ans.trim().toLowerCase() !== "y") {
            process.stdout.write("aborted (no pinning).\n");
            return;
        }
    }
    await fs.mkdir(paths().webDir, { recursive: true, mode: 0o700 });
    const path = paths().webKnownHubs;
    let store;
    try {
        store = JSON.parse(await fs.readFile(path, "utf8"));
        if (store.v !== 1 || typeof store.hubs !== "object")
            throw new Error("bad known_hubs.json");
    }
    catch {
        store = { v: 1, hubs: {} };
    }
    store.hubs[opts.hubUrl] = { fingerprint, pinnedAt: new Date().toISOString() };
    await fs.writeFile(path, JSON.stringify(store, null, 2), { mode: 0o600 });
    process.stdout.write(`pinned. (${path})\n`);
    process.stdout.write(`\nopen ${opts.hubUrl} in your browser. Your browser will warn about the self-signed cert the first time — confirm the fingerprint above matches what the browser shows, then accept.\n`);
}
async function fetchCertFingerprint(host, port) {
    return await new Promise((resolve, reject) => {
        const socket = tlsConnect({ host, port, rejectUnauthorized: false, servername: host }, () => {
            const peer = socket.getPeerCertificate(true);
            const fp = peer.fingerprint256;
            socket.end();
            if (!fp)
                reject(new Error("no peer cert fingerprint"));
            else
                resolve(fp);
        });
        socket.once("error", reject);
        socket.setTimeout(5_000, () => {
            socket.destroy(new Error("tls connect timeout"));
        });
    });
}
async function readOneLine() {
    return new Promise((resolve) => {
        process.stdin.setEncoding("utf8");
        let buf = "";
        const onData = (chunk) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
                process.stdin.off("data", onData);
                process.stdin.pause();
                resolve(buf.slice(0, nl));
            }
        };
        process.stdin.on("data", onData);
        process.stdin.resume();
    });
}
//# sourceMappingURL=web.js.map