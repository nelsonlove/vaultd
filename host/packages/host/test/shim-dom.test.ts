/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test here too: the hits the last case
 * counts are recorded while the host is awaiting whatever `onload` returns.
 * Rewriting it as synchronous to satisfy the rule would test a different thing.
 */

/**
 * The DOM that is not there, and the globals a plugin bundle reads before it is
 * ever instantiated.
 *
 * There is no jsdom here on purpose: a host that behaved *almost* like a
 * browser would hide exactly the cases the compatibility report exists to
 * surface. What these cases pin is that the chain a settings tab builds cannot
 * throw, that every query answers with an empty collection rather than
 * `undefined`, and that the handful of globals the corpus reads at module scope
 * — `app`, `moment`, `i18next`, `MutationObserver` — are installed before any
 * bundle runs.
 */

import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("DOM stubs", () => {
  it("swallows the whole createEl chain a settings tab builds", async () => {
    const harness = await ShimHarness.withVault({});
    const root = harness.api.createDiv({ cls: "panel" });
    const heading = root.createEl("h2", { text: "Title" });
    heading.addClass("big").setAttr("data-x", "1");
    const child = root.createDiv().createSpan({ text: "inner" });
    child.empty();
    root.detach();
    expect(typeof root.createEl).toBe("function");
    expect(root.querySelector("h2")).toBeNull();
    expect(root.querySelectorAll("h2")).toEqual([]);
    expect(root.children).toEqual([]);
  });

  it("installs the Obsidian prototype extensions plugins rely on", async () => {
    await ShimHarness.withVault({});
    expect([1, 2, 3].first()).toBe(1);
    expect([1, 2, 3].last()).toBe(3);
    expect([].first()).toBeUndefined();
    expect([1, 2].contains(2)).toBe(true);
    expect("abc".contains("b")).toBe(true);
  });

  it("exposes window.app and window.moment for the vendored daily-notes interface", async () => {
    const harness = await ShimHarness.withVault({});
    const globalWindow = globalThis as unknown as { app: unknown; moment: unknown };
    expect(globalWindow.app).toBe(harness.app);
    expect(typeof globalWindow.moment).toBe("function");
    expect((globalWindow.moment as () => { format(f: string): string })().format("YYYY")).toMatch(/^\d{4}$/);
  });

  it("provides an inert MutationObserver and i18next", async () => {
    await ShimHarness.withVault({});
    const g = globalThis as unknown as {
      MutationObserver: new (cb: () => void) => { observe(t: unknown, o: unknown): void; disconnect(): void };
      i18next: { t(key: string): string };
    };
    const observer = new g.MutationObserver(() => { throw new Error("must never fire"); });
    expect(() => { observer.observe({}, { subtree: true }); }).not.toThrow();
    expect(() => { observer.disconnect(); }).not.toThrow();
    expect(g.i18next.t("plugins.folder-notes.label")).toBe("plugins.folder-notes.label");
  });

  it("records a safe_stub hit per symbol per plugin, once", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addRibbonIcon("star", "Go", () => {});
        harness.api.setIcon(harness.api.createDiv(), "star");
        harness.api.setIcon(harness.api.createDiv(), "star");
      }
    });
    await harness.load(plugin);
    const stubs = harness.policyRecorder.entries().filter((e) => e.policy === "safe_stub" && e.pluginId === "demo");
    const setIcon = stubs.find((e) => e.symbol === "setIcon");
    expect(setIcon?.hits).toBe(2);
    expect(stubs.filter((e) => e.symbol === "setIcon")).toHaveLength(1);
  });
});
