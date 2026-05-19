---
purpose: Flat-JSON disk store — atomic rename writes, permission enforcement.
---

# src/store/

All `~/.nagent/` state is small JSON files. Reads tolerate missing files; writes go through `fs.write(tmp) → fs.rename(tmp, target)` to avoid torn reads. The root directory is forced to `0700` and all files to `0600` on every write. No SQLite (see ADR-0005).
