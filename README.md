# nagent

> Agent net — a decentralized mesh CLI for cooperating agents across nodes.
>
> **Current release: [v0.3.1](https://github.com/YarnAgent/nagent/releases/tag/v0.3.1)** — mesh peer trust, net-wide `list`, low-lag `attach --line`. See [CHANGELOG via tags](https://github.com/YarnAgent/nagent/releases) for milestone history.
>
> **Unreleased — in flight on `feat/v0.5-relay`:** `nagent relay serve` (dumb-pipe TCP rendezvous), `nagent relay add/grant` (cert pinning + allowlist), `nagent attach --via <auto|direct|relay>`, latency-aware path selection with 10 ms hysteresis. Makes Tailscale optional. See [ADR-0003](docs/architecture/adr/0003-v0.5-nagent-relay.md).

## What it does

```
┌───────────────────────────────────────────────────────────────────────────┐
│   node A (Linux)          node B (macOS)         node C (macOS)           │
│   ├─ tmux session         ├─ tmux session        ├─ tmux session          │
│   ├─ nagentd              ├─ nagentd             ├─ nagentd               │
│   └─ ed25519 identity     └─ ed25519 identity    └─ ed25519 identity      │
│        │                       │                      │                   │
│        └─ ssh / nagent bus ────┴──── mesh trust ──────┘                   │
│                                                                           │
│   `nagent list`        → sessions from every reachable peer in the net    │
│   `nagent attach A/foo`→ from any node, drop into A's tmux session "foo"  │
│   `attach … --line`    → local readline, zero per-keystroke RTT           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Documentation

- **[System Design](docs/system_design.md)** — start here. Trust model, data shape, process model, cross-node operations.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — auto-generated path → purpose map.
- **[ADRs](docs/architecture/adr/)** — Architecture Decision Records (one per significant choice). [ADR-0001](docs/architecture/adr/0001-v0.3-mesh-and-latency.md) covers v0.3's design.
- **[CLAUDE.md](CLAUDE.md)** — durable conventions for Claude Code sessions in this repo.

## Install

Prereqs: macOS or Linux, Node ≥ 22, tmux ≥ 3.0, OpenSSH client.

```sh
npm install -g https://codeload.github.com/YarnAgent/nagent/tar.gz/v0.3.1
nagent --version
```

(We use the codeload tarball URL rather than the `github:YarnAgent/nagent` shorthand because the shorthand triggers a known npm git-dep symlink bug.)

## Quick start (single node)

```sh
mkdir -p /tmp/nagent-demo && cd /tmp/nagent-demo
nagent                       # auto-bootstrap: identity → default net → daemon
                             # then the picker REPL opens. At the prompt:
                             #   /help
                             #   /project init demo-proj
                             #   n                       ← creates a session
                             #   alpha                   ← name when prompted
                             # You're attached to a tmux pane. Inside:
                             #   nagent register-role agent-alpha
                             #   Ctrl-Q to detach (session persists)
                             #   `exit` or `nagent close` to destroy
```

Top-level CLI is sessions-only:

```sh
nagent ls                    # list sessions across the active net (was v0.2 local-only; v0.3 fans out)
nagent ls --local            # local-only behavior (v0.2 shape)
nagent new beta              # create + attach
nagent attach alpha          # attach an existing local session
nagent attach A/alpha        # attach a session on remote peer "A"
nagent attach A/alpha --line # low-lag attach: local readline + remote send-keys
nagent attach A/alpha --mosh # mosh transport (when both ends have mosh)
nagent close beta            # destroy a session (with explicit name from outside)
nagent send <addr> [json]    # bus send
nagent recv --subscribe X    # bus receive (line-oriented JSON frames)
nagent register-role <role>  # tag the current session
nagent daemon --foreground   # run nagentd in the foreground (admin/debug)
```

Net / project / deferred verbs are **slash commands inside the picker**: `/net create`, `/net status`, `/net list`, `/net switch`, `/project init`, `/project list`, `/project switch`, `/invite`, `/join`, `/help`, `/quit`. Deferred to v0.4: `/web`, `/install-service`, `/uninstall-service`, `/project clone`.

### Leaving a session

| Goal | How |
|---|---|
| Detach (session keeps running) | **`Ctrl-Q`** — or the standard `Ctrl-B d` |
| Destroy the session | `exit` / Ctrl-D in the only pane, or `nagent close` from inside |
| Quit the picker REPL | `q` at the `>` prompt (or empty enter / Ctrl-C — none of which destroy anything) |

## Multi-node setup

### Invite a new device

On the **issuer** (already running nagent):

```sh
nagent
> /invite --expires 1h            # prints a base64url token; copy it
> q
```

On the **joiner** (a fresh device after installing nagent):

```sh
nagent join <token>               # SSHes to the issuer once, exchanges keys,
                                  # writes ~/.nagent/ssh_config + authorized_keys.
                                  # v0.3+: issuer also gossips the new peer to
                                  # every existing peer in the net, so mesh
                                  # trust is wired without re-inviting.
```

### Verify mesh trust across three nodes

```sh
# On any node:
nagent list                       # shows sessions from every reachable peer,
                                  # plus (unreachable) rows for any offline peer.

# Direct cross-node attach (any node → any session in the net):
nagent attach <peer>/<session>
nagent attach <peer>/<session> --line   # zero per-keystroke RTT
```

This works regardless of which peer issued the invite — gossip wired `authorized_keys` end-to-end. See [ADR-0001 §1](docs/architecture/adr/0001-v0.3-mesh-and-latency.md) for the gossip design.

## Operational notes

- `~/.nagent/` is the per-user root. Override with `NAGENT_HOME=/path/to/dir` for isolated testing.
- The dedicated tmux socket is `tmux -L nagent` — your own `tmux ls` and `nagent list` never collide.
- The auto-spawned daemon logs to `~/.nagent/daemon.log` and writes its pid to `~/.nagent/daemon.pid`. Set `NAGENT_NO_BOOTSTRAP=1` to bypass auto-bootstrap (used by tests).
- Cross-node SSH wrappers use `"$SHELL" -ilc <cmd>` so nvm/fnm/mise are sourced on remote macOS (zsh) and Linux (bash) consistently.

## Project layout

```
nagent/
├── ARCHITECTURE.md        # Auto-generated path → purpose map
├── CLAUDE.md              # Durable conventions for Claude Code sessions
├── README.md              # This file
├── .githooks/             # Tracked git hooks (enable via core.hooksPath)
├── .claude/agents/        # Project-scoped Claude subagents
├── docs/
│   ├── system_design.md   # ← start here for architecture
│   ├── PRD.md
│   └── architecture/
│       └── adr/           # ADRs — one per significant choice
├── scripts/               # Project automation (incl. map generator)
├── src/                   # TypeScript source, organized by domain
└── tests/                 # vitest unit + integration
```

### After cloning

Enable tracked git hooks (one-time):

```sh
git config core.hooksPath .githooks
```

## Milestone history

| Tag | What shipped |
|---|---|
| **v0.5.1** (in flight) | `ssh-jump` transport — relay is any sshd-running box with the client's nagent pubkey in `authorized_keys`. Traffic flows over `ssh -J`. Works through every middlebox that allows port 22 (including restrictive cloud edges where the v0.5 TLS variant gets RST'd). `nagent relay add ssh://user@host --copy-id`. |
| **v0.5** (in flight) | `nagent relay serve` — dumb-pipe TCP rendezvous on TLS:8443 with self-signed cert pinning; latency-aware `chooseTransport` w/ 10 ms hysteresis (Tailscale-style); `--via auto\|direct\|<relay>` flag on attach; ssh ProxyCommand wired at every SSH spawn site. Tailscale becomes **optional**. ([ADR-0003](docs/architecture/adr/0003-v0.5-nagent-relay.md)) |
| **v0.4** (in flight) | `nagent web serve` + xterm.js SPA — browser access to mesh sessions via SSH-tunneled ttyd. Default browser input is Line mode (single-line buffered shell, zero per-keystroke RTT). ([ADR-0002](docs/architecture/adr/0002-v0.4-web-hub.md)) |
| **v0.3.1** | Fix: cross-node gossip ssh now wraps in `"$SHELL" -ilc` for macOS zsh compatibility. |
| **v0.3.0** | Mesh peer trust via gossip (any-to-any attach without re-inviting); net-wide `list` via SSH fanout; low-lag `attach --line` (local readline + remote `tmux send-keys`) and `--mosh`. |
| **v0.2** (pre-tag, in `main`) | Hub-and-spoke multi-node: `nagent join <token>`, `nagent attach <peer>/<session>` via plain SSH; cross-device install via `scripts/install.sh`. |
| **v0.1** (pre-tag) | Single-node baseline: tmux session management, local bus (`send` / `recv` / `subscribe`), project marker, picker REPL. |

## Routing (v0.5 preview)

`nagent attach` picks the best transport per peer using a node-local path-table. v0.5 ships **two relay transports**:

### `ssh-jump` (v0.5.1) — recommended default

The simplest possible relay: **the relay is just an sshd-running box** that holds your nagent ed25519 pubkey in `authorized_keys`. Traffic flows as `ssh -J relay user@target` — port 22 is universally allowed by every firewall, ISP, and cloud edge, so this works **everywhere**, including behind aggressive TLS inspection (mainland-CN cloud edges, corporate proxies).

```sh
# On any reachable Linux box with sshd (the "relay") — nothing to install:

# On every client:
nagent relay add ssh://ubuntu@your-jump-box --copy-id --name jump-eu
nagent attach <peer>/<session> --via jump-eu      # force ssh-jump
nagent attach <peer>/<session>                    # auto-pick after a probe round
```

`--copy-id` installs the local nagent pubkey into the relay's `~/.ssh/authorized_keys`. If you already trust your nagent identity on that box, you can skip it. The relay needs to be able to reach the target peer (typically via Tailscale).

### `tls` (v0.5) — long-lived TLS rendezvous

A persistent TLS daemon (`nagent relay serve --port 8443`) with self-signed cert pinning. Carries opaque streams over TLS. Useful when SSH outbound is constrained but HTTPS-like traffic isn't (rare); blocked on networks that drop self-signed TLS on non-443 ports (most mainland-CN cloud edges).

```
client                                 relay (any sshd-less box w/ public IP)        target
  │  long-lived TLS:8443 ──────────────►│ ◄──────────── long-lived TLS:8443  │
  │                                     │                                    │ → localhost:22
  │  OPEN dst=target                    │ ── OPEN srcNode=client ─────────►  │
  │                                     │                                    │
  │ ◄═══════ DATA — opaque ciphertext (relay never decrypts) ═══════════════►│
  │            ssh handshake + session, end-to-end encrypted                 │
```

```sh
# On a public-IP box:
nagent relay serve --port 8443
# → prints fingerprint AB:CD:…

# Allow specific peers via mesh peers.json (auto) or explicitly:
nagent relay grant <node-name> <pubkey-base64url>

# On every client:
nagent relay add https://your-relay-host:8443   # TOFU fingerprint pin
```

### Auto-selection across both transports

Both transports register the same way in the path-table. The daemon probes them every 60 s — direct TCP-connect for `direct`, STATUS pull for TLS relays, and a real `ssh -J … true` probe for ssh-jump relays. `chooseTransport` picks the lowest-latency candidate with 10 ms hysteresis. Manual override:

```sh
nagent attach <peer>/<session> --via auto       # default: best latency
nagent attach <peer>/<session> --via direct     # force direct (no relay)
nagent attach <peer>/<session> --via <name>     # force a specific relay
nagent path status                              # inspect path-table
```

Deferred to **v0.4**: per-peer `command=` SSH router (constrains peer access to a known set of nagent subcommands), `callerPub`-to-`$SSH_USER_AUTH_INFO_0` binding for gossip, daemon-startup heal pass, cross-node bus over persistent peer SSH tunnels (`bus-pipe`), `/install-service` for platform daemon units.

Deferred to **v0.5.x / v0.6**: multi-hop relay chains, mid-session failover, Let's Encrypt cert provisioning, gossip-based relay auto-discovery.

Open follow-ups: see [issues](https://github.com/YarnAgent/nagent/issues).
