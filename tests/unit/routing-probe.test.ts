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

  it("probes every non-self peer and persists the result", async () => {
    // Spin up two reachable mini-servers as "alice" and "bob"; the third
    // peer "ghost" points at a closed port.
    const aliceSrv = createServer();
    const bobSrv = createServer();
    await new Promise<void>((r) => aliceSrv.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => bobSrv.listen(0, "127.0.0.1", r));
    const alicePort = (aliceSrv.address() as { port: number }).port;
    const bobPort = (bobSrv.address() as { port: number }).port;

    await writeFile(paths().netPeers("net-test"), JSON.stringify([
      { nodeName: "self",  pubKey: "self-pub",  addresses: [`127.0.0.1:9`],          roles: [] }, // self — skipped
      { nodeName: "alice", pubKey: "alice-pub", addresses: [`127.0.0.1:${alicePort}`], roles: [] },
      { nodeName: "bob",   pubKey: "bob-pub",   addresses: [`127.0.0.1:${bobPort}`],   roles: [] },
      { nodeName: "ghost", pubKey: "ghost-pub", addresses: [`127.0.0.1:1`],            roles: [] }, // closed
    ]));

    const table = await runProbeRound({
      netId: "net-test",
      selfNodeName: "self",
      directTimeoutMs: 500,
    });

    expect(table.node).toBe("self");
    expect(table.direct.alice?.ms).toBeGreaterThanOrEqual(0);
    expect(table.direct.bob?.ms).toBeGreaterThanOrEqual(0);
    expect(table.direct.ghost?.ms).toBeNull();
    expect(table.direct.self).toBeUndefined();
    expect(Object.keys(table.relays)).toEqual([]);

    // Round-trip: readPathTable returns what we wrote.
    const persisted = await readPathTable("net-test");
    expect(persisted.direct.alice?.ms).toBe(table.direct.alice?.ms);

    await Promise.all([
      new Promise<void>((r) => aliceSrv.close(() => r())),
      new Promise<void>((r) => bobSrv.close(() => r())),
    ]);
  });

  it("returns an empty table when peers.json has only self", async () => {
    await writeFile(paths().netPeers("net-test"), JSON.stringify([
      { nodeName: "self", pubKey: "pk", addresses: ["127.0.0.1:9"], roles: [] },
    ]));
    const table = await runProbeRound({ netId: "net-test", selfNodeName: "self" });
    expect(Object.keys(table.direct)).toEqual([]);
  });
});
