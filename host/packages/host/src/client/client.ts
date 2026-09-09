import { VaultdError } from "./errors";
import { LineFramer } from "./framing";
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
    options.stdout.on("data", (chunk: Buffer) => {
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

  private consume(chunk: Buffer): void {
    const { frames, error } = this.framer.push(chunk);
    // Settle every frame that arrived intact BEFORE reporting the framing
    // failure. A response and a corrupt line can share one chunk, and the
    // response's caller is entitled to its answer even though the connection
    // is about to die.
    for (const frame of frames) {
      if ("id" in frame) this.settle(frame);
      else this.options.onEvent(frame);
    }
    if (error) this.die(error);
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
