/**
 * The two named failure classes from the research, reproduced as tests rather
 * than trusted as prose — plus the folder-move ruling and the write the enabled
 * set refuses.
 *
 * Both traps are silent when they bite. A rename delivered as a delete plus a
 * create fires the wrong handler and empties every `Map<TFile, …>` a plugin
 * keeps; a plugin that gates its startup on `resolved` and never gets one does
 * nothing at all, for ever, with no error anywhere. So each has a companion case
 * proving the test has teeth: one where the crash really happens, and one where
 * the gate really is the thing being opened.
 */

import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

describe("the idle census after a rollback", () => {
  it("leaves no timer behind when a plugin's onload throws", async () => {
    // **Task 13's carry: a rolled-back plugin is a plugin that costs nothing.**
    // The idle-cost census counts what a loaded plugin leaves armed, and a
    // plugin whose `onload` threw is not loaded — so a timer of its still
    // firing would be charged to a plugin the host says it does not have, and
    // would go on waking the process for the life of it.
    //
    // Both kinds are armed here, because the rollback has to reach both through
    // different machinery: `Component.unload` disarms what the plugin handed to
    // `registerInterval`, and the loader's own sweep disarms what it never did.
    // Obsidian cannot reach the second kind at all; this host owns the clock, so
    // it can.
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      plugins: {
        greedy: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerInterval(harness.window.setInterval(() => undefined, 200));
              // Never registered: a bare interval, the shape a bundle writes
              // when it is not thinking about teardown.
              harness.window.setInterval(() => undefined, 300);
              await Promise.resolve();
              throw new Error("boom during onload");
            }
          },
      },
    });
    try {
      // **Enabled late rather than at startup, so the baseline is the host's.**
      // `start()` arms the coexistence poll — a timer of the host's own, which
      // has nothing to do with this plugin — so a baseline taken before it
      // would be measuring the startup rather than the rollback.
      await harness.lifecycle.start();
      const baseline = harness.clock.armed();
      await expect(harness.lifecycle.enableLate("greedy")).rejects.toThrow(/could not be enabled/);
      // The load really failed and was really rolled back — without this the
      // assertions below would hold for a plugin that never ran.
      expect(harness.lifecycle.loadFailures().get("greedy")).toContain("rolled back");
      expect(harness.app.plugins.getPlugin("greedy")).toBeNull();
      // Nothing armed, and nothing left in the census for a plugin the host no
      // longer has.
      expect(harness.clock.armed()).toBe(baseline);
      expect(harness.harvest.timers().filter((timer) => timer.pluginId === "greedy")).toEqual([]);
    } finally {
      await harness.stop();
    }
  });
});

describe("lifecycle traps", () => {
  it("survives the folder-notes tabManager trap: rename after layoutReady", async () => {
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n", "Other.md": "Folder\n" },
      enabled: ["folderish"],
      plugins: {
        folderish: (api) =>
          class extends api.Plugin {
            tabManager?: { updateTab(path: string): void };
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("rename", (file) => {
                  this.tabManager!.updateTab((file as { path: string }).path);
                }),
              );
              this.app.workspace.onLayoutReady(() => {
                this.tabManager = {
                  updateTab: () => {
                    this.app.workspace.iterateAllLeaves((leaf: { view?: unknown }) => {
                      if (leaf.view instanceof api.EditableFileView) {
                        throw new Error("no leaves headless");
                      }
                    });
                  },
                };
              });
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    // `renamed:` is harness sugar. On the wire this becomes one
    // generation_committed carrying deleted: ["Folder/Folder.md"] and
    // created: ["Folder/Renamed.md"] with the same revision — there is no
    // rename on the wire. The shim is what pairs them back into one
    // vault.on("rename") delivery, and that pairing is what this test
    // exercises end to end.
    await expect(
      harness.commitGeneration({ renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }] }),
    ).resolves.toBeUndefined();
    expect(harness.quarantine.failuresFor("folderish")).toBe(0);
    await harness.stop();
  });

  it("delivers exactly one rename and no create or delete for a move", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("rename", (file, oldPath) =>
                  seen.push(`rename:${oldPath as string}->${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("create", (file) =>
                  seen.push(`create:${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("delete", (file) =>
                  seen.push(`delete:${(file as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    seen.length = 0;
    await harness.commitGeneration({
      renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }],
    });
    expect(seen).toEqual(["rename:Folder/Folder.md->Folder/Renamed.md"]);
    await harness.stop();
  });

  it("reproduces the trap when layoutReady never fires, proving the test has teeth", async () => {
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n" },
      enabled: ["folderish"],
      suppressLayoutReady: true,
      plugins: {
        folderish: (api) =>
          class extends api.Plugin {
            tabManager?: { updateTab(path: string): void };
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("rename", (file) => {
                  this.tabManager!.updateTab((file as { path: string }).path);
                }),
              );
              this.app.workspace.onLayoutReady(() => {
                this.tabManager = { updateTab: () => undefined };
              });
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.commitGeneration({
      renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }],
    });
    expect(harness.quarantine.failuresFor("folderish")).toBe(1);
    // The brief asked for `/tabManager/` here and V8 does not put the object's
    // own name in the message: `this.tabManager!.updateTab(x)` on an undefined
    // `tabManager` reads "Cannot read properties of undefined (reading
    // 'updateTab')". The property that was reached for is the half V8 reports,
    // so that is the half this asserts on.
    expect(harness.lastHandlerError("folderish")?.message).toMatch(/updateTab/);
    await harness.stop();
  });

  it("does not deadlock a plugin that gates its whole startup on resolved", async () => {
    let gateOpened = false;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["gated"],
      plugins: {
        gated: (api) =>
          class extends api.Plugin {
            ready?: Promise<void>;
            override async onload(): Promise<void> {
              this.ready = new Promise<void>((resolve) => {
                this.registerEvent(
                  this.app.metadataCache.on("resolved", () => {
                    gateOpened = true;
                    resolve();
                  }),
                );
              });
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    expect(gateOpened).toBe(true);
    const plugin = harness.app.plugins.getPlugin("gated") as unknown as { ready: Promise<void> };
    await expect(
      Promise.race([
        plugin.ready.then(() => "opened"),
        harness.tick().then(() => "deadlocked"),
      ]),
    ).resolves.toBe("opened");
    await harness.stop();
  });

  it("opens the gate for a plugin enabled onto a quiet vault", async () => {
    let gateOpened = false;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      plugins: {
        gated: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => {
                  gateOpened = true;
                }),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.enableLate("gated");
    expect(gateOpened).toBe(true);
    // The vault did not change because a plugin was switched on, so nothing
    // asked the index anything. A `resolved` bought with a re-hydration would
    // pass the assertion above and cost a whole-vault walk per enable.
    expect(harness.mirrorRequestsSince("enableLate")).toEqual([]);
    await harness.stop();
  });

  it("delivers a host-initiated folder move as one rename for the folder", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      // `Folder2` is here to be left alone. The subtree test is by path
      // segment, not by string prefix — the same bug class Task 6 fixed in the
      // mirror's child index, where `Deeper.md` is not under `Deep`.
      vault: { "Folder/Note.md": "note\n", "Folder2/Other.md": "other\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("rename", (file, oldPath) =>
                  seen.push(`rename:${oldPath as string}->${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("create", (file) =>
                  seen.push(`create:${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("delete", (file) =>
                  seen.push(`delete:${(file as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    const folder = harness.vault.getFolderByPath("Folder");
    const sibling = harness.vault.getFileByPath("Folder2/Other.md");
    seen.length = 0;
    await harness.renameViaShim("Folder", "Moved");
    // The folder itself and the note under it, each once — and nothing about
    // `Folder2`. A folder carries no content revision, so nothing could have
    // paired the folder by revision; the pair comes from `Vault.rename`'s own
    // record of the move.
    expect([...seen].sort()).toEqual([
      "rename:Folder->Moved",
      "rename:Folder/Note.md->Moved/Note.md",
    ]);
    // And it is the same `TFolder` a plugin was already holding, which is what
    // a delete-plus-create would have thrown away.
    expect(harness.vault.getFolderByPath("Moved")).toBe(folder);
    expect(harness.vault.getFileByPath("Folder2/Other.md")).toBe(sibling);
    await harness.stop();
  });

  it("delivers an external folder move as the descendants' renames plus a folder delete and create", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "Folder/Note.md": "note\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("rename", (file, oldPath) =>
                  seen.push(`rename:${oldPath as string}->${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("create", (file) =>
                  seen.push(`create:${(file as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("delete", (file) =>
                  seen.push(`delete:${(file as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    seen.length = 0;
    // Nobody recorded this one: it happened outside the host, so the only thing
    // the batch says about the folder is that a row went and a row appeared.
    // Guessing a pair from that is the wrong confidence level, and which of the
    // two Obsidian does for the folder object is uncaptured.
    await harness.commitGeneration({
      renamed: [{ from: "Folder/Note.md", to: "Moved/Note.md" }],
    });
    expect([...seen].sort()).toEqual([
      "create:Moved",
      "delete:Folder",
      "rename:Folder/Note.md->Moved/Note.md",
    ]);
    await harness.stop();
  });

  it("refuses to write an enabled set it has already reported as damaged", async () => {
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
    const path = `${harness.config.configDirName}/community-plugins.json`;
    harness.setConfigFile(path, "{ not json");
    // Read-append-write over the `[]` a damaged file answers with would
    // overwrite a set the user may still want, silently, on the strength of a
    // report nobody was obliged to read.
    await expect(harness.lifecycle.enableLate("late")).rejects.toThrow(/damaged/);
    expect(harness.writtenFile(path)).toBeUndefined();
    expect(harness.app.plugins.getPlugin("late")).toBeNull();
    await harness.stop();
  });
});
