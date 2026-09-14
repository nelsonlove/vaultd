/**
 * The `Plugin` base class, as a plugin's own `onload` meets it.
 *
 * Four claims, and every one of them is about a failure a headless host can
 * only make once: a registration that throws inside `onload` kills the plugin
 * before its useful half loads, a `loadData` that reached the GUI's copy would
 * make the two hosts share state they were separated to avoid, an interval
 * nobody recorded is an idle cost nobody can debug, and a teardown that runs
 * twice is a plugin whose `onunload` sees a world it already dismantled.
 */

/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test: the host has to await whatever
 * `onload` returns, or it would answer its first request against a plugin whose
 * registrations had not landed. Rewriting these as synchronous to satisfy the
 * rule would test the one case that needs no awaiting.
 */

import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Plugin base", () => {
  it("accepts and discards the registrations that must never throw", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.registerView("demo-view", () => ({}));
          this.registerEditorExtension({});
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
    expect(harness.harvest.timers().map((t) => t.intervalMs).sort((a, b) => a - b)).toEqual([
      200, 30_000,
    ]);
    await harness.unload("ticker");
    expect(harness.harvest.timers()).toEqual([]);
    expect(harness.activeTimerCount()).toBe(0);
  });

  it("runs every registered teardown exactly once on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const order: string[] = [];
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          this.register(() => order.push("registered"));
          this.registerEvent(harness.app.vault.on("create", () => {}));
        }
        override onunload(): void {
          order.push("onunload");
        }
      },
    );
    await harness.load(plugin);
    await harness.unload("demo");
    await harness.unload("demo");
    expect(order).toEqual(["onunload", "registered"]);
  });
});
