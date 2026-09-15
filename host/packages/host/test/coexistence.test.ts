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
    monitor.stop();
    monitor.stop();
    expect(harness.clock.armed()).toBe(0);
    await harness.stop();
  });
});
