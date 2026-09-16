/**
 * Subscriptions: many clients, many subscriptions per client, and what a client
 * that stops reading is owed.
 *
 * The last two cases are the ones worth reading twice. **The bound is asserted
 * against the queue itself**, driven by a writer that reports backpressure on
 * command — because the number of events a *socket* absorbs before it pushes
 * back is a property of the kernel's Unix-socket buffer, not of this host, and a
 * case that asserted "no more than 64 arrived" over a real socket would be
 * asserting how many bytes Darwin happens to buffer. The socket case then proves
 * the same collapse end to end, with the assertions that are true whatever the
 * kernel buffers: the client is told **once**, it is told where the host is
 * **now**, and it is never handed a partial change set dressed up as a whole one.
 */

import { describe, expect, it } from "vitest";

import { ClientSubscriptions } from "../src/server/subscriptions";
import { HostHarness } from "../src/testing/host-harness";

/**
 * Read until `count` events have arrived, or the client goes quiet for good.
 *
 * Not a sleep: each turn drains what the socket has and asks again, so a host
 * that delivers everything finishes in as many turns as it needs and one that
 * stops delivering fails by the runner's own timeout.
 */
async function drainUntil(
  client: { drainEvents(): Promise<ReadonlyArray<{ type: string; value: unknown }>> },
  count: number,
): Promise<ReadonlyArray<{ type: string; value: unknown }>> {
  let events = await client.drainEvents();
  for (let turn = 0; turn < 5_000 && events.length < count; turn += 1) {
    events = await client.drainEvents();
  }
  return events;
}

describe("host subscriptions", () => {
  it("delivers one generation_committed to each of two connected clients", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      await harness.server.listen();
      const first = await harness.connectClient();
      const second = await harness.connectClient();
      const firstSub = await first.call<{ subscription_id: string; generation: number }>(
        "host.subscribe",
        {},
      );
      const secondSub = await second.call<{ subscription_id: string }>("host.subscribe", {});
      expect(firstSub.subscription_id).not.toBe(secondSub.subscription_id);
      expect(firstSub.generation).toBe(harness.mirror.generation());
      expect(harness.server.clientCount()).toBe(2);

      const firstEvent = first.nextEvent("generation_committed");
      const secondEvent = second.nextEvent("generation_committed");
      await harness.commitGeneration({ modified: ["A.md"] });

      for (const event of await Promise.all([firstEvent, secondEvent])) {
        expect(event).toMatchObject({
          generation: harness.mirror.generation(),
          changes: { kind: "detailed", modified: ["A.md"] },
        });
      }
      await first.disconnect();
      await second.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("gives one client two subscription ids and two deliveries", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      await harness.server.listen();
      const client = await harness.connectClient();
      const a = await client.call<{ subscription_id: string }>("host.subscribe", {});
      const b = await client.call<{ subscription_id: string }>("host.subscribe", {});
      expect(a.subscription_id).not.toBe(b.subscription_id);

      const delivered: string[] = [];
      client.onEvent((envelope) => {
        if (envelope.event.type === "generation_committed") delivered.push(envelope.subscription_id);
      });
      await harness.commitGeneration({ modified: ["A.md"] });
      await client.quiesce();
      expect(delivered.sort()).toEqual([a.subscription_id, b.subscription_id].sort());
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("drops a disconnected client's subscription without disturbing the other", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      await harness.server.listen();
      const leaving = await harness.connectClient();
      const staying = await harness.connectClient();
      await leaving.call("host.subscribe", {});
      await staying.call("host.subscribe", {});
      await leaving.disconnect();
      await harness.serverQuiesce();
      expect(harness.server.clientCount()).toBe(1);

      const event = staying.nextEvent("generation_committed");
      // Must not throw on the write to the dead socket, and must still deliver.
      await expect(harness.commitGeneration({ modified: ["A.md"] })).resolves.toBeUndefined();
      await expect(event).resolves.toMatchObject({ generation: harness.mirror.generation() });
      await staying.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("drops a disconnected client's open snapshots", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const leaving = await harness.connectClient();
      await leaving.call("host.open_snapshot", {});
      await leaving.call("host.open_snapshot", {});
      const before = await harness.connectClient();
      await expect(before.call("host.info", {})).resolves.toMatchObject({
        counters: { snapshot_sessions: 2 },
      });
      await leaving.disconnect();
      await harness.serverQuiesce();
      await expect(before.call("host.info", {})).resolves.toMatchObject({
        counters: { snapshot_sessions: 0 },
      });
    } finally {
      await harness.stop();
    }
  });

  it("collapses a lagging subscriber to one resync_required and no partial detail", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      config: { subscriberQueueLimit: 64 },
    });
    try {
      await harness.lifecycle.start();
      await harness.server.listen();
      // Subscribe **first**, then stall: a socket paused before its own hello
      // could never read the answer to it. See `HostTestClient.stall`.
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      client.stall();

      // **Fill the socket's own buffers first, however many events that takes.**
      // How much a kernel holds for a Unix socket before it pushes back is the
      // kernel's business — tens of kilobytes on Darwin, hundreds on Linux — so
      // a fixed count would be a test about the platform. Commit until the host
      // reports a subscriber that is genuinely behind, and only then overflow
      // the queue by a known amount.
      // Each commit supplies the note's new source rather than letting the
      // harness append a line to it: a note that grows by two lines per commit
      // is re-parsed and re-served on every one of the thousands below, and the
      // quadratic that produces is the test measuring the fixture rather than
      // the host.
      const edit = (n: number): Promise<void> =>
        harness.commitGeneration({ modified: ["A.md"], sources: { "A.md": `# A\n${String(n)}\n` } });
      let commits = 0;
      while (harness.server.pendingEvents() === 0 && commits < 20_000) {
        commits += 1;
        await edit(commits);
      }
      expect(harness.server.pendingEvents()).toBeGreaterThan(0);
      for (let i = 0; i < 64 + 5; i += 1) await edit(commits + i + 1);

      // **Wait for the collapse itself, not for a quiet turn of the loop.** One
      // writer owns this socket, so everything the client is still owed is
      // ordered ahead of the `resync_required`: once that line has arrived,
      // every line before it has too, and nothing follows it. Draining on a
      // timer instead would read whatever happened to have crossed by then.
      const collapse = client.nextEvent("resync_required");
      client.resume();
      await expect(collapse).resolves.toMatchObject({
        reason: "subscriber_lag",
        current_generation: harness.mirror.generation(),
      });
      const events = await client.drainEvents();

      const resyncs = events.filter((event) => event.type === "resync_required");
      expect(resyncs).toHaveLength(1);
      expect(resyncs[0]).toMatchObject({
        value: { reason: "subscriber_lag", current_generation: harness.mirror.generation() },
      });
      // Events really were dropped rather than buffered without bound, and the
      // collapse is the last thing the client hears: nothing older than the
      // generation it names arrives after it.
      const committed = events.filter((event) => event.type === "generation_committed");
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.length).toBeLessThan(commits + 69);
      expect(events[events.length - 1]?.type).toBe("resync_required");
      // Never a truncated change set pretending to be whole.
      for (const event of committed) {
        expect((event.value as { changes: { kind: string } }).changes.kind).toBe("detailed");
      }
      // And the host is still answering this client: a collapse is a message,
      // not a broken connection.
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it("bounds the queue at the configured limit, whatever the socket buffers", () => {
    const written: string[] = [];
    let backedUp = false;
    let drain: (() => void) | null = null;
    const subscriptions = new ClientSubscriptions({
      limit: 4,
      currentGeneration: () => 99,
      mintId: () => "s-1",
      writer: {
        write: (line) => {
          written.push(line);
          return !backedUp;
        },
        onceDrain: (listener) => {
          drain = listener;
        },
      },
    });
    subscriptions.open();

    // Flowing: every event is written straight through.
    subscriptions.deliver({ type: "generation_committed", value: { generation: 1 } });
    expect(written).toHaveLength(1);

    // Backed up: one more line is accepted (the writer answers about the stream,
    // not about the line), and everything after it queues.
    backedUp = true;
    for (let i = 2; i <= 12; i += 1) {
      subscriptions.deliver({ type: "generation_committed", value: { generation: i } });
    }
    expect(written).toHaveLength(2);
    // Four queued, then the cap: the queue is dropped whole and one collapse is
    // owed. Never five, and never a prefix of the truth kept alongside it.
    expect(subscriptions.pending()).toBe(1);

    backedUp = false;
    expect(drain).not.toBeNull();
    (drain as unknown as () => void)();
    expect(written).toHaveLength(3);
    const last = JSON.parse(written[2] as string) as {
      subscription_id: string;
      event: { type: string; value: { reason: string; current_generation: number } };
    };
    expect(last.subscription_id).toBe("s-1");
    expect(last.event).toEqual({
      type: "resync_required",
      value: { reason: "subscriber_lag", current_generation: 99 },
    });
    expect(subscriptions.pending()).toBe(0);
  });

  it("holds a daemon generation_committed until the mirror has caught up, then relays it unchanged", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const seen: unknown[] = [];
      client.onEvent((envelope) => {
        if (envelope.event.type === "generation_committed") seen.push(envelope.event.value);
      });

      const generation = harness.mirror.generation() + 1;
      // The daemon's own payload, with the two fields a host cannot honestly
      // produce: `affected_reference_count`, which the mirror's batch does not
      // carry, and a `cause` that is the daemon's account of its own commit.
      const committed = {
        previous_generation: harness.mirror.generation(),
        generation,
        cause: "watcher" as const,
        changes: { kind: "detailed" as const, created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 9,
      };
      harness.server.relayDaemonEvent({ type: "generation_committed", value: committed });
      await harness.serverQuiesce();
      // Held: this host's mirror is still a generation behind, and a client that
      // heard about generation N would page `host.open_snapshot` for a view that
      // does not hold it.
      expect(seen).toEqual([]);

      await harness.commitGeneration({ generation, modified: ["A.md"], announce: false });
      await harness.serverQuiesce();
      // Released the moment the mirror caught up, and byte for byte what the
      // daemon sent — nothing recomputed, nothing dropped, nothing invented.
      expect(seen).toEqual([committed]);
      expect(harness.mirror.appliedThrough()).toBeGreaterThanOrEqual(generation);
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("does not lag a reading client with a burst larger than the queue", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      config: { subscriberQueueLimit: 64 },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      // A thousand events in one synchronous loop, at a queue limit of 64. A
      // client reading as fast as it can still cannot drain a socket inside the
      // turn that filled it, so a host that delivered the whole burst without
      // yielding collapsed a perfectly healthy reader into a `subscriber_lag`.
      // Measured before the fix: 74 delivered and one collapse.
      for (let i = 0; i < 1_000; i += 1) {
        harness.server.broadcast({
          type: "host.notice",
          value: { plugin_id: null, message: `notice ${String(i)}`, at_unix_ms: i },
        });
      }
      const events = await drainUntil(client, 1_000);
      expect(events.filter((event) => event.type === "host.notice")).toHaveLength(1_000);
      expect(events.filter((event) => event.type === "resync_required")).toHaveLength(0);
      // In order, which is what the outbox is for.
      expect((events[0]?.value as { message: string }).message).toBe("notice 0");
      expect((events[999]?.value as { message: string }).message).toBe("notice 999");
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it("stops delivering after unsubscribe", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      await harness.server.listen();
      const client = await harness.connectClient();
      const sub = await client.call<{ subscription_id: string }>("host.subscribe", {});
      const seen: string[] = [];
      client.onEvent((envelope) => seen.push(envelope.event.type));
      await expect(
        client.call("host.unsubscribe", { subscription_id: sub.subscription_id }),
      ).resolves.toEqual({ subscription_id: sub.subscription_id });
      seen.length = 0;
      await harness.commitGeneration({ modified: ["A.md"] });
      await client.quiesce();
      expect(seen).toEqual([]);
      await expect(
        client.call("host.unsubscribe", { subscription_id: "gone" }),
      ).rejects.toMatchObject({ code: "subscription_not_found" });
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("broadcasts the host's own events beside the daemon-shaped ones", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              new api.Notice("hello from demo");
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const stateChange = client.nextEvent("host.plugin_state_changed");
      const notice = client.nextEvent("host.notice");
      await client.call("host.enable_plugin", { id: "demo" });
      await expect(stateChange).resolves.toEqual({ id: "demo", state: "loaded", reason: null });
      await expect(notice).resolves.toMatchObject({
        plugin_id: "demo",
        message: "hello from demo",
      });
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });
});
