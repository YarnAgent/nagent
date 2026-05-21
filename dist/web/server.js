import { promises as fs } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { hostname } from "node:os";
import { loadOrGenerateHubCert } from "./cert.js";
import { loadOrGenerateWebConfig } from "./token.js";
import { paths } from "../platform/paths.js";
import { readActiveState, readIdentity, readPeers } from "../store/index.js";
import { fanoutSessionsAcrossNet } from "../cli/list_net.js";
import { BusClient } from "../bus/client.js";
import { currentReachableAddresses } from "../ssh/addresses.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");
export const DEFAULT_PORT = 4443;
export const DEFAULT_BIND = "0.0.0.0";
/**
 * Start the nagent-web hub. Resolves once the server is listening; the
 * returned `stop()` closes the server. The hub generates its self-signed
 * cert on first run; subsequent runs reuse it.
 *
 * The pid file at `~/.nagent/web/hub.pid` is updated atomically so a parallel
 * `nagent web stop` invocation can find this process.
 */
export async function runHub(opts) {
    const { port, bind, log } = opts;
    const identity = await readIdentity();
    const nodeName = identity?.nodeName ?? hostname() ?? "nagent-web";
    // Cert: hostname + every reachable address goes into the SAN so clients
    // hitting any IP / DNS-ish name see at least no name-mismatch error.
    const reachable = currentReachableAddresses().map((a) => a.host);
    const cert = await loadOrGenerateHubCert([nodeName, ...reachable]);
    log(`web: cert ready (fingerprint ${cert.fingerprint})`);
    const config = await loadOrGenerateWebConfig();
    void config; // used later by token + ws bridge
    const server = createHttpsServer({ cert: cert.cert, key: cert.key }, async (req, res) => {
        try {
            await routeHttp(req, res, { nodeName, cert });
        }
        catch (err) {
            log(`web: handler error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain" });
            }
            res.end("internal error");
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const actualPort = server.address().port;
    const url = `https://${nodeName}:${actualPort}`;
    await writePidFile(process.pid, actualPort);
    log(`web: listening on https://${bind}:${actualPort} (advertised ${url})`);
    const stop = async () => {
        await new Promise((resolve) => server.close(() => resolve()));
        await fs.unlink(paths().webPid).catch(() => undefined);
    };
    return {
        port: actualPort,
        bind,
        url,
        fingerprint: cert.fingerprint,
        stop,
    };
}
async function routeHttp(req, res, ctx) {
    const url = new URL(req.url ?? "/", `https://localhost`);
    const pathname = url.pathname;
    if (pathname === "/" || pathname === "/index.html") {
        await serveStatic(res, "index.html", "text/html; charset=utf-8");
        return;
    }
    if (pathname.startsWith("/static/")) {
        const rel = normalize(pathname.replace(/^\/static\//, ""));
        if (rel.startsWith("..") || rel.startsWith("/")) {
            res.writeHead(403).end("forbidden");
            return;
        }
        const contentType = guessContentType(rel);
        await serveStatic(res, rel, contentType);
        return;
    }
    if (pathname === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            v: 1,
            node: ctx.nodeName,
            fingerprint: ctx.cert.fingerprint,
            notAfter: ctx.cert.notAfter,
        }));
        return;
    }
    if (pathname === "/api/sessions") {
        const sessions = await collectNetSessions(ctx.nodeName);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ v: 1, sessions }));
        return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
}
async function collectNetSessions(selfNodeName) {
    // Pull local sessions through the daemon's LIST RPC.
    const localSessions = await listLocalSessions(selfNodeName);
    const active = await readActiveState();
    if (!active.activeNetId) {
        return localSessions.map((s) => ({
            node: selfNodeName,
            session: s,
            url: `/s/${encodeURIComponent(selfNodeName)}/${encodeURIComponent(s.name)}`,
        }));
    }
    const peers = await readPeers(active.activeNetId);
    void peers; // used by the fanout below
    const merged = await fanoutSessionsAcrossNet({
        activeNetId: active.activeNetId,
        selfNodeName,
        localSessions,
        projectFilter: undefined,
        includeAll: true,
    });
    const rows = merged.rows.map(({ node, session }) => ({
        node,
        session,
        url: `/s/${encodeURIComponent(node)}/${encodeURIComponent(session.name)}`,
    }));
    for (const u of merged.unreachable) {
        rows.push({ node: u, unreachable: true });
    }
    return rows;
}
async function listLocalSessions(nodeName) {
    const client = new BusClient();
    try {
        await client.connect();
    }
    catch {
        return []; // daemon down — return empty; hub still serves the discovery for peers
    }
    try {
        const helloOk = await client.request({
            verb: "HELLO",
            node: nodeName,
            asCli: true,
        });
        if (helloOk.verb !== "OK")
            return [];
        const r = await client.request({ verb: "LIST", filter: { all: true } });
        if (r.verb !== "LIST_RESULT")
            return [];
        return r.sessions;
    }
    finally {
        client.close();
    }
}
async function serveStatic(res, relPath, contentType) {
    const filePath = join(STATIC_DIR, relPath);
    try {
        const body = await fs.readFile(filePath);
        res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        res.end(body);
    }
    catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
}
function guessContentType(rel) {
    if (rel.endsWith(".html"))
        return "text/html; charset=utf-8";
    if (rel.endsWith(".css"))
        return "text/css; charset=utf-8";
    if (rel.endsWith(".js") || rel.endsWith(".mjs"))
        return "application/javascript; charset=utf-8";
    if (rel.endsWith(".map"))
        return "application/json";
    if (rel.endsWith(".svg"))
        return "image/svg+xml";
    if (rel.endsWith(".png"))
        return "image/png";
    if (rel.endsWith(".ico"))
        return "image/x-icon";
    return "application/octet-stream";
}
async function writePidFile(pid, port) {
    await fs.mkdir(paths().webDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths().webPid, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), { mode: 0o600 });
}
export function readPackageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
        return pkg.version;
    }
    catch {
        return "0.0.0-unknown";
    }
}
//# sourceMappingURL=server.js.map