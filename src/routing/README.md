---
purpose: v0.5 routing layer — TCP-connect direct probes + relay STATUS pulls compose into a per-net path-table; chooseTransport() applies 10ms hysteresis (Tailscale-style) and returns either {type:"direct"} or {type:"via", relay} for the SSH spawn sites to wrap with -o ProxyCommand.
---

# `src/routing/`

Path-aware transport selection for v0.5 (ADR-0003).

## Modules

- `probe.ts` — `probeDirect()` TCP-handshakes peer.addresses[0]:22; `pullRelayStatus()` round-trips STATUS_REQ over an existing RelayClient connection. Writes `~/.nagent/nets/<netId>/path-table.json` atomically.
- `index.ts` — `chooseTransport(target, opts)` reads the path-table and returns the lowest-latency transport. Hysteresis: stick with `opts.stickyTo` if its score is within `hysteresisMs` (default 10ms) of the best.

## Path-table schema

```json
{
  "v": 1,
  "node": "WSL26",
  "updatedAt": "2026-05-22T...",
  "direct": { "<peer>": { "ms": 42, "lastOk": "..." } },
  "relays": {
    "<relayName>": {
      "myRttMs": 18,
      "lastSeen": "...",
      "peers": { "<peer>": { "ms": 30, "lastSeen": "..." } }
    }
  }
}
```

For via-relay candidates the score is `myRttMs + peers[target].ms` (additive estimate; sub-optimal vs. an actual SSH-through-relay probe but cheap and good enough for the v0.5 first cut).
