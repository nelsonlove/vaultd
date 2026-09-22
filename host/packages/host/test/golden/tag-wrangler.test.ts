/**
 * tag-wrangler: the acceptance case for **registration harvesting**, and it
 * asserts the honest result rather than a flattering one.
 *
 * The plugin registers **no commands at all**. Everything it offers a user is a
 * menu entry point, and most of those are DOM-delegated listeners that a host
 * with no DOM can never reach. So the question this file answers is not "does
 * it work" but "does the host see what is there, and say plainly what it cannot
 * reach" — which is the whole of Goal 2.
 */

import { afterEach, describe, expect, it } from "vitest";

import { BINARY_EXISTS, cleanupRealDaemons } from "../real-daemon";
import { LiveHost } from "../../src/testing/live-host";

afterEach(async () => {
  await cleanupRealDaemons();
});

describe.skipIf(!BINARY_EXISTS)("tag-wrangler harvest", () => {
  it("harvests menu entry points from a plugin with zero commands", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", {
      "Tagged.md": "---\ntags: [alpha]\n---\n#beta\n",
    });
    try {
      // Zero commands. Measured, not hoped.
      expect(await host.call("host.list_commands", {})).toEqual({ commands: [] });

      // Exactly ONE editor-menu hook is the entire harvestable surface, and
      // there are zero file-menu hooks. These are the honest numbers from the
      // shipped bundle, recorded in Task 0 Step 4c and re-confirmed against the
      // running app on 2026-09-09.
      const hooks = host
        .harvest()
        .menuHooks()
        .filter((hook) => hook.pluginId === "tag-wrangler");
      expect(hooks.map((hook) => hook.context)).toEqual(["editor-menu"]);
      expect(
        await host.call("host.list_menu_items", { context: "file-menu", path: "Tagged.md" }),
      ).toEqual({ items: [] });

      // **Zero items, and the reason is a surface this host does not have.**
      // The hook is harvested and really runs; what it cannot find is a tag
      // under a cursor, because `host.list_menu_items` builds an editor-menu
      // subject of `(a headless editor stub, { file })` and there is no
      // cursor parameter to carry the capture's `line 5, ch 18`. The live
      // capture's six items are in `expected/editor-menu.json` and are NOT
      // reproduced here. Asserting them
      // would be asserting an outcome this host cannot produce.
      const items = await host.call<{ items: Array<{ title: string }> }>(
        "host.list_menu_items",
        { context: "editor-menu", path: "Tagged.md" },
      );
      expect(items.items).toEqual([]);

      const report = await host.call<{
        report: { plugins: Array<{ scan: { tier_estimate: number } }> };
      }>("host.compat_report", { plugin_id: "tag-wrangler" });
      expect(report.report.plugins[0]?.scan.tier_estimate).toBeGreaterThanOrEqual(1);

      // **DOM-delegated listeners, unreachable with no DOM.** Not "at least
      // one": the count is ground truth and a drift in either direction means
      // either the bundle changed or the detector stopped seeing them.
      //
      // The number is the RUNTIME one, and it disagrees with the capture. Task
      // 0's static read of the bundle counted ten call sites; the host records
      // one row per registration actually made, and the difference is
      // unexplained — it is written down here and in the goldens README rather
      // than being rounded to whichever number reads better.
      const unreachable = host
        .harvest()
        .unreachable()
        .filter((entry) => entry.kind === "dom_delegated_menu");
      expect(unreachable).toHaveLength(17);
      expect(unreachable.filter((entry) => entry.detail.includes("contextmenu"))).toHaveLength(3);

      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 120_000);

  it("survives all four things its onLayoutReady body does", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", {
      "Tagged.md": "---\ntags: [alpha]\naliases: [Ay]\n---\n#beta\n",
      "Other.md": "#alpha\n",
    });
    try {
      // 1. getCachedFiles() + getCache() — the frontmatter scan.
      // 2 & 3. registerEvent(metadataCache.on("changed")) and
      //        registerEvent(vault.on("delete")) — it stays a live subscriber,
      //        so a later edit must reach it without throwing.
      // 4. workspace.getLeavesOfType("tag") — must be [], never undefined.
      expect(host.app().workspace.getLeavesOfType("tag")).toEqual([]);
      await host.call("write_note", {
        path: "Tagged.md",
        content: "---\ntags: [alpha]\naliases: [Bee]\n---\n#beta\n",
        expected: { any: true },
      });
      await host.quiesce();
      await host.call("delete_note", {
        path: "Other.md",
        mode: "permanent",
        expected: { any: true },
      });
      await host.quiesce();
      expect(host.quarantine().failuresFor("tag-wrangler")).toBe(0);
      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 120_000);

  it("degrades honestly when it reaches for global-search", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", { "Tagged.md": "#beta\n" });
    try {
      const internal = host.app().internalPlugins.getPluginById("global-search");
      expect(internal?.instance ?? null).toBeNull();
      expect(host.quarantine().failuresFor("tag-wrangler")).toBe(0);
    } finally {
      await host.stop();
    }
  }, 120_000);
});
