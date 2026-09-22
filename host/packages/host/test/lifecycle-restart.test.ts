/**
 * `onEngineRestart`, at the level a fake daemon can honestly speak about: the
 * diff-replay fallback, the watermark that suppresses it, and the phase guard.
 *
 * **The restart itself is pinned elsewhere.** An engine replacement is a
 * process dying and a supervisor bringing another one up, and the two ways a
 * new engine catches up — a re-hydration, or ordinary delta batches — are not
 * something a fake daemon chooses between. Driving it here by handing the
 * mirror a `resync_required` produced exactly one of those shapes every time,
 * and that is what hid the duplicate-delivery defect this round fixes. The real
 * thing is `lifecycle-restart-real-daemon.test.ts`; what is left here is the
 * arithmetic of the guard, which is the half a real daemon makes slow and
 * awkward to assert.
 */

import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

describe("engine restart continuity", () => {
  it("replays a diff the plugins were never told about, and only once", async () => {
    const events: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" },
      enabled: ["observer"],
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("create", (f) =>
                  events.push(`create:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("resolved", () => events.push("resolved")),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    events.length = 0;

    // An empty map is the honest shape of "a caller whose view predates this
    // host entirely": every path the mirror holds is news to it. Nothing has
    // been delivered yet, so the whole vault comes through as creates.
    await harness.lifecycle.onEngineRestart(new Map());
    expect(events).toEqual(["create:A.md", "create:B.md", "resolved"]);

    // And the second call is the guard doing its job: the same diff, at a
    // generation the sequencer has now delivered, is not news any more. Before
    // this round the watermark keyed on synthetic batches alone and a real
    // engine's delta-shaped recovery slipped past it, delivering every event a
    // second time.
    events.length = 0;
    await harness.lifecycle.onEngineRestart(new Map());
    expect(events).toEqual([]);
    await harness.stop();
  });

  it("does not replay what an ordinary batch already delivered", async () => {
    const events: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["observer"],
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("create", (f) =>
                  events.push(`create:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.metadataCache.on("changed", (f) =>
                  events.push(`changed:${(f as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    const before = harness.mirror.snapshotRevisions();
    await harness.commitGeneration({ created: ["New.md"], modified: ["A.md"] });
    expect(events).toEqual(["create:New.md", "changed:A.md"]);

    // This is the measured shape of a real recovery: the new engine caught up
    // through an ordinary delta batch, so the plugins already hold everything
    // the diff describes. A watermark that only counted synthetic batches
    // replayed all of it.
    events.length = 0;
    await harness.lifecycle.onEngineRestart(before);
    expect(events).toEqual([]);
    await harness.stop();
  });

  it("delivers nothing for a restart notice that arrives after stop", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" },
      enabled: [],
    });
    await harness.lifecycle.start();
    // **A host-owned listener, deliberately.** A stopped host has unloaded its
    // plugins, so a plugin's listener is gone either way and an assertion built
    // on one proves nothing about the guard. This one is registered outside any
    // attribution window, so it has no owner and `detachOwner` does not touch
    // it — which is what lets it see a delivery that should not have happened.
    harness.bus.on("vault:create", (...data: never[]) => {
      const file = data[0] as unknown as { path: string };
      seen.push(`create:${file.path}`);
    });
    await harness.lifecycle.stop();

    // An empty map makes every path in the vault news, so without the guard
    // this replays a `create` for every file the tree already holds — the exact
    // shape that double-inserts into a plugin's own index, delivered by a host
    // that has already said it is stopped.
    await harness.lifecycle.onEngineRestart(new Map());
    expect(seen).toEqual([]);
    expect(harness.lifecycle.phase()).toBe("stopped");
    await harness.stop();
  });

  it("stops delivering, and stops queueing, the moment it is stopped", async () => {
    const events: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["observer"],
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              this.registerEvent(
                this.app.vault.on("create", (f) =>
                  events.push(`create:${(f as { path: string }).path}`),
                ),
              );
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.stop();
    events.length = 0;
    await harness.commitGeneration({ created: ["After.md"] });
    expect(events).toEqual([]);
    // **The half that "no events" cannot see.** A stopped host's phase is not
    // `steady`, so a batch that still reached the subscription would be pushed
    // into the pre-steady buffer and sit there — silent, and one entry per batch
    // for the life of the process. Detaching is what stops that, and this is the
    // only place it is observable.
    expect(harness.lifecycle.pendingBatchCount()).toBe(0);
    await harness.stop();
  });
});
