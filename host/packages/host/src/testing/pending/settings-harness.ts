/**
 * A plugin's settings tab, schema ladder and data file: the harness Task 17
 * drives.
 *
 * **Not yet activated.** Written for `src/testing/settings-harness.ts`, with
 * its imports spelled for that home. Task 17's Step 1 moves it:
 *
 * ```
 * git mv src/testing/pending/settings-harness.ts src/testing/settings-harness.ts
 * ```
 *
 * The ladder is the thing under test: a plugin's settings schema is discovered
 * from `getSettingDefinitions()` where the plugin offers one, from what its
 * `display()` builds where it does not, and from its module exports as a last
 * resort — each rung less certain than the one above it, and the harness lets a
 * case supply exactly one rung so the fallback that actually ran is never in
 * doubt.
 */

import { DaemonHarness } from "./daemon-harness";
import { DataDir } from "../datadir";
import { PluginConfigService } from "../settings/plugin-config";
import { SchemaLadder } from "../settings/ladder";
import type { CachedSchema } from "../settings/ladder";
import type { Plugin, PluginManifest } from "../shim/plugin";

export interface SettingsTabSpec {
  getSettingDefinitions?: () => unknown[];
  display?: () => void;
  moduleExports?: Record<string, unknown>;
  onExternalSettingsChange?: () => void;
}

export class SettingsHarness extends DaemonHarness {
  readonly ladder: SchemaLadder;
  readonly service: PluginConfigService;
  readonly plugin: Plugin;
  readonly manifest: PluginManifest;
  /** The host data directory the plugin's `data.json` lives under. */
  readonly dataDir: string;

  private readonly dir: DataDir;

  protected constructor(pluginId: string, spec: SettingsTabSpec) {
    super({});
    this.manifest = {
      id: pluginId,
      name: pluginId,
      version: "0.0.1",
      minAppVersion: "1.0.0",
      author: "the harness",
      description: `${pluginId}, under the settings harness`,
    };
    this.dir = new DataDir(this.config.dataDir);
    this.dataDir = this.dir.root;
    this.ladder = new SchemaLadder();
    this.service = new PluginConfigService({
      dir: this.dir,
      ladder: this.ladder,
      clock: this.clock,
    });
    this.plugin = this.service.stubPlugin(this.manifest, spec);
  }

  /** A plugin whose settings tab is exactly what `spec` describes. */
  static async withTab(spec: SettingsTabSpec): Promise<SettingsHarness> {
    const harness = new SettingsHarness("settings-fixture", spec);
    await harness.service.discover(harness.plugin);
    return harness;
  }

  /**
   * A plugin whose `data.json` already holds `data`.
   *
   * The optional `schema` seeds the cached rung, which is how a case asserts
   * that a *cached* schema is used rather than re-derived — the difference is
   * invisible in the answer and obvious in the method log.
   */
  static async withData(
    pluginId: string,
    data: Record<string, unknown>,
    options: { schema?: CachedSchema; onExternalSettingsChange?: () => void } = {},
  ): Promise<SettingsHarness> {
    const spec: SettingsTabSpec = {};
    if (options.onExternalSettingsChange !== undefined) {
      spec.onExternalSettingsChange = options.onExternalSettingsChange;
    }
    const harness = new SettingsHarness(pluginId, spec);
    harness.dir.writeJson(`plugins/${pluginId}/data.json`, data);
    if (options.schema !== undefined) harness.ladder.seed(pluginId, options.schema);
    await harness.service.discover(harness.plugin);
    return harness;
  }

  /** What is on disk right now — not what the plugin believes it wrote. */
  readData(pluginId: string): Promise<Record<string, unknown>> {
    return Promise.resolve(
      this.dir.readJson<Record<string, unknown>>(`plugins/${pluginId}/data.json`) ?? {},
    );
  }
}
