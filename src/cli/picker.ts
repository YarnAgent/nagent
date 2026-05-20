import { createInterface } from "node:readline/promises";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { BusClient } from "../bus/client.js";
import { createOrAttachTmuxSession } from "../session/index.js";
import { paths } from "../platform/paths.js";
import {
  readActiveState,
  readNetMeta,
  readProjects,
} from "../store/index.js";
import { findProjectMarker } from "../project/index.js";
import { dispatchSlash } from "./slash.js";
import type {
  HelloFrame,
  ListResultEntry,
  ListResultFrame,
  NodeIdentity,
  SessionCreatedFrame,
  SessionMeta,
} from "../types/index.js";

export interface PickerInput {
  ctx: { identity: NodeIdentity | undefined };
}

interface PickerState {
  nodeName: string;
  netName: string | undefined;
  projectName: string | undefined;
  projectId: string | undefined;
  sessions: ListResultEntry[];
}

export async function runPicker(input: PickerInput): Promise<void> {
  const client = new BusClient();
  try {
    await client.connect();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
      throw new Error(`cannot reach nagentd on ${paths().socket}`);
    }
    throw err;
  }
  const hello: HelloFrame = {
    verb: "HELLO",
    node: input.ctx.identity?.nodeName ?? "node",
    asCli: true,
  };
  const r0 = await client.request(hello);
  if (r0.verb !== "OK") throw new Error(`HELLO failed: ${r0.verb}`);

  const ask = await makeAsker();
  try {
    let exitToAttach: { sessionId: string; name: string; projectId?: string } | undefined;
    while (true) {
      const state = await refreshState(client);
      render(state);
      const raw = await ask("> ");
      if (raw === undefined) break;
      const line = raw.trim();
      if (line === "" || line === "q" || line === "quit") break;

      if (line.startsWith("/")) {
        const result = await dispatchSlash(line.slice(1), {
          log: (s) => process.stdout.write(s + "\n"),
          err: (s) => process.stderr.write(s + "\n"),
        });
        if (result.exitPicker) break;
        process.stdout.write("\n");
        continue;
      }

      if (line === "n") {
        const rawName = await ask("session name: ");
        if (rawName === undefined) break;
        const name = rawName.trim();
        if (!name) {
          process.stderr.write("name required\n\n");
          continue;
        }
        const created = await createSessionViaClient(client, name, state.projectId);
        exitToAttach = { sessionId: created.sessionId, name: created.name, ...(created.projectId ? { projectId: created.projectId } : {}) };
        break;
      }

      const asNum = Number.parseInt(line, 10);
      if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= state.sessions.length) {
        const entry = state.sessions[asNum - 1]!;
        exitToAttach = { sessionId: entry.sessionId, name: entry.name, ...(entry.project ? { projectId: entry.project } : {}) };
        break;
      }

      // bare name → match by session name
      const named = state.sessions.find((s) => s.name === line);
      if (named) {
        exitToAttach = { sessionId: named.sessionId, name: named.name, ...(named.project ? { projectId: named.project } : {}) };
        break;
      }
      process.stderr.write(`unknown input: ${line}\n\n`);
    }

    ask.close();
    client.close();

    if (exitToAttach) {
      createOrAttachTmuxSession({
        sessionId: exitToAttach.sessionId,
        sessionDisplayName: exitToAttach.name,
        nodeName: input.ctx.identity?.nodeName ?? "node",
        ...(exitToAttach.projectId ? { projectId: exitToAttach.projectId } : {}),
        attach: true,
      });
    }
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
}

interface Asker {
  (prompt: string): Promise<string | undefined>;
  close(): void;
}

async function makeAsker(): Promise<Asker> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    rl.on("close", () => { closed = true; });
    const ask = async (q: string): Promise<string | undefined> => {
      if (closed) return undefined;
      try { return await rl.question(q); } catch { return undefined; }
    };
    return Object.assign(ask, { close: () => rl.close() });
  }
  // Piped stdin: read all lines upfront and pop them on each ask.
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  // Trailing newline yields a phantom empty entry — strip it.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let idx = 0;
  const ask = async (q: string): Promise<string | undefined> => {
    process.stdout.write(q);
    if (idx >= lines.length) {
      process.stdout.write("\n");
      return undefined;
    }
    const line = lines[idx++]!;
    process.stdout.write(line + "\n");
    return line;
  };
  return Object.assign(ask, { close: () => {} });
}

async function refreshState(client: BusClient): Promise<PickerState> {
  const id = await readIdAndActive();
  const list = await client.request({
    verb: "LIST",
    filter: id.activeProjectId ? { project: id.activeProjectId } : {},
  });
  const sessions = list.verb === "LIST_RESULT" ? (list as ListResultFrame).sessions : [];
  return {
    nodeName: id.nodeName,
    netName: id.netName,
    projectName: id.projectName,
    projectId: id.activeProjectId,
    sessions,
  };
}

interface ActiveSummary {
  nodeName: string;
  netName: string | undefined;
  projectName: string | undefined;
  activeProjectId?: string;
}

async function readIdAndActive(): Promise<ActiveSummary> {
  const { readIdentity } = await import("../store/index.js");
  const id = await readIdentity();
  const state = await readActiveState();
  let netName: string | undefined;
  if (state.activeNetId) {
    const meta = await readNetMeta(state.activeNetId);
    netName = meta?.name;
  }
  let projectName: string | undefined;
  let activeProjectId = state.activeProjectId;
  // cwd-walk overrides the persisted activeProjectId for context display
  const cwdProj = await findProjectMarker(process.cwd());
  if (cwdProj) {
    activeProjectId = cwdProj.marker.projectId;
    projectName = cwdProj.marker.projectName;
  } else if (state.activeProjectId && state.activeNetId) {
    const list = await readProjects(state.activeNetId);
    projectName = list.find((p) => p.projectId === state.activeProjectId)?.name;
  }
  return {
    nodeName: id?.nodeName ?? "node",
    netName,
    projectName,
    ...(activeProjectId !== undefined ? { activeProjectId } : {}),
  };
}

function shortCwd(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

function render(state: PickerState): void {
  const lines: string[] = [];
  lines.push(
    `nagent — node=${state.nodeName}  net=${state.netName ?? "—"}  project=${state.projectName ?? "—"}  cwd=${shortCwd(pathResolve(process.cwd()))}`,
  );
  lines.push("");
  lines.push(`Sessions${state.projectName ? ` in ${state.projectName}` : ""}:`);
  if (state.sessions.length === 0) {
    lines.push("  (no sessions yet)");
  } else {
    state.sessions.forEach((s, i) => {
      const roles = s.roles.length ? s.roles.join(",") : "-";
      lines.push(`  ${String(i + 1).padStart(2)}) ${s.name.padEnd(16)} attached=${s.attached}   roles=${roles}`);
    });
  }
  lines.push("");
  lines.push("Pick:");
  lines.push("  <n>            attach by index");
  lines.push("  <name>         attach by name");
  lines.push("  n              new session (prompts for name)");
  lines.push("  /<command>     net/project/admin (try /help)");
  lines.push("  q              quit");
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

async function createSessionViaClient(
  client: BusClient,
  name: string,
  projectId: string | undefined,
): Promise<SessionMeta> {
  const r = await client.request({
    verb: "CREATE_SESSION",
    name,
    ...(projectId ? { projectId } : {}),
  });
  if (r.verb === "ERROR") throw new Error((r as { message: string }).message);
  if (r.verb !== "SESSION_CREATED") throw new Error(`unexpected: ${r.verb}`);
  return (r as SessionCreatedFrame).session;
}

