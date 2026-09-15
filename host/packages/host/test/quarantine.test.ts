/* eslint-disable @typescript-eslint/require-await --
 * `onQuarantine` is `(id, failures) => Promise<void>` because the real one —
 * Task 15's, which unloads the plugin and forgets its harvest — has to be
 * awaited before `record` returns. A test double that only writes down which
 * id it was handed has nothing to await, and rewriting it as a synchronous
 * function would not be the callback the tracker takes.
 */

/**
 * The quarantine: five handler failures inside a rolling sixty seconds and the
 * plugin stops being trusted.
 *
 * Two things are being tested here and they are worth telling apart.
 *
 * The **counting** is the tracker's own: per plugin, never across plugins;
 * pruned to the window on every record so a plugin that fails once an hour is
 * never quarantined; one `onQuarantine` call however many failures follow it;
 * and a `lastError` that holds the most recent failure whether or not the
 * threshold was reached, because three later test files assert on it through
 * `harness.lastHandlerError`.
 *
 * The **attribution** is {@link failureFromReport}'s: the host error seam
 * carries a `pluginId` and a phase, and two of the things it carries are the
 * host's own failures rather than any plugin's — a damaged
 * `community-plugins.json` (phase `config`) and a command with no plugin on
 * the stack (plugin id `host`). A quarantine that counted either would disable
 * a plugin for the host's bug, so the adapter drops them and a case pins it.
 *
 * Every duration here is measured with `config.clock.now()`. The rolling
 * window case advances sixty-one seconds and the file still runs in
 * milliseconds; that is the whole reason the clock is injected.
 */

import { describe, expect, it } from "vitest";

import { HOST_PLUGIN_ID, QuarantineTracker, failureFromReport } from "../src/runtime/quarantine";
import { ShimHarness } from "../src/testing/shim-harness";
import { defaultHostConfig } from "../src/config";
import { testClock } from "../src/testing/clock";
import type { HandlerFailure } from "../src/runtime/quarantine";

/**
 * A tracker over a test clock, plus the two things every case below drives it
 * with.
 *
 * The vault root is a name, not a directory: `defaultHostConfig` derives a
 * socket path from it and touches nothing, so a case that made a real
 * `mkdtemp` directory would leave one behind per run and read none of them.
 */
const trackerWith = (): {
  clock: ReturnType<typeof testClock>;
  tracker: QuarantineTracker;
  quarantined: string[];
  reasons: Array<readonly HandlerFailure[]>;
  fail: (pluginId: string, message?: string) => Promise<void>;
} => {
  const clock = testClock();
  const config = {
    ...defaultHostConfig("/vault"),
    clock,
    quarantineFailures: 5,
    quarantineWindowMs: 60_000,
  };
  const quarantined: string[] = [];
  const reasons: Array<readonly HandlerFailure[]> = [];
  const tracker = new QuarantineTracker(config, async (id, failures) => {
    quarantined.push(id);
    reasons.push(failures);
  });
  const fail = async (pluginId: string, message = "nope"): Promise<void> => {
    await tracker.record({
      pluginId,
      label: "command:x",
      error: new Error(message),
      atUnixMs: clock.now(),
    });
  };
  return { clock, tracker, quarantined, reasons, fail };
};

describe("QuarantineTracker", () => {
  it("quarantines on the fifth failure inside the window, not the fourth", async () => {
    const { tracker, quarantined, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(false);
    expect(tracker.failuresFor("flaky")).toBe(4);
    expect(quarantined).toEqual([]);
    await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(true);
    expect(quarantined).toEqual(["flaky"]);
  });

  it("prunes failures that fall out of the rolling window", async () => {
    const { clock, tracker, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("flaky");
    await clock.advance(61_000);
    await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(false);
    expect(tracker.failuresFor("flaky")).toBe(1);
  });

  it("counts per plugin, never across them", async () => {
    const { tracker, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("bad");
    await fail("other");
    expect(tracker.failuresFor("bad")).toBe(4);
    expect(tracker.failuresFor("other")).toBe(1);
    expect(tracker.quarantined()).toEqual([]);
  });

  it("calls onQuarantine exactly once no matter how many more failures arrive", async () => {
    const { tracker, quarantined, fail } = trackerWith();
    for (let i = 0; i < 8; i += 1) await fail("flaky");
    expect(quarantined).toEqual(["flaky"]);
    expect(tracker.reason("flaky")).toHaveLength(5);
  });

  it("keeps the last error and clears it on release", async () => {
    const { tracker, fail } = trackerWith();
    await fail("flaky", "first");
    await fail("flaky", "second");
    expect(tracker.lastError("flaky")?.message).toBe("second");
    tracker.release("flaky");
    expect(tracker.failuresFor("flaky")).toBe(0);
    expect(tracker.lastError("flaky")).toBeNull();
    expect(tracker.isQuarantined("flaky")).toBe(false);
  });

  /**
   * The boundary the brief leaves open, pinned rather than left to whichever
   * comparison the implementation happened to write.
   *
   * The window is **half-open**: `[first, first + windowMs)`. A failure exactly
   * `windowMs` after the first one does not join it — the first has aged out by
   * then — so five failures at 0, 1, 2, 3 and 60_000 ms are four in the window,
   * and the same five at 59_999 ms are a quarantine.
   */
  it("treats the window as half-open at exactly windowMs", async () => {
    const { clock, tracker, fail } = trackerWith();
    const start = clock.now();
    for (let i = 0; i < 4; i += 1) await fail("edge");
    clock.setNow(start + 60_000);
    await fail("edge");
    expect(tracker.failuresFor("edge")).toBe(1);
    expect(tracker.isQuarantined("edge")).toBe(false);
  });

  it("quarantines when the fifth failure lands one millisecond inside the window", async () => {
    const { clock, tracker, fail } = trackerWith();
    const start = clock.now();
    for (let i = 0; i < 4; i += 1) await fail("edge");
    clock.setNow(start + 59_999);
    await fail("edge");
    expect(tracker.isQuarantined("edge")).toBe(true);
  });

  it("hands onQuarantine the failures that caused it", async () => {
    const { tracker, reasons, fail } = trackerWith();
    for (let i = 0; i < 5; i += 1) await fail("flaky", `failure ${i}`);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.map((failure) => failure.error.message)).toEqual([
      "failure 0",
      "failure 1",
      "failure 2",
      "failure 3",
      "failure 4",
    ]);
    expect(tracker.quarantined()).toEqual(["flaky"]);
  });

  it("lets a released plugin be quarantined again", async () => {
    const { tracker, quarantined, fail } = trackerWith();
    for (let i = 0; i < 5; i += 1) await fail("flaky");
    tracker.release("flaky");
    expect(tracker.quarantined()).toEqual([]);
    expect(tracker.reason("flaky")).toEqual([]);
    for (let i = 0; i < 5; i += 1) await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(true);
    expect(quarantined).toEqual(["flaky", "flaky"]);
  });

  /**
   * `forgetPlugin` is what a plugin being uninstalled gets, and it differs from
   * `release` in intent rather than in effect: release is "trust it again",
   * forget is "there is no such plugin". Both leave nothing behind, and the
   * case asserts the second half because a quarantine id that outlived its
   * plugin would refuse a command for a plugin that had been reinstalled.
   */
  it("forgets everything it knows about a plugin", async () => {
    const { tracker, fail } = trackerWith();
    for (let i = 0; i < 5; i += 1) await fail("gone");
    await fail("stays");
    tracker.forgetPlugin("gone");
    expect(tracker.failuresFor("gone")).toBe(0);
    expect(tracker.lastError("gone")).toBeNull();
    expect(tracker.isQuarantined("gone")).toBe(false);
    expect(tracker.reason("gone")).toEqual([]);
    expect(tracker.quarantined()).toEqual([]);
    expect(tracker.failuresFor("stays")).toBe(1);
  });

  it("answers for a plugin it has never heard of", () => {
    const { tracker } = trackerWith();
    expect(tracker.failuresFor("unknown")).toBe(0);
    expect(tracker.lastError("unknown")).toBeNull();
    expect(tracker.isQuarantined("unknown")).toBe(false);
    expect(tracker.reason("unknown")).toEqual([]);
    expect(tracker.quarantined()).toEqual([]);
  });

  /**
   * The threshold is crossed before the callback is awaited, so two failures
   * racing to the fifth cannot both take the transition. Without that the
   * sequencer would unload the same plugin twice, and the second unload runs
   * against a plugin that is already gone.
   */
  it("fires onQuarantine once when two failures cross the threshold together", async () => {
    const { quarantined, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("flaky");
    await Promise.all([fail("flaky"), fail("flaky")]);
    expect(quarantined).toEqual(["flaky"]);
  });

  it("stays quarantined when onQuarantine itself fails", async () => {
    const clock = testClock();
    const config = { ...defaultHostConfig("/vault"), clock };
    const tracker = new QuarantineTracker(config, async () => {
      throw new Error("unload blew up");
    });
    const fail = async (): Promise<void> =>
      tracker.record({
        pluginId: "flaky",
        label: "onload",
        error: new Error("nope"),
        atUnixMs: clock.now(),
      });
    for (let i = 0; i < 4; i += 1) await fail();
    // The rejection reaches the caller rather than being swallowed: the tracker
    // has nowhere to report to, and Task 15's sequencer — which is the caller —
    // has the error seam.
    await expect(fail()).rejects.toThrow("unload blew up");
    expect(tracker.isQuarantined("flaky")).toBe(true);
    // And it is not retried on the next failure, because the transition was
    // taken before the callback ran.
    await expect(fail()).resolves.toBeUndefined();
  });
});

describe("failureFromReport", () => {
  it("never counts the host's own failures against a plugin", () => {
    // A damaged `community-plugins.json`, and a coexistence poll whose
    // subscriber threw. Both are reported with the phase the seam keeps for
    // exactly this reason.
    expect(
      failureFromReport({ error: new Error("bad json"), pluginId: "quickadd", phase: "config" }, 1),
    ).toBeNull();
    // And a command with no plugin on the stack, which the command surface
    // reports against the host id.
    expect(
      failureFromReport({ error: new Error("nope"), pluginId: HOST_PLUGIN_ID, phase: "command" }, 1),
    ).toBeNull();
  });

  it("labels a failure with its phase, and with the detail when there is one", () => {
    const onload = failureFromReport(
      { error: new Error("nope"), pluginId: "demo", phase: "onload" },
      7,
    );
    expect(onload).toMatchObject({ pluginId: "demo", label: "onload", atUnixMs: 7 });
    const command = failureFromReport(
      { error: new Error("nope"), pluginId: "demo", phase: "command" },
      7,
      "demo:go",
    );
    expect(command?.label).toBe("command:demo:go");
  });

  it("carries a thrown non-Error through as an Error the tracker can hold", () => {
    const failure = failureFromReport(
      { error: "a bare string", pluginId: "demo", phase: "onunload" },
      7,
    );
    expect(failure?.error).toBeInstanceOf(Error);
    expect(failure?.error.message).toContain("a bare string");
    expect(failure?.error.cause).toBe("a bare string");
  });
});

/**
 * One case through the real shim, so the unit above is not the only thing that
 * has ever driven it.
 *
 * The wiring — seam listener to tracker to sequencer — is Task 15's, so this
 * builds the smallest honest version of it by hand: a plugin whose command
 * rejects, the failures the host reported for it, and an `onQuarantine` that
 * does what the sequencer's will do. What it proves is the thing the
 * quarantine exists for: the plugin's command leaves `harvest.commands()`, so
 * a capability list can no longer advertise a command nothing will answer.
 */
describe("a quarantine over the real shim", () => {
  it("unloads a plugin whose command keeps failing and drops its harvest", async () => {
    const harness = await ShimHarness.withVault({});
    const tracker = new QuarantineTracker(harness.config, async (id) => {
      await harness.unload(id);
    });
    const plugin = harness.instantiate(
      "flaky",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "go",
            name: "Go",
            callback: async (): Promise<void> => {
              throw new Error("handler blew up");
            },
          });
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.commands().map((command) => command.id)).toEqual(["flaky:go"]);

    const drain = async (): Promise<void> => {
      await harness.quiesce();
      for (const entry of harness.hostErrors.splice(0)) {
        const failure = failureFromReport(entry, harness.clock.now(), "flaky:go");
        if (failure !== null) await tracker.record(failure);
      }
    };
    for (let i = 0; i < 4; i += 1) {
      expect(harness.app.commands.executeCommandById("flaky:go")).toBe(true);
      await drain();
    }
    expect(tracker.failuresFor("flaky")).toBe(4);
    expect(tracker.isQuarantined("flaky")).toBe(false);
    expect(harness.harvest.commands().map((command) => command.id)).toEqual(["flaky:go"]);

    expect(harness.app.commands.executeCommandById("flaky:go")).toBe(true);
    await drain();
    expect(tracker.isQuarantined("flaky")).toBe(true);
    expect(tracker.lastError("flaky")?.message).toBe("handler blew up");
    expect(tracker.reason("flaky").map((failure) => failure.label)).toEqual([
      "command:flaky:go",
      "command:flaky:go",
      "command:flaky:go",
      "command:flaky:go",
      "command:flaky:go",
    ]);
    // The point of the whole component: the command is gone from the harvest,
    // so nothing can list it and nothing can invoke it.
    expect(harness.harvest.commands()).toEqual([]);
    expect(harness.app.commands.executeCommandById("flaky:go")).toBe(false);
  });
});
