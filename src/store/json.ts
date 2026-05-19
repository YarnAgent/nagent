import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(path, DIR_MODE);
  } catch {
    // ignore on filesystems that don't support chmod
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, body, { mode: FILE_MODE });
  try {
    await fs.chmod(tmp, FILE_MODE);
  } catch {
    // ignore
  }
  await fs.rename(tmp, path);
}

export { FILE_MODE, DIR_MODE };
