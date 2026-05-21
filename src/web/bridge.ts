import { promises as fs, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect } from "node:net";
import http from "node:http";
import { WebSocket as WsClient } from "ws";
import type { WebSocket as WsServer } from "ws";
import { shellSingleQuote } from "../lib/shell.js";

void createReadStream; // unused for now

export interface BridgeOptions {
  /** target peer node name as it appears in ssh_config (`nagent.<node>`) */
  peerNode: string;
  /** session name within that peer's nagent net */
  sessionName: string;
  /** the already-upgraded browser-side WebSocket */
  browserWs: WsServer;
  /** allow keystrokes? false = readonly pane */
  writable: boolean;
  /** log channel (forwarded from the hub) */
  log: (line: string) => void;
}

interface BridgeState {
  ssh?: ChildProcess;
  upstream?: WsClient;
  localSock?: string;
  closed: boolean;
}

const TTYD_READY_POLL_MS = 100;
const TTYD_READY_TIMEOUT_MS = 5_000;

/**
 * Open a browser ↔ peer-ttyd bridge for one /ws/<node>/<name> connection.
 *
 * Strategy:
 *   1. Allocate a per-connection ID and pick two Unix socket paths under /tmp.
 *   2. Spawn `ssh -L <local.sock>:<remote.sock> nagent.<peer> -- … ttyd …`.
 *      ssh creates the local socket immediately; ttyd creates the remote
 *      socket once it's running.
 *   3. Poll the local socket until a TCP-style connect succeeds — proves
 *      ttyd has bound on the remote side.
 *   4. Open an upstream WebSocket to ttyd via the `ws+unix://` URL scheme
 *      (supported by the `ws` library), pointing at the local forwarded
 *      socket.
 *   5. Pipe frames both ways. Tear everything down on either side closing.
 *
 * No state persists across calls — every bridge is a one-shot. ttyd dies
 * when its ssh parent exits, so cleanup is "kill the ssh child."
 */
export async function openTtydBridge(opts: BridgeOptions): Promise<void> {
  const { peerNode, sessionName, browserWs, writable, log } = opts;
  const state: BridgeState = { closed: false };
  const bridgeId = randomBytes(6).toString("hex");
  const localSock = join(tmpdir(), `nagent-hub-${bridgeId}.sock`);
  const remoteSock = `/tmp/nagent-ttyd-${bridgeId}.sock`;
  state.localSock = localSock;

  const closeAll = (reason: string): void => {
    if (state.closed) return;
    state.closed = true;
    log(`web/bridge[${bridgeId}]: closing (${reason})`);
    if (state.upstream) {
      try { state.upstream.close(); } catch { /* ignore */ }
    }
    if (state.ssh && !state.ssh.killed) {
      state.ssh.kill("SIGTERM");
    }
    if (browserWs.readyState === browserWs.OPEN || browserWs.readyState === browserWs.CONNECTING) {
      try { browserWs.close(1000, reason); } catch { /* ignore */ }
    }
    // Best-effort: the local sock will be cleaned up when ssh exits.
    void fs.unlink(localSock).catch(() => undefined);
  };

  browserWs.on("close", () => closeAll("browser closed"));
  browserWs.on("error", (err) => {
    log(`web/bridge[${bridgeId}]: browser error: ${(err as Error).message}`);
    closeAll("browser error");
  });

  // Pre-clean any stale sockets.
  await fs.unlink(localSock).catch(() => undefined);

  // Build the remote command. ttyd 1.7+ binds to a Unix socket when the
  // --interface arg starts with `/`. The spawned program is `nagent attach
  // <sessionName>` rather than `tmux attach -t <sessionName>` so the daemon's
  // session-name-to-sessionId lookup gets used (tmux sessions are stored
  // under the prefixed name `s-<sessionId>`, not the human name).
  const ttydArgs = [
    "ttyd",
    "--interface", remoteSock,
    writable ? "--writable" : "--readonly",
    "-t", `titleFixed=${sessionName}`,
    "-t", "disableLeaveAlert=true",
    "--debug=4",
    "--", "nagent", "attach", sessionName,
  ];
  const remoteCmd = ttydArgs.map(shellSingleQuote).join(" ");
  const innerCmd = `rm -f ${shellSingleQuote(remoteSock)}; ${remoteCmd}`;
  const wrappedCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;
  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    "-L", `${localSock}:${remoteSock}`,
    `nagent.${peerNode}`,
    "--",
    wrappedCmd,
  ];
  log(`web/bridge[${bridgeId}]: ssh ${sshArgs.join(" ")}`);
  const ssh = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
  state.ssh = ssh;
  ssh.stdout?.on("data", (d) => log(`web/bridge[${bridgeId}] ttyd: ${String(d).trim()}`));
  ssh.stderr?.on("data", (d) => log(`web/bridge[${bridgeId}] ssh: ${String(d).trim()}`));
  ssh.on("error", (err) => {
    log(`web/bridge[${bridgeId}]: ssh spawn error: ${err.message}`);
    closeAll("ssh spawn error");
  });
  ssh.on("close", (code) => {
    log(`web/bridge[${bridgeId}]: ssh exited (code ${code})`);
    closeAll(`ssh exited ${code}`);
  });

  try {
    await waitForUnixSocketReady(localSock, TTYD_READY_TIMEOUT_MS);
  } catch (err) {
    closeAll(`ttyd never came up: ${(err as Error).message}`);
    return;
  }
  log(`web/bridge[${bridgeId}]: ttyd ready on ${localSock}`);

  // ttyd's WebSocket lives at /ws on its HTTP server.
  // ws supports unix:<path>: URLs via the agent.socketPath trick — and the
  // ws+unix:// scheme directly.
  const upstreamUrl = `ws+unix://${localSock}:/ws`;
  const upstream = new WsClient(upstreamUrl, ["tty"], {
    perMessageDeflate: false,
    skipUTF8Validation: true,
  });
  state.upstream = upstream;

  upstream.on("open", () => {
    log(`web/bridge[${bridgeId}]: upstream open`);
    // ttyd expects a JSON_DATA initial message with column/row info; xterm.js
    // sends one as soon as it attaches. We pass it through verbatim.
  });
  upstream.on("message", (data, isBinary) => {
    if (browserWs.readyState !== browserWs.OPEN) return;
    browserWs.send(data, { binary: isBinary });
  });
  upstream.on("close", () => {
    log(`web/bridge[${bridgeId}]: upstream closed`);
    closeAll("upstream closed");
  });
  upstream.on("error", (err) => {
    log(`web/bridge[${bridgeId}]: upstream error: ${err.message}`);
    closeAll("upstream error");
  });

  browserWs.on("message", (data, isBinary) => {
    if (upstream.readyState !== upstream.OPEN) return;
    upstream.send(data, { binary: isBinary });
  });
}

/**
 * Poll for ttyd-on-the-remote-side to be ready by issuing an actual HTTP
 * request through the SSH-forwarded local socket.
 *
 * NB: a plain `connect()` to the local socket isn't enough — ssh's local
 * forwarding always accepts new connections (it creates the local socket
 * before the remote command runs) and only fails the connection LATER, after
 * the remote tries to dial the upstream socket. We need to actually exchange
 * bytes to confirm ttyd is up.
 */
async function waitForUnixSocketReady(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const c = netConnect(socketPath);
        let gotResponse = false;
        const probeTimer = setTimeout(() => {
          if (!gotResponse) {
            c.destroy();
            reject(new Error("probe timeout"));
          }
        }, 1500);
        c.once("connect", () => {
          // Send a minimal HTTP request to ttyd's index path. Any HTTP
          // response status means ttyd is alive.
          c.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
        });
        c.on("data", (chunk) => {
          if (chunk.toString("utf8").includes("HTTP/")) {
            gotResponse = true;
            clearTimeout(probeTimer);
            c.destroy();
            resolve();
          }
        });
        c.once("error", (err) => { clearTimeout(probeTimer); reject(err); });
        c.once("end", () => {
          if (!gotResponse) {
            clearTimeout(probeTimer);
            reject(new Error("connection ended without HTTP response"));
          }
        });
      });
      return;
    } catch (err) {
      lastErr = err as Error;
      await sleep(TTYD_READY_POLL_MS);
    }
  }
  throw new Error(`ttyd not ready on ${socketPath} in ${timeoutMs}ms (${lastErr?.message ?? "no error"})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Suppress unused-import lint complaints; http is reserved for a future
// non-WebSocket health-check path through the same unix socket.
void http;
