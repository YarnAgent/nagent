import { promises as fs, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureNagentRoot, listNets, readActiveState, readIdentity, writeActiveState, writeIdentity, writeNetMeta, writePeers, } from "../store/index.js";
import { writeJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
const BOOT_FLAG = "NAGENT_NO_BOOTSTRAP";
const LOCK_FILE = ".bootstrap.lock";
const SOCKET_WAIT_MS = 2000;
const SOCKET_POLL_MS = 50;
/**
 * Idempotent bootstrap: ensures identity, default net, and a running daemon.
 * Runs at the top of every CLI entry point. Set NAGENT_NO_BOOTSTRAP=1 to skip.
 */
export async function bootstrap(opts = {}) {
    if (process.env[BOOT_FLAG] === "1")
        return;
    const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
    await ensureNagentRoot();
    const releaseLock = await acquireLock();
    try {
        await ensureIdentity(log);
        await ensureDefaultNet(log);
        if (!opts.skipDaemon)
            await ensureDaemon(log);
    }
    finally {
        await releaseLock();
    }
}
export async function ensureIdentity(log) {
    const existing = await readIdentity();
    if (existing)
        return;
    const nodeName = process.env.NAGENT_NODE_NAME ?? hostname() ?? "node";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" });
    const nodeId = createHash("sha256").update(pubDer).digest("hex").slice(0, 16);
    await writeIdentity({
        nodeId,
        nodeName,
        ed25519Pub: pubDer.toString("base64"),
        createdAt: new Date().toISOString(),
    });
    await fs.mkdir(paths().sshDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths().sshKey, privPem, { mode: 0o600 });
    await fs.writeFile(paths().sshPub, pubDer.toString("base64") + "\n", { mode: 0o644 });
    log(`nagent: initialized node "${nodeName}" (${nodeId})`);
}
export async function ensureDefaultNet(log) {
    const nets = await listNets();
    if (nets.length > 0) {
        // If active net isn't set, point at the first available.
        const active = await readActiveState();
        if (!active.activeNetId) {
            await writeActiveState({ activeNetId: nets[0].netId });
        }
        return;
    }
    const id = (await readIdentity());
    const netId = `n-${randomBytes(6).toString("hex")}`;
    const meta = {
        netId,
        name: "default",
        createdAt: new Date().toISOString(),
        originNode: id.nodeName,
    };
    await writeNetMeta(meta);
    await writePeers(netId, [
        {
            nodeName: id.nodeName,
            pubKey: id.ed25519Pub,
            addresses: [],
            roles: [],
            lastSeen: meta.createdAt,
        },
    ]);
    await writeJson(paths().netAuthority(netId), { originPubKey: id.ed25519Pub, delegations: [] });
    await writeJson(paths().netProjects(netId), []);
    await writeActiveState({ activeNetId: netId });
    log(`nagent: created default net (${netId})`);
}
export async function ensureDaemon(log) {
    if (await socketIsLive())
        return;
    // If the pid file points at a live process, the socket should be live too.
    // If it isn't, we don't kill anything — we warn and bail.
    const stalePid = await readPidIfStale();
    if (stalePid && (await processAlive(stalePid))) {
        log(`nagent: warning — daemon.pid ${stalePid} is alive but socket isn't reachable. Inspect and 'kill ${stalePid}' if needed.`);
        return;
    }
    // Locate the bin we were launched from so the spawned daemon uses the same code.
    const binPath = process.argv[1];
    if (!binPath || !existsSync(binPath)) {
        throw new Error(`bootstrap: cannot locate nagent bin (argv[1]=${binPath})`);
    }
    const logFd = await fs.open(paths().daemonLog, "a", 0o600);
    try {
        const child = spawn(process.execPath, [binPath, "daemon", "--foreground"], {
            detached: true,
            stdio: ["ignore", logFd.fd, logFd.fd],
            env: {
                ...process.env,
                [BOOT_FLAG]: "1",
            },
        });
        child.unref();
        if (child.pid === undefined) {
            throw new Error("bootstrap: failed to spawn daemon (no pid)");
        }
        await writeJson(paths().daemonPid, { pid: child.pid, startedAt: new Date().toISOString() });
        // Poll the socket until it's ready.
        const ok = await waitForSocket(SOCKET_WAIT_MS);
        if (!ok) {
            throw new Error(`bootstrap: daemon did not start within ${SOCKET_WAIT_MS}ms (see ${paths().daemonLog})`);
        }
        log(`nagent: started daemon (pid ${child.pid}, log ${paths().daemonLog})`);
    }
    finally {
        await logFd.close();
    }
}
async function socketIsLive() {
    const sock = paths().socket;
    if (!existsSync(sock))
        return false;
    return new Promise((resolve) => {
        const c = createConnection({ path: sock });
        c.once("connect", () => {
            c.end();
            resolve(true);
        });
        c.once("error", () => resolve(false));
        setTimeout(() => {
            c.destroy();
            resolve(false);
        }, 200);
    });
}
async function waitForSocket(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await socketIsLive())
            return true;
        await sleep(SOCKET_POLL_MS);
    }
    return false;
}
async function readPidIfStale() {
    try {
        const raw = await fs.readFile(paths().daemonPid, "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed.pid === "number" ? parsed.pid : undefined;
    }
    catch {
        return undefined;
    }
}
async function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function acquireLock() {
    const lockPath = `${paths().root}/${LOCK_FILE}`;
    const deadline = Date.now() + SOCKET_WAIT_MS;
    while (Date.now() < deadline) {
        try {
            const handle = await fs.open(lockPath, "wx", 0o600);
            await handle.writeFile(String(process.pid));
            await handle.close();
            return async () => { await fs.unlink(lockPath).catch(() => { }); };
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            // Check whether the lock is stale (owner pid dead).
            try {
                const owner = parseInt((await fs.readFile(lockPath, "utf8")).trim(), 10);
                if (!Number.isNaN(owner) && !(await processAlive(owner))) {
                    await fs.unlink(lockPath).catch(() => { });
                    continue;
                }
            }
            catch { /* ignore */ }
            await sleep(SOCKET_POLL_MS);
        }
    }
    // Fall through: someone else is bootstrapping. Proceed without a lock; the
    // worst case is a redundant write that idempotent helpers tolerate.
    return async () => { };
}
//# sourceMappingURL=bootstrap.js.map