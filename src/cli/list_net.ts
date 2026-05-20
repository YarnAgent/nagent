import { spawn } from "node:child_process";
import { readPeers } from "../store/index.js";
import { runWithConcurrency } from "../gossip/index.js";
import type { ListResultEntry } from "../types/index.js";

interface FanoutInput {
  activeNetId: string;
  selfNodeName: string;
  localSessions: ListResultEntry[];
  projectFilter: string | undefined;
  includeAll: boolean;
}

interface FanoutResult {
  rows: Array<{ node: string; session: ListResultEntry }>;
  unreachable: string[];
}

/**
 * Fan out `nagent list --local --json` to every peer in the active net,
 * merge results with the local sessions, and return a flat row list plus the
 * names of peers that could not be reached. Hard timeout per peer is 3s;
 * total concurrency is capped at 16. Errors don't propagate — unreachable
 * peers are simply listed as such so the user can see the partial picture.
 */
export async function fanoutSessionsAcrossNet(input: FanoutInput): Promise<FanoutResult> {
  const peers = await readPeers(input.activeNetId);
  const others = peers.filter((p) => p.nodeName !== input.selfNodeName);

  const rows: Array<{ node: string; session: ListResultEntry }> = input.localSessions.map(
    (s) => ({ node: input.selfNodeName, session: s }),
  );
  const unreachable: string[] = [];

  if (others.length === 0) return { rows, unreachable };

  const remoteArgs = ["list", "--local", "--json"];
  if (input.projectFilter) remoteArgs.push("--project", input.projectFilter);
  if (input.includeAll) remoteArgs.push("--all");

  const results = await runWithConcurrency(others, 16, async (peer) => {
    return sshListLocal(`nagent.${peer.nodeName}`, remoteArgs, 3000);
  });

  for (let i = 0; i < others.length; i++) {
    const peer = others[i]!;
    const r = results[i]!;
    if ("error" in r) {
      unreachable.push(peer.nodeName);
      continue;
    }
    for (const session of r.result.sessions) {
      rows.push({ node: peer.nodeName, session });
    }
  }

  return { rows, unreachable };
}

interface RemoteListPayload {
  v: 1;
  node: string;
  sessions: ListResultEntry[];
}

/**
 * SSH-shellout to `nagent list --local --json` on a remote peer. Returns the
 * parsed JSON payload, or rejects with an error if ssh fails, times out, or
 * the response can't be parsed.
 *
 * We pass the command through `bash -ilc` so nvm/mise/asdf get sourced and
 * `nagent` is on PATH — same trick as `attach`. Single-quoted to survive ssh's
 * argv-flattening.
 */
async function sshListLocal(
  sshHost: string,
  remoteArgs: string[],
  timeoutMs: number,
): Promise<RemoteListPayload> {
  const innerCmd = ["nagent", ...remoteArgs.map(shellSingleQuote)].join(" ");
  const wrappedCmd = `bash -ilc ${shellSingleQuote(innerCmd)}`;
  return new Promise<RemoteListPayload>((resolve, reject) => {
    const args = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      sshHost,
      "--",
      wrappedCmd,
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ssh ${sshHost}: list timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`ssh ${sshHost}: exit ${code}: ${stderr || "(no stderr)"}`));
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8").trim();
      // The remote may print the bootstrap-on-first-call lines first; the
      // JSON is the last line. Take the last non-empty line and parse it.
      const lastLine = stdout.split(/\r?\n/).filter((l) => l.length > 0).pop();
      if (!lastLine) {
        reject(new Error(`ssh ${sshHost}: empty list response`));
        return;
      }
      try {
        const parsed = JSON.parse(lastLine) as RemoteListPayload;
        if (parsed.v !== 1 || !Array.isArray(parsed.sessions)) {
          reject(new Error(`ssh ${sshHost}: malformed list payload`));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`ssh ${sshHost}: bad JSON: ${(err as Error).message}`));
      }
    });
  });
}

function shellSingleQuote(s: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
