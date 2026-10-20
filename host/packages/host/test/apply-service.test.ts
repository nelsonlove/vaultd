/**
 * The screen host's apply service and its cache (task 6 of
 * `docs/design/web-plugins.md`).
 *
 * The stock Style Settings bundle, unchanged, runs over happy-dom in a
 * {@link ShimHarness}; the stylesheet set is built from the fixture vault by
 * the same `buildSheetSet` the web server uses, and each viewer's values come
 * from the `viewer` data store over the fixture's `data.json`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_JSON, EXPECTED, FIXTURE, MAIN_JS, MAIN_JS_PATH, pluginOwnedClasses } from "./style-settings-run";
import { scratchRoot } from "./scratch";
import { ApplyService, createApplyService } from "../src/screen/apply-service";
import { BundleLoader } from "../src/runtime/loader";
import { pluginHostFor } from "../src/shim/plugin";
import { rejectionGuardArmed, reportUnhandledRejection } from "../src/server/server";
import { ShimHarness } from "../src/testing/shim-harness";
import { buildSheetSet } from "../src/web/sheet-set";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import type { ApplyRequest } from "../src/screen/apply-service";
import type { Mode } from "./style-settings-run";
import type { PluginManifest } from "../src/shim/plugin";
import type { PluginDataStore } from "../src/shim/plugin-data-store";
import type { Sheet } from "../src/web/sheet-set";

const PLUGIN_ID = "obsidian-style-settings";
const VAULT_DIR = join(FIXTURE, "vault");
const MANIFEST = JSON.parse(
  readFileSync(join(VAULT_DIR, ".obsidian", "plugins", PLUGIN_ID, "manifest.json"), "utf8"),
) as PluginManifest;

/** The fixture vault, read from disk as the web server would read it through vaultd. */
function readFixture(path: string): Promise<string | null> {
  try {
    return Promise.resolve(readFileSync(join(VAULT_DIR, path), "utf8"));
  } catch {
    return Promise.resolve(null);
  }
}

interface Rig {
  readonly harness: ShimHarness;
  readonly service: ApplyService;
  readonly loader: BundleLoader;
  readonly stateRoot: string;
  readonly sheets: Sheet[];
  /** What the service logged, one line per host error. */
  readonly logged: string[];
}

const live: Rig[] = [];
const harnesses: ShimHarness[] = [];

afterEach(async () => {
  for (const rig of live.splice(0).reverse()) await rig.service.close().catch(() => undefined);
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.teardown();
    await harness.stop();
  }
});

interface RigOptions {
  cacheLimit?: number;
  applyDeadlineMs?: number;
  wrapStore?: (store: PluginDataStore, viewer: string) => PluginDataStore;
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const harness = await ShimHarness.withVault({}, { dom: happyDomProvider() });
  harnesses.push(harness);
  const logged: string[] = [];
  // The vault's own `data.json`, which the `viewer` store reads (never writes).
  harness.setConfigFile(`.obsidian/plugins/${PLUGIN_ID}/data.json`, DATA_JSON);
  const loader = new BundleLoader(harness.loaderDeps());
  const stateRoot = scratchRoot("vaultd-screen-state-");
  const dom = harness.serverDom;
  if (dom === null) throw new Error("the rig needs a server DOM");
  const service = createApplyService({
    app: harness.app,
    loader,
    queue: harness.loaderDeps().queue,
    document: dom.document as never,
    clock: harness.clock,
    bundle: {
      manifest: { ...MANIFEST, dir: `.obsidian/plugins/${PLUGIN_ID}` },
      request: { pluginId: PLUGIN_ID, filename: MAIN_JS_PATH, source: MAIN_JS, hostModulePaths: harness.hostModulePaths },
    },
    stateRoot,
    log: (line) => {
      logged.push(line);
    },
    ...(options.cacheLimit === undefined ? {} : { cacheLimit: options.cacheLimit }),
    ...(options.applyDeadlineMs === undefined ? {} : { applyDeadlineMs: options.applyDeadlineMs }),
    ...(options.wrapStore === undefined ? {} : { wrapStore: options.wrapStore }),
  });
  const { sheets } = await buildSheetSet(readFixture);
  const made = { harness, service, loader, stateRoot, sheets, logged };
  live.push(made);
  return made;
}

function request(r: Rig, viewer: string, mode: Mode, sheets: Sheet[] = r.sheets): ApplyRequest {
  return { viewer, mode, sheets };
}

/** The classes the capture shows that the plugin owns, sorted, without the mode class. */
function capturedClasses(mode: Mode): string[] {
  const owned = pluginOwnedClasses();
  return EXPECTED.classes[mode].filter((name) => owned.has(name)).sort();
}

/** Give `viewer` a saved value of its own, as the `viewer` store keeps it. */
function patchFor(r: Rig, viewer: string, patch: Record<string, unknown>): void {
  mkdirSync(join(r.stateRoot, viewer), { recursive: true, mode: 0o700 });
  writeFileSync(join(r.stateRoot, viewer, `${PLUGIN_ID}.json`), JSON.stringify(patch));
}

describe("the fixture's sheet set", () => {
  it("is the plugin's own styles.css, the theme and the snippet, in Obsidian 1.14.4's head order", async () => {
    const set = await buildSheetSet(readFixture);
    expect(set.sheets.map((sheet) => sheet.id)).toEqual([
      `plugin:${PLUGIN_ID}`,
      "theme:Fixture Theme",
      "snippet:fixture-snippet",
    ]);
    expect(set.mode).toBe("dark");
  });
});

describe("apply through the service", () => {
  it.each<Mode>(["light", "dark"])("reproduces the capture in %s mode", async (mode) => {
    const r = await rig();
    const result = await r.service.apply(request(r, "alice", mode));
    expect(result.style).toBe(EXPECTED.styleText[mode]);
    expect(result.classes).toEqual(capturedClasses(mode));
    expect(r.harness.hostErrors).toEqual([]);
  });

  it("reproduces both modes in one service, light then dark", async () => {
    const r = await rig();
    const light = await r.service.apply(request(r, "alice", "light"));
    const dark = await r.service.apply(request(r, "alice", "dark"));
    expect(light.style).toBe(EXPECTED.styleText.light);
    expect(dark.style).toBe(EXPECTED.styleText.dark);
    expect(dark.classes).toEqual(capturedClasses("dark"));
    // A mode switch for the same viewer does not reload the plugin.
    expect(r.service.stats().loads).toBe(1);
  });

  it("answers a second identical request from the cache, without running onload again", async () => {
    const r = await rig();
    const loads = vi.spyOn(r.loader, "loadBundle");
    const first = await r.service.apply(request(r, "alice", "dark"));
    const second = await r.service.apply(request(r, "alice", "dark"));
    expect(second).toEqual(first);
    expect(loads).toHaveBeenCalledTimes(1);
    expect(r.service.stats()).toMatchObject({ loads: 1, unloads: 0, hits: 1, misses: 1 });
  });

  it("serialises concurrent requests and still loads once", async () => {
    const r = await rig();
    const loads = vi.spyOn(r.loader, "loadBundle");
    const [a, b, c] = await Promise.all([
      r.service.apply(request(r, "alice", "dark")),
      r.service.apply(request(r, "alice", "dark")),
      r.service.apply(request(r, "alice", "light")),
    ]);
    expect(a.style).toBe(EXPECTED.styleText.dark);
    expect(b).toEqual(a);
    expect(c.style).toBe(EXPECTED.styleText.light);
    expect(loads).toHaveBeenCalledTimes(1);
  });

  it("gives two viewers with different saved values different outputs, back and forth", async () => {
    // A cache of one entry, so every switch is a miss and a reload.
    const r = await rig({ cacheLimit: 1 });
    patchFor(r, "bob", { "fixture-snippet@@sn-width": 900 });
    const outputs: string[] = [];
    for (const viewer of ["alice", "bob", "alice", "bob"]) {
      outputs.push((await r.service.apply(request(r, viewer, "dark"))).style);
    }
    expect(outputs[0]).toBe(EXPECTED.styleText.dark);
    expect(outputs[0]).toContain("--sn-width: 700px;");
    expect(outputs[1]).toContain("--sn-width: 900px;");
    expect(outputs[1]).toBe(EXPECTED.styleText.dark.replace("--sn-width: 700px;", "--sn-width: 900px;"));
    expect(outputs[2]).toBe(outputs[0]);
    expect(outputs[3]).toBe(outputs[1]);
    expect(r.service.stats()).toMatchObject({ loads: 4, unloads: 3, hits: 0, misses: 4 });
    expect(r.harness.hostErrors).toEqual([]);
  });

  it("serves both viewers from the cache once each has been applied", async () => {
    const r = await rig();
    patchFor(r, "bob", { "fixture-snippet@@sn-width": 900 });
    const alice = await r.service.apply(request(r, "alice", "dark"));
    const bob = await r.service.apply(request(r, "bob", "dark"));
    expect(await r.service.apply(request(r, "alice", "dark"))).toEqual(alice);
    expect(await r.service.apply(request(r, "bob", "dark"))).toEqual(bob);
    expect(r.service.stats()).toMatchObject({ loads: 2, hits: 2, misses: 2 });
  });

  it("gives the new output for a changed sheet text, without a reload", async () => {
    const r = await rig();
    const before = await r.service.apply(request(r, "alice", "dark"));
    const changed = r.sheets.map((sheet) =>
      sheet.id === "snippet:fixture-snippet" ? { ...sheet, text: sheet.text.replace("format: px", "format: em") } : sheet,
    );
    const after = await r.service.apply(request(r, "alice", "dark", changed));
    expect(before.style).toContain("--sn-width: 700px;");
    expect(after.style).toBe(before.style.replace("--sn-width: 700px;", "--sn-width: 700em;"));
    expect(after.classes).toEqual(before.classes);
    // A sheet that drops a class toggle's section drops its class as well.
    const noTheme = r.sheets.filter((sheet) => !sheet.id.startsWith("theme:"));
    const bare = await r.service.apply(request(r, "alice", "dark", noTheme));
    expect(bare.classes).toEqual(["css-settings-manager"]);
    expect(r.service.stats().loads).toBe(1);
  });

  it("keeps at most cacheLimit entries, oldest out first", async () => {
    const r = await rig({ cacheLimit: 2 });
    await r.service.apply(request(r, "alice", "dark"));
    await r.service.apply(request(r, "alice", "light"));
    expect(r.service.stats().size).toBe(2);
    const third = r.sheets.slice(1);
    await r.service.apply(request(r, "alice", "dark", third));
    expect(r.service.stats().size).toBe(2);
    // `light` was used after `dark` and before the third, so `dark` went.
    await r.service.apply(request(r, "alice", "light"));
    expect(r.service.stats().hits).toBe(1);
    await r.service.apply(request(r, "alice", "dark"));
    expect(r.service.stats()).toMatchObject({ hits: 1, misses: 4, size: 2 });
  });

  it("refuses a request of the wrong shape before it touches the plugin", async () => {
    const r = await rig();
    await expect(r.service.apply({ viewer: "", mode: "dark", sheets: [] })).rejects.toThrow(/viewer/);
    await expect(r.service.apply({ viewer: "a", mode: "sepia" as Mode, sheets: [] })).rejects.toThrow(/mode/);
    await expect(r.service.apply({ viewer: "a", mode: "dark", sheets: [{ id: 1 }] as never })).rejects.toThrow(/sheets/);
    expect(r.service.stats().loads).toBe(0);
  });

  it("survives a store whose save rejects: the apply fails, nothing is cached, and the next one succeeds", async () => {
    // The plugin's load-time prune calls `save()` without awaiting it, so a
    // rejected save is an unhandled rejection. The runner's own listeners are
    // taken off for this case, so the screen host's guard is the only one: if
    // it were missing, Node would end this worker.
    let failing = true;
    const r = await rig({
      wrapStore: (store) => ({
        kind: store.kind,
        load: (id) => store.load(id),
        save: (id, data) => (failing ? Promise.reject(new Error("disk full")) : store.save(id, data)),
      }),
    });
    const runnerListeners = process
      .listeners("unhandledRejection")
      .filter((listener) => listener !== reportUnhandledRejection);
    for (const listener of runnerListeners) process.off("unhandledRejection", listener);
    expect(rejectionGuardArmed()).toBe(true);
    try {
      await expect(r.service.apply(request(r, "alice", "dark"))).rejects.toThrow(/disk full/);
      expect(r.service.stats().size).toBe(0);
    } finally {
      for (const listener of runnerListeners) process.on("unhandledRejection", listener);
    }
    failing = false;
    const recovered = await r.service.apply(request(r, "alice", "dark"));
    expect(recovered.style).toBe(EXPECTED.styleText.dark);
    expect(recovered.classes).toEqual(capturedClasses("dark"));
    expect(r.service.stats()).toMatchObject({ loads: 2, misses: 2 });
  });

  it("fails an apply past its deadline, and serves the next one", async () => {
    const stuck: Array<() => void> = [];
    let hang = true;
    const r = await rig({
      applyDeadlineMs: 1_000,
      wrapStore: (store) => ({
        kind: store.kind,
        load: (id) =>
          hang
            ? new Promise((resolve) => {
                stuck.push(() => {
                  resolve(store.load(id));
                });
              })
            : store.load(id),
        save: (id, data) => store.save(id, data),
      }),
    });
    await expect(r.service.apply(request(r, "alice", "dark"))).rejects.toThrow(/deadline/);
    hang = false;
    const served = await r.service.apply(request(r, "alice", "dark"));
    expect(served.style).toBe(EXPECTED.styleText.dark);
    // The stuck read finishes late; the abandoned apply must not touch the page.
    for (const release of stuck) release();
    for (let i = 0; i < 20; i += 1) await new Promise<void>((done) => setImmediate(done));
    expect(await r.service.apply(request(r, "alice", "dark"))).toEqual(served);
    expect(await r.service.apply(request(r, "alice", "light"))).toMatchObject({ style: EXPECTED.styleText.light });
  });

  it("holds the process-level rejection guard until close", async () => {
    const r = await rig();
    expect(rejectionGuardArmed()).toBe(true);
    await r.service.close();
    expect(rejectionGuardArmed()).toBe(false);
  });

  it("refuses an apply after close", async () => {
    const r = await rig();
    await r.service.apply(request(r, "alice", "dark"));
    await r.service.close();
    await expect(r.service.apply(request(r, "alice", "light"))).rejects.toThrow(/closed/);
    expect(r.service.stats()).toMatchObject({ loads: 1, unloads: 1 });
  });

  it("logs a host error or a stray rejection that happens outside any apply", async () => {
    const r = await rig();
    await r.service.apply(request(r, "alice", "dark"));
    pluginHostFor(r.harness.app).errors.report(new Error("late handler failed"), PLUGIN_ID, "event");
    const runnerListeners = process
      .listeners("unhandledRejection")
      .filter((listener) => listener !== reportUnhandledRejection);
    for (const listener of runnerListeners) process.off("unhandledRejection", listener);
    try {
      void Promise.reject(new Error("stray promise"));
      for (let i = 0; i < 5; i += 1) await new Promise<void>((done) => setImmediate(done));
    } finally {
      for (const listener of runnerListeners) process.on("unhandledRejection", listener);
    }
    expect(r.logged.some((line) => line.includes(PLUGIN_ID) && line.includes("late handler failed"))).toBe(true);
    expect(r.logged.some((line) => line.includes("stray promise"))).toBe(true);
    // The apply itself was not touched.
    expect(r.service.stats()).toMatchObject({ misses: 1, size: 2 });
  });

  it("releases the guard when the service cannot be built", async () => {
    await expect(rig({ cacheLimit: 0 })).rejects.toThrow(RangeError);
    expect(rejectionGuardArmed()).toBe(false);
  });

  it("releases the guard and stops logging even when the unload in close throws", async () => {
    const r = await rig();
    await r.service.apply(request(r, "alice", "dark"));
    vi.spyOn(r.loader, "unload").mockRejectedValue(new Error("unload broke"));
    await expect(r.service.close()).rejects.toThrow(/unload broke/);
    expect(rejectionGuardArmed()).toBe(false);
    pluginHostFor(r.harness.app).errors.report(new Error("after close"), PLUGIN_ID, "event");
    expect(r.logged.some((line) => line.includes("after close"))).toBe(false);
  });
});
