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
    this.adapter = new DataAdapter(deps, () => this.index);
    // Wired, not assumed: a GUI or a plugin writing into the config zone drops
    // the cache, and the next `getConfig` re-reads. Without this the host would
    // serve a stale `attachmentFolderPath` for the rest of the session, which
    // is exactly the silent staleness `config_changed` exists to prevent.
    deps.mirror.onConfigChanged((path) => {
      if (path.endsWith("/app.json")) this.configCache = null;
    });
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
    return this.index.allFiles().filter((file) => file.extension === "md");
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
   * The load-bearing keys are `attachmentFolderPath` (folder-notes),
   * `newFileLocation`, `newFileFolderPath`, `alwaysUpdateLinks`,
   * `useMarkdownLinks`, `trashOption` and `userIgnoreFilters`. An unknown key
   * answers `undefined`, which is the private API's own behaviour, and is
   * recorded as a `safe_stub` hit so the report shows what plugins actually ask
   * for.
   *
   * The first call starts the read and answers `undefined`, because Obsidian's
   * own signature is synchronous and there is nowhere to await. Priming it
   * eagerly in the constructor was the alternative and is worse: it would put a
   * `read_file` on the wire before the host has a reason to.
   */
  getConfig(key: string): unknown {
    const cache = this.configCache;
    if (cache === null) {
      void this.loadConfig();
      return stub(`Vault.getConfig(${key})`, undefined);
    }
    if (!(key in cache)) return stub(`Vault.getConfig(${key})`, undefined);
    return cache[key];
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
    // `generation` is absent — not zero — for a folder that landed somewhere
    // nothing scans, which is the config zone and any hidden folder. There is
    // then no generation to wait for.
    if (result.generation !== undefined) {
      await this.deps.mirror.applyMutation(result.generation, [path]);
    }
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
   * Neither path is synchronized into the tree here. The daemon models a move
   * as a delete plus a create, `FileIndex.applyBatch` pairs those back into one
   * rename by revision, and an index that had already moved the node would
   * leave that pairing nothing to reuse — so the batch is what moves it.
   */
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const folder = file instanceof TFolder;
    const result = await this.deps.writes.send<RenameResponse>(
      folder ? "rename_folder" : "rename_note",
      { from: file.path, to: newPath, rewrite_links: true },
    );
    await this.deps.mirror.applyMutation(result.generation, [file.path, newPath]);
  }

  /**
   * Permanent deletion.
   *
   * `force` is Obsidian's "delete a folder that is not empty" flag, and it maps
   * onto `delete_folder`'s `recursive`. It means nothing for a file.
   */
  async delete(file: TAbstractFile, force?: boolean): Promise<void> {
    await this.remove(file, "permanent", force ?? true);
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
    await this.deps.mirror.applyMutation(result.generation, [file.path]);
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

  private async loadConfig(): Promise<void> {
    if (this.configLoading !== null) return this.configLoading;
    const loading = (async (): Promise<void> => {
      try {
        const response = await this.deps.client.request<ReadFileResponse>("read_file", {
          path: `${this.configDir}/app.json`,
        });
        const source = Buffer.from(response.content_base64, "base64").toString("utf8");
        const parsed: unknown = JSON.parse(source);
        this.configCache =
          typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        // No `app.json`, or one that is not JSON. A vault with no settings file
        // is an ordinary vault, and every key then answers `undefined` — which
        // is what `getConfig` would have answered for an absent key anyway.
        this.configCache = {};
      } finally {
        this.configLoading = null;
      }
    })();
    this.configLoading = loading;
    return loading;
  }
}
