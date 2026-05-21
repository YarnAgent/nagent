---
purpose: Mesh-trust extension — signed gossip-add-peer protocol that distributes new peer pubkeys across the net so any-to-any direct SSH attach works without re-inviting (v0.3+).
---

# gossip/

After a successful invite redeem the issuer fans out **on the joiner's behalf** to every other peer in the net via the `nagent gossip-add-peer` constrained SSH command. Each peer that receives the gossip verifies the signature against its local `peers.json` (the caller must already be a known peer), then appends the new peer to its own `authorized_keys` + `peers.json` + `ssh_config`.

This solves the v0.2 hub-and-spoke limitation where only the issuer could reach the joiner via SSH.

Daemon-startup heal pass uses the same protocol to reconcile peers that were offline during a previous fanout.

## Files

- `index.ts` — signing/verifying gossip payloads, the SSH-shellout `sendGossipAdd`, and a small bounded-concurrency runner used by the fanout.

## Design

See [ADR-0001](../../docs/architecture/adr/0001-v0.3-mesh-and-latency.md) §1.
