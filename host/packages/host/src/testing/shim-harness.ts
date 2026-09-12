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

import { assembleShim } from "./assemble";
import { FixtureVault } from "./fixture-vault";
import { MirrorHarness } from "./mirror-harness";
import type { HostConfig } from "../config";
import type { MirrorChangeBatch } from "../mirror/types";
import type { App } from "../shim/app";
import type { AppliedBatch } from "../shim/files";
import type { PolicyRecorder } from "../shim/policy";
import type { Vault, WriteGate } from "../shim/vault";
import type { FixtureEntry } from "./mirror-harness";
// activated by Task 10: import type { Plugin, PluginManifest } from "../shim/plugin";
// activated by Task 10: import type { Harvest, HarvestedMenuItem } from "../shim/harvest";
// activated by Task 10: import type { ObsidianApi } from "../shim/api";
// activated by Task 11b: import type { NoticeLog } from "../shim/notice";

export interface ShimHarnessOptions {
  /** Default `true`: most tests want a shim that has finished starting. */
  layoutReady?: boolean;
  /** Default `true`, and ignored by a fixture with no note sources to read. */
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
  readonly policyRecorder!: PolicyRecorder;
  readonly writes!: WriteGate;
  // activated by Task 10:  readonly api!: ObsidianApi;
  //   Task 10's own cases write `class extends harness.api.Plugin`, so the
  //   barrel `shim/api.ts` (Task 11b) has to be reachable by then — which is
  //   why this says 10 and not 11b: it is the task that first calls it.
  // activated by Task 10:  readonly harvest!: Harvest;
  // activated by Task 11b: readonly noticeLog!: NoticeLog;
  /** The specifiers a plugin bundle may resolve to the host's own modules. */
  readonly hostModulePaths: readonly string[] = ["obsidian", "electron", "@electron/remote"];

  private readonly configFiles = new Map<string, string>();
  private readonly sources = new Map<string, string>();
  /** The paths the auto-server answers. Everything else is answered by hand. */
  private readonly autoServed = new Set<string>();
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
      -readonly [K in "app" | "vault" | "policyRecorder" | "writes"]: ShimHarness[K];
    };
    mutable.app = assembly.app;
    mutable.vault = assembly.app.vault;
    mutable.policyRecorder = assembly.policyRecorder;
    mutable.writes = assembly.writes;
    // activated by Task 10:  mutable.api = assembly.api;
    // activated by Task 10:  mutable.harvest = assembly.harvest;
    // activated by Task 11b: mutable.noticeLog = assembly.noticeLog;
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
    harness.assemble();
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

  // activated by Task 10: manifestFor / instantiate / load / unload — every one
  // of them names `Plugin` or `PluginManifest` from `../shim/plugin`, which
  // that task creates.

  /**
   * Fire `layout-ready`, once.
   *
   * A plugin that registers a `layout-ready` handler after the event has fired
   * must still be called — Obsidian's `onLayoutReady` runs the callback
   * immediately in that case — so this flips a latch rather than only firing.
   */
  async flipLayoutReady(): Promise<void> {
    this.layoutReady = true;
    // activated by Task 11a: this.app.workspace.markLayoutReady();
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

  // activated by Task 10:  listMenuItems / invokeMenuItem — both go through
  // `Harvest`, which that task creates.
  // activated by Task 10:  invokeProtocol — `ObsidianApi.protocolHandlers`.
  // activated by Task 11a: openFileIntents — it reads state that exists only
  // once Task 11a builds `WorkspaceLeaf.openFile`.
  // activated by Task 10:  activeTimerCount — `ObsidianApi.components`. It
  // counts plugin-registered timers, which deliberately use the real globals
  // rather than the `TestClock`, and are cleaned up by the component registry.
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

/** The two files `Vault.getConfig` reads, host directory first. */
function configFilePathsFor(harness: ShimHarness): string[] {
  return [`${harness.config.configDirName}/app.json`, ".obsidian/app.json"];
}
