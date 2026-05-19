import { describe, expect, it } from "vitest";
import { matches } from "../../src/bus/match.js";

describe("pattern matcher", () => {
  const beta = { node: "n1", session: "beta", roles: new Set(["agent-beta"]) };
  const alpha = { node: "n1", session: "alpha", roles: new Set(["agent-alpha"]) };

  it("matches an exact node/session pair", () => {
    expect(matches("n1/beta", beta)).toBe(true);
    expect(matches("n1/alpha", beta)).toBe(false);
  });

  it("matches a node wildcard", () => {
    expect(matches("*/beta", beta)).toBe(true);
    expect(matches("*/beta", alpha)).toBe(false);
  });

  it("matches a session wildcard", () => {
    expect(matches("n1/*", beta)).toBe(true);
    expect(matches("n2/*", beta)).toBe(false);
  });

  it("matches a role pattern", () => {
    expect(matches("*/role:agent-beta", beta)).toBe(true);
    expect(matches("*/role:agent-beta", alpha)).toBe(false);
  });

  it("rejects patterns without a slash", () => {
    expect(matches("beta", beta)).toBe(false);
  });
});
