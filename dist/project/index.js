import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { PROJECT_MARKER_FILE } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import { readProjects, writeProjects } from "../store/index.js";
export function newProjectId() {
    return `p-${randomBytes(6).toString("hex")}`;
}
export async function readMarkerAt(dir) {
    try {
        return await readJson(join(dir, PROJECT_MARKER_FILE));
    }
    catch (err) {
        // The marker name `.nagent` collides with the user's nagent home directory
        // (typically `~/.nagent`). When `findProjectMarker` walks up through that
        // ancestor it would otherwise EISDIR. Treat directory collisions as "not a
        // marker, keep walking".
        if (err.code === "EISDIR")
            return undefined;
        throw err;
    }
}
export async function writeMarkerAt(dir, marker) {
    await writeJson(join(dir, PROJECT_MARKER_FILE), marker);
}
/** Walk up from `start` until a directory containing `.nagent` is found, or root. */
export async function findProjectMarker(start) {
    let dir = resolve(start);
    while (true) {
        const marker = await readMarkerAt(dir);
        if (marker)
            return { dir, marker };
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
export async function createProject(opts) {
    const existing = await readMarkerAt(opts.cwd);
    if (existing) {
        throw new Error(`a .nagent marker already exists at ${opts.cwd} (project ${existing.projectName})`);
    }
    const project = {
        projectId: newProjectId(),
        name: opts.name,
        netId: opts.netId,
        createdAt: new Date().toISOString(),
        createdByNode: opts.nodeName,
        ...(opts.description ? { description: opts.description } : {}),
    };
    const projects = await readProjects(opts.netId);
    if (projects.some((p) => p.name === opts.name)) {
        throw new Error(`project name "${opts.name}" already exists in this net`);
    }
    projects.push(project);
    await writeProjects(opts.netId, projects);
    const marker = {
        version: 1,
        netId: project.netId,
        projectId: project.projectId,
        projectName: project.name,
        createdAt: project.createdAt,
        createdByNode: project.createdByNode,
    };
    await writeMarkerAt(opts.cwd, marker);
    return { project, marker };
}
export { readProjects, writeProjects } from "../store/index.js";
//# sourceMappingURL=index.js.map