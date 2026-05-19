# CLAUDE.md — nagent

Durable conventions and project-specific guidance for Claude sessions in this repository.

## Architecture

- **High-level design**: see [docs/system_design.md](docs/system_design.md)
- **Requirements**: see [docs/PRD.md](docs/PRD.md)
- **Decisions**: see [docs/architecture/adr/](docs/architecture/adr/) — every non-trivial architectural choice gets an ADR.

## Conventions

- Source code lives under `src/`, organized by feature/domain (not by type).
- Tests live under `tests/`, mirroring the `src/` layout.
- Files should typically stay under 400 lines; 800 is the hard ceiling.
- Follow the global coding-style, security, and testing rules from `~/.claude/rules/ecc/common/`.

## Workflow

- Before implementing: search GitHub and package registries for existing solutions (per development-workflow.md).
- Use the **planner** agent for non-trivial features; produce a PRD / system_design / task_list before coding.
- TDD: write the failing test first, then implement, then refactor.
- After writing code: run **code-reviewer** (and **security-reviewer** for sensitive code).

## Git Hooks

Tracked hooks live in `.githooks/`. After cloning, run once:

```sh
git config core.hooksPath .githooks
```

- `post-commit`: auto-pushes `main` to `origin/main`. Skips on any other branch. Never force-pushes.

## Open Questions

- Language / runtime: TBD
- Primary framework: TBD
- Storage: TBD
