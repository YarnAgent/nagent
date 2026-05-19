import { createInterface } from "node:readline/promises";
import { BusClient } from "../bus/client.js";
import { createOrAttachTmuxSession } from "../session/index.js";
import { paths } from "../platform/paths.js";
import type { HelloFrame, ListResultFrame, SessionCreatedFrame } from "../types/index.js";

export interface PickerInput {
  ctx: { identity: { nodeName: string } | undefined };
  projectId?: string;
  cliOpts: { project?: string | false };
}

export async function runPicker(input: PickerInput): Promise<void> {
  const client = new BusClient();
  try {
    await client.connect();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      throw new Error(`cannot reach nagentd on ${paths().socket} — run \`nagent daemon --foreground\` first`);
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

  const list = await client.request({
    verb: "LIST",
    filter: input.projectId ? { project: input.projectId } : {},
  });
  if (list.verb !== "LIST_RESULT") throw new Error("LIST failed");
  const sessions = (list as ListResultFrame).sessions;
  client.close();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("nagent — pick a session\n");
    if (input.projectId) process.stdout.write(`(filtered to project ${input.projectId})\n`);
    process.stdout.write("\n");
    if (sessions.length === 0) {
      process.stdout.write("  (no sessions yet)\n\n");
    } else {
      sessions.forEach((s, i) => {
        process.stdout.write(
          `  ${String(i + 1).padStart(2)}) ${s.name}   project=${s.project ?? "-"}   attached=${s.attached}   roles=${s.roles.join(",") || "-"}\n`,
        );
      });
      process.stdout.write("\n");
    }
    process.stdout.write("  n) new session\n");
    process.stdout.write("  q) quit\n\n");
    const choice = (await rl.question("> ")).trim();
    rl.close();

    if (choice === "q" || choice === "") return;
    if (choice === "n") {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const name = (await rl2.question("session name: ")).trim();
      rl2.close();
      if (!name) {
        process.stderr.write("name required\n");
        process.exit(1);
      }
      const c2 = new BusClient();
      await c2.connect();
      const h = await c2.request(hello);
      if (h.verb !== "OK") throw new Error(`HELLO failed: ${h.verb}`);
      const created = await c2.request({
        verb: "CREATE_SESSION",
        name,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
      c2.close();
      if (created.verb === "ERROR") throw new Error((created as { message: string }).message);
      const meta = (created as SessionCreatedFrame).session;
      createOrAttachTmuxSession({
        sessionId: meta.sessionId,
        sessionDisplayName: meta.name,
        nodeName: input.ctx.identity?.nodeName ?? "node",
        ...(input.projectId ? { projectId: input.projectId } : {}),
        attach: true,
      });
      return;
    }

    const idx = parseInt(choice, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      const entry = sessions[idx - 1]!;
      // Re-resolve sessionId via daemon catalog file
      const fs = await import("node:fs/promises");
      const sessionsRaw = JSON.parse(await fs.readFile(paths().sessions, "utf8")) as Array<{ name: string; sessionId: string; projectId?: string }>;
      const full = sessionsRaw.find((s) => s.name === entry.name);
      if (!full) throw new Error(`session "${entry.name}" disappeared`);
      createOrAttachTmuxSession({
        sessionId: full.sessionId,
        sessionDisplayName: entry.name,
        nodeName: input.ctx.identity?.nodeName ?? "node",
        ...(full.projectId ? { projectId: full.projectId } : {}),
        attach: true,
      });
      return;
    }
    process.stderr.write(`unrecognized choice: ${choice}\n`);
    process.exit(1);
  } finally {
    try { rl.close(); } catch {}
  }
}
