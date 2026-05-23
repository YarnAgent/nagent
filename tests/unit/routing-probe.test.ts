import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { paths } from "../../src/platform/paths.js";
import { probeDirect, runProbeRound, readPathTable } from "../../src/routing/probe.js";

describe("probeDirect — TCP connect timing", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns a positive number on a successful connect", async () => {
    const ms = await probeDirect("127.0.0.1", port);
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(1000);
  });

  it("returns null on connection refused (closed port)", async () => {
    // Pick a likely-free port by closing the server first.
    const localPort = port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ms = await probeDirect("127.0.0.1", localPort, 500);
    expect(ms).toBeNull();
    // Restart so afterEach can close it without erroring.
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  // Note: we deliberately don't test the timeout path against an "unroutable"
  // IP. On developer machines with Tailscale / corporate VPNs, reserved
  // ranges (TEST-NET, .invalid) often *do* get routed somewhere, producing
  // either a quick ECONNREFUSED or a real successful connect. The
  // ECONNREFUSED case is already covered above; the wall-clock timeout
  // mechanism is straightforward enough to trust without a brittle network
  // test.
});

describe("runProbeRound — writes path-table.json with direct probes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-routing-probe-"));
    process.env.NAGENT_HOME = dir;
    await mkdir(paths().netDir("net-test"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("TCP-fast-fail correctly marks unreachable peers as null", async () => {
    // v0.5.2: direct probes now do TCP-fast-fail then real SSH handshake.
    // We can't easily fake a working sshd in a unit test, but we can
    // verify the TCP fast-fail short-circuits cleanly for closed ports
    // (ghost) and that all non-self peers end up in the table.
    const aliceSrv = createServer();
    await new Promise<void>((r) => aliceSrv.listen(0, "127.0.0.1", r));
    const alicePort = (aliceSrv.address() as { port: number }).port;

    await writeFile(paths().netPeers("net-test"), JSON.stringify([
      { nodeName: "self",  pubKey: "self-pub",  addresses: [`127.0.0.1:9`],          roles: [] }, // self — skipped
      { nodeName: "alice", pubKey: "alice-pub", addresses: [`127.0.0.1:${alicePort}`], roles: [] },
      { nodeName: "ghost", pubKey: "ghost-pub", addresses: [`127.0.0.1:1`],            roles: [] }, // closed
    ]));

    const table = await runProbeRound({
      netId: "net-test",
      selfNodeName: "self",
      tcpProbeTimeoutMs: 500,
      sshProbeTimeoutMs: 1000, // short — we expect SSH to fail anyway
    });

    expect(table.node).toBe("self");
    expect(table.direct.self).toBeUndefined();
    // alice: TCP succeeds → SSH probe runs (fails in test env, no real sshd) → null with lastFailedAt
    // ghost: TCP fast-fails → null with lastFailedAt
    expect(table.direct.alice).toBeDefined();
    expect(table.direct.alice?.ms).toBeNull();
    expect(table.direct.alice?.lastFailedAt).toBeDefined();
    expect(table.direct.ghost).toBeDefined();
    expect(table.direct.ghost?.ms).toBeNull();
    expect(table.direct.ghost?.lastFailedAt).toBeDefined();
    expect(Object.keys(table.relays)).toEqual([]);

    // Round-trip: readPathTable returns what we wrote.
    const persisted = await readPathTable("net-test");
    expect(persisted.direct.alice?.ms).toBe(table.direct.alice?.ms);

    await new Promise<void>((r) => aliceSrv.close(() => r()));
  });

  it("returns an empty table when peers.json has only self", async () => {
    await writeFile(paths().netPeers("net-test"), JSON.stringify([
      { nodeName: "self", pubKey: "pk", addresses: ["127.0.0.1:9"], roles: [] },
    ]));
    const table = await runProbeRound({ netId: "net-test", selfNodeName: "self" });
    expect(Object.keys(table.direct)).toEqual([]);
  });
});
