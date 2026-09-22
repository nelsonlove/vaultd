/**
 * The quarantine: when the host stops trusting a plugin, and what it counts to
 * decide.
 *
 * Ruling 8's rule is **five handler failures inside a rolling sixty seconds**,
 * per plugin, both numbers read from {@link HostConfig} so a test can drive a
 * different threshold without patching a constant. A plugin that fails once an
 * hour is never quarantined, because the window prunes on every record; a
 * plugin that fails five times in a loop is quarantined on the fifth, and the
 * callback that disables it runs exactly once however many failures follow.
 *
 * **What a quarantine actually does is the caller's**, not this component's.
 * {@link QuarantineTracker} counts and decides; the `onQuarantine` callback —
 * Task 15's lifecycle sequencer supplies the real one — unloads the plugin,
 * calls `harvest.forgetPlugin(id)` so its commands, menu hooks and protocol
 * handlers leave `host.list_*`, and calls `events.forgetPlugin(id)` so no vault
 * change can wake it again. Removing the harvest is the point: a capability
 * list that still advertises a dead plugin's commands is worse than one that
 * says the plugin is quarantined, which is what `host.invoke_command` answers
 * afterwards.
 *
 * **Time comes from `config.clock`, never from the global.** That is a Global
 * Constraint of this phase and it is what makes the window testable: the case
 * for "failures outside the window" advances sixty-one seconds and runs in
 * milliseconds.
 *
 * **The host's own failures never count against a plugin.** Every failure the
 * host has nobody to hand back to travels through `shim/errors.ts`, and two
 * kinds of report there are the host's rather than any plugin's: the phase
 * `config` (a damaged `community-plugins.json`, a coexistence poll that failed,
 * a subscriber to it that threw) and the plugin id {@link HOST_PLUGIN_ID} (a
 * command invoked with no plugin on the stack). {@link failureFromReport} drops
 * both. A host that quarantined a plugin for its own bug would disable
 * working plugins one at a time until somebody noticed.
 *
 * **Uncounted is not the same as unseen.** Task 18 added a third kind: a
 * brokered prompt that failed with nobody awaiting it (phase `interaction`).
 * That one really is the plugin's — it asked the question — but it is not
 * evidence the plugin is broken, because what failed is the human's end of the
 * channel. So it is dropped from the window like the other two and still
 * recorded as the plugin's {@link QuarantineTracker.lastError} through
 * {@link QuarantineTracker.note}: `harness.lastHandlerError` can say what went
 * wrong, and no number of them ever quarantines anything. See
 * {@link UNCOUNTED_PHASES}.
 */

import { HOST_PLUGIN_ID } from "../shim/errors";
import type { HostConfig } from "../config";
import type { HostErrorEntry, HostErrorPhase } from "../shim/errors";

/**
 * The phases that are a plugin's failure and are still never counted.
 *
 * One member today: `interaction`. A brokered prompt fails when the *client*
 * end goes — a detach, a disconnect, a human who never answered — and counting
 * that against the plugin that asked would quarantine a working plugin for
 * something it has no control over. `config` is not here because it is not the
 * plugin's at all: {@link failureFromReport} drops it on the phase, and nothing
 * about it is worth recording as any plugin's last error.
 */
export const UNCOUNTED_PHASES: ReadonlySet<HostErrorPhase> = new Set<HostErrorPhase>([
  "interaction",
]);

/**
 * Re-exported, not re-declared.
 *
 * The one definition lives in `shim/errors.ts`, beside the `pluginId` field it
 * is a value of — it had three copies before Task 15 hoisted it, and three
 * literals for one fact is three chances for a rename to leave this file
 * counting the host's own bugs against a plugin. Re-exported here because a
 * caller that thinks of it as a quarantine concept looks for it here, and
 * `test/quarantine.test.ts` already imports it from this module.
 */
export { HOST_PLUGIN_ID };

/**
 * One failure, attributed.
 *
 * `label` is what the failure is called in a report and in a refusal —
 * `"onload"`, `"command:demo:go"`, `"event:vault:modify"`. It is never parsed:
 * it exists so that a human reading five failures can tell "this plugin's
 * `onload` is broken" from "this plugin's modify handler throws on one note".
 *
 * `atUnixMs` is the caller's reading of `config.clock.now()` rather than
 * something this component stamps, because the caller is where the failure
 * happened: the event bus knows when the handler threw, and a failure recorded
 * after an `await` would be timed by when the queue got to it.
 */
export interface HandlerFailure {
  readonly pluginId: string;
  readonly label: string;
  readonly error: Error;
  readonly atUnixMs: number;
}

interface PluginRecord {
  /** The failures still inside the window, oldest first. */
  window: HandlerFailure[];
  /** The failures that caused the quarantine, frozen when it was decided. */
  reason: readonly HandlerFailure[] | null;
  lastError: Error | null;
  quarantined: boolean;
}

export class QuarantineTracker {
  private readonly records = new Map<string, PluginRecord>();

  constructor(
    private readonly config: HostConfig,
    private readonly onQuarantine: (
      pluginId: string,
      failures: readonly HandlerFailure[],
    ) => Promise<void>,
  ) {}

  /**
   * Record one failure, and quarantine the plugin if this was the fifth.
   *
   * Resolves **after** `onQuarantine` has resolved, so a caller that awaits it
   * knows the unload has completed before it reports the failure onward —
   * otherwise a plugin could still answer a command between the decision to
   * remove it and its removal.
   *
   * The transition is taken **before** the callback runs, so two failures
   * racing to the fifth cannot both take it, and a callback that throws does
   * not leave the plugin free to be quarantined a second time. That rejection
   * travels to the caller rather than being swallowed here: this component has
   * nowhere to report to, and Task 15's sequencer — the caller — has the error
   * seam.
   *
   * A failure that arrives after the quarantine updates `lastError` and
   * nothing else. The window is frozen at that point because it has become the
   * *reason*, and a reason that kept growing would no longer say what the
   * decision was made on.
   */
  async record(failure: HandlerFailure): Promise<void> {
    const record = this.recordFor(failure.pluginId);
    record.lastError = failure.error;
    if (record.quarantined) return;
    this.prune(record, failure.atUnixMs);
    record.window.push(failure);
    if (record.window.length < this.config.quarantineFailures) return;
    record.quarantined = true;
    record.reason = [...record.window];
    await this.onQuarantine(failure.pluginId, record.reason);
  }

  /**
   * Record a failure as this plugin's last one, and count it against nothing.
   *
   * The half of {@link record} that survives for an {@link UNCOUNTED_PHASES}
   * report: the window is not touched, no threshold can be reached, and a
   * plugin that is already quarantined is not disturbed — but
   * {@link lastError} answers, which is what makes an uncounted failure
   * diagnosable rather than silent.
   */
  note(pluginId: string, error: unknown): void {
    this.recordFor(pluginId).lastError = asError(error);
  }

  /** How many failures are inside the window right now. */
  failuresFor(pluginId: string): number {
    const record = this.records.get(pluginId);
    if (record === undefined) return 0;
    if (!record.quarantined) this.prune(record, this.config.clock.now());
    return record.window.length;
  }

  /**
   * The most recent failure's error, whether or not the threshold was reached.
   *
   * Three later test files assert on it through `harness.lastHandlerError`,
   * which is a thin wrapper over this: "the handler threw, and here is what it
   * threw" is the thing a case about a broken handler wants to say, and it is
   * true long before any quarantine.
   */
  lastError(pluginId: string): Error | null {
    return this.records.get(pluginId)?.lastError ?? null;
  }

  isQuarantined(pluginId: string): boolean {
    return this.records.get(pluginId)?.quarantined ?? false;
  }

  /**
   * Every quarantined plugin id.
   *
   * In the order the tracker first heard of each plugin, not the order they
   * were quarantined — a plugin's record is created by its first failure. The
   * order is not meaningful and no caller should read one into it; this is a
   * set with a stable enumeration.
   */
  quarantined(): readonly string[] {
    const ids: string[] = [];
    for (const [pluginId, record] of this.records) {
      if (record.quarantined) ids.push(pluginId);
    }
    return ids;
  }

  /** What a plugin was quarantined for, or nothing if it was not. */
  reason(pluginId: string): readonly HandlerFailure[] {
    return this.records.get(pluginId)?.reason ?? [];
  }

  /**
   * Trust the plugin again: the quarantine goes, the window goes, and so does
   * the last error.
   *
   * The window has to go with it. A release that left four stale failures
   * behind would quarantine the plugin again on its first failure after being
   * re-enabled, which is not a rolling window — it is a grudge.
   */
  release(pluginId: string): void {
    this.records.delete(pluginId);
  }

  /**
   * Forget the plugin entirely.
   *
   * Identical in effect to {@link release} and different in meaning: release
   * says "trust it again", forget says "there is no such plugin" — an
   * uninstall, or a plugin set that no longer lists it. Kept separate because
   * every other component in this host has the same pair, and a caller that had
   * to remember which one this component happened to implement would guess.
   */
  forgetPlugin(pluginId: string): void {
    this.records.delete(pluginId);
  }

  private recordFor(pluginId: string): PluginRecord {
    const existing = this.records.get(pluginId);
    if (existing !== undefined) return existing;
    const fresh: PluginRecord = {
      window: [],
      reason: null,
      lastError: null,
      quarantined: false,
    };
    this.records.set(pluginId, fresh);
    return fresh;
  }

  /**
   * Drop everything that has aged out, measured from `now`.
   *
   * The window is **half-open**: a failure is kept while `now - atUnixMs` is
   * strictly less than `quarantineWindowMs`, so five failures whose first and
   * last are exactly sixty seconds apart are not five in one window. The brief
   * does not choose a side of that boundary; this is the side that makes
   * "inside a rolling sixty seconds" mean a span shorter than sixty seconds,
   * and `test/quarantine.test.ts` pins both sides of it.
   */
  private prune(record: PluginRecord, now: number): void {
    const oldest = now - this.config.quarantineWindowMs;
    let keepFrom = 0;
    while (keepFrom < record.window.length) {
      const entry = record.window[keepFrom];
      if (entry !== undefined && entry.atUnixMs > oldest) break;
      keepFrom += 1;
    }
    if (keepFrom > 0) record.window.splice(0, keepFrom);
  }
}

/**
 * Turn one host error report into something the tracker can count — or into
 * `null`, when it is not a plugin's failure at all.
 *
 * The seam carries three things (`error`, `pluginId`, `phase`) and a
 * {@link HandlerFailure} needs four, so the two missing pieces are supplied by
 * the caller: the clock reading, and the `detail` that turns a phase into a
 * label. A command failure's detail is the command id, which the seam does not
 * carry — `"command"` plus `"demo:go"` is the label `"command:demo:go"`, and
 * the same shape gives the event bus `"event:vault:modify"`. Task 15 is the
 * caller that has both.
 *
 * Returns `null` for the host's own failures — phase `config`, or the plugin id
 * {@link HOST_PLUGIN_ID} — and a caller that skips the `null` is a caller that
 * never quarantines a plugin for the host's bug. It also returns `null` for an
 * {@link UNCOUNTED_PHASES} report, which **is** a plugin's failure and still
 * must not be counted; the caller records that one through
 * {@link QuarantineTracker.note} instead, so it is visible without being
 * evidence.
 */
export function failureFromReport(
  report: HostErrorEntry,
  atUnixMs: number,
  detail?: string,
): HandlerFailure | null {
  if (report.phase === "config" || report.pluginId === HOST_PLUGIN_ID) return null;
  if (UNCOUNTED_PHASES.has(report.phase)) return null;
  const label = detail === undefined || detail === "" ? report.phase : `${report.phase}:${detail}`;
  return { pluginId: report.pluginId, label, error: asError(report.error), atUnixMs };
}

/**
 * Whatever was thrown, as an `Error`.
 *
 * A plugin may throw a string, a number, or an object with a `message` on it,
 * and the corpus does all three. The original is kept as `cause` rather than
 * discarded, because the text of a stringified object is often all a human has
 * to go on and the value itself is sometimes more.
 *
 * **`String(value)` is useless for exactly the case that needs it most.** A
 * plain object renders as `[object Object]`, so the quarantine's reason — the
 * sentence a human reads to find out why a plugin was switched off — said
 * nothing at all about the thrown payload. The payload always survived on
 * `cause`; what was missing was the *rendered* message, so the fallback tries
 * `JSON.stringify` first and keeps `String(value)` for everything that has no
 * JSON form (a `BigInt`, a symbol, a cycle, an object whose `toJSON` throws) —
 * including the case where `JSON.stringify` answers `undefined`, which it does
 * for a function or a bare `undefined`.
 */
function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(`non-Error thrown: ${rendered(value)}`, { cause: value });
}

/** `value` as text for a message: its JSON form when it has one. */
function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // A cycle, a `BigInt`, or a `toJSON` of its own that threw. `String` below.
  }
  return String(value);
}
