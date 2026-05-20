import { networkInterfaces } from "node:os";

export interface ReachableAddress {
  host: string;
  port: number;
}

/**
 * Best-effort detection of locally-reachable IPv4 addresses for an invite token.
 * Filters loopback and link-local; returns one entry per non-internal interface.
 * Always paired with port 22 (sshd default). Override via `nagent invite --addr`.
 */
export function currentReachableAddresses(port = 22): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const seen = new Set<string>();
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      if (info.address.startsWith("169.254.")) continue; // link-local
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      out.push({ host: info.address, port });
    }
  }
  return out;
}

export function parseAddressArg(arg: string, defaultPort = 22): ReachableAddress {
  const idx = arg.lastIndexOf(":");
  if (idx > 0) {
    const host = arg.slice(0, idx);
    const port = Number.parseInt(arg.slice(idx + 1), 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) return { host, port };
  }
  return { host: arg, port: defaultPort };
}
