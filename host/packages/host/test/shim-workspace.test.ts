/**
 * The workspace a headless host really has: a layout-ready latch, no leaves,
 * and an inert leaf that records what a plugin asked it to open.
 *
 * Every case here is one of the shapes the golden corpus actually executes.
 * `getLeavesOfType` returning an empty array rather than `undefined` is what
 * lets folder-notes' `getFileExplorer` early-return and disable its CSS
 * features cleanly, and `iterateAllLeaves` calling nothing is what makes its
 * `TabManager.updateTabs()` a no-op instead of a crash — so both are pinned by
 * a case shaped like the plugin's own code rather than by an assertion about
 * the shim in the abstract.
 */

import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Workspace", () => {
  it("queues onLayoutReady callbacks before ready and runs them in order", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => order.push("first"));
    harness.app.workspace.onLayoutReady(() => order.push("second"));
    expect(harness.app.workspace.layoutReady).toBe(false);
    expect(order).toEqual([]);
    await harness.flipLayoutReady();
    expect(harness.app.workspace.layoutReady).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs a callback immediately once layout is ready", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    await harness.flipLayoutReady();
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => order.push("late"));
    expect(order).toEqual(["late"]);
  });

  it("returns empty leaf collections and iterates nothing", async () => {
    const harness = await ShimHarness.withVault({});
    const workspace = harness.app.workspace;
    expect(workspace.getLeavesOfType("file-explorer")).toEqual([]);
    expect(workspace.getLeavesOfType("markdown")).toEqual([]);
    expect(workspace.getLeavesOfType("tag")).toEqual([]);
    expect(workspace.getActiveViewOfType(harness.api.MarkdownView)).toBeNull();
    expect(workspace.getActiveFileView()).toBeNull();
    let calls = 0;
    workspace.iterateAllLeaves(() => { calls += 1; });
    expect(calls).toBe(0);
  });

  it("survives folder-notes' TabManager shape without throwing", async () => {
    const harness = await ShimHarness.withVault({ "Folder/Folder.md": "x\n" });
    const tabManager = {
      app: harness.app,
      updateTabs(): void {
        this.app.workspace.iterateAllLeaves((leaf: { view?: unknown }) => {
          if (!(leaf.view instanceof harness.api.EditableFileView)) return;
          throw new Error("unreachable: there are no leaves headless");
        });
      },
    };
    expect(() => { tabManager.updateTabs(); }).not.toThrow();
  });

  it("flips the latch once, however often the host says it is ready", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => order.push("startup"));
    await harness.flipLayoutReady();
    await harness.flipLayoutReady();
    harness.app.workspace.markLayoutReady();
    // Startup happens once. A second fan-out would run every plugin's startup
    // work twice — which for the corpus means creating a daily note twice.
    expect(order).toEqual(["startup"]);
  });

  it("flips the latch before the fan-out, so a nested registration still runs", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => {
      order.push("outer");
      // Registered from inside the event. The latch is already up, so this runs
      // immediately; were it flipped after the fan-out it would be queued for a
      // fan-out that has already happened and never run at all.
      harness.app.workspace.onLayoutReady(() => order.push("inner"));
    });
    await harness.flipLayoutReady();
    expect(order).toEqual(["outer", "inner"]);
  });

  it("records an openFile intent on the inert leaf instead of opening anything", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    const leaf = harness.app.workspace.getLeaf(false);
    await leaf.openFile(harness.vault.getFileByPath("A.md")!);
    expect(harness.openFileIntents()).toEqual(["A.md"]);
  });
});
