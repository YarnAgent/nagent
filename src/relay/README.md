---
purpose: nagent-relay v0.5 — TLS-fronted dumb-pipe TCP rendezvous; clients register over a long-lived TLS conn and ask the relay to open opaque byte-streams between two registered peers. SSH stays end-to-end encrypted across the relay.
---

# `src/relay/`

Implementation of the v0.5 relay subsystem. See `docs/architecture/adr/0003-v0.5-nagent-relay.md` for protocol + threat model.

## Modules

- `frame.ts` — length-prefixed binary frame codec (1-byte verb + payload).
- `protocol.ts` — verb enum + hand-rolled payload validators.
- `server.ts` — relay daemon (TLS accept, REGISTER auth, stream routing).
- `client.ts` — long-lived registered conn, inbound-stream → localhost:22 bridge.
- `dial.ts` — `nagent relay-dial <peer>` ProxyCommand helper.
- `allowlist.ts` — union of mesh-peers.json + explicit grants.
- `cert.ts` — self-signed cert helper at `~/.nagent/relay/`.

## Wire protocol summary

Each frame: `[4-byte BE length][1-byte verb][verb-specific bytes]`.

| Verb | Hex | Direction | Payload |
|---|---|---|---|
| REGISTER, REGISTER_OK, REGISTER_REJECT | 0x01/02/82 | C→R / R→C | JSON |
| OPEN, OPEN_OK, OPEN_REJECT | 0x03/04/84 | both | JSON |
| DATA | 0x05 | both | `[4-byte streamId][raw bytes]` |
| CLOSE | 0x06 | both | `[4-byte streamId][optional JSON reason]` |
| PING, PONG | 0x07/08 | both | `[8-byte BE ts_micros]` |
| STATUS_REQ, STATUS_OK | 0x09/0a | C→R / R→C | empty / JSON |

Bare `streamId` is per-connection per-direction (not globally unique). The relay maps `(srcConn, srcSid) ↔ (dstConn, dstSid)`.
