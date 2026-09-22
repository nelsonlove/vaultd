import type { Clock } from "../src/config";

interface Entry {
  readonly fn: () => void;
  due: number;
  readonly intervalMs: number | null;
}

/**
 * A {@link Clock} that only moves when a test says so.
 *
 * **Task 6b ships the real `TestClock` and this file is replaced by it.** It
 * exists now because Task 4 is the first component whose behaviour is timing —
 * the restart ladder — and a backoff test driven by the real clock is a test
 * that sleeps. The Global Constraint is rendezvous over sleeps, so the waiting
 * happens on {@link armed}, which resolves when the code under test has armed
 * the timer, and only then is the clock advanced.
 *
 * The handles are **real, already-cleared** `setTimeout` tokens. `NodeJS.Timeout`
 * is a class with a private shape, and minting a fake one means casting through
 * `any`, which this tree bans; a real token that will never fire costs nothing
 * and keeps the `Clock` signature honest.
 */
export class FakeClock implements Clock {
  private current = 0;
  private readonly entries = new Map<NodeJS.Timeout, Entry>();
  private readonly waits: number[] = [];
  private readonly waiters: Array<{ count: number; resolve(): void }> = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): NodeJS.Timeout {
    return this.arm(fn, ms, null);
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    this.entries.delete(handle);
  }

  setInterval(fn: () => void, ms: number): NodeJS.Timeout {
    return this.arm(fn, ms, ms);
  }

  clearInterval(handle: NodeJS.Timeout): void {
    this.entries.delete(handle);
  }

  /** Every duration this clock has been asked to wait, in arming order. */
  armedWaits(): readonly number[] {
    return [...this.waits];
  }

  /** How many timers are still pending. */
  pending(): number {
    return this.entries.size;
  }

  /**
   * Resolve once `count` timers have been armed on this clock, past or future.
   * The rendezvous that replaces "sleep a bit, then advance and hope".
   */
  armed(count: number): Promise<void> {
    if (this.waits.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
    });
  }

  /**
   * Move time forward and fire everything that comes due, in due order.
   *
   * A callback that arms another timer inside the same advance is honoured if
   * its new deadline also falls inside the window — which is what makes a
   * ladder of restarts drivable by one call when a test wants that.
   */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: [NodeJS.Timeout, Entry] | null = null;
      for (const candidate of this.entries) {
        if (candidate[1].due > target) continue;
        if (next === null || candidate[1].due < next[1].due) next = candidate;
      }
      if (next === null) break;
      const [handle, entry] = next;
      this.current = entry.due;
      if (entry.intervalMs === null) this.entries.delete(handle);
      else entry.due = entry.due + entry.intervalMs;
      entry.fn();
    }
    this.current = target;
  }

  private arm(fn: () => void, ms: number, intervalMs: number | null): NodeJS.Timeout {
    const handle = setTimeout(() => undefined, 0);
    clearTimeout(handle);
    this.entries.set(handle, { fn, due: this.current + ms, intervalMs });
    this.waits.push(ms);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!;
      if (this.waits.length >= waiter.count) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
    return handle;
  }
}
