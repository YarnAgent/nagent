---
purpose: Invite token codec — Iroh-/Tailscale-shaped tokens with a one-time SSH key for the join handshake.
---

# src/invite/

Generates and verifies self-contained invite tokens. Each token packs:

- `netId`, `netName`, issuer node identity (long-term ed25519 pub)
- Issuer's reachable addresses (`host:port`)
- A **fresh one-time ed25519 keypair**: the joiner uses this key to SSH into the issuer for the redemption handshake. The issuer's `~/.ssh/authorized_keys` carries a `command="nagent join-respond <inviteId>"` entry for the one-time pubkey, so the joiner can only run the redeem RPC — not get a shell.
- `nonce`, `expiresAt`, `flags`
- ed25519 `sig` by the issuer's long-term private over the rest of the payload

Tokens are signed JSON wrapped in base64url. Verification re-canonicalises (sorted keys) before checking the signature.

The token is the credential. Leaking it grants only constrained SSH access (the `command=` restriction caps blast radius) for the lifetime of the expiry; rotate fast by setting short `--expires`.
