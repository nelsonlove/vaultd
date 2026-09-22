/**
 * `app.plugins` — what one plugin can see of another.
 *
 * **Cross-plugin lookup is not an edge case in this corpus.** folder-notes asks
 * for `obsidian-front-matter-title-plugin` and uses its API when it is there;
 * rollover-daily-todos asks for `periodic-notes` and falls back to the core
 * daily-notes settings when it is not; quickadd asks for `templater-obsidian`.
 * All three go through this object, and all three already defend against a
 * missing answer — which is why `getPlugin` returns **`null`** for an id that
 * is not loaded rather than `undefined` or a throw: `null` is what Obsidian
 * answers for a plugin that is not installed, and it is the value those guards
 * were written against.
 *
 * **No load-order computation, deliberately.** Obsidian loads plugins in
 * manifest order and a plugin that looks up another during `onload` may find it
 * absent purely because of that order. Since every consumer in the corpus
 * already handles the absent case, ordering the loads to make a lookup succeed
 * would be a behaviour this host had and Obsidian did not.
 *
 * **Enabling and disabling belong to the loader, not here.** `enablePlugin` /
 * `disablePlugin` are the two mutating calls a plugin can make against this
 * surface — quickadd offers a "reload plugin" affordance that uses them — and
 * what they *mean* is "load this bundle" / "tear that one down", which is Task
 * 14's plugin loader. So this registry takes an optional {@link PluginLoader}
 * seam: with one installed the calls do the real thing, and without one they
 * are recorded and answered rather than performed. They never throw, because
 * both are reachable from inside an `onload`.
 */

import { declarePolicy, recordUse, stub } from "./policy";
import type { Plugin, PluginManifest } from "./plugin";

/**
 * The loader seam, filled in by Task 14.
 *
 * An interface rather than a concrete class so this registry — which every
 * plugin holds a reference to — does not have to know how a bundle is found,
 * read or evaluated.
 */
export interface PluginLoader {
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
}

export class PluginRegistry {
  /**
   * Every loaded plugin, by id. A plain object because that is what plugins
   * read: `app.plugins.plugins["dataview"]?.api` is the idiom.
   */
  readonly plugins: Record<string, Plugin> = {};

  /** Every loaded plugin's manifest, by id — the second shape plugins read. */
  readonly manifests: Record<string, PluginManifest> = {};

  /**
   * The ids this host considers enabled.
   *
   * A `Set`, because that is the type Obsidian's own field has and plugins call
   * `.has(...)` on it. It tracks *loaded and running*: a plugin the host has
   * torn down is not enabled, whatever a config file says about it.
   */
  readonly enabledPlugins = new Set<string>();

  private loader: PluginLoader | null = null;

  getPlugin(id: string): Plugin | null {
    recordUse("PluginRegistry.getPlugin");
    return this.plugins[id] ?? null;
  }

  isEnabled(id: string): boolean {
    recordUse("PluginRegistry.isEnabled");
    return this.enabledPlugins.has(id);
  }

  /**
   * Ask the loader to load and enable a plugin.
   *
   * Already enabled is a no-op. With no loader installed the call is recorded
   * and answered — see the header — rather than refused.
   */
  async enablePlugin(id: string): Promise<void> {
    if (this.enabledPlugins.has(id)) return;
    if (this.loader === null) {
      stub("PluginRegistry.enablePlugin", undefined);
      return;
    }
    await this.loader.enable(id);
  }

  /** The counterpart. Disabling a plugin that is not loaded is a no-op. */
  async disablePlugin(id: string): Promise<void> {
    if (!this.enabledPlugins.has(id)) return;
    if (this.loader === null) {
      stub("PluginRegistry.disablePlugin", undefined);
      return;
    }
    await this.loader.disable(id);
  }

  // --- Host-only ------------------------------------------------------------

  /**
   * **HOST-ONLY.** Install the loader. Called once, by whatever owns plugin
   * lifecycles — Task 14's loader in production, nothing in a harness.
   */
  setLoader(loader: PluginLoader | null): void {
    this.loader = loader;
  }

  /**
   * **HOST-ONLY.** Record a plugin as loaded and enabled.
   *
   * Called **before** the plugin's `onload` runs, which is what Obsidian does
   * and what a plugin that looks itself up during startup depends on.
   */
  register(plugin: Plugin): void {
    this.plugins[plugin.manifest.id] = plugin;
    this.manifests[plugin.manifest.id] = plugin.manifest;
    this.enabledPlugins.add(plugin.manifest.id);
  }

  /**
   * **HOST-ONLY.** Forget a plugin the host has torn down.
   *
   * The manifest goes with it. A quarantine that left the manifest behind would
   * leave another plugin able to read a version number for something that is no
   * longer running.
   */
  deregister(id: string): void {
    delete this.plugins[id];
    delete this.manifests[id];
    this.enabledPlugins.delete(id);
  }
}

// The rows this file owns. The class itself is not a barrel export — Obsidian's
// module does not publish it — so only the members are declared here.
declarePolicy("PluginRegistry.getPlugin", "implemented");
declarePolicy("PluginRegistry.isEnabled", "implemented");
declarePolicy("PluginRegistry.enablePlugin", "safe_stub");
declarePolicy("PluginRegistry.disablePlugin", "safe_stub");
