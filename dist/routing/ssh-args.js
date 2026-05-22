// Thin async wrapper around chooseTransport() that resolves the right SSH
// `-o ProxyCommand=…` args for a target peer in the active net. All four
// SSH spawn sites in v0.5 call into this so the transport selection logic
// stays in one place.
import { readActiveState } from "../store/index.js";
import { readPathTable } from "./probe.js";
import { chooseTransport, transportSshArgs } from "./index.js";
/**
 * Returns ssh -o ProxyCommand=… (a 2-element array) when the chosen transport
 * is via a relay; otherwise an empty array. Safe to call before the daemon
 * has populated the path-table — chooseTransport() falls back to direct in
 * that case.
 */
export async function resolveSshTransportArgs(targetPeer, opts) {
    const active = await readActiveState();
    if (!active.activeNetId) {
        // No net yet → direct (the caller will likely error out for other reasons).
        if (opts?.via && opts.via !== "auto" && opts.via !== "direct") {
            return transportSshArgs({ type: "via", relay: opts.via }, targetPeer);
        }
        return [];
    }
    const table = await readPathTable(active.activeNetId);
    const transport = chooseTransport(table, targetPeer, { ...(opts?.via ? { via: opts.via } : {}) });
    return transportSshArgs(transport, targetPeer);
}
//# sourceMappingURL=ssh-args.js.map