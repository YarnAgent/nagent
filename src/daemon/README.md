---
purpose: `nagentd` long-running process — owns the bus socket, subscriber registry, and session catalog.
---

# src/daemon/

The single-node daemon. Binds `~/.nagent/sock`, accepts CLI clients, maintains the in-memory subscriber registry, mirrors tmux session state to `sessions.json`, and runs cleanup on SIGINT/SIGTERM. `--foreground` mode logs to stderr; default mode double-forks.
