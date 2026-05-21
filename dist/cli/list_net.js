import { spawn } from "node:child_process";
import { readPeers } from "../store/index.js";
import { runWithConcurrency } from "../gossip/index.js";
import { shellSingleQuote } from "../lib/shell.js";
/**
 * Fan out `nagent list --local --json` to every peer in the active net,
 * merge results with the local sessions, and return a flat row list plus the
 * names of peers that could not be reached. Hard timeout per peer is 3s;
 * total concurrency is capped at 16. Errors don't propagate — unreachable
 * peers are simply listed as such so the user can see the partial picture.
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
    // Per-peer timeout: 8s accommodates a cold zsh -ilc on macOS (nvm + asdf
    // sourcing can easily eat 1-2s) plus Tailscale RTT plus SSH handshake.
    // The ADR said 3s; real-world testing showed that's too tight in practice.
    const results = await runWithConcurrency(others, 16, async (peer) => {
        return sshListLocal(`nagent.${peer.nodeName}`, remoteArgs, 8000);
    });
    for (let i = 0; i < others.length; i++) {
        const peer = others[i];
        const r = results[i];
        if ("error" in r) {
            unreachable.push(peer.nodeName);
            continue;
        }
        for (const session of r.result.sessions) {
            rows.push({ node: peer.nodeName, session });
        }
    }
    return { rows, unreachable };
}
/**
 * SSH-shellout to `nagent list --local --json` on a remote peer. Returns the
 * parsed JSON payload, or rejects with an error if ssh fails, times out, or
 * the response can't be parsed.
 *
 * We pass the command through `bash -ilc` so nvm/mise/asdf get sourced and
 * `nagent` is on PATH — same trick as `attach`. Single-quoted to survive ssh's
 * argv-flattening.
 */
async function sshListLocal(sshHost, remoteArgs, timeoutMs) {
    // The remote user's login shell is what has nvm/fnm/mise sourced. macOS
    // defaults to zsh — bash -ilc won't load .zprofile, so nagent isn't on
    // PATH. Use $SHELL (which sshd sets to the remote user's login shell).
    const innerCmd = ["nagent", ...remoteArgs.map(shellSingleQuote)].join(" ");
    const wrappedCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;
    return new Promise((resolve, reject) => {
        const args = [
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
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString("utf8").trim();
                reject(new Error(`ssh ${sshHost}: exit ${code}: ${stderr || "(no stderr)"}`));
                return;
            }
            const stdout = Buffer.concat(outChunks).toString("utf8").trim();
            // The remote may print the bootstrap-on-first-call lines first; the
            // JSON is the last line. Take the last non-empty line and parse it.
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