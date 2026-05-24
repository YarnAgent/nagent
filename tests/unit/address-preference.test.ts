import { describe, expect, it } from "vitest";
import { preferAddress } from "../../src/ssh/addresses.js";

describe("preferAddress", () => {
  it("returns undefined for empty array", () => {
    expect(preferAddress([])).toBeUndefined();
  });

  it("returns the only address for single-element array", () => {
    expect(preferAddress(["192.168.1.5:22"])).toBe("192.168.1.5:22");
  });

  it("prefers Tailscale CGNAT (100.64–127.x) over LAN addresses", () => {
    expect(preferAddress(["172.17.0.1:22", "100.85.141.122:22"])).toBe("100.85.141.122:22");
  });

  it("prefers Tailscale CGNAT over public IPs", () => {
    expect(preferAddress(["203.0.113.5:22", "100.96.72.35:22"])).toBe("100.96.72.35:22");
  });

  it("prefers RFC1918 over public when no Tailscale address exists", () => {
    expect(preferAddress(["203.0.113.5:22", "192.168.1.10:22"])).toBe("192.168.1.10:22");
  });

  it("works with addresses without port suffix", () => {
    expect(preferAddress(["172.17.0.1", "100.100.1.1"])).toBe("100.100.1.1");
  });

  it("treats 100.63.x as non-CGNAT (below the 100.64/10 range)", () => {
    expect(preferAddress(["100.63.0.1:22", "10.0.0.5:22"])).toBe("10.0.0.5:22");
  });

  it("treats 100.128.x as non-CGNAT (above the range)", () => {
    expect(preferAddress(["100.128.0.1:22", "10.0.0.5:22"])).toBe("10.0.0.5:22");
  });

  it("handles docker-bridge 172.17 as RFC1918 (lower than Tailscale)", () => {
    expect(preferAddress(["172.17.0.1:22", "100.64.0.1:22"])).toBe("100.64.0.1:22");
  });

  it("picks first among equal-scored candidates", () => {
    expect(preferAddress(["10.0.0.1:22", "192.168.1.1:22"])).toBe("10.0.0.1:22");
  });
});
