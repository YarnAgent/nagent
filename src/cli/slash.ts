import { randomBytes } from "node:crypto";
import {
  listNets,
  readActiveState,
  readIdentity,
  readNetMeta,
  readPeers,
  readProjects,
  writeActiveState,
  writeNetMeta,
  writePeers,
} from "../store/index.js";
import { writeJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
import { createProject } from "../project/index.js";
import { generateInvite } from "./invite.js";
import { cmdJoin } from "./join.js";

export interface SlashOutcome {
  /** Exit the picker REPL after this command. */
  exitPicker?: boolean;
  /** Skip re-rendering (the command already printed everything). */
  silent?: boolean;
}

export type SlashHandler = (args: string[], out: SlashOut) => Promise<SlashOutcome | void>;

export interface SlashOut {
  log: (line: string) => void;
  err: (line: string) => void;
}

interface SlashEntry {
  verb: string;
  sub?: string;
  argHint: string;
  description: string;
  handler: SlashHandler;
}

function deferredHandler(verbLabel: string, version: string): SlashHandler {
  return async (_args, out) => {
    out.log(`[${version}] \`${verbLabel}\` is not yet implemented in v0.1`);
    return {};
  };
}

const TABLE: SlashEntry[] = [
  {
    verb: "help",
    argHint: "",
    description: "show this index",
    handler: async (_args, out) => {
      out.log("slash commands:");
      for (const entry of TABLE) {
        const head = entry.sub ? `/${entry.verb} ${entry.sub}` : `/${entry.verb}`;
        const sig = entry.argHint ? `${head} ${entry.argHint}` : head;
        out.log(`  ${sig.padEnd(34)} — ${entry.description}`);
      }
      return { silent: true };
    },
  },

  // net
  {
    verb: "net",
    sub: "create",
    argHint: "<name>",
    description: "create a net (sets it active)",
    handler: async (args, out) => {
      const name = args[0];
      if (!name) { out.err("usage: /net create <name>"); return {}; }
      const id = (await readIdentity());
      if (!id) { out.err("no identity yet (bootstrap should have created one)"); return {}; }
      const netId = `n-${randomBytes(6).toString("hex")}`;
      const meta = { netId, name, createdAt: new Date().toISOString(), originNode: id.nodeName };
      await writeNetMeta(meta);
      await writePeers(netId, [{ nodeName: id.nodeName, pubKey: id.ed25519Pub, addresses: [], roles: [], lastSeen: meta.createdAt }]);
      await writeJson(paths().netAuthority(netId), { originPubKey: id.ed25519Pub, delegations: [] });
      await writeJson(paths().netProjects(netId), []);
      await writeActiveState({ activeNetId: netId });
      out.log(`created net "${name}" (${netId}); now active`);
      return {};
    },
  },
  {
    verb: "net",
    sub: "status",
    argHint: "",
    description: "show active net + peers",
    handler: async (_args, out) => {
      const state = await readActiveState();
      if (!state.activeNetId) { out.log("no active net"); return {}; }
      const meta = await readNetMeta(state.activeNetId);
      const peers = await readPeers(state.activeNetId);
      out.log(`net: ${meta?.name} (${state.activeNetId})`);
      out.log(`origin: ${meta?.originNode}`);
      out.log(`peers (${peers.length}):`);
      for (const p of peers) out.log(`  - ${p.nodeName}`);
      return {};
    },
  },
  {
    verb: "net",
    sub: "list",
    argHint: "",
    description: "list known nets",
    handler: async (_args, out) => {
      const nets = await listNets();
      if (nets.length === 0) { out.log("(no nets)"); return {}; }
      const active = (await readActiveState()).activeNetId;
      for (const n of nets) {
        const flag = n.netId === active ? "  *active" : "";
        out.log(`${n.netId}  ${n.name}  (origin ${n.originNode})${flag}`);
      }
      return {};
    },
  },
  {
    verb: "net",
    sub: "switch",
    argHint: "<id|name>",
    description: "set the active net",
    handler: async (args, out) => {
      const x = args[0];
      if (!x) { out.err("usage: /net switch <id|name>"); return {}; }
      const nets = await listNets();
      const found = nets.find((n) => n.netId === x || n.name === x);
      if (!found) { out.err(`unknown net: ${x}`); return {}; }
      await writeActiveState({ activeNetId: found.netId });
      out.log(`active net → ${found.name} (${found.netId})`);
      return {};
    },
  },

  // project
  {
    verb: "project",
    sub: "init",
    argHint: "<name>",
    description: "create a project rooted at cwd (writes .nagent)",
    handler: async (args, out) => {
      const name = args[0];
      if (!name) { out.err("usage: /project init <name>"); return {}; }
      const state = await readActiveState();
      if (!state.activeNetId) { out.err("no active net"); return {}; }
      const id = (await readIdentity())!;
      try {
        const { project } = await createProject({
          cwd: process.cwd(),
          name,
          netId: state.activeNetId,
          nodeName: id.nodeName,
        });
        await writeActiveState({ activeNetId: state.activeNetId, activeProjectId: project.projectId });
        out.log(`created project "${name}" (${project.projectId})`);
        out.log(`  marker: ${process.cwd()}/.nagent`);
      } catch (err) {
        out.err((err as Error).message);
      }
      return {};
    },
  },
  {
    verb: "project",
    sub: "list",
    argHint: "",
    description: "list projects in the active net",
    handler: async (_args, out) => {
      const state = await readActiveState();
      if (!state.activeNetId) { out.log("no active net"); return {}; }
      const projects = await readProjects(state.activeNetId);
      if (projects.length === 0) { out.log("(no projects)"); return {}; }
      for (const p of projects) {
        const flag = p.projectId === state.activeProjectId ? "  *active" : "";
        out.log(`${p.projectId}  ${p.name}${flag}`);
      }
      return {};
    },
  },
  {
    verb: "project",
    sub: "switch",
    argHint: "<id|name>",
    description: "set the active project (does not change cwd)",
    handler: async (args, out) => {
      const x = args[0];
      if (!x) { out.err("usage: /project switch <id|name>"); return {}; }
      const state = await readActiveState();
      if (!state.activeNetId) { out.err("no active net"); return {}; }
      const projects = await readProjects(state.activeNetId);
      const found = projects.find((p) => p.projectId === x || p.name === x);
      if (!found) { out.err(`unknown project: ${x}`); return {}; }
      await writeActiveState({ activeNetId: state.activeNetId, activeProjectId: found.projectId });
      out.log(`active project → ${found.name} (${found.projectId})`);
      return {};
    },
  },
  {
    verb: "project",
    sub: "clone",
    argHint: "<projectId> [path]",
    description: "[v0.2] fetch a project from a peer",
    handler: deferredHandler("project clone", "v0.2"),
  },

  // invite / join (real handlers in v0.2)
  {
    verb: "invite",
    argHint: "[--expires 1h] [--addr host[:port]]",
    description: "issue an invite token for another device to join this net",
    handler: async (args, out) => {
      const opts = parseInviteArgs(args);
      try {
        const r = await generateInvite(opts);
        out.log("");
        out.log("invite token (paste on the joining device):");
        out.log("");
        out.log("  " + r.token);
        out.log("");
        out.log(`  inviteId: ${r.inviteId}`);
        out.log(`  expires:  ${r.expiresAt}`);
        out.log("");
        out.log("on the joiner: nagent join <token>");
      } catch (err) { out.err((err as Error).message); }
      return {};
    },
  },
  {
    verb: "join",
    argHint: "<token>",
    description: "join an existing net via an invite token",
    handler: async (args, out) => {
      const token = args[0];
      if (!token) { out.err("usage: /join <token>"); return {}; }
      try { await cmdJoin(token); } catch (err) { out.err((err as Error).message); }
      return {};
    },
  },
  { verb: "web",              argHint: "",          description: "[v0.3] start the browser stream", handler: deferredHandler("web", "v0.3") },
  { verb: "install-service",  argHint: "",          description: "[v0.3] install platform daemon unit", handler: deferredHandler("install-service", "v0.3") },
  { verb: "uninstall-service",argHint: "",          description: "[v0.3] remove platform daemon unit", handler: deferredHandler("uninstall-service", "v0.3") },

  // quit
  {
    verb: "quit",
    argHint: "",
    description: "exit the picker",
    handler: async () => ({ exitPicker: true, silent: true }),
  },
  {
    verb: "q",
    argHint: "",
    description: "exit the picker (alias)",
    handler: async () => ({ exitPicker: true, silent: true }),
  },
];

/** Run a slash line (without the leading `/`). Returns the handler's outcome. */
export async function dispatchSlash(line: string, out: SlashOut): Promise<SlashOutcome> {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const verb = tokens[0]!;
  // Try verb+sub first (e.g., "net create"), then verb alone.
  const sub = tokens[1];
  const entry =
    (sub && TABLE.find((e) => e.verb === verb && e.sub === sub)) ||
    TABLE.find((e) => e.verb === verb && !e.sub);
  if (!entry) {
    out.err(`unknown slash command: ${line} (try /help)`);
    return {};
  }
  const argsStart = entry.sub ? 2 : 1;
  const args = tokens.slice(argsStart);
  const r = await entry.handler(args, out);
  return r ?? {};
}

/** Used by tests + /help to enumerate the table. */
export function slashCommands(): ReadonlyArray<{ verb: string; sub?: string; description: string }> {
  return TABLE.map((e) => ({ verb: e.verb, ...(e.sub !== undefined ? { sub: e.sub } : {}), description: e.description }));
}

function parseInviteArgs(args: string[]): { expires?: string; addr?: string[]; tag?: string[] } {
  const out: { expires?: string; addr?: string[]; tag?: string[] } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--expires" && args[i + 1]) { out.expires = args[++i]; continue; }
    if (a === "--addr" && args[i + 1]) {
      (out.addr ||= []).push(args[++i]!); continue;
    }
    if (a === "--tag" && args[i + 1]) {
      (out.tag ||= []).push(args[++i]!); continue;
    }
  }
  return out;
}
