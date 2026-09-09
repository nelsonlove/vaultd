import type { EventEnvelope, RequestEnvelope, ResponseEnvelope } from "./protocol";

/** One decoded daemon line: a response to a request, or an unsolicited event. */
export type Frame = ResponseEnvelope | EventEnvelope;

export interface PushResult {
  /** Every frame parsed from this chunk, in order, up to the bad line. */
  readonly frames: readonly Frame[];
  /** The first unparseable line in this chunk, if there was one. */
  readonly error?: FramingError;
}

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
 * The newline-delimited JSON reader for the daemon's stdout.
 *
 * **`push` returns a framing error, it never throws one.** A single chunk can
 * carry several complete lines, and throwing on a bad one would discard every
 * good frame that arrived with it — frames that are responses some `await` is
 * waiting on. A chunk of `{A}\n{garbage}\n{B}\n` must still settle A before
 * the connection dies, or A's caller hangs forever on a daemon that already
 * answered it. So `push` parses forward, stops at the first bad line, and
 * returns `{ frames: [A], error }`. B is discarded along with the rest of the
 * buffer: after a framing error the stream position is no longer trustworthy,
 * and a client that kept parsing would be guessing at where the next line
 * starts. The caller processes `frames` first and only then surfaces `error`.
 */
export class LineFramer {
  // Typed as the default `Buffer<ArrayBufferLike>`: an incoming chunk may be
  // backed by any array buffer, and pinning the field to `Buffer<ArrayBuffer>`
  // (what `Buffer.alloc` infers) would refuse to hold one.
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): PushResult {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
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
      let parsed: Frame;
      try {
        parsed = JSON.parse(line) as Frame;
      } catch (cause) {
        this.buffer = Buffer.alloc(0);
        return { frames, error: new FramingError(line, cause) };
      }
      frames.push(parsed);
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
    return { frames };
  }

  /** Encode one request as the single JSON line the daemon's reader expects. */
  static encode(envelope: RequestEnvelope): Buffer {
    return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  }
}
