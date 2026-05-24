import { sign as edSign, verify as edVerify } from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJson } from "../lib/canonical.js";
import { publicKeyFromRaw, privateKeyFromRaw } from "../ssh/identity.js";
import type { Peer } from "../types/index.js";

/**
 * Signed assertion sent peer-to-peer to extend the mesh: "I (callerPub),
 * already trusted in your peers.json, am asking you to also trust newPeer."
 *
 * Receivers verify `sig` against the corresponding peer's pubkey in their
 * local peers.json. Anyone in peers.json may sign — that's how the mesh
 * heals over time. Initial fanout after a join is signed by the issuer.
 */
export interface GossipAddPayload {
  v: 1;
  type: "gossip-add-peer";
  netId: string;
  callerPub: string;       // base64url raw 32 bytes (signer's long-term pub)
  callerNode: string;
  newPeer: Peer;
  ts: string;              // ISO timestamp; receiver enforces ±5min freshness
}

export interface SignedGossipAdd extends GossipAddPayload {
  sig: string;             // base64url ed25519 sig over canonical(payload sans sig)
}

export interface GossipAck {
  v: 1;
  ok: true;
  changed: boolean;        // false if already had the entry (idempotent no-op)
  echoedNodeName: string;
}

export interface GossipReject {
  v: 1;
  ok: false;
  error: string;
}

const FRESHNESS_MS = 5 * 60 * 1000;

/** Sign a gossip payload with the caller's long-term ed25519 private key. */
export function signGossipAdd(
  payload: GossipAddPayload,
  rawPriv32: Buffer,
  rawPub32: Buffer,
): SignedGossipAdd {
  const privKey = privateKeyFromRaw(rawPriv32, rawPub32);
  const sigBytes = edSign(null, Buffer.from(canonicalJson(payload), "utf8"), privKey);
  return { ...payload, sig: sigBytes.toString("base64url") };
}

/**
 * Verify a signed gossip payload.
 *
 * Returns `{ ok: true }` if the signature is valid against `callerPub`, the
 * timestamp is within FRESHNESS_MS of `now`, and the payload version is
 * supported. Otherwise `{ ok: false, error }`.
 *
 * The caller is responsible for cross-checking `callerPub` against its own
 * peers.json before honoring the request — this function only proves the
 * payload was signed by whoever holds `callerPub`'s private key.
 */
export function verifyGossipAdd(
  signed: SignedGossipAdd,
  now = new Date(),
): { ok: true } | { ok: false; error: string } {
  if (signed.v !== 1) return { ok: false, error: `unsupported version ${signed.v}` };
  if (signed.type !== "gossip-add-peer") return { ok: false, error: `unexpected type ${signed.type}` };
  if (!signed.sig) return { ok: false, error: "missing sig" };

  const ts = Date.parse(signed.ts);
  if (Number.isNaN(ts)) return { ok: false, error: `bad ts: ${signed.ts}` };
  const skew = Math.abs(now.getTime() - ts);
  if (skew > FRESHNESS_MS) return { ok: false, error: `stale: ts off by ${Math.round(skew / 1000)}s` };

  const callerPubRaw = Buffer.from(signed.callerPub, "base64url");
  if (callerPubRaw.length !== 32) return { ok: false, error: "malformed callerPub" };

  const newPubRaw = Buffer.from(signed.newPeer.pubKey, "base64url");
  if (newPubRaw.length !== 32) return { ok: false, error: "malformed newPeer.pubKey" };

  const { sig, ...unsigned } = signed;
  void unsigned;
  const canonical = canonicalJson(unsigned);
  const pubKey = publicKeyFromRaw(callerPubRaw);
  const sigBytes = Buffer.from(sig, "base64url");
  if (!edVerify(null, Buffer.from(canonical, "utf8"), pubKey, sigBytes)) {
    return { ok: false, error: "signature verification failed" };
  }
  return { ok: true };
}

/**
 * Build (but don't sign) the payload for a new gossip-add. Helper to keep
 * call sites tidy.
 */
export function buildGossipAdd(args: {
  netId: string;
  callerPub: string;
  callerNode: string;
  newPeer: Peer;
}): GossipAddPayload {
  return {
    v: 1,
    type: "gossip-add-peer",
    netId: args.netId,
    callerPub: args.callerPub,
    callerNode: args.callerNode,
    newPeer: args.newPeer,
    ts: new Date().toISOString(),
  };
}

/**
 * Send a signed gossip-add over SSH to the target peer. Returns the parsed
 * ack/reject. Throws on transport errors (ssh exit code != 0, no parseable
 * stdout). Used by the issuer's post-redeem fanout and by the daemon heal
 * pass.
 *
 * `sshHost` is the ssh_config Host alias (e.g. `nagent.bob`) or a literal
 * `user@host` — ssh will pick the right IdentityFile via the user's config.
 * We assume the caller's standing peer entry on the target's authorized_keys
 * is already in place (it must be, otherwise we couldn't make this call).
 */
export async function sendGossipAdd(
  sshHost: string,
  signed: SignedGossipAdd,
  opts: { timeoutMs?: number; extraSshArgs?: string[] } = {},
): Promise<GossipAck | GossipReject> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const extraSshArgs = opts.extraSshArgs ?? [];
  return new Promise((resolve, reject) => {
    // Wrap in `"$SHELL" -ilc` so nvm / fnm / mise get sourced and nagent is on
    // PATH. macOS sshd doesn't source .zprofile for non-interactive commands,
    // and the user's login shell may be zsh (so `bash -ilc` won't help either).
    const args = [
      ...extraSshArgs,
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      sshHost,
      "--",
      `"$SHELL" -ilc 'nagent gossip-add-peer'`,
    ];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gossip-add to ${sshHost} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString("utf8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`gossip-add to ${sshHost} failed (code ${code}): ${stderr || "(no stderr)"}`));
        return;
      }
      if (!stdout) {
        reject(new Error(`gossip-add to ${sshHost}: empty response`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as GossipAck | GossipReject;
        resolve(parsed);
      } catch (err) {
        reject(new Error(`gossip-add to ${sshHost}: bad JSON: ${(err as Error).message}\n${stdout}`));
      }
    });
    child.stdin.end(JSON.stringify(signed) + "\n");
  });
}

/** Bounded-concurrency parallel runner. Used by the issuer fanout + heal. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ item: T; result: R } | { item: T; error: Error }>> {
  const results: Array<{ item: T; result: R } | { item: T; error: Error }> = [];
  let cursor = 0;
  const inFlight: Promise<void>[] = [];
  const runOne = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx]!;
      try {
        const result = await worker(item);
        results[idx] = { item, result };
      } catch (err) {
        results[idx] = { item, error: err as Error };
      }
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    inFlight.push(runOne());
  }
  await Promise.all(inFlight);
  return results;
}
