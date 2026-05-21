# System Design — nagent

> Status: **Living document.** Current as of v0.3.1. Updates to behavior land here in the same PR as the code change.

This document is the entry point for understanding how nagent is shaped. It explains the moving parts at the level you'd need to land a non-trivial change. For the immutable record of *why* specific choices were made, see [ADRs](architecture/adr/).

## 1. What nagent is

A small CLI plus a long-running daemon (`nagentd`) per device. Devices form **nets** of mutually-trusting peers. Each device hosts **tmux sessions** that are addressable net-wide as `<peer>/<session>`. The CLI offers session management, an inter-process bus for agent-to-agent messaging, and — as of v0.3 — full mesh trust so any node can attach to any session without re-inviting.

The design choices are biased toward:

- **Boring, well-understood transport**: SSH for authenticated bytes; tmux for session multiplexing. No bespoke listening port, no rolled-our-own crypto layer on top of TLS.
- **One device = one identity**: a single ed25519 long-term keypair under `~/.nagent/ssh/nagent_ed25519`. The same key authenticates SSH connections and signs invite tokens + gossip payloads.
- **Plain JSON on disk**: every persistent record is a JSON file, atomically written, in `~/.nagent/`. No SQLite, no binary formats, no migration story other than versioning the file shape.

## 2. Components

```
                    ┌──────────────────────────────────────┐
                    │              User                     │
                    │  ($ nagent …)   (inside picker: /…)    │
                    └────────────────┬─────────────────────┘
                                     │ commander CLI
                                     ▼
            ┌────────────────────────────────────────────────────┐
            │             src/cli/  (short-lived process)         │
            │  bootstrap | picker | new/attach/list/close/send   │
            │  join | gossip-add-peer | attach-line | invite      │
            └─────┬────────────────┬────────────────┬────────────┘
                  │ Unix socket    │ ssh -- bash    │ tmux -L nagent
                  │ (length-       │ -ilc 'nagent …'│ (dedicated socket)
                  │ prefixed JSON) │                │
                  ▼                ▼                ▼
        ┌──────────────────┐ ┌──────────┐  ┌──────────────────┐
        │ src/daemon/      │ │ remote   │  │ tmux server      │
        │ (nagentd)        │ │ nagent   │  │ socket = nagent  │
        │  + subscriber    │ │ on peer  │  │  s-<sessionId>   │
        │    registry      │ │  device  │  │   sessions       │
        │  + session       │ └──────────┘  └──────────────────┘
        │    catalog       │
        │  + bus router    │
        └──────────────────┘
```

| Module | Lives in | Responsibility |
|---|---|---|
| **CLI** | `src/cli/` | Short-lived process. Parses argv, talks to the local daemon over the Unix socket, executes one-shot logic that doesn't need long-lived state. |
| **Daemon** (`nagentd`) | `src/daemon/` | One per device, auto-spawned. Owns the Unix socket, the subscriber registry, the session catalog. Survives across `nagent` invocations; tmux sessions outlive the daemon too. |
| **Bus** | `src/bus/` | Length-prefixed JSON frame protocol over the daemon's Unix socket. Pattern matcher (`<peer>/<sess>`, `*`, `<peer>/role:<name>`), per-subscriber bounded queues with drop-oldest semantics. |
| **Session** | `src/session/` | Thin wrapper over `tmux -L nagent` (own socket so user's `tmux ls` never sees nagent's sessions). |
| **Invite** | `src/invite/` | Token codec: base64url-wrapped JSON, signed by the issuer's long-term ed25519, embeds a one-time keypair used for the SSH handshake. |
| **Join** | `src/cli/join.ts` | Both sides of the redeem handshake: joiner's `cmdJoin` (SSH-execs the issuer's constrained command), issuer's `cmdJoinRespond` (validates + mutates state + fans out gossip). |
| **Gossip** | `src/gossip/` + `src/cli/gossip.ts` | Signed `GossipAddPayload` carrying "extend trust to this peer". `applyGossipAdd` is the receiver side; `sendGossipAdd` SSH-shells out. Issuer-relayed model: when A joins via I, I fans out to every other peer P. |
| **SSH wiring** | `src/ssh/` | `authorized_keys` fenced editor (everything nagent writes lives between `# >>> nagent managed >>>` / `# <<< nagent managed <<<`); `ssh_config` Host writer; identity helpers; reachable-address discovery. |
| **Store** | `src/store/` | Flat-JSON disk I/O — `readJson` / `writeJson` with atomic rename, mode enforcement, schema-stable load/save. |
| **Platform** | `src/platform/` | Paths abstraction (`~/.nagent/`, overridable via `NAGENT_HOME`). |
| **Project** | `src/project/` | Net-wide grouping of sessions. `.nagent` marker reader; cwd walker; project switch. |

## 3. The trust model

Two layers of cryptography:

1. **SSH** (transport layer) — every cross-node call is an `ssh peer -- <cmd>`. Authentication is OpenSSH's standard pubkey check against `~/.ssh/authorized_keys` on the peer.
2. **ed25519 over JSON** (application layer) — invite tokens and gossip payloads carry a signature over canonical JSON. The receiver verifies against a pubkey it already trusts. This is what lets us extend trust to new peers (the SSH layer can't authenticate a key it hasn't seen yet).

### The four identity facts a node holds

```
~/.nagent/
├── identity.json                     ─┐
├── ssh/nagent_ed25519                 │  this node
├── ssh/nagent_ed25519.pub             │
├── nets/<netId>/                      │
│   ├── meta.json                      │
│   ├── peers.json   ← list of other ─┤  the net (one per net we belong to)
│   │                  trusted nodes   │
│   ├── authority.json ← origin pubkey │
│   └── projects.json                 ─┘
└── ssh_config       ← per-peer Host blocks; included from ~/.ssh/config
```

`authority.json` records the **net origin pubkey** — the ed25519 pubkey of whoever first created the net. It's the root of trust for cases where we want an "admin override" path (e.g., origin-signed gossip can rotate any peer's pubkey).

### How a join propagates trust

```
issuer (I)                                joiner (A)
├ /invite                                 │
│  ├─ generates one-time keypair (otK)    │
│  ├─ embeds otK + I's pubkey + addrs in  │
│  │   a signed token                     │
│  └─ writes restricted authorized_keys   │
│     line: `command="nagent join-respond │
│     <id>",no-pty,...  ssh-ed25519 otK`  │
│                                         ▼
└─────── token (out-of-band) ────────►  ssh I -i <otK> -- /run constrained cmd/
                                         │  ↳ sends JOIN_REDEEM on stdin
issuer.cmdJoinRespond                    │
├ verifies invite is pending & unexpired │
├ writes joiner's pubkey to              │
│   ~/.ssh/authorized_keys (tagged)      │
├ writes joiner to peers.json            │
├ removes the one-time entry             │
├ writes JOIN_ACCEPTED to stdout         │
└ then (fire-and-forget, capped 12 s):   │
   fans out gossip-add-peer to all       │
   other peers in the net   ──────────────┐
                                         ▼
                                joiner reads JOIN_ACCEPTED
                                ├ writes net meta + peers + authority
                                ├ for each peer in JOIN_ACCEPTED: wirePeer
                                │  (writes ssh_config Host nagent.<name> +
                                │   appends peer's pubkey to local
                                │   authorized_keys)
                                └ done — joiner can now SSH to any peer it
                                          received in the JOIN_ACCEPTED
                                                                          
gossip targets (each peer P, in parallel)
└ ssh P -- '$SHELL -ilc nagent gossip-add-peer'  ← sends signed payload
   P.applyGossipAdd
   ├ verifies issuer signature against issuer's pubkey from P's peers.json
   ├ verifies freshness (±5 min window)
   ├ checks replay cache (gossip-seen.json)
   ├ rotation gate: if newPeer.nodeName exists with a different pubkey,
   │   only accept if signed by current-on-record pubkey (self-rotation)
   │   or the net origin
   ├ appends newPeer's pubkey to authorized_keys + peers.json + ssh_config
   └ returns {ok: true, changed: true} on stdout
```

The **two gossip directions** matter:
- **Forward** (issuer→peer about joiner): wires the joiner *into* each existing peer's authorized_keys. After this, each peer can verify SSH connections *from* the joiner.
- **Reverse** (joiner→peer, via the JOIN_ACCEPTED's `peers` list): wires each peer *into* the joiner's authorized_keys + ssh_config. After this, the joiner can initiate SSH connections *to* each peer.

A v0.4 follow-up is the **daemon-startup heal pass** — for peers that were offline during a gossip fanout, the heal pass re-pushes once they come back. Until then, manual gossip propagation is the recovery path (see `src/gossip/`).

### What's outside the trust model in v0.3

Two known gaps the ADR explicitly defers to v0.3.x / v0.4 (see [ADR-0001 §Deferred](architecture/adr/0001-v0.3-mesh-and-latency.md#deferred-to-v03x-out-of-scope-for-the-first-cut)):

- **Per-peer constrained `command=` SSH entries.** Currently a peer's `authorized_keys` line is unrestricted — full interactive shell. v0.4 will replace this with `command="nagent ssh-router"` that dispatches based on `$SSH_ORIGINAL_COMMAND`. Mesh trust will then mean "you can call a known set of nagent subcommands as me," not "full shell as me."
- **Binding `callerPub` to `$SSH_USER_AUTH_INFO_0`.** Once the SSH router is in place, gossip can additionally verify that the SSH-authenticated pubkey matches the `callerPub` claimed in the signed payload. Today only the application-layer signature is checked.

The v0.3 first cut contains the blast radius via the **rotation gate** (no peer can hijack another peer's `nodeName`), the **replay cache** (no payload can be re-applied within the freshness window), and **input validation** (`nodeName` / `sshUser` must match strict regexes before reaching authorized_keys / ssh_config).

## 4. Process model

```
┌──────────────────── one device ──────────────────────┐
│                                                       │
│  $ nagent  ←─ short-lived; auto-spawns:               │
│                                                       │
│  nagentd   ←─ long-lived daemon                        │
│   ├─ owns ~/.nagent/sock                              │
│   ├─ subscriber registry (who wants what bus frames)  │
│   └─ session catalog (sessions.json mirror)           │
│                                                       │
│  tmux -L nagent server ←─ separate from user's tmux   │
│   └─ s-<sessionId>  sessions                          │
│                                                       │
│  nagent attach-line (per-attach, short-lived)         │
│   └─ ~/.nagent/run/attach-<pid>/pane.fifo             │
└───────────────────────────────────────────────────────┘
```

- The CLI does not exec the daemon directly — it talks to it over the socket. If no daemon is running, the CLI's bootstrap step spawns one.
- Tmux sessions survive daemon restarts (tmux is its own process tree). Killing the daemon does not destroy sessions.
- `nagent attach <peer>/<sess>` does NOT proxy through the local daemon — it's a direct SSH to the peer. The peer's local daemon is what answers.

## 5. The bus

A small JSON-frame protocol over the daemon's Unix socket. Frame format: 4-byte big-endian length prefix + UTF-8 JSON.

| Verb | Direction | Purpose |
|---|---|---|
| `HELLO` | client → daemon | Identify as a CLI or as an in-session subscriber. |
| `SUBSCRIBE` | client → daemon | Add a pattern (`*`, `<node>/<sess>`, `<node>/role:<name>`) to this client's filter. |
| `SEND` | client → daemon | Deliver `payload` to every subscriber whose pattern matches `to`. |
| `RECV` | daemon → subscriber | Inbound message. |
| `LIST` / `LIST_RESULT` | client → daemon → client | Snapshot of sessions on this node. |
| `CREATE_SESSION` / `CLOSE_SESSION` / `SESSION_CREATED` / `SESSION_CLOSED` | client ↔ daemon | Session-lifecycle RPCs. |
| `REGISTER_ROLE` | client → daemon | Tag the current tmux session with a role string — addressable as `*/role:<name>`. |
| `RECV_DROPPED` | daemon → subscriber | Synthetic frame telling a slow subscriber it lost N messages. |
| `ACK` / `OK` / `ERROR` | daemon → client | Generic response shapes. |

Subscriber queues are bounded; on overflow, oldest gets dropped and a `RECV_DROPPED { dropped: N }` is emitted at the front of the live stream.

**v0.3 status:** the bus is single-daemon, single-device. Cross-node bus (persistent peer `bus-pipe` SSH tunnels) is deferred to v0.4. Until then, cross-node coordination happens via short-lived `ssh peer -- nagent <cmd>` calls — which is exactly how `nagent list` (fanout) and `nagent attach --line` (one long-lived SSH stream) work today.

## 6. Cross-node operations

### `nagent list` (net-wide, v0.3)

```
local nagent CLI
├ reads local sessions via daemon LIST
├ reads peers from ~/.nagent/nets/<netId>/peers.json
└ for each peer in parallel (cap 16, 8 s timeout each):
   └─ ssh nagent.<peer> -- '"$SHELL" -ilc \'nagent list --local --json\''
      ↳ peer's CLI prints {"v":1,"node":"<peer>","sessions":[…]}
local merges all responses, prints unified table with NODE column.
Unreachable peers shown as (unreachable) rows.
```

Wire format pinned by `tests/integration/list_wire.test.ts`. The last non-empty line of the remote stdout is parsed as JSON so any bootstrap noise from the remote ("started daemon …") is ignored.

### `nagent attach <peer>/<session>`

Three modes:

| Mode | Transport | Best for | Trade-off |
|---|---|---|---|
| **Default** (no flag) | `ssh -t <peer> -- nagent attach <session>` (remote tmux attach inside a real PTY) | LAN / Tailscale direct paths with RTT < ~50 ms | Per-keystroke RTT shows up as input lag on slower links. |
| **`--line`** | SSH stdin/stdout pipe to remote `nagent attach-line <session>`, which uses `tmux send-keys` and `tmux pipe-pane` | Shell-style sessions over high-RTT / lossy links | Doesn't support full-screen TUIs (vim, htop). Detects `alternate_screen` and warns. |
| **`--mosh`** | `mosh-client` ↔ `mosh-server` (UDP, predictive echo) | Full TUI work over lossy / mobile links | Requires `mosh` on both ends. |

`--line` is the v0.3 headline UX:

```
local                                       remote (peer)
[peer:session] $ ls            ←── readline echoes "ls" with zero RTT
                               
                               ssh stdin: "ls\n"
                                  ────────────────►
                                               nagent attach-line <session>
                                               ├ tmux send-keys -t <target> -l "ls"
                                               ├ tmux send-keys -t <target> "Enter"
                                               └ tmux pipe-pane → fifo → stdout
                                  ◄────────────────
                               ssh stdout: <pane bytes>
[peer:session] $ ls
total 48                       ←── output appears above redrawn prompt
…
```

Local readline owns the cursor and history; the SSH session is purely a byte conduit. Input feels instant regardless of RTT.

## 7. On-disk layout

```
~/.nagent/
├── identity.json                  # nodeId, nodeName, ed25519 pubkey
├── ssh/
│   ├── nagent_ed25519             # long-term ed25519 priv (OpenSSH PEM format)
│   └── nagent_ed25519.pub
├── ssh_config                     # nagent's managed Host blocks (included from ~/.ssh/config)
├── nets/
│   └── <netId>/
│       ├── meta.json              # netId, name, createdAt, originNode
│       ├── peers.json             # array of Peer { nodeName, pubKey, addresses, sshUser, roles }
│       ├── authority.json         # { originPubKey, delegations }
│       └── projects.json
├── active.json                    # { activeNetId, activeProjectId }
├── sessions.json                  # local session metadata (mirror of tmux truth)
├── invites.json                   # issued invite records { inviteId, state, expiresAt, … }
├── gossip-seen.json               # replay-cache: { entries: [{hash, expiresAt}] }
├── run/                           # per-process scratch (mode 0700)
│   └── attach-<pid>/
│       └── pane.fifo              # tmux pipe-pane target for --line
├── sock                           # daemon's Unix socket
├── daemon.pid
├── daemon.log
└── known_hosts                    # nagent's SSH known_hosts (not the user's)
```

All JSON files are written via `src/store/json.ts`'s atomic-rename helpers; partial-write tears are prevented. `authorized_keys` edits go through `src/ssh/authorized_keys.ts`, which keeps every nagent-managed line inside a fenced block and tags each one (`# nagent-tag=<tag>`) so updates and removals are surgical and never touch the user's other entries.

## 8. Cross-platform notes

- **Login shell sourcing.** Every cross-node SSH command wraps the inner command in `"$SHELL" -ilc <cmd>`. `$SHELL` is the remote user's login shell (bash on most Linux, zsh on macOS since Catalina). `bash -ilc` reads `.bashrc` only; it doesn't source `.zprofile`, so nvm/fnm/mise — which most macOS developers use — aren't on PATH and `nagent` isn't found. `"$SHELL" -ilc` evaluates to the right thing on each platform.
- **Tailscale CGNAT vs. LAN.** `src/ssh/addresses.ts` discovers every interface address; the join handshake stores the full list in `peers.json`. Today `ssh_config` HostName uses `addresses[0]` — which on most boxes is a LAN / docker / WSL2 IP, not the Tailscale CGNAT (100.64.0.0/10) address that's actually reachable across the Tailnet. Known issue ([#4](https://github.com/YarnAgent/nagent/issues/4)) — workaround is a manual `sed` patch of `~/.nagent/ssh_config`; fix is in the v0.3.x backlog.
- **macOS tmux.** Apple doesn't ship tmux. Users install via Homebrew (or, where brew isn't allowed, source-build into `~/.local/`).

## 9. Where to look in code

| Want to understand… | Start at |
|---|---|
| Bootstrap (first run on a new device) | `src/cli/bootstrap.ts ensureIdentity / ensureDefaultNet / ensureDaemon` |
| What a token looks like and how it's signed | `src/invite/index.ts InvitePayload / encodeToken` |
| The join handshake (joiner side) | `src/cli/join.ts cmdJoin` → `sshRedeem` |
| The join handshake (issuer side) | `src/cli/join.ts cmdJoinRespond` |
| How gossip fanout extends trust | `src/cli/join.ts` (look for the `runWithConcurrency` block after `process.stdout.write(JSON.stringify(accepted))`) |
| How a gossip receiver verifies + applies | `src/cli/gossip.ts applyGossipAdd` |
| Net-wide list fanout | `src/cli/list_net.ts fanoutSessionsAcrossNet` |
| `--line` attach (local end) | `src/cli/attach_modes.ts attachLine` |
| `--line` attach (remote end) | `src/cli/attach_line_server.ts cmdAttachLineServer` |
| Bus frame protocol | `src/bus/frame.ts` + `src/types/index.ts` (BusFrame union) |
| The pattern matcher | `src/bus/match.ts` |
| Authorized_keys fenced editor | `src/ssh/authorized_keys.ts` |

## 10. Trade-offs and alternatives

The most consequential design choices are recorded as ADRs so the *why* survives:

- **[ADR-0001 — v0.3: mesh trust, net-wide list, low-lag attach](architecture/adr/0001-v0.3-mesh-and-latency.md)** covers (a) the issuer-relay vs. joiner-walk gossip decision, (b) SSH fanout vs. cached/gossiped list, (c) `--line` (local readline) vs. mosh vs. building our own predictive echo, and (d) cross-node bus over peer SSH tunnels (deferred to v0.4).

When you add a new significant choice, copy `architecture/adr/0000-template.md` and write it up. Future contributors will thank you.

## 11. Known follow-ups (post-v0.3)

Tracked in [GitHub issues](https://github.com/YarnAgent/nagent/issues). The biggest items:

- **#4** — `wireHostEntryForPeer` should prefer Tailscale CGNAT addresses.
- Per-peer `command="nagent ssh-router"` constrained authorized_keys entries (turns mesh trust from "full shell" into "a known set of subcommands").
- Bind `callerPub` ↔ `$SSH_USER_AUTH_INFO_0` for gossip.
- Daemon-startup heal pass (recover from peers offline during a gossip fanout).
- Cross-node bus (persistent `nagent bus-pipe` SSH multiplexed channels).
- `/web` — browser stream into a session.
- `/install-service` — systemd / launchd unit installer for `nagentd`.
