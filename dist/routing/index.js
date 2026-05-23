// Path-table types + chooseTransport() — the selection algorithm consumed by
// the 4 SSH spawn sites (attach, list, gossip, web-bridge) and by `nagent
// path status` / `nagent attach --via auto`.
export const EMPTY_PATH_TABLE = {
    v: 1,
    node: "",
    updatedAt: new Date(0).toISOString(),
    direct: {},
    relays: {},
};
export function chooseTransport(table, target, opts) {
    // Manual override beats everything.
    if (opts?.via === "direct")
        return { type: "direct" };
    if (opts?.via && opts.via !== "auto") {
        return { type: "via", relay: opts.via };
    }
    const candidates = [];
    // Direct candidate.
    const direct = table.direct[target];
    if (direct && typeof direct.ms === "number" && Number.isFinite(direct.ms)) {
        candidates.push({ transport: { type: "direct" }, score: direct.ms });
    }
    // Each known relay.
    for (const [relayName, sample] of Object.entries(table.relays)) {
        if (sample.myRttMs === null)
            continue;
        const peerSample = sample.peers[target];
        if (!peerSample || peerSample.ms === null)
            continue;
        if (!Number.isFinite(sample.myRttMs) || !Number.isFinite(peerSample.ms))
            continue;
        candidates.push({
            transport: { type: "via", relay: relayName },
            score: sample.myRttMs + peerSample.ms,
        });
    }
    // Nothing to compare → graceful fallback. We pick direct so the eventual
    // ssh failure is the right "cannot reach" signal.
    if (candidates.length === 0)
        return { type: "direct" };
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    // Hysteresis: keep stickyTo if it's still within hysteresisMs of best.
    if (opts?.stickyTo) {
        const sticky = findCandidate(candidates, opts.stickyTo);
        if (sticky && sticky.score <= best.score + (opts.hysteresisMs ?? 10)) {
            return opts.stickyTo;
        }
    }
    return best.transport;
}
function findCandidate(cs, t) {
    return cs.find((c) => transportEqual(c.transport, t));
}
export function transportEqual(a, b) {
    if (a.type === "direct" && b.type === "direct")
        return true;
    if (a.type === "via" && b.type === "via")
        return a.relay === b.relay;
    return false;
}
export function transportLabel(t) {
    return t.type === "direct" ? "direct" : `via:${t.relay}`;
}
export function transportSshArgs(transport, targetPeer, extras) {
    if (transport.type === "direct")
        return [];
    if (extras?.pinnedKind === "ssh-jump") {
        if (!extras.sshJumpTarget) {
            throw new Error(`ssh-jump transport requires sshJumpTarget (relay="${transport.relay}")`);
        }
        const args = [];
        // -J doesn't propagate -i to the jump host (per ssh(1)), so use an explicit
        // ProxyCommand with the nagent identity. This makes the jump hop work even
        // when the user's default ssh keys aren't in the relay's authorized_keys.
        const jumpKey = extras.jumpIdentityFile ? `-i ${shellSingleQuote(extras.jumpIdentityFile)} ` : "";
        args.push("-o", `ProxyCommand=ssh ${jumpKey}-o IdentitiesOnly=yes -o BatchMode=yes ` +
            `-o StrictHostKeyChecking=accept-new -W %h:%p ${extras.sshJumpTarget}`);
        // Override the resolved HostName when we have a relay-routable name (e.g.,
        // a Tailscale MagicDNS FQDN). peers.json typically stores LAN IPs that
        // aren't reachable from the relay's network.
        if (extras.targetHostOverride) {
            args.push("-o", `HostName=${extras.targetHostOverride}`);
        }
        return args;
    }
    const peer = shellSingleQuote(targetPeer);
    const relay = shellSingleQuote(transport.relay);
    return ["-o", `ProxyCommand=nagent relay-dial ${peer} --relay ${relay}`];
}
function shellSingleQuote(s) {
    // Safe substitution: replace ' with '\'' inside a single-quoted string.
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
//# sourceMappingURL=index.js.map