/**
 * The headless config directory and the coexistence monitor, over a fake
 * daemon: the harness Task 14 drives.
 *
 * Written by Task 6b under `src/testing/pending/` and activated by Task 14,
 * which is the first task whose modules it can name. Its constructor calls were
 * written against interface sketches and reconciled against the real signatures
 * at activation, each noted at the call site.
 *
 * The question this harness exists to ask is coexistence: the host keeps its
 * own enabled-plugin set in `<configDirName>/`, Obsidian keeps its own in
 * `.obsidian/`, and the two can disagree — including the case where Obsidian
 * has no config file at all, which is `guiEnabled: null` rather than an empty
 * list. An empty list means "Obsidian enabled nothing"; `null` means "there is
 * no Obsidian here to have an opinion", and the monitor treats them
 * differently.
 *
 * **It extends {@link ShimHarness} rather than {@link DaemonHarness}, which is
 * a change from Task 6b's sketch.** The poll is not only an overlap check: it
 * is the one moment in a host's life when an external GUI edit of *any* config
 * file is noticed, so `assembleShim` hangs `InternalPluginRegistry.refresh()`
 * and `Vault.reprimeConfig()` off it. Pinning that wiring means asserting that
 * `vault.getConfig` and `app.internalPlugins` see a changed file after
 * {@link PluginSetHarness.advancePoll} — and neither of those exists without an
 * assembled shim. A harness that built its own monitor beside the assembly
 * would have pinned a wiring production never runs.
 */

import { DaemonHarness } from "./daemon-harness";
import { ShimHarness, configFilePathsFor } from "./shim-harness";
import type { CoexistenceMonitor } from "../pluginset/coexistence";
import type { HeadlessConfigDir } from "../pluginset/config-dir";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";

export interface PluginSetSpec {
  hostEnabled: string[];
  /** `null` = Obsidian has no config file, which is not the same as none enabled. */
  guiEnabled: string[] | null;
  forceShared?: string[];
  installed?: PluginManifest[];
  /**
   * Config-zone files to serve, beyond the two enabled sets.
   *
   * The end-to-end poll case changes `.obsidian/app.json` and
   * `.obsidian/core-plugins.json` underneath a running host, so it has to be
   * able to put them there in the first place.
   */
  configFiles?: Record<string, string>;
}

/** Obsidian's own enabled set — the file the monitor compares against. */
const GUI_COMMUNITY_PLUGINS = ".obsidian/community-plugins.json";

/** `hostEnabled` is required on a spec and is no `HostConfig` key: that is the tell. */
function isPluginSetSpec(arg: PluginSetSpec | Partial<HostConfig>): arg is PluginSetSpec {
  return "hostEnabled" in arg;
}

export class PluginSetHarness extends ShimHarness {
  /**
   * Taken from the assembly, not built here.
   *
   * Definite-assignment for the same reason every `ShimHarness` field is: the
   * shim is wired after a mirror exists, and a constructor cannot await.
   */
  readonly dir!: HeadlessConfigDir;
  readonly monitor!: CoexistenceMonitor;

  private guiEnabled: string[] | null;
  private hostEnabled: string[];

  protected constructor(spec: PluginSetSpec) {
    super({
      config: { forceShared: spec.forceShared ?? [] },
      configFiles: spec.configFiles ?? {},
      // Nothing here loads a plugin or opens a view; the flip costs a round
      // trip per harness and buys this file nothing.
      layoutReady: false,
    });
    this.guiEnabled = spec.guiEnabled;
    this.hostEnabled = [...spec.hostEnabled];
  }

  /**
   * An assembled shim over an empty vault, with the monitor started and one
   * report already taken.
   *
   * `start()` arms the poll and nothing else — the startup check belongs to
   * whoever starts the host, so that a refusal reaches that caller rather than a
   * timer's error handler. The harness therefore takes the first report itself,
   * which is what makes `onOverlapChanged` mean what a test expects: the first
   * report changes nothing, so a subscriber registered after `create` hears only
   * about movement.
   *
   * The sequence below is {@link ShimHarness}'s own start, minus the parts an
   * empty vault has nothing to do (note sources, the warm-up) and plus the
   * monitor. It cannot call that start directly: it is a static that constructs
   * a `ShimHarness` by name.
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
    // The base constructor records `configFiles`; putting them on the wire is
    // `ShimHarness.start`'s job, and this start sequence is not that one.
    for (const [path, contents] of Object.entries(spec.configFiles ?? {})) {
      harness.setConfigFile(path, contents);
    }
    harness.serveConfigZone(spec.installed ?? []);
    // Every config path the two readers prime from has to *answer*, or the
    // prime's read sits in the request queue forever. A path the spec supplied
    // is already served; the rest say `not_found`, which is what the daemon says
    // about a vault with no settings file.
    for (const path of configFilePathsFor(harness)) {
      if (spec.configFiles?.[path] === undefined) harness.unserveFile(path);
    }
    await harness.openMirror({ generation: 1, entries: [], notes: [] });
    harness.assemble();
    // Both config readers prime in their constructors and are read
    // synchronously by the cases that follow. Awaiting the primes is what makes
    // "the first synchronous call answers" true rather than a race.
    await harness.vault.configReady();
    await harness.app.internalPlugins.ready();
    harness.bindPluginSet();
    harness.monitor.start();
    await harness.monitor.check();
    harness.clearMethodLog();
    return harness;
  }

  /**
   * Take the directory and the monitor off the assembly.
   *
   * Positional constructors, an injected error sink, and the `onPoll` wiring all
   * live in `assembleShim` — this harness deliberately holds no second copy of
   * any of it, because the wiring is exactly what the cases are here to check.
   */
  private bindPluginSet(): void {
    const mutable = this as { -readonly [K in "dir" | "monitor"]: PluginSetHarness[K] };
    mutable.dir = this.assembly.dir;
    mutable.monitor = this.assembly.coexistence;
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
   * Fire the overlap poll through the `TestClock`, and wait for it to finish.
   *
   * `overlapPollMs` is a minute in production, and a test that waited it out
   * would take a minute per case. Advancing the injected clock is what makes
   * the poll testable at all — which is the whole reason the clock is injected.
   *
   * The `settled()` await is not decoration. A tick fans out into a check and
   * every poll hook, and the hooks re-read up to eight config files one after
   * another; "the timer fired" is several daemon round trips away from "the
   * poll happened", and draining a fixed number of event-loop turns would be a
   * guess that passes today and hangs the day a hook reads one more file.
   */
  async advancePoll(): Promise<void> {
    await this.clock.advance(this.config.overlapPollMs);
    await this.monitor.settled();
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
