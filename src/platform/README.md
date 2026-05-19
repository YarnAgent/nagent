---
purpose: Platform abstraction — paths, launchd/systemd unit writers, perm enforcement.
---

# src/platform/

Resolves `~/.nagent/` and `tmux -L nagent` paths, writes launchd plist (`~/Library/LaunchAgents/dev.nagent.daemon.plist`) on macOS and a systemd user unit (`~/.config/systemd/user/nagent.service`) on Linux. WSL2 may need `loginctl enable-linger`; the `--foreground` daemon path is the documented fallback.
