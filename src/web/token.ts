import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { paths } from "../platform/paths.js";

export interface TokenPayload {
  /** target peer node name (or "*" for "any session on the hub's node") */
  node: string;
  /** target session name */
  session: string;
  /** issued-at, unix ms */
  iat: number;
  /** expires-at, unix ms */
  exp: number;
  /** readonly access (browser cannot send keystrokes) */
  ro: boolean;
}

interface WebConfig {
  v: 1;
  hmacSecret: string; // base64url
  port?: number;
}

const TOKEN_VERSION = "v1";
const PAYLOAD_SEPARATOR = ".";

/**
 * Read (or create) the hub's persistent web config under `~/.nagent/web.json`.
 * Stores the HMAC secret used to sign `/ws/*` bearer tokens. The file is
 * mode 0600 — anyone with read access to the file can forge tokens, but the
 * blast radius is bounded to one node's sessions.
 */
export async function loadOrGenerateWebConfig(): Promise<WebConfig> {
  const path = paths().webConfig;
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as WebConfig;
    if (parsed.v === 1 && typeof parsed.hmacSecret === "string") return parsed;
  } catch {
    /* fall through to generate */
  }
  const fresh: WebConfig = {
    v: 1,
    hmacSecret: randomBytes(32).toString("base64url"),
  };
  await fs.mkdir(paths().webDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
}

/**
 * Encode + sign a bearer token. Wire format:
 *   v1.<base64url(payload)>.<base64url(hmac)>
 */
export function mintToken(payload: TokenPayload, hmacSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signBody(body, hmacSecret);
  return [TOKEN_VERSION, body, sig].join(PAYLOAD_SEPARATOR);
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; error: string };

/**
 * Verify a bearer token. Returns the decoded payload on success.
 *
 * Failure modes (each distinguishable so the hub can log usefully):
 *   - "unknown version"     : token prefix is not v1
 *   - "malformed"           : missing/extra parts, bad base64, bad JSON
 *   - "bad signature"       : HMAC mismatch (constant-time compared)
 *   - "expired"             : exp < now
 *   - "not yet valid"       : iat > now + clock-skew window
 */
export function verifyToken(token: string, hmacSecret: string, now = Date.now()): VerifyResult {
  const parts = token.split(PAYLOAD_SEPARATOR);
  if (parts.length !== 3) return { ok: false, error: "malformed" };
  const [version, body, sig] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, error: "unknown version" };
  if (!body || !sig) return { ok: false, error: "malformed" };

  const expectedSig = signBody(body, hmacSecret);
  const sigBuf = bufferFromBase64Url(sig);
  const expBuf = bufferFromBase64Url(expectedSig);
  if (!sigBuf || !expBuf || sigBuf.length !== expBuf.length) return { ok: false, error: "bad signature" };
  if (!timingSafeEqual(sigBuf, expBuf)) return { ok: false, error: "bad signature" };

  let payload: TokenPayload;
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(decoded) as TokenPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    return { ok: false, error: "malformed" };
  }
  // 30-second clock-skew tolerance on iat.
  if (payload.iat - 30_000 > now) return { ok: false, error: "not yet valid" };
  if (payload.exp <= now) return { ok: false, error: "expired" };
  return { ok: true, payload };
}

function signBody(bodyBase64Url: string, hmacSecret: string): string {
  return createHmac("sha256", Buffer.from(hmacSecret, "base64url"))
    .update(bodyBase64Url)
    .digest("base64url");
}

function bufferFromBase64Url(s: string): Buffer | null {
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}
