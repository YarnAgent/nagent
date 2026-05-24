// v0.5.1 ssh-jump transport: schema + transportSshArgs branching + end-to-end
// resolveSshTransportArgs lookup. No actual ssh process is spawned here —
// the probe path is exercised manually in a separate smoke test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/platform/paths.js";
import {
  readPinnedRelays,
  readPinnedTlsRelays,
  findPinnedRelay,
  type PinnedRelayRecord,
} from "../../src/relay/pinned.js";
import {
  chooseTransport,
  transportSshArgs,
  type PathTable,
} from "../../src/routing/index.js";
import { resolveSshTransportArgs } from "../../src/routing/ssh-args.js";

async function setupPinnedFile(rec: Record<string, unknown>): Promise<void> {
  await writeFile(paths().pinnedRelays, JSON.stringify({ v: 1, relays: rec }, null, 2), { mode: 0o600 });
}

async function setupActiveNet(netId: string, peers: unknown[] = []): Promise<void> {
  await mkdir(paths().netDir(netId), { recursive: true });
  await writeFile(paths().activeState, JSON.stringify({ activeNetId: netId }), { mode: 0o600 });
  await writeFile(paths().netPeers(netId), JSON.stringify(peers), { mode: 0o600 });
}

async function setupPathTable(netId: string, table: Partial<PathTable>): Promise<void> {
  await writeFile(paths().pathTable(netId), JSON.stringify({
    v: 1,
    node: "self",
    updatedAt: new Date().toISOString(),
    direct: {},
    relays: {},
    ...table,
  }), { mode: 0o600 });
}

describe("pinned-relay schema — discriminated union with backward compat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-pinned-"));
    process.env.NAGENT_HOME = dir;
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("legacy records (no transport field) default to tls", async () => {
    await setupPinnedFile({
      "legacy-relay": { url: "https://h:8443", fingerprint: "FP", pinnedAt: "2026-01-01T00:00:00Z" },
    });
    const all = await readPinnedRelays();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ transport: "tls", name: "legacy-relay", url: "https://h:8443" });
  });

  it("modern records keep their transport field", async () => {
    await setupPinnedFile({
      "tls-r": { transport: "tls", url: "https://h:8443", fingerprint: "FP", pinnedAt: "2026-01-01T00:00:00Z" },
      "ssh-r": { transport: "ssh-jump", sshTarget: "ubuntu@1.2.3.4", pinnedAt: "2026-01-01T00:00:00Z" },
    });
    const all = await readPinnedRelays();
    const byName = Object.fromEntries(all.map((r) => [r.name, r]));
    expect(byName["tls-r"]?.transport).toBe("tls");
    expect(byName["ssh-r"]?.transport).toBe("ssh-jump");
    expect(byName["ssh-r"]).toMatchObject({ sshTarget: "ubuntu@1.2.3.4" });
  });

  it("readPinnedTlsRelays filters out ssh-jump records", async () => {
    await setupPinnedFile({
      "tls-r": { transport: "tls", url: "https://h:8443", fingerprint: "FP", pinnedAt: "x" },
      "ssh-r": { transport: "ssh-jump", sshTarget: "u@h", pinnedAt: "x" },
    });
    const tlsOnly = await readPinnedTlsRelays();
    expect(tlsOnly).toHaveLength(1);
    expect(tlsOnly[0]?.name).toBe("tls-r");
  });

  it("findPinnedRelay returns the typed union variant", async () => {
    await setupPinnedFile({
      "jumper": { transport: "ssh-jump", sshTarget: "ubuntu@10.0.0.5:2222", pinnedAt: "x" },
    });
    const rec = await findPinnedRelay("jumper");
    expect(rec?.transport).toBe("ssh-jump");
    if (rec?.transport === "ssh-jump") {
      expect(rec.sshTarget).toBe("ubuntu@10.0.0.5:2222");
    }
    expect(await findPinnedRelay("ghost")).toBeNull();
  });

  it("malformed records (missing required field for their transport) are skipped", async () => {
    await setupPinnedFile({
      "bad-tls": { transport: "tls", url: "https://h" /* no fingerprint */, pinnedAt: "x" },
      "bad-ssh": { transport: "ssh-jump" /* no sshTarget */, pinnedAt: "x" },
      "good": { transport: "ssh-jump", sshTarget: "u@h", pinnedAt: "x" },
    });
    const all = await readPinnedRelays();
    expect(all.map((r) => r.name)).toEqual(["good"]);
  });
});

describe("transportSshArgs — branches on pinnedKind", () => {
  it("direct returns []", () => {
    expect(transportSshArgs({ type: "direct" }, "alice")).toEqual([]);
  });

  it("via + tls renders the ProxyCommand", () => {
    const args = transportSshArgs(
      { type: "via", relay: "tls-r" },
      "alice",
      { pinnedKind: "tls" },
    );
    expect(args).toEqual([
      "-o",
      "ProxyCommand=nagent relay-dial 'alice' --relay 'tls-r'",
    ]);
  });

  it("via + ssh-jump renders ProxyCommand-with-identity to the jump host", () => {
    const args = transportSshArgs(
      { type: "via", relay: "tencent-cn" },
      "alice",
      { pinnedKind: "ssh-jump", sshJumpTarget: "ubuntu@101.43.123.138" },
    );
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/^ProxyCommand=ssh /);
    expect(args[1]).toMatch(/ -W %h:%p ubuntu@101\.43\.123\.138$/);
  });

  it("via + ssh-jump with jumpIdentityFile embeds -i <path> in ProxyCommand", () => {
    const args = transportSshArgs(
      { type: "via", relay: "tencent-cn" },
      "alice",
      {
        pinnedKind: "ssh-jump",
        sshJumpTarget: "ubuntu@101.43.123.138",
        jumpIdentityFile: "/etc/nagent/id_ed25519",
      },
    );
    expect(args[1]).toContain("-i '/etc/nagent/id_ed25519'");
    expect(args[1]).toContain("-o IdentitiesOnly=yes");
  });

  it("via + ssh-jump with targetHostOverride adds -o HostName=…", () => {
    const args = transportSshArgs(
      { type: "via", relay: "tencent-cn" },
      "alice",
      {
        pinnedKind: "ssh-jump",
        sshJumpTarget: "ubuntu@h",
        targetHostOverride: "alice.tail0a1b2c.ts.net",
      },
    );
    expect(args).toEqual([
      "-o", expect.stringMatching(/^ProxyCommand=ssh /),
      "-o", "HostName=alice.tail0a1b2c.ts.net",
    ]);
  });

  it("via without extras defaults to tls (ProxyCommand)", () => {
    // Back-compat: spawn sites that call without extras get tls behavior.
    const args = transportSshArgs({ type: "via", relay: "r1" }, "alice");
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/ProxyCommand=/);
  });

  it("via + ssh-jump without sshJumpTarget throws (programmer error)", () => {
    expect(() =>
      transportSshArgs(
        { type: "via", relay: "r1" },
        "alice",
        { pinnedKind: "ssh-jump" },
      ),
    ).toThrow(/sshJumpTarget/);
  });
});

describe("resolveSshTransportArgs — end-to-end with pinned lookup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-resolve-"));
    process.env.NAGENT_HOME = dir;
  });

  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns ProxyCommand-with-identity to jump host when path-table picks an ssh-jump relay", async () => {
    await setupActiveNet("net-a");
    await setupPinnedFile({
      "tencent-cn": { transport: "ssh-jump", sshTarget: "ubuntu@1.2.3.4", pinnedAt: "x" },
    });
    await setupPathTable("net-a", {
      direct: { alice: { ms: 500, lastOk: "x" } }, // direct slow
      relays: { "tencent-cn": { myRttMs: 20, lastSeen: "x", peers: { alice: { ms: 30, lastSeen: "x" } } } },
    });
    const args = await resolveSshTransportArgs("alice");
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/^ProxyCommand=ssh -i .* -W %h:%p ubuntu@1\.2\.3\.4$/);
  });

  it("returns ProxyCommand when the chosen relay is TLS-transport", async () => {
    await setupActiveNet("net-b");
    await setupPinnedFile({
      "edge-eu": { transport: "tls", url: "https://h:8443", fingerprint: "FP", pinnedAt: "x" },
    });
    await setupPathTable("net-b", {
      direct: { alice: { ms: 500, lastOk: "x" } },
      relays: { "edge-eu": { myRttMs: 20, lastSeen: "x", peers: { alice: { ms: 30, lastSeen: "x" } } } },
    });
    const args = await resolveSshTransportArgs("alice");
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/ProxyCommand=nagent relay-dial 'alice' --relay 'edge-eu'/);
  });

  it("returns [] when direct is best", async () => {
    await setupActiveNet("net-c");
    await setupPinnedFile({
      "edge-eu": { transport: "tls", url: "https://h:8443", fingerprint: "FP", pinnedAt: "x" },
    });
    await setupPathTable("net-c", {
      direct: { alice: { ms: 5, lastOk: "x" } },
      relays: { "edge-eu": { myRttMs: 200, lastSeen: "x", peers: { alice: { ms: 200, lastSeen: "x" } } } },
    });
    expect(await resolveSshTransportArgs("alice")).toEqual([]);
  });

  it("forced --via ssh-jump relay yields ProxyCommand even without path-table data", async () => {
    await setupActiveNet("net-d");
    await setupPinnedFile({
      "tencent-cn": { transport: "ssh-jump", sshTarget: "ubuntu@1.2.3.4", pinnedAt: "x" },
    });
    await setupPathTable("net-d", { direct: {}, relays: {} });
    const args = await resolveSshTransportArgs("alice", { via: "tencent-cn" });
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/ -W %h:%p ubuntu@1\.2\.3\.4$/);
  });

  it("forced --via unknown-relay falls through to ProxyCommand (fail-loud at ssh time)", async () => {
    // If the user types an unknown relay name, we still synthesize the
    // ProxyCommand variant — the user gets a clear error when ssh tries to
    // spawn `nagent relay-dial` and discovers there's no pinned relay.
    await setupActiveNet("net-e");
    await setupPinnedFile({});
    const args = await resolveSshTransportArgs("alice", { via: "ghost" });
    expect(args[0]).toBe("-o");
    expect(args[1]).toMatch(/ProxyCommand=nagent relay-dial 'alice' --relay 'ghost'/);
  });
});
