import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { shellSingleQuote } from "../lib/shell.js";

/**
 * `nagent attach <peer>/<session> --mosh` — shell out to mosh-client when
 * both ends have mosh installed. Mosh handles predictive local echo + UDP
 * transport, so TUI input lag is hidden.
 *
 * We invoke `mosh <sshHost> -- bash -ilc 'nagent attach <session>'`, which:
 *   - mosh-client connects to mosh-server on the remote (started transparently
 *     via the user's SSH credentials);
 *   - mosh-server then execs our bash wrapper, which sources nvm/mise and runs
 *     `nagent attach <session>` — the same v0.2 single-node attach path,
 *     re-using all existing logic.
 *
 * Errors out (with install hints) if mosh isn't on PATH locally. We can't
 * verify the remote until we actually try, so a failure to find mosh-server
 * on the remote surfaces as a mosh error code.
 */
export async function attachMosh(
  sshHost: string,
  remoteSession: string,
  extraSshArgs: string[] = [],
): Promise<never> {
  const localProbe = spawnSync("which", ["mosh"], { encoding: "utf8" });
  if (localProbe.status !== 0) {
    throw new Error(
      "mosh is not installed locally.\n" +
        "  macOS:           brew install mosh\n" +
        "  Debian / Ubuntu: sudo apt-get install -y mosh\n" +
        "  Fedora / RHEL:   sudo dnf install -y mosh\n" +
        "(or use `--line` for a lag-free shell mode without mosh)",
    );
  }
  const innerCmd = `nagent attach ${shellSingleQuote(remoteSession)}`;
  const remoteCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;
  // mosh has a --ssh option for extra ssh args; collapse the array into one
  // shell-quoted string. Empty extras → no override.
  const moshArgs: string[] = [];
  if (extraSshArgs.length > 0) {
    const sshCmd = ["ssh", ...extraSshArgs.map((a) => shellSingleQuote(a))].join(" ");
    moshArgs.push(`--ssh=${sshCmd}`);
  }
  moshArgs.push(sshHost, "--", remoteCmd);
  const r = spawnSync("mosh", moshArgs, { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

/**
 * `nagent attach <peer>/<session> --line` — line-buffered shell mode that
 * eliminates per-keystroke RTT for shell-style work over high-latency links.
 *
 * Local terminal: a readline prompt with full local echo + GNU keybindings +
 * history. The user types and edits entirely locally; no remote round-trip
 * per keystroke. Pressing Enter sends the line over the existing SSH session
 * to a server-side helper (`nagent attach-line`) which translates it into
 * `tmux send-keys -t <session> <line> Enter` on the remote tmux socket.
 *
 * The remote helper also installs `tmux pipe-pane` and streams pane output
 * back over the same SSH session's stdout, which we print above the readline
 * prompt as it arrives.
 *
 * Trade-offs vs. plain attach:
 *   + Input always feels instant.
 *   + Local history (↑/↓) works across detach/reattach.
 *   - Full-screen TUIs (vim, htop) don't work — we render output as a stream,
 *     not as a real PTY. The remote helper detects the pane's `alternate_screen`
 *     flag and warns at start-of-line if the user enters one.
 */
export async function attachLine(
  sshHost: string,
  remoteSession: string,
  extraSshArgs: string[] = [],
): Promise<never> {
  const prompt = `[${sshHost.replace(/^nagent\./, "")}:${remoteSession}] $ `;
  const innerCmd = `nagent attach-line ${shellSingleQuote(remoteSession)}`;
  const remoteCmd = `"$SHELL" -ilc ${shellSingleQuote(innerCmd)}`;

  // -T: no PTY. We want raw stdio so we can pipe text both directions.
  // -o ServerAliveInterval=30: keep the long-lived SSH session alive.
  const child = spawn(
    "ssh",
    [...extraSshArgs, "-T", "-o", "ServerAliveInterval=30", "-o", "BatchMode=yes", sshHost, "--", remoteCmd],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  // Set up the local readline interface bound to our terminal.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt,
    terminal: true,
    historySize: 1000,
  });
  rl.prompt();

  // Send each line the user submits to the remote helper. We append a literal
  // newline because the remote reads stdin line-by-line.
  rl.on("line", (line) => {
    child.stdin.write(line + "\n");
    rl.prompt();
  });

  // Pane output streams in on the SSH stdout. Write it above the prompt,
  // then redraw the prompt. Using readline.cursorTo + clearLine keeps the
  // user's in-progress input intact while output appears "above".
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    // Move to start of current line, clear it, write the pane output (which
    // may include its own newlines), then redraw the prompt + buffer.
    process.stdout.write("\x1b[2K\r"); // clear current line + carriage return
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
    process.stdout.write(prompt + (rl as unknown as { line: string }).line);
  });

  // Quit conditions.
  rl.on("close", () => {
    child.stdin.end();
  });
  child.on("exit", (code) => {
    rl.close();
    process.exit(code ?? 0);
  });

  // Block the function — we exit via child.on('exit') above.
  return new Promise<never>(() => {});
}

