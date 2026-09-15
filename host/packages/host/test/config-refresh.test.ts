/**
 * What `config_changed` re-reads, and what it deliberately does not.
 *
 * **The premise, corrected against the daemon's real behaviour (Ruling W7).**
 * `config_changed` is raised for writes into the `.obsidian` zone that the
 * daemon itself sees — this host's own raw writes, or another vaultd client's.
 * A GUI Obsidian editing `.obsidian/*.json` is **not** watched, so an event is
 * not the only way a config file changes underneath the host: Task 14's 60 s
 * coexistence poll calls the same `refresh()` for that case. What the cases
 * below pin is the event path and the filter, which is the half this task owns.
 *
 * The third case is the one worth stating out loud: `config_changed` fires for
 * every write into the config zone, a plugin's own `data.json` included, and a
 * registry that re-read four files on each of those would turn one plugin's
 * `saveData` into four `read_file` round trips.
 */

import { describe, expect, it } from "vitest";

import { ShimHarness } from "../src/testing/shim-harness";

describe("config_changed refreshes the config readers", () => {
  it("invalidates the daily-notes options when daily-notes.json is rewritten", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": true }),
          ".obsidian/daily-notes.json": JSON.stringify({ folder: "Old", format: "YYYY", template: "" }),
        },
      },
    );
    const internal = harness.app.internalPlugins;
    const before = internal.getPluginById("daily-notes")?.instance as { options: { folder: string } };
    expect(before.options.folder).toBe("Old");

    // Another vaultd client writes the file; the daemon notices and emits.
    harness.setConfigFile(
      ".obsidian/daily-notes.json",
      JSON.stringify({ folder: "New", format: "YYYY-MM-DD", template: "T.md" }),
    );
    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian/daily-notes.json" },
    });

    const after = internal.getPluginById("daily-notes")?.instance as {
      options: { folder: string; format: string; template: string };
    };
    expect(after.options).toEqual({ folder: "New", format: "YYYY-MM-DD", template: "T.md" });
  });

  it("invalidates the getConfig cache when app.json is rewritten", async () => {
    const harness = await ShimHarness.withVault(
      {},
      { configFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Old" }) } },
    );
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Old");
    harness.setConfigFile(".obsidian/app.json", JSON.stringify({ attachmentFolderPath: "New" }));
    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian/app.json" },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("New");
  });

  it("reads only the file the event names, and coalesces overlapping events", async () => {
    const harness = await ShimHarness.withVault(
      {},
      {
        configFiles: {
          ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": true }),
          ".obsidian/daily-notes.json": JSON.stringify({ folder: "One", format: "YYYY", template: "" }),
          ".obsidian/bookmarks.json": JSON.stringify({ items: [] }),
        },
      },
    );
    const internal = harness.app.internalPlugins;
    harness.clearMethodLog();

    // One named file, one ladder: the host directory's copy and Obsidian's. The
    // other two files are not re-read, because the event says they did not
    // change and the registry still holds their last parse.
    harness.setConfigFile(
      ".obsidian/daily-notes.json",
      JSON.stringify({ folder: "Two", format: "YYYY", template: "" }),
    );
    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian/daily-notes.json" },
    });
    expect(harness.methodsSeen()).toEqual(["read_file", "read_file"]);
    expect(
      (internal.getPluginById("daily-notes")?.instance as { options: { folder: string } }).options
        .folder,
    ).toBe("Two");
    // The untouched files are still answered from the last parse rather than
    // forgotten: a one-file refresh rebuilds the whole map.
    expect(internal.getPluginById("daily-notes")?.enabled).toBe(true);

    // **Overlapping refreshes collapse into one rerun.** The mirror serializes
    // its own events, so the way to reach this is the way Task 14's poll will:
    // `refresh()` called again while one is still in flight. Without the
    // single-flight guard these would interleave two read sequences and
    // whichever *finished* last would install its map — which need not be
    // whichever was *written* last.
    harness.clearMethodLog();
    harness.setConfigFile(
      ".obsidian/daily-notes.json",
      JSON.stringify({ folder: "Three", format: "YYYY", template: "" }),
    );
    harness.setConfigFile(
      ".obsidian/bookmarks.json",
      JSON.stringify({ items: [{ type: "file", path: "A.md" }] }),
    );
    const overlapping = [
      internal.refresh("daily-notes.json"),
      internal.refresh("bookmarks.json"),
      internal.refresh("bookmarks.json"),
    ];
    await Promise.all(overlapping);
    // Every caller's request landed: the first run re-read daily-notes, and the
    // one queued rerun re-read bookmarks once for both callers that asked.
    expect(
      (internal.getPluginById("daily-notes")?.instance as { options: { folder: string } }).options
        .folder,
    ).toBe("Three");
    const bookmarks = internal.getPluginById("bookmarks")?.instance as {
      getBookmarks(): unknown[];
    };
    expect(bookmarks.getBookmarks()).toHaveLength(1);
    // Two ladders, not three: one file per run, and three requests produced two
    // runs. A whole-registry re-read would have cost six round trips per run.
    expect(harness.methodsSeen()).toEqual(["read_file", "read_file", "read_file", "read_file"]);
  });

  it("ignores a config_changed for a plugin data.json", async () => {
    const harness = await ShimHarness.withVault(
      {},
      { configFiles: { ".obsidian/daily-notes.json": JSON.stringify({ folder: "Old" }) } },
    );
    harness.app.internalPlugins.getPluginById("daily-notes");
    harness.clearMethodLog();
    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian-headless/plugins/demo/data.json" },
    });
    // A plugin saving its own settings must not cost four config re-reads.
    expect(harness.methodsSeen()).toEqual([]);
  });
});
