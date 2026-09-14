/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test: the host has to await whatever
 * `onload` returns, or it would answer its first request against a plugin whose
 * registrations had not landed. Rewriting these as synchronous to satisfy the
 * rule would test the one case that needs no awaiting.
 */

/**
 * The `Plugin` base class, as a plugin's own `onload` and its teardown meet it.
 *
 * Every case here is about a failure a headless host can only make once: a
 * registration that throws inside `onload` kills the plugin before its useful
 * half loads, a `loadData` that reached the GUI's copy would make two hosts
 * share state they were separated to avoid, an interval nobody recorded is an
 * idle cost nobody can debug, and a teardown that stops half-way leaves a
 * quarantined plugin still listening, still firing and still invokable.
 *
 * The teardown order — children, `register()` callbacks in reverse, event refs,
 * timers, and `onunload` **last** — is the fix-round-1 ruling, and it is pinned
 * here because the ordering is the whole reason the guard around it works: a
 * plugin's `onunload` runs after its own listeners and timers are already gone,
 * so it cannot re-enter itself on the way out.
 */

import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";
import type { Command } from "../src/shim/plugin";

describe("Plugin base", () => {
  it("accepts and discards the registrations that must never throw", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerView("demo-view", () => ({}));
          // A null-prototype object has no `constructor`, which is the one
          // shape that used to throw out of the set of calls whose whole
          // purpose is never to throw inside `onload`.
          this.registerEditorExtension(Object.create(null) as unknown);
          this.registerMarkdownPostProcessor(() => {});
          this.registerMarkdownCodeBlockProcessor("demo", () => {});
          this.registerEditorSuggest({});
          this.registerHoverLinkSource("demo", {});
          this.registerDomEvent(harness.api.activeDocument, "click", () => {});
          this.register(() => {});
        }
      },
    );
    await expect(harness.load(plugin)).resolves.toBeUndefined();
    expect(harness.harvest.unreachable().map((u) => u.kind).sort()).toEqual([
      "code_block_processor",
      "editor_extension",
      "editor_suggest",
      "view",
    ]);
    expect(harness.hostErrors).toEqual([]);
  });

  it("round-trips loadData and saveData inside the host config dir", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {});
    await expect(plugin.loadData()).resolves.toBeNull();
    const saving = plugin.saveData({ enabled: true });
    const sent = await harness.nextRequest();
    expect(sent.request).toMatchObject({
      method: "write_file",
      params: { path: ".obsidian-headless/plugins/demo/data.json" },
    });
    const written = JSON.parse(
      Buffer.from(
        (sent.request.params as { content_base64: string }).content_base64,
        "base64",
      ).toString("utf8"),
    ) as unknown;
    expect(written).toEqual({ enabled: true });
    harness.respondOk(sent.id, "write_file", { revision: "blake3:d1", semantic: false });
    await saving;
  });

  it("answers null for a data.json that is not JSON, and reports it", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {});
    // Served rather than absent: the file is there, and its bytes are not JSON.
    harness.setConfigFile(".obsidian-headless/plugins/demo/data.json", "{not json");
    // `null`, not a throw: a throw here happens inside `onload` and kills the
    // whole plugin over one bad byte in a settings file.
    await expect(plugin.loadData()).resolves.toBeNull();
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["demo", "plugin-data"],
    ]);
  });

  it("records every interval with its cadence and clears them on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "ticker",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerInterval(harness.api.window.setInterval(() => {}, 200));
          this.registerInterval(harness.api.window.setInterval(() => {}, 30_000));
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.timers().map((t) => t.intervalMs)).toEqual([200, 30_000]);
    expect(harness.activeTimerCount()).toBe(2);
    await harness.unload("ticker");
    expect(harness.harvest.timers()).toEqual([]);
    expect(harness.activeTimerCount()).toBe(0);
  });

  it("clears an interval the shim did not arm, and harvests its cadence as unknown", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "reacher",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          // A bundle that reached around the shim for its timer. The id is not
          // one the shim's `window` handed out, so there is no cadence to read
          // back — but it still has to stop firing when the plugin unloads.
          this.registerInterval(harness.clock.setInterval(() => {}, 500) as unknown as number);
        }
      },
    );
    await harness.load(plugin);
    expect(harness.harvest.timers().map((t) => t.intervalMs)).toEqual([null]);
    expect(harness.activeTimerCount()).toBe(1);
    await harness.unload("reacher");
    expect(harness.activeTimerCount()).toBe(0);
  });

  it("tears down in the ruled order, and only once", async () => {
    const harness = await ShimHarness.withVault({});
    const order: string[] = [];
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.register(() => order.push("first"));
          this.register(() => order.push("second"));
          this.registerEvent(harness.app.vault.on("create", () => {}));
        }
        override onunload(): void {
          order.push("onunload");
        }
      },
    );
    await harness.load(plugin);
    expect(harness.bus.count("vault:create")).toBe(1);
    await harness.unload("demo");
    // Reverse registration order, and `onunload` last: the plugin's own hook
    // runs in a world its listeners and timers have already left.
    expect(order).toEqual(["second", "first", "onunload"]);
    await harness.unload("demo");
    expect(order).toEqual(["second", "first", "onunload"]);
  });

  it("detaches its own listeners when unloaded directly, with nobody telling the bus", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "solo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerEvent(harness.app.vault.on("create", () => {}));
        }
      },
    );
    await harness.load(plugin);
    expect(harness.bus.count("vault:create")).toBe(1);
    // Not through the harness: `harness.unload` also calls `detachOwner`, which
    // would clear the listener whether or not the component ever detached it.
    plugin.unload();
    expect(harness.bus.count("vault:create")).toBe(0);
    plugin.unload();
    expect(harness.bus.count("vault:create")).toBe(0);
  });

  it("finishes the whole teardown when onunload throws, and reports it", async () => {
    const harness = await ShimHarness.withVault({});
    const order: string[] = [];
    class Child extends harness.api.Component {
      override onunload(): void {
        order.push("child");
      }
    }
    const plugin = harness.instantiate(
      "boom",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.addChild(new Child());
          this.register(() => order.push("registered"));
          this.registerEvent(harness.app.vault.on("create", () => {}));
          this.registerInterval(harness.api.window.setInterval(() => {}, 1_000));
          this.addCommand({ id: "a", name: "A", callback: () => {} });
        }
        override onunload(): void {
          order.push("onunload");
          throw new Error("teardown blew up");
        }
      },
    );
    await harness.load(plugin);
    // The throw never escapes: a quarantine unloading a misbehaving plugin is
    // exactly the case this path exists for.
    await expect(harness.unload("boom")).resolves.toBeUndefined();
    expect(order).toEqual(["child", "registered", "onunload"]);
    expect(harness.bus.count("vault:create")).toBe(0);
    expect(harness.activeTimerCount()).toBe(0);
    expect(harness.harvest.commands()).toEqual([]);
    expect(harness.harvest.timers()).toEqual([]);
    expect(harness.hostErrors.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["boom", "onunload"],
    ]);
    // Idempotent even after a throw: nothing runs a second time, and nothing is
    // reported a second time.
    await harness.unload("boom");
    expect(order).toEqual(["child", "registered", "onunload"]);
    expect(harness.hostErrors).toHaveLength(1);
  });

  it("withdraws its commands from the registry when it unloads", async () => {
    const harness = await ShimHarness.withVault({});
    // Task 12 builds the real `CommandRegistry`; what the delegation needs is
    // an object with `addCommand`/`removeCommand`, so a case can pin both
    // halves before that task lands.
    const registry = new Map<string, Command>();
    (harness.app as { commands?: unknown }).commands = {
      addCommand(command: Command): void {
        registry.set(command.id, command);
      },
      removeCommand(id: string): void {
        registry.delete(id);
      },
    };
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.addCommand({ id: "a", name: "A", callback: () => {} });
          this.addCommand({ id: "b", name: "B", callback: () => {} });
        }
      },
    );
    await harness.load(plugin);
    expect([...registry.keys()]).toEqual(["demo:a", "demo:b"]);
    await harness.unload("demo");
    expect([...registry.keys()]).toEqual([]);
  });
});
