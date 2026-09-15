import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BundleLoader, loadPluginBundle, provisionUserScriptGlobals } from "../src/runtime/loader";
import { installModuleInterception } from "../src/runtime/intercept";
import { HeadlessUnsupported, DryRunRefused, resetPolicyTable } from "../src/shim/policy";
import { ShimHarness } from "../src/testing/shim-harness";
import type { Interception } from "../src/runtime/intercept";
import type { PluginManifest } from "../src/shim/plugin";

/**
 * How a bundle gets loaded: the two module-resolution mechanisms, the wrapper
 * that shadows the four bare timer names, and the `require` a QuickAdd user
 * script needs.
 *
 * **Two mechanisms, in this order, and the order is the design.**
 * *Resolution first*: `loadPluginBundle` builds a `Module` whose `paths` begin
 * with the host's own `node_modules`, so an ordinary `require("obsidian")` in a
 * bundle sitting anywhere on disk resolves to the workspace's `obsidian`
 * package with no patching at all — Node's own algorithm does the work, and
 * every other specifier in the bundle keeps Node's ordinary semantics.
 * *`Module._load` patch second, as the fallback*: some requires never reach a
 * module this loader built — a bundle that re-requires itself, a nested worker
 * file, a `@codemirror/*` package that is not installed at all — so a narrow
 * patch maps those specifiers regardless of the requester. Narrow is the whole
 * of it: two bare specifiers plus one namespace, and everything else delegates
 * to the original `_load`.
 *
 * The policy table is module-scoped, so the reset that restores it to what the
 * imports declared goes **here**, at module scope, where this file's own
 * imports have finished evaluating. See `shim/policy.ts`.
 */
resetPolicyTable();

const nodeRequire = createRequire(__filename);
const HOST_ROOT = resolve(__dirname, "..", "..", "..");
const GOLDEN = join(HOST_ROOT, "fixtures", "golden");

const bundle = (name: string): { filename: string; source: string } => {
  const filename = join(__dirname, "fixtures", "bundles", name, "main.js");
  return { filename, source: readFileSync(filename, "utf8") };
};

/** The newest mtime under a tree, in ms. `0` for a tree that is not there. */
function newestMtime(root: string, extension: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, extension));
    else if (entry.name.endsWith(extension)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** Interceptions this file installed, torn down whatever a case did. */
let installed: Interception | null = null;
const intercepting = (options: { allowNodeBuiltins?: boolean; harvest?: ShimHarness["harvest"] } = {}): Interception => {
  installed = installModuleInterception({
    hostModulePaths: hostModulePaths(),
    allowNodeBuiltins: options.allowNodeBuiltins ?? true,
    harvest: options.harvest,
  });
  return installed;
};

function hostModulePaths(): readonly string[] {
  return [join(HOST_ROOT, "node_modules")];
}

afterEach(() => {
  installed?.restore();
  installed = null;
});

describe("the built dist the workspace packages resolve through", () => {
  it("is newer than the sources it is built from", () => {
    // `packages/obsidian/index.js` and `packages/electron/index.js` are plain
    // CommonJS and reach the host through `dist/`, not through the TypeScript
    // Vitest is running. So a bundle that resolves `obsidian` by Node's own
    // algorithm gets whatever `dist/` last held — and a stale one fails in a
    // shape that names neither this task nor the build. Fail here instead,
    // naming the command.
    const src = newestMtime(join(HOST_ROOT, "packages", "host", "src"), ".ts");
    const dist = newestMtime(join(HOST_ROOT, "packages", "host", "dist"), ".js");
    expect(dist, "no dist at all — run `npm --prefix host run build`").toBeGreaterThan(0);
    expect(
      dist,
      "dist is older than src — run `npm --prefix host run build` (npm test does it for you)",
    ).toBeGreaterThanOrEqual(src);
  });
});

describe("module interception", () => {
  it("resolves require('obsidian') from a bundle outside the host tree", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("cjs-plugin");
    const loaded = loadPluginBundle({
      pluginId: "cjs",
      filename,
      source,
      hostModulePaths: harness.hostModulePaths,
    });
    const instance = new loaded.pluginClass(harness.app, harness.manifestFor("cjs"));
    await instance.onload();
    expect((instance as unknown as { loadedWith: string }).loadedWith).toBe("Folder/Note.md");
    expect(harness.harvest.commands().map((c) => c.id)).toEqual(["cjs:probe"]);
  });

  it("serves the same class identities to a rollup default-interop bundle", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("rollup-interop");
    const loaded = loadPluginBundle({
      pluginId: "rollup",
      filename,
      source,
      hostModulePaths: harness.hostModulePaths,
    });
    const instance = new loaded.pluginClass(harness.app, harness.manifestFor("rollup"));
    await instance.onload();
    const seen = instance as unknown as { sawTFile: unknown; sawWindowApp: unknown; sawMoment: string };
    expect(seen.sawTFile).toBe(harness.api.TFile);
    expect(seen.sawWindowApp).toBe(harness.app);
    expect(seen.sawMoment).toBe("function");
  });

  it("intercepts obsidian, electron and @codemirror, delegating everything else", async () => {
    const harness = await ShimHarness.withVault({});
    const interception = intercepting({ harvest: harness.harvest });

    const path = nodeRequire("node:path") as { join(a: string, b: string): string };
    expect(path.join("a", "b")).toBe("a/b");
    // A Node builtin the corpus really reaches for: `nested-properties` calls
    // `require("tty")` at module scope, bare, and it must come out as Node's.
    const tty = nodeRequire("tty") as { isatty(fd: number): boolean };
    expect(typeof tty.isatty).toBe("function");

    const shim = nodeRequire("obsidian") as { normalizePath(p: string): string };
    expect(typeof shim.normalizePath).toBe("function");
    expect(shim.normalizePath("a//b.md")).toBe("a/b.md");
    const electron = nodeRequire("electron") as { shell: unknown };
    expect(electron.shell).toBeDefined();
    expect(interception.interceptedCount()).toBe(2);

    // The CodeMirror tier is out of scope by design, and exactly one golden
    // reaches it at module scope. An inert stub whose members are classes
    // rather than `undefined` is what lets that bundle finish evaluating.
    const state = nodeRequire("@codemirror/state") as { StateField: unknown; Prec: unknown };
    expect(typeof state.StateField).toBe("function");
    expect(typeof state.Prec).toBe("function");
    expect(interception.interceptedCount()).toBe(3);
    void harness;
  });

  it("records every @codemirror require on the harvest as an unreachable editor extension", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "cm-probe",
      class extends harness.api.Plugin {
        override onload(): void {
          intercepting({ harvest: harness.harvest });
          nodeRequire("@codemirror/view");
          nodeRequire("@codemirror/state");
        }
      },
    );
    await harness.load(plugin);
    const rows = harness.harvest.unreachable().filter((row) => row.kind === "editor_extension");
    expect(rows.map((row) => row.detail)).toEqual(["@codemirror/view", "@codemirror/state"]);
    expect(rows.every((row) => row.pluginId === "cm-probe")).toBe(true);
  });

  it("refuses the dangerous Node builtins under dry-run, and only those", () => {
    const interception = intercepting({ allowNodeBuiltins: false });
    for (const specifier of ["node:child_process", "node:http", "node:https", "node:net"]) {
      const reach = (): void => {
        nodeRequire(specifier);
      };
      expect(reach, specifier).toThrow(DryRunRefused);
      expect(reach, specifier).toThrow(/dry_run_refused/);
    }
    // Still ordinary: a builtin that cannot reach the vault or the network.
    expect(typeof (nodeRequire("node:path") as { join: unknown }).join).toBe("function");
    void interception;
  });

  it("restores Module._load, and the workspace link answers on its own after that", async () => {
    const harness = await ShimHarness.withVault({});
    const interception = intercepting();
    const intercepted = nodeRequire("obsidian") as Record<string, unknown>;
    expect(interception.interceptedCount()).toBe(1);
    interception.restore();
    installed = null;

    // **Not `Cannot find module`.** `host/node_modules/obsidian` is a real
    // workspace link to `packages/obsidian`, so after the patch is gone Node
    // resolves the specifier on its own — which is the *first* of the two
    // mechanisms, doing its job with nothing patched. What proves the restore
    // is that the patch stopped counting and stopped answering.
    const resolved = nodeRequire("obsidian") as Record<string, unknown>;
    expect(interception.interceptedCount()).toBe(1);
    expect(typeof resolved["normalizePath"]).toBe("function");
    expect(resolved["TFile"]).toBe(harness.api.TFile);
    expect(intercepted["TFile"]).toBe(harness.api.TFile);
  });

  it("routes a bundle's bare setTimeout and setInterval through the host's clock", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("bare-timers");
    const loaded = loadPluginBundle({
      pluginId: "bare-timers",
      filename,
      source,
      hostModulePaths: harness.hostModulePaths,
    });
    expect(harness.activeTimerCount()).toBe(0);
    const plugin = harness.instantiate("bare-timers", loaded.pluginClass);
    await harness.load(plugin);
    // One, not two: the bare `clearTimeout` disarmed the bare `setTimeout` on
    // the same clock. Node's own timers would have left this at zero.
    expect(harness.activeTimerCount()).toBe(1);
    await harness.unload("bare-timers");
    expect(harness.activeTimerCount()).toBe(0);
  });

  it("provisions window.require for a QuickAdd-shaped user script, and puts the refusal back", async () => {
    const harness = await ShimHarness.withVault({});
    // Before provisioning, `window.require` is Task 11a's typed refusal.
    expect(() => harness.window.require("node:crypto")).toThrow(HeadlessUnsupported);

    const provisioned = provisionUserScriptGlobals(nodeRequire);
    try {
      const source = readFileSync(join(__dirname, "fixtures", "bundles", "user-script.md"), "utf8");
      // QuickAdd's own user-script loader, verbatim in shape: it supplies
      // `module` and `exports` itself and needs only `window.require` to be a
      // real function.
      const requireShim = (m: string): unknown =>
        (globalThis as unknown as { require?: (s: string) => unknown }).require?.(m);
      const exportsObj: Record<string, unknown> = {};
      const moduleObj = { exports: exportsObj as unknown };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
      new Function("require", "module", "exports", source)(requireShim, moduleObj, exportsObj);
      const entry = (exportsObj["default"] ?? moduleObj.exports) as (params: unknown) => string;
      expect(entry({})).toMatch(/^[0-9a-f]{8}$/);
      expect(harness.window.require("node:path")).toBe(nodeRequire("node:path"));
    } finally {
      provisioned.restore();
    }
    expect(() => harness.window.require("node:crypto")).toThrow(HeadlessUnsupported);
    expect((globalThis as unknown as { require?: unknown }).require).toBeUndefined();
  });
});

describe("the loader's plugin lifecycle", () => {
  it("registers a bundle's instance with app.plugins and deregisters it on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const loader = new BundleLoader(harness.loaderDeps());
    const { filename, source } = bundle("cjs-plugin");
    const manifest = harness.manifestFor("cjs");
    harness.setConfigFile(`${manifest.dir}/data.json`, "{}");
    const plugin = await loader.loadBundle({
      request: { pluginId: "cjs", filename, source, hostModulePaths: harness.hostModulePaths },
      manifest,
    });
    expect(harness.app.plugins.getPlugin("cjs")).toBe(plugin);
    expect(harness.app.plugins.isEnabled("cjs")).toBe(true);
    await loader.disable("cjs");
    expect(harness.app.plugins.getPlugin("cjs")).toBeNull();
    expect(harness.app.plugins.isEnabled("cjs")).toBe(false);
  });

  it("backs app.plugins.enablePlugin and disablePlugin once installed", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("cjs-plugin");
    const manifest = harness.manifestFor("cjs");
    harness.setConfigFile(`${manifest.dir}/data.json`, "{}");
    const loader = new BundleLoader({
      ...harness.loaderDeps(),
      provide: (id) =>
        id === "cjs"
          ? { request: { pluginId: id, filename, source, hostModulePaths: harness.hostModulePaths }, manifest }
          : null,
    });
    harness.app.plugins.setLoader(loader);
    await harness.app.plugins.enablePlugin("cjs");
    expect(harness.app.plugins.isEnabled("cjs")).toBe(true);
    expect(harness.harvest.commands().map((c) => c.id)).toEqual(["cjs:probe"]);
    await harness.app.plugins.disablePlugin("cjs");
    expect(harness.app.plugins.isEnabled("cjs")).toBe(false);
    expect(harness.harvest.commands()).toEqual([]);
    // An id the provider does not know is not a throw: `enablePlugin` is
    // reachable from inside another plugin's `onload`.
    await expect(harness.app.plugins.enablePlugin("nobody")).resolves.toBeUndefined();
  });
});

/** The eight golden bundles, and the settings each one was captured with. */
const GOLDENS = [
  "automatic-linker",
  "find-replace",
  "folder-notes",
  "nested-properties",
  "obsidian-linter",
  "obsidian-rollover-daily-todos",
  "quickadd",
  "tag-wrangler",
];

/** The methods the sweep answers as successes rather than as `not_found`. */
const WRITE_METHODS = new Set(["write_file", "write_note", "create_folder", "delete_path", "rename_path"]);

interface Scenario {
  readonly settings: Record<string, unknown>;
}

/** The captured settings, with obsidian-linter's 918 KB table switched off. */
function settingsFor(id: string): Record<string, unknown> {
  const scenario = JSON.parse(readFileSync(join(GOLDEN, id, "scenario.json"), "utf8")) as Scenario;
  const settings = scenario.settings;
  const ruleConfigs = settings["ruleConfigs"] as Record<string, { enabled?: boolean }> | undefined;
  const autoCorrect = ruleConfigs?.["auto-correct-common-misspellings"];
  if (autoCorrect !== undefined) autoCorrect.enabled = false;
  return settings;
}

/**
 * Load one golden through the loader, and hand back whatever happened.
 *
 * The load is allowed to fail. What this task claims about the eight is that
 * every one of them **evaluates and enters `onload`** — the door works — not
 * that every one of them runs to completion against a one-note fixture vault
 * with no editor. A failure after the door is the shim's business, and it is
 * asserted by name below so a new one cannot appear unnoticed.
 */
async function loadGolden(id: string): Promise<GoldenRun> {
  const harness = await ShimHarness.withVault({});
  // Installed last, so every hook the harness already has wins.
  harness.serve((request) => {
    const method = request.request.method;
    // A plugin that writes during `onload` is ordinary — folder-notes persists
    // a migrated `data.json` before it does anything else — so a write is
    // answered as a write. Everything left is a read for a path this one-note
    // fixture vault does not have, and `not_found` is what the daemon says
    // about that. A request nothing answers would sit in the queue and the load
    // would never return, which is the shape this hook exists to prevent.
    if (WRITE_METHODS.has(method)) {
      harness.respondOk(request.id, method, {
        generation: harness.mirror.generation(),
        revision: "blake3:golden-sweep",
      });
      return true;
    }
    harness.respondErr(request.id, {
      code: "not_found",
      message: `${String((request.request.params as { path?: string }).path)} is not in this fixture vault`,
    });
    return true;
  });
  const manifest = JSON.parse(
    readFileSync(join(GOLDEN, id, "plugin", "manifest.json"), "utf8"),
  ) as PluginManifest;
  const mutable = manifest as { dir: string };
  mutable.dir = `${harness.config.configDirName}/plugins/${manifest.id}`;
  harness.setConfigFile(`${manifest.dir}/data.json`, JSON.stringify(settingsFor(id)));
  const filename = join(GOLDEN, id, "plugin", "main.js");
  const loader = new BundleLoader(harness.loaderDeps());
  // Installed, because `nested-properties` reaches `@codemirror/state` and
  // `@codemirror/view` at module scope and no such package exists to resolve.
  intercepting({ harvest: harness.harvest });
  let error: unknown = null;
  try {
    await loader.loadBundle({
      request: {
        pluginId: manifest.id,
        filename,
        source: readFileSync(filename, "utf8"),
        hostModulePaths: harness.hostModulePaths,
      },
      manifest,
    });
  } catch (caught: unknown) {
    error = caught;
  }
  return { harness, loader, id: manifest.id, error };
}

interface GoldenRun {
  readonly harness: ShimHarness;
  readonly loader: BundleLoader;
  /** The manifest's id, which is not always the fixture directory's name. */
  readonly id: string;
  readonly error: unknown;
}

/**
 * The one golden whose `onload` does not survive this shim, and exactly why.
 *
 * `nested-properties` bundles a `Component` base of its own that reaches into
 * Obsidian's **private** `_children` field — `[...this._children]`, inside its
 * own `load()`. This host's `Component` keeps its children in a field of its
 * own, so the spread is a spread of `undefined`. That is a shim-parity question
 * about undocumented internals rather than a loader one: before this task the
 * bundle could not be evaluated at all — it dies at a module-scope `tty`
 * require and two `@codemirror` packages — and it now evaluates, constructs,
 * and enters `onload`.
 */
const KNOWN_ONLOAD_FAILURE = new Map([["nested-properties", /is not iterable/]]);

describe("every golden bundle, through the loader", () => {
  for (const id of GOLDENS) {
    it(`loads ${id} and enters onload`, async () => {
      const run = await loadGolden(id);
      const plugin = run.loader.instance(run.id);
      if (plugin === null) throw new Error(`${id} produced no plugin instance`);
      // Registered **before** `onload`, which is what Obsidian does and what a
      // plugin that looks itself up during startup depends on.
      expect(run.harness.app.plugins.getPlugin(run.id)).toBe(plugin);
      expect(run.harness.app.plugins.isEnabled(run.id)).toBe(true);
      // `isLoaded` goes true before `onload` runs, so this says exactly what
      // this task claims: the bundle evaluated, the class constructed, and the
      // plugin's own `onload` was entered.
      expect(plugin.isLoaded).toBe(true);
      const expected = KNOWN_ONLOAD_FAILURE.get(id);
      if (expected === undefined) {
        expect(run.error).toBeNull();
        expect(run.harness.hostErrors.map((entry) => String(entry.error))).toEqual([]);
      } else {
        expect(String(run.error)).toMatch(expected);
      }
    }, 120_000);
  }

  it("records tag-wrangler's delegated DOM listeners as unreachable", async () => {
    const run = await loadGolden("tag-wrangler");
    const delegated = run.harness.harvest
      .unreachable()
      .filter((row) => row.kind === "dom_delegated_menu");
    // **Seventeen registrations from ten call sites**, and the difference is
    // the bundle's own structure rather than a miscount on either side. Five
    // `Node.on` call sites sit in the plugin's own `onload`; the other five sit
    // in a helper component the plugin instantiates **three times** — once for
    // the tag pane, once for preview, once for the editor — so those five run
    // three times each. A registration is what this host cannot deliver to, so
    // a registration is what it records. The Task 0 capture's "ten, two of them
    // contextmenu" counts call sites, which nothing at runtime can see.
    expect(delegated.length).toBe(17);
    expect(delegated.filter((row) => row.detail === "contextmenu").length).toBe(3);
    expect(delegated.every((row) => row.pluginId === "tag-wrangler")).toBe(true);
    // The capture's other half, unchanged: one menu hook harvested and zero
    // commands. That pair is the plugin's whole reachable surface.
    expect(run.harness.harvest.menuHooks().length).toBe(1);
    expect(run.harness.harvest.commands()).toEqual([]);
  }, 120_000);

  it("forgets every delegated row when the loader unloads the plugin", async () => {
    const run = await loadGolden("tag-wrangler");
    await run.loader.unload("tag-wrangler");
    expect(run.harness.harvest.unreachable()).toEqual([]);
    expect(run.harness.app.plugins.getPlugin("tag-wrangler")).toBeNull();
    expect(run.harness.app.plugins.isEnabled("tag-wrangler")).toBe(false);
  }, 120_000);
});
