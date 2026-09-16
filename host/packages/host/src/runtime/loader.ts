/**
 * How a bundle gets loaded — the **first** of the two module mechanisms, and the
 * plugin lifecycle that hangs off it.
 *
 * Tasks 1–12 built everything a bundle reaches once it is running. This is the
 * door it comes in through.
 *
 * **Resolution, not patching.** `loadPluginBundle` builds a real `Module` whose
 * `paths` array *starts* with the host's own `node_modules`. A bundle sitting at
 * `<vault>/.obsidian-headless/plugins/<id>/main.js` therefore resolves
 * `require("obsidian")` to the workspace's `obsidian` package by Node's own
 * algorithm, with nothing patched — and every other specifier in the bundle
 * keeps Node's ordinary semantics, which is how `require("tty")` and
 * `require("util")` come out as the real builtins. `runtime/intercept.ts` is the
 * fallback for the requires this cannot reach; it is not the main road.
 *
 * **No `vm` context.** Plugins run with the host's Node privileges, exactly as
 * they do under Electron. The design's non-goals say so and `--dry-run` is a
 * refusal gate rather than a sandbox.
 *
 * **The wrapper shadows the four timer names, and it has to.** Five of the eight
 * golden bundles call `setTimeout` and `setInterval` **bare**, because that is
 * what a browser build does. A bare name inside a module resolves to
 * `globalThis`, and `globalThis.setTimeout` is Node's own — which the injected
 * clock cannot see, a test cannot advance, and the harvest cannot count. The
 * host's `window` carries clock-routed versions of all four, and `globals.ts`
 * cannot make a bare call reach them (replacing Node's own timers would freeze
 * the runtime). So this loader wraps the source in a function whose parameters
 * are those four names, taken from `window`. Inside a bundle the bare spelling
 * is then `window`'s, which is exactly what it is in the browser the bundle was
 * compiled for.
 *
 * The wrapper is a **prefix and a suffix**, never an insertion, so every line of
 * a bundle keeps its line number in a stack trace. Parameters rather than
 * `const` declarations, so a bundle that declares `var setTimeout` of its own
 * shadows a parameter — legal — instead of colliding with a `const`, which is a
 * `SyntaxError` that would take the whole plugin down.
 */

import Module from "node:module";
import { dirname } from "node:path";

import { clearTimersOwnedBy } from "../shim/timers";
import { stub } from "../shim/policy";
import type { App } from "../shim/app";
import type { DispatchQueue } from "./queue";
import type { Harvest } from "../shim/harvest";
import type { HostErrors } from "../shim/errors";
import type { Plugin, PluginManifest } from "../shim/plugin";
import type { PluginLoader } from "../shim/plugin-registry";
import type { ShimEventBus } from "../shim/events";

export interface BundleLoadRequest {
  readonly pluginId: string;
  /** The absolute path of the materialised `main.js`. */
  readonly filename: string;
  /**
   * The bundle's source, as a string.
   *
   * Passed in rather than read here: reading a plugin directory is the config
   * zone's job and goes through the daemon's `read_file`, which is Task 14's.
   * This module compiles what it is handed.
   */
  readonly source: string;
  /** Prepended to the module's `paths`. See the header. */
  readonly hostModulePaths: readonly string[];
}

export interface LoadedBundle {
  readonly exports: unknown;
  readonly pluginClass: new (app: App, manifest: PluginManifest) => Plugin;
}

/** What Node's `Module` really has, under the parts its typings publish. */
interface CompilableModule {
  filename: string;
  paths: string[];
  exports: unknown;
  _compile(code: string, filename: string): unknown;
}

interface ModulePaths {
  _nodeModulePaths(from: string): string[];
}

/**
 * The four names a browser build calls bare, and the object they come from.
 *
 * Parameters rather than declarations: a bundle that declares `var setTimeout`
 * of its own shadows a parameter, which is legal, where it would collide with a
 * `const` and take the plugin down with a `SyntaxError`.
 */
const CLOCK_NAMES = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"];

/**
 * Wrap a bundle so its bare timer calls are `window`'s.
 *
 * **Prefix and suffix, never an insertion.** Everything before the source is on
 * source line 1 and everything after begins with a newline, so every line of the
 * bundle keeps the number a stack trace will print. An insertion after the
 * directive prologue would have been the alternative and it moves nothing, but
 * it also means finding the prologue, and a `"use strict"` mis-parsed out of the
 * prologue silently un-stricts the whole bundle. Wrapping keeps the directive
 * exactly where it is: first statement of a function body, which is still a
 * directive prologue, applying to the bundle and nothing else.
 *
 * `globalThis` is the fallback for a caller with no host assembled — a loader
 * test compiling a bundle on its own. The names are then Node's, which is what
 * they would have been with no wrapper at all.
 */
function loadPluginBundleWrapper(source: string): string {
  // A shebang is only a shebang at byte zero. No bundle in the corpus has one,
  // and a bundle that did would become a syntax error once anything preceded
  // it, so it is dropped rather than moved.
  const body = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  const names = CLOCK_NAMES.join(",");
  const from = CLOCK_NAMES.map((name) => `__vaultdWindow.${name}`).join(",");
  return (
    `;(function(__vaultdWindow){(function(${names}){` +
    body +
    `\n}).call(this,${from});}).call(this,typeof window==="undefined"?globalThis:window);`
  );
}

/**
 * A bundle that would not evaluate, or that evaluated into nothing usable.
 *
 * **Typed and attributed, because a raw throw from `_compile` is neither.** A
 * bundle's own module-scope error arrives as whatever the bundle threw — often
 * a bare `Error` with a message about a variable nobody outside that bundle has
 * heard of — and nothing in it names the plugin. A host that hands that
 * straight to its caller has lost the one fact the caller needs. The original
 * is kept as `cause`, so nothing is hidden.
 */
export class PluginBundleFailed extends Error {
  readonly code = "plugin_bundle_failed";
  readonly pluginId: string;
  constructor(pluginId: string, reason: string, options?: { cause?: unknown }) {
    super(`plugin ${pluginId} could not be loaded: ${reason}`, options);
    this.name = "PluginBundleFailed";
    this.pluginId = pluginId;
  }
}

/**
 * A plugin whose `onload` threw. The host has already rolled it back.
 *
 * Separate from {@link PluginBundleFailed} because the two leave the host in
 * different states and a caller branches on that: a bundle that would not
 * evaluate never registered anything, while a plugin whose `onload` threw was
 * registered, ran, and has been taken back out again.
 */
export class PluginLoadFailed extends Error {
  readonly code = "plugin_load_failed";
  readonly pluginId: string;
  constructor(pluginId: string, options?: { cause?: unknown }) {
    super(`plugin ${pluginId} threw during onload and has been rolled back`, options);
    this.name = "PluginLoadFailed";
    this.pluginId = pluginId;
  }
}

export function loadPluginBundle(request: BundleLoadRequest): LoadedBundle {
  // `undefined`, not `null`. Node's constructor is `Module(id, parent?: Module)`
  // and its body does `if (parent && parent.children)` — `null` works today by
  // accident, and the declared type is `Module | undefined`, which `strict`
  // TypeScript holds us to. Use the spelling the signature actually has.
  const mod = new Module(request.filename, undefined) as unknown as CompilableModule;
  mod.filename = request.filename;
  mod.paths = [
    ...request.hostModulePaths,
    ...(Module as unknown as ModulePaths)._nodeModulePaths(dirname(request.filename)),
  ];
  try {
    mod._compile(loadPluginBundleWrapper(request.source), request.filename);
  } catch (error: unknown) {
    throw new PluginBundleFailed(request.pluginId, describe(error), { cause: error });
  }
  const exported = mod.exports;
  // Both shapes in the corpus: esbuild bundles export the class on `default`
  // through `__toCommonJS`, rollup bundles assign it straight to
  // `module.exports`.
  const candidate = (exported as { default?: unknown } | null)?.default ?? exported;
  if (typeof candidate !== "function") {
    throw new PluginBundleFailed(request.pluginId, "it exported no Plugin class");
  }
  return { exports: mod.exports, pluginClass: candidate as LoadedBundle["pluginClass"] };
}

/** One line naming what went wrong, whatever a bundle chose to throw. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * `window.require`, for the moment a QuickAdd user script needs it.
 *
 * **Replaces Task 11a's typed refusal, and `restore()` puts that refusal back.**
 * The refusal is the right answer for a *plugin bundle*: a bundle gets its own
 * `require` from the module wrapper, so a bundle reaching for `window.require`
 * is reaching around its own door and the report should say so. A **user
 * script** is different — QuickAdd loads one with
 * `new Function("require", "module", "exports", src)`, passing a one-line shim
 * that forwards its specifier to `window.require` when there is one. It
 * supplies `module` and `exports` itself, so the only thing it needs from this
 * host is `window.require` being a real function. Scripts in the corpus
 * genuinely reach Node this way.
 *
 * (The shape of that one-liner is not spelled out here on purpose:
 * `test/fs-seam.test.ts` bans a dynamic `require` call anywhere under `src/`,
 * prose included, because a grep cannot tell a quoted example from a call.)
 *
 * `globalThis.module` and `globalThis.exports` are defensive: a script written
 * outside QuickAdd's wrapper may reference them, and an inert pair is a cheaper
 * answer than a `ReferenceError`. The load-bearing one is `window.require`.
 *
 * The host's own `require` is **passed in** rather than built here, because
 * `test/fs-seam.test.ts` bans this module from constructing one — and rightly:
 * a module that can mint a `require` can reach the file system without naming
 * it. The caller that owns the host's module identity hands its own over.
 */
export function provisionUserScriptGlobals(hostRequire: NodeJS.Require): { restore(): void } {
  const window = (globalThis as { window?: object }).window;
  const previous: Array<[object, string, PropertyDescriptor | undefined]> = [
    [globalThis, "require", Object.getOwnPropertyDescriptor(globalThis, "require")],
    [globalThis, "module", Object.getOwnPropertyDescriptor(globalThis, "module")],
    [globalThis, "exports", Object.getOwnPropertyDescriptor(globalThis, "exports")],
  ];
  if (window !== undefined) {
    previous.push([window, "require", Object.getOwnPropertyDescriptor(window, "require")]);
  }
  provide(globalThis, "require", hostRequire);
  provide(globalThis, "module", { exports: {} });
  provide(globalThis, "exports", {});
  if (window !== undefined) provide(window, "require", hostRequire);
  return {
    restore(): void {
      for (const [target, key, descriptor] of previous) {
        if (descriptor === undefined) delete (target as Record<string, unknown>)[key];
        else Object.defineProperty(target, key, descriptor);
      }
    },
  };
}

function provide(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
}

/** One bundle plus the manifest it runs under. */
export interface BundleSource {
  readonly request: BundleLoadRequest;
  readonly manifest: PluginManifest;
}

export interface BundleLoaderDeps {
  readonly app: App;
  readonly queue: DispatchQueue;
  readonly events: ShimEventBus;
  readonly harvest: Harvest;
  /**
   * Where a failed `onload` is reported, with phase `"onload"`.
   *
   * The rejected promise is for the caller that is waiting; this is for
   * everything else — the quarantine, the compatibility report, and a human
   * reading a log. "Swallowed" and "reported" look identical from outside, so
   * the failure goes to both places.
   */
  readonly errors: HostErrors;
  /**
   * How `enablePlugin(id)` finds a bundle to load.
   *
   * Optional, and absent is not an error: `app.plugins.enablePlugin` is
   * reachable from inside another plugin's `onload` — quickadd offers a "reload
   * plugin" affordance that calls it — so an id nothing can supply is answered
   * and recorded rather than refused. Task 14's plugin set is what fills this
   * in; a test supplies its own.
   */
  provide?(id: string): BundleSource | null;
}

/**
 * The lifecycle half of the loader: construct, register, load, tear down.
 *
 * **It is what backs `app.plugins`.** Until now only the test harness called
 * `PluginRegistry.register`, and `enablePlugin`/`disablePlugin` were inert
 * stubs with a seam waiting for an implementation — this is that
 * implementation. `register` happens **before** `onload`, which is what Obsidian
 * does and what a plugin that looks itself (or a peer) up during startup
 * depends on.
 *
 * **Tearing down is three steps and a quarantine needs all three**: the
 * plugin's own `onunload` plus its component teardown, every event registration
 * it made (`detachOwner`), and its whole harvest. A plugin that kept either of
 * the last two could still be invoked, or still be woken by a vault change,
 * after the host had decided it was gone.
 *
 * **Compilation runs inside the plugin's attribution window**, not just its
 * `onload`. A bundle's module scope is where several of them register
 * everything interesting — a `@codemirror` require, a prototype patch, a policy
 * hit — and a host that opened the window only for `onload` would record all of
 * it against nobody.
 */
export class BundleLoader implements PluginLoader {
  private readonly instances = new Map<string, Plugin>();

  constructor(private readonly deps: BundleLoaderDeps) {}

  /** Compile a bundle, construct its plugin, register it, and run `onload`. */
  async loadBundle(source: BundleSource): Promise<Plugin> {
    const id = source.manifest.id;
    const bundle = await this.deps.queue.run(id, `${id}:compile`, () =>
      this.deps.events.attributingTo(id, () => loadPluginBundle(source.request)),
    );
    // Kept before the plugin is constructed, because a bundle whose `onload`
    // throws is still a bundle whose settings this host can describe — and
    // because Task 17's ladder reads `SETTINGS_CATALOG` / `DEFAULT_SETTINGS`
    // off exactly this object, which nothing else in the process holds once
    // the plugin class has been read out of it. Dropped again by
    // `Harvest.forgetPlugin` when the plugin is torn down.
    this.deps.harvest.recordModuleExports(id, bundle.exports);
    const plugin = new bundle.pluginClass(this.deps.app, source.manifest);
    await this.load(plugin);
    return plugin;
  }

  /**
   * Register and load a plugin this loader did not compile.
   *
   * **Registration comes before `onload` and a failure rolls it back.** The
   * order is Obsidian's, and a plugin that looks itself (or a peer) up during
   * startup depends on it — but "registered" is a claim about a plugin that is
   * running, and a plugin whose `onload` threw is not. Left half-registered it
   * would still be listed as enabled, still be findable by every other plugin,
   * still own its harvested commands, and still be woken by vault changes;
   * worse, a compatibility report would count it among the plugins that work.
   *
   * So the failure path undoes all of it — through {@link unload}, which is the
   * same three-step teardown a deliberate unload takes, so a partial `onload`
   * cannot leave an armed interval or a live subscription behind — reports the
   * cause through the error seam with phase `"onload"`, and hands the caller a
   * {@link PluginLoadFailed} naming the plugin.
   */
  async load(plugin: Plugin): Promise<void> {
    const id = plugin.manifest.id;
    this.instances.set(id, plugin);
    this.deps.app.plugins.register(plugin);
    try {
      await this.deps.queue.run(id, `${id}:onload`, async () => {
        await this.deps.events.attributingTo(id, () => plugin.load());
      });
    } catch (error: unknown) {
      // `unload` never throws — `Component.unload` is written not to — so the
      // rollback cannot itself bury the cause.
      await this.unload(id);
      // **And the loader does not hold it either.** `unload` deliberately keeps
      // its map entry — a plugin the host loaded and then tore down is one it
      // knows about, and `Component.unload`'s own idempotence is what a second
      // call is meant to exercise. A plugin that never finished loading is a
      // different thing: nothing may hand it back, or a caller asking "what is
      // loaded under this id" gets an instance that was rolled back.
      this.instances.delete(id);
      this.deps.errors.report(error, id, "onload");
      throw new PluginLoadFailed(id, { cause: error });
    }
  }

  /**
   * Tear one plugin down completely.
   *
   * A plugin this loader never saw is a no-op rather than a throw. One it
   * **has** seen stays in the map and is unloaded again on a second call,
   * deliberately: the idempotence that matters lives in `Component.unload`, and
   * short-circuiting here would hide a host that had lost it.
   */
  async unload(id: string): Promise<void> {
    const plugin = this.instances.get(id);
    if (plugin === undefined) return;
    await this.deps.queue.run(id, `${id}:onunload`, () => {
      plugin.unload();
    });
    this.deps.events.detachOwner(id);
    this.deps.harvest.forgetPlugin(id);
    // **After the component teardown, so it only sweeps what is left.**
    // `Component.unload` disarms the timers the plugin handed to
    // `registerInterval`; this disarms the ones it never did — a bare
    // `setInterval` in a bundle, which the loader's wrapper routes through this
    // host's clock. Obsidian cannot disarm those either, but this host owns the
    // clock: one left armed goes on firing into a plugin that is gone, with
    // nobody to attribute it to. See `shim/timers.ts`.
    clearTimersOwnedBy(id);
    this.deps.app.plugins.deregister(id);
  }

  /** Remember a plugin somebody else constructed, so `unload` can find it. */
  track(plugin: Plugin): void {
    this.instances.set(plugin.manifest.id, plugin);
  }

  /** The instance loaded under `id`, or `null`. */
  instance(id: string): Plugin | null {
    return this.instances.get(id) ?? null;
  }

  // --- PluginLoader, as `app.plugins` calls it -------------------------------

  async enable(id: string): Promise<void> {
    const source = this.deps.provide?.(id) ?? null;
    if (source === null) {
      // Recorded, not refused — see {@link BundleLoaderDeps.provide}.
      stub("PluginRegistry.enablePlugin", undefined);
      return;
    }
    await this.loadBundle(source);
  }

  async disable(id: string): Promise<void> {
    if (this.instances.get(id) === undefined) {
      // Nothing this loader knows about. Recorded rather than silent, so a
      // harness with a loader installed reports the same thing one without a
      // loader does — see {@link BundleLoaderDeps.provide}.
      stub("PluginRegistry.disablePlugin", undefined);
      return;
    }
    await this.unload(id);
  }
}
