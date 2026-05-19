#!/usr/bin/env node
import { Command } from "commander";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { resolve as resolvePath } from "node:path";
import { generateKeyPairSync, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ensureNagentRoot,
  readActiveState,
  writeActiveState,
  readIdentity,
  writeIdentity,
  listNets,
  readNetMeta,
  writeNetMeta,
  writePeers,
  readPeers,
  readProjects,
} from "../store/index.js";
import { writeJson } from "../store/json.js";
import { paths } from "../platform/paths.js";
import { BusClient } from "../bus/client.js";
import { runDaemon } from "../daemon/index.js";
import {
  createProject,
  findProjectMarker,
} from "../project/index.js";
import {
  checkTmuxVersion,
  createOrAttachTmuxSession,
  attachTmuxSession,
  tmuxSessionName,
} from "../session/index.js";
import type {
  BusFrame,
  HelloFrame,
  ListResultFrame,
  NodeIdentity,
  SessionCreatedFrame,
  SessionMeta,
} from "../types/index.js";
import { runPicker } from "./picker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0-unknown";
  }
}

interface CliContext {
  identity: NodeIdentity | undefined;
  activeNetId?: string;
  activeProjectId?: string;
  cwdProject: Awaited<ReturnType<typeof findProjectMarker>>;
}

async function loadContext(opts: { allowNoIdentity?: boolean } = {}): Promise<CliContext> {
  await ensureNagentRoot();
  const identity = await readIdentity();
  if (!identity && !opts.allowNoIdentity) {
    throw new Error("nagent is not initialized on this device — run `nagent init` first");
  }
  const active = await readActiveState();
  const cwdProject = await findProjectMarker(process.cwd());
  return {
    identity,
    ...(active.activeNetId ? { activeNetId: active.activeNetId } : {}),
    ...(active.activeProjectId ? { activeProjectId: active.activeProjectId } : {}),
    cwdProject,
  };
}

type ProjectOpt = { project?: string | false };

function activeProjectIdFromCtx(ctx: CliContext, cliOpts: ProjectOpt): string | undefined {
  if (cliOpts.project === false) return undefined; // --no-project
  if (typeof cliOpts.project === "string") return cliOpts.project;
  if (ctx.cwdProject) return ctx.cwdProject.marker.projectId;
  if (ctx.activeProjectId) return ctx.activeProjectId;
  return undefined;
}

async function withDaemon<T>(fn: (client: BusClient) => Promise<T>): Promise<T> {
  const client = new BusClient();
  try {
    await client.connect();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
      throw new Error(`cannot reach nagentd on ${paths().socket} — run \`nagent daemon --foreground\` in another terminal`);
    }
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function sendHelloAsCli(client: BusClient, ctx: CliContext): Promise<void> {
  const hello: HelloFrame = {
    verb: "HELLO",
    node: ctx.identity?.nodeName ?? "node",
    asCli: true,
    ...(process.env.NAGENT_SESSION ? { session: process.env.NAGENT_SESSION } : {}),
    ...(process.env.NAGENT_PROJECT ? { project: process.env.NAGENT_PROJECT } : {}),
  };
  const r = await client.request(hello);
  if (r.verb !== "OK") throw new Error(`HELLO failed: ${(r as { message?: string }).message ?? r.verb}`);
}

async function sendHelloAsSession(client: BusClient, sessionName: string, projectId: string | undefined, ctx: CliContext): Promise<void> {
  const hello: HelloFrame = {
    verb: "HELLO",
    node: ctx.identity?.nodeName ?? "node",
    session: sessionName,
    asCli: false,
    ...(projectId ? { project: projectId } : {}),
  };
  const r = await client.request(hello);
  if (r.verb !== "OK") throw new Error(`HELLO failed: ${(r as { message?: string }).message ?? r.verb}`);
}

// ----- commands -----

async function cmdInit(opts: { noService?: boolean; force?: boolean; name?: string }): Promise<void> {
  await ensureNagentRoot();
  const existing = await readIdentity();
  if (existing && !opts.force) {
    process.stderr.write(`nagent already initialized as node "${existing.nodeName}" (${existing.nodeId})\n`);
    return;
  }
  const nodeName = opts.name ?? process.env.NAGENT_NODE_NAME ?? hostname() ?? "node";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const nodeId = createHash("sha256").update(pubDer).digest("hex").slice(0, 16);

  const identity: NodeIdentity = {
    nodeId,
    nodeName,
    ed25519Pub: pubDer.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  await writeIdentity(identity);

  await fs.mkdir(paths().sshDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths().sshKey, privPem, { mode: 0o600 });
  await fs.writeFile(paths().sshPub, identity.ed25519Pub + "\n", { mode: 0o644 });

  process.stdout.write(`initialized nagent as node "${nodeName}" (${nodeId})\n`);
  process.stdout.write(`  config: ${paths().root}\n`);
  if (!opts.noService) {
    process.stdout.write(`  note: service installation (launchd/systemd) is deferred in v0.1.\n`);
    process.stdout.write(`        run \`nagent daemon --foreground\` to start the daemon.\n`);
  }
}

async function cmdNetCreate(name: string): Promise<void> {
  const ctx = await loadContext();
  const id = ctx.identity!;
  const netId = `n-${randomBytes(6).toString("hex")}`;
  const meta = {
    netId,
    name,
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
  process.stdout.write(`created net "${name}" (${netId}); now active\n`);
}

async function cmdNetStatus(): Promise<void> {
  const ctx = await loadContext();
  if (!ctx.activeNetId) {
    process.stdout.write("no active net — run `nagent net create <name>`\n");
    return;
  }
  const meta = await readNetMeta(ctx.activeNetId);
  const peers = await readPeers(ctx.activeNetId);
  process.stdout.write(`net: ${meta?.name} (${ctx.activeNetId})\n`);
  process.stdout.write(`origin: ${meta?.originNode}\n`);
  process.stdout.write(`peers (${peers.length}):\n`);
  for (const p of peers) process.stdout.write(`  - ${p.nodeName}\n`);
}

async function cmdNetList(): Promise<void> {
  const nets = await listNets();
  if (nets.length === 0) {
    process.stdout.write("no nets — run `nagent net create <name>`\n");
    return;
  }
  for (const n of nets) {
    process.stdout.write(`${n.netId}  ${n.name}  (origin ${n.originNode})\n`);
  }
}

async function cmdProjectInit(name: string, opts: { description?: string }): Promise<void> {
  const ctx = await loadContext();
  if (!ctx.activeNetId) throw new Error("no active net — run `nagent net create <name>` first");
  const id = ctx.identity!;
  const { project } = await createProject({
    cwd: process.cwd(),
    name,
    netId: ctx.activeNetId,
    nodeName: id.nodeName,
    ...(opts.description ? { description: opts.description } : {}),
  });
  await writeActiveState({ activeNetId: ctx.activeNetId, activeProjectId: project.projectId });
  process.stdout.write(`created project "${name}" (${project.projectId})\n`);
  process.stdout.write(`  marker: ${process.cwd()}/.nagent\n`);
}

async function cmdProjectList(): Promise<void> {
  const ctx = await loadContext();
  if (!ctx.activeNetId) {
    process.stdout.write("no active net\n");
    return;
  }
  const projects = await readProjects(ctx.activeNetId);
  if (projects.length === 0) {
    process.stdout.write("no projects in this net\n");
    return;
  }
  for (const p of projects) {
    const marker = ctx.cwdProject?.marker.projectId === p.projectId ? "  *cwd" : "";
    const active = ctx.activeProjectId === p.projectId ? "  *active" : "";
    process.stdout.write(`${p.projectId}  ${p.name}${active}${marker}\n`);
  }
}

async function cmdProjectSwitch(idOrName: string): Promise<void> {
  const ctx = await loadContext();
  if (!ctx.activeNetId) throw new Error("no active net");
  const projects = await readProjects(ctx.activeNetId);
  const project = projects.find((p) => p.projectId === idOrName || p.name === idOrName);
  if (!project) throw new Error(`unknown project: ${idOrName}`);
  await writeActiveState({ activeNetId: ctx.activeNetId, activeProjectId: project.projectId });
  process.stdout.write(`active project → ${project.name} (${project.projectId})\n`);
}

async function cmdNew(name: string, opts: { project?: string | false; attach?: boolean }): Promise<void> {
  const tmuxOk = checkTmuxVersion();
  if (!tmuxOk.ok) throw new Error(`tmux check failed: ${tmuxOk.reason}`);
  const ctx = await loadContext();
  const projectId = activeProjectIdFromCtx(ctx, opts);
  const meta = await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const created = await client.request({ verb: "CREATE_SESSION", name, ...(projectId ? { projectId } : {}) });
    if (created.verb === "ERROR") throw new Error((created as { message: string }).message);
    if (created.verb !== "SESSION_CREATED") throw new Error(`unexpected response: ${created.verb}`);
    return (created as SessionCreatedFrame).session;
  });
  process.stdout.write(`created session "${meta.name}" (${meta.sessionId})${projectId ? ` in project ${projectId}` : ""}\n`);
  createOrAttachTmuxSession({
    sessionId: meta.sessionId,
    sessionDisplayName: meta.name,
    nodeName: ctx.identity!.nodeName,
    ...(projectId ? { projectId } : {}),
    attach: opts.attach !== false,
  });
}

async function cmdAttach(name: string): Promise<void> {
  const ctx = await loadContext();
  const meta = await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const r = await client.request({ verb: "LIST" });
    if (r.verb !== "LIST_RESULT") throw new Error("LIST failed");
    const entry = (r as ListResultFrame).sessions.find((s) => s.name === name);
    if (!entry) throw new Error(`unknown session: ${name}`);
    return entry;
  });
  const target = tmuxSessionName(meta.address.split("/")[1]!); // not perfect — improve below
  // Better: just attach by the user-visible name; tmux session name = s-<sessionId>
  // We need the sessionId — get it from the catalog file directly for correctness.
  const sessionsRaw = JSON.parse(await fs.readFile(paths().sessions, "utf8")) as SessionMeta[];
  const fullMeta = sessionsRaw.find((s) => s.name === name);
  if (!fullMeta) throw new Error(`session "${name}" disappeared`);
  attachTmuxSession(tmuxSessionName(fullMeta.sessionId));
  // unreachable
  void target;
}

async function cmdList(opts: { project?: string | false; all?: boolean }): Promise<void> {
  const ctx = await loadContext();
  const projectId = opts.all ? undefined : activeProjectIdFromCtx(ctx, opts);
  await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const r = await client.request({ verb: "LIST", filter: projectId ? { project: projectId } : { all: !!opts.all } });
    if (r.verb !== "LIST_RESULT") throw new Error("LIST failed");
    const sessions = (r as ListResultFrame).sessions;
    if (sessions.length === 0) {
      process.stdout.write("(no sessions)\n");
      return;
    }
    const widths = {
      name: Math.max(4, ...sessions.map((s) => s.name.length)),
      addr: Math.max(7, ...sessions.map((s) => s.address.length)),
      proj: Math.max(7, ...sessions.map((s) => (s.project ?? "-").length)),
    };
    process.stdout.write(`${"NAME".padEnd(widths.name)}  ${"ADDRESS".padEnd(widths.addr)}  ${"PROJECT".padEnd(widths.proj)}  ATT  ROLES\n`);
    for (const s of sessions) {
      const roles = s.roles.length ? s.roles.join(",") : "-";
      process.stdout.write(
        `${s.name.padEnd(widths.name)}  ${s.address.padEnd(widths.addr)}  ${(s.project ?? "-").padEnd(widths.proj)}  ${String(s.attached).padStart(3)}  ${roles}\n`,
      );
    }
  });
}

async function cmdClose(name?: string): Promise<void> {
  const ctx = await loadContext();
  const target = name ?? process.env.NAGENT_SESSION;
  if (!target) throw new Error("`nagent close` from outside a session needs an explicit <name>");
  await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const r = await client.request({ verb: "CLOSE_SESSION", name: target });
    if (r.verb === "ERROR") throw new Error((r as { message: string }).message);
  });
  process.stdout.write(`closed session "${target}"\n`);
}

async function cmdSend(addr: string, payload: string | undefined): Promise<void> {
  const ctx = await loadContext();
  let body: unknown;
  if (payload === undefined) {
    const raw = await readStdin();
    body = tryParseJson(raw);
  } else {
    body = tryParseJson(payload);
  }
  const msgId = randomUUID();
  await withDaemon(async (client) => {
    if (process.env.NAGENT_SESSION) {
      await sendHelloAsSession(client, process.env.NAGENT_SESSION, process.env.NAGENT_PROJECT, ctx);
    } else {
      await sendHelloAsCli(client, ctx);
    }
    const r = await client.request({
      verb: "SEND",
      to: addr,
      payload: body,
      msgId,
      hops: 0,
    });
    if (r.verb === "ERROR") throw new Error((r as { message: string }).message);
    if (r.verb !== "ACK") throw new Error(`unexpected response: ${r.verb}`);
  });
  process.stdout.write(`sent (${msgId}) to ${addr}\n`);
}

async function cmdRecv(opts: { subscribe?: string; timeout?: string; count?: string }): Promise<void> {
  const ctx = await loadContext();
  const limit = opts.count ? parseInt(opts.count, 10) : Infinity;
  const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) : 0;
  let received = 0;
  const client = new BusClient();
  await client.connect();
  try {
    if (process.env.NAGENT_SESSION) {
      await sendHelloAsSession(client, process.env.NAGENT_SESSION, process.env.NAGENT_PROJECT, ctx);
    } else {
      await sendHelloAsCli(client, ctx);
    }
    if (opts.subscribe) {
      const r = await client.request({ verb: "SUBSCRIBE", pattern: opts.subscribe });
      if (r.verb !== "OK") throw new Error(`SUBSCRIBE failed: ${r.verb}`);
    }
    await new Promise<void>((resolve) => {
      const timer = timeoutMs > 0 ? setTimeout(() => resolve(), timeoutMs) : null;
      client.on("frame", (frame: BusFrame) => {
        if (frame.verb === "RECV" || frame.verb === "RECV_DROPPED") {
          process.stdout.write(JSON.stringify(frame) + "\n");
          received++;
          if (received >= limit) {
            if (timer) clearTimeout(timer);
            resolve();
          }
        }
      });
      client.on("close", () => resolve());
    });
  } finally {
    client.close();
  }
}

async function cmdRegisterRole(role: string): Promise<void> {
  const ctx = await loadContext();
  const session = process.env.NAGENT_SESSION;
  if (!session) throw new Error("`nagent register-role` must be run inside a session (NAGENT_SESSION not set)");
  await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const r = await client.request({ verb: "REGISTER_ROLE", session, role });
    if (r.verb === "ERROR") throw new Error((r as { message: string }).message);
  });
  process.stdout.write(`registered role "${role}" on session ${session}\n`);
}

async function cmdDaemon(opts: { foreground?: boolean }): Promise<void> {
  if (!opts.foreground) {
    process.stderr.write("background daemon mode is not implemented in v0.1; use --foreground\n");
    process.exit(2);
  }
  await runDaemon({ foreground: true });
}

function deferredStub(verbName: string): () => never {
  return () => {
    process.stderr.write(`\`${verbName}\` is deferred to v0.2 (multi-node mesh)\n`);
    process.exit(64);
  };
}

// ----- helpers -----

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function tryParseJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function cmdPickerEntry(opts: { project?: string | false }): Promise<void> {
  if (process.env.NAGENT_SESSION) {
    process.stderr.write(
      `you're attached to ${process.env.NAGENT_NODE ?? "?"}/${process.env.NAGENT_SESSION}; ` +
        `Ctrl-B d to detach, \`nagent close\` to destroy\n`,
    );
    process.exit(1);
  }
  const ctx = await loadContext();
  const projectId = activeProjectIdFromCtx(ctx, opts);
  await runPicker({ ctx, projectId, cliOpts: opts });
}

// ----- main -----

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("nagent")
    .description("agent net — decentralized mesh for cooperating agents (v0.1: single-node)")
    .version(readPackageVersion())
    .option("-p, --project <id>", "operate within a specific project")
    .option("--no-project", "ignore active project context");

  program.action(async (opts: { project?: string | false }) => {
    await cmdPickerEntry(opts);
  });

  program
    .command("init")
    .description("initialize this device as a node")
    .option("--no-service", "skip service install (default in v0.1)")
    .option("--force", "overwrite existing identity")
    .option("--name <name>", "set the node name (defaults to hostname)")
    .action(async (opts) => {
      await cmdInit(opts);
    });

  program
    .command("daemon")
    .description("run nagentd")
    .option("--foreground", "run in the foreground (recommended in v0.1)")
    .action(async (opts) => {
      await cmdDaemon(opts);
    });

  const net = program.command("net").description("net commands");
  net
    .command("create <name>")
    .description("create a new net (v0.1: of size 1)")
    .action(async (name: string) => { await cmdNetCreate(name); });
  net.command("status").description("show active net").action(async () => { await cmdNetStatus(); });
  net.command("list").description("list known nets").action(async () => { await cmdNetList(); });

  const project = program.command("project").description("project commands");
  project
    .command("init <name>")
    .option("-d, --description <text>")
    .description("create a project rooted at cwd (writes .nagent)")
    .action(async (name: string, opts: { description?: string }) => { await cmdProjectInit(name, opts); });
  project.command("list").description("list projects in active net").action(async () => { await cmdProjectList(); });
  project
    .command("switch <idOrName>")
    .description("set active project (does not change cwd)")
    .action(async (x: string) => { await cmdProjectSwitch(x); });
  project.command("clone <projectId> [path]").description("[deferred] fetch a project from a peer").action(deferredStub("project clone"));

  program
    .command("new <name>")
    .description("create a session and attach")
    .option("--no-attach", "create but don't attach (useful in scripts)")
    .option("-p, --project <id>", "tag with a specific project")
    .option("--no-project", "do not tag with a project")
    .action(async (name: string, opts: { attach?: boolean; project?: string | false }) => {
      await cmdNew(name, opts);
    });

  program
    .command("attach <name>")
    .description("attach to an existing session")
    .action(async (name: string) => { await cmdAttach(name); });

  program
    .command("list")
    .description("list sessions")
    .option("-p, --project <id>", "filter by project")
    .option("-a, --all", "show all projects")
    .action(async (opts) => { await cmdList(opts); });

  program
    .command("close [name]")
    .description("close a session (default: current session)")
    .action(async (name?: string) => { await cmdClose(name); });

  program
    .command("send <addr> [payload]")
    .description("send a message on the bus (payload from stdin if omitted)")
    .action(async (addr: string, payload?: string) => { await cmdSend(addr, payload); });

  program
    .command("recv")
    .description("receive bus messages (blocks unless --count or --timeout)")
    .option("-s, --subscribe <pattern>", "additional address pattern to receive on")
    .option("-t, --timeout <ms>", "stop after N ms")
    .option("-n, --count <n>", "stop after N frames")
    .action(async (opts) => { await cmdRecv(opts); });

  program
    .command("register-role <role>")
    .description("tag the current session with a role (e.g. agent-alpha)")
    .action(async (role: string) => { await cmdRegisterRole(role); });

  // Deferred verbs — keep the surface stable.
  program.command("invite").description("[deferred] issue an invite token").action(deferredStub("invite"));
  program.command("join <token>").description("[deferred] join a net via invite").action(deferredStub("join"));
  program.command("web").description("[deferred] start the browser stream").action(deferredStub("web"));
  program
    .command("install-service")
    .description("[deferred] install platform daemon unit")
    .action(deferredStub("install-service"));
  program
    .command("uninstall-service")
    .description("[deferred] remove platform daemon unit")
    .action(deferredStub("uninstall-service"));

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
