---
purpose: Shared TypeScript types — identities, nets, projects, sessions, bus frames.
---

# src/types/

Pure type declarations consumed across modules. No runtime exports beyond zod-style shape guards where strictly needed. Bus frame types use a discriminated union on `verb`.
