/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test: the host has to await whatever
 * `onload` returns, or it would answer its first request against a plugin whose
 * registrations had not landed. Rewriting these as synchronous to satisfy the
 * rule would test the one case that needs no awaiting.
 */

/**
 * The harvest: every registration a plugin makes, recorded as something the
 * host can actually invoke.
 *
 * This is the payoff of the whole shim. A GUI-less Obsidian cannot show a
 * command palette, a context menu, or a ribbon, so the only honest thing to do
 * with a registration is to write down what it was and keep whatever the plugin
 * handed over — the callback, the item's title, the protocol action — so that
 * something outside the process can ask for it by name later.
 *
 * The menu round trip is the case worth reading twice: the items are rebuilt
 * per listing and per invocation, because a plugin's item text and its
 * `onClick` closure both depend on the file the menu was opened over. And a
 * hook the plugin has **withdrawn** must stop building items by every route it
 * can be withdrawn through, or the host reports a capability nobody offers.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { warmFixtureCache } from "../src/testing/fixture-vault";
import { ShimHarness } from "../src/testing/shim-harness";
import type { EventCallback } from "../src/shim/events";

/** The one fixture in this file whose note has to be really parsed. */
const MENU_VAULT = { "A.md": "x\n" };

beforeAll(() => {
  warmFixtureCache([{ path: "A.md", source: MENU_VAULT["A.md"] }]);
}, 300_000);

/** What a plugin does inside a menu hook, spelled once. */
function addItem(menu: unknown, title: string, onClick: () => void): void {
  (menu as { addItem(cb: (item: unknown) => void): void }).addItem((item) => {
    const typed = item as {
      setTitle(t: string): unknown;
      setIcon(i: string): unknown;
      onClick(cb: () => void): unknown;
    };
    typed.setTitle(title);
    typed.setIcon("wand");
    typed.onClick(onClick);
  });
}

describe("Harvest", () => {
  it("records commands with fully qualified ids and their callback kind", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.addCommand({ id: "plain", name: "Plain", icon: "star", callback: () => {} });
          this.addCommand({ id: "checked", name: "Checked", checkCallback: () => true });
          this.addCommand({ id: "edit", name: "Edit", editorCallback: () => {} });
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.commands()).toEqual([
      {
        pluginId: "demo",
        id: "demo:plain",
        localId: "plain",
        name: "Plain",
        icon: "star",
        kind: "callback",
        hotkeys: [],
      },
      {
        pluginId: "demo",
        id: "demo:checked",
        localId: "checked",
        name: "Checked",
        icon: null,
        kind: "checkCallback",
        hotkeys: [],
      },
      {
        pluginId: "demo",
        id: "demo:edit",
        localId: "edit",
        name: "Edit",
        icon: null,
        kind: "editorCallback",
        hotkeys: [],
      },
    ]);
  });

  it("harvests a real file-menu hook into invokable items", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const chosen: string[] = [];
    const plugin = harness.instantiate(
      "menus",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
              addItem(menu, `Do it to ${(file as { path: string }).path}`, () =>
                chosen.push("clicked"),
              );
            }),
          );
        }
      },
    );
    await harness.load(plugin);
    const items = await harness.listMenuItems("file-menu", "A.md");
    expect(items).toEqual([
      {
        hookId: "menus:file-menu:0",
        pluginId: "menus",
        id: "menus:file-menu:0:0",
        title: "Do it to A.md",
        icon: "wand",
        section: null,
        checked: null,
      },
    ]);
    await harness.invokeMenuItem("menus:file-menu:0:0", "A.md");
    expect(chosen).toEqual(["clicked"]);
  });

  it("gives a plugin's second hook the next ordinal, and lists both", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const plugin = harness.instantiate(
      "two",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu) => {
              addItem(menu, "from the first hook", () => {});
            }),
          );
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu) => {
              addItem(menu, "from the second hook", () => {});
            }),
          );
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.menuHooks().map((hook) => hook.id)).toEqual([
      "two:file-menu:0",
      "two:file-menu:1",
    ]);
    const items = await harness.listMenuItems("file-menu", "A.md");
    expect(items.map((item) => [item.id, item.title])).toEqual([
      ["two:file-menu:0:0", "from the first hook"],
      ["two:file-menu:1:0", "from the second hook"],
    ]);
  });

  it("does not spend an item ordinal on a separator", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const chosen: string[] = [];
    const plugin = harness.instantiate(
      "sep",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu) => {
              addItem(menu, "above", () => chosen.push("above"));
              (menu as { addSeparator(): void }).addSeparator();
              addItem(menu, "below", () => chosen.push("below"));
            }),
          );
        }
      },
    );
    await harness.load(plugin);
    const items = await harness.listMenuItems("file-menu", "A.md");
    expect(items.map((item) => [item.id, item.title])).toEqual([
      ["sep:file-menu:0:0", "above"],
      ["sep:file-menu:0:1", "below"],
    ]);
    // The ordinal a caller was given has to still name the item it listed: a
    // recorded separator would shift everything after it by one.
    await harness.invokeMenuItem("sep:file-menu:0:1", "A.md");
    expect(chosen).toEqual(["below"]);
  });

  it("stops building a hook's items once the plugin takes the listener off", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const hook = ((menu: unknown): void => {
      addItem(menu, "withdrawn", () => {});
    }) as unknown as EventCallback;
    const plugin = harness.instantiate(
      "offs",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(this.app.workspace.on("file-menu", hook));
        }
      },
    );
    await harness.load(plugin);
    expect(await harness.listMenuItems("file-menu", "A.md")).toHaveLength(1);
    // `off(name, callback)` is the third way to withdraw a listener — the two
    // the ref carries are the easy ones — and the harvest has to follow it.
    harness.app.workspace.off("file-menu", hook);
    expect(harness.harvest.menuHooks()).toEqual([]);
    expect(await harness.listMenuItems("file-menu", "A.md")).toEqual([]);
  });

  it("reports a menu hook that throws, and still builds the other plugin's items", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const thrower = harness.instantiate(
      "thrower",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(
            this.app.workspace.on("file-menu", () => {
              throw new Error("hook blew up");
            }),
          );
        }
      },
    );
    const quiet = harness.instantiate(
      "quiet",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu) => {
              addItem(menu, "still here", () => {});
            }),
          );
        }
      },
    );
    await harness.load(thrower);
    await harness.load(quiet);
    const items = await harness.listMenuItems("file-menu", "A.md");
    expect(items.map((item) => item.title)).toEqual(["still here"]);
    // Attributed, not swallowed: a quarantine cannot act on a failure it is
    // never told about.
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["thrower", "menu-hook"],
    ]);
  });

  it("harvests a protocol handler and invokes it with its params", async () => {
    const harness = await ShimHarness.withVault({});
    const received: Array<Record<string, string>> = [];
    const plugin = harness.instantiate(
      "proto",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerObsidianProtocolHandler("run", (params) => {
            received.push(params);
          });
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.protocolHandlers()).toEqual([{ pluginId: "proto", action: "run" }]);
    await harness.invokeProtocol("run", { choice: "Daily", value: "x" });
    expect(received).toEqual([{ action: "run", choice: "Daily", value: "x" }]);
  });

  it("forgets a quarantined plugin's whole harvest", async () => {
    const harness = await ShimHarness.withVault(MENU_VAULT);
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.addCommand({ id: "a", name: "A", callback: () => {} });
          this.registerObsidianProtocolHandler("go", () => {});
          this.registerEvent(
            this.app.workspace.on("file-menu", (menu) => {
              addItem(menu, "gone soon", () => {});
            }),
          );
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.commands()).toHaveLength(1);
    // Through the unload path rather than by calling `forgetPlugin` directly:
    // the quarantine is the caller that matters, and what it has to leave
    // behind is nothing at all.
    await harness.unload("demo");
    expect(harness.harvest.commands()).toEqual([]);
    expect(harness.harvest.protocolHandlers()).toEqual([]);
    expect(harness.harvest.menuHooks()).toEqual([]);
    expect(await harness.listMenuItems("file-menu", "A.md")).toEqual([]);
    expect(harness.bus.count()).toBe(0);
  });
});
