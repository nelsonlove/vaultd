/**
 * The wedged-thread watchdog: the one component that reports a failure the
 * thread it is watching could never report itself.
 *
 * ## The mechanism is named because the obvious one cannot work
 *
 * A wedged main thread cannot answer a `postMessage`, so a `postMessage`
 * ping-pong structurally cannot catch the only failure this component exists
 * for. Instead the main loop stamps a `SharedArrayBuffer` with
 * `Atomics.store` every `stampIntervalMs`; a `worker_threads` worker wakes on
 * its own `Atomics.wait` timer, reads the stamp with `Atomics.load`, and when
 * the gap exceeds `thresholdMs` writes a report **from the worker thread**,
 * whose I/O never touches the wedged loop.
 *
 * The direction is what makes this different from the ping-pong the design
 * ruled out: the **worker** posts, because the worker is the healthy thread.
 * The main side answers nothing.
 *
 * **Report-only.** Nothing is interrupted, nothing is killed, no signal is
 * raised. A stall produces one JSON line in a file inside the host data
 * directory — never the vault — and one message the main side collects if it is
 * alive to hear it.
 *
 * ## The clock split, and why it is not a contradiction
 *
 * The Global Constraints ban bare timers and require `config.clock`; this
 * component is the named exception, and the exception is precisely one timer.
 *
 * - **Main side:** the heartbeat is `clock.setInterval(() => this.stamp(), …)`
 *   — injected, so a test drives it with `TestClock.advance`, and the stamped
 *   value comes from `clock.now()`.
 * - **Worker side:** one real `Atomics.wait` loop, in `watchdog-worker.js`,
 *   because a watchdog driven by the clock it is watching detects nothing — if
 *   the main thread is wedged, so is any timer the main thread must service.
 *
 * ## What the buffer holds
 *
 * Two **64-bit** slots, as a `BigInt64Array`. Slot {@link STAMP} is
 * milliseconds of the main side's clock since {@link Watchdog.start}; slot
 * {@link STOP} is the flag that lets the worker leave its wait and end. Nothing
 * else crosses: the report is built on the worker side from the stamp and the
 * worker's own wall clock.
 *
 * **Sixty-four bits rather than thirty-two, because the stamp is elapsed time
 * and a daemon runs for months.** `Atomics.store` on an `Int32Array` applies
 * `ToInt32`, so an elapsed-milliseconds stamp wraps negative at `2^31-1` ms —
 * **24.855 days** — and every poll after that computes a stall of about
 * 4.29e9 ms. Worse, the worker's one-report-per-stall latch re-arms on every
 * fresh stamp, so the wrap does not produce one wrong line: it produces one per
 * stamp, for ever, into the report file. A watchdog that screams continuously
 * about a host that is fine is worse than no watchdog, because the next real
 * stall is one line in a million. `BigInt64Array` removes the ceiling outright
 * (292 million years), and `Atomics.wait` works on it, so the wait loop is
 * unchanged. `test/watchdog.test.ts` pins it with a month of simulated uptime.
 *
 * ## Who stamps
 *
 * The heartbeat, and the {@link DispatchQueue} between tasks — through a hook
 * the assembler hands the queue, never an import of this module into it. Both,
 * because either alone is wrong: a host saturated with plugin work services no
 * interval, so the busiest healthy host in the fleet would be the one reporting
 * itself wedged; and a host with an idle queue stamps from nowhere else.
 */

import { Worker } from "node:worker_threads";
import { join } from "node:path";

import type { Clock, HostConfig } from "../config";

/** One stall, as the worker saw it. */
export interface WatchdogReport {
  readonly stalledForMs: number;
  readonly lastStampUnixMs: number;
  readonly detectedAtUnixMs: number;
}

export interface WatchdogOptions {
  readonly thresholdMs: number;
  readonly stampIntervalMs: number;
  readonly reportPath: string;
  /** The injected clock. Drives the MAIN-side heartbeat only. */
  readonly clock: Clock;
  /**
   * How long the worker's `Atomics.wait` blocks between looks, in real
   * milliseconds — the one real timer in this plan.
   *
   * Derived from the threshold when it is not given, because the only thing it
   * trades is detection latency against wakes: a stall is noticed at most one
   * poll after the threshold. See {@link pollFor}.
   */
  readonly pollMs?: number;
  /**
   * How large the report file may grow before the worker rotates it.
   *
   * One generation, kept as `<reportPath>.1`: a stall log is read after the
   * fact and the interesting lines are the recent ones, so an unbounded file is
   * a slow leak and a deep archive of it is nobody's question. Default
   * {@link REPORT_ROTATE_BYTES}. `0` keeps the file unbounded, which nothing in
   * this host asks for.
   */
  readonly rotateBytes?: number;
  /**
   * Behave as though this watchdog started `simulatedUptimeMs` ago. **Tests
   * only.**
   *
   * Both sides take it: the main side's epoch moves back by it, so the first
   * stamp is already that far along, and the worker adds it to its own elapsed
   * time. That symmetry is what makes it a *simulation of uptime* rather than a
   * simulated stall — and it is the only way to reach the `2^31` ms boundary in
   * a test without waiting twenty-five days for it.
   */
  readonly simulatedUptimeMs?: number;
}

/** Milliseconds of the main side's clock since {@link Watchdog.start}. */
const STAMP = 0;
/** Non-zero once {@link Watchdog.stop} has asked the worker to finish. */
const STOP = 1;

/**
 * Where the worker file is, from `src/runtime/` and from `dist/runtime/` alike.
 *
 * **The package compiles `src/` only** (`tsconfig.json` `include: ["src"]`,
 * `tsc --build`), so a plain `.js` worker under `src/` would never reach
 * `dist/` and a host started from `dist/` would spawn a worker that is not
 * there. It lives outside both instead, at `host/packages/host/worker/`, which
 * is the same two levels up from either directory — so this one expression
 * answers for both builds. `test/watchdog.test.ts` asserts that from the
 * compiled module as well as from the source, because "the same depth" is the
 * kind of claim that stays true only while somebody is checking.
 */
export function watchdogWorkerPath(): string {
  return join(__dirname, "..", "..", "worker", "watchdog-worker.js");
}

/**
 * How long the worker blocks between looks, for a given threshold.
 *
 * A quarter of the threshold, clamped: fine enough that detection latency is a
 * fraction of the stall rather than a multiple of it, coarse enough that a
 * 30-second production threshold does not wake a thread four times a second for
 * a host that is perfectly well.
 */
function pollFor(thresholdMs: number): number {
  return Math.max(5, Math.min(250, Math.floor(thresholdMs / 4)));
}

export class Watchdog {
  /** Two 64-bit slots: see {@link STAMP} and {@link STOP}. */
  private readonly buffer = new SharedArrayBuffer(16);
  private readonly view = new BigInt64Array(this.buffer);
  private worker: Worker | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** The value of `clock.now()` the stamps are measured from. */
  private epoch = 0;
  private readonly collected: WatchdogReport[] = [];
  private readonly waiters: Array<{
    readonly count: number;
    readonly resolve: (reports: readonly WatchdogReport[]) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  /** Resolves when the worker thread has exited. See {@link stop}. */
  private exit: Promise<void> = Promise.resolve();
  private exitedValue = true;

  constructor(private readonly options: WatchdogOptions) {}

  /**
   * Spawn the worker and arm the heartbeat. Idempotent.
   *
   * The first stamp lands here rather than one interval later, so the buffer
   * never holds a stamp the main side has not actually made.
   */
  start(): void {
    if (this.worker !== null) return;
    // Normally zero. A test that wants a host which has been up for a month
    // moves the epoch back and starts the stamp there, and hands the worker the
    // same number — see {@link WatchdogOptions.simulatedUptimeMs}.
    const uptimeMs = Math.max(0, Math.round(this.options.simulatedUptimeMs ?? 0));
    this.epoch = this.options.clock.now() - uptimeMs;
    Atomics.store(this.view, STAMP, BigInt(uptimeMs));
    Atomics.store(this.view, STOP, 0n);
    const worker = new Worker(watchdogWorkerPath(), {
      workerData: {
        buffer: this.buffer,
        thresholdMs: this.options.thresholdMs,
        pollMs: this.options.pollMs ?? pollFor(this.options.thresholdMs),
        reportPath: this.options.reportPath,
        rotateBytes: this.options.rotateBytes ?? REPORT_ROTATE_BYTES,
        uptimeMs,
      },
    });
    worker.on("message", (report: WatchdogReport) => {
      this.collected.push(report);
      this.release();
    });
    worker.on("error", (error: Error) => {
      // A worker that could not start — a missing file, an unwritable report
      // directory — must fail whoever is waiting on it rather than leaving them
      // waiting for a thread that is gone.
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
    this.exitedValue = false;
    this.exit = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        this.exitedValue = true;
        resolve();
      });
    });
    // **Never the reason the process stays alive.** A watchdog is a thing the
    // host has, not a thing that keeps the host running.
    worker.unref();
    this.worker = worker;
    this.resumeHeartbeat();
  }

  /**
   * Stamp the shared buffer.
   *
   * Called by the heartbeat and by the dispatch queue between tasks, so a
   * busy-but-healthy loop still stamps. The value is *elapsed milliseconds of
   * the injected clock*, not a wall-clock time: the worker measures elapsed
   * real time against it, which is what lets a `TestClock` drive one side of a
   * comparison whose other side is the real world.
   */
  stamp(): void {
    // **A stamp before `start()` is a no-op.** The assembler wires the queue's
    // `afterTask` hook when it builds the watchdog, and starting it is a later
    // call — so between the two every task boundary would otherwise pay an
    // `Atomics.store` and a notify to write a number measured from an epoch of
    // zero into a slot no thread is reading.
    if (this.worker === null) return;
    const elapsed = this.options.clock.now() - this.epoch;
    Atomics.store(this.view, STAMP, BigInt(Math.max(0, Math.round(elapsed))));
    // Wakes the worker out of its wait at once, so a stamp re-arms the report
    // without waiting out a poll.
    Atomics.notify(this.view, STAMP);
  }

  /**
   * Stop stamping without stopping the worker — a host-only seam.
   *
   * The only honest way to simulate "the main thread is wedged" while the test
   * itself is still running: a suspended heartbeat is, from the worker's side
   * of the buffer, indistinguishable from a loop that cannot service it.
   */
  suspendHeartbeat(): void {
    if (this.heartbeat === null) return;
    this.options.clock.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Stamp once and arm the heartbeat again. The other half of the seam. */
  resumeHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.stamp();
    const handle = this.options.clock.setInterval(() => {
      this.stamp();
    }, this.options.stampIntervalMs);
    // A `TestClock` hands back a plain token with no `unref`; the system clock
    // hands back a real timer, and a watchdog heartbeat must never be what
    // holds a process open.
    if (typeof handle.unref === "function") handle.unref();
    this.heartbeat = handle;
  }

  /**
   * Test seam: resolve when the worker has produced at least `n` reports.
   *
   * **It can only resolve while something else keeps the loop alive.** The
   * worker is `unref()`ed by design, so a process whose *only* pending work is
   * this promise exits quietly rather than resolving or rejecting it. A host
   * serving a socket and a test runner both hold the loop open; a bare probe
   * script has to hold it itself.
   */
  awaitReports(n: number): Promise<readonly WatchdogReport[]> {
    if (this.collected.length >= n) return Promise.resolve([...this.collected]);
    return new Promise<readonly WatchdogReport[]>((resolve, reject) => {
      this.waiters.push({ count: n, resolve, reject });
    });
  }

  /** Every stall the worker has reported to this side, in order. */
  reports(): readonly WatchdogReport[] {
    return [...this.collected];
  }

  /** Has the worker thread exited? True before {@link start} and after {@link stop}. */
  exited(): boolean {
    return this.exitedValue;
  }

  /**
   * Disarm the heartbeat, end the worker, and wait for its thread to go.
   *
   * The stop flag and the notify come first so the worker leaves its
   * `Atomics.wait` and ends on its own terms — closing its port, having written
   * whatever it had. `terminate()` behind it is the guarantee rather than the
   * mechanism, and the awaited `exit` is what makes "no thread outlives this"
   * something a caller can assert rather than hope.
   */
  async stop(): Promise<void> {
    this.suspendHeartbeat();
    const worker = this.worker;
    if (worker === null) return;
    this.worker = null;
    Atomics.store(this.view, STOP, 1n);
    Atomics.notify(this.view, STAMP);
    await worker.terminate();
    await this.exit;
  }

  private release(): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter === undefined || this.collected.length < waiter.count) continue;
      this.waiters.splice(i, 1);
      waiter.resolve([...this.collected]);
    }
  }
}

/**
 * The watchdog this configuration asks for, or `null` for none.
 *
 * **Built rather than started.** The assembler builds one; starting it is the
 * host lifecycle's call — a factory that spawned a thread would spawn one in
 * every harness that merely assembled a host.
 *
 * `watchdogThresholdMs` of `0` disables it, which is what every harness runs
 * with: a suite that spawned a worker thread per assembled host would pay for a
 * component none of its cases are about, and `test/watchdog.test.ts` builds its
 * own directly.
 *
 * The report file goes in the host's own data directory, never the vault. The
 * stamp interval is derived rather than configured, because the only thing it
 * decides is how fine the evidence is: a tenth of the threshold gives a wedge
 * ten stamps of resolution, and the clamp keeps a small threshold from arming a
 * timer that fires more often than anything it is watching.
 */
export function watchdogFor(config: HostConfig, dataDir: string): Watchdog | null {
  if (config.watchdogThresholdMs <= 0) return null;
  return new Watchdog({
    thresholdMs: config.watchdogThresholdMs,
    stampIntervalMs: Math.max(50, Math.min(5_000, Math.floor(config.watchdogThresholdMs / 10))),
    reportPath: join(dataDir, WATCHDOG_REPORT_FILE),
    clock: config.clock,
  });
}

/** One JSON object per line, appended: a log a human reads after the fact. */
export const WATCHDOG_REPORT_FILE = "stalls.jsonl";

/**
 * How large `stalls.jsonl` may grow before the worker rotates it.
 *
 * One megabyte is roughly ten thousand stall lines — far more than a host worth
 * diagnosing produces, and small enough that the file is never the reason a
 * data directory grows. One generation is kept (`stalls.jsonl.1`); the
 * generation before that is gone, because a stall log is read after the fact
 * and the recent lines are the ones that answer the question.
 */
export const REPORT_ROTATE_BYTES = 1024 * 1024;
