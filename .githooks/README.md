---
purpose: Tracked git hooks (enable via `git config core.hooksPath .githooks`).
---

# .githooks/

Version-controlled git hooks. Activate once per clone:

```sh
git config core.hooksPath .githooks
```

- `pre-commit` — regenerates `ARCHITECTURE.md` from per-directory purpose fields and stages it.
- `post-commit` — auto-pushes `main` to `origin/main` (skips on other branches; never force-pushes).
