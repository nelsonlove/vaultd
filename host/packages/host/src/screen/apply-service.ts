/**
 * The screen host's one job: apply the screen profile's plugins for a viewer
 * and say what they did to the page (docs/design/web-plugins.md, section 2
 * option C and task 6).
 *
 * **Apply.** `{ viewer, mode, sheets }` → `{ classes, styles }`. The sheets go
 * into `document.head` as `<style>` elements in the order given (Obsidian's
 * order, built by `web/sheet-set.ts`), `body` gets `theme-light` or
 * `theme-dark`, the plugins' data store is the viewer's, `css-change` is raised
 * and the plugins' timers (a 100 ms debounce, say) are driven on the host's own
 * clock (never a real wait).
 *
 * **The answer is a diff, and names no plugin.** Just before the plugins load,
 * the service notes the page: every `<style>` in `head` it did not put there
 * itself, by id (or by position, for one with no id) and text, and the `body`
 * classes. After the apply settles it compares: the answer is the `body`
 * classes added since (sorted, the mode class left out), and every `<style>`
 * added or changed since, in document order, each with its id or `null`. The
 * service knows nothing of what any one plugin writes.
 *
 * **A plugin that fails to load is reported, not fatal.** Its `onload` (or
 * its bundle, or its constructor) throws: it is rolled back by the loader,
 * left out of this service's later loads, and listed by {@link
 * ApplyService.failed}; the others are served.
 *
 * **Two parses, always.** The output depends on the previous apply (E11): a
 * `color-gradient` whose end colour is not saved reads that colour back through
 * `getComputedStyle`, which sees the plugin's own last output. So every apply
 * parses, raises `css-change` and parses again, which is the state Obsidian
 * shows after any stylesheet change and what the capture recorded.
 *
 * **One live context (E6).** `document` and `window` are process globals, so
 * one plugin instance is live at a time, for one viewer and one data revision.
 * A request for another context unloads the plugin, clears the page, and loads
 * it again with that viewer's store. Requests run one at a time, in arrival
 * order, through one promise chain; that chain is this service's own, not the
 * host's dispatch queue, because loading a plugin enters that queue itself.
 *
 * **Cache.** Keyed by (sheet-set hash, mode, data revision), bounded LRU. The
 * data revision is a digest of the document the viewer's store loads, so it is
 * content-addressed: two viewers whose saved values come out the same share an
 * entry, and a vault `data.json` change gives a new revision by itself. With a
 * `VaultDocumentCache` (the screen host's), the vault document is the one last
 * read, re-read only after the owner empties the cache on a `config_changed`,
 * so a hit costs no vaultd round trip; the viewer's patch is read from disk. An
 * apply can save (the load-time prune, E4), which changes the revision; the
 * result is cached under the revision before the apply and the one after it,
 * so the next identical request is a hit.
 */

import { createHash } from "node:crypto";

import { ViewerDataStore } from "../shim/viewer-data-store";
import type { VaultDocumentCache } from "../shim/viewer-data-store";
import { installPluginHost, pluginHostFor } from "../shim/plugin";
import { sheetSetHash } from "../web/sheet-set";
import { declareScreenPolicy, stub } from "../shim/policy";
import { HOST_PLUGIN_ID } from "../shim/errors";
import { guardUnhandledRejections } from "../server/server";
import { systemClock } from "../config";
import type { Clock } from "../config";
import type { HostErrorPhase } from "../shim/errors";
import type { App } from "../shim/app";
import type { BundleLoader, BundleSource } from "../runtime/loader";
import type { DispatchQueue } from "../runtime/queue";
import type { Mode, Sheet } from "../web/sheet-set";
import type { PluginDataStore } from "../shim/plugin-data-store";

export type { Mode, Sheet } from "../web/sheet-set";

/** How many applies the cache keeps by default. */
export const APPLY_CACHE_LIMIT = 64;

/**
 * How long one apply may take, in real milliseconds, before it fails. Bounds a
 * vaultd that is connected but stuck: the apply fails, the next request
 * reloads the plugin, and later requests are not held behind it for ever.
 */
export const APPLY_DEADLINE_MS = 5_000;

/** One clock step: past the plugin's 100 ms debounce, as the parity harness steps. */
export const DEBOUNCE_STEP_MS = 150;

/** The attribute that marks a `<style>` element this service put in the head. */
const SHEET_ATTRIBUTE = "data-vaultd-sheet";

const MODE_CLASSES = ["theme-light", "theme-dark"] as const;

export interface ApplyRequest {
  /** The viewer whose saved values apply (`web/viewer-identity.ts`). */
  readonly viewer: string;
  readonly mode: Mode;
  /** The stylesheet set, in Obsidian's order. */
  readonly sheets: readonly Sheet[];
}

/** One `<style>` element the plugins added to `head`, or changed. */
export interface AppliedStyle {
  /** Its `id`, or `null` when it has none. */
  readonly id: string | null;
  readonly text: string;
}

export interface ApplyResult {
  /** The `body` classes the plugins added, sorted. The mode class is not among them. */
  readonly classes: readonly string[];
  /** The `<style>` elements the plugins added to `head` or changed, in document order. */
  readonly styles: readonly AppliedStyle[];
}

/** A plugin that could not be loaded, and why. */
export interface PluginFailure {
  readonly id: string;
  readonly reason: string;
}

export interface ApplyStats {
  /** Plugin loads (each one runs `onload`). */
  readonly loads: number;
  readonly unloads: number;
  readonly hits: number;
  readonly misses: number;
  /** Entries in the cache now. */
  readonly size: number;
}

/** The members of a server-DOM element this service uses. */
export interface ServiceElement {
  textContent: string | null;
  readonly id: string;
  readonly classList: Iterable<string> & {
    add(...names: string[]): void;
    remove(...names: string[]): void;
  };
  readonly firstChild: unknown;
  readonly lastChild: unknown;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild<T>(child: T): T;
  insertBefore<T>(child: T, before: unknown): T;
  removeChild<T>(child: T): T;
}

/** The members of a server document this service uses. */
export interface ServiceDocument {
  readonly head: ServiceElement;
  readonly body: ServiceElement;
  createElement(tag: string): ServiceElement;
  getElementById(id: string): ServiceElement | null;
  querySelectorAll(selector: string): Iterable<ServiceElement>;
}

/**
 * The one store installed behind the plugin, pointed at a viewer's store per
 * live context. The plugin host context takes one store for the life of the
 * host; this is it.
 */
export class SwitchableDataStore implements PluginDataStore {
  private current: PluginDataStore | null = null;

  get kind(): PluginDataStore["kind"] {
    return this.current?.kind ?? "viewer";
  }

  use(store: PluginDataStore): void {
    this.current = store;
  }

  load(pluginId: string): Promise<unknown> {
    return this.target().load(pluginId);
  }

  save(pluginId: string, data: unknown): Promise<void> {
    return this.target().save(pluginId, data);
  }

  private target(): PluginDataStore {
    if (this.current === null) throw new Error("no viewer's data store is selected");
    return this.current;
  }
}

/** What the service needs, kept narrow so it can be driven without a whole host. */
export interface ApplyServiceDeps {
  readonly document: ServiceDocument;
  /** `app.workspace.trigger("css-change")`. */
  raiseCssChange(): void;
  /** Move the host's clock forward, firing every timer due. */
  advance(ms: number): Promise<void>;
  /** Wait until the plugin's saves and every other queued task have finished. */
  settle(): Promise<void>;
  /** Compile and load one plugin; its `onload` runs. Throws when it fails to load. */
  loadPlugin(id: string): Promise<void>;
  unloadPlugin(id: string): Promise<void>;
  /** The viewer's data store. */
  storeFor(viewer: string): PluginDataStore;
  /** The store installed behind the plugin. */
  readonly store: SwitchableDataStore;
  /** The plugins to load, in load order. */
  readonly pluginIds: readonly string[];
  readonly cacheLimit?: number;
  /** Default {@link APPLY_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  /** The real clock the deadline runs on. */
  readonly timers: Pick<Clock, "setTimeout" | "clearTimeout">;
  /**
   * Hear every host error. An error reported while the plugins are running for
   * an apply fails that apply (phase `plugin-data` excepted: a data file that
   * cannot be read falls back to defaults, which is a sound answer; and phase
   * `onload`: a plugin that fails to load is left out, not a failed apply).
   */
  onHostError(listener: (error: unknown, pluginId: string, phase: HostErrorPhase) => void): () => void;
  /** Called once by {@link ApplyService.close}. */
  release?(): void;
}

/** An apply that ran but whose plugin reported a failure; nothing is cached. */
export class ApplyFailed extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(
      `the apply failed: ${causes.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; ")}`,
    );
    this.name = "ApplyFailed";
  }
}

/** Thrown inside an apply that its deadline has already abandoned. */
class Abandoned extends Error {}

interface LiveContext {
  viewer: string;
  revision: string;
  setHash: string;
  /** The plugins loaded in this context, in load order. */
  loaded: string[];
}

/** The page just before the plugins loaded: each `<style>` not the service's, by key, and the `body` classes. */
interface Baseline {
  styles: Map<string, string>;
  classes: Set<string>;
}

export class ApplyService {
  private readonly cache = new Map<string, ApplyResult>();
  private readonly limit: number;
  private live: LiveContext | null = null;
  private baseline: Baseline = { styles: new Map(), classes: new Set() };
  /** Plugins that failed to load, by id, with the reason; left out of later loads. */
  private readonly failedPlugins = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private counts = { loads: 0, unloads: 0, hits: 0, misses: 0 };
  /** Bumped by each apply and by a deadline; work holding an older token stops. */
  private generation = 0;
  /** Set when an apply was abandoned: the plugin's state is not trusted. */
  private needsReload = false;
  /** Errors reported while the plugin runs for the current apply, else `null`. */
  private failures: unknown[] | null = null;
  private closed = false;
  private readonly unlisten: () => void;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.limit = deps.cacheLimit ?? APPLY_CACHE_LIMIT;
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError("the apply cache limit must be a whole number of at least 1");
    }
    this.unlisten = deps.onHostError((error, _pluginId, phase) => {
      if (this.failures !== null && phase !== "plugin-data" && phase !== "onload") this.failures.push(error);
    });
  }

  /** Apply for one viewer. Requests run one at a time, in the order they arrive. */
  apply(request: ApplyRequest): Promise<ApplyResult> {
    try {
      checkRequest(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.closed) return Promise.reject(new Error("the apply service is closed"));
    const run = this.chain.then(() => this.withDeadline(request));
    // The chain carries on after a failed apply; the caller still sees the failure.
    this.chain = run.catch(() => undefined);
    return run;
  }

  stats(): ApplyStats {
    return { ...this.counts, size: this.cache.size };
  }

  /** The plugins that failed to load so far, in load order. */
  failed(): readonly PluginFailure[] {
    return this.deps.pluginIds.flatMap((id) => {
      const reason = this.failedPlugins.get(id);
      return reason === undefined ? [] : [{ id, reason }];
    });
  }

  /** The plugins this service loads: every one given, less those that failed. */
  plugins(): readonly string[] {
    return this.deps.pluginIds.filter((id) => !this.failedPlugins.has(id));
  }

  /** Refuse new requests, let the queued ones finish, unload the plugin. The cache stays. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.chain;
      await this.dropContext();
    } finally {
      // Whatever the unload did, the listener and the guard go.
      this.unlisten();
      this.deps.release?.();
    }
  }

  /**
   * Run one apply, but fail it at the deadline. An abandoned apply keeps
   * running until its next step, where its stale token stops it before it
   * touches the page again; the next apply reloads the plugin.
   */
  private withDeadline(request: ApplyRequest): Promise<ApplyResult> {
    this.generation += 1;
    const token = this.generation;
    const ms = this.deps.deadlineMs ?? APPLY_DEADLINE_MS;
    return new Promise<ApplyResult>((resolve, reject) => {
      const timer = this.deps.timers.setTimeout(() => {
        if (token !== this.generation) return;
        this.generation += 1;
        this.needsReload = true;
        this.failures = null;
        reject(new Error(`the apply did not finish within its deadline of ${String(ms)} ms`));
      }, ms);
      this.applyNow(request, token).then(
        (result) => {
          this.deps.timers.clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          this.deps.timers.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private check(token: number): void {
    if (token !== this.generation) throw new Abandoned("abandoned at its deadline");
  }

  private async applyNow(request: ApplyRequest, token: number): Promise<ApplyResult> {
    const setHash = sheetSetHash(request.sheets);
    const store = this.deps.storeFor(request.viewer);
    const revision = await this.revisionOf(store);
    this.check(token);
    const key = cacheKey(setHash, request.mode, revision);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.counts.hits += 1;
      this.remember(key, cached);
      return cached;
    }
    this.counts.misses += 1;

    this.failures = [];
    try {
      const live = this.live;
      if (this.needsReload || live === null || live.viewer !== request.viewer || live.revision !== revision) {
        await this.reload(request, store, setHash, token);
      } else {
        if (live.setHash !== setHash) this.replaceSheets(request.sheets);
        live.setHash = setHash;
        this.setMode(request.mode);
        await this.parse(token);
      }
      await this.parse(token);
      // A failure the plugin reported (a rejected save, a throwing handler)
      // means the page may not hold its answer: fail, and cache nothing.
      if (this.failures.length > 0) throw new ApplyFailed(this.failures);
    } catch (error) {
      // An abandoned apply leaves the page to the request after it.
      if (error instanceof Abandoned || token !== this.generation) throw error;
      this.failures = null;
      // A context that failed half way is not one to reuse.
      await this.dropContext();
      throw error;
    }
    this.failures = null;

    const result = this.read();
    this.remember(key, result);
    const after = await this.revisionOf(store);
    this.check(token);
    if (after !== revision) this.remember(cacheKey(setHash, request.mode, after), result);
    if (this.live !== null) this.live.revision = after;
    return result;
  }

  /** A new live context: unload, clear the page, select the store, load. */
  private async reload(request: ApplyRequest, store: PluginDataStore, setHash: string, token: number): Promise<void> {
    await this.dropContext();
    this.check(token);
    this.needsReload = false;
    this.clearPage();
    this.replaceSheets(request.sheets);
    this.setMode(request.mode);
    this.deps.store.use(store);
    this.baseline = this.notePage();
    this.counts.loads += 1;
    const loaded: string[] = [];
    try {
      for (const id of this.plugins()) {
        try {
          await this.deps.loadPlugin(id);
          loaded.push(id);
        } catch (error) {
          // The loader rolled it back; the others go on.
          this.failedPlugins.set(id, error instanceof Error ? describeLoadFailure(error) : String(error));
        }
        this.check(token);
      }
    } catch (error) {
      // Abandoned part way: unload what did load, so nothing is left running.
      for (const id of loaded.reverse()) await this.deps.unloadPlugin(id);
      throw error;
    }
    // Checked before `live` is set, so an abandoned apply never names the
    // live context the request after it relies on.
    this.live = { viewer: request.viewer, revision: "", setHash, loaded };
    // `onload` may arm work on a timer (a debounced parse); let it run.
    await this.deps.advance(DEBOUNCE_STEP_MS);
    await this.deps.settle();
    this.check(token);
  }

  private async dropContext(): Promise<void> {
    const live = this.live;
    if (live === null) return;
    this.live = null;
    this.counts.unloads += 1;
    const errors: unknown[] = [];
    for (const id of [...live.loaded].reverse()) {
      try {
        await this.deps.unloadPlugin(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  }

  /** `css-change`, then past the debounce. */
  private async parse(token: number): Promise<void> {
    this.deps.raiseCssChange();
    await this.deps.advance(DEBOUNCE_STEP_MS);
    await this.deps.settle();
    this.check(token);
  }

  private clearPage(): void {
    const { head, body } = this.deps.document;
    for (const element of [head, body]) {
      while (element.lastChild !== null) element.removeChild(element.lastChild);
      element.classList.remove(...[...element.classList]);
    }
  }

  /** Put the set in the head, in order, ahead of anything the plugin added. */
  private replaceSheets(sheets: readonly Sheet[]): void {
    const { document } = this.deps;
    for (const old of [...document.querySelectorAll(`style[${SHEET_ATTRIBUTE}]`)]) {
      document.head.removeChild(old);
    }
    const first = document.head.firstChild;
    for (const sheet of sheets) {
      const style = document.createElement("style");
      style.setAttribute(SHEET_ATTRIBUTE, sheet.id);
      style.textContent = sheet.text;
      document.head.insertBefore(style, first);
    }
  }

  private setMode(mode: Mode): void {
    const { classList } = this.deps.document.body;
    classList.remove(...MODE_CLASSES);
    classList.add(mode === "light" ? "theme-light" : "theme-dark");
  }

  /** Every `<style>` in `head` this service did not put there, in document order, with its key. */
  private pluginStyles(): Array<{ key: string; id: string | null; text: string }> {
    const found: Array<{ key: string; id: string | null; text: string }> = [];
    let unnamed = 0;
    for (const element of this.deps.document.querySelectorAll("head > style")) {
      if (element.getAttribute(SHEET_ATTRIBUTE) !== null) continue;
      const id = element.id === "" ? null : element.id;
      // An element with no id is known by its place among the others with none.
      const key = id === null ? `#${String((unnamed += 1))}` : `id:${id}`;
      found.push({ key, id, text: element.textContent ?? "" });
    }
    return found;
  }

  /** The page as it is before the plugins load, to compare the answer against. */
  private notePage(): Baseline {
    return {
      styles: new Map(this.pluginStyles().map((style) => [style.key, style.text])),
      classes: new Set(this.deps.document.body.classList),
    };
  }

  private read(): ApplyResult {
    const { document } = this.deps;
    const modeClasses = new Set<string>(MODE_CLASSES);
    const classes = [...document.body.classList]
      .filter((name) => !modeClasses.has(name) && !this.baseline.classes.has(name))
      .sort();
    const styles = this.pluginStyles()
      .filter((style) => this.baseline.styles.get(style.key) !== style.text)
      .map((style) => Object.freeze({ id: style.id, text: style.text }));
    return Object.freeze({ classes: Object.freeze(classes), styles: Object.freeze(styles) });
  }

  /** A digest of every loaded plugin's data as the viewer's store loads it. */
  private async revisionOf(store: PluginDataStore): Promise<string> {
    const entries: unknown[] = [];
    for (const id of this.plugins()) entries.push([id, await store.load(id)]);
    return createHash("sha256").update(canonicalJson(entries)).digest("hex");
  }

  private remember(key: string, result: ApplyResult): void {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/** What {@link createApplyService} wires together from an assembled screen host. */
export interface ScreenApplyDeps {
  readonly app: App;
  readonly loader: BundleLoader;
  readonly queue: DispatchQueue;
  readonly document: ServiceDocument;
  /** The clock the assembly's timers are on; the service moves it. */
  readonly clock: { advance(ms: number): Promise<void> };
  /** The plugins' bundles and manifests, in load order. */
  readonly bundles: readonly BundleSource[];
  /** The viewer store's state root. Default `viewerStateRoot()`. */
  readonly stateRoot?: string;
  /** The vault's own config directory. Default `.obsidian`. */
  readonly vaultConfigDirName?: string;
  readonly cacheLimit?: number;
  /** Default {@link APPLY_DEADLINE_MS}. */
  readonly applyDeadlineMs?: number;
  /**
   * Where a host error is shown: every one the host reports while this service
   * lives, inside an apply or not, a stray rejection the guard caught among
   * them. One line each. Default: standard error.
   */
  readonly log?: (line: string) => void;
  /**
   * The vault's `data.json` as last read, shared by every viewer's store, so a
   * cache hit (which reads the data revision) costs no vaultd round trip. The
   * screen host empties it on a `config_changed`. Without it, every revision
   * read goes to vaultd.
   */
  readonly vaultDocuments?: VaultDocumentCache;
  /** Wrap each viewer's store; a test uses it to make a store fail. */
  readonly wrapStore?: (store: PluginDataStore, viewer: string) => PluginDataStore;
}

/**
 * Build the service over an assembled host: install the switchable store
 * behind the plugins, and load and unload through `loader`.
 */
export function createApplyService(deps: ScreenApplyDeps): ApplyService {
  const store = new SwitchableDataStore();
  const context = pluginHostFor(deps.app);
  // The plugin reads its host context when it is constructed, so the store is
  // in place before the first load.
  installPluginHost(deps.app, { ...context, dataStore: store });
  installScreenWorkspace(deps.app);
  // **The process-level guard, for as long as this service can run a plugin.**
  // The stock plugin's load-time prune calls an async save without awaiting
  // it, so a save that rejects is an unhandled rejection, which ends a Node
  // process. The headless host's refcounted guard reports it to the host's
  // errors instead; the service then fails the apply that was running.
  const unguard = guardUnhandledRejections((reason) => {
    context.errors.report(reason, HOST_PLUGIN_ID, "event");
  });
  // The host's error ring keeps the last few for a reader that asks; nothing
  // asks in the screen host, so each one is also written out.
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const unlog = context.errors.onError((error, pluginId, phase) => {
    log(`vaultd-screen-host: ${pluginId} (${phase}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  });
  const release = (): void => {
    unlog();
    unguard();
  };
  const pluginIds = deps.bundles.map((bundle) => bundle.manifest.id);
  if (new Set(pluginIds).size !== pluginIds.length) {
    release();
    throw new Error("the screen profile names a plugin twice");
  }
  try {
    return buildService(deps, context, store, pluginIds, release);
  } catch (error) {
    release();
    throw error;
  }
}

function buildService(
  deps: ScreenApplyDeps,
  context: ReturnType<typeof pluginHostFor>,
  store: SwitchableDataStore,
  pluginIds: readonly string[],
  release: () => void,
): ApplyService {
  const bundles = new Map(deps.bundles.map((bundle) => [bundle.manifest.id, bundle]));
  return new ApplyService({
    document: deps.document,
    raiseCssChange: () => {
      deps.app.workspace.trigger("css-change");
    },
    advance: (ms) => deps.clock.advance(ms),
    settle: () => settle(deps.queue),
    loadPlugin: async (id) => {
      const bundle = bundles.get(id);
      if (bundle === undefined) throw new Error(`no bundle for ${id}`);
      await deps.loader.loadBundle(bundle);
    },
    unloadPlugin: (id) => deps.loader.unload(id),
    storeFor: (viewer) => {
      const store = new ViewerDataStore({
        host: context,
        viewerId: viewer,
        ...(deps.stateRoot === undefined ? {} : { stateRoot: deps.stateRoot }),
        ...(deps.vaultConfigDirName === undefined ? {} : { vaultConfigDirName: deps.vaultConfigDirName }),
        ...(deps.vaultDocuments === undefined ? {} : { vaultDocuments: deps.vaultDocuments }),
      });
      return deps.wrapStore === undefined ? store : deps.wrapStore(store, viewer);
    },
    store,
    pluginIds,
    timers: systemClock(),
    onHostError: (listener) => context.errors.onError(listener),
    release,
    ...(deps.cacheLimit === undefined ? {} : { cacheLimit: deps.cacheLimit }),
    ...(deps.applyDeadlineMs === undefined ? {} : { deadlineMs: deps.applyDeadlineMs }),
  });
}

/**
 * The workspace members the screen profile adds for its plugins, on this
 * host's workspace only (the headless host is not changed).
 *
 * `detachLeavesOfType`: Style Settings closes its settings view with it in
 * `onunload`, and every context switch unloads the plugin. There are no leaves
 * on a server, so it detaches nothing (a safe stub, as the design's API table
 * says for the view surface, E7).
 */
export function installScreenWorkspace(app: App): void {
  const workspace = app.workspace as unknown as Record<string, unknown>;
  if (typeof workspace["detachLeavesOfType"] === "function") return;
  Object.defineProperty(workspace, "detachLeavesOfType", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: (type: string): void => {
      void type;
      stub("Workspace.detachLeavesOfType", undefined);
    },
  });
}

declareScreenPolicy("Workspace.detachLeavesOfType", "safe_stub");

/**
 * Let a parse's saves finish: a few turns of the loop so the save is queued,
 * then the dispatch queue drained (both of its serialisations), then a few
 * more turns for what the save's answer resolves.
 */
async function settle(queue: DispatchQueue): Promise<void> {
  await turns(10);
  await queue.idle();
  await turns(10);
}

async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise<void>((done) => setImmediate(done));
}

/** One line for a plugin that failed to load: the loader's message, and its cause's when it wraps one. */
function describeLoadFailure(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && !error.message.includes(cause.message)) return `${error.message}: ${cause.message}`;
  return error.message;
}

function cacheKey(setHash: string, mode: Mode, revision: string): string {
  return `${setHash}\n${mode}\n${revision}`;
}

/** JSON with object keys sorted, so equal documents digest equally. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkRequest(request: ApplyRequest): void {
  if (typeof request !== "object" || request === null) throw new TypeError("an apply request must be an object");
  if (typeof request.viewer !== "string" || request.viewer === "") {
    throw new TypeError("an apply request needs a non-empty viewer");
  }
  if (request.mode !== "light" && request.mode !== "dark") {
    throw new TypeError('an apply request\'s mode must be "light" or "dark"');
  }
  if (
    !Array.isArray(request.sheets) ||
    !request.sheets.every(
      (sheet: unknown) =>
        typeof sheet === "object" &&
        sheet !== null &&
        typeof (sheet as Sheet).id === "string" &&
        typeof (sheet as Sheet).text === "string",
    )
  ) {
    throw new TypeError("an apply request's sheets must be an array of { id, text } strings");
  }
}
