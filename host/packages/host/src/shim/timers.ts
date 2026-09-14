/**
 * The plugin-facing timer registry: `window.setInterval` as the host serves it,
 * and the table `Component.registerInterval` reads a cadence out of.
 *
 * **Why a registry at all.** Obsidian's `registerInterval(id)` is handed a
 * number and nothing else — no cadence, no owner — so a host that wanted to
 * report "this plugin arms a 200 ms timer forever" has no way to learn the
 * 200 from the call. The cadence is known at exactly one moment, inside
 * `setInterval`, so that is where it is written down. Task 10 records it in the
 * harvest; the idle-cost census is the reason it is worth recording at all.
 *
 * **Why the table is module-level while the arming is not.** `registerInterval`
 * reaches the registry through the id alone — a bare `Component` has no host
 * reference to consult — so the id has to be enough to find the entry. Ids are
 * therefore handed out from one module-wide counter and every live timer is in
 * one module-wide table, while the *arming* goes through a per-assembly
 * {@link ShimTimers} holding that assembly's {@link Clock}. Two hosts in one
 * process share the id space and share nothing else.
 *
 * **Why the clock and not the globals.** Every timer in this host is armed
 * through the injected clock, so a test drives time rather than waiting for it
 * and a leaked interval is a number a test can assert on (`TestClock.armed()`)
 * rather than a process that will not exit. An earlier draft of this phase said
 * plugin-facing timers should use the real globals — that is the one place the
 * "never a bare setInterval" rule would have had an exception, and it was
 * withdrawn: a plugin cannot observe which clock armed its callback, and a host
 * that cannot count its own timers cannot report them.
 */

import type { Clock } from "../config";

/** One armed plugin-facing timer, as the module-wide table holds it. */
interface TimerEntry {
  readonly intervalMs: number;
  readonly repeating: boolean;
  /** Disarms it on the clock that armed it. Idempotent. */
  readonly clear: () => void;
}

/**
 * Ids are module-wide so that {@link clearTimerById} and {@link intervalMsOf}
 * need nothing but the number a plugin held on to.
 */
let nextTimerId = 1;
const liveTimers = new Map<number, TimerEntry>();

/** The cadence `setInterval` was called with, or `null` for an id nobody armed here. */
export function intervalMsOf(id: number): number | null {
  return liveTimers.get(id)?.intervalMs ?? null;
}

/**
 * Disarm a timer by the id a plugin holds.
 *
 * An id this host never handed out is left alone rather than passed to the
 * global `clearInterval`: nothing in the host arms a global timer, so an
 * unknown id can only have come from a bundle that reached around the shim, and
 * guessing at its handle type would be the more dangerous of the two mistakes.
 */
export function clearTimerById(id: number): void {
  const entry = liveTimers.get(id);
  if (entry === undefined) return;
  liveTimers.delete(id);
  entry.clear();
}

/** How many plugin-facing timers are armed right now, across every host. */
export function liveTimerCount(): number {
  return liveTimers.size;
}

/**
 * One host's `window.setTimeout` / `setInterval` pair.
 *
 * Returns **numbers**, because that is what `window.setInterval` returns in a
 * browser and what `registerInterval(id: number)` is declared to take. Node's
 * own `setInterval` returns a `Timeout` object, so handing the real global's
 * return value to a plugin would be handing it a value it may not pass back.
 */
export class ShimTimers {
  constructor(private readonly clock: Clock) {}

  setInterval(callback: () => void, ms: number): number {
    return this.arm(callback, ms, true);
  }

  setTimeout(callback: () => void, ms: number): number {
    return this.arm(callback, ms, false);
  }

  clearInterval(id: number): void {
    clearTimerById(id);
  }

  clearTimeout(id: number): void {
    clearTimerById(id);
  }

  private arm(callback: () => void, ms: number, repeating: boolean): number {
    const id = nextTimerId;
    nextTimerId += 1;
    if (repeating) {
      const handle = this.clock.setInterval(callback, ms);
      liveTimers.set(id, {
        intervalMs: ms,
        repeating,
        clear: () => {
          this.clock.clearInterval(handle);
        },
      });
      return id;
    }
    // A one-shot forgets itself when it fires, or the table would grow by one
    // entry per `setTimeout` for the life of the host.
    const handle = this.clock.setTimeout(() => {
      liveTimers.delete(id);
      callback();
    }, ms);
    liveTimers.set(id, {
      intervalMs: ms,
      repeating,
      clear: () => {
        this.clock.clearTimeout(handle);
      },
    });
    return id;
  }
}
