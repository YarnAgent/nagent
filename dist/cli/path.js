// `nagent path status` + `nagent path probe` — inspect and refresh the local
// path-table. Probe currently does a direct-only one-shot round; relay
// STATUS pulls require an in-process RelayClient (provided by the daemon
// in task #32). When that lands, the same function will pull relay data too.
import { readActiveState, readIdentity } from "../store/index.js";
import { runProbeRound, readPathTable } from "../routing/probe.js";
import { chooseTransport, transportLabel, } from "../routing/index.js";
export async function cmdPathStatus(opts) {
    const active = await readActiveState();
    if (!active.activeNetId)
        throw new Error("no active net");
    const table = await readPathTable(active.activeNetId);
    if (opts.json) {
        process.stdout.write(JSON.stringify(table, null, 2) + "\n");
        return;
    }
    if (opts.peer) {
        renderPeer(table, opts.peer);
        return;
    }
    renderTable(table);
}
function renderTable(t) {
    if (Object.keys(t.direct).length === 0 && Object.keys(t.relays).length === 0) {
        process.stdout.write(`path-table is empty. Run \`nagent path probe\` to populate it, or wait for the daemon's periodic tick.\n`);
        return;
    }
    process.stdout.write(`updated:  ${t.updatedAt}\n`);
    process.stdout.write(`node:     ${t.node}\n\n`);
    // Direct
    const directRows = [];
    for (const [peer, sample] of Object.entries(t.direct).sort()) {
        directRows.push([peer, sample.ms === null ? "unreachable" : `${sample.ms.toFixed(1)} ms`]);
    }
    process.stdout.write("DIRECT\n");
    if (directRows.length === 0)
        process.stdout.write("  (no direct probes)\n");
    for (const [peer, ms] of directRows)
        process.stdout.write(`  ${peer.padEnd(24)} ${ms}\n`);
    // Relays
    process.stdout.write("\nRELAYS\n");
    if (Object.keys(t.relays).length === 0)
        process.stdout.write("  (no pinned relays)\n");
    for (const [name, sample] of Object.entries(t.relays).sort()) {
        const myRtt = sample.myRttMs === null ? "—" : `${sample.myRttMs.toFixed(1)} ms`;
        process.stdout.write(`  ${name}  (myRtt ${myRtt}, peers ${Object.keys(sample.peers).length})\n`);
        for (const [peer, ps] of Object.entries(sample.peers).sort()) {
            const ms = ps.ms === null ? "unreachable" : `${ps.ms.toFixed(1)} ms`;
            process.stdout.write(`    via:${name}/${peer.padEnd(20)} ${ms}\n`);
        }
    }
    // Selection summary for each known peer.
    const allPeers = new Set([
        ...Object.keys(t.direct),
        ...Object.values(t.relays).flatMap((r) => Object.keys(r.peers)),
    ]);
    if (allPeers.size > 0) {
        process.stdout.write("\nBEST CHOICE\n");
        for (const peer of [...allPeers].sort()) {
            const choice = chooseTransport(t, peer);
            process.stdout.write(`  ${peer.padEnd(24)} → ${transportLabel(choice)}\n`);
        }
    }
}
function renderPeer(t, peer) {
    process.stdout.write(`peer: ${peer}\n\n`);
    const d = t.direct[peer];
    process.stdout.write(`  direct:  ${d ? (d.ms === null ? "unreachable" : `${d.ms.toFixed(1)} ms`) : "(no probe)"}\n`);
    for (const [name, sample] of Object.entries(t.relays).sort()) {
        const ps = sample.peers[peer];
        const my = sample.myRttMs === null ? "—" : `${sample.myRttMs.toFixed(1)}`;
        const r = ps?.ms === null ? "unreachable" : ps?.ms !== undefined ? `${ps.ms.toFixed(1)}` : "(no data)";
        const total = sample.myRttMs !== null && ps?.ms != null ? `${(sample.myRttMs + ps.ms).toFixed(1)} ms` : "—";
        process.stdout.write(`  via:${name.padEnd(16)}  me→relay ${my} ms + relay→peer ${r}  =  ${total}\n`);
    }
    const choice = chooseTransport(t, peer);
    process.stdout.write(`\n  best:    ${transportLabel(choice)}\n`);
}
// ---------------------------------------------------------------------------
// nagent path probe
// ---------------------------------------------------------------------------
export async function cmdPathProbe() {
    const active = await readActiveState();
    if (!active.activeNetId)
        throw new Error("no active net");
    const id = await readIdentity();
    if (!id?.nodeName)
        throw new Error("identity missing — run `nagent` once to bootstrap");
    const start = Date.now();
    const table = await runProbeRound({
        netId: active.activeNetId,
        selfNodeName: id.nodeName,
    });
    const ms = Date.now() - start;
    const peersProbed = Object.keys(table.direct).length;
    const direct = peersProbed - Object.values(table.direct).filter((s) => s.ms === null).length;
    process.stdout.write(`probe round done in ${ms} ms — ${direct}/${peersProbed} direct paths up\n`);
    process.stdout.write(`(relay STATUS pulls require the daemon to be running; see \`nagent daemon\` + v0.5 task #32)\n`);
    process.stdout.write(`\n`);
    renderTable(table);
}
//# sourceMappingURL=path.js.map