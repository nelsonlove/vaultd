/**
 * The headless config directory and the coexistence monitor, over a fake
 * daemon: the harness Task 14 drives.
 *
 * Written by Task 6b under `src/testing/pending/` and activated here by Task
 * 14, which is the first task whose modules it can name. Three of its calls
 * were written against interface sketches and reconciled against the real
 * signatures at activation, each noted at the call site.
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
import { CoexistenceMonitor } from "../pluginset/coexistence";
import { HeadlessConfigDir } from "../pluginset/config-dir";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";

export interface PluginSetSpec {
  hostEnabled: string[];
  /** `null` = Obsidian has no config file, which is not the same as none enabled. */
  guiEnabled: string[] | null;
  forceShared?: string[];
  installed?: PluginManifest[];
}

/** Obsidian's own enabled set — the file the monitor compares against. */
const GUI_COMMUNITY_PLUGINS = ".obsidian/community-plugins.json";

/** `hostEnabled` is required on a spec and is no `HostConfig` key: that is the tell. */
function isPluginSetSpec(arg: PluginSetSpec | Partial<HostConfig>): arg is PluginSetSpec {
  return "hostEnabled" in arg;
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
    // Positional, not an options bag: both constructors take their collaborators
    // in order, and the monitor takes the `client` as well as the directory —
    // Obsidian's own `community-plugins.json` is read through `read_file`
    // directly, because the directory's config ladder would answer it with the
    // *host's* copy. The clock is not an argument at all; it reaches the monitor
    // as `config.clock`, which is the Global Constraint's one time source and is
    // already this harness's `TestClock`.
    this.dir = new HeadlessConfigDir(this.client, this.config);
    this.monitor = new CoexistenceMonitor(this.dir, this.client, this.config);
  }

  /**
   * A started monitor with one report already taken.
   *
   * `start()` arms the poll and nothing else — the startup check belongs to
   * whoever starts the host, so that a refusal reaches that caller rather than a
   * timer's error handler. The harness therefore takes the first report itself,
   * which is what makes `onOverlapChanged` mean what a test expects: the first
   * report changes nothing, so a subscriber registered after `create` hears only
   * about movement.
   *
   * **Why the second overload exists.** Task 6b named this factory `create`,
   * which is also {@link DaemonHarness}'s — and TypeScript checks a class's
   * static side against its base's, so a bare redeclaration with a different
   * shape is `TS2417` however unused the inherited one is. Declaring the base's
   * signature as a second overload makes the static side assignable again, and
   * it is not a fiction: `PluginSetHarness.create({})` **already** meant "build a
   * plain `DaemonHarness`" before this class existed, because the inherited
   * static constructs the base. The implementation below keeps exactly that
   * behaviour rather than inventing a new one for it.
   */
  static override create(spec: PluginSetSpec): Promise<PluginSetHarness>;
  static override create(overrides?: Partial<HostConfig>): DaemonHarness;
  static override create(
    arg: PluginSetSpec | Partial<HostConfig> = {},
  ): Promise<PluginSetHarness> | DaemonHarness {
    if (!isPluginSetSpec(arg)) return DaemonHarness.create(arg);
    return PluginSetHarness.started(arg);
  }

  private static async started(spec: PluginSetSpec): Promise<PluginSetHarness> {
    const harness = new PluginSetHarness(spec);
    harness.serveConfigZone(spec.installed ?? []);
    harness.monitor.start();
    await harness.monitor.check();
    harness.clearMethodLog();
    return harness;
  }

  /**
   * What Obsidian's own config directory says — or that there is none.
   *
   * `null` is not an empty list. "Obsidian has no `community-plugins.json`" and
   * "Obsidian has one that enables nothing" are different facts, and the
   * monitor is required to treat them differently, so the harness has to be
   * able to express both: the `null` arm un-serves the path through
   * {@link DaemonHarness.unserveFile}, which makes the next read answer
   * `not_found` the way the daemon would. {@link serveConfigZone} does it, so
   * that a spec which starts out `null` is absent from the first read rather
   * than only from the first *change* — activating this file, a harness built
   * with `guiEnabled: null` served nothing for that path at all and the
   * monitor's first read waited forever.
   */
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
   * `autoServeFiles` only ever *adds* — it merges — so the absent case cannot be
   * expressed by what this passes it. `unserveFile` is the only way to take a
   * path back off the wire, and the `null` arm calls it here rather than in
   * {@link setGuiEnabled} so that both roads into this state go through one
   * line: a spec that is born `null` and a spec that becomes `null`.
   *
   * Order matters. `autoServeFiles` clears a path's absent flag when it serves
   * it, so the un-serve comes second; the other way round, a harness that went
   * `null` would answer its own stale bytes.
   */
  private serveConfigZone(installed: readonly PluginManifest[]): void {
    const files: Record<string, string> = {
      [`${this.config.configDirName}/community-plugins.json`]: JSON.stringify(this.hostEnabled),
    };
    if (this.guiEnabled !== null) {
      files[GUI_COMMUNITY_PLUGINS] = JSON.stringify(this.guiEnabled);
    }
    for (const manifest of installed) {
      files[`${this.config.configDirName}/plugins/${manifest.id}/manifest.json`] =
        JSON.stringify(manifest);
    }
    this.autoServeFiles(files);
    if (this.guiEnabled === null) this.unserveFile(GUI_COMMUNITY_PLUGINS);
  }

  /** `CoexistenceMonitor.stop` is synchronous and idempotent — nothing to await. */
  override async stop(): Promise<void> {
    this.monitor.stop();
    await super.stop();
  }
}
