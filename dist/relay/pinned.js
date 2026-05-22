// Reader for the client-side pinned-relays list at ~/.nagent/relays.json.
// Owned for *writes* by src/cli/relay.ts (`nagent relay add/remove`); the
// daemon reads via this module to construct its RelayClient on startup.
import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";
export async function readPinnedRelays() {
    try {
        const raw = await fs.readFile(paths().pinnedRelays, "utf8");
        const obj = JSON.parse(raw);
        if (obj.v !== 1 || !obj.relays)
            return [];
        return Object.entries(obj.relays).map(([name, r]) => ({
            name,
            url: r.url,
            fingerprint: r.fingerprint,
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=pinned.js.map