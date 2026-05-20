---
purpose: SSH wiring — authorized_keys fenced editor, ssh_config writer, identity helpers, reachable-address detection.
---

# src/ssh/

Manages the user's SSH state in **fenced blocks** so nagent only ever owns its own region — never the user's existing config.

- `identity.ts` — load the node's ed25519 keypair (`~/.nagent/ssh/nagent_ed25519` PEM) and produce raw 32-byte material + OpenSSH `authorized_keys` lines.
- `authorized_keys.ts` — append/replace/remove lines inside a fenced block in `~/.ssh/authorized_keys`, tagged so we can find them later.
- `ssh_config.ts` — own `~/.nagent/ssh_config` (one `Host nagent.<peer>` block per peer); ensure `Include ~/.nagent/ssh_config` is in `~/.ssh/config` exactly once.
- `addresses.ts` — best-effort reachable address detection for invite tokens.

**Hard rules** (asserted in tests):
- **Never** emit `ForwardAgent yes` in any nagent-written config.
- `StrictHostKeyChecking accept-new` (TOFU on first contact, warn on key change).
- Write only to `~/.ssh/*` and `~/.nagent/*`; never `/etc/ssh/*`.
- Files: dir `0700`, files `0600`, atomic rename for catalog writes.
