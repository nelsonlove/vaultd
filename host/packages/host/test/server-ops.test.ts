/**
 * The `host.*` operations, driven by a real client over the real socket.
 *
 * Every case here connects, says hello with the nonce, and speaks the same
 * line-delimited JSON a `vaultd` client already speaks — nothing reaches into
 * the server's internals, because what is being asserted is the contract a
 * client sees.
 */

import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

describe("host.* operations", () => {
  it("lists and invokes a harvested command, reporting notices", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.addCommand({
                id: "shout",
                name: "Shout",
                icon: "megaphone",
                callback: () => {
                  new api.Notice("shouted");
                },
              });
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      // snake_case on the wire, without exception. `pluginId`/`localId` are the
      // internal spellings and never leave the process; wire.ts converts.
      await expect(client.call("host.list_commands", {})).resolves.toEqual({
        commands: [
          {
            plugin_id: "demo",
            id: "demo:shout",
            local_id: "shout",
            name: "Shout",
            icon: "megaphone",
            kind: "callback",
            hotkeys: [],
          },
        ],
      });
      const invoked = await client.call<{ ran: boolean; notices: string[]; generation: number }>(
        "host.invoke_command",
        { command_id: "demo:shout" },
      );
      expect(invoked.ran).toBe(true);
      expect(invoked.notices).toEqual(["shouted"]);
      expect(invoked.generation).toBe(harness.mirror.generation());
    } finally {
      await harness.stop();
    }
  });

  it("sets the active file for an editorCallback command", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.addCommand({
                id: "edit",
                name: "Edit",
                editorCallback: (editor: unknown) => {
                  seen.push((editor as { getValue(): string }).getValue());
                },
              });
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.invoke_command", { command_id: "demo:edit", active_file: "A.md" });
      expect(seen).toEqual(["# A\n"]);
      // The same command with no file named is a client error, not a silent
      // `ran: false`: there is no focused editor in a headless host, so the
      // note has to be named and the host says which field is missing.
      await expect(client.call("host.invoke_command", { command_id: "demo:edit" })).rejects.toMatchObject(
        { code: "invalid_request" },
      );
      await expect(
        client.call("host.invoke_command", { command_id: "demo:edit", active_file: "Gone.md" }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await harness.stop();
    }
  });

  it("refuses a quarantined plugin's command with a typed code", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.addCommand({
                id: "boom",
                name: "Boom",
                callback: () => {
                  throw new Error("nope");
                },
              });
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      for (let i = 0; i < 5; i += 1) {
        await client.call("host.invoke_command", { command_id: "demo:boom" }).catch(() => undefined);
      }
      await expect(
        client.call("host.invoke_command", { command_id: "demo:boom" }),
      ).rejects.toMatchObject({ code: "plugin_quarantined" });
      await expect(client.call("host.list_commands", {})).resolves.toEqual({ commands: [] });
      const listed = await client.call<{ plugins: Array<{ id: string; state: string }> }>(
        "host.list_plugins",
        {},
      );
      expect(listed.plugins).toMatchObject([{ id: "demo", state: "quarantined" }]);
    } finally {
      await harness.stop();
    }
  });

  it("forwards a non-host method to vaultd verbatim", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const result = await client.call<{ generation: number }>("get_vault_info", undefined);
      expect(result.generation).toBe(harness.mirror.generation());
      expect(harness.daemonMethodsSeen()).toContain("get_vault_info");
    } finally {
      await harness.stop();
    }
  });

  it("serves snapshot pages from the mirror without touching the daemon", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "Folder/B.md": "# B\n" },
      enabled: [],
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      harness.clearDaemonMethodLog();
      const opened = await client.call<{
        snapshot_id: string;
        entry_count: number;
        note_count: number;
      }>("host.open_snapshot", {});
      expect(opened.entry_count).toBe(3);
      expect(opened.note_count).toBe(2);
      // `entries`, matching vaultd's own SnapshotTreeResponse — a client pages
      // the host exactly as it pages the daemon (Ruling 5).
      const page = await client.call<{
        entries: Array<{ path: string }>;
        next_cursor: string | null;
      }>("host.snapshot_tree", { snapshot_id: opened.snapshot_id, cursor: null, limit: 2 });
      expect(page.entries.map((entry) => entry.path)).toEqual(["A.md", "Folder"]);
      expect(page.entries[0]).toMatchObject({
        kind: "note",
        ctime_unix_ms: expect.any(Number) as unknown,
        mtime_unix_ms: expect.any(Number) as unknown,
      });
      expect(page.next_cursor).not.toBeNull();
      const rest = await client.call<{ entries: Array<{ path: string }>; next_cursor: null }>(
        "host.snapshot_tree",
        { snapshot_id: opened.snapshot_id, cursor: page.next_cursor, limit: 2 },
      );
      expect(rest.entries.map((entry) => entry.path)).toEqual(["Folder/B.md"]);
      expect(rest.next_cursor).toBeNull();
      const notes = await client.call<{ notes: Array<{ path: string; sections?: unknown[] }> }>(
        "host.snapshot_notes",
        {
          snapshot_id: opened.snapshot_id,
          cursor: null,
          limit: 10,
          include: ["metadata", "sections"],
        },
      );
      // sections is a TOP-LEVEL facet, never nested inside metadata.
      expect(notes.notes[0]?.sections).toBeDefined();
      expect(
        (notes.notes[0] as { metadata?: { sections?: unknown } }).metadata?.sections,
      ).toBeUndefined();
      await client.call("host.close_snapshot", { snapshot_id: opened.snapshot_id });
      expect(harness.daemonMethodsSeen()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("refuses a page whose pinned generation the host has moved past", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const opened = await client.call<{ snapshot_id: string }>("host.open_snapshot", {});
      await harness.commitGeneration({ modified: ["A.md"] });
      await expect(
        client.call("host.snapshot_tree", { snapshot_id: opened.snapshot_id, cursor: null }),
      ).rejects.toMatchObject({ code: "generation_mismatch" });
      // The same code and the same tail the daemon sends, so a client's retry
      // loop does not have to know which door the page came through.
      const failure = await client
        .call("host.snapshot_tree", { snapshot_id: opened.snapshot_id, cursor: null })
        .then(
          () => null,
          (error: unknown) => error as { body: { current_generation?: number } },
        );
      expect(failure?.body.current_generation).toBe(harness.mirror.generation());
    } finally {
      await harness.stop();
    }
  });

  it("answers host_not_ready for the ops Task 20b wires, until it does", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      config: { wireLateOps: false },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      for (const method of [
        "host.attach_interaction",
        "host.detach_interaction",
        "host.get_plugin_config",
        "host.set_plugin_config",
        "host.compat_report",
        "host.respond_interaction",
      ]) {
        await expect(client.call(method, { id: "demo" })).rejects.toMatchObject({
          code: "host_not_ready",
        });
      }
    } finally {
      await harness.stop();
    }
  });

  it("answers host_not_ready for plugin ops until the host is steady", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const client = await harness.connectClient();
      // `host.hello` already answered — a client that has just connected has to
      // be able to ask what is going on *because* something is wrong.
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
      await expect(client.call("host.list_commands", {})).rejects.toMatchObject({
        code: "host_not_ready",
      });
    } finally {
      await harness.stop();
    }
  });

  it("returns typed errors for unknown ids", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await expect(
        client.call("host.invoke_command", { command_id: "nope:nope" }),
      ).rejects.toMatchObject({ code: "command_not_found" });
      await expect(client.call("host.enable_plugin", { id: "not-installed" })).rejects.toMatchObject(
        { code: "plugin_not_installed" },
      );
      await expect(
        client.call("host.snapshot_tree", { snapshot_id: "gone", cursor: null }),
      ).rejects.toMatchObject({ code: "snapshot_not_found" });
      await expect(client.call("host.nonesuch", {})).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.stop();
    }
  });

  it("enables and disables an installed plugin, reporting the state it reached", async () => {
    const loaded: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              loaded.push("demo");
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({
        plugins: [{ id: "demo", state: "disabled" }],
      });
      await expect(client.call("host.enable_plugin", { id: "demo" })).resolves.toEqual({
        id: "demo",
        state: "loaded",
      });
      expect(loaded).toEqual(["demo"]);
      // The enabled set was written, so the plugin is still enabled after a
      // restart rather than only for this session.
      expect(
        JSON.parse(
          harness.writtenFile(`${harness.config.configDirName}/community-plugins.json`) ?? "null",
        ),
      ).toEqual(["demo"]);
      await expect(client.call("host.disable_plugin", { id: "demo" })).resolves.toEqual({
        id: "demo",
        state: "disabled",
      });
    } finally {
      await harness.stop();
    }
  });

  it("refuses a plugin the GUI is already running, and honours force_shared", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      guiEnabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await expect(client.call("host.enable_plugin", { id: "demo" })).rejects.toMatchObject({
        code: "overlap_refused",
      });
      await expect(
        client.call("host.enable_plugin", { id: "demo", force_shared: true }),
      ).resolves.toEqual({ id: "demo", state: "loaded" });
    } finally {
      await harness.stop();
    }
  });

  it("lists and invokes a harvested menu item and a protocol handler", async () => {
    const chosen: string[] = [];
    const delivered: Array<Record<string, string>> = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.workspace.on("file-menu", (menu: unknown, file: unknown) => {
                  const path = (file as { path: string }).path;
                  (menu as { addItem(cb: (item: unknown) => void): void }).addItem((item) => {
                    const typed = item as {
                      setTitle(t: string): unknown;
                      setIcon(i: string): unknown;
                      onClick(cb: () => void): unknown;
                    };
                    typed.setTitle(`Bless ${path}`);
                    typed.setIcon("sparkle");
                    typed.onClick(() => {
                      chosen.push(path);
                      new api.Notice("blessed");
                    });
                  });
                }),
              );
              this.registerObsidianProtocolHandler("bless", (params) => {
                delivered.push(params);
              });
              await Promise.resolve();
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const menu = await client.call<{ items: Array<Record<string, unknown>> }>(
        "host.list_menu_items",
        { context: "file-menu", path: "A.md" },
      );
      expect(menu.items).toEqual([
        {
          hook_id: "demo:file-menu:0",
          plugin_id: "demo",
          id: "demo:file-menu:0:0",
          title: "Bless A.md",
          icon: "sparkle",
          section: null,
          checked: null,
        },
      ]);
      const invoked = await client.call<{ notices: string[] }>("host.invoke_menu_item", {
        item_id: "demo:file-menu:0:0",
        path: "A.md",
      });
      expect(chosen).toEqual(["A.md"]);
      expect(invoked.notices).toEqual(["blessed"]);

      await expect(client.call("host.list_protocol_handlers", {})).resolves.toEqual({
        handlers: [{ plugin_id: "demo", action: "bless" }],
      });
      await client.call("host.invoke_protocol", { action: "bless", params: { note: "A.md" } });
      // `{ action, ...params }` is the shape Obsidian hands a handler, and
      // plugins read the action out of the params object.
      expect(delivered).toEqual([{ action: "bless", note: "A.md" }]);

      await expect(
        client.call("host.invoke_menu_item", { item_id: "demo:file-menu:9:0", path: "A.md" }),
      ).rejects.toMatchObject({ code: "menu_item_not_found" });
      await expect(client.call("host.invoke_protocol", { action: "nope" })).rejects.toMatchObject({
        code: "protocol_handler_not_found",
      });
    } finally {
      await harness.stop();
    }
  });

  it("reports the host's own state through hello and info", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const hello = await client.call<Record<string, unknown>>("host.hello", undefined).catch(
        // A second hello on one connection is refused; the first one's payload
        // is what `connectClient` already consumed, so this asserts on `info`.
        () => null,
      );
      expect(hello).toBeNull();
      const info = await client.call<{
        overlap: { gui_readable: boolean; overlap_poll_ms: number } | null;
        counters: Record<string, unknown>;
        timers: unknown[];
        unsupported: unknown[];
      }>("host.info", { refresh: true });
      expect(info.overlap).toMatchObject({
        gui_readable: false,
        overlap_poll_ms: harness.config.overlapPollMs,
      });
      expect(info.counters).toMatchObject({
        generation: harness.mirror.generation(),
        resync_count: 0,
        resyncs_by_reason: {},
      });
      expect(Array.isArray(info.timers)).toBe(true);
      expect(Array.isArray(info.unsupported)).toBe(true);
    } finally {
      await harness.stop();
    }
  });
});
