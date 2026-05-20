import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { paths } from "../platform/paths.js";

export interface SshHostEntry {
  peerName: string;
  host: string;
  port?: number;
  user: string;
  identityFile?: string;
}

const FENCE = (peer: string) =>
  ({ open: `# >>> nagent host ${peer} >>>`, close: `# <<< nagent host ${peer} <<<` });

const INCLUDE_LINE = `Include ${nagentSshConfigPath()}`;

export function nagentSshConfigPath(): string {
  return paths().root + "/ssh_config";
}

function userSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

async function readOrEmpty(path: string): Promise<string> {
  try { return await fs.readFile(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function writeFile600(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, content, { mode: 0o600 });
}

/** Ensure `Include ~/.nagent/ssh_config` is in the user's ~/.ssh/config exactly once. */
export async function ensureUserSshConfigInclude(): Promise<void> {
  const path = userSshConfigPath();
  const current = await readOrEmpty(path);
  if (current.split("\n").some((l) => l.trim() === INCLUDE_LINE.trim())) return;
  const body = current.length && !current.endsWith("\n") ? current + "\n" : current;
  await writeFile600(path, `${INCLUDE_LINE}\n${body}`);
}

function renderEntry(entry: SshHostEntry): string {
  const lines: string[] = [];
  const f = FENCE(entry.peerName);
  lines.push(f.open);
  lines.push(`Host nagent.${entry.peerName}`);
  lines.push(`  HostName ${entry.host}`);
  if (entry.port && entry.port !== 22) lines.push(`  Port ${entry.port}`);
  lines.push(`  User ${entry.user}`);
  if (entry.identityFile) {
    lines.push(`  IdentityFile ${entry.identityFile}`);
    lines.push(`  IdentitiesOnly yes`);
  }
  // Security: no agent forwarding, no X forwarding. TOFU known_hosts.
  lines.push(`  ForwardAgent no`);
  lines.push(`  ForwardX11 no`);
  lines.push(`  StrictHostKeyChecking accept-new`);
  lines.push(`  UserKnownHostsFile ${paths().root}/known_hosts`);
  lines.push(f.close);
  return lines.join("\n");
}

function stripBlock(content: string, peerName: string): string {
  const f = FENCE(peerName);
  const lines = content.split("\n");
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    if (!skip && l.trim() === f.open.trim()) { skip = true; continue; }
    if (skip && l.trim() === f.close.trim()) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  return out.join("\n");
}

/**
 * Add or replace a `Host nagent.<peer>` block in ~/.nagent/ssh_config.
 * Idempotent. Asserts no ForwardAgent yes anywhere in the resulting file.
 */
export async function writeHostEntry(entry: SshHostEntry): Promise<void> {
  const path = nagentSshConfigPath();
  const cur = await readOrEmpty(path);
  let next = stripBlock(cur, entry.peerName);
  if (next.length && !next.endsWith("\n")) next += "\n";
  next += renderEntry(entry) + "\n";
  assertNoForwardAgent(next);
  await writeFile600(path, next);
}

/** Remove a `Host nagent.<peer>` block. No-op if absent. */
export async function removeHostEntry(peerName: string): Promise<void> {
  const path = nagentSshConfigPath();
  const cur = await readOrEmpty(path);
  if (!cur) return;
  const next = stripBlock(cur, peerName);
  await writeFile600(path, next);
}

/** Return parsed host entries (just peerName for now). Used by tests. */
export async function listHostEntries(): Promise<string[]> {
  const cur = await readOrEmpty(nagentSshConfigPath());
  const out: string[] = [];
  for (const m of cur.matchAll(/# >>> nagent host (\S+) >>>/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function assertNoForwardAgent(text: string): void {
  // We refuse to write a file that turns agent forwarding on. We only check
  // affirmative `ForwardAgent yes`; `ForwardAgent no` is fine (we write that).
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^ForwardAgent\s+yes\b/i.test(t)) {
      throw new Error(`refusing to write ssh_config containing 'ForwardAgent yes' (security)`);
    }
  }
}

export const _internal = { renderEntry, stripBlock, INCLUDE_LINE, nagentSshConfigPath };
