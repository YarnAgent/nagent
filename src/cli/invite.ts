import { userInfo } from "node:os";
import { paths } from "../platform/paths.js";
import {
  encodeToken,
  generateOneTimeKey,
  newInviteId,
  newNonce,
  type InvitePayload,
} from "../invite/index.js";
import {
  appendAuthorizedKey,
} from "../ssh/authorized_keys.js";
import {
  sshAuthorizedKeysLine,
  loadSshKeypair,
} from "../ssh/identity.js";
import {
  currentReachableAddresses,
  parseAddressArg,
  type ReachableAddress,
} from "../ssh/addresses.js";
import {
  readActiveState,
  readIdentity,
  readInvites,
  readNetMeta,
  writeInvites,
} from "../store/index.js";
import type { InviteRecord } from "../types/index.js";

function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s} (use 30s, 5m, 1h, 1d)`);
  const n = Number.parseInt(m[1]!, 10);
  const unit = (m[2] ?? "s").toLowerCase();
  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * factor;
}

export interface InviteOptions {
  expires?: string;        // duration string (default 1h)
  addr?: string[];         // override reachable addrs
  tag?: string[];          // k=v pairs
  reusable?: boolean;      // not used in v0.2 (single-shot only)
}

export interface InviteResult {
  token: string;
  inviteId: string;
  expiresAt: string;
}

/** Generate an invite token and install the constrained authorized_keys entry. */
export async function generateInvite(opts: InviteOptions = {}): Promise<InviteResult> {
  const identity = await readIdentity();
  if (!identity) throw new Error("nagent not initialized (bootstrap should have created identity)");
  const active = await readActiveState();
  if (!active.activeNetId) throw new Error("no active net");
  const netMeta = await readNetMeta(active.activeNetId);
  if (!netMeta) throw new Error(`active net ${active.activeNetId} not found`);

  const keypair = await loadSshKeypair(identity.nodeId);
  const issuerPub = keypair.rawPub.toString("base64url");

  const oneTime = generateOneTimeKey();
  const inviteId = newInviteId();
  const ttlMs = parseDuration(opts.expires ?? "1h");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const addrs: ReachableAddress[] = opts.addr && opts.addr.length
    ? opts.addr.map((a) => parseAddressArg(a))
    : currentReachableAddresses();
  if (addrs.length === 0) {
    throw new Error("no reachable address detected — pass --addr <host[:port]>");
  }

  const tags = parseTags(opts.tag ?? []);

  const payload: InvitePayload = {
    v: 1,
    netId: netMeta.netId,
    netName: netMeta.name,
    inviteId,
    issuerNode: identity.nodeName,
    issuerPub,
    issuerSshUser: userInfo().username,
    issuerAddrs: addrs,
    oneTimePub: oneTime.pub,
    oneTimePriv: oneTime.priv,
    nonce: newNonce(),
    expiresAt,
    ...(Object.keys(tags).length ? { flags: { tags } } : {}),
  };

  const token = encodeToken(payload, keypair.privKey);

  // Install the one-time authorized_keys entry with a forced command.
  // Forced commands run under sshd's minimal env — PATH typically lacks nvm /
  // homebrew / mise paths, so `#!/usr/bin/env node` shebangs fail. Embed the
  // absolute node binary and NAGENT_HOME explicitly.
  const nagentBin = process.argv[1];
  if (!nagentBin) throw new Error("cannot resolve nagent bin path (argv[1] empty)");
  const nodeBin = process.execPath;
  const homeForCmd = paths().root;
  const command =
    `env NAGENT_HOME=${shellQuote(homeForCmd)} ` +
    `${shellQuote(nodeBin)} ${shellQuote(nagentBin)} join-respond ${inviteId}`;
  const restrictions = `command="${escapeForAuthorizedKeys(command)}",no-pty,no-X11-forwarding,no-agent-forwarding,no-port-forwarding`;
  const oneTimePubRaw = Buffer.from(oneTime.pub, "base64url");
  const sshLine = sshAuthorizedKeysLine(oneTimePubRaw, `nagent-invite-${inviteId}`);
  await appendAuthorizedKey({
    line: `${restrictions} ${sshLine}`,
    tag: `invite-${inviteId}`,
  });

  // Record the invite.
  const records = await readInvites();
  const record: InviteRecord = {
    inviteId,
    oneTimePub: oneTime.pub,
    netId: payload.netId,
    expiresAt,
    state: "pending",
    createdAt: new Date().toISOString(),
    ...(Object.keys(tags).length ? { flags: { tags } } : {}),
  };
  records.push(record);
  await writeInvites(records);

  return { token, inviteId, expiresAt };
}

function escapeForAuthorizedKeys(s: string): string {
  // command="..." — backslash-escape internal backslashes and double-quotes.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Single-quote a token for safe embedding in a shell command. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function parseTags(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of raw) {
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
