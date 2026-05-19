---
purpose: Session management — thin wrapper over `tmux -L nagent` (new/attach/list/close).
---

# src/session/

We wrap tmux instead of reimplementing a multiplexer. Uses a dedicated tmux socket name (`nagent`) so the user's own `tmux ls` is never polluted. Internal session names are `s-<sessionId>`; user-visible name + project tag live in the daemon catalog. Attach paths `exec` tmux so the CLI process is replaced and the user's TTY is inherited cleanly.
