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
import { affectedPathsForRename } from "./rename-paths";
import { declarePolicy, recordUse, stub } from "./policy";
import { OBSIDIAN_CONFIG_DIR } from "../pluginset/config-dir";
import type { RequestSink } from "../client/request-sink";
import type {
  GenerationResponse,
  MutationResponse,
  ReadFileResponse,
  RenameResponse,
  WriteFileResponse,
} from "../client/protocol";
import type { HostConfig } from "../config";
// The seam itself is declared with its implementations; this file re-exports
// the type a few lines below, and needs it in scope for `VaultDeps`.
import { readThroughOverlay } from "../dryrun/dry-run";
import type { WriteGate } from "../dryrun/dry-run";
import type { Mirror } from "../mirror/mirror";
import type { MirrorChangeBatch } from "../mirror/types";
import type { DispatchQueue } from "../runtime/queue";
import type { AppliedBatch, ApplyBatchOptions, TAbstractFile } from "./files";
import type { EventCallback, EventRef, ShimEventBus } from "./events";

/**
 * The one seam every host write passes through — **re-homed by Task 19**, which
 * owns `src/dryrun/dry-run.ts` and the `DryRunGate` that implements it.
 *
 * The declaration lived here while `Vault` was its only consumer; it now lives
 * beside its implementations, and this line is what keeps the eight modules
 * that import `WriteGate` from this file naming it where they always did.
 * Nothing else moved, because every consumer names the type and none of them
 * names an implementation.
 */
export type { WriteGate } from "../dryrun/dry-run";

export interface VaultDeps {
  mirror: Mirror;
  client: RequestSink;
  config: HostConfig;
  events: ShimEventBus;
  writes: WriteGate;
  queue: DispatchQueue;
}

/** How many times `process` re-reads and re-runs its callback before giving up. */
const PROCESS_ATTEMPTS = 5;

// `OBSIDIAN_CONFIG_DIR` — Obsidian's own config directory, which the host reads
// and never writes — is imported from `pluginset/config-dir.ts`, which holds the
// package's one copy of the string after a review found three. The host writes
// into `HostConfig.configDirName` (`.obsidian-headless`) and reads config
// host-directory-first with a fallback to there, so a fresh headless config dir
// inherits the real settings — which is what makes rollover work on day one —
// while an explicit override wins.

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

  /**
   * Folder moves **this host performed**, waiting for the batch that describes
   * them.
   *
   * A folder has no content revision, so `FileIndex.applyBatch` cannot pair one
   * out of the delete and the create the wire sends — see that module's header.
   * The pair is nonetheless known exactly here, at the call site that sent
   * `rename_folder`, so it is written down and Task 15's sequencer drains it
   * when the batch arrives. Only folders: a note pairs by revision and needs no
   * record.
   *
   * It is drained, not accumulated. A recorded move whose batch never arrives —
   * the mutation escalated to a resync, say — is dropped by the next drain, and
   * `applyBatch` ignores a pair whose ends the batch does not name, so a stale
   * record is inert rather than wrong.
   */
  private readonly folderMoves: Array<{ from: string; to: string }> = [];

  private configCache: Record<string, unknown> | null = null;
  private configLoading: Promise<void> | null = null;
  /** Bumped by every invalidation, so a read in flight across one is discarded. */
  private configEpoch = 0;

  constructor(private readonly deps: VaultDeps) {
    super(deps.events);
    this.configDir = deps.config.configDirName;
    // The gate's overlay, not a class test: a forwarding gate declares none,
    // and `--dry-run`'s declares the one Task 19b's consultation points read.
    this.index = new FileIndex(deps.mirror, this, deps.writes.overlay ?? null);
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
    //
    // It **re-primes**, and returns the promise so the mirror's fan-out awaits
    // it: dropping the cache alone would leave the next `getConfig` — the very
    // call that discovers the change — answering `undefined` and merely
    // starting the read. `getConfig` is synchronous, so "invalidated" has to
    // mean "already reloaded" by the time the event settles.
    deps.mirror.onConfigChanged((path) => {
      if (!path.endsWith("/app.json")) return;
      return this.reprimeConfig();
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
   * Write down a folder move this host just performed.
   *
   * @internal Host seam. Called by {@link rename} and by
   * `FileManager.renameFile`, and drained by {@link takeFolderMoves}. See
   * {@link folderMoves}.
   */
  recordFolderMove(from: string, to: string): void {
    this.folderMoves.push({ from, to });
  }

  /**
   * Every folder move recorded since the last drain, and forget them.
   *
   * @internal Host seam. Task 15's lifecycle sequencer calls it once per batch.
   */
  takeFolderMoves(): Array<{ from: string; to: string }> {
    return this.folderMoves.splice(0, this.folderMoves.length);
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
   * **Four ways the cache reloads, and what each one covers.** A
   * `config_changed` for an `.obsidian/` write **the daemon performed**; a write
   * this host itself makes to either file, through {@link configWritten};
   * {@link configReady} for an explicit prime; and {@link reprimeConfig}, which
   * the coexistence poll calls once a minute. Each of them **re-reads** rather
   * than merely dropping, and each is awaited by whatever triggered it, so the
   * first synchronous `getConfig` after a change answers the new value.
   *
   * The gap the poll closes is wider than an earlier draft of this paragraph
   * claimed. It is not only an external edit of the *host* directory: Ruling W7
   * says the daemon emits `config_changed` for raw writes it performs, and a
   * review's probe confirmed that an external GUI edit of `.obsidian/app.json`
   * — watched for eight seconds in the `watching` state — emits nothing at all.
   * So an edit made by the GUI Obsidian in *either* directory reaches no
   * subscriber, and the poll is what re-reads both.
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
  configWritten(path: string): Promise<void> {
    if (!this.configFilePaths().includes(path)) return Promise.resolve();
    return this.reprimeConfig();
  }

  // --- Reads ----------------------------------------------------------------

  /**
   * A note's current bytes, as text.
   *
   * Under `--dry-run` "current" means the run's own: {@link currentSource}
   * consults the gate's overlay before the wire, so a plugin that wrote and
   * then read sees what it wrote. In every other run it is one `read_file`, as
   * it always was.
   */
  async read(file: TFile): Promise<string> {
    return (await this.currentSource(file.path)).content.toString("utf8");
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
    const bytes = (await this.currentSource(file.path)).content;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  // --- Writes ---------------------------------------------------------------

  async create(path: string, data: string): Promise<TFile> {
    recordUse("Vault.create");
    const result = await this.deps.writes.send<MutationResponse>("write_note", {
      path,
      content: data,
      expected: { absent: true },
    });
    await this.deps.mirror.applyMutation(result.generation, [path]);
    return this.createdFile(path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    recordUse("Vault.createBinary");
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
    recordUse("Vault.createFolder");
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
    // **Under `--dry-run` this is the expected outcome, not a broken host.**
    // Nothing was created, so `applyMutation` was a no-op and the mirror has no
    // row — and a plugin whose `onload` makes a folder is ordinary, so throwing
    // here would fail working plugins for a property of the mode rather than of
    // the plugin. A detached folder is the same answer this method already
    // gives for a folder the mirror will never hold. The throw stays for a real
    // run, where it is a genuine invariant failure worth hearing about.
    if (this.deps.config.dryRun) return this.index.detachedFolder(path);
    throw new Error(`the daemon created ${path} but the mirror has no folder row for it`);
  }

  async modify(file: TFile, data: string): Promise<void> {
    recordUse("Vault.modify");
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
    recordUse("Vault.modifyBinary");
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
    recordUse("Vault.process");
    return this.deps.queue.runExclusivePath(file.path, async () => {
      for (let attempt = 1; attempt <= PROCESS_ATTEMPTS; attempt += 1) {
        // The overlay first, so that two `append`s to one note under
        // `--dry-run` compose instead of the second one silently discarding the
        // first — the read half of the same promise `read` keeps.
        const read = await this.currentSource(file.path);
        const next = fn(read.content.toString("utf8"));
        try {
          const result = await this.deps.writes.send<MutationResponse>("write_note", {
            path: file.path,
            content: next,
            expected:
              read.revision === undefined ? { any: true as const } : { revision: read.revision },
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
    recordUse("Vault.append");
    await this.process(file, (existing) => `${existing}${data}`);
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    recordUse("Vault.copy");
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
   * **The refetch set is {@link affectedPathsForRename}'s**, shared with
   * `FileManager.renameFile` — both ends, the subtree at both ends, and every
   * note that linked to any of them. This method used to compute the first two
   * and forget the third, which left every note whose links the daemon had just
   * rewritten stale in the mirror: wrong `resolvedLinks`, wrong `backlinks`,
   * wrong `outgoing` resolutions, all of them handed straight to plugin code.
   * Found by Task 9's review, which had already fixed the same hole on the
   * neighbouring surface.
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
   * leave that pairing nothing to reuse — so the batch is what moves it. The
   * window that used to leave is closed: `applyMutation` emits the batch as the
   * last thing it does, inside the `await` below, and Task 15's sequencer is
   * subscribed to it, so the tree has moved by the time this method resolves.
   *
   * **A folder move is recorded before the apply**, because a folder has no
   * content revision for the pairing to work from. See {@link folderMoves}.
   */
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    recordUse("Vault.rename");
    const folder = file instanceof TFolder;
    // Read before the send: afterwards `from` is gone and so is its backlink
    // entry, so the same call would answer with a smaller set and say nothing.
    const affected = affectedPathsForRename(this, this.deps.mirror, file, newPath);
    const from = file.path;
    const result = await this.deps.writes.send<RenameResponse>(
      folder ? "rename_folder" : "rename_note",
      { from, to: newPath, rewrite_links: true },
    );
    // **Before the apply, because the apply is what emits the batch.** A folder
    // has no revision to pair on, so this record is the only thing that lets the
    // sequencer report the move as one `rename` rather than a delete and a
    // create — and `applyMutation` emits the batch inside the await below, so a
    // record written afterwards would arrive one batch too late. See
    // {@link folderMoves}.
    if (folder) this.recordFolderMove(from, newPath);
    await this.deps.mirror.applyMutation(result.generation, affected);
    // Under `--dry-run` no batch follows, so nothing else would move the tree
    // — and a plugin holding the old parent's `TFolder` reads `children`
    // without asking the index anything. A no-op in a real run.
    this.index.refresh();
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
   * is the thing that can be behind: the node stays in the tree until a batch
   * removes it. `applyMutation` emits the batch inside the `await` this method
   * holds and Task 15's sequencer is subscribed to it, so the window is closed
   * rather than narrowed — but the emptiness test runs *before* any of that, so
   * it still has to ask the mirror.
   */
  async delete(file: TAbstractFile, force?: boolean): Promise<void> {
    recordUse("Vault.delete");
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
    recordUse("Vault.trash");
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
    // Before the early return, because a delete in an unindexed zone answers no
    // generation and still has to leave the tree. See {@link FileIndex.refresh}.
    this.index.refresh();
    if (result.generation === undefined) return;
    // The same subtree rule as `rename`: a deleted folder's descendants are
    // rows that moved and the wire names none of them.
    //
    // **Defence in depth, and currently unreachable.** Unlike `rename` — whose
    // destination rows the mirror cannot expand, because they do not exist there
    // yet — a delete names a folder the mirror still holds, so
    // `Mirror.applyMutation` expands it anyway and this list adds nothing. It is
    // kept because the two sides are independent: a mutation that removed the
    // row first, or a mirror that stopped expanding, would lose the subtree
    // silently. A mutant that deletes these paths therefore survives the suite,
    // and that is not a coverage gap.
    const affected =
      file instanceof TFolder ? [file.path, ...this.descendantsOf(file.path)] : [file.path];
    await this.deps.mirror.applyMutation(result.generation, affected);
  }

  /**
   * Every path the mirror holds under `path`, `path` itself excluded.
   *
   * @internal Host seam, public so Task 9's `FileManager` can ask the same
   * question this class asks — a folder move or delete has to name its subtree,
   * and two implementations of "what is under this folder" would be two chances
   * to orphan it.
   */
  descendantsOf(path: string): string[] {
    const prefix = `${path}/`;
    return this.deps.mirror
      .entries()
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => entry.path);
  }

  /**
   * Both ends of a folder move, and every row under both ends.
   *
   * @internal Host seam, public for the same reason as {@link descendantsOf}:
   * `FileManager.renameFile` moves folders too, and the destination rows it has
   * to name are exactly the ones the mirror cannot expand on its own.
   */
  movedPaths(from: string, to: string): string[] {
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
   *
   * @internal Host seam, public so every write in the shim states its
   * precondition the same way — Task 9's `patch_frontmatter` and `rename_note`
   * carry one too, and a second implementation would be a second answer to
   * "what does this host consider unconditional".
   */
  expectedFor(path: string): { revision: string } | { any: true } {
    // **The overlay's revision first, under `--dry-run` only** — it holds one
    // exactly for a path this run has already written. Ruling 4: the synthetic
    // revision the gate answered is the one the *next* write must carry, so a
    // plugin that creates a note and then modifies it states a precondition
    // rather than declaring itself unconditional, which is what it would do for
    // real against a note that now exists.
    const overlaid = this.deps.writes.overlay?.entry(path)?.revision;
    if (typeof overlaid === "string") return { revision: overlaid };
    const revision = this.deps.mirror.entry(path)?.revision;
    return revision === null || revision === undefined ? { any: true } : { revision };
  }

  /**
   * One path's current bytes and the revision to write against.
   *
   * The one place `Vault` reads a note, so that `read`, `cachedRead`,
   * `readBinary` and `process` cannot disagree about what "current" means. The
   * overlay branch lives in `dryrun/dry-run.ts` beside the precedence it
   * implements.
   */
  private currentSource(path: string): Promise<{ content: Buffer; revision: string | undefined }> {
    return readThroughOverlay(this.deps.client, this.deps.writes.overlay, path);
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
    const loading = this.readConfig(this.configEpoch).finally(() => {
      this.configLoading = null;
    });
    this.configLoading = loading;
    return loading;
  }

  /**
   * Drop the cache and read it again, as one step.
   *
   * The epoch is what makes a read that was already in flight when the file
   * changed harmless: it resolves, sees that its epoch is stale, and declines
   * to install bytes that are known to be old. Without it the race is a cache
   * holding the *previous* contents of a file that has just been rewritten,
   * which is the exact staleness this whole path exists to prevent.
   *
   * **Public, and unconditional — that is the difference from
   * {@link configReady}.** `configReady` returns immediately once the cache is
   * warm, which is right for a prime and useless for a poll: hanging it off the
   * 60 s tick would re-read nothing, ever, after the first second of the
   * host's life. The poll needs the re-read to happen *because* nothing told it
   * anything changed, so it calls this.
   */
  reprimeConfig(): Promise<void> {
    this.configEpoch += 1;
    this.configCache = null;
    this.configLoading = null;
    return this.loadConfig();
  }

  private async readConfig(epoch: number): Promise<void> {
    for (const path of this.configFilePaths()) {
      const parsed = await this.readConfigFile(path);
      if (parsed === null) continue;
      if (epoch !== this.configEpoch) return;
      this.configCache = parsed;
      return;
    }
    if (epoch !== this.configEpoch) return;
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

/**
 * The vault's **mutations**, declared and recorded — and only the mutations.
 *
 * Added by Task 20, which needed `Vault.modify` to appear in the detector's
 * ordered call log. The line is drawn at mutations rather than at every method
 * on purpose. The write surface is what a compatibility report is *about*: the
 * 2026-08-28 census found 31 of 56 plugins mutate the vault and that every one
 * of those mutations goes through these primitives, so "which of them does this
 * plugin reach for" is a question with a reader. A read answered out of the
 * mirror — `getFileByPath`, `getMarkdownFiles`, `getAbstractFileByPath` — is
 * the host handing back something it already holds; recording those would
 * bury the writes under them and make the report a log of ordinary work rather
 * than a description of a surface.
 *
 * `implemented` because they are: every one of them really performs the
 * mutation, and `--dry-run` recording it instead is a property of the run
 * rather than of the surface (see `refuseInDryRun` in `shim/policy.ts`).
 *
 * `append` records **and** so does the `process` it delegates to, which is the
 * honest reading: a plugin that appends has reached for both.
 */
declarePolicy("Vault.create", "implemented");
declarePolicy("Vault.createBinary", "implemented");
declarePolicy("Vault.createFolder", "implemented");
declarePolicy("Vault.modify", "implemented");
declarePolicy("Vault.modifyBinary", "implemented");
declarePolicy("Vault.process", "implemented");
declarePolicy("Vault.append", "implemented");
declarePolicy("Vault.copy", "implemented");
declarePolicy("Vault.rename", "implemented");
declarePolicy("Vault.delete", "implemented");
declarePolicy("Vault.trash", "implemented");
