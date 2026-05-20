import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuthorizedKey,
  hasAuthorizedKeyTag,
  removeAuthorizedKey,
} from "../../src/ssh/authorized_keys.js";
import {
  writeHostEntry,
  removeHostEntry,
  listHostEntries,
  nagentSshConfigPath,
} from "../../src/ssh/ssh_config.js";

describe("authorized_keys fenced editor", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-ak-"));
    path = join(dir, "authorized_keys");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates the fenced block and appends a tagged line on a fresh file", async () => {
    await appendAuthorizedKey({ path, tag: "peer-bob", line: "ssh-ed25519 AAAA bob@host" });
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("# >>> nagent managed (do not edit) >>>");
    expect(raw).toContain("ssh-ed25519 AAAA bob@host  # nagent-tag=peer-bob");
    expect(raw).toContain("# <<< nagent managed <<<");
  });

  it("preserves the user's lines outside the fenced block", async () => {
    await writeFile(path, "ssh-rsa AAAAB user@laptop\n", { mode: 0o600 });
    await appendAuthorizedKey({ path, tag: "peer-bob", line: "ssh-ed25519 AAAA bob@host" });
    const raw = await readFile(path, "utf8");
    expect(raw).toMatch(/^ssh-rsa AAAAB user@laptop\n/);
    expect(raw).toContain("nagent-tag=peer-bob");
  });

  it("replaces (idempotent) when appending with an existing tag", async () => {
    await appendAuthorizedKey({ path, tag: "peer-bob", line: "ssh-ed25519 OLD bob@host" });
    await appendAuthorizedKey({ path, tag: "peer-bob", line: "ssh-ed25519 NEW bob@host" });
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("OLD");
    expect(raw).toContain("NEW");
    // exactly one matching line
    expect(raw.match(/nagent-tag=peer-bob/g)?.length).toBe(1);
  });

  it("removes by tag", async () => {
    await appendAuthorizedKey({ path, tag: "peer-bob", line: "ssh-ed25519 X bob@host" });
    expect(await hasAuthorizedKeyTag("peer-bob", path)).toBe(true);
    await removeAuthorizedKey({ path, tag: "peer-bob" });
    expect(await hasAuthorizedKeyTag("peer-bob", path)).toBe(false);
  });
});

describe("ssh_config writer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-sc-"));
    process.env.NAGENT_HOME = dir;
  });
  afterEach(async () => {
    delete process.env.NAGENT_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a Host nagent.<peer> block with safe defaults", async () => {
    await writeHostEntry({
      peerName: "alice",
      host: "10.0.0.1",
      port: 22,
      user: "alice",
      identityFile: "/tmp/key",
    });
    const raw = await readFile(nagentSshConfigPath(), "utf8");
    expect(raw).toContain("Host nagent.alice");
    expect(raw).toContain("HostName 10.0.0.1");
    expect(raw).toContain("User alice");
    expect(raw).toContain("IdentityFile /tmp/key");
    expect(raw).toContain("ForwardAgent no");
    expect(raw).toContain("StrictHostKeyChecking accept-new");
  });

  it("does NOT include 'ForwardAgent yes' (security assertion)", async () => {
    await writeHostEntry({ peerName: "alice", host: "10.0.0.1", user: "alice" });
    const raw = await readFile(nagentSshConfigPath(), "utf8");
    expect(raw).not.toMatch(/ForwardAgent\s+yes/i);
  });

  it("is idempotent — second write replaces the block, not duplicates it", async () => {
    await writeHostEntry({ peerName: "alice", host: "10.0.0.1", user: "alice" });
    await writeHostEntry({ peerName: "alice", host: "10.0.0.2", user: "alice" });
    const entries = await listHostEntries();
    expect(entries).toEqual(["alice"]);
    const raw = await readFile(nagentSshConfigPath(), "utf8");
    expect(raw).toContain("HostName 10.0.0.2");
    expect(raw).not.toContain("HostName 10.0.0.1");
  });

  it("can remove a host entry", async () => {
    await writeHostEntry({ peerName: "alice", host: "10.0.0.1", user: "alice" });
    await writeHostEntry({ peerName: "bob", host: "10.0.0.2", user: "bob" });
    await removeHostEntry("alice");
    const entries = await listHostEntries();
    expect(entries).toEqual(["bob"]);
  });
});
