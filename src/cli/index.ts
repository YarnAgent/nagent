#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ensureNagentRoot,
  readActiveState,
  readIdentity,
} from "../store/index.js";
import { paths } from "../platform/paths.js";
import { BusClient } from "../bus/client.js";
import { runDaemon } from "../daemon/index.js";
import { findProjectMarker } from "../project/index.js";
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
} from "../types/index.js";
import { runPicker } from "./picker.js";
import { bootstrap } from "./bootstrap.js";

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

async function loadContext(): Promise<CliContext> {
  await ensureNagentRoot();
  const identity = await readIdentity();
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
  if (cliOpts.project === false) return undefined;
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
      throw new Error(`cannot reach nagentd on ${paths().socket}`);
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
    nodeName: ctx.identity?.nodeName ?? "node",
    ...(projectId ? { projectId } : {}),
    attach: opts.attach !== false,
  });
}

async function cmdAttach(name: string): Promise<void> {
  const ctx = await loadContext();
  const entry = await withDaemon(async (client) => {
    await sendHelloAsCli(client, ctx);
    const r = await client.request({ verb: "LIST", filter: { all: true } });
    if (r.verb !== "LIST_RESULT") throw new Error("LIST failed");
    const found = (r as ListResultFrame).sessions.find((s) => s.name === name);
    if (!found) throw new Error(`unknown session: ${name}`);
    return found;
  });
  attachTmuxSession(tmuxSessionName(entry.sessionId));
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
    process.stderr.write("background daemon mode is not implemented; use --foreground\n");
    process.exit(2);
  }
  await runDaemon({ foreground: true });
}

async function cmdPickerEntry(): Promise<void> {
  if (process.env.NAGENT_SESSION) {
    process.stderr.write(
      `you're attached to ${process.env.NAGENT_NODE ?? "?"}/${process.env.NAGENT_SESSION}; ` +
        `Ctrl-B d to detach, \`nagent close\` to destroy\n`,
    );
    process.exit(1);
  }
  const ctx = await loadContext();
  await runPicker({ ctx });
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

/**
 * Wrap an action with auto-bootstrap. Used by every subcommand except `daemon`,
 * which manages its own lifecycle.
 */
function bootstrapped<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    await bootstrap();
    return fn(...args);
  };
}

// ----- main -----

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("nagent")
    .description("agent net — decentralized mesh for cooperating agents (v0.1: single-node)")
    .version(readPackageVersion());

  program.action(bootstrapped(async () => {
    await cmdPickerEntry();
  }));

  program
    .command("daemon")
    .description("run nagentd (use --foreground for log visibility; auto-spawned otherwise)")
    .option("--foreground", "run in the foreground")
    .action(async (opts: { foreground?: boolean }) => {
      // The daemon command must not auto-spawn another daemon.
      process.env.NAGENT_NO_BOOTSTRAP = "1";
      await ensureNagentRoot();
      await cmdDaemon(opts);
    });

  program
    .command("new <name>")
    .description("create a session and attach")
    .option("--no-attach", "create but don't attach (useful in scripts)")
    .option("-p, --project <id>", "tag with a specific project")
    .option("--no-project", "do not tag with a project")
    .action(bootstrapped(async (name: string, opts: { attach?: boolean; project?: string | false }) => {
      await cmdNew(name, opts);
    }));

  program
    .command("attach <name>")
    .description("attach to an existing session")
    .action(bootstrapped(async (name: string) => { await cmdAttach(name); }));

  const listCmd = program
    .command("list")
    .alias("ls")
    .description("list sessions")
    .option("-p, --project <id>", "filter by project")
    .option("-a, --all", "show all projects")
    .action(bootstrapped(async (opts: { project?: string | false; all?: boolean }) => { await cmdList(opts); }));
  void listCmd;

  program
    .command("close [name]")
    .description("close a session (default: current session)")
    .action(bootstrapped(async (name?: string) => { await cmdClose(name); }));

  program
    .command("send <addr> [payload]")
    .description("send a message on the bus (payload from stdin if omitted)")
    .action(bootstrapped(async (addr: string, payload?: string) => { await cmdSend(addr, payload); }));

  program
    .command("recv")
    .description("receive bus messages (blocks unless --count or --timeout)")
    .option("-s, --subscribe <pattern>", "additional address pattern to receive on")
    .option("-t, --timeout <ms>", "stop after N ms")
    .option("-n, --count <n>", "stop after N frames")
    .action(bootstrapped(async (opts: { subscribe?: string; timeout?: string; count?: string }) => { await cmdRecv(opts); }));

  program
    .command("register-role <role>")
    .description("tag the current session with a role (e.g. agent-alpha)")
    .action(bootstrapped(async (role: string) => { await cmdRegisterRole(role); }));

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
