/**
 * `CoexistenceMonitor`: what happens when a GUI Obsidian and this host both
 * think they are running the same plugin.
 *
 * Separate config directories keep the two `data.json` files apart, and that is
 * the whole of what they fix. A plugin's side effects are not in its settings:
 * two folder-notes instances make two folder notes per folder, two linter
 * instances run two lint passes over the same write, and three plugins in the
 * census bind a TCP port at load — the second one to try it fails, or worse,
 * takes the port. So the second half of coexistence is a refusal, and this file
 * pins its terms.
 *
 * The fifth case is the one that is easy to get wrong. "Obsidian has no
 * `community-plugins.json`" is not "Obsidian enables nothing": it is "there is
 * no Obsidian here to have an opinion", and a monitor that could not tell them
 * apart would either refuse everything in a vault with no GUI or claim an
 * overlap it never read.
 */

import { describe, expect, it } from "vitest";

import { CoexistenceMonitor, OverlapRefused } from "../src/pluginset/coexistence";
import { PluginSetHarness } from "../src/testing/pluginset-harness";

describe("CoexistenceMonitor", () => {
  it("reports the overlap between the two enabled sets", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["folder-notes", "automatic-linker"],
      guiEnabled: ["folder-notes", "tag-wrangler"],
    });
    const report = await harness.monitor.check();
    expect(report.overlap).toEqual(["folder-notes"]);
    expect(report.hostEnabled).toEqual(["folder-notes", "automatic-linker"]);
    expect(report.guiEnabled).toEqual(["folder-notes", "tag-wrangler"]);
    expect(report.guiReadable).toBe(true);
    await harness.stop();
  });

  it("refuses to enable a plugin the GUI already has enabled", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: [],
      guiEnabled: ["obsidian-linter"],
    });
    await expect(harness.monitor.assertCanEnable("obsidian-linter")).rejects.toBeInstanceOf(
      OverlapRefused,
    );
    await harness.monitor.assertCanEnable("obsidian-linter").catch((error: OverlapRefused) => {
      expect(error.code).toBe("overlap_refused");
      expect(error.pluginId).toBe("obsidian-linter");
      expect(error.message).toContain("event double-fire");
      expect(error.message).toContain("port binding");
    });
    await harness.stop();
  });

  it("admits a plugin named in --force-shared", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: [],
      guiEnabled: ["obsidian-linter"],
      forceShared: ["obsidian-linter"],
    });
    await expect(harness.monitor.assertCanEnable("obsidian-linter")).resolves.toBeUndefined();
    expect((await harness.monitor.check()).forced).toEqual(["obsidian-linter"]);
    await harness.stop();
  });

  it("catches a mid-session GUI enable on the next poll", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["quickadd"],
      guiEnabled: [],
    });
    const seen: string[][] = [];
    harness.monitor.onOverlapChanged((report) => seen.push([...report.overlap]));
    expect((await harness.monitor.check()).overlap).toEqual([]);
    harness.setGuiEnabled(["quickadd"]);
    await harness.advancePoll();
    expect(seen).toEqual([["quickadd"]]);
    expect(harness.monitor.latest()?.overlap).toEqual(["quickadd"]);
    await harness.stop();
  });

  it("reports guiReadable false rather than failing when Obsidian has no config", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: ["quickadd"], guiEnabled: null });
    const report = await harness.monitor.check();
    expect(report.guiReadable).toBe(false);
    expect(report.overlap).toEqual([]);
    await expect(harness.monitor.assertCanEnable("quickadd")).resolves.toBeUndefined();
    await harness.stop();
  });

  it("runs the external-config hook on the poll and not on an explicit check", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    let polls = 0;
    const off = harness.monitor.onPoll(() => {
      polls += 1;
    });
    await harness.monitor.check();
    expect(polls).toBe(0);
    await harness.advancePoll();
    expect(polls).toBe(1);
    off();
    await harness.advancePoll();
    expect(polls).toBe(1);
    await harness.stop();
  });

  it("stops polling once stopped, and stopping twice is not an error", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    const monitor: CoexistenceMonitor = harness.monitor;
    const armed = harness.clock.armed();
    monitor.stop();
    monitor.stop();
    expect(harness.clock.armed()).toBe(armed - 1);
    await harness.stop();
  });

  /**
   * The poll **repeats**.
   *
   * A one-shot timer would degrade the monitor to a single delayed check and
   * every other case in this file would still pass: they all advance once.
   * `checkedAtMs` comes from the injected clock, so two ticks are two stamps
   * exactly `overlapPollMs` apart, and a `setTimeout` in place of the interval
   * leaves the second one equal to the first.
   */
  it("keeps polling: two advances are two checks", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    const first = harness.monitor.latest()?.checkedAtMs ?? 0;
    await harness.advancePoll();
    const second = harness.monitor.latest()?.checkedAtMs ?? 0;
    await harness.advancePoll();
    const third = harness.monitor.latest()?.checkedAtMs ?? 0;
    expect(second - first).toBe(harness.config.overlapPollMs);
    expect(third - second).toBe(harness.config.overlapPollMs);
    await harness.stop();
  });

  /**
   * `start()` twice arms one interval, not two.
   *
   * Without the guard `this.timer` keeps only the last handle, so the first
   * interval is one `stop()` can never disarm: it polls the daemon forever, at
   * double the rate, in a host that believes it stopped. Counted as a delta
   * rather than an absolute, because an assembled shim has timers of its own and
   * this case is about exactly one of them.
   */
  it("arms one interval however many times it is started", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    const armed = harness.clock.armed();
    harness.monitor.start();
    harness.monitor.start();
    expect(harness.clock.armed()).toBe(armed);
    harness.monitor.stop();
    expect(harness.clock.armed()).toBe(armed - 1);
    await harness.stop();
  });

  /**
   * A broadcaster that throws must not fail the enable that noticed the change.
   *
   * `record` runs inside `check`, which runs inside `assertCanEnable`, which
   * runs on `host.enable_plugin`. Left bare, one broken subscriber would refuse
   * a plugin that has nothing wrong with it.
   */
  it("isolates an overlap subscriber that throws, and reports it", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["quickadd"],
      guiEnabled: [],
    });
    const alsoRan: string[][] = [];
    harness.monitor.onOverlapChanged(() => {
      throw new Error("broadcaster is broken");
    });
    harness.monitor.onOverlapChanged((report) => alsoRan.push([...report.overlap]));
    harness.setGuiEnabled(["quickadd"]);
    await expect(harness.monitor.assertCanEnable("tag-wrangler")).resolves.toBeUndefined();
    expect(alsoRan).toEqual([["quickadd"]]);
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["host", "config"],
    ]);
    await harness.stop();
  });

  /**
   * A hook that throws costs its own turn and nothing else.
   *
   * The tick's promise of "nothing here may throw" is what keeps the 60 s blind
   * window from silently becoming forever: an unhandled rejection out of a timer
   * callback has no caller, and the next tick would never be armed.
   */
  it("keeps polling after a poll hook throws, and reports the failure", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    let good = 0;
    harness.monitor.onPoll(() => {
      throw new Error("hook is broken");
    });
    harness.monitor.onPoll(() => {
      good += 1;
    });
    await harness.advancePoll();
    await harness.advancePoll();
    expect(good).toBe(2);
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["host", "config"],
      ["host", "config"],
    ]);
    await harness.stop();
  });

  /**
   * A **check** that fails costs its own tick and nothing else.
   *
   * The sibling case below it covers a *hook* throwing; this one covers the
   * other arm of the same method, and they are not the same guard. This is the
   * promise that keeps the 60 s blind window from silently becoming forever: a
   * rejected timer callback has no caller, so a check that took its rejection
   * with it would leave the interval armed and every later tick unreachable —
   * a monitor that looks alive and has stopped looking.
   *
   * `latest()` must still hold the *previous* answer afterwards. That is the
   * honest state: a failed read tells this host nothing, so it knows exactly
   * what it knew a minute ago, and inventing an empty report would be a claim
   * the daemon never made.
   */
  it("keeps polling after a check fails, and reports it", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["quickadd"],
      guiEnabled: ["quickadd"],
    });
    const before = harness.monitor.latest();
    expect(before?.overlap).toEqual(["quickadd"]);

    // A directory double: the next read of the enabled set fails the way a
    // closed client or a daemon mid-restart fails it, and every later one is
    // the real thing again.
    const dir = harness.dir;
    const real = dir.readEnabledSet.bind(dir);
    let failed = false;
    dir.readEnabledSet = (): Promise<string[]> => {
      if (failed) return real();
      failed = true;
      return Promise.reject(new Error("the daemon went away"));
    };

    await harness.advancePoll();
    expect(failed).toBe(true);
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["host", "config"],
    ]);
    // Unchanged: the same report object, not a fresh empty one.
    expect(harness.monitor.latest()).toBe(before);

    // And the next tick is an ordinary tick.
    harness.setGuiEnabled([]);
    await harness.advancePoll();
    expect(harness.monitor.latest()?.overlap).toEqual([]);
    expect(harness.monitor.latest()).not.toBe(before);
    expect(harness.hostErrors).toHaveLength(1);
    await harness.stop();
  });

  /**
   * `settled()` is load-bearing, and this is what would fail without it.
   *
   * A tick fans out into a check and every hook, and a hook takes however many
   * event-loop turns its work takes. `quiesce()` drains **three** turns of the
   * immediate queue — enough for the hooks that exist today, and a guess about
   * the ones that do not.
   *
   * The case cannot make that point with round trips. Against `FakeDaemon` a
   * read costs microtasks rather than turns, so sixteen sequential ones still
   * land inside three — measured: that version of this case passed with
   * `settled()` removed, which is exactly the false green this case exists to
   * prevent. So it models the general fact instead, which is the one the method
   * claims: a hook needing more turns than `quiesce` drains is seen only because
   * `advancePoll` waits for the *tick*. A hook awaiting a real daemon, a real
   * file system, or a `DispatchQueue` slot is that hook.
   */
  it("waits for the whole tick, not a fixed number of event-loop turns", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    let finished = false;
    harness.monitor.onPoll(async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      finished = true;
    });
    await harness.advancePoll();
    expect(finished).toBe(true);
    await harness.stop();
  });

  /**
   * `teardown()` disarms the poll.
   *
   * Nothing outside a harness starts the monitor today, so nothing leaks yet.
   * When Task 15 starts it at boot, an assembly torn down without that line
   * leaves an interval polling a vault this host no longer owns — through a
   * client that has been closed — once a minute, forever.
   */
  it("stops the poll when the whole host is torn down", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    expect(harness.clock.armed()).toBeGreaterThan(0);
    harness.teardown();
    expect(harness.clock.armed()).toBe(0);
    await harness.stop();
  });

  /**
   * The assembly's error sink reaches the **directory**, not only the monitor.
   *
   * `assembleShim` passes one `HostErrors` to both. The monitor's half is pinned
   * twice over by the cases above; this is the other half, and losing it would
   * be invisible — a damaged `community-plugins.json` in a real host would print
   * to stderr instead of reaching the host's seam and, later, its listeners.
   */
  it("reports a damaged config file through the assembled error sink", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    harness.setConfigFile(".obsidian-headless/community-plugins.json", '{"not": "an array"}');
    await expect(harness.dir.readEnabledSet()).resolves.toEqual([]);
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["host", "config"],
    ]);
    await harness.stop();
  });

  /**
   * The wiring, end to end: one tick re-reads every config file a GUI edit can
   * change, and the overlap report moves with them.
   *
   * This is Ruling W7's second half. `assembleShim` hangs
   * `InternalPluginRegistry.refresh()` and `Vault.reprimeConfig()` off
   * `onPoll`, and the reason it has to is that **nothing else will ever tell
   * this host**: a GUI Obsidian writing `.obsidian/app.json` or
   * `.obsidian/core-plugins.json` raises no `config_changed`, because the daemon
   * announces only the writes it performs itself. Before the poll fires, every
   * assertion below still answers with the old file.
   */
  it("re-primes the vault config and the internal plugins on the poll", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: [],
      guiEnabled: [],
      configFiles: {
        ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Attachments" }),
        ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": false }),
      },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Attachments");
    expect(harness.app.internalPlugins.getPluginById("daily-notes")?.enabled).toBe(false);
    expect(harness.monitor.latest()?.overlap).toEqual([]);

    // What a GUI Obsidian does behind this host's back.
    harness.setConfigFile(".obsidian/app.json", JSON.stringify({ attachmentFolderPath: "Files" }));
    harness.setConfigFile(".obsidian/core-plugins.json", JSON.stringify({ "daily-notes": true }));
    harness.setGuiEnabled(["quickadd"]);
    harness.setHostEnabled(["quickadd"]);

    // Nothing has told the host anything: the old answers still stand.
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Attachments");
    expect(harness.app.internalPlugins.getPluginById("daily-notes")?.enabled).toBe(false);

    await harness.advancePoll();

    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Files");
    expect(harness.app.internalPlugins.getPluginById("daily-notes")?.enabled).toBe(true);
    expect(harness.monitor.latest()?.overlap).toEqual(["quickadd"]);
    expect(harness.hostErrors).toEqual([]);
    await harness.stop();
  });
});
