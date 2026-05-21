---
purpose: nagent-web hub — HTTPS server that gives browsers access to tmux sessions across the mesh by SSH-tunnelling to a per-session ttyd on the owning peer (v0.4+).
---

# web/

The `nagent-web` hub. Any node can opt in by running `nagent web serve`. The hub:

- Terminates HTTPS (self-signed cert under `~/.nagent/web/`, pinned by clients via `nagent web trust`).
- Serves the xterm.js SPA + a session-discovery API that fans out across the mesh via the same code path as `nagent list`.
- On WebSocket upgrade for `/ws/<node>/<name>`, opens an SSH connection to the owning peer with Unix-domain socket forwarding, spawns `ttyd` bound to that socket, and proxies WebSocket bytes through it.

Browser users only ever talk to the hub. Peer nodes don't need to run any web server — they just need `ttyd` installed.

## Files

- `index.ts` — public surface (`runHub`, types).
- `cert.ts` — self-signed cert generation / load.
- `token.ts` — HMAC bearer tokens for `/ws` routes.
- `server.ts` — HTTPS routing + WebSocket proxy.
- `static/` — the SPA (HTML + bundled xterm.js).

## Design

See [ADR-0002](../../docs/architecture/adr/0002-v0.4-web-hub.md).
