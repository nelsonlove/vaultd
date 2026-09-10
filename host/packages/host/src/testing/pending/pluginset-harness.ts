/**
 * The headless config directory and the coexistence monitor, over a fake
 * daemon: the harness Task 14 drives.
 *
 * **Not yet activated.** Written for `src/testing/pluginset-harness.ts`, with
 * its imports spelled for that home. Task 14's Step 1 moves it:
 *
 * ```
 * git mv src/testing/pending/pluginset-harness.ts src/testing/pluginset-harness.ts
 * ```
 *
 * The question this harness exists to ask is coexistence: the host keeps its
 * own enabled-plugin set in `<configDirName>/`, Obsidian keeps its own in
 * `.obsidian/`, and the two can disagree — including the case where Obsidian
 * has no config file at all, which is `guiEnabled: null` rather than an empty
 * list. An empty list means "Obsidian enabled nothing"; `null` means "there is
 * no Obsidian here to have an opinion", and the monitor treats them
 * differently.
 */

import { DaemonHarness } from "./daemon-harness";
import { CoexistenceMonitor } from "../shim/coexistence";
import { HeadlessConfigDir } from "../shim/config-dir";
import type { PluginManifest } from "../shim/plugin";

export interface PluginSetSpec {
  hostEnabled: string[];
  /** `null` = Obsidian has no config file, which is not the same as none enabled. */
  guiEnabled: string[] | null;
  forceShared?: string[];
  installed?: PluginManifest[];
}

export class PluginSetHarness extends DaemonHarness {
  readonly dir: HeadlessConfigDir;
  readonly monitor: CoexistenceMonitor;

  private guiEnabled: string[] | null;
  private hostEnabled: string[];

  protected constructor(spec: PluginSetSpec) {
    super({ forceShared: spec.forceShared ?? [] });
    this.guiEnabled = spec.guiEnabled;
    this.hostEnabled = [...spec.hostEnabled];
    this.dir = new HeadlessConfigDir({ config: this.config, client: this.client });
    this.monitor = new CoexistenceMonitor({
      config: this.config,
      clock: this.clock,
      dir: this.dir,
    });
  }

  static async create(spec: PluginSetSpec): Promise<PluginSetHarness> {
    const harness = new PluginSetHarness(spec);
    harness.serveConfigZone(spec.installed ?? []);
    await harness.monitor.start();
    harness.clearMethodLog();
    return harness;
  }

  setGuiEnabled(ids: string[] | null): void {
    this.guiEnabled = ids === null ? null : [...ids];
    this.serveConfigZone([]);
  }

  setHostEnabled(ids: string[]): void {
    this.hostEnabled = [...ids];
    this.serveConfigZone([]);
  }

  /**
   * Fire the overlap poll through the {@link TestClock}. Never sleeps.
   *
   * `overlapPollMs` is a minute in production, and a test that waited it out
   * would take a minute per case. Advancing the injected clock is what makes
   * the poll testable at all — which is the whole reason the clock is injected.
   */
  async advancePoll(): Promise<void> {
    await this.clock.advance(this.config.overlapPollMs);
    await this.quiesce();
  }

  /**
   * Answer every config-zone read from this harness's current state.
   *
   * Re-registered on each change rather than mutated in place, because
   * `autoServeFiles` merges: a path that must answer *absent* — Obsidian's
   * `community-plugins.json` when `guiEnabled` is `null` — cannot be expressed
   * by adding an entry, only by not having one and letting the `not_found`
   * arm answer.
   */
  private serveConfigZone(installed: readonly PluginManifest[]): void {
    const files: Record<string, string> = {
      [`${this.config.configDirName}/community-plugins.json`]: JSON.stringify(this.hostEnabled),
    };
    if (this.guiEnabled !== null) {
      files[".obsidian/community-plugins.json"] = JSON.stringify(this.guiEnabled);
    }
    for (const manifest of installed) {
      files[`${this.config.configDirName}/plugins/${manifest.id}/manifest.json`] =
        JSON.stringify(manifest);
    }
    this.autoServeFiles(files);
  }

  override async stop(): Promise<void> {
    await this.monitor.stop();
    await super.stop();
  }
}
