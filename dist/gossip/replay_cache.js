import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { paths } from "../platform/paths.js";
const FRESHNESS_MS = 5 * 60 * 1000;
function replayPath() {
    return `${paths().root}/gossip-seen.json`;
}
/**
 * Per-payload replay guard. Returns `true` if this exact signed payload has
 * been applied in the last 5 minutes (the same window the freshness check
 * accepts), in which case the caller should reject the gossip. Otherwise
 * records the payload's hash for the same window and returns `false`.
 *
 * Persisted on disk so a fresh-process gossip-add invocation sees prior
 * applies. Entries past their `expiresAt` are pruned on every call. Issue #3,
 * M1.
 */
export async function isReplay(signed, now = Date.now()) {
    const hash = hashSigned(signed);
    const file = await readFile();
    const fresh = file.entries.filter((e) => e.expiresAt > now);
    if (fresh.some((e) => e.hash === hash)) {
        // Re-persist the pruned file so we don't grow unbounded.
        if (fresh.length !== file.entries.length)
            await writeFile({ v: 1, entries: fresh });
        return true;
    }
    fresh.push({ hash, expiresAt: now + FRESHNESS_MS });
    await writeFile({ v: 1, entries: fresh });
    return false;
}
function hashSigned(signed) {
    // SHA-256 over (sig || canonicalJson(payloadSansSig)) so we treat the same
    // sig replayed against the same payload as a single fingerprint.
    return createHash("sha256")
        .update(signed.sig)
        .update("\0")
        .update(JSON.stringify(signed.newPeer) + "|" + signed.ts + "|" + signed.callerPub)
        .digest("hex");
}
async function readFile() {
    try {
        const raw = await fs.readFile(replayPath(), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.v === 1 && Array.isArray(parsed.entries))
            return parsed;
    }
    catch {
        /* file missing or unreadable — start fresh */
    }
    return { v: 1, entries: [] };
}
async function writeFile(file) {
    await fs.mkdir(dirname(replayPath()), { recursive: true });
    await fs.writeFile(replayPath(), JSON.stringify(file), { mode: 0o600 });
}
//# sourceMappingURL=replay_cache.js.map