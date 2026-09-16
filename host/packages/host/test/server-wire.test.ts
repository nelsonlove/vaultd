/**
 * Every field name on the host socket is `snake_case`, without exception.
 *
 * The converters are asserted one at a time — key set and casing — and then the
 * same predicate is walked recursively over a **live** `host.info` response.
 * That last case is the one that matters: it is what catches a field somebody
 * adds to a response next year and forgets to convert, which no per-function
 * test can see because the function they added it to is the one they wrote.
 */

import { describe, expect, it } from "vitest";

import { ClientSubscriptions } from "../src/server/subscriptions";
import { HostHarness } from "../src/testing/host-harness";
import {
  toWireCommand,
  toWireMenuItem,
  toWireNotice,
  toWireOverlap,
  toWirePluginState,
  toWirePolicyUse,
  toWireProtocolHandler,
  toWireSettingTab,
  toWireTimer,
  toWireTreeEntry,
  toWireUnreachable,
} from "../src/server/wire";
import type { HarvestedCommand, HarvestedMenuItem } from "../src/shim/harvest";
import type { MirrorEntry } from "../src/mirror/types";
import type { OverlapReport } from "../src/pluginset/coexistence";
import type { PluginSettingTab } from "../src/shim/plugin";

const noCamelCase = (value: unknown, path = "$"): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => noCamelCase(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key, `${path}.${key}`).not.toMatch(/[a-z][A-Z]/);
    noCamelCase(child, `${path}.${key}`);
  }
};

const command: HarvestedCommand = {
  pluginId: "demo",
  id: "demo:shout",
  localId: "shout",
  name: "Shout",
  icon: "megaphone",
  kind: "editorCallback",
  hotkeys: [{ modifiers: ["Mod"], key: "K" }],
};

const menuItem: HarvestedMenuItem = {
  hookId: "demo:file-menu:0",
  pluginId: "demo",
  id: "demo:file-menu:0:1",
  title: "Bless",
  icon: null,
  section: "danger",
  checked: true,
};

const overlap: OverlapReport = {
  hostEnabled: ["demo"],
  guiEnabled: ["demo", "other"],
  overlap: ["demo"],
  forced: [],
  guiReadable: true,
  checkedAtMs: 1_700_000_000_000,
};

const noteEntry: MirrorEntry = {
  path: "Folder/Note.md",
  kind: "note",
  name: "Note.md",
  parent: "Folder",
  revision: "blake3:0f2c",
  size: 24,
  ctimeMs: 1_756_100_000_000,
  mtimeMs: 1_756_100_000_001,
};

const folderEntry: MirrorEntry = {
  path: "Folder",
  kind: "folder",
  name: "Folder",
  parent: "",
  revision: null,
  size: null,
  ctimeMs: 1_756_100_000_000,
  mtimeMs: 1_756_100_000_000,
};

describe("the wire converts every shape to snake_case", () => {
  it("converts a plugin state", () => {
    const wire = toWirePluginState({
      id: "demo",
      name: "Demo",
      version: "1.2.3",
      state: "loaded",
      loadMs: 12,
      failureCount: 0,
      reason: null,
    });
    expect(Object.keys(wire).sort()).toEqual([
      "failure_count",
      "id",
      "load_ms",
      "name",
      "reason",
      "state",
      "version",
    ]);
    noCamelCase(wire);
  });

  it("converts a harvested command, hotkeys and all", () => {
    const wire = toWireCommand(command);
    expect(Object.keys(wire).sort()).toEqual([
      "hotkeys",
      "icon",
      "id",
      "kind",
      "local_id",
      "name",
      "plugin_id",
    ]);
    expect(wire.hotkeys).toEqual([{ modifiers: ["Mod"], key: "K" }]);
    // Copied, not aliased: a client's decoded array must not be host state.
    expect(wire.hotkeys[0]?.modifiers).not.toBe(command.hotkeys[0]?.modifiers);
    noCamelCase(wire);
  });

  it("converts a harvested menu item", () => {
    const wire = toWireMenuItem(menuItem);
    expect(Object.keys(wire).sort()).toEqual([
      "checked",
      "hook_id",
      "icon",
      "id",
      "plugin_id",
      "section",
      "title",
    ]);
    noCamelCase(wire);
  });

  it("converts an overlap report", () => {
    const wire = toWireOverlap(overlap);
    expect(Object.keys(wire).sort()).toEqual([
      "checked_at_ms",
      "forced",
      "gui_enabled",
      "gui_readable",
      "host_enabled",
      "overlap",
    ]);
    noCamelCase(wire);
  });

  it("converts a tree entry, omitting what a row does not have", () => {
    const note = toWireTreeEntry(noteEntry);
    expect(Object.keys(note).sort()).toEqual([
      "ctime_unix_ms",
      "kind",
      "mtime_unix_ms",
      "path",
      "revision",
      "size",
    ]);
    // A folder carries neither `size` nor `revision`, and absent is spelled by
    // omission rather than by `null` — the daemon's own shape.
    const folder = toWireTreeEntry(folderEntry);
    expect(Object.keys(folder).sort()).toEqual(["ctime_unix_ms", "kind", "mtime_unix_ms", "path"]);
    expect("revision" in folder).toBe(false);
    noCamelCase(note);
    noCamelCase(folder);
  });

  it("converts the smaller rows, and never carries a live object", () => {
    expect(toWireProtocolHandler({ pluginId: "demo", action: "bless" })).toEqual({
      plugin_id: "demo",
      action: "bless",
    });
    expect(toWireTimer({ pluginId: "demo", intervalMs: null, createdAt: 7 })).toEqual({
      plugin_id: "demo",
      interval_ms: null,
      created_at: 7,
    });
    expect(
      toWireUnreachable({ pluginId: "demo", kind: "dom_listener", detail: "contextmenu" }),
    ).toEqual({ plugin_id: "demo", kind: "dom_listener", detail: "contextmenu" });
    expect(
      toWireNotice({ pluginId: null, message: "hello", atUnixMs: 3, timeoutMs: null }),
    ).toEqual({ plugin_id: null, message: "hello", at_unix_ms: 3 });
    expect(
      toWirePolicyUse({ symbol: "Modal.open", policy: "absent", pluginId: "demo", hits: 4 }),
    ).toEqual({ symbol: "Modal.open", policy: "absent", plugin_id: "demo", hits: 4 });
    // The setting tab's row is `{ plugin_id, has_setting_definitions }` and
    // nothing else, so the plugin's live `PluginSettingTab` instance — which the
    // harvest really holds, for Task 17's schema ladder — never leaves the
    // process.
    const tab = toWireSettingTab({
      pluginId: "demo",
      hasSettingDefinitions: true,
      tab: { marker: "live object" } as unknown as PluginSettingTab,
    });
    expect(tab).toEqual({ plugin_id: "demo", has_setting_definitions: true });
    expect(JSON.stringify(tab)).not.toContain("live object");
  });

  it("finds no camelCase key in any event this host can emit", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      guiEnabled: [],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              new api.Notice("hello from demo");
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});

      // Every daemon-shaped event, relayed.
      harness.server.relayDaemonEvent({
        type: "runtime_state_changed",
        value: { generation: 1, live_state: "watching" },
      });
      harness.server.relayDaemonEvent({
        type: "resync_required",
        value: { current_generation: 1, reason: "watcher_overflow" },
      });
      // `config_changed` comes from the mirror's own seam rather than the relay,
      // so it is driven the way a real one arrives.
      await harness.mirror.applyEvent({
        type: "config_changed",
        value: { path: ".obsidian/app.json" },
      });
      // `generation_committed`, held by the relay and released by the mirror.
      await harness.commitGeneration({ modified: ["A.md"] });
      // `host.plugin_state_changed` and `host.notice`, from the enable.
      await client.call("host.enable_plugin", { id: "demo" });
      // `host.overlap_changed`: the first reading changes nothing, the second is
      // a genuinely different overlap set.
      await client.call("host.info", { refresh: true });
      harness.setGuiEnabled(["demo"]);
      await client.call("host.info", { refresh: true });

      const events = await client.drainEvents();
      const types = new Set(events.map((event) => event.type));
      expect([...types].sort()).toEqual([
        "config_changed",
        "generation_committed",
        "host.notice",
        "host.overlap_changed",
        "host.plugin_state_changed",
        "resync_required",
        "runtime_state_changed",
      ]);
      for (const event of events) noCamelCase(event, `$.${event.type}`);

      // The one event no daemon sends and no plugin raises: the collapse this
      // host synthesizes for a subscriber that fell behind. Driven through the
      // queue directly, because forcing it over a socket is what
      // `server-subscriptions.test.ts` is for.
      const written: string[] = [];
      let backedUp = true;
      let drain: (() => void) | null = null;
      const subscriptions = new ClientSubscriptions({
        limit: 1,
        currentGeneration: () => 12,
        mintId: () => "s-1",
        writer: {
          write: (line) => {
            written.push(line);
            return !backedUp;
          },
          onceDrain: (listener) => {
            drain = listener;
          },
        },
      });
      subscriptions.open();
      for (let i = 0; i < 4; i += 1) {
        subscriptions.deliver({ type: "generation_committed", value: { generation: i } });
      }
      backedUp = false;
      (drain as unknown as () => void)();
      const collapse = written
        .map((line) => JSON.parse(line) as { event: { type: string } })
        .find((frame) => frame.event.type === "resync_required");
      expect(collapse).toBeDefined();
      noCamelCase(collapse);
    } finally {
      await harness.stop();
    }
  });

  it("finds no camelCase key at any depth of a live host.info", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.addCommand({ id: "shout", name: "Shout", callback: () => undefined });
              this.registerInterval(
                (globalThis as unknown as { window: { setInterval: typeof setInterval } }).window.setInterval(
                  () => undefined,
                  1_000,
                ) as unknown as number,
              );
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const info = await client.call("host.info", { refresh: true });
      // The fixture is chosen so the walk has something to walk: a plugin row, a
      // harvested timer and an overlap reading are all present.
      const body = info as { plugins: unknown[]; timers: unknown[]; overlap: unknown };
      expect(body.plugins.length).toBeGreaterThan(0);
      expect(body.timers.length).toBeGreaterThan(0);
      expect(body.overlap).not.toBeNull();
      noCamelCase(info);
      noCamelCase(client.helloPayload(), "$.hello");
      noCamelCase(await client.call("host.list_commands", {}));
      noCamelCase(await client.call("host.list_plugins", {}));
      noCamelCase(await client.call("host.list_menu_items", { context: "file-menu", path: "A.md" }));
      noCamelCase(await client.call("host.list_protocol_handlers", {}));
      const opened = await client.call<{ snapshot_id: string }>("host.open_snapshot", {});
      noCamelCase(opened);
      // **The two pages are the biggest payloads on this socket**, and the notes
      // page with every facet asked for is the deepest: six facet arrays of
      // daemon DTOs, two of which are renamed on the way out (`list_items`,
      // `references`). A walk that stopped at `host.info` would never have seen
      // them.
      noCamelCase(
        await client.call("host.snapshot_tree", { snapshot_id: opened.snapshot_id, cursor: null }),
        "$.snapshot_tree",
      );
      noCamelCase(
        await client.call("host.snapshot_notes", {
          snapshot_id: opened.snapshot_id,
          cursor: null,
          include: ["metadata", "references", "resolutions", "backlinks", "sections", "list_items"],
        }),
        "$.snapshot_notes",
      );
    } finally {
      await harness.stop();
    }
  });
});
