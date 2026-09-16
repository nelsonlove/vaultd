/**
 * A plugin's settings tab, schema ladder and data file: the harness Task 17
 * drives.
 *
 * The ladder is the thing under test: a plugin's settings schema is discovered
 * from `getSettingDefinitions()` where the plugin offers a usable one, from a
 * field-descriptor array its bundle exports where it does not, and from its
 * `DEFAULT_SETTINGS` as a last resort — each rung less certain than the one
 * above it, and the harness lets a case supply exactly one rung so the fallback
 * that actually ran is never in doubt.
 *
 * **Reconciled against what Task 17 built**, which the pending draft could only
 * guess at. Three things moved and each was a real disagreement rather than a
 * rename:
 *
 * - `SchemaLadder` takes the data directory it caches under (and this harness's
 *   clock, so a captured-at stamp is a value a case can pin), and
 *   `PluginConfigService` takes the four arguments the brief pins plus the two
 *   wirings Ruling 3 needs: `app.plugins`, to find the loaded instance whose
 *   `onExternalSettingsChange` a write has to call, and the dispatch queue that
 *   entry point goes through.
 * - The draft's `service.stubPlugin` and `service.discover` are gone. Building a
 *   plugin is not a config service's job, and the ladder needs no discovery
 *   pass: `climb` is called with the plugin and reads the harvest itself. The
 *   harness builds the stub here instead, the way production builds a real one —
 *   an `App` with a plugin host installed, a `Harvest` recording the live
 *   settings tab, the bundle's exports kept beside it.
 * - `data.json` is served through the **daemon**, at
 *   `<configDir>/plugins/<id>/data.json`, rather than written into the host's
 *   own data directory. That is where the file really lives (Ruling 3), it is
 *   the path `Plugin.saveData` writes, and reading it any other way would have
 *   made every case in `settings-safety.test.ts` pass against a file the host
 *   does not use.
 *
 * **The data directory is a fresh one under the repository's `target/tmp`**,
 * never `$XDG_STATE_HOME/vaultd-host`: the ladder's cache is a real write, and a
 * harness that took the configured value would leave schema files in the
 * developer's home directory and let two test files share one cache.
 */

import { join, resolve } from "node:path";

import { App } from "../shim/app";
import { DaemonHarness } from "./daemon-harness";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../settings/plugin-config";
import { DispatchQueue } from "../runtime/queue";
import { Harvest } from "../shim/harvest";
import { HeadlessConfigDir } from "../pluginset/config-dir";
import { HostErrors } from "../shim/errors";
import { Plugin, installPluginHost } from "../shim/plugin";
import { PluginRegistry } from "../shim/plugin-registry";
import { SchemaLadder } from "../settings/ladder";
import { ShimEventBus } from "../shim/events";
import { forwardingWriteGate } from "./assemble";
import { fs } from "../runtime/fs-access";
import { revisionOfSource } from "./daemon-harness";
import { socketPathFor } from "../config";
import { sweepStaleDataDirs } from "./shim-harness";
import type { CachedSchema } from "../settings/ladder";
import type { HostConfig } from "../config";
import type { PluginManifest, PluginSettingTab } from "../shim/plugin";

/**
 * What a case says about the plugin it is climbing against. Everything is
 * optional, and a spec that says nothing describes a plugin with no settings
 * tab, no descriptor array and no defaults — the `source: "none"` floor.
 */
export interface SettingsTabSpec {
  getSettingDefinitions?: () => unknown[];
  display?: () => void;
  /**
   * What the bundle exported. `unknown` rather than a record, because the plain
   * CommonJS idiom exports a **function** (`module.exports = MyPlugin`) and both
   * lower rungs read own properties off one.
   */
  moduleExports?: unknown;
  onExternalSettingsChange?: () => void;
}

/**
 * A cached schema as a case writes one: the two fields that matter, with the
 * envelope filled in from the harness's own manifest and clock.
 */
export type SeededSchema = Pick<CachedSchema, "source" | "items">;

export class SettingsHarness extends DaemonHarness {
  readonly ladder: SchemaLadder;
  readonly service: PluginConfigService;
  readonly plugin: Plugin;
  readonly manifest: PluginManifest;
  /** The host data directory the ladder caches schemas under. */
  readonly dataDir: string;

  readonly app: App;
  readonly harvest: Harvest;
  /**
   * The headless config directory the service reads and writes through.
   *
   * Public because a case sometimes has to ask the layer *below* the service
   * what it answered: "a `data.json` holding the literal `null` reads as an
   * empty document" is a claim about this method, and every caller above it
   * collapses `null` and `{}` with a `??`.
   */
  readonly dir: HeadlessConfigDir;
  private readonly queue = new DispatchQueue();
  /** Every vault path this harness's daemon serves, by content. */
  private readonly stored = new Map<string, string>();

  protected constructor(
    pluginId: string,
    spec: SettingsTabSpec,
    overrides: Partial<HostConfig> = {},
  ) {
    super({ ...configFor(freshDataDir()), ...overrides });
    this.dataDir = this.config.dataDir;
    this.manifest = {
      id: pluginId,
      name: pluginId,
      version: "0.0.1",
      minAppVersion: "1.0.0",
      author: "the harness",
      description: `${pluginId}, under the settings harness`,
    };
    this.serveFiles();
    this.ladder = new SchemaLadder(this.dataDir, this.clock);
    // On the forwarding default deliberately: this harness has no `--dry-run`
    // mode and its whole subject is what really lands in `data.json`, so a gate
    // that recorded instead of writing would make every case here vacuous.
    this.dir = new HeadlessConfigDir(this.client, this.config);
    this.harvest = new Harvest();
    this.app = new App({ appId: "settings-harness", appVersion: this.config.appVersion });
    const plugins = new PluginRegistry();
    Object.assign(this.app, { plugins });
    installPluginHost(this.app, {
      config: this.config,
      client: this.client,
      writes: forwardingWriteGate(this.client),
      harvest: this.harvest,
      events: new ShimEventBus(),
      queue: this.queue,
      clock: this.clock,
      errors: new HostErrors(),
    });
    this.service = new PluginConfigService(
      this.dir,
      this.ladder,
      DEFAULT_KEY_REGISTRY,
      this.config,
      { plugins, queue: this.queue },
    );
    this.plugin = new HarnessPlugin(this.app, this.manifest);
    // A tab is registered when the spec describes one, and not otherwise: a
    // plugin that never called `addSettingTab` has no rung-1 candidate at all,
    // which is a different state from one whose tab declares nothing.
    if (spec.getSettingDefinitions !== undefined || spec.display !== undefined) {
      this.plugin.addSettingTab(tabFrom(spec));
    }
    if (spec.moduleExports !== undefined) {
      this.harvest.recordModuleExports(pluginId, spec.moduleExports);
    }
    if (spec.onExternalSettingsChange !== undefined) {
      this.plugin.onExternalSettingsChange = spec.onExternalSettingsChange;
    }
    plugins.register(this.plugin);
  }

  /** A plugin whose settings tab is exactly what `spec` describes. */
  static withTab(spec: SettingsTabSpec): Promise<SettingsHarness> {
    return Promise.resolve(new SettingsHarness("settings-fixture", spec));
  }

  /**
   * A plugin whose `data.json` already holds `data`.
   *
   * The optional `schema` seeds the ladder's cache for this plugin's version,
   * which is how a case drives `set`'s refusals without climbing a rung first:
   * the service reads the cache, so what is in it *is* what the service knows.
   */
  static withData(
    pluginId: string,
    data: Record<string, unknown>,
    options: {
      schema?: SeededSchema;
      onExternalSettingsChange?: () => void;
      config?: Partial<HostConfig>;
    } = {},
  ): Promise<SettingsHarness> {
    const spec: SettingsTabSpec = {};
    if (options.onExternalSettingsChange !== undefined) {
      spec.onExternalSettingsChange = options.onExternalSettingsChange;
    }
    const harness = new SettingsHarness(pluginId, spec, options.config ?? {});
    harness.stored.set(harness.dir.dataPath(pluginId), `${JSON.stringify(data, null, 2)}\n`);
    if (options.schema !== undefined) {
      harness.ladder.write({
        pluginId,
        pluginVersion: harness.manifest.version,
        capturedAtUnixMs: harness.clock.now(),
        ...options.schema,
      });
    }
    return Promise.resolve(harness);
  }

  /**
   * A plugin whose `data.json` holds exactly these **bytes**.
   *
   * {@link withData}'s counterpart for the documents a JSON value cannot
   * express: a file a human damaged, a bare `null`, an array where an object
   * belongs. What a config service does with each of those is a decision, and a
   * decision needs a case.
   */
  static withRawData(pluginId: string, source: string): Promise<SettingsHarness> {
    const harness = new SettingsHarness(pluginId, {});
    harness.stored.set(harness.dir.dataPath(pluginId), source);
    return Promise.resolve(harness);
  }

  /** What is on disk right now — not what the plugin believes it wrote. */
  readData(pluginId: string): Promise<Record<string, unknown>> {
    const source = this.stored.get(this.dir.dataPath(pluginId));
    if (source === undefined) return Promise.resolve({});
    return Promise.resolve(JSON.parse(source) as Record<string, unknown>);
  }

  /**
   * The exact bytes of `data.json`, or `undefined` when there is no file.
   *
   * {@link readData} answers the parsed document, which is the right question
   * for "did the merge preserve that key" and the wrong one for "did this call
   * leave the file alone": a rewrite that changes nothing but the last byte is
   * invisible to a parse and obvious here.
   */
  rawData(pluginId: string): string | undefined {
    return this.stored.get(this.dir.dataPath(pluginId));
  }

  /**
   * Answer the three verbs the config directory uses, and remember the writes.
   *
   * Remembering is the point: `set` reads the document, merges over it and
   * writes the whole thing back, so "the keys the patch did not mention
   * survived" is only a fact a case can assert if the next read sees the write.
   */
  private serveFiles(): void {
    this.serve((request) => {
      const method = request.request.method;
      const path = (request.request.params as { path?: string } | undefined)?.path;
      if (path === undefined) return false;
      if (method === "read_file") {
        const content = this.stored.get(path);
        if (content === undefined) {
          this.respondErr(request.id, { code: "not_found", message: `${path} does not exist` });
          return true;
        }
        this.respondReadFile(request.id, content, revisionOfSource(content));
        return true;
      }
      if (method === "write_file") {
        const encoded = (request.request.params as { content_base64?: string }).content_base64;
        if (encoded === undefined) return false;
        const content = Buffer.from(encoded, "base64").toString("utf8");
        this.stored.set(path, content);
        // `semantic: false`, and therefore no generation: every path this
        // harness serves is inside a hidden config directory, and nothing there
        // joins one.
        this.respondOk(request.id, "write_file", {
          revision: revisionOfSource(content),
          semantic: false,
        });
        return true;
      }
      if (method === "create_folder") {
        this.respondOk(request.id, "create_folder", { path });
        return true;
      }
      return false;
    });
  }
}

/** The concrete `Plugin` the harness hands the ladder. It registers nothing of its own. */
class HarnessPlugin extends Plugin {}

/**
 * The settings tab a spec describes.
 *
 * Built by hand rather than from a `PluginSettingTab` subclass because the
 * structural type is the whole contract the harvest and the ladder have with
 * it: `addSettingTab` records whatever the plugin passed, and rung 1 calls
 * `getSettingDefinitions()` on exactly that object. Assigned conditionally so
 * that a spec with only a `display` really does present a tab with no
 * `getSettingDefinitions` at all — a method that exists and answers nothing is
 * a different plugin from one that never had the method.
 */
function tabFrom(spec: SettingsTabSpec): PluginSettingTab {
  const tab: PluginSettingTab = {};
  if (spec.getSettingDefinitions !== undefined) {
    tab.getSettingDefinitions = spec.getSettingDefinitions;
  }
  if (spec.display !== undefined) tab.display = spec.display;
  return tab;
}

/** Every config override this harness makes on its own behalf. */
function configFor(dataDir: string): Partial<HostConfig> {
  return {
    dataDir,
    // Derived from the harness's own data dir, never the real one: a socket
    // path left pointing into the user's home directory would put the host back
    // outside the tree it was told to stay in the moment anything created its
    // parent.
    socketPath: socketPathFor(dataDir, "/vault"),
    allowNetwork: false,
  };
}

/**
 * A directory no other harness has, under the repository's own `target/tmp`.
 *
 * The same name family `ShimHarness` uses, deliberately: one sweep collects
 * both, and a stale schema cache is exactly as much litter as a stale
 * `localStorage` document.
 */
function freshDataDir(): string {
  const root = resolve(__dirname, "..", "..", "..", "..", "..", "target", "tmp");
  fs.mkdirSync(root, { recursive: true });
  if (!swept) {
    swept = true;
    sweepStaleDataDirs(root);
  }
  return fs.mkdtempSync(join(root, "host-state-"));
}

/** One sweep per process, at the first harness. */
let swept = false;
