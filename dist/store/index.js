import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
import { ensureDir, readJson, writeJson } from "./json.js";
export async function ensureNagentRoot() {
    const p = paths();
    await ensureDir(p.root);
    await ensureDir(p.netsDir);
    await ensureDir(p.sshDir);
}
// identity
export async function readIdentity() {
    return readJson(paths().identity);
}
export async function writeIdentity(id) {
    await writeJson(paths().identity, id);
}
// active state (which net / project is "current" globally on this node)
export async function readActiveState() {
    return (await readJson(paths().activeState)) ?? {};
}
export async function writeActiveState(state) {
    await writeJson(paths().activeState, state);
}
// nets
export async function listNets() {
    const p = paths();
    try {
        const dirs = await fs.readdir(p.netsDir);
        const out = [];
        for (const d of dirs) {
            const meta = await readJson(p.netMeta(d));
            if (meta)
                out.push(meta);
        }
        return out;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return [];
        throw err;
    }
}
export async function readNetMeta(netId) {
    return readJson(paths().netMeta(netId));
}
export async function writeNetMeta(meta) {
    await writeJson(paths().netMeta(meta.netId), meta);
}
// peers
export async function readPeers(netId) {
    return (await readJson(paths().netPeers(netId))) ?? [];
}
export async function writePeers(netId, peers) {
    await writeJson(paths().netPeers(netId), peers);
}
// projects (catalog per net)
export async function readProjects(netId) {
    return (await readJson(paths().netProjects(netId))) ?? [];
}
export async function writeProjects(netId, projects) {
    await writeJson(paths().netProjects(netId), projects);
}
// invites (issued by this node)
export async function readInvites() {
    return (await readJson(paths().invites)) ?? [];
}
export async function writeInvites(records) {
    await writeJson(paths().invites, records);
}
//# sourceMappingURL=index.js.map