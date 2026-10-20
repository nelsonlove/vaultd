/**
 * **The screen host**: the second host profile (docs/design/web-plugins.md,
 * section 2, "Where the server apply runs"; owner decision 1).
 *
 * Its own process beside the web server, never inside the headless host: the
 * headless host keeps its inert stub document on purpose. This one assembles
 * the same shim with happy-dom behind `document`, connects to `vaultd` the way
 * the headless host does, and loads **only the screen plugins** — today Style
 * Settings, and only when the vault's own `.obsidian/community-plugins.json`
 * enables it. It reads the vault's `.obsidian` (the GUI's directory) and never
 * writes there: the plugin's saves go to the `viewer` store, outside the vault.
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
 * the screen plugin's bundle and enabled state, each stylesheet set it built,
 * and the vault's `data.json`. A `config_changed` from vaultd for a path that
 * can change the output (see {@link affectsScreen}), or any `resync_required`,
 * marks all of it stale, and the next request reads it again; a changed bundle
 * or enabled state replaces the apply service (and with it the result cache).
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
import { APPLY_DEADLINE_MS, createApplyService } from "./apply-service";
import { happyDomProvider } from "../shim/dom-providers/happy-dom";
import { installModuleInterception } from "../runtime/intercept";
import { drivenClock } from "../runtime/driven-clock";
import { VaultDocumentCache } from "../shim/viewer-data-store";
import { buildSheetSet } from "../web/sheet-set";
import { isKnownRuntimeEvent } from "../client/protocol";
import type { ApplyRequest, ApplyResult, ApplyService, Mode, Sheet } from "./apply-service";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";
import type { ReadFileResponse, RuntimeEventDto } from "../client/protocol";
import type { ServiceDocument } from "./apply-service";
import type { VaultdClient } from "../client/client";

/** The plugins this profile runs. Everything else in the vault is the headless host's. */
export const SCREEN_PLUGIN_IDS: readonly string[] = ["obsidian-style-settings"];

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
  /** Times the screen plugin's bundle or enabled state changed and the service was replaced. */
  readonly bundle_changes: number;
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
  /** The screen plugins that are loaded-on-demand, by id. Empty when none is enabled. As last read. */
  readonly plugins: readonly string[];
  /** The apply service, or `null` when no screen plugin is enabled. As last read. */
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
    const mirror = await Mirror.open(clientOf, config);
    undo.push(() => {
      mirror.stop();
    });

    const clock = drivenClock(Date.now());
    const assembly = assembleShim({ config, client: countedClient, mirror, clock, dom: happyDomProvider() });
    undo.push(() => assembly.teardown());
    const modulePaths = [resolve(__dirname, "..", "..", "..", "..", "node_modules")];
    const interception = installModuleInterception({
      hostModulePaths: modulePaths,
      allowNodeBuiltins: true,
      harvest: assembly.harvest,
    });
    undo.push(() => {
      interception.restore();
    });
    const loader = new BundleLoader({
      app: assembly.app,
      queue: assembly.queue,
      events: assembly.events,
      harvest: assembly.harvest,
      errors: assembly.errors,
    });
    assembly.app.plugins.setLoader(loader);

    const readTimeoutMs = options.readTimeoutMs ?? CONFIG_READ_TIMEOUT_MS;
    /** The revision of every `.obsidian` file the host read, `null` for one that was not there. */
    const revisions = new Map<string, string | null>();
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
        revisions.set(path, entry?.revision ?? null);
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
    let plugins: readonly string[] = [];
    /** A digest of the plugin id, manifest and bundle in use, or `null` for none. */
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
      void mirror.applyEvent(event).catch(() => undefined);
      if (!isKnownRuntimeEvent(event)) return;
      if (event.type === "config_changed" && affectsScreen(event.value.path)) {
        counts.configEvents += 1;
        markStale();
      } else if (event.type === "resync_required") {
        markStale();
      }
    });

    const dataPathOf = (id: string): string => `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/data.json`;
    const bundlePaths = (id: string): string[] => [
      `${OBSIDIAN_CONFIG_DIR}/community-plugins.json`,
      `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/manifest.json`,
      `${OBSIDIAN_CONFIG_DIR}/plugins/${id}/main.js`,
    ];

    /**
     * Read everything again (after an event, a failure, or at start). Sets and
     * `data.json` are dropped. The plugin's enabled state and bundle are read,
     * and a new manifest is parsed and checked **before** the old service is
     * touched; a change replaces the service (the old one is closed, its plugin
     * unloaded), and the new one starts with an empty result cache, because
     * the cache key does not hold the bundle.
     */
    const refresh = async (): Promise<void> => {
      const at = changes;
      counts.configReads += 1;
      sets.clear();
      vaultDocuments.clear();
      revisions.clear();
      const enabled = parseIds(await read(`${OBSIDIAN_CONFIG_DIR}/community-plugins.json`));
      const id = SCREEN_PLUGIN_IDS.find((candidate) => enabled.includes(candidate)) ?? null;
      let next: { id: string; manifest: PluginManifest; source: string; digest: string } | null = null;
      if (id !== null && dom !== null) {
        const dir = `${OBSIDIAN_CONFIG_DIR}/plugins/${id}`;
        const manifestText = await read(`${dir}/manifest.json`);
        const source = await read(`${dir}/main.js`);
        // The baseline the period's check compares `data.json` against.
        await readEntry(dataPathOf(id));
        if (manifestText !== null && source !== null) {
          const digest = createHash("sha256").update(`${id}\n${String(manifestText.length)}\n${manifestText}\n`).update(source).digest("hex");
          next = { id, manifest: { ...parseManifest(manifestText, id), dir }, source, digest };
        }
      }
      if ((next?.digest ?? null) !== bundleDigest) {
        if (bundleDigest !== null) counts.bundleChanges += 1;
        const old = service;
        service = null;
        plugins = [];
        bundleDigest = null;
        if (old !== null) await old.close();
        if (next !== null && dom !== null) {
          service = createApplyService({
            app: assembly.app,
            loader,
            queue: assembly.queue,
            document: dom.document as unknown as ServiceDocument,
            clock,
            bundle: {
              manifest: next.manifest,
              request: {
                pluginId: next.id,
                filename: join(config.vaultRoot, OBSIDIAN_CONFIG_DIR, "plugins", next.id, "main.js"),
                source: next.source,
                hostModulePaths: modulePaths,
              },
            },
            vaultDocuments,
            ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
            ...(options.cacheLimit === undefined ? {} : { cacheLimit: options.cacheLimit }),
          });
          plugins = [next.id];
          bundleDigest = next.digest;
        }
      }
      readThrough = at;
      readAt = Date.now();
    };

    /**
     * The period's check, when no event said anything changed: read the files
     * again and compare their revisions with the ones kept. Nothing changed:
     * nothing is dropped or rebuilt. The bundle or enabled state changed: a
     * full refresh. Otherwise only `data.json`'s cache, or only the sets, go.
     */
    const revalidate = async (): Promise<void> => {
      counts.configChecks += 1;
      const id = plugins[0] ?? null;
      const paths = new Set(revisions.keys());
      paths.add(`${OBSIDIAN_CONFIG_DIR}/community-plugins.json`);
      if (id !== null) paths.add(dataPathOf(id));
      const before = new Map(revisions);
      const changed: string[] = [];
      for (const path of paths) {
        const entry = await readEntry(path);
        if ((entry?.revision ?? null) !== (before.has(path) ? before.get(path) : undefined)) changed.push(path);
      }
      const bundle = new Set(bundlePaths(id ?? SCREEN_PLUGIN_IDS[0] ?? ""));
      if (changed.some((path) => bundle.has(path))) {
        await refresh();
        return;
      }
      if (id !== null && changed.includes(dataPathOf(id))) vaultDocuments.clear();
      if (changed.some((path) => id === null || path !== dataPathOf(id))) sets.clear();
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
        if (service === null) return { classes: [], style: "" };
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

    const stats = (): ScreenStats => ({
      ...(service?.stats() ?? { loads: 0, unloads: 0, hits: 0, misses: 0, size: 0 }),
      vaultd_requests: vaultdRequests,
      sheet_bytes_received: counts.sheetBytes,
      config_events: counts.configEvents,
      config_reads: counts.configReads,
      config_checks: counts.configChecks,
      bundle_changes: counts.bundleChanges,
    });

    const server = new ScreenServer({
      socketPath: config.socketPath,
      dataDir: config.dataDir,
      clock: config.clock,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      maxPreAuthConnections: config.maxPreAuthConnections,
      lineCapBytes: SCREEN_LINE_CAP_BYTES,
      hello: () => ({ protocol_version: 1, profile: "screen", vault_root: config.vaultRoot, plugins: [...plugins] }),
      dispatch: async (method, params) => {
        switch (method) {
          case "screen.apply": {
            try {
              const result = await apply(params as ScreenApplyRequest);
              return { classes: [...result.classes], style: result.style };
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
        return plugins;
      },
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

function parseIds(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
