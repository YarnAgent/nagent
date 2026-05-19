---
purpose: Project concept — net-wide grouping; `.nagent` marker reader/writer; cwd-walker.
---

# src/project/

A project is `{projectId, name, netId, createdAt, createdByNode}` stored in the net's `projects.json`. Each project's working directory carries a `.nagent` JSON marker (no secrets). cwd → project resolution walks up the directory tree like `git`, stopping at the first ancestor containing `.nagent`.
