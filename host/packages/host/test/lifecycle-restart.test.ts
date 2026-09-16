/**
 * Engine restart continuity (Ruling 7).
 *
 * The index is on disk, so a new engine over the same index resumes where the
 * old one committed. The *connection* survives nothing — so the question is what
 * a plugin sees across the gap, and the answer is: the same shape as a bulk
 * external edit, which every plugin already tolerates, and no `onunload` at all.
 */

import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

describe("engine restart continuity", () => {
  it("keeps plugins loaded and synthesizes changed events for the revision diff", async () => {
    const events: string[] = [];
    let onloadCount = 0;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "Gone.md": "x\n" },
      enabled: ["observer"],
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              onloadCount += 1;
              this.registerEvent(
                this.app.metadataCache.on("changed", (f) =>
                  events.push(`changed:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("create", (f) =>
                  events.push(`create:${(f as { path: string }).path}`),
                ),
              );
              this.registerEvent(
                this.app.vault.on("delete", (f) =>
                  events.push(`delete:${(f as { path: string }).path}`),
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
    expect(onloadCount).toBe(1);
    events.length = 0;
    await harness.restartEngine({
      generation: 40,
      vault: { "A.md": "# A changed\n", "New.md": "fresh\n" },
    });
    expect(onloadCount).toBe(1);
    expect(events).toEqual(["create:New.md", "changed:A.md", "delete:Gone.md", "resolved"]);
    expect(harness.lifecycle.phase()).toBe("steady");
    await harness.stop();
  });

  it("reloads plugins when the knob is set", async () => {
    let onloadCount = 0;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["observer"],
      config: { reloadPluginsOnEngineRestart: true },
      plugins: {
        observer: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              onloadCount += 1;
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    await harness.restartEngine({ generation: 40, vault: { "A.md": "# A\n" } });
    expect(onloadCount).toBe(2);
    await harness.stop();
  });

  it("tells a reloaded plugin the cache is resolved, so its gate opens again", async () => {
    const opened: number[] = [];
    let loads = 0;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["gated"],
      config: { reloadPluginsOnEngineRestart: true },
      plugins: {
        gated: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              loads += 1;
              const load = loads;
              this.app.workspace.onLayoutReady(() => {
                this.registerEvent(
                  this.app.metadataCache.on("resolved", () => opened.push(load)),
                );
              });
              return Promise.resolve();
            }
          },
      },
    });
    await harness.lifecycle.start();
    opened.length = 0;
    await harness.restartEngine({ generation: 40, vault: { "A.md": "# A\n" } });
    // The second instance registered its listener from an `onLayoutReady` that
    // ran immediately — the latch is still flipped, a restart does not unflip it
    // — and then got the `resolved` its startup waits for. A reload that fired
    // nothing would leave every gate-waiting plugin dead after a restart, which
    // is the same silent deadlock the late-enable path exists to close.
    expect(opened).toEqual([2]);
    await harness.stop();
  });
});
