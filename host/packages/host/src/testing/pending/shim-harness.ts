/**
 * A whole shim over a hydrated mirror: the harness Tasks 7–13 drive.
 *
 * **Not yet activated.** Written for `src/testing/shim-harness.ts`, with its
 * imports spelled for that home, and moved there by Task 7's Step 1 together
 * with `assemble.ts`:
 *
 * ```
 * git mv src/testing/pending/assemble.ts src/testing/assemble.ts
 * git mv src/testing/pending/shim-harness.ts src/testing/shim-harness.ts
 * ```
 *
 * Everything below is a method some later task calls. They are enumerated here,
 * with bodies, so a divergence between what a task calls and what the harness
 * offers is a compile error at activation rather than a surprise in the middle
 * of writing that task's tests.
 */

import { assembleShim } from "./assemble";
import { FixtureVault } from "./fixture-vault";
import { MirrorHarness } from "./mirror-harness";
import type { HostConfig } from "../config";
import type { MirrorChangeBatch } from "../mirror/types";
import type { App } from "../shim/app";
import type { ObsidianApi } from "../shim/api";
import type { AppliedBatch, Vault } from "../shim/vault";
import type { Harvest, HarvestedMenuItem } from "../shim/harvest";
import type { NoticeLog } from "../shim/notice";
import type { Plugin, PluginManifest } from "../shim/plugin";
import type { PolicyRecorder } from "../shim/policy";
import type { WriteGate } from "../dryrun/dry-run";
import type { FixtureEntry } from "./mirror-harness";

export interface ShimHarnessOptions {
  /** Default `true`: most tests want a shim that has finished starting. */
  layoutReady?: boolean;
  /** Default `true`: warm the position index, so offsets answer. */
  warm?: boolean;
  /** Served through `read_file`, for the config zone the host reads. */
  configFiles?: Record<string, string>;
  config?: Partial<HostConfig>;
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
  readonly api!: ObsidianApi;
  readonly harvest!: Harvest;
  readonly policyRecorder!: PolicyRecorder;
  readonly noticeLog!: NoticeLog;
  readonly writes!: WriteGate;
  /** The specifiers a plugin bundle may resolve to the host's own modules. */
  readonly hostModulePaths: readonly string[] = ["obsidian", "electron", "@electron/remote"];

  private readonly configFiles = new Map<string, string>();
  private readonly sources = new Map<string, string>();
  private readonly plugins = new Map<string, Plugin>();
  private layoutReady: boolean;

  protected constructor(options: ShimHarnessOptions) {
    super(options.config ?? {});
    this.layoutReady = options.layoutReady ?? true;
    for (const [path, contents] of Object.entries(options.configFiles ?? {})) {
      this.configFiles.set(path, contents);
    }
  }

  /** Wire the shim around the hydrated mirror. Called once, by a factory. */
  private assemble(): void {
    const assembly = assembleShim({
      config: this.config,
      client: this.client,
      mirror: this.mirror,
      clock: this.clock,
    });
    const mutable = this as {
      -readonly [K in "app" | "vault" | "api" | "harvest" | "policyRecorder" | "noticeLog" | "writes"]: ShimHarness[K];
    };
    mutable.app = assembly.app;
    mutable.vault = assembly.app.vault;
    mutable.api = assembly.api;
    mutable.harvest = assembly.harvest;
    mutable.policyRecorder = assembly.policyRecorder;
    mutable.noticeLog = assembly.noticeLog;
    mutable.writes = assembly.writes;
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
    for (const [path, source] of Object.entries(sources)) harness.sources.set(path, source);
    harness.autoServeFiles({ ...sources, ...Object.fromEntries(harness.configFiles) });
    await harness.openMirror(spec);
    harness.assemble();
    if (options.warm ?? true) await harness.mirror.warmPositions();
    if (harness.layoutReady) await harness.flipLayoutReady();
    return harness;
  }

  /** Replace a config-zone file's contents; the next `read_file` serves it. */
  setConfigFile(path: string, contents: string): void {
    this.configFiles.set(path, contents);
    this.autoServeFiles({ [path]: contents });
  }

  manifestFor(id: string): PluginManifest {
    return {
      id,
      name: id,
      version: "0.0.1",
      minAppVersion: "1.0.0",
      author: "the harness",
      description: `${id}, instantiated by ShimHarness`,
    };
  }

  /** Construct a plugin against this shim's `App`, without loading it. */
  instantiate<T extends Plugin>(id: string, ctor: new (app: App, m: PluginManifest) => T): T {
    const plugin = new ctor(this.app, this.manifestFor(id));
    this.plugins.set(id, plugin);
    return plugin;
  }

  /** Load one plugin, with every registration it makes attributed to it. */
  async load(plugin: Plugin): Promise<void> {
    this.plugins.set(plugin.manifest.id, plugin);
    await plugin.load();
  }

  async unload(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (plugin === undefined) throw new Error(`${id} was never loaded on this harness`);
    await plugin.unload();
    this.plugins.delete(id);
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

  /** Change what a `read_file` for `path` answers, without touching the mirror. */
  setFileContent(path: string, content: string): void {
    this.sources.set(path, content);
    this.autoServeFiles({ [path]: content });
  }

  revisionOf(path: string): string {
    const revision = this.mirror.entry(path)?.revision;
    if (revision === null || revision === undefined) {
      throw new Error(`${path} has no revision in this mirror`);
    }
    return revision;
  }

  /** Drive a plugin-visible write all the way through the gate and the daemon. */
  async writeNote(path: string, content: string): Promise<void> {
    const writing = this.vault.adapter.write(path, content);
    const request = await this.expectRequest("write_file");
    const generation = this.mirror.generation() + 1;
    const revision = `blake3:written-${String(generation)}`;
    this.respondOk(request.id, "write_file", { generation, revision, path });
    this.setFileContent(path, content);
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
  emitBatch(batch: {
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
    return this.vault.applyBatch(change, { sizes: batch.sizes ?? {} });
  }

  /**
   * Answer the read and the write one `vault.process()` issues, in that order.
   *
   * `process` is read-modify-write with a precondition, so a test that answered
   * only the read would hang on the write and a test that answered them out of
   * order would deadlock. One helper, one order, in one place.
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
    const writing = await this.expectRequest("write_file");
    this.respondOk(writing.id, "write_file", { generation, revision: newRevision, path });
    await this.quiesce();
  }

  /** Every menu item the loaded plugins contribute for `path`, in order. */
  async listMenuItems(
    context: "file-menu" | "editor-menu",
    path: string,
  ): Promise<HarvestedMenuItem[]> {
    const items = await this.harvest.menuItems(context, path);
    return [...items];
  }

  async invokeMenuItem(itemId: string, path: string): Promise<void> {
    await this.harvest.invokeMenuItem(itemId, path);
    await this.quiesce();
  }

  async invokeProtocol(action: string, params: Record<string, string>): Promise<void> {
    await this.api.protocolHandlers.invoke(action, params);
    await this.quiesce();
  }

  /** Every path a plugin asked the workspace to open, in order. */
  openFileIntents(): readonly string[] {
    return this.app.workspace.openFileIntents();
  }

  /**
   * How many plugin-registered timers are armed.
   *
   * Not the {@link TestClock}'s count: plugin-facing timers deliberately use
   * the real globals — a plugin observing a frozen clock is a plugin observing
   * a lie — and are cleaned up by the component registry instead. This counts
   * those, which is what an unload-leak test is actually asking about.
   */
  activeTimerCount(): number {
    return this.api.components.activeTimerCount();
  }

  override async stop(): Promise<void> {
    for (const id of [...this.plugins.keys()]) await this.unload(id);
    await super.stop();
  }
}
