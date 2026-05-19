---
purpose: Architecture overview and decision records (ADRs).
---

# Architecture

This directory holds architectural documentation for nagent.

## Contents

- **[adr/](adr/)** — Architecture Decision Records. Each significant architectural choice gets its own ADR documenting the context, decision, and consequences.
- **[../system_design.md](../system_design.md)** — Living high-level system design document.
- **[../PRD.md](../PRD.md)** — Product requirements that drive the architecture.

## When to Add an ADR

Add an ADR when you:
- Choose a major dependency, framework, or language
- Decide on a data storage approach
- Pick a deployment or hosting model
- Establish a cross-cutting pattern (auth, error handling, observability)
- Reverse or supersede a prior decision

## ADR Workflow

1. Copy [adr/0000-template.md](adr/0000-template.md) → `adr/NNNN-short-title.md`
2. Fill in Context, Decision, Consequences
3. Set status to `Proposed`
4. After acceptance, change status to `Accepted`
5. If superseded later, mark `Superseded by ADR-NNNN`
