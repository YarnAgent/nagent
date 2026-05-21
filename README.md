# nagent

> Agent net — a decentralized mesh CLI for cooperating agents across nodes.
>
> **v0.2 status (in progress on `main`)**: hub-and-spoke multi-node. `nagent join <token>` connects a new device to an existing net via an invite issued by an existing peer; `nagent attach <peer>/<session>` SSH-execs into the remote node's `nagent attach` and you're inside the remote tmux. Cross-node bus (`send`/`recv` across the mesh) and full peer-to-peer trust are in v0.3.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — auto-generated path → purpose map (read this first)
- [Product Requirements](docs/PRD.md)
- [System Design](docs/system_design.md)
- [Architecture Overview](docs/architecture/README.md)
- [Architecture Decision Records](docs/architecture/adr/)

## Installing on a second device (v0.2)

Prereqs on the target: macOS or Linux, Node ≥22, tmux ≥3.0, OpenSSH client.

```sh
curl -fsSL https://raw.githubusercontent.com/YarnAgent/nagent/main/scripts/install.sh | bash
```

Under the hood this runs `npm install -g 'github:YarnAgent/nagent#main'` (the `prepare` script in our `package.json` compiles TS to `dist/`). Test it with `nagent --version`.

## Verify v0.1 on this device

Prerequisites: `tmux ≥ 3.0`, Node ≥ 22. (This repo has been validated on WSL2 + Node 24 + tmux 3.6.)

**One-time setup**

```sh
cd /root/proj/nagent
npm install
npm run build && chmod +x dist/cli/index.js
npm link    # registers `nagent` on PATH
```

**Just use it (no manual init, no manual daemon)**

```sh
mkdir -p /tmp/nagent-demo && cd /tmp/nagent-demo
nagent                       # auto-bootstrap: identity → default net → daemon
                             # then the picker REPL opens. At the prompt:
                             #   /help
                             #   /project init demo-proj
                             #   n                      ← creates a session
                             #   alpha                  ← name when prompted
                             # You're attached to a tmux pane. Inside:
                             #   nagent register-role agent-alpha
                             #   Ctrl-Q to detach (session persists)
                             #   `exit` or `nagent close` to destroy
```

### Leaving a session

| Goal | How |
|---|---|
| Detach (session keeps running) | **`Ctrl-Q`** (single keypress, no prefix) — or the standard `Ctrl-B` then `d` |
| Destroy the session | `exit` / Ctrl-D in the only pane, or `nagent close` from inside |
| Quit the picker REPL | `q` at the `>` prompt (or empty enter / Ctrl-C — none of which destroy anything) |

**Top-level CLI is sessions-only**

```sh
nagent ls                    # list sessions (alias: `nagent list`)
nagent new beta              # create + attach
nagent attach alpha          # attach an existing one
nagent close beta            # destroy a session (with explicit name from outside)
nagent send <addr> [json]    # bus send  (uses NAGENT_SESSION env if set)
nagent recv --subscribe X    # bus receive (line-oriented JSON frames)
nagent register-role <role>  # tag the current session
nagent daemon --foreground   # run nagentd in the foreground (admin/debug)
```

Net + project + deferred verbs are **slash commands inside the picker** (`/net create`, `/net status`, `/net list`, `/net switch`, `/project init`, `/project list`, `/project switch`, `/project clone` *(v0.2)*, `/invite` *(v0.2)*, `/join` *(v0.2)*, `/web` *(v0.3)*, `/help`, `/quit`).

**Headline test — cross-session agent messaging**

```sh
cd /tmp/nagent-demo
nagent new beta --no-attach
NAGENT_SESSION=beta NAGENT_NODE=$(hostname) nagent register-role agent-beta

# subscribe in one terminal (the "beta agent")
NAGENT_SESSION=beta NAGENT_NODE=$(hostname) nagent recv --subscribe '*/role:agent-beta'

# in another, send a message addressed by role
echo '{"q":"status?"}' | NAGENT_SESSION=alpha NAGENT_NODE=$(hostname) \
  nagent send '*/role:agent-beta'
# → the subscriber prints: {"verb":"RECV","from":"<host>/alpha","payload":{"q":"status?"},"msgId":"…"}
```

**Persistence & close**

```sh
# Kill the daemon: `kill $(jq -r .pid ~/.nagent/daemon.pid)` — next `nagent` respawns it.
# tmux sessions survive across daemon restarts.
```

**Notes**

- `~/.nagent/` is the per-user root. Override with `NAGENT_HOME=/path/to/dir` for isolated testing.
- The dedicated tmux socket is `tmux -L nagent` — your own `tmux ls` and `nagent list` never collide.
- The auto-spawned daemon logs to `~/.nagent/daemon.log` and writes its pid to `~/.nagent/daemon.pid`. Set `NAGENT_NO_BOOTSTRAP=1` to bypass auto-bootstrap (used by tests).

## Three-node verification (v0.3, in progress on `feat/v0.3-mesh-and-latency`)

The v0.3 branch adds three things on top of v0.2:

1. **Mesh trust** — after a join, the issuer fans out `gossip-add-peer` to every existing peer so the new joiner ends up in everyone's `authorized_keys`. Any node can SSH-attach to any other without re-inviting.
2. **Net-wide list** — `nagent list` fans out to every peer (cap 16 parallel, 3 s timeout each) and merges the results. `(unreachable)` rows flag peers that didn't answer. `--local` keeps the v0.2 single-node shape.
3. **Low-lag attach** — `nagent attach <peer>/<session> --line` runs a local readline; keystrokes never round-trip, output streams back via `tmux pipe-pane`. `--mosh` is also available when both ends have mosh installed.

### Install the v0.3 branch on a fresh device

```sh
# Linux / macOS, Node ≥22, tmux ≥3.0, OpenSSH client.
npm install -g https://codeload.github.com/YarnAgent/nagent/tar.gz/feat/v0.3-mesh-and-latency
nagent --version          # 0.1.0-alpha.1
```

(Use the same codeload-tarball URL form rather than the `github:` shorthand to avoid a known npm git-dep symlink bug.)

### Reproducing the end-to-end test

On node **A** (already in a net, with at least one session running):

```sh
nagent                              # picker
> /invite --expires 1h              # copy the token; one-shot per device
> q
```

On node **B** (fresh device after the install above):

```sh
nagent join <token>                 # mesh trust gets wired automatically
nagent list                         # should show A's sessions + your own
nagent attach A/<sess> --line       # type, see no lag, exit with Ctrl-D
```

On node **C** (another fresh device, joined the same way):

```sh
nagent attach B/<sess>              # direct C→B works without going via A
                                    # (gossip wired authorized_keys both ways)
```

That last attach is the headline acceptance test for v0.3 mesh trust: **any node can attach to any session, regardless of which peer issued the invite.**

## Two-node verification (v0.2)

On the **issuer** (already running nagent, has a session you want to share):

```sh
nagent                            # open picker, then at the prompt:
> /invite --expires 1h            # prints a base64url token; copy it
> q
```

On the **joiner** (a fresh device after running the installer):

```sh
nagent join <token>               # SSHes to the issuer once, exchanges keys,
                                  # writes ~/.nagent/ssh_config + authorized_keys
nagent attach <issuerName>/<sess> # opens the issuer's session — Ctrl-Q to detach
```

The join handshake uses a one-time SSH key embedded in the token: the issuer's `~/.ssh/authorized_keys` gets a `command="nagent join-respond <id>",no-pty,...` entry, the joiner SSHes with the token's key, runs the constrained command (which can do nothing but the redeem RPC), receives the net's peer list + authority chain, and the one-time entry is removed. Both sides end up with each other's long-term ed25519 pubkeys in `authorized_keys`.

Hub-and-spoke: joiners can attach to the issuer (and to any peer whose `authorized_keys` was wired during their own join). v0.3 adds gossip so joiner-to-joiner attach works without re-inviting.

## Project Structure

```
nagent/
├── ARCHITECTURE.md        # Auto-generated path → purpose map
├── CLAUDE.md              # Durable conventions for Claude sessions
├── README.md              # This file
├── .githooks/             # Tracked git hooks (enable via core.hooksPath)
├── docs/
│   ├── PRD.md
│   ├── system_design.md
│   └── architecture/
├── scripts/               # Project automation (incl. map generator)
├── src/                   # TypeScript source, organized by domain
└── tests/                 # vitest unit + integration
```

### After cloning

Enable tracked git hooks (one-time):

```sh
git config core.hooksPath .githooks
```
