/**
 * The startup order, and the two places it is load-bearing.
 *
 * Every case here is about *when* something happened rather than whether it
 * happened, because every failure this file exists to catch looks like a plugin
 * that simply does nothing: a `layoutReady` that never flips, a `resolved` that
 * fires once and never again, a late enable that leaves its plugin waiting for a
 * vault change a quiet vault never has.
 */

import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

describe("lifecycle order", () => {
  it("runs the five steps in the specified order across two plugins", async () => {
    const order: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" },
      enabled: ["first", "second"],
      plugins: {
        first: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              order.push("first:onload");
              order.push(`first:layoutReady=${String(this.app.workspace.layoutReady)}`);
              this.app.workspace.onLayoutReady(() => order.push("first:layout"));
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => order.push("first:resolved")),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolve", () => order.push("first:resolve")),
              );
              return Promise.resolve();
            }
          },
        second: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              order.push("second:onload");
              this.app.workspace.onLayoutReady(() => order.push("second:layout"));
              return Promise.resolve();
            }
          },
      },
    });
    const report = await harness.lifecycle.start();
    expect(report.loaded).toEqual(["first", "second"]);
    expect(order).toEqual([
      "first:onload",
      "first:layoutReady=false",
      "second:onload",
      "first:layout",
      "second:layout",
      "first:resolve",
      "first:resolve",
      "first:resolved",
    ]);
    expect(harness.lifecycle.phase()).toBe("steady");
    await harness.stop();
  });

  it("re-fires resolved after every steady-state mirror batch", async () => {
    const events: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => events.push("resolved")),
              );
              this.registerEvent(
                this.app.metadataCache.on("changed", (file) =>
                  events.push(`changed:${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("create", (file) =>
                  events.push(`create:${(file as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    events.length = 0;
    await harness.commitGeneration({ created: ["New.md"], modified: ["A.md"] });
    expect(events).toEqual(["create:New.md", "changed:A.md", "resolved"]);
    await harness.stop();
  });

  it("gives a late-enabled plugin layoutReady and a synthetic resolved immediately", async () => {
    const order: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      plugins: {
        late: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              order.push("onload");
              this.app.workspace.onLayoutReady(() => order.push("layout"));
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => order.push("resolved")),
              );
              return Promise.resolve();
            }
          },
        bystander: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => order.push("bystander:resolved")),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.enableLate("bystander");
    order.length = 0;
    await harness.lifecycle.enableLate("late");
    // `bystander` is doing real work here: it proves the synthetic `resolved`
    // reaches the newly enabled plugin **only**. A broadcast would re-fire it at
    // every plugin already running, for a fact that is true of none of them.
    expect(order).toEqual(["onload", "layout", "resolved"]);
    await harness.stop();
  });

  it("persists a late enable into the headless enabled set", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      plugins: {
        late: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.enableLate("late");
    // Read back off the wire rather than off a harness field: the write has to
    // have reached the file the *next* host start will read, or the plugin is
    // running now and gone after a restart with nothing to say why.
    expect(harness.writtenFile(`${harness.config.configDirName}/community-plugins.json`)).toBe(
      `${JSON.stringify(["late"], null, 2)}\n`,
    );
    expect(harness.app.plugins.getPlugin("late")).not.toBeNull();

    await harness.lifecycle.disable("late");
    expect(harness.writtenFile(`${harness.config.configDirName}/community-plugins.json`)).toBe(
      `${JSON.stringify([], null, 2)}\n`,
    );
    expect(harness.app.plugins.getPlugin("late")).toBeNull();
    await harness.stop();
  });

  it("loads nothing the GUI is already running, and says why", async () => {
    const loaded: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["shared", "ours"],
      guiEnabled: ["shared"],
      plugins: {
        shared: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              loaded.push("shared");
              return Promise.resolve();
            }
          },
        ours: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              loaded.push("ours");
              return Promise.resolve();
            }
          },
      },
    });
    const report = await harness.lifecycle.start();
    expect(loaded).toEqual(["ours"]);
    expect(report.loaded).toEqual(["ours"]);
    expect(report.failed.map((entry) => entry.id)).toEqual(["shared"]);
    expect(report.failed[0]?.error).toMatch(/refusing to enable "shared"/);
    await harness.stop();
  });

  it("records a plugin whose onload throws and loads the rest", async () => {
    const loaded: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["broken", "fine"],
      plugins: {
        broken: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              await Promise.resolve();
              throw new Error("nope");
            }
          },
        fine: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              loaded.push("fine");
              return Promise.resolve();
            }
          },
      },
    });
    const report = await harness.lifecycle.start();
    expect(loaded).toEqual(["fine"]);
    expect(report.loaded).toEqual(["fine"]);
    expect(report.failed.map((entry) => entry.id)).toEqual(["broken"]);
    expect(harness.lifecycle.loadTimings().has("broken")).toBe(false);
    expect(harness.lifecycle.loadTimings().has("fine")).toBe(true);
    await harness.stop();
  });
});
