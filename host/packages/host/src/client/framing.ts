import type { EventEnvelope, RequestEnvelope, ResponseEnvelope } from "./protocol";

/** One decoded daemon line: a response to a request, or an unsolicited event. */
export type Frame = ResponseEnvelope | EventEnvelope;

export interface PushResult {
  /** Every frame parsed from this chunk, in order, up to the bad line. */
  readonly frames: readonly Frame[];
  /**
   * Lines that were valid JSON but not well-formed envelopes, in order. Not
   * fatal on their own: see {@link MalformedEnvelopeError}.
   */
  readonly malformed: readonly MalformedEnvelopeError[];
  /** The first unparseable line in this chunk, if there was one. */
  readonly error?: FramingError;
}

/** A line that is not valid JSON. The stream position is no longer trustworthy. */
export class FramingError extends Error {
  readonly line: string;

  constructor(line: string, cause: unknown) {
    super(`unparseable daemon line: ${line.slice(0, 200)}`);
    this.name = "FramingError";
    this.line = line;
    this.cause = cause;
  }
}

/**
 * A line that parsed as JSON but is not an envelope this protocol defines.
 *
 * Distinct from {@link FramingError} because the consequences are different in
 * both directions. The stream is still byte-aligned — every newline was where
 * it should be — so the framer reads on rather than discarding the buffer. But
 * the line itself is unusable, and if it named a request id then some caller is
 * waiting on it: that caller is told, by rejection, rather than left pending
 * forever on an answer that will never come again.
 *
 * `id` is the id the line claimed, when it claimed one as a string. A line that
 * claims none cannot be attributed to any caller, and the client treats it as a
 * transport failure instead.
 */
export class MalformedEnvelopeError extends Error {
  readonly line: string;
  readonly id: string | null;

  constructor(line: string, id: string | null, detail: string) {
    super(`malformed daemon envelope (${detail}): ${line.slice(0, 200)}`);
    this.name = "MalformedEnvelopeError";
    this.line = line;
    this.id = id;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one question that tells the two envelope shapes apart, asked of a JSON
 * object: is `subscription_id` a string **and** `event` an object?
 *
 * It is a **pair** test, and both halves matter, because either key alone can
 * appear on the other shape as a tail field a later daemon added. Asking about
 * `id` alone routed an event with an `id` tail to the response branch, where it
 * was refused and killed the connection; asking about `event` alone routed a
 * response with an `event` tail to the event branch, where it matched no
 * subscription and left its caller pending forever. Both bugs were the same
 * bug, and this function exists so the decoder and the frame router cannot ask
 * the question two different ways again.
 */
function looksLikeEvent(value: Record<string, unknown>): boolean {
  return typeof value.subscription_id === "string" && isRecord(value.event);
}

/** {@link looksLikeEvent}, for a frame that has already been validated. */
export function isEventFrame(frame: Frame): frame is EventEnvelope {
  return looksLikeEvent(frame as unknown as Record<string, unknown>);
}

/**
 * Validate one parsed line against the two envelope shapes, and nothing more.
 *
 * **This is a boundary decoder, not a schema validator.** It checks exactly
 * what the frame router is about to dereference — the envelope's own fields,
 * the outcome's tag, and the error body's fields, which `VaultdError` lifts
 * onto a class — and it deliberately does not look inside a success payload or
 * an event's `value`. Those stay the unchecked `T` of `request<T>`: a
 * mis-shaped payload surfaces as an undefined field in a caller that can say
 * what it expected, while a mis-shaped *envelope* used to surface as an
 * uncaught `TypeError` inside a stream listener, which killed the host and
 * stranded every other in-flight request.
 *
 * Unknown-variant tolerance holds throughout: an unknown error `code`, an
 * unknown event `type`, and an unrecognized tail field are all accepted. This
 * function rejects shapes that are *missing* or *mistyped*, never shapes that
 * are merely newer.
 *
 * @returns the frame, or a string naming what is wrong with it.
 */
function validateEnvelope(parsed: unknown): Frame | string {
  if (!isRecord(parsed)) return "not a JSON object";
  if (typeof parsed.version !== "number") return "no numeric version";

  // The event shape is tested FIRST, and as a pair — see {@link looksLikeEvent}
  // for why a one-key test is wrong in both directions. An envelope with both
  // `subscription_id` and an `event` object is an event, whatever else it
  // carries; a response is what is left.
  if (!looksLikeEvent(parsed) && ("id" in parsed || "outcome" in parsed)) {
    if (typeof parsed.id !== "string") return "response envelope with no string id";
    const outcome = parsed.outcome;
    if (!isRecord(outcome)) return "response envelope with no outcome object";
    if (outcome.status === "ok") {
      const payload = outcome.value;
      if (!isRecord(payload)) return "ok outcome with no payload object";
      if (typeof payload.type !== "string") return "ok payload with no string type";
      if (!("value" in payload)) return "ok payload with no value";
      return parsed as unknown as ResponseEnvelope;
    }
    if (outcome.status === "err") {
      const body = outcome.value;
      if (!isRecord(body)) return "err outcome with no error body";
      if (typeof body.code !== "string") return "error body with no string code";
      if (typeof body.message !== "string") return "error body with no string message";
      // The four tails are optional, and each is checked only when present:
      // absent is the common case, and a wrong type here would reach a caller
      // as a plausible-looking number or string on `VaultdError`.
      if ("supported_version" in body && typeof body.supported_version !== "number") {
        return "error body with a non-numeric supported_version";
      }
      if ("current_generation" in body && typeof body.current_generation !== "number") {
        return "error body with a non-numeric current_generation";
      }
      if ("current_revision" in body && typeof body.current_revision !== "string") {
        return "error body with a non-string current_revision";
      }
      if ("position" in body && typeof body.position !== "number") {
        return "error body with a non-numeric position";
      }
      return parsed as unknown as ResponseEnvelope;
    }
    return "outcome with an unrecognized status";
  }

  if (typeof parsed.subscription_id !== "string") {
    return "neither a response (no id) nor an event (no subscription_id)";
  }
  const event = parsed.event;
  if (!isRecord(event)) return "event envelope with no event object";
  if (typeof event.type !== "string") return "event with no string type";
  return parsed as unknown as EventEnvelope;
}

const NOTHING_MALFORMED: readonly MalformedEnvelopeError[] = Object.freeze([]);

/**
 * The newline-delimited JSON reader for the daemon's stdout.
 *
 * **`push` returns its failures, it never throws one.** A single chunk can
 * carry several complete lines, and throwing on a bad one would discard every
 * good frame that arrived with it — frames that are responses some `await` is
 * waiting on. A chunk of `{A}\n{garbage}\n{B}\n` must still settle A before
 * the connection dies, or A's caller hangs forever on a daemon that already
 * answered it. So `push` parses forward and returns what it found.
 *
 * The two failure channels differ in exactly one way, and it is the stream
 * position. A line that is not JSON (`error`) leaves the framer unable to say
 * where the next line begins, so the rest of the buffer is discarded and
 * parsing stops. A line that is JSON but not an envelope (`malformed`) leaves
 * every newline exactly where it was, so parsing continues and the bad line is
 * reported alongside the good ones.
 */
export class LineFramer {
  // Typed as the default `Buffer<ArrayBufferLike>`: an incoming chunk may be
  // backed by any array buffer, and pinning the field to `Buffer<ArrayBuffer>`
  // (what `Buffer.alloc` infers) would refuse to hold one.
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): PushResult {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    let malformed: MalformedEnvelopeError[] | null = null;
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      // Slice on the newline *byte* before decoding: a UTF-8 sequence split
      // across two chunks stays in the buffer as bytes and is never turned
      // into a replacement character by a premature `toString`.
      const line = this.buffer.toString("utf8", start, newline);
      start = newline + 1;
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        this.buffer = Buffer.alloc(0);
        return {
          frames,
          malformed: malformed ?? NOTHING_MALFORMED,
          error: new FramingError(line, cause),
        };
      }
      const validated = validateEnvelope(parsed);
      if (typeof validated === "string") {
        const id =
          isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : null;
        malformed ??= [];
        malformed.push(new MalformedEnvelopeError(line, id, validated));
        continue;
      }
      frames.push(validated);
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
    return { frames, malformed: malformed ?? NOTHING_MALFORMED };
  }

  /** Encode one request as the single JSON line the daemon's reader expects. */
  static encode(envelope: RequestEnvelope): Buffer {
    return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  }
}
