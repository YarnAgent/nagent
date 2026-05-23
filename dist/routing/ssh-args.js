// Thin async wrapper around chooseTransport() that resolves the right SSH
// extra args for a target peer in the active net. All four SSH spawn sites
// in v0.5 call into this so the transport selection logic stays in one
// place.
//
// v0.5.1: when the chosen transport is via-relay, we look up the pinned
// record to discriminate `tls` (ProxyCommand) vs `ssh-jump` (-J).
import { readActiveState } from "../store/index.js";
import { readPathTable } from "./probe.js";
import { findPinnedRelay } from "../relay/pinned.js";
import { chooseTransport, transportSshArgs } from "./index.js";
export async function resolveSshTransportArgs(targetPeer, opts) {
    const transport = await resolveTransport(targetPeer, opts);
    return await renderArgs(transport, targetPeer);
}
async function resolveTransport(targetPeer, opts) {
    const active = await readActiveState();
    if (!active.activeNetId) {
        // No net yet → direct (the caller will likely error out for other reasons).
        if (opts?.via && opts.via !== "auto" && opts.via !== "direct") {
            return { type: "via", relay: opts.via };
        }
        return { type: "direct" };
    }
    const table = await readPathTable(active.activeNetId);
    return chooseTransport(table, targetPeer, { ...(opts?.via ? { via: opts.via } : {}) });
}
async function renderArgs(transport, targetPeer) {
    if (transport.type === "direct")
        return [];
    const pinned = await findPinnedRelay(transport.relay);
    if (pinned?.transport === "ssh-jump") {
        return transportSshArgs(transport, targetPeer, {
            pinnedKind: "ssh-jump",
            sshJumpTarget: pinned.sshTarget,
        });
    }
    // Default (and explicit tls): ProxyCommand path.
    return transportSshArgs(transport, targetPeer, { pinnedKind: "tls" });
}
//# sourceMappingURL=ssh-args.js.map