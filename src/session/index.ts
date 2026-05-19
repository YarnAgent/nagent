import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { TMUX_SOCKET_NAME, paths } from "../platform/paths.js";

export function tmuxSessionName(sessionId: string): string {
  return `s-${sessionId}`;
}

export function tmuxArgs(args: string[]): string[] {
  return ["-L", TMUX_SOCKET_NAME, ...args];
}

export interface SpawnSessionOptions {
  sessionId: string;
  nodeName: string;
  sessionDisplayName: string;
  projectId?: string;
  attach: boolean;
}

/**
 * Create a tmux session with NAGENT_* env exported. Returns immediately if
 * `attach` is false; otherwise replaces the current process with `tmux attach`.
 */
export function createOrAttachTmuxSession(opts: SpawnSessionOptions): void {
  const target = tmuxSessionName(opts.sessionId);
  const env = {
    ...process.env,
    NAGENT_SOCK: paths().socket,
    NAGENT_NODE: opts.nodeName,
    NAGENT_SESSION: opts.sessionDisplayName,
    ...(opts.projectId ? { NAGENT_PROJECT: opts.projectId } : {}),
  };

  // Ensure tmux session exists (idempotent — `new-session -A` attaches if it does).
  const existsCheck = spawnSync("tmux", tmuxArgs(["has-session", "-t", target]), { stdio: "ignore" });
  if (existsCheck.status !== 0) {
    const create = spawnSync(
      "tmux",
      tmuxArgs(["new-session", "-d", "-s", target]),
      { stdio: "inherit", env },
    );
    if (create.status !== 0) {
      throw new Error(`tmux new-session failed (exit ${create.status})`);
    }
    // Push NAGENT_* into the session environment so future panes inherit them.
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("NAGENT_") && typeof v === "string") {
        spawnSync("tmux", tmuxArgs(["set-environment", "-t", target, k, v]), { stdio: "ignore" });
      }
    }
  }

  if (opts.attach) {
    attachTmuxSession(target);
  }
}

/** Replaces the current process with `tmux -L nagent attach -t <target>`. */
export function attachTmuxSession(target: string): never {
  // We use spawnSync with stdio:'inherit' so the user's TTY is handed to tmux.
  // We then exit with tmux's exit code. (execvp would be cleaner but Node has no built-in exec replacement.)
  const opts: SpawnOptions = { stdio: "inherit" };
  const r = spawnSync("tmux", tmuxArgs(["attach-session", "-t", target]), opts);
  process.exit(r.status ?? 0);
}

/** Returns true if a tmux session with the given full target name exists. */
export function tmuxSessionExists(target: string): boolean {
  const r = spawnSync("tmux", tmuxArgs(["has-session", "-t", target]), { stdio: "ignore" });
  return r.status === 0;
}

/** Synchronously list tmux session names on the nagent socket. */
export function listTmuxSessions(): string[] {
  const r = spawnSync("tmux", tmuxArgs(["ls", "-F", "#S"]), { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) return [];
  return r.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Check tmux is installed and meets minimum version. */
export function checkTmuxVersion(): { ok: true; version: string } | { ok: false; reason: string } {
  const r = spawnSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) return { ok: false, reason: "tmux not found on PATH" };
  const m = /tmux\s+(?:next-)?([0-9]+(?:\.[0-9]+)?)/.exec(r.stdout.toString("utf8"));
  if (!m || !m[1]) return { ok: false, reason: `cannot parse tmux version: ${r.stdout.toString("utf8")}` };
  const major = parseFloat(m[1]);
  if (major < 3.0) return { ok: false, reason: `tmux ${m[1]} too old; need >= 3.0` };
  return { ok: true, version: m[1] };
}
