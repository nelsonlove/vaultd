/**
 * The schema ladder: what a plugin's settings **are**, discovered from the
 * strongest source that plugin actually offers.
 *
 * Four rungs, each less certain than the one above it, and the artifact is the
 * same file whichever rung produced it:
 *
 * 1. **`definitions`** — the plugin's own `getSettingDefinitions()`, which
 *    Obsidian shipped in 1.13.0. Accepted only when the items it answers carry
 *    `control.key`. The method existing is not enough: tasknotes and
 *    tasknotes-workflows implement it degenerately — one opaque item whose
 *    `render` calls the old renderer — so a ladder that trusted the method
 *    would report a confident *empty* schema for the largest plugin in the
 *    corpus. That is the case worth the whole rung boundary.
 * 2. **`descriptors`** — a field-descriptor array the bundle exports under a
 *    recognized name ({@link DESCRIPTOR_EXPORTS}). automatic-linker's
 *    `SETTINGS_CATALOG` is 31 entries of key/control/name/description/options,
 *    with a test in that repository keeping it in parity with the real fields.
 * 3. **`types`** — the keys and defaults of an exported `DEFAULT_SETTINGS`.
 *    Complete for keys and defaults (execute-code 211/211, automatic-linker
 *    31/31) and carries no human description at all, which is exactly why it
 *    sits below the two rungs that do.
 * 4. **`llm`** — an offline tool, run by a person, never at runtime. It emits
 *    this same file format, so a host's behaviour is identical no matter which
 *    rung produced the file it is serving. {@link SchemaLadder.climb} covers
 *    rungs 1–3 and nothing here can reach rung 4.
 *
 * **`display()` is never executed.** The research measured running it as weaker
 * than reading source in every sampled case — meta-bind's is dead code,
 * folder-notes recovers about a sixth of its fields, governor is structurally
 * blind to part of its own config — and governor's `display()` spawns the
 * `claude` CLI, which would hang a headless harness rather than merely answer
 * badly. A rung that cannot be trusted and can hang is not a rung.
 *
 * **The cache is keyed by version**, at `schema/<pluginId>@<version>.json`
 * under the host's data directory, so a plugin update is a cache miss *by
 * construction*: there is no invalidation logic here to get wrong, and no way
 * for a stale schema to be served for a bundle that has moved on. Every byte
 * goes through {@link DataDir}, the host's one writing module.
 */

import { DataDir } from "../datadir";
import { systemClock } from "../config";
import { pluginHostFor } from "../shim/plugin";
import type { Clock } from "../config";
import type { Plugin, PluginManifest, PluginSettingTab } from "../shim/plugin";

/** Which rung produced a schema. `none` means no rung applied. */
export type SchemaSource = "definitions" | "descriptors" | "types" | "llm" | "none";

/**
 * Obsidian's own nine-control union, plus `unknown`.
 *
 * `unknown` is not a tenth control: it is the honest answer for a key whose
 * control nothing declared — a `DEFAULT_SETTINGS` entry holding an object, a
 * descriptor naming a control this host has never seen. A write to such a key
 * is type-checked against nothing, which is the only defensible thing to do
 * with a type nobody stated.
 */
export type SchemaControl =
  | "toggle"
  | "dropdown"
  | "text"
  | "textarea"
  | "number"
  | "file"
  | "folder"
  | "slider"
  | "color"
  | "unknown";

export interface SchemaItem {
  key: string;
  control: SchemaControl;
  name?: string;
  description?: string;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
}

export interface CachedSchema {
  pluginId: string;
  pluginVersion: string;
  source: SchemaSource;
  items: SchemaItem[];
  capturedAtUnixMs: number;
}

/**
 * The export names rung 2 recognizes, in the order it tries them.
 *
 * A closed list rather than a search: the point of the rung is that the
 * *plugin* published a machine-readable description of its own settings, and
 * a host that went hunting through every export for something array-shaped
 * would sooner or later find a plugin's command table and call it a schema.
 */
const DESCRIPTOR_EXPORTS = ["SETTINGS_CATALOG", "settingsDefinitions", "configFields"] as const;

/** The export rung 3 reads. */
const DEFAULTS_EXPORT = "DEFAULT_SETTINGS";

const CONTROLS = new Set<string>([
  "toggle",
  "dropdown",
  "text",
  "textarea",
  "number",
  "file",
  "folder",
  "slider",
  "color",
]);

export class SchemaLadder {
  private readonly dir: DataDir;
  private readonly clock: Clock;

  /**
   * `clock` defaults so that the one-argument form the brief pins keeps
   * working, and exists at all because a captured-at stamp read from the
   * ambient globals is a value no test can pin. Every harness passes its
   * `TestClock`; production passes the host's.
   */
  constructor(dataDir: string, clock: Clock = systemClock()) {
    this.dir = new DataDir(dataDir);
    this.clock = clock;
  }

  /** The cached schema for exactly this version, or `null` for a miss. */
  read(pluginId: string, pluginVersion: string): CachedSchema | null {
    return this.dir.readJson<CachedSchema>(cachePath(pluginId, pluginVersion));
  }

  /**
   * Write one schema to the cache, atomically.
   *
   * Atomic because the file is read at startup by something that has no second
   * source for it: a truncated write would be an unparseable document, and
   * {@link DataDir.readJson} is right to throw on one rather than quietly serve
   * an empty schema for a plugin that has forty settings.
   */
  write(schema: CachedSchema): void {
    this.dir.writeJsonAtomic(cachePath(schema.pluginId, schema.pluginVersion), schema);
  }

  /**
   * Rungs 1–3, in order, against a loaded plugin. Never writes — the Detector
   * decides when a climb becomes a cache entry.
   *
   * The tab comes from the harvest, which is the only thing in this process
   * holding a reference to it: `addSettingTab` is handed a live instance that
   * the plugin constructs inside `onload` and then drops. The reference never
   * crosses the socket — `server/wire.ts` sends `{ plugin_id,
   * has_setting_definitions }` — so an object with a path to the whole `App`
   * cannot leak into a client's JSON.
   */
  climb(plugin: Plugin, manifest: PluginManifest): CachedSchema {
    const harvest = pluginHostFor(plugin.app).harvest;
    const tab = harvest.settingTabs().find((row) => row.pluginId === manifest.id)?.tab;
    const exports = harvest.moduleExports(manifest.id);
    const climbed =
      fromDefinitions(tab) ?? fromDescriptors(exports) ?? fromDefaults(exports) ?? null;
    return {
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      source: climbed?.source ?? "none",
      items: climbed?.items ?? [],
      capturedAtUnixMs: this.clock.now(),
    };
  }
}

/** `schema/<pluginId>@<version>.json`. See the header on why the version is in it. */
function cachePath(pluginId: string, pluginVersion: string): string {
  return `schema/${pluginId}@${pluginVersion}.json`;
}

interface ClimbedRung {
  source: SchemaSource;
  items: SchemaItem[];
}

/**
 * Rung 1. `null` demotes to the next rung — including when the method throws.
 *
 * A plugin's method throwing is a fact about that plugin, not about this host,
 * and the answer to it is the next rung rather than a failed climb: the whole
 * point of a ladder is that a plugin which cannot describe itself one way may
 * still describe itself another.
 */
function fromDefinitions(tab: PluginSettingTab | undefined): ClimbedRung | null {
  if (tab === undefined || typeof tab.getSettingDefinitions !== "function") return null;
  let raw: unknown;
  try {
    raw = tab.getSettingDefinitions();
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: SchemaItem[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) return null;
    const control = asRecord(record["control"]);
    // The degenerate case, and the reason this rung is a boundary rather than a
    // presence test: an item with a `render` and no `control.key` describes
    // nothing a caller could read or write by name.
    if (control === null) return null;
    const key = control["key"];
    if (typeof key !== "string" || key === "") return null;
    items.push(
      item(key, controlOf(control["type"]), {
        name: record["name"],
        description: record["description"],
        defaultValue: record["defaultValue"] ?? control["defaultValue"],
        options: record["options"] ?? control["options"],
      }),
    );
  }
  return { source: "definitions", items };
}

/** Rung 2: the first recognized export that is a usable descriptor array. */
function fromDescriptors(exports: unknown): ClimbedRung | null {
  const bundle = asRecord(exports);
  if (bundle === null) return null;
  for (const name of DESCRIPTOR_EXPORTS) {
    const value = bundle[name];
    if (!Array.isArray(value) || value.length === 0) continue;
    const items = descriptorItems(value);
    if (items !== null) return { source: "descriptors", items };
  }
  return null;
}

/**
 * Every entry must carry a `key` **and** a control-ish field, or the array is
 * not a settings catalogue and this rung declines it whole.
 *
 * Whole rather than per-entry: a partially recognized array would produce a
 * schema that *looks* authoritative and silently omits keys, which is the shape
 * that makes `set` refuse a legitimate write with `unknown_key`.
 */
function descriptorItems(entries: readonly unknown[]): SchemaItem[] | null {
  const items: SchemaItem[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === null) return null;
    const key = record["key"];
    if (typeof key !== "string" || key === "") return null;
    const declared = record["control"] ?? record["type"] ?? record["kind"];
    if (typeof declared !== "string") return null;
    items.push(
      item(key, controlOf(declared), {
        name: record["name"],
        description: record["description"],
        defaultValue: record["defaultValue"] ?? record["default"],
        options: record["options"],
      }),
    );
  }
  return items;
}

/**
 * Rung 3: the keys and defaults of `DEFAULT_SETTINGS`, with the control
 * inferred from each default's JS type.
 *
 * Inferred, and the inference is deliberately shallow — a boolean is a toggle,
 * a number is a number, a string is a text field, and anything else is
 * `unknown`. A default of `[]` says nothing about whether the plugin renders a
 * dropdown, a list editor or nothing at all, and guessing one would be
 * inventing a control from a value.
 */
function fromDefaults(exports: unknown): ClimbedRung | null {
  const bundle = asRecord(exports);
  if (bundle === null) return null;
  const defaults = asRecord(bundle[DEFAULTS_EXPORT]);
  if (defaults === null) return null;
  const keys = Object.keys(defaults);
  if (keys.length === 0) return null;
  const items = keys.map((key) => item(key, controlOfValue(defaults[key]), {
    defaultValue: defaults[key],
  }));
  return { source: "types", items };
}

/**
 * Build a {@link SchemaItem} with only the fields that are really there.
 *
 * The optional fields are assigned conditionally rather than set to
 * `undefined`, because `exactOptionalPropertyTypes` is on and because a cached
 * file carrying `"name": null` for every key would be a document that claims
 * more than the climb found.
 */
function item(
  key: string,
  control: SchemaControl,
  fields: { name?: unknown; description?: unknown; defaultValue?: unknown; options?: unknown },
): SchemaItem {
  const built: SchemaItem = { key, control };
  if (typeof fields.name === "string") built.name = fields.name;
  if (typeof fields.description === "string") built.description = fields.description;
  if (fields.defaultValue !== undefined) built.defaultValue = fields.defaultValue;
  const options = optionsOf(fields.options);
  if (options !== null) built.options = options;
  return built;
}

/** A declared control name, or `unknown` for anything outside Obsidian's union. */
function controlOf(declared: unknown): SchemaControl {
  if (typeof declared !== "string") return "unknown";
  return CONTROLS.has(declared) ? (declared as SchemaControl) : "unknown";
}

/** Rung 3's inference. See {@link fromDefaults}. */
function controlOfValue(value: unknown): SchemaControl {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  return "unknown";
}

/** `[{ value, label }]`, or `null` when what was offered is not that. */
function optionsOf(raw: unknown): Array<{ value: string; label: string }> | null {
  if (!Array.isArray(raw)) return null;
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) return null;
    const value = record["value"];
    const label = record["label"] ?? record["name"] ?? record["display"];
    if (typeof value !== "string" || typeof label !== "string") return null;
    options.push({ value, label });
  }
  return options.length === 0 ? null : options;
}

/** A plain object to read keys off, or `null`. An array is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
