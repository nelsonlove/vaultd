import { PassThrough } from "node:stream";

import type { ProtocolErrorBody, RequestEnvelope, RuntimeEventDto } from "../client/protocol";

interface Waiter {
  count: number;
  resolve(envelopes: RequestEnvelope[]): void;
}

/**
 * A daemon made of two `PassThrough` streams, for tests that need request /
 * response correlation without a process.
 *
 * It is a **rendezvous**, not a timer: `received(n)` resolves the moment the
 * client's nth request line has been parsed, so a test never sleeps waiting
 * for a write to land. Every helper that writes to `stdout` writes one whole
 * line, except `writeRaw`, which exists so a test can put several frames — or
 * a deliberately corrupt one — into a single chunk.
 *
 * It lives under `src/testing/` rather than `test/` because Task 3's
 * subscription tests need it too, and because `src/index.ts` deliberately
 * exports nothing from this directory.
 */
export class FakeDaemon {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  private readonly sent: RequestEnvelope[] = [];
  private readonly lines: string[] = [];
  private readonly waiters: Waiter[] = [];

  constructor() {
    let pending = "";
    this.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim().length) {
          this.lines.push(line);
          this.sent.push(JSON.parse(line) as RequestEnvelope);
        }
        newline = pending.indexOf("\n");
      }
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]!;
        if (this.sent.length >= waiter.count) {
          this.waiters.splice(i, 1);
          waiter.resolve(this.sent.slice(0, waiter.count));
        }
      }
    });
  }

  /** Resolve once `count` request lines have arrived, decoded, in order. */
  received(count: number): Promise<RequestEnvelope[]> {
    if (this.sent.length >= count) return Promise.resolve(this.sent.slice(0, count));
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
    });
  }

  /** The exact request lines the client wrote, undecoded, for byte assertions. */
  rawLines(): readonly string[] {
    return [...this.lines];
  }

  respondOk(id: string, type: string, value: unknown): void {
    this.write({ version: 1, id, outcome: { status: "ok", value: { type, value } } });
  }

  respondErr(id: string, body: ProtocolErrorBody): void {
    this.write({ version: 1, id, outcome: { status: "err", value: body } });
  }

  emit(subscriptionId: string, event: RuntimeEventDto): void {
    this.write({ version: 1, subscription_id: subscriptionId, event });
  }

  endStdout(): void {
    this.stdout.end();
  }

  /**
   * Write bytes to stdout verbatim, so a test can put several frames — or a
   * deliberately corrupt line — into one chunk.
   */
  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  private write(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}
