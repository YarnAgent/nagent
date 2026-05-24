// Helper for resolving nagent peer names to Tailscale MagicDNS FQDNs.
//
// When ssh-jump traffic flows `client → relay → target`, the relay needs to
// resolve the target hostname *itself* — our local ssh_config Host aliases
// don't propagate over `-J`. For Tailscale-enabled meshes the easiest
// solution is to give the relay the target's MagicDNS FQDN
// (e.g. `mac-m3.tailf779e9.ts.net`), which any tailscaled-running box
// resolves to the right 100.x.x.x peer address.
//
// We look it up by shelling out to `tailscale status --json` on the client.
// Best-effort: if tailscale isn't installed, isn't logged in, or the peer
// isn't on this tailnet, we return null and the caller falls back to whatever
// ssh_config naturally resolves (which may still be wrong, but isn't worse).
import { spawn } from "node:child_process";
let cached = null;
const CACHE_TTL_MS = 30_000;
/**
 * Best-effort: returns the Tailscale MagicDNS FQDN for `peerName`, or null.
 * Matches peers by case-insensitive `HostName` first, then by the leading
 * label of `DNSName`. The result is cached for 30 s so the attach path
 * doesn't shell out to tailscale every time.
 */
export async function magicDnsFor(peerName) {
    const now = Date.now();
    if (!cached || now - cached.at > CACHE_TTL_MS) {
        cached = { at: now, map: await loadTailscaleMap() };
    }
    const key = peerName.toLowerCase();
    return cached.map.get(key) ?? null;
}
async function loadTailscaleMap() {
    const map = new Map();
    const raw = await runTailscaleStatus();
    if (!raw)
        return map;
    let status;
    try {
        status = JSON.parse(raw);
    }
    catch {
        return map;
    }
    const all = [];
    if (status.Self)
        all.push(status.Self);
    if (status.Peer)
        for (const p of Object.values(status.Peer))
            all.push(p);
    for (const p of all) {
        const fqdn = (p.DNSName ?? "").replace(/\.$/, "");
        if (!fqdn)
            continue;
        const host = (p.HostName ?? "").toLowerCase();
        const shortName = fqdn.split(".")[0].toLowerCase();
        if (host)
            map.set(host, fqdn);
        if (shortName)
            map.set(shortName, fqdn);
    }
    return map;
}
function runTailscaleStatus() {
    return new Promise((resolve) => {
        const child = spawn("tailscale", ["status", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
        const chunks = [];
        child.stdout?.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        child.once("close", (code) => {
            if (code !== 0)
                return resolve(null);
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        child.once("error", () => resolve(null));
        // Cap the wait — tailscale CLI is usually <100 ms but be defensive.
        setTimeout(() => { try {
            child.kill("SIGTERM");
        }
        catch { /* */ } resolve(null); }, 2000);
    });
}
/** Test seam: forget the cached map so the next lookup re-shells out. */
export function _resetTailscaleCache() { cached = null; }
//# sourceMappingURL=tailscale.js.map