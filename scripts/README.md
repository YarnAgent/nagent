---
purpose: Project automation scripts (build, codegen, hooks helpers).
---

# scripts/

Bash/utility scripts invoked by hooks, CI, or developers.

- `build-arch-map.sh` — regenerates `ARCHITECTURE.md` from per-directory `purpose:` frontmatter. Wired into `.githooks/pre-commit`.
