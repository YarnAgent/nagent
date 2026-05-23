import { spawn } from "node:child_process";
import { readPeers } from "../store/index.js";
import { runWithConcurrency } from "../gossip/index.js";
import { shellSingleQuote } from "../lib/shell.js";
import { resolveSshTransportArgs } from "../routing/ssh-args.js";
import { readPathTable } from "../routing/probe.js";
import { readPinnedRelays } from "../relay/pinned.js";
const PER_PEER_TIMEOUT_MS = 8_000;
/**
 * Fan out `nagent list --local --json` to every peer in the active net,
 * merge results with the local sessions, and return rows + unreachable peers.
 *
 * v0.5.2: per peer, we race `direct` vs the best-pinned-relay leg in parallel
 * (happy-eyeballs). First success wins; the loser is cancelled. Both fail →
 * the peer is bucketed as unreachable. This makes `list` resilient to transient
 * direct-path issues (cold-start host-key acceptance, tailscale path
 * renegotiation, brief sshd hiccups) at the cost of one extra ssh process
 * spawn per peer when a relay is pinned.
 */
export async function fanoutSessionsAcrossNet(input) {
    const peers = await readPeers(input.activeNetId);
    const others = peers.filter((p) => p.nodeName !== input.selfNodeName);
    const rows = input.localSessions.map((s) => ({ node: input.selfNodeName, session: s }));
    const unreachable = [];
    if (others.length === 0)
        return { rows, unreachable };
    const remoteArgs = ["list", "--local", "--json"];
    if (input.projectFilter)
        remoteArgs.push("--project", input.projectFilter);
    if (input.includeAll)
        remoteArgs.push("--all");
    const pinned = await readPinnedRelays();
    const pathTable = await safeReadPathTable(input.activeNetId);
    const bestRelay = pickBestRelayPerPeer(pathTable, others.map((p) => p.nodeName), pinned.map((r) => r.name));
    // Per-peer timeout: 8s accommodates a cold zsh -ilc on macOS (nvm + asdf
    // sourcing can easily eat 1-2s) plus Tailscale RTT plus SSH handshake.
    const results = await runWithConcurrency(others, 16, async (peer) => {
        const legs = [];
        legs.push({
            via: undefined,
            extraSshArgs: await resolveSshTransportArgs(peer.nodeName, { via: "direct" }),
        });
        const relayName = bestRelay.get(peer.nodeName);
        if (relayName) {
            legs.push({
                via: relayName,
                extraSshArgs: await resolveSshTransportArgs(peer.nodeName, { via: relayName }),
            });
        }
        return racePeerLegs(`nagent.${peer.nodeName}`, remoteArgs, PER_PEER_TIMEOUT_MS, legs);
    });
    for (let i = 0; i < others.length; i++) {
        const peer = others[i];
        const wrapped = results[i];
        if ("error" in wrapped) {
            // runWithConcurrency threw — shouldn't happen since racePeerLegs swallows
            // errors, but treat as unreachable defensively.
            unreachable.push(peer.nodeName);
            continue;
        }
        const r = wrapped.result;
        if ("error" in r) {
            unreachable.push(peer.nodeName);
            continue;
        }
        for (const session of r.payload.sessions) {
            rows.push({
                node: peer.nodeName,
                session,
                ...(r.via ? { via: r.via } : {}),
            });
        }
    }
    return { rows, unreachable };
}
/**
 * Race the candidate legs in parallel; the first leg whose ssh+JSON parse
 * succeeds wins and aborts the others. If all legs fail, the combined error
 * message is returned.
 */
async function racePeerLegs(sshHost, remoteArgs, timeoutMs, legs) {
    if (legs.length === 0)
        return { error: "no transport legs" };
    if (legs.length === 1) {
        const only = legs[0];
        try {
            const payload = await sshListLocal(sshHost, remoteArgs, timeoutMs, only.extraSshArgs);
            return only.via ? { payload, via: only.via } : { payload };
        }
        catch (err) {
            return { error: err.message };
        }
    }
    const ac = new AbortController();
    const errors = [];
    return new Promise((resolve) => {
        let settled = false;
        const onWin = (payload, via) => {
            if (settled)
                return;
            settled = true;
            ac.abort();
            resolve(via ? { payload, via } : { payload });
        };
        const onLose = (err) => {
            errors.push(err);
            if (settled)
                return;
            if (errors.length === legs.length) {
                settled = true;
                resolve({ error: errors.map((e) => e.message).join("; ") });
            }
        };
        for (const leg of legs) {
            sshListLocal(sshHost, remoteArgs, timeoutMs, leg.extraSshArgs, ac.signal)
                .then((payload) => onWin(payload, leg.via))
                .catch(onLose);
        }
    });
}
/**
 * For each peer, pick the pinned relay with the lowest measured ms in the
 * path table (`relays[*].peers[peer].ms`). Falls back to the first pinned
 * relay name if there's no path-table data yet. Exported for testability.
 */
export function pickBestRelayPerPeer(table, peerNames, relayNames) {
    const out = new Map();
    if (relayNames.length === 0)
        return out;
    for (const peer of peerNames) {
        let best = null;
        if (table?.relays) {
            for (const relayName of relayNames) {
                const sample = table.relays[relayName]?.peers?.[peer];
                if (sample && typeof sample.ms === "number" && Number.isFinite(sample.ms)) {
                    if (!best || sample.ms < best.ms)
                        best = { name: relayName, ms: sample.ms };
                }
            }
        }
        out.set(peer, best?.name ?? relayNames[0]);
    }
    return out;
}
async function safeReadPathTable(netId) {
    try {
        return await readPathTable(netId);
    }
    catch {
        return null;
    }
}
/**
 * SSH-shellout to `nagent list --local --json` on a remote peer. Returns the
 * parsed JSON payload, or rejects with an error if ssh fails, times out, or
 * the response can't be parsed.
 *
 * We pass the command through the login shell (`$SHELL -ilc`) so nvm/mise/asdf
 * get sourced and `nagent` is on PATH — same trick as `attach`. Single-quoted
 * to survive ssh's argv-flattening.
 *
 * When `signal` aborts (e.g. a sibling leg won the race), the child is killed
 * and the promise rejects with `aborted`.
 */
async function sshListLocal(sshHost, remoteArgs, timeoutMs, extraSshArgs = [], signal) {
    // The remote user's login shell is what has nvm/fnm/mise sourced. macOS
    // defaults to zsh — bash -ilc won't load .zprofile, so nagent isn't on
    // PATH. Use $SHELL (which sshd sets to the remote user's login shell).
    const innerCmd = ["nagent", ...remoteArgs.map(shellSingleQuote)].join(" ");
    const wrappedCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
        }
        const args = [
            ...extraSshArgs,
            "-o", "BatchMode=yes",
            "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
            sshHost,
            "--",
            wrappedCmd,
        ];
        const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        const outChunks = [];
        const errChunks = [];
        child.stdout.on("data", (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        child.stderr.on("data", (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`ssh ${sshHost}: list timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onAbort = () => {
            clearTimeout(timer);
            try {
                child.kill("SIGTERM");
            }
            catch { /* */ }
            reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString("utf8").trim();
                reject(new Error(`ssh ${sshHost}: exit ${code}: ${stderr || "(no stderr)"}`));
                return;
            }
            const stdout = Buffer.concat(outChunks).toString("utf8").trim();
            // The remote may print bootstrap-on-first-call lines first; the JSON
            // is the last non-empty line.
            const lastLine = stdout.split(/\r?\n/).filter((l) => l.length > 0).pop();
            if (!lastLine) {
                reject(new Error(`ssh ${sshHost}: empty list response`));
                return;
            }
            try {
                const parsed = JSON.parse(lastLine);
                if (parsed.v !== 1 || !Array.isArray(parsed.sessions)) {
                    reject(new Error(`ssh ${sshHost}: malformed list payload`));
                    return;
                }
                resolve(parsed);
            }
            catch (err) {
                reject(new Error(`ssh ${sshHost}: bad JSON: ${err.message}`));
            }
        });
    });
}
//# sourceMappingURL=list_net.js.map