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

import { currentPluginId } from "./policy";
import type { Clock } from "../config";

/** One armed plugin-facing timer, as the module-wide table holds it. */
interface TimerEntry {
  readonly intervalMs: number;
  readonly repeating: boolean;
  /**
   * Whose timer it is, taken from the attribution window at arm time, or `null`
   * for one the host armed for itself.
   *
   * Recorded so that {@link clearTimersOwnedBy} can find a timer a bundle armed
   * with a **bare** `setInterval` and never handed to `registerInterval`. The
   * registered ones are disarmed by `Component.unload`; these are the rest, and
   * without an owner there is no way to tell them from the host's own.
   */
  readonly pluginId: string | null;
  /** Disarms it on the clock that armed it. Idempotent. */
  readonly clear: () => void;
}

/**
 * Ids are module-wide so that {@link clearTimerById} and {@link intervalMsOf}
 * need nothing but the number a plugin held on to.
 */
let nextTimerId = 1;
/**
 * Entries leave on a clear and when a one-shot fires, so a host that unloads
 * its plugins leaves nothing behind. A host torn down *without* unloading them
 * leaks one entry per armed interval for the life of the process — bounded by
 * the number of timers that host's plugins armed, and only reachable by a
 * caller that skipped the teardown it owns.
 */
const liveTimers = new Map<number, TimerEntry>();

/** The cadence `setInterval` was called with, or `null` for an id nobody armed here. */
export function intervalMsOf(id: number): number | null {
  return liveTimers.get(id)?.intervalMs ?? null;
}

/**
 * Disarm a timer by the id a plugin holds.
 *
 * An id this table never handed out is still cleared, through `fallback` — the
 * component's injected clock — because such an id can only have come from a
 * bundle that reached around the shim for its timer, and a timer that goes on
 * firing after its plugin has been unloaded is the exact idle cost this module
 * exists to make visible. `Clock.clearInterval` takes the handle Node's own
 * `setInterval` returns, which is what a bundle doing that would be holding;
 * a handle from some third source is simply not found, and clearing it is a
 * no-op rather than a throw.
 *
 * **Only observable under `systemClock`.** The fallback really disarms a Node
 * interval, and that is the case it exists for — production. A `TestClock`
 * cannot resolve a handle Node armed, so no in-process test can watch a real
 * one stop; the committed case pins the reachable half instead, a timer armed
 * on the harness's own clock and passed to `registerInterval` as if it had come
 * from elsewhere. Second limit, implied by the same mechanism: a browser-style
 * numeric id from some third source resolves to nothing and stays a no-op.
 */
export function clearTimerById(id: number, fallback: Clock | null = null): void {
  const entry = liveTimers.get(id);
  if (entry === undefined) {
    fallback?.clearInterval(id as unknown as NodeJS.Timeout);
    return;
  }
  liveTimers.delete(id);
  entry.clear();
}

/** How many plugin-facing timers are armed right now, across every host. */
export function liveTimerCount(): number {
  return liveTimers.size;
}

/**
 * Disarm every timer `pluginId` armed that is still armed, and say how many.
 *
 * **The bare half of the teardown.** `Component.unload` disarms the timers a
 * plugin handed to `registerInterval`; this disarms the ones it never did — a
 * bare `setInterval` in a bundle, which the loader's wrapper routes through
 * this host's clock and which therefore has an owner even though the plugin
 * never named it. Called by the loader after the component teardown, so it only
 * ever sweeps what is left.
 *
 * **This goes further than Obsidian, deliberately.** Obsidian cannot disarm an
 * unregistered timer either, so a plugin that leaked one there leaks it too.
 * The difference is that this host *owns the clock*: a timer left armed here
 * goes on firing into a plugin that has been torn down, with no plugin to
 * attribute it to, and Task 19's idle-cost census would count it against
 * nobody. Leaving it running is not parity, it is a leak this host can see and
 * chose not to close.
 */
export function clearTimersOwnedBy(pluginId: string): number {
  let cleared = 0;
  for (const [id, entry] of [...liveTimers]) {
    if (entry.pluginId !== pluginId) continue;
    liveTimers.delete(id);
    entry.clear();
    cleared += 1;
  }
  return cleared;
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
    // Taken here and not later: this is the one moment the attribution window
    // is open around the call that armed it.
    const pluginId = currentPluginId();
    const id = nextTimerId;
    nextTimerId += 1;
    if (repeating) {
      const handle = this.clock.setInterval(callback, ms);
      liveTimers.set(id, {
        intervalMs: ms,
        pluginId,
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
      pluginId,
      repeating,
      clear: () => {
        this.clock.clearTimeout(handle);
      },
    });
    return id;
  }
}
