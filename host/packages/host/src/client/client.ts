import { VaultdError } from "./errors";
import { LineFramer, MalformedEnvelopeError } from "./framing";
import { PROTOCOL_VERSION } from "./protocol";
import type {
  EventEnvelope,
  LiveStateDto,
  RequestEnvelope,
  ResponseEnvelope,
  RuntimeEventDto,
  SubscribeEventsResponse,
} from "./protocol";

export { VaultdError } from "./errors";

interface Deferred {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** What a subscriber is handed, once per event, in arrival order. */
export type SubscriptionHandler = (event: RuntimeEventDto) => void;

/** Where a throw out of a {@link SubscriptionHandler} goes. */
export type SubscriptionErrorHandler = (error: Error, event: RuntimeEventDto) => void;

interface Subscriber {
  handler: SubscriptionHandler;
  onError?: SubscriptionErrorHandler;
}

/**
 * One live subscription. `close()` is the only way to end it, and it is
 * idempotent: a second call returns the first call's promise, and a `close`
 * that failed may be retried.
 */
export interface SubscriptionHandle {
  readonly subscriptionId: string;
  /**
   * The generation this subscription starts from — a **strict** start point,
   * not a hint: no `generation_committed` naming this generation or an earlier
   * one is ever delivered here. `null` means the subscription opened before
   * anything had been committed.
   */
  readonly startGeneration: number | null;
  /** The runtime's observational status at the moment the subscription opened. */
  readonly liveState: LiveStateDto;
  close(): Promise<void>;
}

export interface VaultdClientOptions {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  onEvent(envelope: EventEnvelope): void;
  onFatal(error: Error): void;
  /**
   * Where a throw out of `onEvent` goes. Optional, and the default matters:
   * with a handler here, a consumer bug is the consumer's problem and the
   * client keeps running; **without** one, the throw is reported to `onFatal`
   * once the current chunk has finished settling, because a bug nobody claims
   * must not be swallowed. Either way the rest of the chunk is delivered
   * first — a response sharing a chunk with a throwing event handler still
   * settles.
   */
  onHandlerError?(error: Error, envelope: EventEnvelope): void;
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * Request / response over one vaultd stdio pair.
 *
 * The whole correlation story is one `Map<string, Deferred>` keyed by request
 * id. The frame router tells a response from an event by the presence of `id`:
 * a response envelope has `id` and `outcome`, an event envelope has
 * `subscription_id` and `event`, and the two never share a shape.
 *
 * Ids are `h-<counter>` **strings**, never numbers, because
 * `RequestEnvelope.id` is a Rust `String` and a JSON number there is a decode
 * error rather than a coercion.
 *
 * This class owns no process. Spawning, and the lifetime of the daemon behind
 * these streams, belong to the supervisor above it; `onFatal` is how the
 * client tells that supervisor the transport is finished — after it has
 * already failed everything in flight, so no caller is left waiting on a
 * connection nobody is reading any more.
 */
export class VaultdClient {
  private readonly framer = new LineFramer();
  private readonly pending = new Map<string, Deferred>();
  private readonly subscriptions = new Map<string, Subscriber>();
  private readonly orphanEvents = new Map<string, RuntimeEventDto[]>();
  private readonly closedSubscriptions = new Set<string>();
  private readonly options: VaultdClientOptions;
  private counter = 0;
  private closed = false;
  private pendingSubscribes = 0;

  /**
   * How many events may be held for a subscription whose handler is not
   * installed yet. Deliberately larger than the daemon's own per-subscription
   * bound of 64, because this buffer only has to cover one round trip.
   */
  private static readonly ORPHAN_LIMIT = 256;

  constructor(options: VaultdClientOptions) {
    this.options = options;
    options.stdout.on("data", (chunk: unknown) => {
      this.consume(chunk);
    });
    options.stdout.on("end", () => {
      this.die(new Error("daemon stdout closed"));
    });
    options.stdout.on("error", (error: Error) => {
      this.die(error);
    });
  }

  /**
   * Send one request and resolve with `outcome.value.value` — the operation's
   * own payload, unwrapped from the response envelope and its `{ type, value }`
   * tag. A `status: "err"` outcome rejects with a {@link VaultdError}.
   *
   * `params` is omitted from the envelope entirely when it is `undefined`,
   * because the daemon's adjacently tagged `Request` serializes its unit
   * variants (`health`, `get_vault_info`) with no `params` key at all.
   */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("client is closed"));
    const id = `h-${(this.counter += 1)}`;
    const envelope: RequestEnvelope =
      params === undefined
        ? { version: PROTOCOL_VERSION, id, request: { method } }
        : { version: PROTOCOL_VERSION, id, request: { method, params } };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.options.stdin.write(LineFramer.encode(envelope));
    });
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Reject everything in flight. The map is cleared before anything settles. */
  failAllPending(reason: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const deferred of waiting) deferred.reject(reason);
  }

  /** Stop accepting requests and fail what is in flight. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error("client closed"));
    this.dropSubscriptions();
  }

  /**
   * Subscribe to the daemon's live events.
   *
   * The handler is called once per event for this subscription, in arrival
   * order, and is handed the event **exactly as the daemon sent it**: an
   * unknown event type, cause, reason, live state, or change-set kind arrives
   * degraded rather than dropped, and no change set is reordered, expanded, or
   * filtered on the way through. Two rules govern applying one — `deleted`
   * before `created`, and a deleted folder implies its subtree — and both are
   * the caller's to apply; `client/events.ts` states them, together with what a
   * caller must do on each `resync_required` reason. This client never retries
   * or resyncs on its own.
   *
   * `onError` is where a throw out of `handler` goes, and passing one is the
   * expected shape of a subscription: a subscriber bug must not take down the
   * transport that every other subscription on this connection shares. With no
   * `onError`, the throw falls back to the client's `onHandlerError`; with
   * neither, it is dropped, because the alternative — `onFatal` — would let one
   * buggy subscriber kill the daemon connection. Either way the event behind
   * the throw is still delivered.
   *
   * **The registration race, and why the fix is a buffer.** `subscribe_events`
   * takes `{}` and the daemon mints the `subscription_id`, so there is no token
   * to register a handler under before the request goes out. Meanwhile
   * `await` yields, and one `consume` call can carry the subscribe response and
   * the first events of the subscription it creates. So events for a
   * subscription with no handler yet are buffered ({@link ORPHAN_LIMIT} of
   * them, oldest dropped and the gap announced as a synthesized
   * `resync_required { subscriber_lag }`) and drained, in order, after the
   * handler is installed and before this promise resolves.
   */
  async subscribeEvents(
    handler: SubscriptionHandler,
    onError?: SubscriptionErrorHandler,
  ): Promise<SubscriptionHandle> {
    const subscriber: Subscriber = onError ? { handler, onError } : { handler };
    this.pendingSubscribes += 1;
    let response: SubscribeEventsResponse;
    try {
      // `subscribe_events` takes an empty params object, not an absent one.
      response = await this.request<SubscribeEventsResponse>("subscribe_events", {});
    } finally {
      this.pendingSubscribes -= 1;
    }
    const id = response.subscription_id;
    this.subscriptions.set(id, subscriber);
    // Drain anything that arrived during the round trip, in arrival order,
    // before this promise resolves — so the caller never observes a gap.
    const buffered = this.orphanEvents.get(id);
    this.orphanEvents.delete(id);
    // Nothing is in flight any more, so an id still orphaned belongs to no
    // subscription this client will ever install a handler for.
    if (this.pendingSubscribes === 0) this.orphanEvents.clear();
    for (const event of buffered ?? []) this.deliver(subscriber, id, event);
    let closing: Promise<void> | null = null;
    return {
      subscriptionId: id,
      startGeneration: response.generation,
      liveState: response.live_state,
      close: (): Promise<void> => {
        closing ??= this.unsubscribe(id).catch((error: unknown) => {
          // A close that failed left the subscription open on the daemon, so
          // the next call must try again rather than return that failure.
          closing = null;
          throw error instanceof Error ? error : new Error(String(error));
        });
        return closing;
      },
    };
  }

  /** How many subscriptions still hold a handler on this client. */
  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * The frame router for one event envelope.
   *
   * `onEvent` sees every event, subscribed or not — it is the connection's own
   * observer, and it is called last so a subscriber's throw cannot rob it of
   * the frame. A throw out of `onEvent` itself keeps the behaviour it has
   * always had: reported to `onHandlerError`, or fatal when nobody claims it.
   */
  private route(frame: EventEnvelope): void {
    const subscriber = this.subscriptions.get(frame.subscription_id);
    if (subscriber) {
      this.deliver(subscriber, frame.subscription_id, frame.event);
    } else if (this.pendingSubscribes > 0 && !this.closedSubscriptions.has(frame.subscription_id)) {
      this.buffer(frame.subscription_id, frame.event);
    }
    this.options.onEvent(frame);
  }

  /** Hold one event for a subscription whose handler is not installed yet. */
  private buffer(subscriptionId: string, event: RuntimeEventDto): void {
    const queued = this.orphanEvents.get(subscriptionId) ?? [];
    if (queued.length >= VaultdClient.ORPHAN_LIMIT) {
      // Drop the oldest and say so. `current_generation` is null because this
      // marker is the client's, not the daemon's: nothing here knows which
      // generation the dropped events named, and inventing one would be worse
      // than admitting it. The daemon's own `subscriber_lag` always names one.
      queued.shift();
      queued[0] = {
        type: "resync_required",
        value: { current_generation: null, reason: "subscriber_lag" },
      };
    }
    queued.push(event);
    this.orphanEvents.set(subscriptionId, queued);
  }

  /** Call one subscriber, and keep its throw off the transport. */
  private deliver(subscriber: Subscriber, subscriptionId: string, event: RuntimeEventDto): void {
    try {
      subscriber.handler(event);
    } catch (thrown) {
      const error = asError(thrown);
      // Called through the object, never lifted into a local: detaching an
      // interface method is how a consumer's `this` quietly goes missing.
      if (subscriber.onError) {
        subscriber.onError(error, event);
      } else if (this.options.onHandlerError) {
        this.options.onHandlerError(error, {
          version: PROTOCOL_VERSION,
          subscription_id: subscriptionId,
          event,
        });
      }
    }
  }

  /**
   * End one subscription.
   *
   * The handler is removed only **after** the `unsubscribe` response resolves,
   * and that is load-bearing: the daemon flushes the subscription's queue
   * before answering, so an event arriving during the round trip is still this
   * subscription's and must be delivered. Nothing bearing that id follows the
   * response.
   */
  private async unsubscribe(id: string): Promise<void> {
    await this.request("unsubscribe", { subscription_id: id });
    this.subscriptions.delete(id);
    this.orphanEvents.delete(id);
    // Ids are never reused within a daemon process, but a client may outlive
    // one. Remembering the close is what stops a late event from being
    // buffered as an orphan and replayed to a future subscription.
    this.closedSubscriptions.add(id);
  }

  /** The transport is gone: no handler can be called again, so hold none. */
  private dropSubscriptions(): void {
    this.subscriptions.clear();
    this.orphanEvents.clear();
  }

  private consume(rawChunk: unknown): void {
    // A `NodeJS.ReadableStream` hands its `data` listener `any`, and a stream
    // someone called `setEncoding` on hands it a string. Normalizing here is
    // what keeps `Buffer.concat` from throwing inside a listener, where a throw
    // is an uncaught exception rather than a returned error.
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(typeof rawChunk === "string" ? rawChunk : String(rawChunk), "utf8");
    const { frames, malformed, error } = this.framer.push(chunk);
    // Settle every frame that arrived intact BEFORE reporting any failure. A
    // response and a bad line can share one chunk, and the response's caller is
    // entitled to its answer even though the connection may be about to die.
    // A consumer callback that throws must not strand the frames behind it
    // either, so each dispatch is isolated and the throw is reported after the
    // loop.
    let handlerFailure: { error: Error; envelope: EventEnvelope } | null = null;
    for (const frame of frames) {
      // Dispatch on the EVENT shape, not on `"id" in frame`. An event envelope
      // that carries a top-level `id` tail field — which the boundary decoder
      // accepts, because tail fields are a widening — used to be routed to
      // `settle`, where it named no pending request and was dropped in silence.
      if (!("event" in frame)) {
        this.settle(frame);
        continue;
      }
      try {
        this.route(frame);
      } catch (thrown) {
        handlerFailure ??= { error: asError(thrown), envelope: frame };
      }
    }
    for (const bad of malformed) this.reportMalformed(bad);
    if (handlerFailure) this.reportHandlerFailure(handlerFailure.error, handlerFailure.envelope);
    if (error) this.die(error);
  }

  /**
   * A line that was JSON but not an envelope.
   *
   * When it named a pending request, that request is told — a caller waiting on
   * an answer the daemon has already spent is strictly worse off hanging than
   * failing. The connection survives: the framer kept its place, so there is
   * nothing to tear down. A line that named no pending request cannot be
   * attributed to anybody, and something writing unrecognizable lines to this
   * stdout is a transport failure the supervisor above needs to hear about.
   */
  private reportMalformed(bad: MalformedEnvelopeError): void {
    if (bad.id !== null) {
      const deferred = this.pending.get(bad.id);
      if (deferred) {
        this.pending.delete(bad.id);
        deferred.reject(bad);
        return;
      }
    }
    this.die(bad);
  }

  private reportHandlerFailure(error: Error, envelope: EventEnvelope): void {
    // Called through `this.options` rather than lifted into a local: these are
    // interface methods, and detaching one from its object is how a consumer's
    // `this` quietly goes missing.
    if (this.options.onHandlerError) {
      this.options.onHandlerError(error, envelope);
      return;
    }
    this.die(error);
  }

  private settle(frame: ResponseEnvelope): void {
    const deferred = this.pending.get(frame.id);
    // A response to an id nobody is waiting on is dropped, not fatal: it is
    // what a late answer to a request `close()` already failed looks like.
    if (!deferred) return;
    this.pending.delete(frame.id);
    if (frame.outcome.status === "ok") deferred.resolve(frame.outcome.value.value);
    else deferred.reject(new VaultdError(frame.outcome.value));
  }

  /**
   * The transport is finished. Reported exactly once — a stream that ends and
   * then errors, or errors twice, must not deliver two fatalities to a
   * supervisor whose job is to decide whether to restart the daemon.
   */
  private die(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(error);
    this.dropSubscriptions();
    this.options.onFatal(error);
  }
}
