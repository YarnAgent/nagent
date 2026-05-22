// `nagent relay` CLI commands — daemon + client-pinning + allowlist mgmt +
// stdio dialer wrapper used as ssh ProxyCommand.

import { promises as fs, existsSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";
import { paths } from "../platform/paths.js";
import { RelayServer } from "../relay/server.js";
import {
  addGrant,
  removeGrant,
  listGrants,
} from "../relay/allowlist.js";
import { relayDial } from "../relay/dial.js";

const DEFAULT_PORT = 8443;
const DEFAULT_BIND = "0.0.0.0";

// ---------------------------------------------------------------------------
// nagent relay serve
// ---------------------------------------------------------------------------

export interface RelayServeOpts {
  port?: string;
  bind?: string;
  name?: string;
}

export async function cmdRelayServe(opts: RelayServeOpts): Promise<void> {
  const port = opts.port ? Number.parseInt(opts.port, 10) : DEFAULT_PORT;
  const bind = opts.bind ?? DEFAULT_BIND;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${opts.port}`);
  }

  const existing = await readRunningRelayPidfile();
  if (existing && processIsAlive(existing.pid)) {
    process.stdout.write(
      `relay: daemon already running (pid ${existing.pid}, port ${existing.port})\n`,
    );
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

  process.stdout.write(
    `nagent-relay: ready\n` +
      `  URL:          https://<this-host>:${info.port}\n` +
      `  fingerprint:  ${info.fingerprint}\n` +
      `  pin on a client:  nagent relay add https://<this-host>:${info.port}\n`,
  );

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`\nrelay: received ${sig}, shutting down…\n`);
    await srv.stop();
    await fs.unlink(paths().relayPid).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

interface PidfileRecord { pid: number; port: number; startedAt: string }

async function readRunningRelayPidfile(): Promise<PidfileRecord | null> {
  if (!existsSync(paths().relayPid)) return null;
  try { return JSON.parse(await fs.readFile(paths().relayPid, "utf8")) as PidfileRecord; }
  catch { return null; }
}

async function writePidfile(rec: PidfileRecord): Promise<void> {
  await fs.mkdir(paths().relayDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths().relayPid, JSON.stringify(rec, null, 2), { mode: 0o600 });
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function guessRelayName(): Promise<string> {
  // Default: this node's nagent identity nodeName; fall back to hostname.
  try {
    const id = JSON.parse(await fs.readFile(paths().identity, "utf8")) as { nodeName?: string };
    if (id.nodeName) return id.nodeName;
  } catch { /* no identity yet */ }
  return (await import("node:os")).hostname() || "nagent-relay";
}

async function guessAltNames(): Promise<string[]> {
  const out = new Set<string>();
  const os = await import("node:os");
  const h = os.hostname(); if (h) out.add(h);
  for (const ifaceList of Object.values(os.networkInterfaces())) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (!iface.internal && iface.address) out.add(iface.address);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// nagent relay stop
// ---------------------------------------------------------------------------

export async function cmdRelayStop(): Promise<void> {
  const rec = await readRunningRelayPidfile();
  if (!rec) { process.stdout.write("relay: no daemon running\n"); return; }
  if (!processIsAlive(rec.pid)) {
    await fs.unlink(paths().relayPid).catch(() => undefined);
    process.stdout.write(`relay: stale pidfile (pid ${rec.pid}) — cleaned\n`);
    return;
  }
  try {
    process.kill(rec.pid, "SIGTERM");
    process.stdout.write(`relay: stopped daemon (pid ${rec.pid})\n`);
  } catch (err) {
    throw new Error(`failed to stop relay pid ${rec.pid}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// nagent relay add <url>
// ---------------------------------------------------------------------------

export interface PinnedRelayRecord {
  url: string;
  fingerprint: string;
  pinnedAt: string;
}
interface PinnedRelaysFile { v: 1; relays: Record<string, PinnedRelayRecord> }

export interface RelayAddOpts { name?: string; yes?: boolean }

export async function cmdRelayAdd(url: string, opts: RelayAddOpts): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`relay URL must be https:// (got ${u.protocol})`);
  const host = u.hostname;
  const port = u.port ? Number.parseInt(u.port, 10) : DEFAULT_PORT;
  const name = opts.name ?? host;
  const fingerprint = await fetchCertFingerprint(host, port);

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

  const store = await readPinnedRelays();
  store.relays[name] = { url, fingerprint, pinnedAt: new Date().toISOString() };
  await writePinnedRelays(store);
  process.stdout.write(`pinned as "${name}". (${paths().pinnedRelays})\n`);
}

export async function cmdRelayRemove(name: string): Promise<void> {
  const store = await readPinnedRelays();
  if (!store.relays[name]) {
    process.stdout.write(`relay "${name}" was not pinned\n`);
    return;
  }
  delete store.relays[name];
  await writePinnedRelays(store);
  process.stdout.write(`unpinned "${name}"\n`);
}

export async function cmdRelayList(): Promise<void> {
  const store = await readPinnedRelays();
  const names = Object.keys(store.relays).sort();
  if (names.length === 0) { process.stdout.write("(no pinned relays — use `nagent relay add <url>`)\n"); return; }
  const rows: Array<{ name: string; url: string; fp: string; pinned: string }> = [];
  for (const n of names) {
    const r = store.relays[n]!;
    rows.push({ name: n, url: r.url, fp: r.fingerprint.slice(0, 23) + "…", pinned: r.pinnedAt });
  }
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    url: Math.max(3, ...rows.map((r) => r.url.length)),
    fp: 24,
    pinned: Math.max(6, ...rows.map((r) => r.pinned.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  process.stdout.write(`${pad("NAME", w.name)}  ${pad("URL", w.url)}  ${pad("FINGERPRINT", w.fp)}  PINNED-AT\n`);
  for (const r of rows) {
    process.stdout.write(`${pad(r.name, w.name)}  ${pad(r.url, w.url)}  ${pad(r.fp, w.fp)}  ${r.pinned}\n`);
  }
}

async function readPinnedRelays(): Promise<PinnedRelaysFile> {
  try {
    const raw = await fs.readFile(paths().pinnedRelays, "utf8");
    const obj = JSON.parse(raw) as PinnedRelaysFile;
    if (obj.v === 1 && typeof obj.relays === "object" && obj.relays) return obj;
  } catch { /* missing or malformed */ }
  return { v: 1, relays: {} };
}

async function writePinnedRelays(store: PinnedRelaysFile): Promise<void> {
  await fs.writeFile(paths().pinnedRelays, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function fetchCertFingerprint(host: string, port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const sock = tlsConnect(
      { host, port, rejectUnauthorized: false, servername: host },
      () => {
        const peer = sock.getPeerCertificate(true);
        const fp = peer.fingerprint256;
        sock.end();
        if (!fp) reject(new Error("no peer cert fingerprint"));
        else resolve(fp);
      },
    );
    sock.once("error", reject);
    sock.setTimeout(5_000, () => sock.destroy(new Error("tls connect timeout")));
  });
}

async function readOneLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) { process.stdin.off("data", onData); process.stdin.pause(); resolve(buf.slice(0, nl)); }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// nagent relay grant / revoke (run on the relay box)
// ---------------------------------------------------------------------------

export async function cmdRelayGrant(node: string, pubKey: string): Promise<void> {
  const entry = await addGrant(node, pubKey);
  process.stdout.write(`granted: ${entry.node} (pubKey ${entry.pubKey.slice(0, 16)}…)\n`);
}

export async function cmdRelayRevoke(node: string): Promise<void> {
  const ok = await removeGrant(node);
  process.stdout.write(ok ? `revoked: ${node}\n` : `no grant for "${node}"\n`);
}

export async function cmdRelayListAllowed(): Promise<void> {
  const grants = await listGrants();
  if (grants.length === 0) { process.stdout.write("(no explicit grants — using mesh peers.json union)\n"); return; }
  for (const g of grants) {
    process.stdout.write(`${g.node}  ${g.pubKey.slice(0, 16)}…  granted=${g.grantedAt}\n`);
  }
}

// ---------------------------------------------------------------------------
// nagent relay-dial — ProxyCommand stdio bridge wrapper
// ---------------------------------------------------------------------------

export interface RelayDialOpts {
  relay: string;
  /** Override the IPC socket path (testing). */
  ipcSockPath?: string;
}

export async function cmdRelayDial(peer: string, opts: RelayDialOpts): Promise<void> {
  if (!peer) throw new Error("usage: nagent relay-dial <peer> --relay <name>");
  if (!opts.relay) throw new Error("--relay <name> is required");
  const code = await relayDial({
    ipcSockPath: opts.ipcSockPath ?? paths().relayClientSock,
    relayName: opts.relay,
    peerNodeName: peer,
  });
  process.exit(code);
}
