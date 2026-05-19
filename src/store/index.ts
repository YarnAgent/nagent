import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
import { ensureDir, readJson, writeJson } from "./json.js";
import type {
  ActiveState,
  NetMeta,
  NodeIdentity,
  Peer,
  Project,
} from "../types/index.js";

export async function ensureNagentRoot(): Promise<void> {
  const p = paths();
  await ensureDir(p.root);
  await ensureDir(p.netsDir);
  await ensureDir(p.sshDir);
}

// identity
export async function readIdentity(): Promise<NodeIdentity | undefined> {
  return readJson<NodeIdentity>(paths().identity);
}
export async function writeIdentity(id: NodeIdentity): Promise<void> {
  await writeJson(paths().identity, id);
}

// active state (which net / project is "current" globally on this node)
export async function readActiveState(): Promise<ActiveState> {
  return (await readJson<ActiveState>(paths().activeState)) ?? {};
}
export async function writeActiveState(state: ActiveState): Promise<void> {
  await writeJson(paths().activeState, state);
}

// nets
export async function listNets(): Promise<NetMeta[]> {
  const p = paths();
  try {
    const dirs = await fs.readdir(p.netsDir);
    const out: NetMeta[] = [];
    for (const d of dirs) {
      const meta = await readJson<NetMeta>(p.netMeta(d));
      if (meta) out.push(meta);
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
export async function readNetMeta(netId: string): Promise<NetMeta | undefined> {
  return readJson<NetMeta>(paths().netMeta(netId));
}
export async function writeNetMeta(meta: NetMeta): Promise<void> {
  await writeJson(paths().netMeta(meta.netId), meta);
}

// peers
export async function readPeers(netId: string): Promise<Peer[]> {
  return (await readJson<Peer[]>(paths().netPeers(netId))) ?? [];
}
export async function writePeers(netId: string, peers: Peer[]): Promise<void> {
  await writeJson(paths().netPeers(netId), peers);
}

// projects (catalog per net)
export async function readProjects(netId: string): Promise<Project[]> {
  return (await readJson<Project[]>(paths().netProjects(netId))) ?? [];
}
export async function writeProjects(netId: string, projects: Project[]): Promise<void> {
  await writeJson(paths().netProjects(netId), projects);
}
