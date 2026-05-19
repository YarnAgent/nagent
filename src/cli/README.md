---
purpose: `nagent` CLI surface (commander) — entry point, picker, all v0.1 verbs, deferred-verb stubs.
---

# src/cli/

User-facing command surface. The `bin` entry in `package.json` points at `dist/cli/index.js`. All subcommands talk to the daemon through `src/bus/` over `~/.nagent/sock`; nothing touches state directly except `init`, which lays the directory tree before any daemon exists.
