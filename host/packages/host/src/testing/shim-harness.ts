/**
 * A whole shim over a hydrated mirror: the harness Tasks 7–13 drive.
 *
 * **Activated by Task 7**, together with `assemble.ts`, and reconciled against
 * the surfaces that task actually built. The methods Task 7's own tests drive
 * — `withEntries`, `withVault`, `app`, `vault`, `setFileContent`, `revisionOf`,
 * `writeNote`, `emitBatch`, `settleProcess`, `flipLayoutReady` — are real. The
 * rest were written against modules that do not exist yet (`shim/plugin.ts` and
 * `shim/harvest.ts` in Task 10, `shim/notice.ts` and `shim/api.ts` in Task 11b)
 * and are commented out below, each with the task that restores it. They are
 * left in place rather than deleted so that the divergence between what a later
 * task calls and what this harness offers stays visible.
 *
 * Two behaviours are worth knowing before writing a case against it:
 *
 * - **A fixture's own files are served automatically; anything else is
 *   answered by hand.** `withVault` hands its sources to the auto-server, so a
 *   `read_file` for one of them never reaches the request queue. A path the
 *   fixture never had — `setFileContent` on an entries-only harness, say —
 *   stays manual, which is what lets a `process` case answer the read and the
 *   write in order and assert what each one carried.
 * - **An entries-only harness does not warm positions.** Warming reads every
 *   note's source, and an `entries` fixture has none to read, so a warm-up
 *   there would issue reads nothing can answer.
 */

import { join, resolve } from "node:path";

import { assembleShim } from "./assemble";
import { FixtureVault } from "./fixture-vault";
import { BundleLoader } from "../runtime/loader";
import { MirrorHarness, noteDto } from "./mirror-harness";
import { REFETCH_FACETS } from "../mirror/mirror";
import { fs } from "../runtime/fs-access";
import { socketPathFor } from "../config";
import type { HostConfig } from "../config";
import type { MirrorChangeBatch } from "../mirror/types";
import type { App } from "../shim/app";
import type { AppliedBatch } from "../shim/files";
import type { PolicyRecorder } from "../shim/policy";
import type { Vault, WriteGate } from "../shim/vault";
import type { FixtureEntry, FixtureNote } from "./mirror-harness";
import type { HostAssembly } from "./assemble";
import type { Plugin, PluginManifest } from "../shim/plugin";
import type { Harvest, HarvestedMenuItem, MenuContext } from "../shim/harvest";
import type { BundleLoaderDeps } from "../runtime/loader";
import type { HostErrorEntry } from "../shim/errors";
import type { ShimEventBus } from "../shim/events";
import type { ObsidianApi } from "../shim/api";
import type { NoticeLog } from "../shim/notice";
import type { HostWindow } from "../shim/globals";
import type { StubDocument } from "../shim/dom";
import type { DomEnvironment, DomProvider } from "../shim/dom-provider";

export interface ShimHarnessOptions {
  /**
   * Where this harness's host may write its own state.
   *
   * **Defaults to a fresh directory under the repository's `target/tmp`**, and
   * that default is a safety rail rather than a convenience: the host persists
   * `localStorage` through `DataDir`, and `HostConfig.dataDir` is
   * `$XDG_STATE_HOME/vaultd-host` — so a harness that took the config's value
   * would write into the developer's home directory the first time a case
   * called `setItem`, and two test files would share one document with no
   * isolation between them. Fresh per harness, so no two cases can see each
   * other's stored values either.
   *
   * `test/shim-dom.test.ts` holds the guard that fails if this ever resolves
   * under the real state directory.
   */
  dataDir?: string;
  /** Default `true`: most tests want a shim that has finished starting. */
  layoutReady?: boolean;
  /** Default `true`, and ignored by a fixture with no note sources to read. */
  warm?: boolean;
  /** Served through `read_file`, for the config zone the host reads. */
  configFiles?: Record<string, string>;
  config?: Partial<HostConfig>;
  /**
   * What goes behind `document`. Omitted, it is the inert stub, as in the
   * headless host; a real-DOM provider gives a screen host's document instead,
   * reachable as {@link ShimHarness.serverDom}.
   */
  dom?: DomProvider;
}

export class ShimHarness extends MirrorHarness {
  /**
   * Assigned by {@link assemble}, which runs after the hydration handshake.
   *
   * Definite-assignment rather than constructor-assigned, and it has to be: a
   * shim is assembled around a `Mirror`, a `Mirror` does not exist until its
   * hydration has been answered, and answering it means awaiting — which a
   * constructor cannot do. Every static factory below assembles before it hands
   * the harness back, so no test ever sees one of these undefined.
   */
  readonly app!: App;
  readonly vault!: Vault;
  readonly policyRecorder!: PolicyRecorder;
  readonly writes!: WriteGate;
  /**
   * The `obsidian` module a plugin resolves.
   *
   * Task 10's own cases write `class extends harness.api.Plugin`, so the barrel
   * `shim/api.ts` had to be reachable by then — which is why it is created
   * there and only filled in by Task 11b.
   */
  readonly api!: ObsidianApi;
  readonly harvest!: Harvest;
  /**
   * Every failure the host had nobody to hand back to, in order.
   *
   * Collected rather than merely available: a harness that registered no
   * listener would send each one to the process's error stream, so a case about
   * a throwing `onunload` would pass while printing a stack trace. Assert on
   * this instead — and assert on it, rather than on the absence of a throw,
   * because "swallowed" and "reported" look identical from outside.
   */
  readonly hostErrors: HostErrorEntry[] = [];
  /**
   * Every notice this host's plugins raised.
   *
   * Read by cases that assert what a command told the user, and by Task 19's:
   * the log records outside dry-run too, so "the notice was raised" is a fact a
   * case can assert in the mode it actually runs in.
   */
  readonly noticeLog!: NoticeLog;
  /**
   * The `window` and `document` this host installed.
   *
   * Reachable here rather than off the barrel, because Obsidian's module
   * exports neither: they are globals, they are declared in the policy table's
   * `GLOBAL_ONLY_SYMBOLS` list, and a test that wants *this host's* pair should
   * ask the host for it rather than a module that would be lying to offer it.
   */
  readonly window!: HostWindow;
  /**
   * The real document and its constructors, when this harness was built with a
   * DOM provider; `null` for the stub.
   */
  readonly serverDom: DomEnvironment | null = null;
  private stubDocument: StubDocument | null = null;

  /**
   * The stub document. **Refused on a server-DOM harness** rather than typed as
   * a union: every existing case reaches stub-only members such as `on`, and a
   * server-DOM case should be reading {@link serverDom} instead.
   */
  get document(): StubDocument {
    if (this.stubDocument === null) {
      throw new Error("this harness runs a server DOM; read harness.serverDom.document instead");
    }
    return this.stubDocument;
  }
  /**
   * Where the host's own modules live — **directories**, prepended to a
   * bundle's `module.paths`.
   *
   * Corrected in Task 13, which is the first task to use them. They held
   * *specifiers* (`["obsidian", "electron", …]`), which nothing could have
   * consumed: `module.paths` is a list of `node_modules` directories Node walks,
   * and Node resolves `obsidian` by looking for a directory of that name inside
   * one of them. `host/node_modules` is a real directory holding real workspace
   * links to `packages/obsidian` and `packages/electron`, so one entry is the
   * whole answer and a bundle materialised anywhere on disk finds both.
   */
  readonly hostModulePaths: readonly string[] = [
    resolve(__dirname, "..", "..", "..", "..", "node_modules"),
  ];

  /**
   * The whole assembly, kept because a plugin's lifecycle needs two pieces of
   * it that no shim surface exposes: the {@link DispatchQueue} every entry
   * point runs through, and the event bus whose attribution window makes a
   * registration the plugin's own.
   */
  protected assembly!: HostAssembly;
  /** The plugins this harness has instantiated, by id. */
  private readonly plugins = new Map<string, Plugin>();
  /**
   * The real loader, doing the real lifecycle.
   *
   * Task 13 moved `register`/`onload`/`onunload`/`deregister` out of this
   * harness and into {@link BundleLoader}, which is what `app.plugins` and Task
   * 14's plugin set both use. The harness keeps only what is harness-shaped —
   * the instantiation bookkeeping below and the `quiesce()` either side — so
   * that a test drives the same lifecycle production does rather than a
   * test-only arrangement that happens to work.
   */
  private loader!: BundleLoader;
  /** What `electron.shell` asked the OS to open. See {@link spawns}. */
  private readonly spawned: Array<[string, string[]]> = [];
  private readonly configFiles = new Map<string, string>();
  private readonly sources = new Map<string, string>();
  /** The fixture rows behind `get_note`, by path. See {@link serveNotes}. */
  private readonly noteRows = new Map<string, FixtureNote>();
  /** The paths the auto-server answers. Everything else is answered by hand. */
  private readonly autoServed = new Set<string>();
  private layoutReady: boolean;
  private readonly dom: DomProvider | undefined;

  protected constructor(options: ShimHarnessOptions) {
    // The data dir goes in **first**, so an explicit `config.dataDir` from a
    // case still wins: the spread that follows overwrites it. The socket path
    // is re-derived from it rather than left as `defaultHostConfig` computed
    // it, because that one names the real state directory — and a harness that
    // moved its data dir but kept a socket path in the user's home directory
    // has only moved half of itself.
    super(configFor(options));
    this.layoutReady = options.layoutReady ?? true;
    this.dom = options.dom;
    for (const [path, contents] of Object.entries(options.configFiles ?? {})) {
      this.configFiles.set(path, contents);
    }
  }

  /**
   * Wire the shim around the hydrated mirror. Called once, by a factory.
   *
   * `protected` rather than private because Task 14's `PluginSetHarness` is a
   * second subclass with its own start sequence: it needs an empty mirror and
   * a started coexistence monitor, which {@link ShimHarness.start} does not
   * offer, and a harness that assembled a *second* shim of its own instead
   * would be testing a wiring production never runs.
   */
  protected assemble(): void {
    const assembly = assembleShim({
      config: this.config,
      // A supplier, like production's: this harness's client never changes, so
      // the indirection buys it nothing — but taking the same signature is what
      // makes the harness exercise the wiring production runs rather than a
      // second one that happens to work.
      client: () => this.client,
      mirror: this.mirror,
      clock: this.clock,
      dataDir: this.config.dataDir,
      // **Never the real opener.** `assembleShim`'s default is `osSpawn`, which
      // really launches the platform's `open` — the same hazard class as a
      // harness persisting `localStorage` into the developer's home directory.
      // No test needs a window to appear on someone's screen, and a fixture
      // that reached for one would otherwise do it silently. Recorded instead,
      // readable through {@link spawns}. `test/module-intercept.test.ts` holds
      // the guard that fails if this is ever the real one.
      spawn: (command, args) => {
        this.spawned.push([command, [...args]]);
        return Promise.resolve();
      },
      ...(this.dom === undefined ? {} : { dom: this.dom }),
    });
    const mutable = this as {
      -readonly [K in
        | "app"
        | "vault"
        | "policyRecorder"
        | "writes"
        | "api"
        | "harvest"
        | "noticeLog"
        | "window"
        | "serverDom"]: ShimHarness[K];
    };
    this.assembly = assembly;
    this.loader = new BundleLoader(this.loaderDeps());
    // Installed, so `app.plugins.enablePlugin`/`disablePlugin` reach the same
    // lifecycle `harness.load()` drives rather than a second, inert one. With
    // no `provide` an `enable` for an unknown id still records and answers
    // exactly as the loader-less stub did, so nothing a case asserts changes —
    // what changes is that a harness now has **one** plugin lifecycle in it.
    // Task 14's plugin set installs its own loader the same way.
    assembly.app.plugins.setLoader(this.loader);
    mutable.app = assembly.app;
    mutable.vault = assembly.app.vault;
    mutable.policyRecorder = assembly.policyRecorder;
    mutable.writes = assembly.writes;
    mutable.api = assembly.api;
    mutable.harvest = assembly.harvest;
    assembly.errors.onError((error, pluginId, phase) => {
      this.hostErrors.push({ error, pluginId, phase });
    });
    mutable.noticeLog = assembly.noticeLog;
    mutable.window = assembly.globals.window;
    if (assembly.globals.dom === null) this.stubDocument = assembly.globals.document;
    else mutable.serverDom = assembly.globals.dom;
  }

  /** A shim over a tree with no note bodies — the cheapest useful fixture. */
  static async withEntries(
    entries: FixtureEntry[],
    options: ShimHarnessOptions = {},
  ): Promise<ShimHarness> {
    const notes = entries
      .filter((entry) => entry.kind === "note")
      .map((entry) => ({ path: entry.path, revision: entry.revision ?? `blake3:${entry.path}` }));
    return ShimHarness.start({ generation: 1, entries, notes }, {}, options);
  }

  /**
   * A shim over real markdown, parsed by the real parser.
   *
   * This is the honest fixture: the rows the mirror holds are the rows a real
   * hydration of this vault would hold, because the same parser produced them.
   */
  static async withVault(
    files: Record<string, string>,
    options: ShimHarnessOptions = {},
  ): Promise<ShimHarness> {
    const vault = new FixtureVault(files);
    return ShimHarness.start(
      { generation: 1, entries: vault.entries(), notes: vault.notes() },
      vault.files,
      options,
    );
  }

  private static async start(
    spec: { generation: number; entries: FixtureEntry[]; notes: ReturnType<FixtureVault["notes"]> },
    sources: Readonly<Record<string, string>>,
    options: ShimHarnessOptions,
  ): Promise<ShimHarness> {
    const harness = new ShimHarness(options);
    for (const [path, source] of Object.entries(sources)) {
      harness.sources.set(path, source);
      harness.autoServed.add(path);
    }
    for (const note of spec.notes) harness.noteRows.set(note.path, note);
    for (const path of harness.configFiles.keys()) harness.autoServed.add(path);
    harness.autoServeFiles({ ...sources, ...Object.fromEntries(harness.configFiles) });
    // The `Vault` constructor primes `getConfig` from two files. A fixture that
    // supplies neither must still *answer* both, or the prime's reads would sit
    // in the request queue and the next `nextRequest()` — which a case expects
    // to be its own write — would hand out a `read_file` instead. `not_found`
    // is what the daemon says about a vault with no settings file, so that is
    // what an unsupplied config path says here.
    for (const path of configFilePathsFor(harness)) {
      if (!harness.configFiles.has(path)) harness.unserveFile(path);
    }
    await harness.openMirror(spec);
    harness.serveNotes();
    harness.assemble();
    // Both config readers prime themselves in their constructors, and both are
    // read **synchronously** by the cases that follow — `vault.getConfig(key)`
    // and `internalPlugins.getPluginById(id)`. Awaiting the primes here is what
    // makes "the first synchronous call answers" true rather than a race
    // against the fixture server.
    await harness.vault.configReady();
    await harness.app.internalPlugins.ready();
    // A fixture with no note sources has nothing to warm from: every read the
    // warm-up issued would sit unanswered, and the harness would never start.
    if ((options.warm ?? true) && Object.keys(sources).length > 0) {
      await harness.mirror.warmPositions();
    }
    if (harness.layoutReady) await harness.flipLayoutReady();
    return harness;
  }

  /** Replace a config-zone file's contents; the next `read_file` serves it. */
  setConfigFile(path: string, contents: string): void {
    this.configFiles.set(path, contents);
    this.autoServed.add(path);
    this.autoServeFiles({ [path]: contents });
  }

  /**
   * The one event bus every shim surface shares.
   *
   * Exposed so a case can count listeners — the only way to tell a plugin that
   * detached its own registrations from one the harness detached for it.
   */
  get bus(): ShimEventBus {
    return this.assembly.events;
  }

  /**
   * The four things a {@link BundleLoader} needs from an assembled host.
   *
   * Exposed so a test can build its own loader — with a `provide` of its own,
   * to drive `app.plugins.enablePlugin` — against the same host this harness is
   * driving, rather than against a second assembly.
   */
  loaderDeps(): BundleLoaderDeps {
    return {
      app: this.assembly.app,
      queue: this.assembly.queue,
      events: this.assembly.events,
      harvest: this.assembly.harvest,
      errors: this.assembly.errors,
    };
  }

  /**
   * Every OS-opener call this host's `electron.shell` would have made.
   *
   * `[command, args]` per call, in order. The harness never runs them — see the
   * `spawn` it passes {@link assembleShim} — so a case asserts on this instead
   * of on a window that opened on somebody's screen.
   */
  spawns(): ReadonlyArray<readonly [string, readonly string[]]> {
    return this.spawned.map(([command, args]) => [command, [...args]] as const);
  }

  /** A manifest for a plugin that has no `manifest.json`, as most cases do. */
  manifestFor(id: string): PluginManifest {
    return {
      id,
      name: id,
      version: "0.0.0",
      minAppVersion: "1.0.0",
      description: `the ${id} fixture plugin`,
      author: "vaultd host tests",
      isDesktopOnly: false,
      dir: `${this.config.configDirName}/plugins/${id}`,
    };
  }

  /**
   * Build one plugin, exactly as the real loader will: `new ctor(app, manifest)`.
   *
   * It also declares the plugin's `data.json` **absent**, unless a case
   * supplied one through `configFiles`. A plugin with no saved data is the
   * ordinary case, `not_found` is what the daemon says about it, and a path
   * nothing answers would otherwise sit in the request queue — so the first
   * `loadData()` would hang instead of answering `null`.
   */
  instantiate<T extends Plugin>(
    id: string,
    ctor: new (app: App, manifest: PluginManifest) => T,
  ): T {
    const dataPath = `${this.config.configDirName}/plugins/${id}/data.json`;
    if (!this.configFiles.has(dataPath)) this.unserveFile(dataPath);
    const plugin = new ctor(this.app, this.manifestFor(id));
    this.plugins.set(id, plugin);
    return plugin;
  }

  /**
   * Drive one plugin's `onload` the way the host will.
   *
   * Through the {@link DispatchQueue}, so `currentPluginId()` answers for the
   * whole of it and every policy hit is attributed; and inside the bus's
   * attribution window, so every listener the plugin registers is owned by it
   * and can be dropped again on unload.
   */
  async load(plugin: Plugin): Promise<void> {
    this.plugins.set(plugin.manifest.id, plugin);
    // Registration-before-`onload` and the attribution window are the loader's,
    // not this harness's — see {@link loader}.
    await this.loader.load(plugin);
    await this.quiesce();
  }

  /**
   * Unload one plugin, completely.
   *
   * Three steps, and a quarantine needs all three: `onunload` plus the
   * component teardown (the plugin's own), every listener it registered
   * (`detachOwner`), and its whole harvest. A plugin that kept either of the
   * last two could still be invoked, or still be woken by a vault change, after
   * the host had decided it was gone.
   *
   * Unloading a plugin this harness never instantiated is a no-op rather than a
   * throw. A plugin it **has** instantiated is kept in the map and unloaded
   * again on a second call, deliberately: the idempotence that matters lives in
   * `Component.unload`, and a harness that short-circuited here would hide a
   * host that had lost it.
   */
  async unload(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (plugin === undefined) return;
    // A plugin this harness only `instantiate`d never reached the loader, so it
    // is handed over here rather than looked up there.
    this.loader.track(plugin);
    await this.loader.unload(id);
    await this.quiesce();
  }

  /**
   * Fire `layout-ready`, once.
   *
   * A plugin that registers a `layout-ready` handler after the event has fired
   * must still be called — Obsidian's `onLayoutReady` runs the callback
   * immediately in that case — so this flips a latch rather than only firing.
   */
  async flipLayoutReady(): Promise<void> {
    this.layoutReady = true;
    this.app.workspace.markLayoutReady();
    await this.quiesce();
  }

  /**
   * Change what a `read_file` for `path` answers, without touching the mirror.
   *
   * A path the fixture supplied stays auto-served and simply answers the new
   * bytes. A path it did not — an entries-only harness has no sources at all —
   * is recorded here and answered by the case, which is what lets a `process`
   * case see the read request itself.
   */
  setFileContent(path: string, content: string): void {
    this.sources.set(path, content);
    if (this.autoServed.has(path)) this.autoServeFiles({ [path]: content });
  }

  /** What a case last said `path` contains, or `undefined` if it never said. */
  fileContent(path: string): string | undefined {
    return this.sources.get(path);
  }

  revisionOf(path: string): string {
    const revision = this.mirror.entry(path)?.revision;
    if (revision === null || revision === undefined) {
      throw new Error(`${path} has no revision in this mirror`);
    }
    return revision;
  }

  /**
   * Drive a plugin-visible write all the way through the gate and the daemon.
   *
   * Three steps, because a shim write is three: the op the adapter sends, the
   * answer, and the refetch `applyMutation` issues to make the mirror
   * read-your-writes consistent. A helper that answered only the first would
   * hand back a promise that never settles.
   *
   * The op is **`write_note`**, because the daemon refuses `write_file` for a
   * Markdown note and this helper writes notes. A harness that answered the
   * shape the daemon rejects would teach every later task to send it.
   */
  async writeNote(path: string, content: string): Promise<void> {
    const writing = this.vault.adapter.write(path, content);
    const request = await this.expectRequest("write_note");
    const generation = this.mirror.generation() + 1;
    const revision = `blake3:written-${String(generation)}`;
    this.respondOk(request.id, "write_note", { generation, revision });
    this.setFileContent(path, content);
    // The refetch asks for the ancestors too — a folder's `mtime` moves when a
    // child is rewritten — and a path answered by nothing is answered as
    // absent, which would delete the containing folder and everything under it.
    await this.answerRefetch(generation, [{ path, revision }], {
      entries: ancestorFoldersOf(path),
    });
    await writing;
  }

  /**
   * Push one change batch through the shim as though the mirror had applied it.
   *
   * Resolves with the {@link AppliedBatch} the file index produced, which is
   * how a test asserts that a delete/create pair was recognised as a rename —
   * the wire has no rename, so the pairing is the shim's own work and has to be
   * observable to be tested.
   */
  async emitBatch(batch: {
    generation: number;
    created?: string[];
    modified?: string[];
    deleted?: string[];
    revisions?: Record<string, string>;
    sizes?: Record<string, number>;
  }): Promise<AppliedBatch> {
    const change: MirrorChangeBatch = {
      generation: batch.generation,
      created: batch.created ?? [],
      modified: batch.modified ?? [],
      deleted: batch.deleted ?? [],
      revisions: batch.revisions ?? {},
      cause: null,
      synthetic: false,
    };
    const applied = this.vault.applyBatch(change, { sizes: batch.sizes ?? {} });
    await this.quiesce();
    return applied;
  }

  /**
   * Answer the read, the write, and the refetch one `vault.process()` issues,
   * in that order.
   *
   * `process` is read-modify-write with a precondition and a read-your-writes
   * refetch behind it, so a test that answered only the read would hang on the
   * write and one that stopped at the write would hang on the refetch. One
   * helper, one order, in one place.
   */
  async settleProcess(
    path: string,
    read: string,
    readRevision: string,
    generation: number,
    newRevision: string,
  ): Promise<void> {
    const reading = await this.expectRequest("read_file");
    this.respondReadFile(reading.id, read, readRevision);
    const writing = await this.expectRequest("write_note");
    this.respondOk(writing.id, "write_note", { generation, revision: newRevision });
    await this.answerRefetch(generation, [{ path, revision: newRevision }]);
    await this.quiesce();
  }

  /**
   * Build every plugin's menu for `path` and report the items.
   *
   * The menu is built from scratch on every call, which is the whole point: a
   * plugin's item text and its `onClick` both close over the file, so a listing
   * kept from an earlier call would describe a different file's menu.
   */
  async listMenuItems(context: MenuContext, path: string): Promise<readonly HarvestedMenuItem[]> {
    const subject = this.menuSubject(context, path);
    return await this.assembly.queue.run(null, `menu:${context}:${path}`, () =>
      this.harvest.listMenuItems(context, subject),
    );
  }

  /**
   * Pick one harvested menu item, as a chooser outside the process would.
   *
   * The menu is rebuilt for this call rather than reused from the listing, so
   * the handler that runs is the one bound to *this* file.
   */
  async invokeMenuItem(id: string, path: string): Promise<void> {
    const context = menuContextOf(id);
    const found = this.harvest.menuItemFor(id, this.menuSubject(context, path));
    if (found === null) throw new Error(`no harvested menu item ${id}`);
    await this.assembly.queue.run(found.pluginId, `menu-item:${id}`, () => found.item.invoke());
    await this.quiesce();
  }

  /**
   * Deliver an `obsidian://` action to the plugin that registered it.
   *
   * `{ action, ...params }` is the shape Obsidian hands a protocol handler —
   * the action is in the params — and plugins read it.
   */
  async invokeProtocol(action: string, params: Record<string, string> = {}): Promise<void> {
    const found = this.harvest.protocolHandlerFor(action);
    if (found === null) throw new Error(`no harvested protocol handler for ${action}`);
    await this.assembly.queue.run(found.pluginId, `protocol:${action}`, () =>
      found.handler({ action, ...params }),
    );
    await this.quiesce();
  }

  /**
   * Every path a plugin asked to have opened, in order.
   *
   * The only observable consequence of an `openFile` on a host with no window:
   * the leaf records the intent and opens nothing, so this is what a case
   * asserts on instead of asserting that nothing happened.
   */
  openFileIntents(): readonly string[] {
    return this.app.workspace.openFileIntents();
  }

  /**
   * How many plugin-facing timers are armed.
   *
   * Every timer in this host — the host's own and the ones a plugin arms
   * through `window.setInterval` — goes through the injected clock, so a leaked
   * interval is a number a case can assert on rather than a process that will
   * not exit.
   */
  activeTimerCount(): number {
    return this.clock.armed();
  }

  /**
   * What a menu handler is called with after the menu itself.
   *
   * `file-menu` gets `(file, source)`, which is Obsidian's own shape and which
   * plugins branch on — a plugin that only adds its item for the file explorer
   * would add nothing at all if the source were omitted. `editor-menu` gets
   * `(editor, view)`, and this host has neither yet: Task 11a supplies the real
   * pair, and until then the view carries the file so a handler that only reads
   * `view.file` still works.
   */
  /**
   * Answer the `get_note` an `Editor.open` issues, and only that one.
   *
   * **The `include` field is what separates the two callers**, and the
   * separation is the daemon's own shape rather than a convention invented
   * here: the mirror's refetch always asks for `include: ["sections",
   * "list_items"]` (`REFETCH_FACETS`, the only two optional facets there are),
   * and an editor read asks for neither. So a `get_note` with no `include` is
   * an editor's, and is served from the fixture's own row plus the source this
   * harness currently holds; one **with** `include` is a refetch's and is left
   * for `answerRefetch` to answer, which is what lets a case assert the
   * read/write/refetch order of a real flush.
   */
  private serveNotes(): void {
    this.serve((request) => {
      if (request.request.method !== "get_note") return false;
      const params = request.request.params as { path?: string; include?: unknown };
      if (params.include !== undefined) {
        // The separator is an invariant, so a drift in it is answered loudly
        // rather than by a hang: an `include` that is not the mirror's exact
        // refetch shape means some third caller has appeared, and leaving it to
        // `answerRefetch` would strand a request nothing answers.
        if (!sameFacets(params.include)) {
          this.respondErr(request.id, {
            code: "invalid_request",
            message:
              `a get_note carried include=${JSON.stringify(params.include)}, which is neither ` +
              `the editor's (absent) nor the mirror's refetch (${JSON.stringify(REFETCH_FACETS)}). ` +
              "The harness separates the two by that field; teach it the third caller.",
          });
          return true;
        }
        return false;
      }
      const path = params.path;
      if (path === undefined) return false;
      const fixture = this.noteRows.get(path);
      const source = this.sources.get(path);
      if (fixture === undefined || source === undefined) return false;
      this.respondOk(request.id, "get_note", {
        generation: this.mirror.generation(),
        note: { ...noteDto(fixture), source },
      });
      return true;
    });
  }

  private menuSubject(context: MenuContext, path: string): readonly unknown[] {
    const file = this.vault.getAbstractFileByPath(path);
    if (file === null) throw new Error(`${path} is not in this harness's vault`);
    if (context === "file-menu") return [file, "file-explorer-context-menu"];
    return [{ headless: true }, { file }];
  }
}

/**
 * Which menu an item id belongs to.
 *
 * An item id is `<pluginId>:<context>:<hookOrdinal>:<itemOrdinal>`, so the
 * context is the third segment from the right — read from the right because a
 * plugin id is the only part that could itself contain a colon.
 */
function menuContextOf(id: string): MenuContext {
  const segments = id.split(":");
  const context = segments[segments.length - 3];
  if (context !== "file-menu" && context !== "editor-menu") {
    throw new Error(`${id} does not name a menu item`);
  }
  return context;
}

/** Whether a `get_note`'s `include` is exactly the mirror's refetch facets. */
function sameFacets(include: unknown): boolean {
  if (!Array.isArray(include) || include.length !== REFETCH_FACETS.length) return false;
  return REFETCH_FACETS.every((facet) => include.includes(facet));
}

/** Every folder above `path`, as a fixture row. */
function ancestorFoldersOf(path: string): { path: string; kind: "folder" }[] {
  const folders: { path: string; kind: "folder" }[] = [];
  let cut = path.lastIndexOf("/");
  while (cut !== -1) {
    folders.push({ path: path.slice(0, cut), kind: "folder" });
    cut = path.lastIndexOf("/", cut - 1);
  }
  return folders;
}

/**
 * A directory no other harness has, under the repository's own `target/tmp`.
 *
 * Inside the worktree on purpose: a test suite that writes outside the tree it
 * was checked out into is the one class of defect a suite must not have, and
 * `target/` is where this repository already puts build scratch, so a `cargo
 * clean` sweeps these with everything else.
 *
 * `mkdtemp` rather than a counter, because test files run in separate forked
 * processes: a name built from a counter would collide the moment two forks
 * reached the same case number, and the collision would be two harnesses
 * sharing one stored document — exactly the isolation this exists to give.
 * The call goes through the fs seam like every other file-system call under
 * `src/`, so the write guard can see it.
 */
function freshDataDir(): string {
  const root = resolve(__dirname, "..", "..", "..", "..", "..", "target", "tmp");
  fs.mkdirSync(root, { recursive: true });
  // Once per process, before this process adds one of its own.
  if (!swept) {
    swept = true;
    sweepStaleDataDirs(root, SCRATCH_PREFIXES);
  }
  return fs.mkdtempSync(join(root, PREFIX));
}

/** Every config override a harness makes on its own behalf. */
function configFor(options: ShimHarnessOptions): Partial<HostConfig> {
  const dataDir = options.dataDir ?? freshDataDir();
  const vaultRoot = options.config?.vaultRoot ?? "/vault";
  return {
    dataDir,
    socketPath: socketPathFor(dataDir, vaultRoot),
    // **No test run may reach the network.** Production defaults to `true`;
    // every harness turns it off, so a real community bundle loaded by a case —
    // which is what the golden corpus is — cannot phone home even if its
    // `onload` tries. A case that wants the forwarding path passes
    // `config: { allowNetwork: true }` deliberately, and then owns the
    // consequence. The spread below is what lets it.
    allowNetwork: false,
    // **No harness spawns a watchdog thread.** Production defaults to 30 s and
    // the assembler builds one whenever this is positive; a suite that spawned
    // a worker thread per assembled host would pay for a component none of its
    // cases are about, and would have a thread to account for in every file.
    // `test/watchdog.test.ts` builds its own directly, and a case that wants the
    // assembled one passes a threshold deliberately — the spread below is what
    // lets it.
    watchdogThresholdMs: 0,
    ...(options.config ?? {}),
  };
}

/** The name every harness data dir starts with, and the sweep matches on. */
const PREFIX = "host-state-";

/**
 * Every scratch family this suite leaves under `target/tmp`, swept together.
 *
 * Task 22's harness-hygiene carry: the directory had collected 2,985 entries
 * across this phase because each family was swept only by the harness that
 * made it, and two of them (`vaultd-guard-`, `vaultd-other-`, from an earlier
 * spelling of the fs-guard fixtures) were made by code that no longer exists
 * and so were never swept at all. One list, swept once per process, on the same
 * six-hour floor — nothing a live run owns can be caught, and nothing a dead
 * run left behind survives the next day's first test.
 *
 * `LiveHost` is deliberately not on this list *as its only cleanup*: it removes
 * its own vault and state directory in `stop()`, which is the per-run cleanup
 * the carry asked for. Its prefixes are here so a run killed mid-case is still
 * collected.
 */
export const SCRATCH_PREFIXES: readonly string[] = [
  PREFIX,
  "host-sock-",
  "vaultd-guard-",
  "vaultd-other-",
  "live-",
  "hs-",
];
/** Old enough that nothing a live run made can be caught by the sweep. */
const STALE_MS = 6 * 60 * 60 * 1000;
/** One sweep per process, at the first harness. */
let swept = false;

/**
 * Remove the data dirs earlier runs left behind. **Exported for its own test.**
 *
 * A fresh directory per harness means a full suite leaves several hundred of
 * them, almost all empty — nothing is written unless a case touches
 * `localStorage` — and nothing else would ever collect them. The age bound is
 * what makes this safe against the runner's own parallelism: test files run in
 * separate forked processes that sweep independently, and every directory a
 * live process owns is seconds old, so a six-hour floor cannot reach one.
 *
 * Failures are swallowed on purpose. Two forks sweeping the same stale
 * directory at the same time is the ordinary case, not an error, and a harness
 * that could not tidy up must still start.
 *
 * `prefix` is a parameter since Task 16a, which leaves a second family behind:
 * a host harness also makes a short-named socket directory, for Darwin's
 * ~104-byte socket address limit, and it needs the same collection on the same
 * terms rather than a second sweep written slightly differently.
 */
export function sweepStaleDataDirs(root: string, prefix: string | readonly string[] = PREFIX): void {
  const prefixes = typeof prefix === "string" ? [prefix] : prefix;
  const cutoff = Date.now() - STALE_MS;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!prefixes.some((candidate) => name.startsWith(candidate))) continue;
      const full = join(root, name);
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // Another fork got there first, or the entry went away underneath us.
      }
    }
  } catch {
    // No directory to sweep, or it is not readable. Neither stops a harness.
  }
}

/**
 * Every config-zone path this host's readers ask for at startup, host directory
 * first.
 *
 * `Vault.getConfig` primes from `app.json`; Task 12's `InternalPluginRegistry`
 * primes from three more. A path a fixture did not supply has to be answered
 * `not_found` rather than left unanswered, or the prime's read would sit in the
 * request queue and the next `nextRequest()` — which a case expects to be its
 * own write — would hand out a `read_file` instead.
 */
export function configFilePathsFor(harness: ShimHarness): string[] {
  const names = ["app.json", "core-plugins.json", "daily-notes.json", "bookmarks.json"];
  return names.flatMap((name) => [`${harness.config.configDirName}/${name}`, `.obsidian/${name}`]);
}
