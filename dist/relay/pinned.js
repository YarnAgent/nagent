// Pinned-relays store at ~/.nagent/relays.json.
//
// v0.5 shipped a single shape (tls + fingerprint + url). v0.5.1 introduces
// a second transport, `ssh-jump`, with its own fields. Legacy records (no
// `transport` field) load as `"tls"` for backward compat.
//
// Writes happen via the CLI (src/cli/relay.ts); reads from the daemon
// (relay-client startup), the routing layer (transport selection), and
// the CLI (list).
import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
/** All pinned relays (any transport). Empty array if none / file missing. */
export async function readPinnedRelays() {
    try {
        const raw = await fs.readFile(paths().pinnedRelays, "utf8");
        const obj = JSON.parse(raw);
        if (obj.v !== 1 || !obj.relays)
            return [];
        const out = [];
        for (const [name, r] of Object.entries(obj.relays)) {
            const rec = parseRecord(name, r);
            if (rec)
                out.push(rec);
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * Only TLS-transport relays, shaped for the RelayClient constructor input.
 * The relay-client doesn't know how to talk ssh-jump (they're handled by
 * the routing layer at SSH spawn time, not by a long-lived connection).
 */
export async function readPinnedTlsRelays() {
    const all = await readPinnedRelays();
    const out = [];
    for (const r of all) {
        if (r.transport === "tls")
            out.push({ name: r.name, url: r.url, fingerprint: r.fingerprint });
    }
    return out;
}
/** Find a pinned record by name, or null. */
export async function findPinnedRelay(name) {
    const all = await readPinnedRelays();
    return all.find((r) => r.name === name) ?? null;
}
function parseRecord(name, r) {
    const pinnedAt = typeof r.pinnedAt === "string" ? r.pinnedAt : new Date(0).toISOString();
    const transport = r.transport ?? "tls";
    if (transport === "tls") {
        if (typeof r.url !== "string" || !r.url)
            return null;
        if (typeof r.fingerprint !== "string" || !r.fingerprint)
            return null;
        return { transport: "tls", name, url: r.url, fingerprint: r.fingerprint, pinnedAt };
    }
    if (transport === "ssh-jump") {
        if (typeof r.sshTarget !== "string" || !r.sshTarget)
            return null;
        return { transport: "ssh-jump", name, sshTarget: r.sshTarget, pinnedAt };
    }
    return null;
}
//# sourceMappingURL=pinned.js.map