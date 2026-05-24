import { networkInterfaces } from "node:os";
/**
 * Best-effort detection of locally-reachable IPv4 addresses for an invite token.
 * Filters loopback and link-local; returns one entry per non-internal interface.
 * Always paired with port 22 (sshd default). Override via `nagent invite --addr`.
 */
export function currentReachableAddresses(port = 22) {
    const out = [];
    const seen = new Set();
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
        if (!list)
            continue;
        for (const info of list) {
            if (info.internal)
                continue;
            if (info.family !== "IPv4")
                continue;
            if (info.address.startsWith("169.254."))
                continue; // link-local
            if (seen.has(info.address))
                continue;
            seen.add(info.address);
            out.push({ host: info.address, port });
        }
    }
    return out;
}
export function parseAddressArg(arg, defaultPort = 22) {
    const idx = arg.lastIndexOf(":");
    if (idx > 0) {
        const host = arg.slice(0, idx);
        const port = Number.parseInt(arg.slice(idx + 1), 10);
        if (!Number.isNaN(port) && port > 0 && port < 65536)
            return { host, port };
    }
    return { host: arg, port: defaultPort };
}
/**
 * Pick the best address from a peer's address list for ssh_config wiring.
 *
 * Preference order:
 *   1. Tailscale CGNAT (100.64.0.0/10 — includes 100.64–127.x.x.x)
 *   2. Other RFC1918 private addresses (10/8, 172.16/12, 192.168/16)
 *   3. Anything else (public IPs, etc.)
 *
 * Fixes #4: previously `addresses[0]` was used, which on many hosts is a
 * LAN or docker-bridge address that remote peers can't route to.
 */
export function preferAddress(addresses) {
    if (addresses.length === 0)
        return undefined;
    if (addresses.length === 1)
        return addresses[0];
    let bestScore = -1;
    let best = addresses[0];
    for (const addr of addresses) {
        const host = addr.includes(":") ? addr.slice(0, addr.lastIndexOf(":")) : addr;
        const score = addressScore(host);
        if (score > bestScore) {
            bestScore = score;
            best = addr;
        }
    }
    return best;
}
function addressScore(host) {
    if (isTailscaleCgnat(host))
        return 2;
    if (isRfc1918(host))
        return 1;
    return 0;
}
function isTailscaleCgnat(ip) {
    const parts = ip.split(".");
    if (parts.length !== 4)
        return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a !== 100)
        return false;
    return b >= 64 && b <= 127;
}
function isRfc1918(ip) {
    const parts = ip.split(".");
    if (parts.length !== 4)
        return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 10)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    return false;
}
//# sourceMappingURL=addresses.js.map