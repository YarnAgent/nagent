import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/index.js";
import { BusClient } from "../../src/bus/client.js";
import { writeIdentity } from "../../src/store/index.js";

describe("bus end-to-end (single daemon, two clients)", () => {
  let dir: string;
  let daemon: Daemon;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nagent-int-"));
    process.env.NAGENT_HOME = dir;
    await writeIdentity({
      nodeId: "deadbeef",
      nodeName: "test-node",
      ed25519Pub: "x",
      createdAt: new Date().toISOString(),
    });
    daemon = new Daemon({ foreground: false, log: () => {} });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
    delete process.env.NAGENT_HOME;
  });

  async function helloSession(client: BusClient, session: string) {
    const r = await client.request({ verb: "HELLO", node: "test-node", session, asCli: false });
    expect(r.verb).toBe("OK");
  }
  async function helloCli(client: BusClient) {
    const r = await client.request({ verb: "HELLO", node: "test-node", asCli: true });
    expect(r.verb).toBe("OK");
  }

  it("creates a session, registers a role, and delivers a SEND by role wildcard", async () => {
    // CLI-1: creates the receiver session "beta" and tags it.
    const setup = new BusClient();
    await setup.connect();
    await helloCli(setup);
    const created = await setup.request({ verb: "CREATE_SESSION", name: "beta" });
    expect(created.verb).toBe("SESSION_CREATED");
    const tag = await setup.request({ verb: "REGISTER_ROLE", session: "beta", role: "agent-beta" });
    expect(tag.verb).toBe("OK");
    setup.close();

    // Receiver: connect as session beta and wait for one frame.
    const receiver = new BusClient();
    await receiver.connect();
    await helloSession(receiver, "beta");

    const got = new Promise<unknown>((resolve) => {
      receiver.on("frame", (f) => {
        if (f.verb === "RECV") resolve(f);
      });
    });

    // Sender: connect as "alpha" (no need to create — sender doesn't need to be a tracked session).
    const sender = new BusClient();
    await sender.connect();
    await helloSession(sender, "alpha");
    const ack = await sender.request({
      verb: "SEND",
      to: "*/role:agent-beta",
      payload: { ping: 1 },
      msgId: "m-1",
      hops: 0,
    });
    expect(ack.verb).toBe("ACK");

    const frame = (await got) as { from: string; payload: { ping: number }; msgId: string };
    expect(frame.payload).toEqual({ ping: 1 });
    expect(frame.from).toBe("test-node/alpha");
    expect(frame.msgId).toBe("m-1");

    sender.close();
    receiver.close();
  });

  it("drops SEND to an address with no live subscriber but still ACKs", async () => {
    const sender = new BusClient();
    await sender.connect();
    await helloCli(sender);
    const ack = await sender.request({
      verb: "SEND",
      to: "test-node/ghost",
      payload: null,
      msgId: "m-2",
      hops: 0,
    });
    expect(ack.verb).toBe("ACK");
    sender.close();
  });
});
