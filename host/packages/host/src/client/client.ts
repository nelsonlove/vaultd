import { VaultdError } from "./errors";
import { LineFramer, MalformedEnvelopeError } from "./framing";
import { PROTOCOL_VERSION } from "./protocol";
import type { EventEnvelope, RequestEnvelope, ResponseEnvelope } from "./protocol";

export { VaultdError } from "./errors";

interface Deferred {
  resolve(value: unknown): void;
  reject(error: Error): void;
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
  private readonly options: VaultdClientOptions;
  private counter = 0;
  private closed = false;

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
      if ("id" in frame) {
        this.settle(frame);
        continue;
      }
      try {
        this.options.onEvent(frame);
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
    this.options.onFatal(error);
  }
}
