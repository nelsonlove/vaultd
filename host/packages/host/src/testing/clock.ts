/**
 * The injectable clock a test drives by hand.
 *
 * Every component whose behaviour depends on time takes it from
 * {@link HostConfig.clock}, never from the globals — the Global Constraint of
 * this phase — and the reason is exactly this file: a host whose timers come
 * from the globals can only be tested by waiting, and a suite that waits is a
 * suite that is slow when it passes and flaky when it does not.
 *
 * This is Task 6b's `clock.ts`, built here because Task 6's mirror harness is
 * its first consumer. Task 6b finds it present rather than writing it twice.
 */

import type { Clock } from "../config";

export interface TestClock extends Clock {
  /** Run every timer due within `ms`, in due order, advancing `now()` as it goes. */
  advance(ms: number): Promise<void>;
  /** Flush the microtask queue without moving time. */
  tick(): Promise<void>;
  /** How many timers are armed right now — used to assert nothing leaked. */
  armed(): number;
  setNow(unixMs: number): void;
}

export function testClock(startUnixMs = 1_700_000_000_000): TestClock {
  let now = startUnixMs;
  let sequence = 0;
  interface Armed {
    id: number;
    due: number;
    every: number | null;
    fn: () => void;
  }
  const armed = new Map<number, Armed>();
  const handleOf = (id: number): NodeJS.Timeout => ({ id }) as unknown as NodeJS.Timeout;
  const idOf = (handle: NodeJS.Timeout): number => (handle as unknown as { id: number }).id;

  const arm = (fn: () => void, ms: number, every: number | null): NodeJS.Timeout => {
    const id = (sequence += 1);
    armed.set(id, { id, due: now + Math.max(0, ms), every, fn });
    return handleOf(id);
  };

  return {
    now: () => now,
    setNow(unixMs: number) {
      now = unixMs;
    },
    setTimeout: (fn, ms) => arm(fn, ms, null),
    clearTimeout(handle) {
      armed.delete(idOf(handle));
    },
    setInterval: (fn, ms) => arm(fn, ms, Math.max(1, ms)),
    clearInterval(handle) {
      armed.delete(idOf(handle));
    },
    armed: () => armed.size,
    async tick() {
      await Promise.resolve();
      await Promise.resolve();
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...armed.values()]
          .filter((entry) => entry.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        now = next.due;
        if (next.every === null) armed.delete(next.id);
        else next.due = now + next.every;
        next.fn();
        // Let anything the callback awaited settle before the next timer, so
        // ordering is causal rather than merely numeric.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}
