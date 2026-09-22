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
    // **Every stage of the startup is timed, the mirror's snapshot walk
    // included.** That walk runs inside `startHost` before this sequencer
    // exists, so it is read off the mirror rather than measured here — and
    // until it was, the design's "mirror hydration time" was instrumented in
    // part and the baseline document had to say so. Disjoint from
    // `hydrationMs`, which starts at `lifecycle.start()`.
    expect(report.snapshotHydrationMs).toBe(harness.mirror.snapshotHydrationMs());
    expect(report.snapshotHydrationMs).toBeGreaterThanOrEqual(0);
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

  it("groups each file's cache event with its own vault event", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              // Read B's cache while B still exists, so the `deleted` event has
              // a previous cache to carry. By the time the event fires the
              // mirror's row is gone and nothing can rebuild it — the retained
              // assembly is the only copy left.
              this.app.metadataCache.getCache("B.md");
              this.registerEvent(
                this.app.vault.on("modify", (f) =>
                  seen.push(`modify:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("changed", (f) =>
                  seen.push(`changed:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("delete", (f) =>
                  seen.push(`delete:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("deleted", (f, prev) =>
                  seen.push(
                    `deleted:${(f as { path: string }).path}:${prev === null ? "null" : "cache"}`,
                  ),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => seen.push("resolved")),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    seen.length = 0;
    await harness.commitGeneration({ modified: ["A.md"], deleted: ["B.md"] });
    // **The discriminating assertion.** Two different notes, one modified and
    // one deleted, so the two candidate orders differ: this one groups each
    // file's cache event with that file's vault event, where the plan's earlier
    // prose put every `metadataCache` event after every `vault` event. Ruled for
    // the grouping on 2026-09-15 — Obsidian's documented model is per file
    // ("called when a file has been indexed, and its updated cache is now
    // available"), and the plan's only stated reason (one event per move) is
    // satisfied either way.
    expect(seen).toEqual([
      "modify:A.md",
      "changed:A.md",
      "delete:B.md",
      "deleted:B.md:cache",
      "resolved",
    ]);
    await harness.stop();
  });

  it("fires resolve in path order, and exactly one startup resolved behind all of them", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "b/Deep.md": "# D\n", "A.md": "# A\n", "a/Nested.md": "# N\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.metadataCache.on("resolve", (f) =>
                  seen.push(`resolve:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => seen.push("resolved")),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    expect(seen).toEqual([
      "resolve:A.md",
      "resolve:a/Nested.md",
      "resolve:b/Deep.md",
      "resolved",
    ]);
    await harness.stop();
  });

  it("holds a batch raised during onload until the startup resolve run is done", async () => {
    const seen: string[] = [];
    let fire: (() => Promise<void>) | null = null;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["observer", "writer"],
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("create", (f) =>
                  seen.push(`create:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolve", (f) =>
                  seen.push(`resolve:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => seen.push("resolved")),
              );
              return Promise.resolve();
            }
          },
        writer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              // A plugin that writes from its own `onload` — several in the
              // census do, to seed a folder or a settings note.
              await fire?.();
            }
          },
      },
    });
    fire = () => harness.commitGeneration({ created: ["FromOnload.md"] });
    await harness.lifecycle.start();
    // The startup `resolved` fires **once**, after every `resolve`. Delivered
    // where it landed, the onload batch's own `resolved` came first — before a
    // single `resolve` — and the six plugins in the census that read `resolved`
    // as "the cache is complete now" would have opened their gate on a cache
    // nothing had resolved yet.
    expect(seen).toEqual([
      "resolve:A.md",
      "resolve:FromOnload.md",
      "resolved",
      "create:FromOnload.md",
      "resolved",
    ]);
    await harness.stop();
  });

  it("arms the coexistence poll during the hydrating phase", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      guiEnabled: [],
    });
    await harness.lifecycle.start();
    expect(harness.coexistence.latest()?.guiEnabled).toEqual([]);
    // Nothing tells this host that a GUI Obsidian enabled a plugin — the daemon
    // watches no write it did not make — so the poll is the whole mechanism,
    // and starting it is the lifecycle's call rather than the assembler's.
    harness.setGuiEnabled(["late-from-the-gui"]);
    await harness.advanceClock(harness.config.overlapPollMs);
    await harness.coexistence.settled();
    expect(harness.coexistence.latest()?.guiEnabled).toEqual(["late-from-the-gui"]);
    await harness.stop();
  });
});
