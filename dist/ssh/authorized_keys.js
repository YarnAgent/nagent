import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const FENCE_OPEN = "# >>> nagent managed (do not edit) >>>";
const FENCE_CLOSE = "# <<< nagent managed <<<";
export function authorizedKeysPath() {
    const override = process.env.NAGENT_AUTHORIZED_KEYS_PATH;
    if (override && override.length > 0)
        return override;
    return join(homedir(), ".ssh", "authorized_keys");
}
function parse(content) {
    const lines = content.length === 0 ? [] : content.split("\n");
    // Note: split on '\n' leaves a trailing '' for files ending with a newline.
    const out = { before: [], inside: [], after: [], hadFence: false };
    let phase = "before";
    for (const line of lines) {
        if (phase === "before") {
            if (line === FENCE_OPEN) {
                phase = "inside";
                out.hadFence = true;
                continue;
            }
            out.before.push(line);
        }
        else if (phase === "inside") {
            if (line === FENCE_CLOSE) {
                phase = "after";
                continue;
            }
            out.inside.push(line);
        }
        else {
            out.after.push(line);
        }
    }
    return out;
}
function render(p) {
    const parts = [];
    if (p.before.length)
        parts.push(p.before.join("\n"));
    parts.push(FENCE_OPEN);
    if (p.inside.length)
        parts.push(p.inside.join("\n"));
    parts.push(FENCE_CLOSE);
    if (p.after.length)
        parts.push(p.after.join("\n"));
    // Always end the file with a newline.
    let out = parts.join("\n");
    if (!out.endsWith("\n"))
        out += "\n";
    return out;
}
/** Tag goes in the line's trailing comment field: `# nagent-tag=<tag>`. */
function lineWithTag(line, tag) {
    return `${line.trim()}  # nagent-tag=${tag}`;
}
function tagOf(line) {
    const m = /\bnagent-tag=([^\s]+)/.exec(line);
    return m?.[1];
}
async function readFileOrEmpty(path) {
    try {
        return await fs.readFile(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return "";
        throw err;
    }
}
async function writeKeysFile(path, content) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, content, { mode: 0o600 });
}
/**
 * Append `line` (an SSH authorized_keys line, e.g. `ssh-ed25519 ...`) inside the
 * nagent fenced block, tagged with `tag`. If a line with the same tag already
 * exists, it is replaced (idempotent).
 */
export async function appendAuthorizedKey(args) {
    const path = args.path ?? authorizedKeysPath();
    const content = await readFileOrEmpty(path);
    const parsed = parse(content);
    const tagged = lineWithTag(args.line, args.tag);
    const idx = parsed.inside.findIndex((l) => tagOf(l) === args.tag);
    if (idx >= 0)
        parsed.inside[idx] = tagged;
    else
        parsed.inside.push(tagged);
    await writeKeysFile(path, render(parsed));
}
/** Remove the line with the given tag. No-op if not present. */
export async function removeAuthorizedKey(args) {
    const path = args.path ?? authorizedKeysPath();
    const content = await readFileOrEmpty(path);
    if (!content)
        return false;
    const parsed = parse(content);
    const before = parsed.inside.length;
    parsed.inside = parsed.inside.filter((l) => tagOf(l) !== args.tag);
    if (parsed.inside.length === before && !parsed.hadFence)
        return false;
    await writeKeysFile(path, render(parsed));
    return parsed.inside.length !== before;
}
/** True if a line with the given tag exists in the fenced block. */
export async function hasAuthorizedKeyTag(tag, path) {
    const content = await readFileOrEmpty(path ?? authorizedKeysPath());
    if (!content)
        return false;
    return parse(content).inside.some((l) => tagOf(l) === tag);
}
/** Visible to tests for snapshot assertions. */
export const _internal = { FENCE_OPEN, FENCE_CLOSE, parse, render };
//# sourceMappingURL=authorized_keys.js.map