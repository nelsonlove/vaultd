/**
 * The screen host's one job: apply a screen plugin for a viewer and say what it
 * did to the page (docs/design/web-plugins.md, section 2 option C and task 6).
 *
 * **Apply.** `{ viewer, mode, sheets }` → `{ classes, style }`. The sheets go
 * into `document.head` as `<style>` elements in the order given (Obsidian's
 * order, built by `web/sheet-set.ts`), `body` gets `theme-light` or
 * `theme-dark`, the plugin's data store is the viewer's, `css-change` is raised
 * and the plugin's 100 ms debounce is driven on the host's own clock (never a
 * real wait). The answer is the `body` classes the plugin set and the text of
 * its `<style id="css-settings-manager">`.
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
 * entry, and a vault `data.json` change gives a new revision by itself. An
 * apply can save (the load-time prune, E4), which changes the revision; the
 * result is cached under the revision before the apply and the one after it,
 * so the next identical request is a hit.
 */

import { createHash } from "node:crypto";

import { ViewerDataStore } from "../shim/viewer-data-store";
import { installPluginHost, pluginHostFor } from "../shim/plugin";
import { sheetSetHash } from "../web/sheet-set";
import { stub } from "../shim/policy";
import type { App } from "../shim/app";
import type { BundleLoader, BundleSource } from "../runtime/loader";
import type { DispatchQueue } from "../runtime/queue";
import type { Mode, Sheet } from "../web/sheet-set";
import type { PluginDataStore } from "../shim/plugin-data-store";

export type { Mode, Sheet } from "../web/sheet-set";

/** How many applies the cache keeps by default. */
export const APPLY_CACHE_LIMIT = 64;

/** One clock step: past the plugin's 100 ms debounce, as the parity harness steps. */
export const DEBOUNCE_STEP_MS = 150;

/** The id of the `<style>` element Style Settings writes its output into. */
export const OUTPUT_STYLE_ID = "css-settings-manager";

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

export interface ApplyResult {
  /** The `body` classes the plugin set, sorted. The mode class is not among them. */
  readonly classes: readonly string[];
  /** The text of `#css-settings-manager`, or `""` when the plugin wrote none. */
  readonly style: string;
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
  /** Compile and load the plugin; `onload` runs. */
  loadPlugin(): Promise<void>;
  unloadPlugin(): Promise<void>;
  /** The viewer's data store. */
  storeFor(viewer: string): PluginDataStore;
  /** The store installed behind the plugin. */
  readonly store: SwitchableDataStore;
  readonly pluginId: string;
  readonly cacheLimit?: number;
}

interface LiveContext {
  viewer: string;
  revision: string;
  setHash: string;
}

export class ApplyService {
  private readonly cache = new Map<string, ApplyResult>();
  private readonly limit: number;
  private live: LiveContext | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private counts = { loads: 0, unloads: 0, hits: 0, misses: 0 };

  constructor(private readonly deps: ApplyServiceDeps) {
    this.limit = deps.cacheLimit ?? APPLY_CACHE_LIMIT;
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError("the apply cache limit must be a whole number of at least 1");
    }
  }

  /** Apply for one viewer. Requests run one at a time, in the order they arrive. */
  apply(request: ApplyRequest): Promise<ApplyResult> {
    try {
      checkRequest(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const run = this.chain.then(() => this.applyNow(request));
    // The chain carries on after a failed apply; the caller still sees the failure.
    this.chain = run.catch(() => undefined);
    return run;
  }

  stats(): ApplyStats {
    return { ...this.counts, size: this.cache.size };
  }

  /** Unload the plugin, if it is loaded. The cache stays. */
  async close(): Promise<void> {
    await this.chain;
    if (this.live !== null) {
      this.live = null;
      this.counts.unloads += 1;
      await this.deps.unloadPlugin();
    }
  }

  private async applyNow(request: ApplyRequest): Promise<ApplyResult> {
    const setHash = sheetSetHash(request.sheets);
    const store = this.deps.storeFor(request.viewer);
    const revision = await this.revisionOf(store);
    const key = cacheKey(setHash, request.mode, revision);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.counts.hits += 1;
      this.remember(key, cached);
      return cached;
    }
    this.counts.misses += 1;

    try {
      const live = this.live;
      if (live === null || live.viewer !== request.viewer || live.revision !== revision) {
        await this.reload(request, store, setHash);
      } else {
        if (live.setHash !== setHash) this.replaceSheets(request.sheets);
        live.setHash = setHash;
        this.setMode(request.mode);
        await this.parse();
      }
      await this.parse();
    } catch (error) {
      // A context that failed half way is not one to reuse.
      await this.dropContext();
      throw error;
    }

    const result = this.read();
    this.remember(key, result);
    const after = await this.revisionOf(store);
    if (after !== revision) this.remember(cacheKey(setHash, request.mode, after), result);
    if (this.live !== null) this.live.revision = after;
    return result;
  }

  /** A new live context: unload, clear the page, select the store, load. */
  private async reload(request: ApplyRequest, store: PluginDataStore, setHash: string): Promise<void> {
    await this.dropContext();
    this.clearPage();
    this.replaceSheets(request.sheets);
    this.setMode(request.mode);
    this.deps.store.use(store);
    this.counts.loads += 1;
    await this.deps.loadPlugin();
    this.live = { viewer: request.viewer, revision: "", setHash };
    // `onload` arms the first parse; let it run.
    await this.deps.advance(DEBOUNCE_STEP_MS);
    await this.deps.settle();
  }

  private async dropContext(): Promise<void> {
    if (this.live === null) return;
    this.live = null;
    this.counts.unloads += 1;
    await this.deps.unloadPlugin();
  }

  /** `css-change`, then past the debounce. */
  private async parse(): Promise<void> {
    this.deps.raiseCssChange();
    await this.deps.advance(DEBOUNCE_STEP_MS);
    await this.deps.settle();
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

  private read(): ApplyResult {
    const { document } = this.deps;
    const modeClasses = new Set<string>(MODE_CLASSES);
    const classes = [...document.body.classList].filter((name) => !modeClasses.has(name)).sort();
    const style = document.getElementById(OUTPUT_STYLE_ID)?.textContent ?? "";
    return Object.freeze({ classes: Object.freeze(classes), style });
  }

  private async revisionOf(store: PluginDataStore): Promise<string> {
    const data = await store.load(this.deps.pluginId);
    return createHash("sha256").update(canonicalJson(data)).digest("hex");
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
  /** The screen plugin's bundle and manifest. */
  readonly bundle: BundleSource;
  /** The viewer store's state root. Default `viewerStateRoot()`. */
  readonly stateRoot?: string;
  /** The vault's own config directory. Default `.obsidian`. */
  readonly vaultConfigDirName?: string;
  readonly cacheLimit?: number;
}

/**
 * Build the service over an assembled host: install the switchable store
 * behind the plugin, and load and unload through `loader`.
 */
export function createApplyService(deps: ScreenApplyDeps): ApplyService {
  const store = new SwitchableDataStore();
  const context = pluginHostFor(deps.app);
  // The plugin reads its host context when it is constructed, so the store is
  // in place before the first load.
  installPluginHost(deps.app, { ...context, dataStore: store });
  installScreenWorkspace(deps.app);
  const pluginId = deps.bundle.manifest.id;
  return new ApplyService({
    document: deps.document,
    raiseCssChange: () => {
      deps.app.workspace.trigger("css-change");
    },
    advance: (ms) => deps.clock.advance(ms),
    settle: () => settle(deps.queue),
    loadPlugin: async () => {
      await deps.loader.loadBundle(deps.bundle);
    },
    unloadPlugin: () => deps.loader.unload(pluginId),
    storeFor: (viewer) =>
      new ViewerDataStore({
        host: context,
        viewerId: viewer,
        ...(deps.stateRoot === undefined ? {} : { stateRoot: deps.stateRoot }),
        ...(deps.vaultConfigDirName === undefined ? {} : { vaultConfigDirName: deps.vaultConfigDirName }),
      }),
    store,
    pluginId,
    ...(deps.cacheLimit === undefined ? {} : { cacheLimit: deps.cacheLimit }),
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
