import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  assertNotExpired,
  decodeAndVerify,
  encodeToken,
  generateOneTimeKey,
  INVITE_VERSION,
  newInviteId,
  newNonce,
  oneTimePrivKey,
  type InvitePayload,
} from "../../src/invite/index.js";

function makeIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubX = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { privateKey, pubX };
}

function makePayload(overrides: Partial<InvitePayload> = {}): InvitePayload {
  const { pub, priv } = generateOneTimeKey();
  return {
    v: INVITE_VERSION,
    netId: "n-aaaa",
    netName: "demo",
    inviteId: newInviteId(),
    issuerNode: "alice",
    issuerPub: "PLACEHOLDER",
    issuerSshUser: "root",
    issuerAddrs: [{ host: "127.0.0.1", port: 22 }],
    oneTimePub: pub,
    oneTimePriv: priv,
    nonce: newNonce(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("invite token codec", () => {
  it("round-trips encode → decode + verify", () => {
    const { privateKey, pubX } = makeIssuer();
    const payload = makePayload({ issuerPub: pubX });
    const token = encodeToken(payload, privateKey);
    const decoded = decodeAndVerify(token);
    expect(decoded.netId).toBe("n-aaaa");
    expect(decoded.issuerNode).toBe("alice");
    expect(decoded.v).toBe(INVITE_VERSION);
    expect(decoded.sig).toBeTypeOf("string");
  });

  it("rejects a tampered payload (post-encoding mutation)", () => {
    const { privateKey, pubX } = makeIssuer();
    const token = encodeToken(makePayload({ issuerPub: pubX, netId: "n-orig" }), privateKey);
    // Decode, mutate netId in the wire payload, re-encode (without re-signing).
    const json = Buffer.from(token, "base64url").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    obj.netId = "n-evil";
    const tampered = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    expect(() => decodeAndVerify(tampered)).toThrow(/signature/);
  });

  it("rejects a token signed by the wrong key", () => {
    const issuer = makeIssuer();
    const attacker = makeIssuer();
    // Use attacker's signing key, but advertise issuer's pubkey → mismatch.
    const payload = makePayload({ issuerPub: issuer.pubX });
    const token = encodeToken(payload, attacker.privateKey);
    expect(() => decodeAndVerify(token)).toThrow(/signature/);
  });

  it("assertNotExpired throws past expiry", () => {
    const { privateKey, pubX } = makeIssuer();
    const expired = encodeToken(
      makePayload({ issuerPub: pubX, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      privateKey,
    );
    const decoded = decodeAndVerify(expired);
    expect(() => assertNotExpired(decoded)).toThrow(/expired/);
  });

  it("oneTimePrivKey reconstructs a usable signing key", () => {
    const { privateKey, pubX } = makeIssuer();
    const token = decodeAndVerify(encodeToken(makePayload({ issuerPub: pubX }), privateKey));
    const k = oneTimePrivKey(token);
    expect(k.type).toBe("private");
  });

  it("rejects malformed base64 / JSON", () => {
    expect(() => decodeAndVerify("!!!not-base64url!!!")).toThrow();
    expect(() => decodeAndVerify(Buffer.from("not json", "utf8").toString("base64url"))).toThrow(/JSON/);
  });
});
