import { promises as fs, existsSync } from "node:fs";
import { DEFAULT_BIND, DEFAULT_PORT, runHub } from "../web/index.js";
import { paths } from "../platform/paths.js";
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
//# sourceMappingURL=web.js.map