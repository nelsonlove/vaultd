/**
 * `app.internalPlugins` — Obsidian's core plugins, as much of them as a vault's
 * config files can honestly answer for.
 *
 * **Three are reimplemented, the rest are present-but-absent.** `daily-notes`
 * and `bookmarks` are, from a plugin's point of view, config readers: what
 * rollover-daily-todos wants from `daily-notes` is `{ folder, format, template }`
 * out of `daily-notes.json`, and what a bookmark consumer wants is the tree out
 * of `bookmarks.json`. Both are files this host can read, so both are real.
 * `global-search` is the third: its instance (`shim/global-search.ts`) has the
 * two methods the corpus calls, `openGlobalSearch` and `getGlobalSearchQuery`,
 * and opening a search runs it on the engine's `search` and makes it the host's
 * current search, which host clients read — there is no pane to show it in. It
 * is served only when `core-plugins.json` enables it, as Obsidian's is.
 * Everything else a core plugin does — `file-explorer`'s tree, `bases`,
 * `file-recovery`, `properties`, `workspaces` — is a *view*, and a headless host
 * has none. Those report `enabled` truthfully from
 * `core-plugins.json` and hand back `instance: null`, which is exactly the
 * shape the consuming plugins already branch on: folder-notes' `getFileExplorer()`
 * early-returns on a falsy instance and disables its CSS features cleanly.
 *
 * **`templates` falls to the same default, and that is a decision.** Nothing in
 * the corpus reads its instance, and an object with an empty `options` would
 * claim a template folder this host never read. `null` says "not here" to a
 * plugin that asks, which is the answer a plugin can act on.
 *
 * **With no `core-plugins.json` at all, every id reports `enabled: false`** —
 * including `file-explorer`, `global-search` and `properties`, which a fresh
 * real vault has on by default. Which way Obsidian reports a core plugin in a
 * vault whose file has never been written is **uncaptured**, and `false` is the
 * least-harm reading: the file is the only record this host has, and claiming
 * `enabled` for a view that is certainly not there would be a second claim on
 * top of one it cannot back. For the view-only ids nothing downstream turns on
 * it — `instance` is `null` either way, so every consumer takes the same
 * degraded branch. For `global-search` it decides whether the instance is
 * served at all, and `false` means a vault without the file gets none.
 *
 * **Config resolution is host-directory-first**, the same ladder
 * `Vault.getConfig` uses for `app.json`: `<hostConfigDir>/<name>` first,
 * `.obsidian/<name>` as the fallback. A fresh headless config dir therefore
 * inherits the real vault's `daily-notes.json` — which is what makes rollover
 * work on day one — while an explicit headless override wins. Both reads go
 * through the daemon's `read_file`; the host never opens either file itself.
 *
 * **When the cache is re-read, stated against the daemon's real behaviour
 * (Ruling W7).** The daemon raises `config_changed` for writes into `.obsidian`
 * that it sees: this host's own raw writes, and another vaultd client's. It
 * does **not** watch a GUI Obsidian editing those files. So {@link
 * InternalPluginRegistry.refresh} runs on three occasions: once at startup,
 * once per `config_changed` naming one of the three files this registry reads,
 * and whenever Task 14's 60 s coexistence poll calls it for the external-edit
 * case an event will never cover. It is public for exactly that third caller.
 *
 * The basename filter on the event matters: `config_changed` fires for every
 * write into the config zone, including every plugin's own `data.json`, and
 * re-reading the config files on each of those would turn one plugin's
 * `saveData` into a handful of `read_file` round trips.
 */

import { declarePolicy, recordUse } from "./policy";
import type { GlobalSearchInstance } from "./global-search";
import { OBSIDIAN_CONFIG_DIR } from "../pluginset/config-dir";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { ReadFileResponse } from "../client/protocol";
import type { RequestSink } from "../client/request-sink";

// `OBSIDIAN_CONFIG_DIR` — Obsidian's own config directory, which this host reads
// and never writes — comes from `pluginset/config-dir.ts`, which holds the
// package's one copy of the string after a review found three.

/** One entry of `app.internalPlugins.plugins`. */
export interface InternalPluginEntry {
  readonly id: string;
  readonly enabled: boolean;
  /** A reimplemented core plugin's instance; `null` for everything else. */
  readonly instance: unknown;
}

/** What `daily-notes`' instance carries, and all of it that plugins read. */
export interface DailyNotesInstance {
  options: { folder: string; format: string; template: string };
}

/** One node of the bookmarks tree, as `bookmarks.json` spells it. */
export interface BookmarkItem {
  type: "file" | "folder" | "search" | "graph" | "group" | "url" | (string & {});
  title?: string;
  path?: string;
  subpath?: string;
  query?: string;
  url?: string;
  ctime?: number;
  items?: BookmarkItem[];
}

/** What `bookmarks`' instance carries. */
export interface BookmarksInstance {
  items: BookmarkItem[];
  getBookmarks(): BookmarkItem[];
  getItemTitle(item: BookmarkItem): string;
}

export interface InternalPluginDeps {
  readonly client: RequestSink;
  readonly mirror: Mirror;
  readonly config: HostConfig;
  /**
   * The host's one `global-search` instance, built beside this registry and
   * also handed to the server, which reads its state and relays its event. The
   * registry only decides whether a plugin is given it.
   */
  readonly globalSearch: GlobalSearchInstance;
}

/**
 * Obsidian's defaults for `daily-notes.json`, used for any key the file omits.
 *
 * A vault that has never opened the core plugin's settings has no file at all,
 * and `YYYY-MM-DD` with no folder and no template is what Obsidian behaves as
 * in that state.
 */
const DAILY_NOTES_DEFAULTS = { folder: "", format: "YYYY-MM-DD", template: "" } as const;

/**
 * The core plugins this host reports present and cannot serve an instance for.
 *
 * Every one of them is a view. A sixth id — or any id at all that is not
 * `daily-notes`, `bookmarks` or `global-search` — falls to the same default; the
 * list is written out because these five are the ones the corpus actually asks
 * for, and a reader of this file is owed the names.
 */
const VIEW_ONLY = new Set<string>([
  "file-explorer",
  "bases",
  "file-recovery",
  "properties",
  "workspaces",
]);

export class InternalPluginRegistry {
  /** Every core plugin this host knows an `enabled` flag for, by id. */
  readonly plugins: Record<string, InternalPluginEntry> = {};

  private readonly deps: InternalPluginDeps;
  private readonly unsubscribe: () => void;
  /** The first refresh, so a caller can wait for the registry to be usable. */
  private readonly primed: Promise<void>;

  /**
   * The last parse of each config file, kept so a refresh can re-read **one**
   * file and still rebuild the whole map.
   *
   * `undefined` means "never read"; `null` means "read, and there is no such
   * file or it does not parse" — which is an ordinary vault state and not the
   * same claim.
   */
  private parsed = new Map<string, Record<string, unknown> | null>();

  /** The refresh in flight, or `null`. See {@link refresh}. */
  private inFlight: Promise<void> | null = null;
  /** The rerun queued behind it, so overlapping events collapse into one. */
  private queuedRun: Promise<void> | null = null;
  /**
   * What the next run must read: a set of basenames, or `null` for every file.
   * `undefined` when nothing is queued.
   */
  private queuedNames: Set<string> | null | undefined = undefined;

  /**
   * The files this registry reads. A write to anything else is ignored.
   *
   * **`app.json` is deliberately not here**, against the brief's list of four:
   * nothing in this registry reads it, `Vault.getConfig` holds its own
   * subscription for exactly that file, and a second listener re-reading three
   * unrelated files on every `app.json` write would be round trips nobody
   * consumes.
   */
  private static readonly WATCHED = new Set<string>([
    "core-plugins.json",
    "daily-notes.json",
    "bookmarks.json",
  ]);

  constructor(deps: InternalPluginDeps) {
    this.deps = deps;
    this.unsubscribe = deps.mirror.onConfigChanged(async (path: string) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!InternalPluginRegistry.WATCHED.has(name)) return;
      // Named, so the event costs one file's ladder rather than every file's.
      await this.refresh(name);
    });
    this.primed = this.refresh();
  }

  /**
   * The entry for a core plugin, or `null` for an id this host has no opinion
   * about.
   *
   * The five view-only ids and the three reimplemented ones are always present,
   * whatever `core-plugins.json` says, so the calls the corpus actually makes
   * always get an entry. An id outside that set and outside the config file is
   * one this host has never heard of, and `null` — Obsidian's own answer for a
   * core plugin that does not exist — is the honest one.
   */
  getPluginById(id: string): InternalPluginEntry | null {
    recordUse("InternalPluginRegistry.getPluginById");
    return this.plugins[id] ?? null;
  }

  /**
   * The instance, but only when the core plugin is enabled.
   *
   * `null` in every other case: disabled, unknown, or enabled-but-view-only.
   * This is the call folder-notes and tag-wrangler make, and `null` is what
   * sends them down their own already-written degraded branch.
   */
  getEnabledPluginById(id: string): unknown {
    recordUse("InternalPluginRegistry.getEnabledPluginById");
    const entry = this.plugins[id];
    if (entry === undefined || !entry.enabled) return null;
    return entry.instance;
  }

  /**
   * Re-read this registry's config files and rebuild the map.
   *
   * Public because it has three callers: the constructor, the `config_changed`
   * subscription, and Task 14's coexistence poll — see this file's header for
   * why the third one is not redundant.
   *
   * **`name` reads one file.** A `config_changed` names the path that changed,
   * and re-reading the other two costs four `read_file` round trips that answer
   * what the registry already holds. The last parse of every file is kept
   * ({@link parsed}), so a one-file refresh still rebuilds the whole map from
   * current values. Omitting `name` re-reads everything, which is what the
   * constructor and the coexistence poll — which is told *nothing* about what
   * changed — both want.
   *
   * **Refreshes are single-flight, and overlapping ones collapse.** Two events
   * in flight used to produce two interleaved read sequences, and whichever
   * *finished* last installed its map — which need not be whichever was
   * *written* last. Now a request that arrives while a refresh is running is
   * merged into one queued rerun that starts when the current one finishes, so
   * the runs are ordered and the last one to start is the last to write. Every
   * caller's promise resolves only once a run that includes its request has
   * finished.
   */
  refresh(name?: string): Promise<void> {
    this.queueName(name);
    if (this.inFlight === null) return this.startRun();
    // One rerun however many events arrive: their names merge above, and they
    // all await the same promise.
    this.queuedRun ??= this.inFlight.then(
      () => this.startRun(),
      () => this.startRun(),
    );
    return this.queuedRun;
  }

  /** Merge one request into what the next run will read. */
  private queueName(name: string | undefined): void {
    if (name === undefined || this.queuedNames === null) {
      this.queuedNames = null;
      return;
    }
    if (this.queuedNames === undefined) this.queuedNames = new Set([name]);
    else this.queuedNames.add(name);
  }

  /** Take the queued request and run it. One at a time, by construction. */
  private startRun(): Promise<void> {
    const names = this.queuedNames === undefined ? null : this.queuedNames;
    this.queuedNames = undefined;
    this.queuedRun = null;
    const run = this.readAndRebuild(names).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async readAndRebuild(names: ReadonlySet<string> | null): Promise<void> {
    for (const file of InternalPluginRegistry.WATCHED) {
      if (names !== null && !names.has(file) && this.parsed.has(file)) continue;
      this.parsed.set(file, await this.readConfigJson(file));
    }
    const enabled = enabledMap(this.parsed.get("core-plugins.json") ?? null);
    const daily = this.parsed.get("daily-notes.json") ?? null;
    const bookmarks = this.parsed.get("bookmarks.json") ?? null;
    const next: Record<string, InternalPluginEntry> = {};
    for (const [id, on] of Object.entries(enabled)) {
      next[id] = { id, enabled: on, instance: null };
    }
    for (const id of VIEW_ONLY) {
      next[id] ??= { id, enabled: false, instance: null };
    }
    // Served only while enabled, as Obsidian's is: a disabled core plugin has
    // no instance for a plugin to call.
    const searchEnabled = enabled["global-search"] ?? false;
    next["global-search"] = {
      id: "global-search",
      enabled: searchEnabled,
      instance: searchEnabled ? this.deps.globalSearch : null,
    };
    next["daily-notes"] = {
      id: "daily-notes",
      enabled: enabled["daily-notes"] ?? false,
      instance: dailyNotesInstance(daily),
    };
    next["bookmarks"] = {
      id: "bookmarks",
      enabled: enabled["bookmarks"] ?? false,
      instance: bookmarksInstance(bookmarks),
    };
    // Replace the contents rather than the object: a plugin that captured
    // `app.internalPlugins.plugins` at load — which several do — must see the
    // refreshed values rather than a snapshot of the old ones.
    for (const id of Object.keys(this.plugins)) delete this.plugins[id];
    Object.assign(this.plugins, next);
  }

  /** **HOST-ONLY.** Resolves once the first read has landed. */
  ready(): Promise<void> {
    return this.primed;
  }

  /** **HOST-ONLY.** Stop listening. For a host being torn down. */
  detach(): void {
    this.unsubscribe();
  }

  /**
   * One config file's object, host directory first.
   *
   * `null` when neither copy is there or neither parses — which is an ordinary
   * vault state, not a failure: a vault that has never enabled a core plugin
   * has no `core-plugins.json` at all.
   */
  private async readConfigJson(name: string): Promise<Record<string, unknown> | null> {
    const paths = [`${this.deps.config.configDirName}/${name}`, `${OBSIDIAN_CONFIG_DIR}/${name}`];
    for (const path of paths) {
      const parsed = await this.readOne(path);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  private async readOne(path: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.deps.client.request<ReadFileResponse>("read_file", { path });
      const source = Buffer.from(response.content_base64, "base64").toString("utf8");
      const parsed: unknown = JSON.parse(source);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * `core-plugins.json` in either of its two shapes.
 *
 * Obsidian wrote an **array of enabled ids** until 1.6 and an **object of
 * id → boolean** after it. Both are still found in real vaults — the file is
 * only rewritten when a core plugin is toggled — so both are read.
 */
function enabledMap(config: Record<string, unknown> | null): Record<string, boolean> {
  if (config === null) return {};
  const enabled: Record<string, boolean> = {};
  if (Array.isArray(config)) {
    for (const id of config) if (typeof id === "string") enabled[id] = true;
    return enabled;
  }
  for (const [id, value] of Object.entries(config)) {
    if (typeof value === "boolean") enabled[id] = value;
  }
  return enabled;
}

/** `daily-notes`' instance: its options, with Obsidian's defaults filled in. */
function dailyNotesInstance(config: Record<string, unknown> | null): DailyNotesInstance {
  return {
    options: {
      folder: stringOr(config?.["folder"], DAILY_NOTES_DEFAULTS.folder),
      format: stringOr(config?.["format"], DAILY_NOTES_DEFAULTS.format),
      template: stringOr(config?.["template"], DAILY_NOTES_DEFAULTS.template),
    },
  };
}

/** `bookmarks`' instance: the tree, and the two readers plugins call on it. */
function bookmarksInstance(config: Record<string, unknown> | null): BookmarksInstance {
  const raw = config?.["items"];
  const items: BookmarkItem[] = Array.isArray(raw) ? (raw as BookmarkItem[]) : [];
  return {
    items,
    getBookmarks: (): BookmarkItem[] => [...items],
    getItemTitle: (item: BookmarkItem): string => bookmarkTitle(item),
  };
}

/**
 * What one bookmark is called.
 *
 * An explicit `title` always wins — that is the name the user typed. Otherwise
 * the item names itself: a file by its basename without the extension (which is
 * what Obsidian displays), a folder by its path, a search by its query, a URL
 * by its address. A node that carries none of those has no name, and `""` is
 * the answer Obsidian renders as a blank row.
 */
function bookmarkTitle(item: BookmarkItem): string {
  if (typeof item.title === "string" && item.title !== "") return item.title;
  if (item.type === "file" && typeof item.path === "string") {
    const base = item.path.slice(item.path.lastIndexOf("/") + 1);
    return base.endsWith(".md") ? base.slice(0, -3) : base;
  }
  if (typeof item.path === "string") return item.path;
  if (typeof item.query === "string") return item.query;
  if (typeof item.url === "string") return item.url;
  return "";
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

// The rows this file owns. The class is not a barrel export: Obsidian's module
// publishes neither it nor `app`, and a plugin reaches this through the app.
declarePolicy("InternalPluginRegistry.getPluginById", "implemented");
declarePolicy("InternalPluginRegistry.getEnabledPluginById", "implemented");
