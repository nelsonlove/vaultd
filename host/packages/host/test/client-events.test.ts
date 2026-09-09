import { describe, expect, it } from "vitest";

import { VaultdClient } from "../src/client/client";
import { LineFramer } from "../src/client/framing";
import { FakeDaemon } from "../src/testing/fake-daemon";
import type { EventEnvelope, RuntimeEventDto } from "../src/client/events";

/**
 * The subscription half of the client, against `FakeDaemon`.
 *
 * The real daemon proves the wire shapes (`client-events-real-daemon.test.ts`).
 * It cannot prove the tolerance ones: a variant a later `vaultd` introduces is
 * by definition a variant this `vaultd` never emits, so an unknown event type,
 * cause, reason, live state, or change-set kind can only be put on the wire by
 * a fake. Those cases live here.
 *
 * Nothing in this file sleeps. `daemon.received(n)` is a rendezvous on the
 * parsed request line, and {@link settled} yields exactly one turn of the event
 * loop — a `PassThrough` delivers a chunk on `process.nextTick`, which runs
 * before the `setImmediate` this awaits, so one turn is always enough and never
 * a race.
 */
const settled = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const connect = (daemon: FakeDaemon, seen: EventEnvelope[]): VaultdClient =>
  new VaultdClient({
    stdout: daemon.stdout,
    stdin: daemon.stdin,
    onEvent: (envelope) => seen.push(envelope),
    onFatal: () => {},
  });

describe("subscribeEvents", () => {
  it("returns the start generation and routes events to the handler", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    expect(sent!.request.method).toBe("subscribe_events");
    // `subscribe_events` takes an empty params object, not an absent one.
    expect(sent!.request.params).toEqual({});
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 12,
      live_state: "watching",
    });
    const handle = await pending;
    expect(handle.subscriptionId).toBe("sub-1");
    expect(handle.startGeneration).toBe(12);
    expect(handle.liveState).toBe("watching");
    daemon.emit("sub-1", {
      type: "generation_committed",
      value: {
        previous_generation: 12,
        generation: 13,
        cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await settled();
    expect(routed).toHaveLength(1);
    expect(routed[0]!.type).toBe("generation_committed");
  });

  it("delivers an unknown event type instead of throwing", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: null,
      live_state: "starting",
    });
    await pending;
    daemon.emit("sub-1", { type: "future_event", value: { anything: true } });
    daemon.emit("sub-1", {
      type: "generation_committed",
      value: {
        previous_generation: null,
        generation: 1,
        cause: "some_future_cause",
        changes: { kind: "some_future_kind" },
        affected_note_count: 0,
        affected_reference_count: 0,
      },
    });
    await settled();
    expect(routed.map((event) => event.type)).toEqual(["future_event", "generation_committed"]);
  });

  it("ignores events for a subscription it already closed", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [subscribe] = await daemon.received(1);
    daemon.respondOk(subscribe!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 3,
      live_state: "watching",
    });
    const handle = await pending;
    const closing = handle.close();
    const sent = await daemon.received(2);
    expect(sent[1]!.request.method).toBe("unsubscribe");
    expect(sent[1]!.request.params).toEqual({ subscription_id: "sub-1" });
    daemon.respondOk(sent[1]!.id, "unsubscribe", { subscription_id: "sub-1" });
    await closing;
    daemon.emit("sub-1", {
      type: "resync_required",
      value: { current_generation: 9, reason: "runtime_recovered" },
    });
    await settled();
    expect(routed).toHaveLength(0);
  });

  it("delivers an event that arrived before unsubscribe was answered", async () => {
    // The daemon flushes a subscription's queue *before* answering
    // `unsubscribe` (protocol.md §Events), so an event that shares the chunk
    // with that response is still this subscription's and must be delivered.
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [subscribe] = await daemon.received(1);
    daemon.respondOk(subscribe!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 3,
      live_state: "watching",
    });
    const handle = await pending;
    const closing = handle.close();
    const sent = await daemon.received(2);
    daemon.writeRaw(
      `${JSON.stringify({
        version: 1,
        subscription_id: "sub-1",
        event: { type: "config_changed", value: { path: ".obsidian/app.json" } },
      })}\n` +
        `${JSON.stringify({
          version: 1,
          id: sent[1]!.id,
          outcome: {
            status: "ok",
            value: { type: "unsubscribe", value: { subscription_id: "sub-1" } },
          },
        })}\n`,
    );
    await closing;
    expect(routed.map((event) => event.type)).toEqual(["config_changed"]);
  });

  it("delivers an event that raced the subscribe response, in order, before resolving", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    // One chunk carrying the subscribe response AND two events for the
    // subscription it is about to create. The client parses all three frames
    // in one `consume` call, so the handler is provably not installed yet when
    // the events are routed.
    daemon.writeRaw(
      `${JSON.stringify({
        version: 1,
        id: sent!.id,
        outcome: {
          status: "ok",
          value: {
            type: "subscribe_events",
            value: { subscription_id: "sub-1", generation: 5, live_state: "watching" },
          },
        },
      })}\n` +
        `${JSON.stringify({
          version: 1,
          subscription_id: "sub-1",
          event: {
            type: "generation_committed",
            value: {
              previous_generation: 5,
              generation: 6,
              cause: "watcher",
              changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
              affected_note_count: 1,
              affected_reference_count: 0,
            },
          },
        })}\n` +
        `${JSON.stringify({
          version: 1,
          subscription_id: "sub-1",
          event: { type: "resync_required", value: { current_generation: 7, reason: "watcher_overflow" } },
        })}\n`,
    );
    const handle = await pending;
    expect(handle.subscriptionId).toBe("sub-1");
    // Both events must already be delivered, in arrival order, by the time the
    // subscribe promise resolves. A dropped first event is the exact bug the
    // orphan buffer exists to prevent, and it is invisible without this test.
    expect(routed.map((event) => event.type)).toEqual(["generation_committed", "resync_required"]);
  });

  it("keeps two subscriptions apart", async () => {
    const daemon = new FakeDaemon();
    const first: RuntimeEventDto[] = [];
    const second: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pendingFirst = client.subscribeEvents((event) => first.push(event));
    const [a] = await daemon.received(1);
    daemon.respondOk(a!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 1,
      live_state: "watching",
    });
    await pendingFirst;
    const pendingSecond = client.subscribeEvents((event) => second.push(event));
    const sent = await daemon.received(2);
    daemon.respondOk(sent[1]!.id, "subscribe_events", {
      subscription_id: "sub-2",
      generation: 1,
      live_state: "watching",
    });
    await pendingSecond;
    daemon.emit("sub-2", { type: "config_changed", value: { path: ".obsidian/hotkeys.json" } });
    await settled();
    expect(first).toHaveLength(0);
    expect(second.map((event) => event.type)).toEqual(["config_changed"]);
  });
});

describe("unknown-variant tolerance", () => {
  it("hands an unknown live_state back from subscribe unchanged", async () => {
    const daemon = new FakeDaemon();
    const client = connect(daemon, []);
    const pending = client.subscribeEvents(() => {});
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 4,
      live_state: "hyperspace",
    });
    const handle = await pending;
    expect(handle.liveState).toBe("hyperspace");
  });

  it("delivers an unknown cause, reason, live_state, and change-set kind with the envelope intact", async () => {
    const daemon = new FakeDaemon();
    const envelopes: EventEnvelope[] = [];
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, envelopes);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 4,
      live_state: "watching",
    });
    await pending;
    // Every one of these is a shape a *later* daemon could emit. Each must
    // reach the subscriber degraded — the unknown spelling preserved, not
    // erased — with the rest of the envelope untouched.
    const wire: RuntimeEventDto[] = [
      {
        type: "generation_committed",
        value: {
          previous_generation: 4,
          generation: 5,
          cause: "some_future_cause",
          changes: { kind: "some_future_kind" },
          affected_note_count: 2,
          affected_reference_count: 3,
        },
      },
      { type: "runtime_state_changed", value: { generation: 5, live_state: "hyperspace" } },
      { type: "resync_required", value: { current_generation: 5, reason: "some_future_reason" } },
      { type: "from_the_future", value: { nested: { deep: [1, 2, 3] } } },
    ];
    for (const event of wire) daemon.emit("sub-1", event);
    await settled();
    expect(routed).toEqual(wire);
    expect(envelopes.map((envelope) => envelope.subscription_id)).toEqual([
      "sub-1",
      "sub-1",
      "sub-1",
      "sub-1",
    ]);
  });

  it("routes an event envelope carrying a top-level id tail field to the subscription", async () => {
    // Tail-field tolerance and the frame router disagreed: routing on the
    // presence of `id` alone sent an event that happens to carry one down the
    // response branch, where it was malformed and fatal. An event envelope is
    // identified by `subscription_id` + `event`, and a tail field a later
    // daemon adds is a widening, not a corruption.
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => {},
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 4,
      live_state: "watching",
    });
    await pending;
    daemon.writeRaw(
      `${JSON.stringify({
        version: 1,
        subscription_id: "sub-1",
        id: "not-a-request-id",
        event: { type: "config_changed", value: { path: ".obsidian/app.json" } },
      })}\n`,
    );
    await settled();
    expect(routed.map((event) => event.type)).toEqual(["config_changed"]);
    expect(fatal).toBeNull();
  });

  it("decodes an event line with a top-level id tail field as an event frame", () => {
    // The same fix, one layer down: the boundary decoder must not route on
    // `id` before it has looked for the event shape.
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(
      Buffer.from(
        '{"version":1,"subscription_id":"sub-1","id":"tail","event":{"type":"config_changed","value":{"path":"x"}}}\n',
      ),
    );
    expect(malformed).toEqual([]);
    expect(frames).toHaveLength(1);
    expect("subscription_id" in frames[0]!).toBe(true);
  });

  it("still refuses a response envelope with no outcome, and attributes it", () => {
    // The other side of the same branch: a response that lost its `outcome` is
    // still malformed, and still names the caller waiting on it.
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(Buffer.from('{"version":1,"id":"h-1"}\n'));
    expect(frames).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.id).toBe("h-1");
  });
});

describe("a subscriber that throws", () => {
  it("reaches the subscription's error channel and leaves the client alive", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const errors: string[] = [];
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => {},
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.subscribeEvents(
      (event) => {
        if (event.type === "config_changed") throw new Error("the subscriber is buggy");
        routed.push(event);
      },
      (error) => errors.push(error.message),
    );
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 4,
      live_state: "watching",
    });
    await pending;
    daemon.emit("sub-1", { type: "config_changed", value: { path: ".obsidian/app.json" } });
    daemon.emit("sub-1", { type: "resync_required", value: { current_generation: 5, reason: "watcher_overflow" } });
    await settled();
    expect(errors).toEqual(["the subscriber is buggy"]);
    // The event behind the throw still arrives, and the transport is untouched:
    // a subscriber bug must never take down the connection every other
    // subscription shares.
    expect(routed.map((event) => event.type)).toEqual(["resync_required"]);
    expect(fatal).toBeNull();
    const health = client.request<{ service: string }>("health");
    const requests = await daemon.received(2);
    daemon.respondOk(requests[1]!.id, "health", { service: "vaultd", status: "ok" });
    await expect(health).resolves.toEqual({ service: "vaultd", status: "ok" });
  });

  it("falls back to onHandlerError when the subscription named no channel", async () => {
    const daemon = new FakeDaemon();
    const errors: string[] = [];
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => {},
      onHandlerError: (error) => errors.push(error.message),
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.subscribeEvents(() => {
      throw new Error("no channel of my own");
    });
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 4,
      live_state: "watching",
    });
    await pending;
    daemon.emit("sub-1", { type: "config_changed", value: { path: "x" } });
    await settled();
    expect(errors).toEqual(["no channel of my own"]);
    expect(fatal).toBeNull();
  });
});

describe("the orphan buffer", () => {
  it("drops the oldest events and leads the drain with a synthesized subscriber_lag", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    // 300 events and the subscribe response in one chunk: every event is
    // routed while the subscribe is still in flight, so all 300 land in the
    // orphan buffer, which is bounded at 256.
    const lines: string[] = [];
    for (let i = 1; i <= 300; i += 1) {
      lines.push(
        JSON.stringify({
          version: 1,
          subscription_id: "sub-1",
          event: { type: "config_changed", value: { path: `p-${i}` } },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        version: 1,
        id: sent!.id,
        outcome: {
          status: "ok",
          value: {
            type: "subscribe_events",
            value: { subscription_id: "sub-1", generation: 5, live_state: "watching" },
          },
        },
      }),
    );
    daemon.writeRaw(`${lines.join("\n")}\n`);
    await pending;
    expect(routed).toHaveLength(256);
    // The gap is announced, never silent — the same contract the daemon's own
    // bounded queues keep (protocol.md §Bounds).
    expect(routed[0]).toEqual({
      type: "resync_required",
      value: { current_generation: null, reason: "subscriber_lag" },
    });
    // What survived is the newest run, contiguous and in order, ending at the
    // last event the daemon sent.
    const paths = routed.slice(1).map((event) => (event.value as { path: string }).path);
    expect(paths[paths.length - 1]).toBe("p-300");
    const first = Number(paths[0]!.slice(2));
    expect(paths).toEqual(
      Array.from({ length: paths.length }, (_unused, index) => `p-${first + index}`),
    );
  });

  it("holds no handler once the transport is finished", async () => {
    const daemon = new FakeDaemon();
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => {},
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.subscribeEvents(() => {});
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 1,
      live_state: "watching",
    });
    await pending;
    expect(client.subscriptionCount()).toBe(1);
    daemon.endStdout();
    await settled();
    // The daemon's stdout closed: nothing can reach a handler again, so the
    // client keeps none — a supervisor that restarts the daemon subscribes
    // afresh rather than inheriting the dead one's handlers.
    expect(fatal).not.toBeNull();
    expect(client.subscriptionCount()).toBe(0);
  });

  it("does not replay a post-close event to a later subscription with the same id", async () => {
    const daemon = new FakeDaemon();
    const firstSeen: RuntimeEventDto[] = [];
    const secondSeen: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => firstSeen.push(event));
    const [subscribe] = await daemon.received(1);
    daemon.respondOk(subscribe!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 1,
      live_state: "watching",
    });
    const handle = await pending;
    const closing = handle.close();
    const sent = await daemon.received(2);
    daemon.respondOk(sent[1]!.id, "unsubscribe", { subscription_id: "sub-1" });
    await closing;
    daemon.emit("sub-1", { type: "config_changed", value: { path: "after-close" } });
    await settled();
    const again = client.subscribeEvents((event) => secondSeen.push(event));
    const requests = await daemon.received(3);
    daemon.respondOk(requests[2]!.id, "subscribe_events", {
      subscription_id: "sub-1",
      generation: 2,
      live_state: "watching",
    });
    await again;
    expect(firstSeen).toHaveLength(0);
    expect(secondSeen).toHaveLength(0);
  });
});
