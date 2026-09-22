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

/**
 * One `generation_committed` as the daemon sends it, relayed into the host.
 *
 * A helper rather than a fifth copy of the payload: the two fields a host
 * cannot honestly produce (`affected_reference_count` and the daemon's `cause`)
 * are what the relay is promising to pass through untouched, so every case that
 * drives one should be driving the same shape.
 */
function commit(harness: HostHarness, generation: number, previous: number): void {
  harness.server.relayDaemonEvent({
    type: "generation_committed",
    value: {
      previous_generation: previous,
      generation,
      cause: "watcher",
      changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
      affected_note_count: 1,
      affected_reference_count: 0,
    },
  });
}

/**
 * The same payload, **delivered rather than held**.
 *
 * {@link commit} goes through `relayDaemonEvent`, which holds a
 * `generation_committed` until this host's mirror has reached it — right for a
 * case about the hold, and wrong for a case about the socket, where the event
 * has to reach the subscription now. `broadcast` is the door the relay itself
 * uses once the hold releases, so this is the same road with the wait taken
 * out.
 */
function broadcastCommit(harness: HostHarness, generation: number, previous: number): void {
  harness.server.broadcast({
    type: "generation_committed",
    value: {
      previous_generation: previous,
      generation,
      cause: "watcher",
      changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
      affected_note_count: 1,
      affected_reference_count: 0,
    },
  });
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

      // **One real commit, so a real daemon-caused generation is among the
      // events this client is owed.** It goes into the paused socket's buffer
      // and arrives when the client resumes.
      await harness.commitGeneration({ modified: ["A.md"], sources: { "A.md": "# A\n1\n" } });
      const base = harness.mirror.generation();

      // **Fill the socket's own buffers, however many events that takes.** How
      // much a kernel holds for a Unix socket before it pushes back is the
      // kernel's business — tens of kilobytes on Darwin, hundreds on Linux — so
      // a fixed count would be a test about the platform. Emit until the host
      // reports a subscriber that is genuinely behind, and only then overflow
      // the queue by a known amount.
      //
      // **The fill is broadcast, not committed, and that is this case's fix.**
      // It used to drive `harness.commitGeneration` for every event, and each
      // of those is a whole dialogue with the fake daemon — a refetch answered,
      // the mirror applied, the host settled — so filling a socket cost a few
      // hundred round trips through the event loop. Quiet that is 130 ms; on a
      // loaded machine, where a turn of the loop can cost tens of milliseconds,
      // the final review measured the case **time out at 30 s**, taking the
      // whole suite's exit code with it: one red run in four. The loop was
      // bounded in commits and unbounded in time, which is not a bound. A
      // broadcast is the same road — the same `HostServer`, the same
      // `ClientSubscriptions`, the same real socket refusing the same bytes —
      // with the daemon dialogue taken out of it, so the fill costs turns of
      // the loop rather than round trips. The sibling case above drives the
      // relay by hand for the same reason.
      //
      // Bounded three ways, so no future machine can make this the slow case
      // again: by count, by wall clock, and by a diagnosis rather than a
      // timeout if either bound is reached.
      const deadline = Date.now() + 5_000;
      const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
      let emitted = 0;
      const emit = async (): Promise<void> => {
        emitted += 1;
        broadcastCommit(harness, base + emitted, base + emitted - 1);
        // One turn per event: `HostServer.broadcast` hands the loop a turn once
        // a subscriber is behind, so without this the events would sit in its
        // outbox and be delivered after this case had already resumed the
        // client — which is the one order in which no collapse happens.
        await tick();
      };
      while (harness.server.pendingEvents() === 0) {
        if (emitted >= 20_000 || Date.now() > deadline) {
          throw new Error(
            `the socket never pushed back: ${String(emitted)} events emitted in ` +
              `${String(Date.now() - (deadline - 5_000))} ms, pendingEvents()=` +
              `${String(harness.server.pendingEvents())}`,
          );
        }
        await emit();
      }
      expect(harness.server.pendingEvents()).toBeGreaterThan(0);
      for (let i = 0; i < 64 + 5; i += 1) await emit();

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
      expect(committed.length).toBeLessThan(emitted + 1);
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

  /**
   * A subscription over a writer a case drives by hand.
   *
   * The per-subscription void rule is deterministic and needs no socket — every
   * assertion below is about **what the client is written**, which is the only
   * thing that matters and the thing `heldCommitCount()` cannot see.
   */
  function queueProbe(generation: number): {
    subscriptions: ClientSubscriptions;
    written: Array<{ type: string; generation: number | null }>;
    stall: () => void;
    resume: () => void;
  } {
    const written: Array<{ type: string; generation: number | null }> = [];
    let backedUp = false;
    let drain: (() => void) | null = null;
    const subscriptions = new ClientSubscriptions({
      limit: 2,
      currentGeneration: () => generation,
      mintId: () => "s-1",
      writer: {
        write: (line) => {
          const frame = JSON.parse(line) as {
            event: { type: string; value: { generation?: number } };
          };
          written.push({ type: frame.event.type, generation: frame.event.value.generation ?? null });
          return !backedUp;
        },
        onceDrain: (listener) => {
          drain = listener;
        },
      },
    });
    subscriptions.open();
    return {
      subscriptions,
      written,
      stall: () => {
        backedUp = true;
      },
      resume: () => {
        backedUp = false;
        drain?.();
      },
    };
  }

  const committed = (generation: number): { type: string; value: unknown } => ({
    type: "generation_committed",
    value: { generation },
  });

  it("voids a commit at or below a relayed resync, and lets the next one through", () => {
    const { subscriptions, written } = queueProbe(10);
    subscriptions.deliver({
      type: "resync_required",
      value: { current_generation: 10, reason: "oversized_change_set" },
    });
    // A client told "re-read at generation 10" that then applied a change set
    // for 9 or 10 would move its own state backwards.
    subscriptions.deliver(committed(9));
    subscriptions.deliver(committed(10));
    subscriptions.deliver(committed(11));
    expect(written).toEqual([
      { type: "resync_required", generation: null },
      { type: "generation_committed", generation: 11 },
    ]);
  });

  it("voids a commit at or below the collapse it synthesized for itself", () => {
    const { subscriptions, written, stall, resume } = queueProbe(10);
    // Back the writer up and overflow the queue, so the subscription owes
    // itself a collapse; the drain is what writes it.
    stall();
    for (let i = 0; i < 6; i += 1) subscriptions.deliver(committed(100 + i));
    resume();
    expect(written.at(-1)).toEqual({ type: "resync_required", generation: null });
    // The collapse names generation 10, so a commit released from the server's
    // held set afterwards at 9 or 10 is void for this subscription — which no
    // server-side prune can see, because the collapse was this subscription's
    // own.
    written.length = 0;
    subscriptions.deliver(committed(9));
    subscriptions.deliver(committed(10));
    subscriptions.deliver(committed(11));
    expect(written).toEqual([{ type: "generation_committed", generation: 11 }]);
  });

  it("stores the generation it knows for a resync that names none", () => {
    const { subscriptions, written } = queueProbe(10);
    subscriptions.deliver({
      type: "resync_required",
      value: { current_generation: null, reason: "runtime_recovered" },
    });
    written.length = 0;
    // Everything up to what the host knows now is void — and **everything after
    // it is not**. A watermark of infinity would deafen this subscription for
    // the life of the connection.
    subscriptions.deliver(committed(10));
    subscriptions.deliver(committed(11));
    subscriptions.deliver(committed(12));
    expect(written).toEqual([
      { type: "generation_committed", generation: 11 },
      { type: "generation_committed", generation: 12 },
    ]);
  });

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

  it("drops a held commit that a later resync has made void", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const seen: string[] = [];
      client.onEvent((envelope) => seen.push(envelope.event.type));

      const generation = harness.mirror.generation() + 1;
      harness.server.relayDaemonEvent({
        type: "generation_committed",
        value: {
          previous_generation: harness.mirror.generation(),
          generation,
          cause: "watcher",
          changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
          affected_note_count: 1,
          affected_reference_count: 0,
        },
      });
      expect(harness.server.heldCommitCount()).toBe(1);

      // The daemon lost per-path detail five generations on. The resync is not
      // held — it is a statement about the engine, not about this host's view —
      // and it **voids** the commit still waiting behind it.
      harness.server.relayDaemonEvent({
        type: "resync_required",
        value: { current_generation: generation + 4, reason: "oversized_change_set" },
      });
      await harness.serverQuiesce();
      expect(seen).toEqual(["resync_required"]);
      expect(harness.server.heldCommitCount()).toBe(0);

      // And it stays void when the mirror finally reaches it: a client told
      // "re-read at generation N + 5" that then applied a change set for N would
      // move its own state backwards.
      await harness.commitGeneration({ generation, modified: ["A.md"], announce: false });
      await harness.serverQuiesce();
      expect(seen).toEqual(["resync_required"]);
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("keeps delivering after a resync that names no generation", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const delivered: number[] = [];
      client.onEvent((envelope) => {
        if (envelope.event.type !== "generation_committed") return;
        delivered.push((envelope.event.value as { generation: number }).generation);
      });

      // `current_generation: null` is what the daemon sends when it cannot name
      // one — `ResyncRequiredEventDto.current_generation` is `number | null`,
      // written from the shipped Rust — and it is the strongest form of "start
      // over". It voids what is held **once**; it must not become a standing
      // watermark, or every future commit on this subscription is dropped for
      // the life of the connection and the client is never told the vault
      // changed again. It does not crash and it does not refuse: it lies by
      // silence, which is the failure class this door's lens exists for.
      harness.server.relayDaemonEvent({
        type: "resync_required",
        value: { current_generation: null, reason: "runtime_recovered" },
      });
      await harness.serverQuiesce();
      expect(delivered).toEqual([]);

      for (let i = 0; i < 3; i += 1) {
        await harness.commitGeneration({
          modified: ["A.md"],
          sources: { "A.md": `# A\n${String(i)}\n` },
        });
      }
      await harness.serverQuiesce();
      expect(delivered).toHaveLength(3);
      expect(delivered[2]).toBe(harness.mirror.generation());
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  });

  it("bounds the held commits and collapses the hold rather than growing", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      config: { subscriberQueueLimit: 32 },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const collapse = client.nextEvent("resync_required");

      // A mirror that falls a long way behind a committing daemon — a slow
      // re-hydration, a stalled engine connection, a vault import. The held list
      // was the one buffer on this door that grew without bound: measured at
      // 7.4 MiB for twenty thousand commits, with nothing refusing any of them.
      const ahead = harness.mirror.generation() + 1;
      let peak = 0;
      for (let i = 0; i < 20_000; i += 1) {
        harness.server.relayDaemonEvent({
          type: "generation_committed",
          value: {
            previous_generation: ahead + i,
            generation: ahead + i + 1,
            cause: "watcher",
            changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
            affected_note_count: 1,
            affected_reference_count: 0,
          },
        });
        peak = Math.max(peak, harness.server.heldCommitCount());
      }
      // Flat, at the same bound the subscriber queue uses.
      expect(peak).toBeLessThanOrEqual(32);
      await expect(collapse).resolves.toMatchObject({
        reason: "subscriber_lag",
        current_generation: harness.mirror.generation(),
      });
      // **One collapse for the episode, not one per overflow.** The held set
      // overflows again every 32 commits while the mirror stands still, and
      // announcing each one told the subscriber the same true thing three
      // hundred times — three hundred re-hydrations for one condition.
      const events = await client.drainEvents();
      expect(events.filter((event) => event.type === "resync_required")).toHaveLength(1);
      // The client is still served: a collapse is a message, not a broken
      // connection.
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
      await client.disconnect();
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it("re-arms the hold collapse once the mirror has really released something", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      config: { subscriberQueueLimit: 4 },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});

      /** Five commits at a limit of four: the fifth is the overflow. */
      const overflow = (): void => {
        // Far enough ahead that this host's mirror can never reach them, which
        // is what keeps them held rather than delivered on arrival.
        const ahead = harness.mirror.generation() + 1_000;
        for (let i = 0; i < 5; i += 1) commit(harness, ahead + i + 1, ahead + i);
      };

      overflow();
      await harness.serverQuiesce();

      // **The release is the whole case.** One collapse per episode is right
      // only if an episode can end, and the single thing that ends one is the
      // mirror actually moving: a latch that was set and never cleared would
      // say "your view is void" once and then stay silent for the life of the
      // process, however far behind the mirror fell afterwards — the failure
      // that looks exactly like a healthy host from the client's side.
      const generation = harness.mirror.generation() + 1;
      commit(harness, generation, harness.mirror.generation());
      await harness.commitGeneration({ generation, modified: ["A.md"], announce: false });
      await harness.serverQuiesce();

      overflow();
      await harness.serverQuiesce();

      const events = await client.drainEvents();
      // Two episodes, two collapses — and the commit the mirror caught up to,
      // relayed in between, which is the evidence the first episode ended.
      expect(events.filter((event) => event.type === "resync_required")).toHaveLength(2);
      expect(events.filter((event) => event.type === "generation_committed")).toHaveLength(1);
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
