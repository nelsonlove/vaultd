/**
 * Run the stock Style Settings bundle over a server DOM, the way task 4 of
 * `docs/design/web-plugins.md` compares DOMs against the live capture.
 *
 * One run is one fresh host, built with the given DOM provider:
 *
 * 1. The fixture's theme, then its snippet, go into `document.head` as
 *    `<style>` elements, in Obsidian's order (theme, then snippets).
 * 2. `body` carries `theme-light` or `theme-dark`.
 * 3. The fixture's `data.json` is served at the plugin's data path, so
 *    `loadData()` reads it through the `vault` data store.
 * 4. The **stock, unchanged** `main.js` is compiled and loaded by the real
 *    {@link BundleLoader}.
 * 5. The test clock is advanced past the plugin's 100 ms debounce (fake timers,
 *    never a real wait), `css-change` is raised, and the clock is advanced past
 *    the debounce again. **Two parses, on purpose:** the capture was taken with
 *    the plugin already applied (the capture script raises `css-change` after
 *    load and after a mode switch), and a `color-gradient` whose end colour is
 *    not saved reads that colour back through `getComputedStyle` — so its value
 *    depends on the previous apply's output. The second parse is the one the
 *    capture recorded.
 * 6. The load-time prune's `saveData` is answered and its bytes are kept.
 *
 * Nothing here touches `main.js`; the bundle is read from the fixture and
 * handed to the loader as it is.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import yaml from "js-yaml";

import { BundleLoader } from "../src/runtime/loader";
import { ShimHarness } from "../src/testing/shim-harness";
import type { DomProvider } from "../src/shim/dom-provider";
import type { PluginManifest } from "../src/shim/plugin";

const REPO = resolve(__dirname, "..", "..", "..", "..");
export const FIXTURE = join(REPO, "host", "fixtures", "style-settings");
const OBSIDIAN = join(FIXTURE, "vault", ".obsidian");
const PLUGIN_DIR = join(OBSIDIAN, "plugins", "obsidian-style-settings");

export const THEME_CSS = readFileSync(join(OBSIDIAN, "themes", "Fixture Theme", "theme.css"), "utf8");
export const SNIPPET_CSS = readFileSync(join(OBSIDIAN, "snippets", "fixture-snippet.css"), "utf8");
export const DATA_JSON = readFileSync(join(PLUGIN_DIR, "data.json"), "utf8");
export const MAIN_JS_PATH = join(PLUGIN_DIR, "main.js");
export const MAIN_JS = readFileSync(MAIN_JS_PATH, "utf8");
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")) as PluginManifest;

export type Mode = "light" | "dark";

/** The capture of the live Obsidian, as the capture script wrote it. */
export const EXPECTED = {
  classes: readJson<Record<Mode, string[]>>("classes.json"),
  styleText: readJson<Record<Mode, string>>("style-text.json"),
  pluginData: readJson<{ in_memory: Record<string, unknown>; on_disk: Record<string, unknown> }>("plugin-data.json"),
  domProbe: readJson<Record<string, { html?: string; error?: string }>>("dom-probe.json"),
  meta: readJson<{ obsidian_version: string; plugin_version: string }>("meta.json"),
};

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE, "expected", name), "utf8")) as T;
}

interface SettingDecl {
  id: string;
  type: string;
  options?: Array<string | { value: string }>;
}

/**
 * The `body` classes the plugin owns, derived from the fixture's `@settings`
 * blocks: `css-settings-manager`, every class-toggle id and every class-select
 * option. Everything else on the capture's `body` (`mod-macos`, `is-frameless`
 * and the rest) is the app's.
 */
export function pluginOwnedClasses(): Set<string> {
  const owned = new Set<string>(["css-settings-manager"]);
  for (const css of [THEME_CSS, SNIPPET_CSS]) {
    for (const block of css.matchAll(/\/\*\s*@settings([\s\S]*?)\*\//g)) {
      const section = yaml.load(block[1] ?? "") as { settings?: SettingDecl[] };
      for (const setting of section.settings ?? []) {
        if (setting.type === "class-toggle") owned.add(setting.id);
        if (setting.type === "class-select") {
          for (const option of setting.options ?? []) owned.add(typeof option === "string" ? option : option.value);
        }
      }
    }
  }
  return owned;
}

/** The members of the real document a run reads. */
interface RunElement {
  id: string;
  textContent: string | null;
  classList: Iterable<string> & { add(...c: string[]): void };
  appendChild<T>(child: T): T;
}
interface RunDocument {
  head: RunElement;
  body: RunElement;
  createElement(tag: string): RunElement;
  getElementById(id: string): RunElement | null;
}

export interface StyleSettingsRun {
  readonly harness: ShimHarness;
  /** `[...document.body.classList].sort()` after the apply. */
  readonly classes: string[];
  /** The text of `#css-settings-manager` after the apply, or `null` if absent. */
  readonly styleText: string | null;
  /** `plugin.settingsManager.settings` after the apply. */
  readonly inMemory: Record<string, unknown> | null;
  /** What the load-time `saveData` wrote, parsed; `null` if it never saved. */
  readonly saved: Record<string, unknown> | null;
  /** From the start of `loadBundle` to the end of the first apply, in ms of real time. */
  readonly loadToApplyMs: number;
}

/**
 * Load the stock plugin into a fresh host over `provider` and apply it in
 * `mode`. The caller tears the harness down (`teardown`, then `stop`).
 */
export async function runStyleSettings(
  provider: DomProvider,
  mode: Mode,
  options: { parses?: 1 | 2 } = {},
): Promise<StyleSettingsRun> {
  const harness = await ShimHarness.withVault({}, { dom: provider });
  const manifest: PluginManifest = { ...MANIFEST, dir: `${harness.config.configDirName}/plugins/${MANIFEST.id}` };
  harness.setConfigFile(`${manifest.dir}/data.json`, DATA_JSON);

  const document = (globalThis as unknown as { document: RunDocument }).document;
  for (const css of [THEME_CSS, SNIPPET_CSS]) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
  document.body.classList.add(mode === "light" ? "theme-light" : "theme-dark");

  // The prune-save at load is a `write_file` through the gate; answer it and
  // keep what it carried.
  let saved: Record<string, unknown> | null = null;
  harness.serve((request) => {
    if (request.request.method !== "write_file") return false;
    const params = request.request.params as { path: string; content_base64: string };
    if (params.path !== `${manifest.dir}/data.json`) return false;
    saved = JSON.parse(Buffer.from(params.content_base64, "base64").toString("utf8")) as Record<string, unknown>;
    harness.respondOk(request.id, "write_file", { revision: "blake3:saved", semantic: false });
    return true;
  });

  const started = performance.now();
  const loader = new BundleLoader(harness.loaderDeps());
  const plugin = await loader.loadBundle({
    request: {
      pluginId: manifest.id,
      filename: MAIN_JS_PATH,
      source: MAIN_JS,
      hostModulePaths: harness.hostModulePaths,
    },
    manifest,
  });
  await harness.clock.advance(150);
  await settle();
  const loadToApplyMs = performance.now() - started;

  if ((options.parses ?? 2) === 2) {
    harness.app.workspace.trigger("css-change");
    await harness.clock.advance(150);
    await settle();
  }

  const style = document.getElementById("css-settings-manager");
  const manager = (plugin as unknown as { settingsManager?: { settings?: Record<string, unknown> } }).settingsManager;
  return {
    harness,
    classes: [...document.body.classList].sort(),
    styleText: style?.textContent ?? null,
    inMemory: manager?.settings === undefined ? null : (JSON.parse(JSON.stringify(manager.settings)) as Record<string, unknown>),
    saved,
    loadToApplyMs,
  };
}

/** Let the save's promise chain and the fake daemon's answer settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((done) => setImmediate(done));
}
