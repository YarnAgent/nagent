// `nagent relay` CLI commands — daemon + client-pinning + allowlist mgmt +
// stdio dialer wrapper used as ssh ProxyCommand.
import { promises as fs, existsSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { dirname } from "node:path";
import { paths } from "../platform/paths.js";
import { RelayServer } from "../relay/server.js";
import { addGrant, removeGrant, listGrants, } from "../relay/allowlist.js";
import { relayDial } from "../relay/dial.js";
import { readIdentity } from "../store/index.js";
import { loadSshKeypair } from "../ssh/identity.js";
const DEFAULT_PORT = 8443;
const DEFAULT_BIND = "0.0.0.0";
export async function cmdRelayServe(opts) {
    const port = opts.port ? Number.parseInt(opts.port, 10) : DEFAULT_PORT;
    const bind = opts.bind ?? DEFAULT_BIND;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port: ${opts.port}`);
    }
    const existing = await readRunningRelayPidfile();
    if (existing && processIsAlive(existing.pid)) {
        process.stdout.write(`relay: daemon already running (pid ${existing.pid}, port ${existing.port})\n`);
        return;
    }
    const relayName = opts.name ?? (await guessRelayName());
    const altNames = await guessAltNames();
    const srv = new RelayServer({
        port, bind, relayName, altNames,
        log: (line) => process.stderr.write(line + "\n"),
    });
    const info = await srv.start();
    await writePidfile({ pid: process.pid, port: info.port, startedAt: new Date().toISOString() });
    process.stdout.write(`nagent-relay: ready\n` +
        `  URL:          https://<this-host>:${info.port}\n` +
        `  fingerprint:  ${info.fingerprint}\n` +
        `  pin on a client:  nagent relay add https://<this-host>:${info.port}\n`);
    const shutdown = async (sig) => {
        process.stderr.write(`\nrelay: received ${sig}, shutting down…\n`);
        await srv.stop();
        await fs.unlink(paths().relayPid).catch(() => undefined);
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
async function readRunningRelayPidfile() {
    if (!existsSync(paths().relayPid))
        return null;
    try {
        return JSON.parse(await fs.readFile(paths().relayPid, "utf8"));
    }
    catch {
        return null;
    }
}
async function writePidfile(rec) {
    await fs.mkdir(paths().relayDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths().relayPid, JSON.stringify(rec, null, 2), { mode: 0o600 });
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
async function guessRelayName() {
    // Default: this node's nagent identity nodeName; fall back to hostname.
    try {
        const id = JSON.parse(await fs.readFile(paths().identity, "utf8"));
        if (id.nodeName)
            return id.nodeName;
    }
    catch { /* no identity yet */ }
    return (await import("node:os")).hostname() || "nagent-relay";
}
async function guessAltNames() {
    const out = new Set();
    const os = await import("node:os");
    const h = os.hostname();
    if (h)
        out.add(h);
    for (const ifaceList of Object.values(os.networkInterfaces())) {
        if (!ifaceList)
            continue;
        for (const iface of ifaceList) {
            if (!iface.internal && iface.address)
                out.add(iface.address);
        }
    }
    return [...out];
}
// ---------------------------------------------------------------------------
// nagent relay stop
// ---------------------------------------------------------------------------
export async function cmdRelayStop() {
    const rec = await readRunningRelayPidfile();
    if (!rec) {
        process.stdout.write("relay: no daemon running\n");
        return;
    }
    if (!processIsAlive(rec.pid)) {
        await fs.unlink(paths().relayPid).catch(() => undefined);
        process.stdout.write(`relay: stale pidfile (pid ${rec.pid}) — cleaned\n`);
        return;
    }
    try {
        process.kill(rec.pid, "SIGTERM");
        process.stdout.write(`relay: stopped daemon (pid ${rec.pid})\n`);
    }
    catch (err) {
        throw new Error(`failed to stop relay pid ${rec.pid}: ${err.message}`);
    }
}
export async function cmdRelayAdd(input, opts) {
    const parsed = parseRelayInput(input);
    if (parsed.kind === "tls") {
        await addTlsRelay(parsed.url, opts);
    }
    else {
        await addSshJumpRelay(parsed.sshTarget, opts);
    }
}
function parseRelayInput(input) {
    if (input.startsWith("https://"))
        return { kind: "tls", url: input };
    if (input.startsWith("ssh://"))
        return { kind: "ssh-jump", sshTarget: input.slice("ssh://".length) };
    // Bare user@host or user@host:port — anything with an `@` and no scheme.
    if (/^[A-Za-z0-9_.\-]+@[A-Za-z0-9_.\-]+(:\d+)?$/.test(input)) {
        return { kind: "ssh-jump", sshTarget: input };
    }
    throw new Error(`unrecognized relay address: "${input}"\n` +
        "  Use one of:\n" +
        "    https://host:port         (TLS transport)\n" +
        "    ssh://user@host[:port]    (ssh-jump transport)\n" +
        "    user@host[:port]          (shorthand for ssh://)");
}
async function addTlsRelay(url, opts) {
    const u = new URL(url);
    if (u.protocol !== "https:")
        throw new Error(`relay URL must be https:// (got ${u.protocol})`);
    const host = u.hostname;
    const port = u.port ? Number.parseInt(u.port, 10) : DEFAULT_PORT;
    const name = opts.name ?? host;
    const fingerprint = await fetchCertFingerprint(host, port);
    process.stdout.write(`transport:     tls\n`);
    process.stdout.write(`relay:         ${url}\n`);
    process.stdout.write(`name:          ${name}\n`);
    process.stdout.write(`fingerprint:   ${fingerprint}\n`);
    if (!opts.yes && process.stdin.isTTY) {
        process.stdout.write(`Pin this fingerprint? Confirm 'y' and press enter: `);
        const ans = await readOneLine();
        if (ans.trim().toLowerCase() !== "y") {
            process.stdout.write("aborted (not pinned).\n");
            return;
        }
    }
    const store = await readPinnedRelaysRaw();
    store.relays[name] = { transport: "tls", url, fingerprint, pinnedAt: new Date().toISOString() };
    await writePinnedRelaysRaw(store);
    process.stdout.write(`pinned as "${name}". (${paths().pinnedRelays})\n`);
}
async function addSshJumpRelay(sshTarget, opts) {
    const { user, host, port } = splitSshTarget(sshTarget);
    const name = opts.name ?? host;
    process.stdout.write(`transport:     ssh-jump\n`);
    process.stdout.write(`ssh target:    ${sshTarget}\n`);
    process.stdout.write(`name:          ${name}\n`);
    if (opts.copyId) {
        process.stdout.write(`\ninstalling nagent pubkey on ${sshTarget} ...\n`);
        try {
            await installPubkey(sshTarget);
            process.stdout.write(`  ok\n`);
        }
        catch (err) {
            process.stderr.write(`  failed: ${err.message}\n`);
            process.stderr.write(`  you can install it manually — see the line printed below.\n`);
        }
    }
    else {
        process.stdout.write(`\nadd this line to ${sshTarget}:~/.ssh/authorized_keys:\n\n`);
        const line = await getNagentAuthorizedKeysLine();
        process.stdout.write(`  ${line}\n\n`);
        process.stdout.write(`or rerun with --copy-id to install it automatically.\n`);
    }
    process.stdout.write(`\nchecking reachability ...\n`);
    const reachable = await sshReachable(sshTarget, 6000);
    process.stdout.write(reachable ? `  ok\n` : `  not yet (auth not set up or host unreachable)\n`);
    const store = await readPinnedRelaysRaw();
    store.relays[name] = { transport: "ssh-jump", sshTarget, pinnedAt: new Date().toISOString() };
    await writePinnedRelaysRaw(store);
    process.stdout.write(`\npinned as "${name}". (${paths().pinnedRelays})\n`);
    void user;
    void port; // used inside helpers
}
export async function cmdRelayRemove(name) {
    const store = await readPinnedRelaysRaw();
    if (!store.relays[name]) {
        process.stdout.write(`relay "${name}" was not pinned\n`);
        return;
    }
    delete store.relays[name];
    await writePinnedRelaysRaw(store);
    process.stdout.write(`unpinned "${name}"\n`);
}
export async function cmdRelayList() {
    const store = await readPinnedRelaysRaw();
    const names = Object.keys(store.relays).sort();
    if (names.length === 0) {
        process.stdout.write("(no pinned relays — use `nagent relay add <url-or-ssh-target>`)\n");
        return;
    }
    const rows = [];
    for (const n of names) {
        const r = store.relays[n];
        const t = r.transport ?? "tls";
        if (t === "ssh-jump") {
            rows.push({ name: n, transport: "ssh-jump", target: r.sshTarget ?? "(missing)", extra: "", pinned: r.pinnedAt ?? "" });
        }
        else {
            const fp = r.fingerprint ? r.fingerprint.slice(0, 23) + "…" : "(no fingerprint)";
            rows.push({ name: n, transport: "tls", target: r.url ?? "(missing)", extra: fp, pinned: r.pinnedAt ?? "" });
        }
    }
    const w = {
        name: Math.max(4, ...rows.map((r) => r.name.length)),
        transport: Math.max(9, ...rows.map((r) => r.transport.length)),
        target: Math.max(6, ...rows.map((r) => r.target.length)),
        extra: Math.max(11, ...rows.map((r) => r.extra.length)),
    };
    const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
    process.stdout.write(`${pad("NAME", w.name)}  ${pad("TRANSPORT", w.transport)}  ${pad("TARGET", w.target)}  ${pad("FINGERPRINT", w.extra)}  PINNED-AT\n`);
    for (const r of rows) {
        process.stdout.write(`${pad(r.name, w.name)}  ${pad(r.transport, w.transport)}  ${pad(r.target, w.target)}  ${pad(r.extra, w.extra)}  ${r.pinned}\n`);
    }
}
async function readPinnedRelaysRaw() {
    try {
        const raw = await fs.readFile(paths().pinnedRelays, "utf8");
        const obj = JSON.parse(raw);
        if (obj.v === 1 && typeof obj.relays === "object" && obj.relays)
            return obj;
    }
    catch { /* missing or malformed */ }
    return { v: 1, relays: {} };
}
async function writePinnedRelaysRaw(store) {
    await fs.mkdir(dirname(paths().pinnedRelays), { recursive: true });
    await fs.writeFile(paths().pinnedRelays, JSON.stringify(store, null, 2), { mode: 0o600 });
}
async function fetchCertFingerprint(host, port) {
    return await new Promise((resolve, reject) => {
        const sock = tlsConnect({ host, port, rejectUnauthorized: false, servername: host }, () => {
            const peer = sock.getPeerCertificate(true);
            const fp = peer.fingerprint256;
            sock.end();
            if (!fp)
                reject(new Error("no peer cert fingerprint"));
            else
                resolve(fp);
        });
        sock.once("error", reject);
        sock.setTimeout(5_000, () => sock.destroy(new Error("tls connect timeout")));
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
// ---------------------------------------------------------------------------
// nagent relay grant / revoke (run on the relay box)
// ---------------------------------------------------------------------------
export async function cmdRelayGrant(node, pubKey) {
    const entry = await addGrant(node, pubKey);
    process.stdout.write(`granted: ${entry.node} (pubKey ${entry.pubKey.slice(0, 16)}…)\n`);
}
export async function cmdRelayRevoke(node) {
    const ok = await removeGrant(node);
    process.stdout.write(ok ? `revoked: ${node}\n` : `no grant for "${node}"\n`);
}
// ---------------------------------------------------------------------------
// ssh-jump helpers (used by addSshJumpRelay; also by the routing layer
// indirectly via splitSshTarget when probing).
// ---------------------------------------------------------------------------
export function splitSshTarget(target) {
    const m = target.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    if (!m || !m[2])
        throw new Error(`invalid ssh target: "${target}"`);
    return {
        user: m[1] ?? null,
        host: m[2],
        port: m[3] ? Number(m[3]) : null,
    };
}
async function sshReachable(sshTarget, timeoutMs) {
    return new Promise((resolve) => {
        const { user, host, port } = splitSshTarget(sshTarget);
        const args = [
            "-o", "BatchMode=yes",
            "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
            "-o", "StrictHostKeyChecking=accept-new",
        ];
        if (port) {
            args.push("-p", String(port));
        }
        args.push(user ? `${user}@${host}` : host, "--", "true");
        const child = spawn("ssh", args, { stdio: "ignore" });
        const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(false); }, timeoutMs + 1000);
        child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
        child.on("error", () => { clearTimeout(timer); resolve(false); });
    });
}
async function getNagentAuthorizedKeysLine() {
    const id = await readIdentity();
    if (!id)
        throw new Error("no nagent identity — run `nagent` once to bootstrap");
    const kp = await loadSshKeypair(id.nodeId);
    return kp.authorizedKeysLine;
}
async function installPubkey(sshTarget) {
    const line = await getNagentAuthorizedKeysLine();
    const { user, host, port } = splitSshTarget(sshTarget);
    // Append idempotently. Pipe the line via stdin so we don't have to fight
    // ssh's argv→string flattening on the remote shell.
    const remoteCmd = 'KEY=$(cat); ' +
        'umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh; ' +
        'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; ' +
        'if ! grep -qF -- "$KEY" ~/.ssh/authorized_keys; then printf "%s\\n" "$KEY" >> ~/.ssh/authorized_keys; fi';
    // Try the nagent key first (in case the operator already authorized this
    // node from another box), then fall back to the user's default keys
    // (typical first-time-from-this-box case where the user already has shell
    // access via their personal key + we just want to add the nagent key on
    // top). The `IdentitiesOnly=yes` prevents ssh from offering keys the
    // server didn't ask for, which speeds up the auth retry.
    const args = ["-o", "StrictHostKeyChecking=accept-new"];
    args.push("-i", paths().sshKey);
    args.push("-o", "PreferredAuthentications=publickey");
    // Don't set IdentitiesOnly so ssh can still fall back to the agent / default
    // keys if the nagent key isn't authorized yet (the whole point of --copy-id).
    if (port)
        args.push("-p", String(port));
    args.push(user ? `${user}@${host}` : host, "--", remoteCmd);
    return new Promise((resolve, reject) => {
        const child = spawn("ssh", args, { stdio: ["pipe", "inherit", "inherit"] });
        child.stdin.write(line + "\n");
        child.stdin.end();
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ssh exited ${code}`)));
        child.on("error", reject);
    });
}
export async function cmdRelayListAllowed() {
    const grants = await listGrants();
    if (grants.length === 0) {
        process.stdout.write("(no explicit grants — using mesh peers.json union)\n");
        return;
    }
    for (const g of grants) {
        process.stdout.write(`${g.node}  ${g.pubKey.slice(0, 16)}…  granted=${g.grantedAt}\n`);
    }
}
export async function cmdRelayDial(peer, opts) {
    if (!peer)
        throw new Error("usage: nagent relay-dial <peer> --relay <name>");
    if (!opts.relay)
        throw new Error("--relay <name> is required");
    const code = await relayDial({
        ipcSockPath: opts.ipcSockPath ?? paths().relayClientSock,
        relayName: opts.relay,
        peerNodeName: peer,
    });
    process.exit(code);
}
//# sourceMappingURL=relay.js.map