/**
 * One client's subscriptions, and the bounded queue behind each of them.
 *
 * **The host never blocks on a slow subscriber.** A client that stops reading
 * fills the kernel's buffer, then the socket's own write buffer, and from that
 * point every event it is owed has to go somewhere. Growing without bound is how
 * one stalled client takes the whole host down, so the queue is capped at
 * {@link HostConfig.subscriberQueueLimit} and a subscription that reaches the cap
 * owes **one** `resync_required { reason: "subscriber_lag" }` in place of
 * everything it missed.
 *
 * That is the same discipline `vaultd`'s own subscriber registry uses, and it is
 * reimplemented here rather than reinvented: the shape a subscriber has to
 * handle is identical through either door, so a client that already knows what
 * to do with a daemon's `subscriber_lag` needs no second code path for the
 * host's.
 *
 * **Everything queued at the moment of the drop is discarded, not just the
 * overflow.** A queue that kept its first 256 events and dropped the rest would
 * deliver a prefix of the truth and then a resync — and a client applying that
 * prefix would move its own state forward on a partial account before being told
 * to re-read. One resync, carrying the generation read **at flush time**, is the
 * whole message: *you are behind, here is where the host is now, re-read*.
 *
 * **One writer per socket.** Responses and events go through the same `write`,
 * so a line can never be interleaved with another line, and the flush loop stops
 * the moment the socket reports backpressure and resumes on `drain`.
 */

import type { ResyncReasonDto } from "../client/protocol";

/** One event as the host broadcasts it, before it is addressed to anybody. */
export interface HostEvent {
  readonly type: string;
  readonly value: unknown;
}

/**
 * The socket, as this module needs it.
 *
 * Two methods, because that is all a bounded queue over a stream needs: hand a
 * line over and be told whether the stream is backed up, and be told when it is
 * not any more. Narrow enough that `test/server-subscriptions.test.ts` drives the
 * queue with a writer that reports backpressure on command — which is the only
 * way to assert the bound without depending on how many bytes a particular
 * kernel happens to buffer for a Unix socket.
 */
export interface EventWriter {
  /** Write one line. `false` means the stream is backed up (the line is kept). */
  write(line: string): boolean;
  /** Call `listener` once, when the stream drains. */
  onceDrain(listener: () => void): void;
}

interface Subscription {
  readonly id: string;
  readonly queue: HostEvent[];
  /** Set when the cap was reached. Cleared when the resync is actually emitted. */
  dropped: boolean;
  /**
   * The highest generation this subscription has been told to re-read at.
   *
   * **A `generation_committed` at or below it is void and is never delivered.**
   * A subscriber told "your view is void, re-read at generation N" that then
   * received a change set for generation 2 would move its own state *backwards*
   * — which is the one thing the resync told it not to do. The server prunes the
   * commits it is *holding* when a resync is relayed; this is the same rule one
   * layer down, and it is what covers the collapse this class synthesizes for a
   * subscriber that fell behind, which no server-side prune can see.
   */
  resyncedThrough: number;
}

export interface SubscriptionsDeps {
  readonly writer: EventWriter;
  readonly limit: number;
  /** Read at emit time, so a collapsed subscriber is told where the host is *now*. */
  readonly currentGeneration: () => number;
  /** Mints subscription ids. Unique across the whole host, not just this client. */
  readonly mintId: () => string;
}

export class ClientSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private flushing = false;
  private rotation = 0;

  constructor(private readonly deps: SubscriptionsDeps) {}

  /**
   * Open one subscription.
   *
   * The generation it answers with is the one the host holds *now*, which is the
   * client's start point: every event this subscription delivers describes a
   * move away from it.
   */
  open(): { id: string; generation: number } {
    const id = this.deps.mintId();
    this.subscriptions.set(id, { id, queue: [], dropped: false, resyncedThrough: -1 });
    return { id, generation: this.deps.currentGeneration() };
  }

  close(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  count(): number {
    return this.subscriptions.size;
  }

  /** Everything still waiting, across this client's subscriptions. */
  pending(): number {
    let total = 0;
    for (const subscription of this.subscriptions.values()) {
      total += subscription.queue.length + (subscription.dropped ? 1 : 0);
    }
    return total;
  }

  /** True while a flush is waiting on the socket to drain. */
  blocked(): boolean {
    return this.flushing;
  }

  /**
   * Queue one event for every subscription this client holds, then flush.
   *
   * **Answers whether the event actually reached somebody.** `false` means this
   * client will not see it: either it holds no subscriptions at all, or at
   * least one of them was collapsed into a `resync_required` and this event is
   * part of the gap that collapse stands in for.
   *
   * Almost every caller ignores the answer, and should: a broadcast describes
   * something that happened to the vault, the client has been told its view is
   * void, and re-reading is how it catches up. The one caller that cannot
   * ignore it is the interaction broker, because a prompt is not a fact about
   * the vault a client can re-read — it is a question with a plugin waiting on
   * the answer, and a question nobody received has to fail **now** rather than
   * two minutes later on its timeout. See `interaction/broker.ts`.
   */
  deliver(event: HostEvent): boolean {
    const resyncAt = resyncWatermarkOf(event, this.deps.currentGeneration);
    const committedAt = event.type === "generation_committed" ? generationOf(event) : null;
    // Vacuously "every subscription took it" is the wrong answer for a client
    // with none: what the caller is asking is whether the event reached
    // anybody, and nobody is not somebody.
    let reached = this.subscriptions.size > 0;
    for (const subscription of this.subscriptions.values()) {
      // Void: this subscription has already been told to re-read at a generation
      // at or past this one. See {@link Subscription.resyncedThrough}. Not
      // delivered, so not reached — which only a `generation_committed` can be,
      // and no caller that reads the answer ever sends one.
      if (committedAt !== null && committedAt <= subscription.resyncedThrough) {
        reached = false;
        continue;
      }
      if (resyncAt !== null) {
        subscription.resyncedThrough = Math.max(subscription.resyncedThrough, resyncAt);
      }
      // Already behind: everything from here is part of the same gap, and one
      // gap is one `resync_required`. Queueing more would only postpone the
      // moment the client is told, and would deliver events *older* than the
      // generation that resync is about to name.
      if (subscription.dropped) {
        reached = false;
        continue;
      }
      if (subscription.queue.length >= this.deps.limit) {
        subscription.dropped = true;
        subscription.queue.length = 0;
        reached = false;
        continue;
      }
      subscription.queue.push(event);
    }
    this.flush();
    return reached;
  }

  /** Forget every subscription. The client is gone, or has been torn down. */
  clear(): void {
    this.subscriptions.clear();
  }

  /**
   * Write until the queues are empty or the socket asks us to stop.
   *
   * Re-entrant calls are absorbed: `deliver` calls this on every event, and a
   * flush already waiting on `drain` must not start a second loop writing the
   * same queue from two places.
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    for (;;) {
      const line = this.takeNext();
      if (line === null) break;
      if (!this.deps.writer.write(line)) {
        // The line above **was** accepted — `write` answers false about the
        // stream's state, not about the line — so nothing is lost by stopping
        // here. The next one waits for the drain.
        this.deps.writer.onceDrain(() => {
          this.flushing = false;
          this.flush();
        });
        return;
      }
    }
    this.flushing = false;
  }

  /**
   * The next line to write, round-robin across this client's subscriptions.
   *
   * Round-robin rather than in order, so a subscription with a full queue cannot
   * starve a subscription with one event in it — two subscriptions on one socket
   * are two independent streams, and a client that opened a second one did so
   * because it wants both.
   */
  private takeNext(): string | null {
    const subscriptions = [...this.subscriptions.values()];
    if (subscriptions.length === 0) return null;
    for (let step = 0; step < subscriptions.length; step += 1) {
      const at = (this.rotation + step) % subscriptions.length;
      const subscription = subscriptions[at];
      if (subscription === undefined) continue;
      const event = subscription.queue.shift();
      if (event !== undefined) {
        this.rotation = at + 1;
        return frame(subscription.id, event);
      }
      if (subscription.dropped) {
        subscription.dropped = false;
        this.rotation = at + 1;
        const collapse = this.lagEvent();
        // The collapse is a resync like any other: everything at or below the
        // generation it names is void for this subscription from here on, which
        // covers a commit the server releases from its held set afterwards.
        subscription.resyncedThrough = Math.max(
          subscription.resyncedThrough,
          resyncWatermarkOf(collapse, this.deps.currentGeneration) ?? -1,
        );
        return frame(subscription.id, collapse);
      }
    }
    return null;
  }

  /**
   * The collapse, as `vaultd` spells it.
   *
   * `current_generation` is read here rather than when the drop happened,
   * because the client is about to re-read and what it needs is where the host
   * is when the message reaches it.
   */
  private lagEvent(): HostEvent {
    const reason: ResyncReasonDto = "subscriber_lag";
    return {
      type: "resync_required",
      value: { current_generation: this.deps.currentGeneration(), reason },
    };
  }
}

/** One event envelope, as a line. The host's envelope is the daemon's. */
function frame(subscriptionId: string, event: HostEvent): string {
  return `${JSON.stringify({ version: 1, subscription_id: subscriptionId, event })}\n`;
}

/** The generation a `generation_committed` names, or `-1` if it names none. */
function generationOf(event: HostEvent): number {
  const value = event.value as { generation?: unknown } | null;
  return typeof value?.generation === "number" ? value.generation : -1;
}

/**
 * The generation a `resync_required` tells a subscriber to re-read at, or `null`
 * for any other event.
 *
 * **A resync that names no generation is read as the one the host knows now, and
 * never as infinity.** The daemon sends `current_generation: null` when it
 * cannot name one, and the two things this host does with a resync want
 * different answers to that. Voiding the *held* set is a one-shot "everything
 * currently held is void", and infinity is right for it. This watermark is a
 * **standing** rule — nothing ever lowers it — so infinity here meant every
 * future `generation_committed`, at any generation, was dropped for the life of
 * the subscription: the client kept being answered, kept receiving host events,
 * and was never told the vault had changed again. It did not crash and it did
 * not refuse; it lied by silence.
 *
 * The host's current generation is the honest standing answer: everything the
 * host could still release for a generation already passed is void, and the
 * next commit is not.
 */
function resyncWatermarkOf(event: HostEvent, now: () => number): number | null {
  if (event.type !== "resync_required") return null;
  const value = event.value as { current_generation?: unknown } | null;
  return typeof value?.current_generation === "number" ? value.current_generation : now();
}
