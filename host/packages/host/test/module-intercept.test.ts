import Module, { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BundleLoader,
  PluginBundleFailed,
  PluginLoadFailed,
  loadPluginBundle,
  provisionUserScriptGlobals,
} from "../src/runtime/loader";
import { installModuleInterception } from "../src/runtime/intercept";
import { HeadlessUnsupported, DryRunRefused, resetPolicyTable } from "../src/shim/policy";
import { ShimHarness } from "../src/testing/shim-harness";
import type { ElectronStub } from "../src/runtime/electron-registry";
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

  it("records the same @codemirror rows for a second host in the same process", async () => {
    // The dedup exists to collapse one bundle's three call sites into one
    // dependency — a question about **one** host. Held process-wide it becomes
    // a memo of rows already reported, and the second host's compatibility
    // report comes out silently short with nothing to say about why.
    const rowsForOneHost = async (): Promise<string[]> => {
      const harness = await ShimHarness.withVault({});
      const plugin = harness.instantiate(
        "cm-two-hosts",
        class extends harness.api.Plugin {
          override onload(): void {
            nodeRequire("@codemirror/state");
          }
        },
      );
      const interception = intercepting({ harvest: harness.harvest });
      await harness.load(plugin);
      interception.restore();
      installed = null;
      return harness.harvest
        .unreachable()
        .filter((row) => row.kind === "editor_extension")
        .map((row) => row.detail);
    };
    expect(await rowsForOneHost()).toEqual(["@codemirror/state"]);
    expect(await rowsForOneHost(), "the second host records its own rows").toEqual([
      "@codemirror/state",
    ]);
  });

  it("hands every mechanism the live module, not the host assembled when it loaded", async () => {
    const first = await ShimHarness.withVault({});
    // Mechanism 1, no patch installed: Node's own resolution through the
    // workspace link.
    const mod = nodeRequire("obsidian") as Record<string, unknown>;
    // `Notice` and `debounce` are bound per host; `TFile` is module-level and
    // identical across hosts, so it cannot tell liveness from a snapshot.
    expect(mod["Notice"]).toBe(first.api.Notice);
    expect(mod["debounce"]).toBe(first.api.debounce);

    const second = await ShimHarness.withVault({});
    expect(mod["Notice"], "the module object follows the current host").toBe(second.api.Notice);
    expect(mod["debounce"]).toBe(second.api.debounce);
    expect(mod["Notice"]).not.toBe(first.api.Notice);

    // Mechanism 2 hands back the **same object**, not a snapshot of the barrel:
    // a bundle that re-requires through the patch must not end up holding an
    // older host's surfaces than one that re-requires through the link.
    intercepting();
    expect(nodeRequire("obsidian")).toBe(mod);
    expect(nodeRequire("electron")).toBe(nodeRequire("electron"));
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

  it("restores in any order, leaving Module._load byte-identical", async () => {
    const slot = Module as unknown as { _load: unknown };
    const nodesOwn = slot._load;
    const harness = await ShimHarness.withVault({});

    const outer = installModuleInterception({ hostModulePaths: [], allowNodeBuiltins: true });
    const inner = installModuleInterception({ hostModulePaths: [], allowNodeBuiltins: true });

    // The **outer** one goes first, which is the order the naive
    // "put back what I found" implementation gets wrong in one direction and
    // the naive "only if it is still mine" fix gets wrong in the other: the
    // first clobbers the inner patch, the second strands it for the life of the
    // process with no handle able to undo it.
    outer.restore();
    expect(slot._load, "the inner layer still owns the slot").not.toBe(nodesOwn);
    // And still works: the outer layer went inert and re-linked, it did not
    // take the inner one's delegate away.
    expect(typeof (nodeRequire("obsidian") as { normalizePath: unknown }).normalizePath).toBe("function");
    expect(inner.interceptedCount()).toBe(1);
    expect(outer.interceptedCount()).toBe(0);

    inner.restore();
    expect(slot._load, "Module._load is Node's own function again").toBe(nodesOwn);
    // Idempotent, in any order, however many times.
    outer.restore();
    inner.restore();
    expect(slot._load).toBe(nodesOwn);
    void harness;
  });

  it("shares one layer chain between the src and dist copies of itself", async () => {
    // **Two copies of `intercept.ts` exist in a test process** — Vitest's
    // transform of `src/`, and Node's `dist/` if a package pulls it in — and
    // two module-level chains over one `Module._load` would re-open the
    // stranded-patch bug the chain exists to close. The chain therefore lives
    // in the same process cell the module registries do, and this loads the
    // module under both paths to prove it.
    const slot = Module as unknown as { _load: unknown };
    const nodesOwn = slot._load;
    const harness = await ShimHarness.withVault({});
    const dist = nodeRequire(
      join(HOST_ROOT, "packages", "host", "dist", "runtime", "intercept.js"),
    ) as { installModuleInterception: typeof installModuleInterception };
    expect(dist.installModuleInterception, "the dist copy is a different function object").not.toBe(
      installModuleInterception,
    );

    const fromSrc = installModuleInterception({ hostModulePaths: [], allowNodeBuiltins: true });
    const fromDist = dist.installModuleInterception({ hostModulePaths: [], allowNodeBuiltins: true });
    // Out of order, across the two copies: the bottom layer belongs to one
    // module instance and the top to the other.
    fromSrc.restore();
    expect(slot._load).not.toBe(nodesOwn);
    expect(typeof (nodeRequire("obsidian") as { normalizePath: unknown }).normalizePath).toBe("function");
    fromDist.restore();
    expect(slot._load, "one chain, so unwinding it reaches Node's own _load").toBe(nodesOwn);
    void harness;
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

  it("resolves obsidian for a bundle outside the host tree, through module.paths alone", async () => {
    // **Every other fixture and golden in this suite sits inside `host/`**, so
    // Node's ordinary walk up the directory tree finds `host/node_modules`
    // whether or not `hostModulePaths` was prepended — which would leave
    // mechanism 1, the design's main road, untested by a case named after it.
    // This one writes the bundle somewhere Node's walk cannot reach the host
    // from, and proves both directions.
    const harness = await ShimHarness.withVault({});
    const scratch = join(HOST_ROOT, "..", "target", "tmp");
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, "outside-bundle-"));
    try {
      const filename = join(dir, "main.js");
      const source = readFileSync(bundle("cjs-plugin").filename, "utf8");
      writeFileSync(filename, source, "utf8");

      // No interception: nothing is patched, and `globalPaths` carries no host
      // entry. Without the host's `node_modules` on `module.paths` there is
      // simply no `obsidian` to find from here.
      const withoutPaths = (): unknown =>
        loadPluginBundle({ pluginId: "outside", filename, source, hostModulePaths: [] });
      expect(withoutPaths).toThrow(PluginBundleFailed);
      expect(withoutPaths).toThrow(/Cannot find module 'obsidian'/);

      const loaded = loadPluginBundle({
        pluginId: "outside",
        filename,
        source,
        hostModulePaths: harness.hostModulePaths,
      });
      const instance = new loaded.pluginClass(harness.app, harness.manifestFor("outside"));
      await instance.onload();
      expect((instance as unknown as { loadedWith: string }).loadedWith).toBe("Folder/Note.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never gives a harness the real OS opener", async () => {
    // `assembleShim`'s default `spawn` really launches the platform's `open`.
    // No test needs a window on somebody's screen, and a future fixture that
    // reached for one would do it silently — so a harness always passes a
    // recording fake, and this is the guard that says so. If it were the real
    // one, `spawns()` would be empty and a Finder window would have appeared.
    const harness = await ShimHarness.withVault({});
    const path = join(HOST_ROOT, "..", "target", "tmp", "spawn-guard.md");
    const electron = nodeRequire("electron") as ElectronStub;
    await expect(electron.shell.openPath(path)).resolves.toBe("");
    await electron.shell.showItemInFolder(path);
    expect(harness.spawns()).toEqual([
      ["open", [path]],
      ["open", ["-R", path]],
    ]);
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

describe("delegated DOM listeners", () => {
  it("withdraws exactly the row a matching Node.off names", async () => {
    const harness = await ShimHarness.withVault({});
    const handler = (): void => undefined;
    const other = (): void => undefined;
    const plugin = harness.instantiate(
      "off-probe",
      class extends harness.api.Plugin {
        override onload(): void {
          harness.document.body.on("contextmenu", ".tag", handler);
          harness.document.body.on("click", ".tag", handler);
          harness.document.on("dragstart", ".tag", handler);
          // Withdrawn: this row must not survive.
          harness.document.body.off("contextmenu", ".tag", handler);
          // Three near-misses, none of which may withdraw anything: wrong
          // selector, wrong handler, wrong type.
          harness.document.body.off("click", ".other", handler);
          harness.document.body.off("click", ".tag", other);
          harness.document.body.off("mouseover", ".tag", handler);
        }
      },
    );
    await harness.load(plugin);
    const rows = harness.harvest.unreachable().filter((row) => row.kind === "dom_delegated_menu");
    expect(rows.map((row) => row.detail)).toEqual(["click", "dragstart"]);
    expect(rows.every((row) => row.pluginId === "off-probe")).toBe(true);
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

  it("rolls a plugin all the way back when its onload throws", async () => {
    const harness = await ShimHarness.withVault({});
    const loader = new BundleLoader(harness.loaderDeps());
    const { filename, source } = bundle("throwing-onload");
    const manifest = harness.manifestFor("throwing");
    harness.setConfigFile(`${manifest.dir}/data.json`, "{}");

    const loading = loader.loadBundle({
      request: { pluginId: "throwing", filename, source, hostModulePaths: harness.hostModulePaths },
      manifest,
    });
    await expect(loading).rejects.toBeInstanceOf(PluginLoadFailed);
    await expect(loading).rejects.toThrow(/plugin throwing threw during onload/);

    // Registered before `onload` — correct, and Obsidian's order — but a
    // plugin whose `onload` threw is not running, so none of this may survive.
    expect(harness.app.plugins.getPlugin("throwing")).toBeNull();
    expect(harness.app.plugins.isEnabled("throwing")).toBe(false);
    expect(Object.keys(harness.app.plugins.manifests)).toEqual([]);
    // Its command was harvested before the throw. A report that still listed it
    // would be offering an entry point into a plugin that is not there.
    expect(harness.harvest.commands()).toEqual([]);
    // Three timers were armed before the throw: one handed to
    // `registerInterval`, which the component teardown disarms, and two bare
    // ones it cannot see. **Both halves go.** A timer left armed here would go
    // on firing into a plugin that is gone, on this host's own clock, with
    // nobody to attribute it to — see `shim/timers.ts`.
    expect(harness.activeTimerCount()).toBe(0);
    // And the loader no longer holds it: a plugin that never finished loading
    // is not one a caller asking "what is loaded under this id" may be handed.
    expect(loader.instance("throwing")).toBeNull();
    // Reported as well as rejected: "swallowed" and "reported" look identical
    // from outside, so the failure goes to both places.
    const reported = harness.hostErrors.filter(
      (entry) => entry.pluginId === "throwing" && entry.phase === "onload",
    );
    expect(reported.length).toBeGreaterThanOrEqual(1);
    expect(String(reported[0]?.error)).toMatch(/onload blew up/);
  });

  it("drops the recorded module exports when a plugin's constructor throws", async () => {
    const harness = await ShimHarness.withVault({});
    const loader = new BundleLoader(harness.loaderDeps());
    const { filename, source } = bundle("throwing-constructor");
    const manifest = harness.manifestFor("doomed");

    const loading = loader.loadBundle({
      request: { pluginId: "doomed", filename, source, hostModulePaths: harness.hostModulePaths },
      manifest,
    });
    await expect(loading).rejects.toThrow(/constructor blew up/);

    // The bundle's exports are recorded **before** the class is constructed,
    // because Task 17's schema ladder reads a loaded plugin's own
    // `SETTINGS_CATALOG` / `DEFAULT_SETTINGS` off exactly that object and
    // nothing else in the process holds it. Every other failure gives them back
    // through `unload` → `forgetPlugin`; a constructor that throws reaches
    // neither, so a whole module scope would be held for the life of the host
    // for a plugin that never existed.
    expect(harness.harvest.moduleExports("doomed")).toBeUndefined();
    // And nothing else survives either: registration happens inside `load()`,
    // which was never reached.
    expect(harness.app.plugins.getPlugin("doomed")).toBeNull();
    expect(loader.instance("doomed")).toBeNull();
  });

  it("names the plugin when a bundle will not evaluate at all", () => {
    const filename = join(__dirname, "fixtures", "bundles", "cjs-plugin", "main.js");
    const broken = (): unknown =>
      loadPluginBundle({
        pluginId: "broken",
        filename,
        source: "throw new Error('module scope blew up');",
        hostModulePaths: [],
      });
    expect(broken).toThrow(PluginBundleFailed);
    // The plugin's id is the one fact the caller needs and the one thing a
    // bundle's own throw can never carry.
    expect(broken).toThrow(/plugin broken could not be loaded: Error: module scope blew up/);

    const empty = (): unknown =>
      loadPluginBundle({ pluginId: "empty", filename, source: "module.exports = {};", hostModulePaths: [] });
    expect(empty).toThrow(/plugin empty could not be loaded: it exported no Plugin class/);
  });

  it("compiles a bundle inside its plugin's attribution window", async () => {
    // A bundle's module scope is where several of the corpus register the
    // interesting things — `nested-properties` reaches CodeMirror there. A
    // loader that opened the attribution window only around `onload` would
    // record all of it against nobody, and the row would vanish.
    const harness = await ShimHarness.withVault({});
    intercepting({ harvest: harness.harvest });
    const loader = new BundleLoader(harness.loaderDeps());
    const { filename, source } = bundle("module-scope-cm");
    const manifest = harness.manifestFor("module-scope");
    harness.setConfigFile(`${manifest.dir}/data.json`, "{}");
    await loader.loadBundle({
      request: { pluginId: "module-scope", filename, source, hostModulePaths: harness.hostModulePaths },
      manifest,
    });
    expect(harness.harvest.unreachable()).toEqual([
      { pluginId: "module-scope", kind: "editor_extension", detail: "@codemirror/state" },
    ]);
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
 * Goldens whose `onload` does not survive this shim, and exactly what each one
 * hits — matched against what reached the **error seam**, because that is where
 * the plugin's own error lands; the caller gets a `PluginLoadFailed` wrapper.
 *
 * `nested-properties` is the only one, and the reason has moved twice. It used
 * to die at `[...this._children]` in a `Component` base of its own that reaches
 * into Obsidian's *private* child list — `shim/plugin.ts` now provides
 * `_children` and `_loaded` as an uncaptured best-effort mimic and it gets far
 * past that. It then died on a bare property write to
 * `app.metadataTypeManager.registeredTypeWidgets`, which `shim/app.ts` now
 * provides for the same reason and in the same shallow way. What it hits now is
 * its own check, not a `TypeError`: it reads the **built-in `multitext`
 * widget** back out of that map and refuses to continue without one.
 *
 * That is where this stops. A property-type widget is a GUI rendering surface
 * with no runtime capture behind it in this repository, and inventing one would
 * be inventing behaviour rather than mirroring it — the line the design draws
 * for undocumented internals. The plugin evaluates, constructs, registers and
 * enters `onload`; it needs a surface this host does not have, and the
 * compatibility report is where that gets said.
 */
const KNOWN_ONLOAD_FAILURE = new Map<string, RegExp>([
  ["nested-properties", /Value is undefined/],
]);

describe("every golden bundle, through the loader", () => {
  for (const id of GOLDENS) {
    it(`loads ${id} and enters onload`, async () => {
      const run = await loadGolden(id);
      const expected = KNOWN_ONLOAD_FAILURE.get(id);
      if (expected === undefined) {
        const plugin = run.loader.instance(run.id);
        if (plugin === null) throw new Error(`${id} produced no plugin instance`);
        // `_loaded` goes true before `onload` runs, so it says exactly what this
        // task claims and nothing more: the bundle evaluated, the class
        // constructed, and the plugin's own `onload` was entered.
        expect(plugin._loaded).toBe(true);
        expect(run.error).toBeNull();
        expect(run.harness.hostErrors.map((entry) => String(entry.error))).toEqual([]);
        // Registered **before** `onload`, which is what Obsidian does and what
        // a plugin that looks itself up during startup depends on — and still
        // registered afterwards, because it is running.
        expect(run.harness.app.plugins.getPlugin(run.id)).toBe(plugin);
        expect(run.harness.app.plugins.isEnabled(run.id)).toBe(true);
        expect(plugin.isLoaded).toBe(true);
      } else {
        // `PluginLoadFailed` is thrown from the `onload` path and nowhere else,
        // after the plugin was constructed and registered — so its presence is
        // this branch's "evaluated, constructed, entered `onload`" assertion.
        expect(run.error).toBeInstanceOf(PluginLoadFailed);
        expect(run.harness.hostErrors.map((entry) => String(entry.error)).join("\n")).toMatch(expected);
        // And rolled back, completely: not registered, not enabled, no harvest
        // rows, no timers — registered or bare — and not held by the loader.
        expect(run.harness.app.plugins.getPlugin(run.id)).toBeNull();
        expect(run.harness.app.plugins.isEnabled(run.id)).toBe(false);
        expect(run.harness.harvest.unreachable()).toEqual([]);
        expect(run.harness.activeTimerCount()).toBe(0);
        expect(run.loader.instance(run.id)).toBeNull();
      }
    }, 120_000);
  }

  it("records tag-wrangler's delegated DOM listeners as unreachable", async () => {
    const run = await loadGolden("tag-wrangler");
    const delegated = run.harness.harvest
      .unreachable()
      .filter((row) => row.kind === "dom_delegated_menu");
    // **Seventeen registrations, three of them `contextmenu`.** Five come from
    // `Node.on` call sites in the plugin's own `onload`; the other twelve from a
    // helper component it instantiates four times — for the tag pane, preview,
    // the properties pill and the editor — whose registrations branch on the
    // options each instance is given. Every one of them is a registration this
    // host cannot deliver to, which is what the row means and what a
    // compatibility report is built from.
    //
    // The Task 0 capture record states a different figure. It is a capture
    // record, it stays as it is, and no theory about how it was counted belongs
    // here: what is asserted is what this host observes.
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
