# nagent

> Agent net — a decentralized mesh CLI for cooperating agents across nodes.
>
> **v0.1 status**: single-node only. Every concept (node, net, project, session, bus) works on one machine. Multi-node mesh / SSH wiring / web stream are in the TODO list (see `docs/architecture/adr/` and the v0.1 plan).

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — auto-generated path → purpose map (read this first)
- [Product Requirements](docs/PRD.md)
- [System Design](docs/system_design.md)
- [Architecture Overview](docs/architecture/README.md)
- [Architecture Decision Records](docs/architecture/adr/)

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
