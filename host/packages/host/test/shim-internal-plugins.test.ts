/**
 * `app.internalPlugins`: the two core plugins this host reimplements as config
 * readers, and the ones it reports present-but-absent so a plugin takes its own
 * degraded branch.
 *
 * The cases are the corpus's own shapes. rollover-daily-todos reads
 * `daily-notes`' options through `getEnabledPluginById` **and**
 * `plugins["daily-notes"].instance`, so both spellings are pinned; folder-notes
 * asks for `file-explorer` and early-returns on a falsy answer; tag-wrangler
 * asks for `global-search`. A `null` instance is what makes those branches run;
 * an object with plausible-looking empty methods would not.
 */

import { describe, expect, it } from "vitest";

import { ShimHarness } from "../src/testing/shim-harness";

describe("app.internalPlugins", () => {
  it("serves daily-notes options from the config file and reports its real enabled flag", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/core-plugins.json": JSON.stringify({
            "daily-notes": false,
            bookmarks: true,
            "file-explorer": true,
          }),
          ".obsidian/daily-notes.json": JSON.stringify({
            folder: "Journal/Daily",
            format: "YYYY-MM/YYYY-MM-DD",
            template: "Templates/Daily.md",
          }),
        },
      },
    );
    const internal = harness.app.internalPlugins;
    const entry = internal.getPluginById("daily-notes");
    expect(entry?.enabled).toBe(false);
    const instance = entry?.instance as {
      options: { folder: string; format: string; template: string };
    };
    expect(instance.options).toEqual({
      folder: "Journal/Daily",
      format: "YYYY-MM/YYYY-MM-DD",
      template: "Templates/Daily.md",
    });
    expect(internal.plugins["daily-notes"]?.enabled).toBe(false);
    expect(internal.getEnabledPluginById("daily-notes")).toBeNull();
  });

  it("prefers the headless config dir over Obsidian's when both exist", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/daily-notes.json": JSON.stringify({ folder: "Gui", format: "YYYY", template: "" }),
          ".obsidian-headless/daily-notes.json": JSON.stringify({
            folder: "Headless",
            format: "YYYY-MM-DD",
            template: "",
          }),
        },
      },
    );
    const instance = harness.app.internalPlugins.getPluginById("daily-notes")?.instance as {
      options: { folder: string };
    };
    expect(instance.options.folder).toBe("Headless");
  });

  it("serves the bookmarks tree", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/core-plugins.json": JSON.stringify({ bookmarks: true }),
          ".obsidian/bookmarks.json": JSON.stringify({
            items: [
              { type: "folder", ctime: 1, path: "Inbox" },
              { type: "group", title: "Reading", items: [{ type: "file", ctime: 2, path: "A.md" }] },
            ],
          }),
        },
      },
    );
    const instance = harness.app.internalPlugins.getEnabledPluginById("bookmarks") as {
      items: unknown[];
      getBookmarks(): { type: string }[];
      getItemTitle(item: unknown): string;
    };
    expect(instance.getBookmarks()).toHaveLength(2);
    expect(instance.getItemTitle({ type: "folder", path: "Inbox" })).toBe("Inbox");
    expect(instance.getItemTitle({ type: "group", title: "Reading" })).toBe("Reading");
  });

  it("reports the six absent core plugins with a null instance", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/core-plugins.json": JSON.stringify({
            "file-explorer": true,
            "global-search": true,
            bases: true,
            "file-recovery": true,
            properties: true,
            workspaces: true,
            templates: true,
          }),
        },
      },
    );
    const internal = harness.app.internalPlugins;
    for (const id of [
      "file-explorer",
      "global-search",
      "bases",
      "file-recovery",
      "properties",
      "workspaces",
      "templates",
    ]) {
      expect(internal.getPluginById(id)?.instance, id).toBeNull();
      expect(internal.getEnabledPluginById(id), id).toBeNull();
    }
    expect(internal.getPluginById("file-explorer")?.enabled).toBe(true);
  });

  it("lets folder-notes and tag-wrangler degrade instead of throwing", async () => {
    const harness = await ShimHarness.withVault({});
    const explorer = harness.app.internalPlugins.getEnabledPluginById("file-explorer");
    expect(explorer).toBeNull();
    const search = harness.app.internalPlugins.getPluginById("global-search");
    const query = search?.instance as { getGlobalSearchQuery?(): string } | null;
    expect(query && query.getGlobalSearchQuery && query.getGlobalSearchQuery()).toBeFalsy();
    expect(harness.app.workspace.getLeavesOfType("file-explorer")).toEqual([]);
  });
});
