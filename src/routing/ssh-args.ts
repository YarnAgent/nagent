// Thin async wrapper around chooseTransport() that resolves the right SSH
// extra args for a target peer in the active net. All four SSH spawn sites
// in v0.5 call into this so the transport selection logic stays in one
// place.
//
// v0.5.1: when the chosen transport is via-relay, we look up the pinned
// record to discriminate `tls` (ProxyCommand) vs `ssh-jump` (-J).

import { readActiveState } from "../store/index.js";
import { paths } from "../platform/paths.js";
import { readPathTable } from "./probe.js";
import { findPinnedRelay } from "../relay/pinned.js";
import { magicDnsFor } from "./tailscale.js";
import { chooseTransport, transportSshArgs, type Transport } from "./index.js";

export interface ResolveTransportOpts {
  /** "auto" | "direct" | "<relay-name>". */
  via?: string;
}

export async function resolveSshTransportArgs(
  targetPeer: string,
  opts?: ResolveTransportOpts,
): Promise<string[]> {
  const transport = await resolveTransport(targetPeer, opts);
  return await renderArgs(transport, targetPeer);
}

async function resolveTransport(
  targetPeer: string,
  opts?: ResolveTransportOpts,
): Promise<Transport> {
  const active = await readActiveState();
  if (!active.activeNetId) {
    // No net yet → direct (the caller will likely error out for other reasons).
    if (opts?.via && opts.via !== "auto" && opts.via !== "direct") {
      return { type: "via", relay: opts.via };
    }
    return { type: "direct" };
  }
  const table = await readPathTable(active.activeNetId);
  return chooseTransport(table, targetPeer, { ...(opts?.via ? { via: opts.via } : {}) });
}

async function renderArgs(transport: Transport, targetPeer: string): Promise<string[]> {
  if (transport.type === "direct") return [];
  const pinned = await findPinnedRelay(transport.relay);
  if (pinned?.transport === "ssh-jump") {
    // Try to find a relay-resolvable name for the target. Tailscale MagicDNS
    // FQDNs are universally reachable from any tailscaled-running box, which
    // is what the relay typically is.
    const targetHostOverride = (await magicDnsFor(targetPeer)) ?? undefined;
    return transportSshArgs(transport, targetPeer, {
      pinnedKind: "ssh-jump",
      sshJumpTarget: pinned.sshTarget,
      jumpIdentityFile: paths().sshKey,
      ...(targetHostOverride ? { targetHostOverride } : {}),
    });
  }
  // Default (and explicit tls): ProxyCommand path.
  return transportSshArgs(transport, targetPeer, { pinnedKind: "tls" });
}
