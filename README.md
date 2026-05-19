# nagent

> Brief one-line description of the project.

## Overview

TBD — high-level architectural overview goes here.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — auto-generated path → purpose map (read this first)
- [Product Requirements](docs/PRD.md)
- [System Design](docs/system_design.md)
- [Architecture Overview](docs/architecture/README.md)
- [Architecture Decision Records](docs/architecture/adr/)

## Getting Started

TBD — setup, install, and run instructions.

### After cloning

Enable tracked git hooks (one-time):

```sh
git config core.hooksPath .githooks
```

## Project Structure

```
nagent/
├── ARCHITECTURE.md        # Auto-generated path → purpose map
├── CLAUDE.md              # Durable conventions for Claude sessions
├── README.md              # This file
├── .githooks/             # Tracked git hooks (enable via core.hooksPath)
├── docs/
│   ├── PRD.md             # Product requirements
│   ├── system_design.md   # High-level system design
│   └── architecture/
│       ├── README.md      # Architecture overview
│       └── adr/           # Architecture Decision Records
├── scripts/               # Project automation (incl. map generator)
├── src/                   # Source code (organized by feature/domain)
└── tests/                 # Tests
```
