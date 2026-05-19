import { promises as fs } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { PROJECT_MARKER_FILE } from "../platform/paths.js";
import { readJson, writeJson } from "../store/json.js";
import { readProjects, writeProjects } from "../store/index.js";
import type { Project, ProjectMarker } from "../types/index.js";

export function newProjectId(): string {
  return `p-${randomBytes(6).toString("hex")}`;
}

export async function readMarkerAt(dir: string): Promise<ProjectMarker | undefined> {
  return readJson<ProjectMarker>(join(dir, PROJECT_MARKER_FILE));
}

export async function writeMarkerAt(dir: string, marker: ProjectMarker): Promise<void> {
  await writeJson(join(dir, PROJECT_MARKER_FILE), marker);
}

/** Walk up from `start` until a directory containing `.nagent` is found, or root. */
export async function findProjectMarker(start: string): Promise<{ dir: string; marker: ProjectMarker } | undefined> {
  let dir = resolve(start);
  while (true) {
    const marker = await readMarkerAt(dir);
    if (marker) return { dir, marker };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function createProject(opts: {
  cwd: string;
  name: string;
  netId: string;
  nodeName: string;
  description?: string;
}): Promise<{ project: Project; marker: ProjectMarker }> {
  const existing = await readMarkerAt(opts.cwd);
  if (existing) {
    throw new Error(`a .nagent marker already exists at ${opts.cwd} (project ${existing.projectName})`);
  }
  const project: Project = {
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
  const marker: ProjectMarker = {
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
