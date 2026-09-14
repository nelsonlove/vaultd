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
 * `onClick` closure both depend on the file the menu was opened over.
 */

/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test: the host has to await whatever
 * `onload` returns, or it would answer its first request against a plugin whose
 * registrations had not landed. Rewriting these as synchronous to satisfy the
 * rule would test the one case that needs no awaiting.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { warmFixtureCache } from "../src/testing/fixture-vault";
import { ShimHarness } from "../src/testing/shim-harness";

/** The one fixture in this file whose note has to be really parsed. */
const MENU_VAULT = { "A.md": "x\n" };

beforeAll(() => {
  warmFixtureCache([{ path: "A.md", source: MENU_VAULT["A.md"] }]);
}, 300_000);

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
              (menu as { addItem(cb: (item: unknown) => void): void }).addItem((item) => {
                const typed = item as {
                  setTitle(t: string): unknown;
                  setIcon(i: string): unknown;
                  onClick(cb: () => void): unknown;
                };
                typed.setTitle(`Do it to ${(file as { path: string }).path}`);
                typed.setIcon("wand");
                typed.onClick(() => chosen.push("clicked"));
              });
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
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.addCommand({ id: "a", name: "A", callback: () => {} });
          this.registerObsidianProtocolHandler("go", () => {});
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.commands()).toHaveLength(1);
    harness.harvest.forgetPlugin("demo");
    expect(harness.harvest.commands()).toEqual([]);
    expect(harness.harvest.protocolHandlers()).toEqual([]);
  });
});
