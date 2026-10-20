/**
 * **The screen host**: the second host profile (docs/design/web-plugins.md,
 * section 2, "Where the server apply runs"; owner decision 1).
 *
 * Its own process beside the web server, never inside the headless host: the
 * headless host keeps its inert stub document on purpose. This one assembles
 * the same shim with happy-dom behind `document`, connects to `vaultd` the way
 * the headless host does, and loads only the plugins named by
 * {@link ScreenHostOptions.plugins} (the `--plugins` flag), each only while the
 * vault's own `.obsidian/community-plugins.json` enables it, in that file's
 * order. **With none named it loads nothing**: never "every enabled plugin",
 * because this process is not a sandbox and a plugin that writes files on a
 * Sync-kept vault pushes them to every device (owner's ruling, 2026-10-20). It
 * names no plugin itself: what a plugin did to the page
 * is read back as a diff (`apply-service.ts`). A plugin that cannot be read or
 * loaded is reported (`host.hello`'s `failed`), not fatal; the others are
 * served. It reads the vault's `.obsidian` (the GUI's directory) and writes
 * nothing of its own; a plugin's writes go through vaultd as in the headless
 * host, or with {@link ScreenHostOptions.readOnly} (`--read-only`) are all
 * refused and recorded (`write-gate.ts`). The plugins' own saves go to the
 * `viewer` store, outside the vault.
 *
 * It answers one request, `screen.apply` (`apply-service.ts`), over its own
 * socket (`screen-server.ts`).
 *
 * **Its own clock for the plugin.** The assembly's timers run on a driven
 * clock that only the apply service moves, so the plugin's 100 ms debounce
 * costs no real wait and an apply is never cut by a timer firing half way.
 * The engine supervisor keeps the real clock.
 *
 * **Config changes reach the next apply without a restart (task 8).** The
 * host reads the vault's `.obsidian` through vaultd and keeps what it read:
 * the plugins' bundles and enabled state, each stylesheet set it built, and
 * the vault's `data.json` of each plugin. A `config_changed` from vaultd for a path that
 * can change the output (see {@link affectsScreen}), or any `resync_required`,
 * marks all of it stale, and the next request reads it again; a changed bundle,
 * enabled state or set of failures replaces the apply service (and with it the
 * result cache).
 * vaultd does not watch `.obsidian`, so an edit made outside vaultd (desktop
 * Obsidian, a sync tool) raises no event: after {@link CONFIG_REVALIDATE_MS}
 * the host reads the files again and compares their revisions, and drops only
 * what changed. Every one of these reads has a timeout
 * ({@link CONFIG_READ_TIMEOUT_MS}); a read that fails or times out fails its
 * request and leaves the host stale, so the next request reads everything
 * again and the queue keeps moving.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BundleLoader } from "../runtime/loader";
import { DataDir } from "../datadir";
import { DaemonUnreachable } from "../host";
import { Mirror } from "../mirror/mirror";
import { OBSIDIAN_CONFIG_DIR } from "../pluginset/config-dir";
import { ScreenError, ScreenServer } from "./screen-server";
import { Supervisor } from "../supervisor";
import { VaultdError } from "../client/errors";
import { assembleShim } from "../testing/assemble";
import { APPLY_DEADLINE_MS, boundedLoaderQueue, createApplyService } from "./apply-service";
import { RefusingWriteGate } from "./write-gate";
import { happyDomProvider } from "../shim/dom-providers/happy-dom";
import { installModuleInterception } from "../runtime/intercept";
import { drivenClock } from "../runtime/driven-clock";
import { VaultDocumentCache } from "../shim/viewer-data-store";
import { buildSheetSet } from "../web/sheet-set";
import { isKnownRuntimeEvent } from "../client/protocol";
import type { ApplyRequest, ApplyResult, ApplyService, Mode, PluginFailure, Sheet } from "./apply-service";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";
import type { ReadFileResponse, RuntimeEventDto } from "../client/protocol";
import type { ServiceDocument } from "./apply-service";
import type { VaultdClient } from "../client/client";

/** The answer when no plugin is loaded: nothing added to the page. */
const EMPTY_RESULT: ApplyResult = Object.freeze({ classes: Object.freeze([]), styles: Object.freeze([]) });

/** One `screen.apply` line can carry a whole theme; 64 MB is far past any real set. */
export const SCREEN_LINE_CAP_BYTES = 64 * 1024 * 1024;

/**
 * How long what the host read from `.obsidian` is trusted without an event, in
 * real milliseconds. vaultd raises `config_changed` only for its own writes,
 * so this bounds how long an edit made outside vaultd goes unseen. A re-read
 * costs a few vaultd reads (the bundle, the sets in use, `data.json`) once per
 * period, not per request.
 */
export const CONFIG_REVALIDATE_MS = 10_000;

/**
 * How long one `.obsidian` read through vaultd may take, in real milliseconds:
 * the apply deadline's value. These reads (the bundle, the sets, the period's
 * check) run before the apply and outside its deadline.
 */
export const CONFIG_READ_TIMEOUT_MS = APPLY_DEADLINE_MS;

/** How many built stylesheet sets the host keeps (one per distinct theme and snippet choice). */
export const SHEET_SET_CACHE_LIMIT = 32;

/** The files under `.obsidian/` a screen apply depends on. */
const SCREEN_CONFIG_FILES = new Set(["appearance.json", "community-plugins.json"]);
const PLUGIN_FILES = new Set(["styles.css", "data.json", "main.js", "manifest.json"]);

/**
 * Can a change at `path` (a vault path, as `config_changed` names it) change
 * a screen apply? The theme and snippet folders, `appearance.json`,
 * `community-plugins.json`, and a plugin's `styles.css`, `data.json`,
 * `main.js` and `manifest.json`; a folder above any of them too, since a
 * folder create announces the folder.
 */
export function affectsScreen(path: string, configDir: string = OBSIDIAN_CONFIG_DIR): boolean {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== configDir) return false;
  if (parts.length === 1) return true;
  const [, top] = parts as [string, string, ...string[]];
  if (SCREEN_CONFIG_FILES.has(top) || top === "themes" || top === "snippets") return true;
  if (top !== "plugins") return false;
  // `.obsidian/plugins`, `.obsidian/plugins/<id>`, or one of a plugin's files.
  return parts.length <= 3 || (parts.length === 4 && PLUGIN_FILES.has(parts[3] as string));
}

/**
 * A `screen.apply` request. Either `sheets` (the whole set, built by the
 * caller) or `appearance` (the effective theme and snippets; the host builds
 * the set itself from `.obsidian` through vaultd and keeps it, so a page asks
 * with a few bytes and no sheet text).
 */
export interface ScreenApplyRequest {
  readonly viewer: string;
  readonly mode: Mode;
  readonly sheets?: readonly Sheet[];
  readonly appearance?: { readonly theme?: string; readonly snippets?: readonly string[] };
}

/** `screen.stats`: the apply service's counts, and the host's own. */
export interface ScreenStats {
  readonly loads: number;
  readonly unloads: number;
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
  /** Requests this host's plugin side and config reads sent to vaultd. */
  readonly vaultd_requests: number;
  /** Bytes of sheet text received in `screen.apply` requests. */
  readonly sheet_bytes_received: number;
  /** `config_changed` events that marked the host's config stale. */
  readonly config_events: number;
  /** Times the host read all of `.obsidian` again and dropped what it kept (at start, after an event or a failure, or when the period's check found the bundle changed). */
  readonly config_reads: number;
  /** Times the period's check compared revisions (it drops only what changed). */
  readonly config_checks: number;
  /** Times the plugins' bundles, enabled state or read failures changed and the service was replaced. */
  readonly bundle_changes: number;
  /** As `host.hello` says now: the plugins loaded, and those that failed. */
  readonly plugins: readonly string[];
  readonly failed: readonly PluginFailure[];
  /** Plugins `--plugins` names that the vault does not enable. */
  readonly unknown: readonly string[];
  /** Whether the host refuses every vault write (`--read-only`). */
  readonly read_only: boolean;
  /** Vault writes refused under `--read-only` (each one a plugin tried); 0 without it. */
  readonly writes_refused: number;
}

/** `$XDG_STATE_HOME/vaultd-screen-host`: this host's own state, apart from the headless host's. */
export function screenDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-screen-host");
}

/** `<dataDir>/run/<vault digest>/screen.sock`. */
export function screenSocketPathFor(dataDir: string, vaultRoot: string): string {
  const digest = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 16);
  return join(dataDir, "run", digest, "screen.sock");
}

export interface ScreenHostOptions {
  /**
   * The plugins to load (the `--plugins` flag), each only while the vault's
   * `community-plugins.json` enables it, in that file's order. Default: none,
   * so the host loads nothing; it never loads "every enabled plugin".
   */
  readonly plugins?: readonly string[];
  /**
   * Refuse every vault write a plugin tries, record it, and refuse the node
   * file system, process and network modules to bundles (`--read-only`).
   * Default: off, so a plugin's writes go through vaultd as in the headless
   * host.
   */
  readonly readOnly?: boolean;
  /** The `viewer` store's state root. Default `$XDG_STATE_HOME/vaultd-web/plugin-data`. */
  readonly stateRoot?: string;
  readonly cacheLimit?: number;
  /** Bind the socket. Default `true`. */
  readonly listen?: boolean;
  /** Default {@link CONFIG_REVALIDATE_MS}; `0` trusts events alone. */
  readonly revalidateMs?: number;
  /** How long one `.obsidian` read through vaultd may take. Default {@link CONFIG_READ_TIMEOUT_MS}. */
  readonly readTimeoutMs?: number;
  /** A test seam: wrap each `.obsidian` read (for example, never answer one). */
  readonly interceptRead?: <T>(path: string, read: Promise<T>) => Promise<T>;
}

export interface RunningScreenHost {
  readonly config: HostConfig;
  readonly socketPath: string;
  /**
   * The plugins the host loads, by id, in load order: named in `plugins`,
   * enabled, read, and not failed. Empty when there are none. As last read;
   * a plugin whose `onload` throws leaves it at the first apply that loads it.
   */
  readonly plugins: readonly string[];
  /** The plugins that could not be read or loaded, with the reason. */
  readonly failed: readonly PluginFailure[];
  /** The plugins `plugins` names that the vault does not enable. As last read. */
  readonly unknown: readonly string[];
  /** With `readOnly`, the gate that refused every vault write a plugin tried; else `null`. */
  readonly writes: RefusingWriteGate | null;
  /** The apply service, or `null` when no plugin is loaded. As last read. */
  readonly service: ApplyService | null;
  apply(request: ScreenApplyRequest): Promise<ApplyResult>;
  stats(): ScreenStats;
  /** The engine's client (for tests and tools: a write through it raises `config_changed`). */
  client(): VaultdClient;
  stop(): Promise<void>;
}

/** Start a screen host over `config` (the headless host's config shape). */
export async function startScreenHost(config: HostConfig, options: ScreenHostOptions = {}): Promise<RunningScreenHost> {
  new DataDir(config.dataDir).ensureSecureDir(".");
  const supervisor = new Supervisor(config, {
    onClientReady: () => {},
    onEngineLost: () => {},
    onStateChange: () => {},
  });
  try {
    await supervisor.start();
    await supervisor.whenWatching();
  } catch (error) {
    await supervisor.stop();
    throw new DaemonUnreachable(error);
  }
  // **Undone in reverse, on a failed start and at stop.** Each step pushes its
  // own undo once it exists, so a start that fails half way takes down what it
  // built, the spawned vaultd included, rather than leaving it running. The
  // reverse order is also the stop order: the socket first (no new request
  // can reload the plugin), then the plugin, the module interception, the
  // assembly's globals, the mirror, and the engine last.
  const undo: Array<() => Promise<void> | void> = [() => supervisor.stop()];
  const unwind = async (): Promise<void> => {
    for (const step of undo.splice(0).reverse()) {
      try {
        await step();
      } catch {
        // Keep unwinding: a later step still owns a resource.
      }
    }
  };
  try {
    const clientOf = (): VaultdClient => supervisor.client();
    // Every request the plugin side and the config reads send is counted, so
    // a test can see that a cache hit sends none.
    let vaultdRequests = 0;
    const countedClient = (): VaultdClient => {
      const real = supervisor.client();
      return new Proxy(real, {
        get(target, key): unknown {
          if (key === "request") {
            return (...args: Parameters<VaultdClient["request"]>): ReturnType<VaultdClient["request"]> => {
              vaultdRequests += 1;
              return target.request(...args);
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    // **No note mirror.** The screen plugins read only `.obsidian/`, through
    // vaultd, so the mirror is the empty one: a full `Mirror.open` would load
    // every note's metadata (on a vault of about 22,400 notes, 24 s and most
    // of the process's 940 MB) for nothing. `app.vault` and `metadataCache`
    // answer as an empty vault here.
    const mirror = Mirror.empty(clientOf, config);
    undo.push(() => {
      mirror.stop();
    });

    const clock = drivenClock(Date.now());
    // **`readOnly`: the screen profile writes nothing (review S1).** Every
    // mutation the shim makes goes through this gate, which refuses it and
    // records it; the node file system, process and network modules are
    // refused to plugin bundles below. Without it, a plugin's writes go to
    // vaultd as in the headless host: they are the plugin's own behaviour on
    // one more device (owner's ruling, 2026-10-20). Either way a plugin's own
    // data goes to the viewer store.
    const readOnly = options.readOnly === true;
    const writes = readOnly ? new RefusingWriteGate() : null;
    const assembly = assembleShim({
      config,
      client: countedClient,
      mirror,
      clock,
      dom: happyDomProvider(),
      ...(writes === null ? {} : { writes }),
    });
    writes?.reportTo(assembly.errors);
    undo.push(() => assembly.teardown());
    const modulePaths = [resolve(__dirname, "..", "..", "..", "..", "node_modules")];
    const interception = installModuleInterception({
      hostModulePaths: modulePaths,
      // Read-only: no `fs`, `child_process`, network or `vm` for a bundle, or
      // the gate above would be a door with a wall beside it.
      allowNodeBuiltins: !readOnly,
      harvest: assembly.harvest,
    });
    undo.push(() => {
      interception.restore();
    });
    const loader = new BundleLoader({
      app: assembly.app,
      // Each load, unload and compile fails at its own deadline, so a plugin
      // whose `onload` never finishes fails alone (apply-service.ts).
      queue: boundedLoaderQueue(assembly.queue),
      events: assembly.events,
      harvest: assembly.harvest,
      errors: assembly.errors,
    });
    assembly.app.plugins.setLoader(loader);

    const readTimeoutMs = options.readTimeoutMs ?? CONFIG_READ_TIMEOUT_MS;
    /**
     * What the period's check compares against: the revision each file had the
     * first time the host read it since the last full refresh (or since the
     * check last saw it change). A later read, such as the one a new set makes,
     * does not move it, so an edit made outside vaultd cannot be hidden by a
     * read that happened to see it.
     */
    const validated = new Map<string, string | null>();
    /**
     * One read through vaultd, bounded: vaultd's client has no timeout of its
     * own, and these reads run outside the apply deadline, so a read that never
     * answers would otherwise hold the host's queue for good (review of task 8,
     * finding 1). A timed-out read fails its request; the host is left stale.
     */
    const readEntry = async (path: string): Promise<{ text: string; revision: string } | null> => {
      const underlying = (async (): Promise<{ text: string; revision: string } | null> => {
        try {
          const response = await countedClient().request<ReadFileResponse>("read_file", { path });
          return { text: Buffer.from(response.content_base64, "base64").toString("utf8"), revision: response.revision };
        } catch (error) {
          if (error instanceof VaultdError && (error.code === "not_found" || error.code === "parent_not_found")) return null;
          throw error;
        }
      })();
      const bounded = options.interceptRead === undefined ? underlying : options.interceptRead(path, underlying);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_settle, fail) => {
        timer = setTimeout(() => {
          fail(new Error(`reading ${path} through vaultd took over ${String(readTimeoutMs)} ms`));
        }, readTimeoutMs);
      });
      try {
        const entry = await Promise.race([bounded, deadline]);
        if (!validated.has(path)) validated.set(path, entry?.revision ?? null);
        return entry;
      } finally {
        clearTimeout(timer);
      }
    };
    const read = async (path: string): Promise<string | null> => (await readEntry(path))?.text ?? null;

    // --- What the host read from `.obsidian`, and when it is read again. ---
    const dom = assembly.globals.dom;
    const vaultDocuments = new VaultDocumentCache();
    const sets = new Map<string, readonly Sheet[]>();
    const revalidateMs = options.revalidateMs ?? CONFIG_REVALIDATE_MS;
    const counts = { sheetBytes: 0, configEvents: 0, configReads: 0, configChecks: 0, bundleChanges: 0 };
    let service: ApplyService | null = null;
    /** The enabled (and named) plugin ids, as last read, whether or not they could be read. */
    let candidates: readonly string[] = [];
    /** Plugins `plugins` names that the vault does not enable, as last read. */
    let unknown: readonly string[] = [];
    /** Plugins whose files could not be read or parsed at the last read. */
    let readFailures: readonly PluginFailure[] = [];
    /** A digest of the plugin ids, manifests and bundles in use and of the read failures, or `null` for none. */
    let bundleDigest: string | null = null;
    /**
     * Stale until a refresh succeeds: `changes` counts the marks, `readThrough`
     * is the count a successful refresh started at. A mark that lands while a
     * refresh runs is not lost, and a refresh that fails leaves the host stale.
     */
    let changes = 1;
    let readThrough = 0;
    let readAt = 0;
    let stopped = false;

    const markStale = (): void => {
      changes += 1;
    };
    // vaultd's own events: a config change that can change the output, or a
    // resync (an engine restart, a lost event), makes the next request re-read.
    await supervisor.subscribe((event: RuntimeEventDto) => {
      if (!isKnownRuntimeEvent(event)) return;
      if (event.type === "config_changed" && affectsScreen(event.value.path)) {
        counts.configEvents += 1;
        markStale();
      } else if (event.type === "resync_required") {
        markStale();
      }
    });

    const enabledPath = `${OBSIDIAN_CONFIG_DIR}/community-plugins.json`;
    const dataPathOf = (id: string): string => `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/data.json`;
    const bundlePathsOf = (id: string): string[] => [
      `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/manifest.json`,
      `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/main.js`,
    ];
    const named = options.plugins === undefined ? null : new Set(options.plugins);

    /**
     * Read everything again (after an event, a failure, or at start). Sets and
     * `data.json` are dropped. The enabled list is read, and each plugin's
     * bundle and manifest are read and checked **before** the old service is
     * touched. A plugin whose files are missing or whose manifest is not
     * valid is a read failure: reported, and left out, while the others load.
     * A change to what loads (or to the failures) replaces the service (the
     * old one is closed, its plugins unloaded), and the new one starts with an
     * empty result cache, because the cache key does not hold the bundles. A
     * read that fails or times out throws, and the host stays stale.
     */
    const refresh = async (): Promise<void> => {
      const at = changes;
      counts.configReads += 1;
      sets.clear();
      vaultDocuments.clear();
      validated.clear();
      const enabled = parseIds(await read(enabledPath));
      // Nothing is named: nothing loads (never "every enabled plugin").
      const ids = named === null ? [] : [...new Set(enabled)].filter((id) => named.has(id));
      unknown = named === null ? [] : [...named].filter((id) => !enabled.includes(id));
      const ready: Array<{ id: string; manifest: PluginManifest; source: string }> = [];
      const failures: PluginFailure[] = [];
      const digest = createHash("sha256");
      if (dom !== null) {
        for (const id of ids) {
          if (!isFolderName(id)) {
            failures.push({ id, reason: `${JSON.stringify(id)} is not a plugin folder name` });
            continue;
          }
          const dir = `${OBSIDIAN_CONFIG_DIR}/plugins/${id}`;
          const [manifestPath, sourcePath] = bundlePathsOf(id) as [string, string];
          const manifestText = await read(manifestPath);
          const source = await read(sourcePath);
          // The baseline the period's check compares `data.json` against.
          await readEntry(dataPathOf(id));
          let reason: string | null = null;
          let manifest: PluginManifest | null = null;
          if (manifestText === null) reason = `${id} has no manifest.json`;
          else if (source === null) reason = `${id} has no main.js`;
          else {
            try {
              manifest = { ...parseManifest(manifestText, id), dir };
            } catch (error) {
              reason = error instanceof Error ? error.message : String(error);
            }
          }
          if (manifest === null || source === null || manifestText === null) {
            failures.push({ id, reason: reason ?? `${id} could not be read` });
            digest.update(`failed\n${id}\n${reason ?? ""}\n`);
            continue;
          }
          ready.push({ id, manifest, source });
          digest.update(`${id}\n${String(manifestText.length)}\n${manifestText}\n${String(source.length)}\n`).update(source);
        }
      }
      candidates = ids;
      readFailures = failures;
      const next = ready.length === 0 && failures.length === 0 ? null : digest.digest("hex");
      if (next !== bundleDigest) {
        if (bundleDigest !== null) counts.bundleChanges += 1;
        const old = service;
        service = null;
        bundleDigest = null;
        if (old !== null) await old.close();
        if (ready.length > 0 && dom !== null) {
          service = createApplyService({
            app: assembly.app,
            loader,
            queue: assembly.queue,
            document: dom.document as unknown as ServiceDocument,
            clock,
            bundles: ready.map(({ id, manifest, source }) => ({
              manifest,
              request: {
                pluginId: id,
                filename: join(config.vaultRoot, OBSIDIAN_CONFIG_DIR, "plugins", id, "main.js"),
                source,
                hostModulePaths: modulePaths,
              },
            })),
            vaultDocuments,
            ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
            ...(options.cacheLimit === undefined ? {} : { cacheLimit: options.cacheLimit }),
          });
        }
        bundleDigest = next;
      }
      readThrough = at;
      readAt = Date.now();
    };

    /**
     * The period's check, when no event said anything changed: read the files
     * again and compare their revisions with the ones kept. Nothing changed:
     * nothing is dropped or rebuilt. A bundle or the enabled state changed: a
     * full refresh. Otherwise only `data.json`'s cache, or only the sets, go.
     */
    const revalidate = async (): Promise<void> => {
      counts.configChecks += 1;
      const dataPaths = new Set(candidates.filter(isFolderName).map(dataPathOf));
      const bundle = new Set([enabledPath, ...candidates.filter(isFolderName).flatMap(bundlePathsOf)]);
      const paths = new Set([...validated.keys(), ...bundle, ...dataPaths]);
      const before = new Map(validated);
      const changed: string[] = [];
      for (const path of paths) {
        const entry = await readEntry(path);
        const revision = entry?.revision ?? null;
        if (revision !== (before.has(path) ? before.get(path) : undefined)) {
          changed.push(path);
          validated.set(path, revision);
        }
      }
      if (changed.some((path) => bundle.has(path))) {
        await refresh();
        return;
      }
      if (changed.some((path) => dataPaths.has(path))) vaultDocuments.clear();
      if (changed.some((path) => !dataPaths.has(path))) sets.clear();
      readAt = Date.now();
    };
    undo.push(async () => {
      stopped = true;
      await chain.catch(() => undefined);
      await service?.close();
    });

    /** The set for an effective theme and snippet choice, built once and kept until the config changes. */
    const setFor = async (appearance: NonNullable<ScreenApplyRequest["appearance"]>): Promise<readonly Sheet[]> => {
      const override = {
        ...(appearance.theme === undefined ? {} : { theme: appearance.theme }),
        ...(appearance.snippets === undefined ? {} : { snippets: appearance.snippets }),
      };
      const key = JSON.stringify([override.theme ?? null, override.snippets ?? null]);
      const held = sets.get(key);
      if (held !== undefined) {
        sets.delete(key);
        sets.set(key, held);
        return held;
      }
      const { sheets } = await buildSheetSet(read, override);
      sets.set(key, sheets);
      while (sets.size > SHEET_SET_CACHE_LIMIT) {
        const oldest = sets.keys().next().value;
        if (oldest === undefined) break;
        sets.delete(oldest);
      }
      return sheets;
    };

    // Requests run one at a time here too, so a refresh never replaces the
    // service under an apply.
    let chain: Promise<unknown> = Promise.resolve();
    const applyNow = async (request: ScreenApplyRequest): Promise<ApplyResult> => {
      checkScreenRequest(request);
      if (stopped) throw new Error("the screen host is stopped");
      let sheets: readonly Sheet[] | null = null;
      try {
        if (readThrough !== changes) await refresh();
        else if (revalidateMs > 0 && Date.now() - readAt >= revalidateMs) await revalidate();
        if (service === null) return EMPTY_RESULT;
        if (request.sheets === undefined) sheets = await setFor(request.appearance ?? {});
      } catch (error) {
        // A read that failed or timed out: the next request reads everything again.
        if (!(error instanceof TypeError)) markStale();
        throw error;
      }
      if (sheets === null) {
        for (const sheet of request.sheets ?? []) counts.sheetBytes += Buffer.byteLength(String(sheet?.text ?? ""), "utf8");
        sheets = request.sheets ?? [];
      }
      return service.apply({ viewer: request.viewer, mode: request.mode, sheets } satisfies ApplyRequest);
    };
    const apply = (request: ScreenApplyRequest): Promise<ApplyResult> => {
      const run = chain.then(() => applyNow(request));
      chain = run.catch(() => undefined);
      return run;
    };
    // The first read happens now, so the ready line names the plugins.
    await refresh();

    const loadedPlugins = (): readonly string[] => service?.plugins() ?? [];
    const failedPlugins = (): readonly PluginFailure[] => {
      const byId = new Map([...readFailures, ...(service?.failed() ?? [])].map((failure) => [failure.id, failure]));
      return candidates.flatMap((id) => {
        const failure = byId.get(id);
        return failure === undefined ? [] : [failure];
      });
    };

    const stats = (): ScreenStats => ({
      ...(service?.stats() ?? { loads: 0, unloads: 0, hits: 0, misses: 0, size: 0 }),
      vaultd_requests: vaultdRequests,
      sheet_bytes_received: counts.sheetBytes,
      config_events: counts.configEvents,
      config_reads: counts.configReads,
      config_checks: counts.configChecks,
      bundle_changes: counts.bundleChanges,
      plugins: [...loadedPlugins()],
      failed: failedPlugins().map((failure) => ({ ...failure })),
      unknown: [...unknown],
      read_only: readOnly,
      writes_refused: writes?.refusals ?? 0,
    });

    const server = new ScreenServer({
      socketPath: config.socketPath,
      dataDir: config.dataDir,
      clock: config.clock,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      maxPreAuthConnections: config.maxPreAuthConnections,
      lineCapBytes: SCREEN_LINE_CAP_BYTES,
      hello: () => ({
        protocol_version: 1,
        profile: "screen",
        vault_root: config.vaultRoot,
        plugins: [...loadedPlugins()],
        failed: failedPlugins().map((failure) => ({ ...failure })),
        unknown: [...unknown],
        read_only: readOnly,
      }),
      dispatch: async (method, params) => {
        switch (method) {
          case "screen.apply": {
            try {
              const result = await apply(params as ScreenApplyRequest);
              return {
                classes: [...result.classes],
                styles: result.styles.map((style) => ({ id: style.id, text: style.text })),
              };
            } catch (error) {
              if (error instanceof TypeError) throw new ScreenError("invalid_request", error.message);
              throw error;
            }
          }
          case "screen.stats":
            return stats();
          default:
            throw new ScreenError("invalid_request", `the screen host has no method ${JSON.stringify(method)}`);
        }
      },
    });
    undo.push(() => server.close());
    const socketPath = options.listen === false ? config.socketPath : await server.listen();

    return {
      config,
      socketPath,
      get plugins() {
        return loadedPlugins();
      },
      get failed() {
        return failedPlugins();
      },
      get unknown() {
        return unknown;
      },
      writes,
      get service() {
        return service;
      },
      apply,
      stats,
      client: clientOf,
      stop: unwind,
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}

/** Refuse a request of the wrong shape before it reaches the plugin (a `TypeError`, so `invalid_request`). */
function checkScreenRequest(request: ScreenApplyRequest): void {
  if (typeof request !== "object" || request === null) throw new TypeError("an apply request must be an object");
  if (request.sheets === undefined) {
    const appearance = request.appearance;
    if (typeof appearance !== "object" || appearance === null || Array.isArray(appearance)) {
      throw new TypeError("an apply request needs sheets or an appearance object");
    }
  }
}

/** The plugin's manifest, parsed and checked before it replaces anything. */
function parseManifest(text: string, id: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`the manifest of ${id} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`the manifest of ${id} is not an object`);
  const manifest = value as Record<string, unknown>;
  if (manifest["id"] !== id) throw new Error(`the manifest of ${id} names the id ${JSON.stringify(manifest["id"])}`);
  return manifest as unknown as PluginManifest;
}

/** One folder entry: not empty, no slash, not `.` or `..`. A plugin id is read as a folder under `plugins/`. */
function isFolderName(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0");
}

function parseIds(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
