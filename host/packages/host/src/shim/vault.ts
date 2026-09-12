/**
 * `app.vault` — Obsidian's vault API, over `vaultd`'s mutation operations.
 *
 * Two rules shape every method here.
 *
 * **Reads are synchronous and answered from the mirror.** Obsidian's `Vault` is
 * synchronous to the last accessor and no plugin will await `getFiles()`, so
 * the answer has to be in memory before it is asked for. The four methods that
 * are genuinely asynchronous in Obsidian too — `read`, `cachedRead`,
 * `readBinary`, and every mutation — are the only ones that touch the wire.
 *
 * **Every mutation goes through the {@link WriteGate}, in one shape.** Send the
 * op, then bring the mirror to the generation the daemon answered with:
 *
 * ```ts
 * const result = await this.deps.writes.send<MutationResponse>(method, params);
 * await this.deps.mirror.applyMutation(result.generation, [path]);
 * ```
 *
 * The gate is the seam Task 19's `--dry-run` intercepts at, which is why no
 * method here calls the client directly for a write, and the `applyMutation` is
 * read-your-writes: a plugin that writes and immediately reads must see its own
 * bytes, and the subscription's `generation_committed` for that write may not
 * have arrived yet.
 *
 * The wire mapping, pinned so nothing re-decides it later: `create` →
 * `write_note { expected: { absent: true } }`; `modify` → `write_note
 * { expected: { revision } }` with the mirror's current revision; `append` →
 * `process` with a concatenating callback, never an unconditional write;
 * `createFolder` → `create_folder`; `rename` on a `TFile` → `rename_note
 * { rewrite_links: true }` and on a `TFolder` → `rename_folder
 * { rewrite_links: true }`; `copy` → `copy_file { if_exists: "error" }`;
 * `trash(file, true)` → `delete_note { mode: "trash_system" }`;
 * `trash(file, false)` → `delete_note { mode: "trash_local" }`; `delete(file)`
 * → `delete_note { mode: "permanent" }` or `delete_folder
 * { mode: "permanent", recursive: true }`. Per Ruling 3 of the mutation spec
 * the shim passes the plugin's own choice through and consults `app.json`'s
 * `trashOption` never.
 */

import { basename } from "node:path";

import { VaultdError } from "../client/errors";
import { DataAdapter } from "./adapter";
import { Events } from "./events";
import { FileIndex, TFile, TFolder } from "./files";
import { stub } from "./policy";
import type { VaultdClient } from "../client/client";
import type {
  GenerationResponse,
  MutationResponse,
  ReadFileResponse,
  RenameResponse,
  WriteFileResponse,
} from "../client/protocol";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { MirrorChangeBatch } from "../mirror/types";
import type { DispatchQueue } from "../runtime/queue";
import type { AppliedBatch, ApplyBatchOptions, TAbstractFile } from "./files";
import type { EventCallback, EventRef, ShimEventBus } from "./events";

/**
 * The one seam every host write passes through.
 *
 * An interface with a single method, declared here because `Vault` is its first
 * consumer and Task 19 — which owns `src/dryrun/dry-run.ts` and the
 * `DryRunGate` that implements it — comes twelve tasks later. That task may
 * re-home the declaration; nothing else changes if it does, because every
 * consumer names the type and none of them names an implementation.
 */
export interface WriteGate {
  send<T>(method: string, params: unknown): Promise<T>;
}

export interface VaultDeps {
  mirror: Mirror;
  client: VaultdClient;
  config: HostConfig;
  events: ShimEventBus;
  writes: WriteGate;
  queue: DispatchQueue;
}

/** How many times `process` re-reads and re-runs its callback before giving up. */
const PROCESS_ATTEMPTS = 5;

/**
 * Obsidian's own config directory, which the host reads and never writes.
 *
 * The host writes into `HostConfig.configDirName` (`.obsidian-headless`) and
 * reads config host-directory-first with a fallback to here — so a fresh
 * headless config dir inherits the real settings, which is what makes rollover
 * work on day one, while an explicit override wins.
 */
const OBSIDIAN_CONFIG_DIR = ".obsidian";

/**
 * `delete` refused because the folder has something in it.
 *
 * Typed rather than a bare `Error` because it is a refusal a plugin can
 * reasonably handle — Obsidian's own `delete` refuses the same case without
 * `force` — and because a destructive operation that fails should say which
 * rule stopped it.
 */
export class FolderNotEmpty extends Error {
  readonly code = "folder_not_empty";
  readonly path: string;
  constructor(path: string) {
    super(`${path} is not empty; pass force to delete it`);
    this.name = "FolderNotEmpty";
    this.path = path;
  }
}

export class Vault extends Events {
  /** The vault-relative config directory. `.obsidian-headless`, not `.obsidian`. */
  readonly configDir: string;
  readonly adapter: DataAdapter;
  /**
   * The tree of `TFile`s and `TFolder`s.
   *
   * Public because Task 15's sequencer feeds it batches and Task 8's metadata
   * cache resolves links to the same instances a plugin holds.
   */
  readonly index: FileIndex;

  private configCache: Record<string, unknown> | null = null;
  private configLoading: Promise<void> | null = null;

  constructor(private readonly deps: VaultDeps) {
    super(deps.events);
    this.configDir = deps.config.configDirName;
    this.index = new FileIndex(deps.mirror, this);
    this.index.rebuild();
    this.adapter = new DataAdapter(deps, () => this);
    // Wired, not assumed: a GUI or a plugin writing into the config zone drops
    // the cache, and the next `getConfig` re-reads. Without this the host would
    // serve a stale `attachmentFolderPath` for the rest of the session, which
    // is exactly the silent staleness `config_changed` exists to prevent.
    // Only a path inside `.obsidian/` raises `config_changed` (Ruling W7), and
    // `.obsidian/app.json` is exactly the file the fallback arm reads — so this
    // listener is live rather than decorative. The host's own writes are caught
    // by `configWritten`, because a write this host made raises no event for it.
    deps.mirror.onConfigChanged((path) => {
      if (path.endsWith("/app.json")) this.configCache = null;
    });
    // Primed once, here, so the first synchronous `getConfig` answers. Both
    // reads are for paths a harness serves or answers `not_found` for, so this
    // never reaches a test's request queue.
    void this.loadConfig();
  }

  getName(): string {
    return basename(this.deps.config.vaultRoot);
  }

  // --- The tree -------------------------------------------------------------

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.index.get(path) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const file = this.index.get(path);
    return file instanceof TFile ? file : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const folder = this.index.get(path);
    return folder instanceof TFolder ? folder : null;
  }

  getRoot(): TFolder {
    return this.index.root();
  }

  getFiles(): TFile[] {
    return this.index.allFiles();
  }

  getMarkdownFiles(): TFile[] {
    // Lower-cased, because `Note.MD` is a note to the daemon and to the rename
    // pairing, and a vault where those three disagree is a vault with a file
    // that is a note for some purposes and not others.
    return this.index.allFiles().filter((file) => file.extension.toLowerCase() === "md");
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [this.index.root(), ...this.index.allLoaded()];
  }

  getAllFolders(includeRoot?: boolean): TFolder[] {
    const folders = this.index.allFolders();
    return includeRoot === true ? [this.index.root(), ...folders] : folders;
  }

  /**
   * Apply one mirror batch to the tree and report what it did.
   *
   * The seam between the mirror and the shim. Task 15's lifecycle sequencer
   * calls this and turns the {@link AppliedBatch} into `create` / `modify` /
   * `rename` / `delete` events; until it exists, nothing subscribes the mirror
   * to this, so a change the host did not make itself reaches the tree only
   * through a test driving this method.
   */
  applyBatch(batch: MirrorChangeBatch, options: ApplyBatchOptions = {}): AppliedBatch {
    return this.index.applyBatch(batch, options);
  }

  /**
   * Obsidian's private `getConfig`, answered from a cached `app.json`.
   *
   * **Host directory first, `.obsidian/` second.** A fresh headless config dir
   * inherits the real vault's settings — which is what makes rollover work on
   * day one — while an explicit override in the host directory wins. Task 14's
   * `HeadlessConfigDir.readConfigJson` is the same ladder for the same reason.
   *
   * The load-bearing keys are `attachmentFolderPath` (folder-notes),
   * `newFileLocation`, `newFileFolderPath`, `alwaysUpdateLinks`,
   * `useMarkdownLinks`, `trashOption` and `userIgnoreFilters`. An unknown key
   * answers `undefined`, which is the private API's own behaviour, and is
   * recorded as a `safe_stub` hit so the report shows what plugins actually ask
   * for. A key asked for before the prime has landed records nothing: the cache
   * being cold is this host's state, not a fact about the plugin.
   *
   * **Three ways the cache drops, and one gap.** A `config_changed` for an
   * `.obsidian/` write; a write this host itself makes to either file, through
   * {@link configWritten}; and an explicit re-prime. The gap is an external GUI
   * edit of the *host* directory, which raises no event — Task 14's 60 s config
   * poll is what closes it.
   */
  getConfig(key: string): unknown {
    const cache = this.configCache;
    if (cache === null) {
      void this.loadConfig();
      return undefined;
    }
    if (!(key in cache)) return stub(`Vault.getConfig(${key})`, undefined);
    return cache[key];
  }

  /** Resolve once the config cache holds an answer. Primed in the constructor. */
  async configReady(): Promise<void> {
    if (this.configCache !== null) return;
    await this.loadConfig();
  }

  /**
   * Tell the config cache that this host wrote `path`.
   *
   * The daemon raises `config_changed` for a write into `.obsidian/` — but not
   * for one into the host's own directory, and a host that wrote its own
   * `app.json` and kept serving the old one would be stale about the one file
   * it controls completely.
   */
  configWritten(path: string): void {
    if (this.configFilePaths().includes(path)) this.configCache = null;
  }

  // --- Reads ----------------------------------------------------------------

  async read(file: TFile): Promise<string> {
    const response = await this.deps.client.request<ReadFileResponse>("read_file", {
      path: file.path,
    });
    return Buffer.from(response.content_base64, "base64").toString("utf8");
  }

  /**
   * Obsidian's `cachedRead`, which here is a plain read.
   *
   * **There is no cache, and this is not an oversight.** The mirror retains no
   * note source — the `PositionIndex` exists precisely so that byte offsets can
   * be answered without keeping every note's bytes in memory — so a "cached"
   * read has nothing to read from and would have to invent a second cache with
   * a second invalidation rule. A plugin that calls this gets current bytes;
   * the contract it relies on (no write of its own in between) still holds.
   */
  cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const response = await this.deps.client.request<ReadFileResponse>("read_file", {
      path: file.path,
    });
    const bytes = Buffer.from(response.content_base64, "base64");
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  // --- Writes ---------------------------------------------------------------

  async create(path: string, data: string): Promise<TFile> {
    const result = await this.deps.writes.send<MutationResponse>("write_note", {
      path,
      content: data,
      expected: { absent: true },
    });
    await this.deps.mirror.applyMutation(result.generation, [path]);
    return this.createdFile(path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const result = await this.deps.writes.send<WriteFileResponse>("write_file", {
      path,
      content_base64: Buffer.from(data).toString("base64"),
      expected: { absent: true },
    });
    if (result.generation !== undefined) {
      await this.deps.mirror.applyMutation(result.generation, [path]);
    }
    return this.createdFile(path);
  }

  async createFolder(path: string): Promise<TFolder> {
    const result = await this.deps.writes.send<GenerationResponse>("create_folder", { path });
    // **`generation` absent is a success, not a failure.** It is absent — not
    // zero — for a folder that landed somewhere nothing scans: the config zone,
    // or any hidden folder. `docs/protocol.md` singles this case out because a
    // plugin host has to make `<configDir>/plugins/<id>/`, and Obsidian answers
    // a `TFolder` when it does. The mirror will never hold a row for it, so the
    // answer is a folder that is not in the tree.
    if (result.generation === undefined) return this.index.detachedFolder(path);
    await this.deps.mirror.applyMutation(result.generation, [path]);
    const folder = this.index.sync(path);
    if (folder instanceof TFolder) return folder;
    throw new Error(`the daemon created ${path} but the mirror has no folder row for it`);
  }

  async modify(file: TFile, data: string): Promise<void> {
    const expected = this.expectedFor(file.path);
    const result = await this.deps.writes.send<MutationResponse>("write_note", {
      path: file.path,
      content: data,
      expected,
    });
    await this.deps.mirror.applyMutation(result.generation, [file.path]);
    this.index.sync(file.path);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const result = await this.deps.writes.send<WriteFileResponse>("write_file", {
      path: file.path,
      content_base64: Buffer.from(data).toString("base64"),
      expected: this.expectedFor(file.path),
    });
    if (result.generation !== undefined) {
      await this.deps.mirror.applyMutation(result.generation, [file.path]);
    }
    this.index.sync(file.path);
  }

  /**
   * Read, transform, write — the documented client compare-and-swap loop.
   *
   * `read_file` for the current bytes and revision, run the callback, then
   * `write_note` with that revision as the precondition. A `revision_conflict`
   * means somebody else wrote between the two, so the loop **re-reads and
   * re-runs the callback against the new content** rather than retrying the
   * same result — an update computed from bytes that no longer exist is exactly
   * the lost update this is here to prevent. Five attempts, then the typed
   * error reaches the plugin.
   *
   * The whole loop holds the path's lock, so two plugins processing one note
   * interleave at the host instead of racing to a conflict at the daemon
   * (mutation-spec Ruling 2 assigns that serialization here explicitly).
   */
  process(file: TFile, fn: (data: string) => string): Promise<string> {
    return this.deps.queue.runExclusivePath(file.path, async () => {
      for (let attempt = 1; attempt <= PROCESS_ATTEMPTS; attempt += 1) {
        const read = await this.deps.client.request<ReadFileResponse>("read_file", {
          path: file.path,
        });
        const content = Buffer.from(read.content_base64, "base64").toString("utf8");
        const next = fn(content);
        try {
          const result = await this.deps.writes.send<MutationResponse>("write_note", {
            path: file.path,
            content: next,
            expected: { revision: read.revision },
          });
          await this.deps.mirror.applyMutation(result.generation, [file.path]);
          this.index.sync(file.path);
          return next;
        } catch (error) {
          const conflict = error instanceof VaultdError && error.code === "revision_conflict";
          if (!conflict || attempt === PROCESS_ATTEMPTS) throw error;
        }
      }
      // Unreachable: the last attempt either returns or rethrows.
      throw new Error(`process(${file.path}) exhausted ${String(PROCESS_ATTEMPTS)} attempts`);
    });
  }

  /**
   * Append through `process`, never through an unconditional write.
   *
   * An append that read and then wrote without a precondition would silently
   * discard anything written in between, which is the one failure mode a
   * plugin appending to a daily note cannot detect.
   */
  async append(file: TFile, data: string): Promise<void> {
    await this.process(file, (existing) => `${existing}${data}`);
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    const result = await this.deps.writes.send<MutationResponse>("copy_file", {
      from: file.path,
      to: newPath,
      if_exists: "error",
    });
    await this.deps.mirror.applyMutation(result.generation, [newPath]);
    const made = this.index.sync(newPath);
    if (made === null) {
      throw new Error(`the daemon copied ${file.path} to ${newPath} but the mirror has no row for it`);
    }
    // The daemon copied a file to a path, so the copy is the same kind of thing
    // the original was; Obsidian's own signature makes the same promise.
    return made as T;
  }

  /**
   * Rename, with links rewritten by the daemon.
   *
   * **A folder move names its whole subtree.** The wire answers one generation
   * and nothing else: every descendant lands at a new path that no part of the
   * answer mentions. Refetching only the two named paths advanced the mirror
   * past the generation that moved them, so the `generation_committed` that
   * would have described it was dropped by the staleness guard — and every file
   * in that folder was gone from this host, silently and permanently, with no
   * error and no event. So the old subtree is read out of the mirror *before*
   * the send and its destination paths are computed here. `Mirror.applyMutation`
   * expands the source folder again on its own side; this is the half that the
   * mirror cannot do, because the destination rows do not exist there yet.
   *
   * A subtree larger than `mirrorDeltaPathLimit` escalates to a resync, which
   * is the right answer for a move that big and not a failure.
   *
   * **Neither path is synchronized into the tree here.** The daemon models a
   * move as a delete plus a create, `FileIndex.applyBatch` pairs those back into
   * one rename by revision, and an index that had already moved the node would
   * leave that pairing nothing to reuse — so the batch is what moves it. Until
   * Task 15 subscribes the mirror to that batch, the tree keeps the old path
   * until something replays the batch: `applyMutation` emits it as the last
   * thing it does, inside the `await` this method holds, so a Task 15 subscriber
   * closes the window entirely rather than narrowing it.
   */
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const folder = file instanceof TFolder;
    const affected = folder
      ? this.movedPaths(file.path, newPath)
      : [file.path, newPath];
    const result = await this.deps.writes.send<RenameResponse>(
      folder ? "rename_folder" : "rename_note",
      { from: file.path, to: newPath, rewrite_links: true },
    );
    await this.deps.mirror.applyMutation(result.generation, affected);
  }

  /**
   * Permanent deletion.
   *
   * `force` is Obsidian's "delete a folder that is not empty" flag and maps onto
   * `delete_folder`'s `recursive`. It **defaults to `false`**, as Obsidian's
   * does: a plugin that calls `delete(folder)` on a folder full of notes gets a
   * typed refusal rather than a recursive wipe. It means nothing for a file.
   *
   * The emptiness test reads the mirror rather than the tree, because the tree
   * is the thing that can be behind: as with {@link rename}, the node stays in
   * the tree until a batch removes it, and until Task 15 subscribes the mirror
   * to those batches a plugin that deletes a note and immediately calls
   * `getFiles()` still sees it. `applyMutation` emits the batch inside the
   * `await` this method holds, so a Task 15 subscriber closes that window
   * rather than narrowing it — the folder case is the one that could not wait,
   * and it is closed here and in the mirror.
   */
  async delete(file: TAbstractFile, force?: boolean): Promise<void> {
    const recursive = force ?? false;
    if (file instanceof TFolder && !recursive && this.descendantsOf(file.path).length > 0) {
      throw new FolderNotEmpty(file.path);
    }
    await this.remove(file, "permanent", recursive);
  }

  /**
   * The two trashes, chosen by the plugin.
   *
   * `system` is the plugin's own decision and the shim passes it through —
   * Ruling 3 of the mutation spec — rather than overriding it with `app.json`'s
   * `trashOption`, which is the *user's* default for deletions the user makes.
   */
  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    await this.remove(file, system ? "trash_system" : "trash_local", true);
  }

  // --- Events ---------------------------------------------------------------

  override on(
    name: "create" | "modify" | "delete" | "rename",
    callback: EventCallback,
    context?: unknown,
  ): EventRef {
    return super.on(name, callback, context);
  }

  protected override prefix(): string {
    return "vault";
  }

  // --- Internals ------------------------------------------------------------

  private async remove(
    file: TAbstractFile,
    mode: "permanent" | "trash_system" | "trash_local",
    recursive: boolean,
  ): Promise<void> {
    const result =
      file instanceof TFolder
        ? await this.deps.writes.send<GenerationResponse>("delete_folder", {
            path: file.path,
            mode,
            recursive,
          })
        : await this.deps.writes.send<GenerationResponse>("delete_note", {
            path: file.path,
            mode,
          });
    if (result.generation === undefined) return;
    // The same subtree rule as `rename`: a deleted folder's descendants are
    // rows that moved and the wire names none of them. The mirror expands a
    // folder it still holds on its own side too; naming them costs nothing and
    // does not depend on the order the two sides see the removal in.
    const affected =
      file instanceof TFolder ? [file.path, ...this.descendantsOf(file.path)] : [file.path];
    await this.deps.mirror.applyMutation(result.generation, affected);
  }

  /** Every path the mirror holds under `path`, `path` itself excluded. */
  private descendantsOf(path: string): string[] {
    const prefix = `${path}/`;
    return this.deps.mirror
      .entries()
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => entry.path);
  }

  /** Both ends of a folder move, and every row under both ends. */
  private movedPaths(from: string, to: string): string[] {
    const under = this.descendantsOf(from);
    return [from, to, ...under, ...under.map((path) => `${to}${path.slice(from.length)}`)];
  }

  /** The two files `getConfig` reads, host directory first. */
  private configFilePaths(): string[] {
    return [`${this.configDir}/app.json`, `${OBSIDIAN_CONFIG_DIR}/app.json`];
  }

  /**
   * The precondition for a write to `path`: the revision the mirror holds.
   *
   * A path the mirror has no revision for — an attachment, which carries none,
   * or a path outside the index — is written unconditionally. `{ any: true }`
   * rather than an omitted field, because saying it out loud is the shape the
   * daemon documents for "I mean this to be unconditional".
   */
  private expectedFor(path: string): { revision: string } | { any: true } {
    const revision = this.deps.mirror.entry(path)?.revision;
    return revision === null || revision === undefined ? { any: true } : { revision };
  }

  private createdFile(path: string): TFile {
    const file = this.index.sync(path);
    if (file instanceof TFile) return file;
    throw new Error(`the daemon accepted a write to ${path} but the mirror has no row for it`);
  }

  /**
   * Fill the cache from the first `app.json` that answers, host directory first.
   *
   * Never rejects: a vault with no settings file is an ordinary vault, and every
   * key then answers `undefined` — which is what `getConfig` would have answered
   * for an absent key anyway. One load is in flight at a time; a second caller
   * joins the first.
   */
  private loadConfig(): Promise<void> {
    const existing = this.configLoading;
    if (existing !== null) return existing;
    const loading = this.readConfig().finally(() => {
      this.configLoading = null;
    });
    this.configLoading = loading;
    return loading;
  }

  private async readConfig(): Promise<void> {
    for (const path of this.configFilePaths()) {
      const parsed = await this.readConfigFile(path);
      if (parsed === null) continue;
      this.configCache = parsed;
      return;
    }
    this.configCache = {};
  }

  /** One config file's object, or `null` for "not there, or not an object". */
  private async readConfigFile(path: string): Promise<Record<string, unknown> | null> {
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
