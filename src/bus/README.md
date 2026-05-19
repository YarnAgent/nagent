---
purpose: Inter-session bus — length-prefixed JSON frames over Unix socket, verbs, pattern matcher.
---

# src/bus/

Wire format: 4-byte big-endian length + UTF-8 JSON payload. Verbs: `HELLO`, `SEND`, `RECV`, `SUBSCRIBE`, `LIST`, `ACK`, `REGISTER_ROLE`, `RECV_DROPPED`. Pattern matcher supports `node/session`, `node/*`, `*/role:foo`. `hops` increments at each forwarder (v0.2 prep). Per-subscriber bounded queue with drop-oldest + synthetic `RECV_DROPPED` frames.
