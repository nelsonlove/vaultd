/**
 * `app.fileManager` — the surface plugins edit properties and move files
 * through.
 *
 * ## `processFrontMatter` never re-serializes a note
 *
 * Thirteen plugins in the corpus call it, and the tempting implementation —
 * read the note, parse the YAML, hand the object over, dump the YAML back,
 * write the whole file — rewrites every note it touches: key order, comments,
 * quoting style, anchors, and block scalars are all decided by whichever YAML
 * emitter the host happens to link, not by what the user wrote. A plugin that
 * sets one `status:` field would silently reformat the document.
 *
 * So this reads the note's **current frontmatter as a plain object out of the
 * mirror's row**, hands that to the callback, diffs the object before and
 * after, and sends `patch_frontmatter` carrying only the keys the callback
 * actually changed. A callback that changes nothing sends nothing at all.
 *
 * **What "preserves the bytes" does and does not promise.** Everything outside
 * the addressed *top-level key* survives exactly — key order, comments,
 * quoting, the block scalar three keys down, and the body — which is measured
 * rather than hoped. Within the addressed key it depends on the edit: setting a
 * **scalar onto a scalar that is already there, reached as a mapping key**,
 * splices that scalar's own span and moves nothing around it, however deep it
 * sits. Every other edit below the stored granularity re-serializes the
 * smallest enclosing top-level property — a deletion, a new sequence or
 * mapping, a target that is itself a sequence or mapping, a target that does
 * not exist yet, or a leaf addressed as a sequence element — so that one
 * property can come back in the document's addition dialect (block collections
 * in flow style, indentation normalized, comments between its own lines
 * dropped) while nothing outside it moves. Still **narrower than Obsidian**,
 * which re-serializes the entire frontmatter block on every
 * `processFrontMatter` call.
 *
 * Four rules decide what a diff emits, and each exists because the alternative
 * is wrong rather than merely different:
 *
 * - A key present before and absent after — deleted, or set to `undefined` —
 *   becomes `{ key_path, value: null }`, which is the mutation spec's deletion
 *   form.
 * - A key the callback set to **`null`** becomes `{ key_path, set_null: true }`,
 *   the additive entry that writes a YAML `null` into the key rather than
 *   removing it — which is what Obsidian does with `fm.key = null`. The two
 *   outcomes need two spellings because `value: null` is already spoken for as
 *   the deletion marker and `PatchValueDto` has no null variant of its own.
 * - A **branch that changed shape** goes whole: an object that became a scalar,
 *   a scalar that became an object, or a new key whose value is a subtree. A
 *   key path into a branch that no longer has that shape addresses a span that
 *   does not exist.
 * - An **array goes whole whenever it differs at all**. The daemon does address
 *   sequence elements by index — `["maps", "0", "value"]` is accepted — so this
 *   is a choice rather than a limit, and the choice costs nothing: a leaf
 *   addressed as a sequence element is one of the shapes that re-serializes the
 *   enclosing property anyway, so the indexed form produces the *same* bytes as
 *   sending the array whole while addressing a position rather than a value.
 *
 * **Key paths go out as segment arrays, never as a dotted string.** The two
 * spellings address differently and the daemon rewrites neither into the other:
 * a string is a dot-path, so `"my.key"` means `key` inside `my`, while
 * `["my.key"]` is the single key of that name. For a key whose own name
 * contains a dot the string form is not merely ambiguous but wrong — measured
 * in review against the shipped daemon, it grew a nested `my:` mapping beside
 * the real key and left the real key stale, a silent wrong-target write in the
 * one method whose whole point is not to disturb a note. Segments are never
 * split, joined, or escaped anywhere in this module. What no `key_path` can
 * name is an **empty segment**, which the daemon refuses with
 * `invalid_request`; this host refuses it first, with
 * {@link UnaddressableFrontmatterKey}, so the error names the note and the key.
 *
 * The whole read-diff-send loop holds the path's lock through
 * `DispatchQueue.runExclusivePath`, the same serialization `Vault.process`
 * uses, so two plugins patching one note interleave at the host instead of
 * racing to a conflict at the daemon. A `revision_conflict` means somebody else
 * wrote in between, so the loop **brings the mirror's row up to date and runs
 * the callback again against the new frontmatter** — an edit computed from
 * bytes that no longer exist is the lost update the precondition exists to
 * prevent. Three attempts, then the typed error reaches the plugin.
 *
 * Read-your-writes holds at the **mirror**: the row carries the patched
 * frontmatter before this resolves. `app.metadataCache.getFileCache` answers
 * with it once that note's position index is warm, and answers `null` while it
 * is cold — `MetadataCache.cacheFor`'s documented contract, not a gap this
 * method can close.
 *
 * ## A rename refetches more than the wire names
 *
 * `RenameResponse` is `{ generation, revision?, links_rewritten,
 * link_rewrite_failures }`: the failures carry paths, the successes carry only
 * a count. After a rename the shim therefore knows how many inbound links were
 * repaired but not which notes they were in — and every one of those notes now
 * has different bytes and a different revision, so leaving them in the mirror
 * is leaving the mirror wrong.
 *
 * It does not invent path-level knowledge it was not given. Before the request
 * goes out it asks {@link affectedPathsForRename} — the one answer this shim
 * has, shared with `Vault.rename` — for both ends of the move, every row under
 * both ends of a folder move, and every note the mirror knew was linking to any
 * of them. `from` is in that set and has to be: after the move it holds
 * nothing, the refetch answers it absent, and that is what takes the row out of
 * the mirror. The capture happens **before** the send for the same reason:
 * afterwards the backlink entry is gone and the set would be silently emptier.
 *
 * **Neither kind of rename carries an `expected`.** `rename_folder` rejects the
 * field outright — a folder has no bytes and therefore no revision — and the
 * note form deliberately omits it too: Obsidian's `renameFile` has no
 * compare-and-swap failure mode, the mirror's revision lags the filesystem by a
 * watcher round trip, and a move does not depend on the bytes it is moving. A
 * precondition here made a rename fail with `revision_conflict` whenever
 * anything had touched the note a moment earlier, which `Vault.rename` never
 * did.
 *
 * ## The one place `trashOption` is read
 *
 * `vault.trash(file, system)` passes the plugin's own choice through (mutation
 * spec Ruling 3). `fileManager.trashFile` has no such argument — Obsidian's own
 * signature takes only the file — so this is the one API whose deletion mode
 * comes from the *user's* preference in `app.json`: `system` → `trash_system`,
 * `local` → `trash_local`, `none` → `permanent`, and `trash_system` when the
 * setting is missing, which is Obsidian's own default.
 */

import { VaultdError } from "../client/errors";
import { HeadlessUnsupported, currentPluginId, declarePolicy, recordUse, stub } from "./policy";
import { TFolder } from "./files";
import { affectedPathsForRename } from "./rename-paths";
import type { DispatchQueue } from "../runtime/queue";
import type { Mirror } from "../mirror/mirror";
import type { MetadataCache } from "./metadata-cache";
import type { TAbstractFile, TFile } from "./files";
import type { Vault, WriteGate } from "./vault";
import type {
  DeleteModeDto,
  FrontmatterEditDto,
  GenerationResponse,
  LinkRewriteFailureDto,
  MutationResponse,
  PatchValueDto,
  PropertyDto,
  PropertyValueDto,
  RenameResponse,
} from "../client/protocol";

/**
 * What a headless host asks a human, when there is a human to ask.
 *
 * Declared here because {@link FileManager.promptForDeletion} is its first and
 * so far only consumer; Task 18 owns the interaction handler that implements it
 * and may re-home the declaration, which changes nothing here because this
 * module names the type and never an implementation.
 */
export interface ConfirmRequest {
  /** The file or folder the question is about. */
  path: string;
  /** What to ask, already phrased for a human. */
  message: string;
}

export interface ConfirmBroker {
  confirm(request: ConfirmRequest): Promise<boolean>;
}

export interface FileManagerDeps {
  mirror: Mirror;
  vault: Vault;
  metadataCache: MetadataCache;
  writes: WriteGate;
  queue: DispatchQueue;
  /** Attached by Task 18 when a human is reachable; absent means nobody is. */
  confirm?: ConfirmBroker | null;
}

/**
 * How many times `processFrontMatter` re-reads and re-runs its callback.
 *
 * Three rather than `Vault.process`'s five, and the difference is deliberate: a
 * whole-file `process` rewrites bytes a conflicting writer may legitimately be
 * appending to, so retrying it is ordinary, while a frontmatter patch that
 * loses three races in a row is contending with something that is writing this
 * note continuously, and a fourth attempt is not going to be the lucky one.
 */
const PATCH_ATTEMPTS = 3;

/** Obsidian's own name for a folder made with no name given. */
const UNTITLED_FOLDER = "Untitled";

/**
 * A frontmatter key no `key_path` can name.
 *
 * **A dot in a key is no longer one of these.** The daemon takes a segment
 * array (`["my.key"]`) as of the additive wire form, and that is what this host
 * sends, so a dotted name is ordinary. What remains unnameable is an **empty
 * segment**: `docs/protocol.md` makes a path with one `invalid_request` in
 * either spelling, and a key named `""` is something YAML can hold and this
 * protocol cannot address.
 *
 * Typed, and carrying the key and the note, because the plugin that asked has
 * to be able to tell this apart from "the write failed" — nothing was written,
 * nothing was corrupted, and the key it named is the reason. Refusing here
 * rather than letting the daemon refuse means the error names the note and the
 * segment list instead of a decode position.
 */
export class UnaddressableFrontmatterKey extends Error {
  readonly code = "unaddressable_frontmatter_key";
  readonly path: string;
  readonly keyPath: readonly string[];
  constructor(path: string, keyPath: readonly string[]) {
    super(
      `${path}: the frontmatter key ${JSON.stringify(keyPath.join(" › "))} has an empty segment, ` +
        `which no key_path can address — the daemon refuses one with invalid_request`,
    );
    this.name = "UnaddressableFrontmatterKey";
    this.path = path;
    this.keyPath = [...keyPath];
  }
}

/**
 * A value a callback produced that cannot survive the trip.
 *
 * `NaN` and `Infinity` are the ones that matter: `JSON.stringify` turns both
 * into `null`, and `null` on this wire means *delete this key*. A plugin that
 * divided by zero would silently lose the property it was setting, so it gets
 * a typed refusal instead and the note is not touched.
 */
export class UnrepresentableFrontmatterValue extends Error {
  readonly code = "unrepresentable_frontmatter_value";
  readonly path: string;
  readonly keyPath: readonly string[];
  constructor(path: string, keyPath: readonly string[], value: number) {
    super(
      `${path}: the frontmatter key ${JSON.stringify(keyPath.join(" › "))} was set to ` +
        `${String(value)}, which JSON cannot carry — it would reach the daemon as null and ` +
        `delete the key`,
    );
    this.name = "UnrepresentableFrontmatterValue";
    this.path = path;
    this.keyPath = [...keyPath];
  }
}

/** `newLinkFormat`'s three values, as `app.json` spells them. */
type LinkFormat = "shortest" | "relative" | "absolute";

export class FileManager {
  private confirmBroker: ConfirmBroker | null;
  private lastFailures: readonly LinkRewriteFailureDto[] = [];

  constructor(private readonly deps: FileManagerDeps) {
    this.confirmBroker = deps.confirm ?? null;
  }

  // --- Frontmatter ----------------------------------------------------------

  /**
   * Edit one note's frontmatter as an object, and send only what changed.
   *
   * See the module doc for why this never re-serializes the document, what the
   * diff emits, and why the loop re-runs the callback on a conflict rather than
   * re-sending the same patch.
   */
  processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    recordUse("FileManager.processFrontMatter");
    return this.deps.queue.runExclusivePath(file.path, async () => {
      for (let attempt = 1; attempt <= PATCH_ATTEMPTS; attempt += 1) {
        // Two independent conversions rather than one and a clone: the callback
        // is free to mutate its object to any depth, and `before` has to be a
        // tree it cannot reach.
        const before = this.frontmatterOf(file.path);
        const after = this.frontmatterOf(file.path);
        fn(after);
        const patch = diffFrontMatter(before, after, file.path);
        if (patch.length === 0) return;
        try {
          const result = await this.deps.writes.send<MutationResponse>("patch_frontmatter", {
            path: file.path,
            patch,
            expected: this.deps.vault.expectedFor(file.path),
          });
          await this.deps.mirror.applyMutation(result.generation, [file.path]);
          this.deps.vault.index.sync(file.path);
          return;
        } catch (error) {
          const conflict = error instanceof VaultdError && error.code === "revision_conflict";
          if (!conflict || attempt === PATCH_ATTEMPTS) throw error;
          // Bring the row up to date so the next attempt's callback runs
          // against the frontmatter that is really there. The daemon's
          // `current_revision` says the bytes moved but not what they say, and
          // the mirror is the only thing that can answer that.
          await this.deps.mirror.applyMutation(this.deps.mirror.generation(), [file.path]);
        }
      }
      // Unreachable: the last attempt either returns or rethrows.
      throw new Error(
        `processFrontMatter(${file.path}) exhausted ${String(PATCH_ATTEMPTS)} attempts`,
      );
    });
  }

  // --- Moving things --------------------------------------------------------

  /**
   * Move a file or folder, with the daemon repairing inbound links.
   *
   * See the module doc for the refetch set and why `rename_folder` carries no
   * precondition.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    recordUse("FileManager.renameFile");
    // Captured BEFORE the mutation: once it lands, `from` no longer exists and
    // its backlink entry is gone with it, so a set computed afterwards would be
    // silently emptier.
    const affected = affectedPathsForRename(this.deps.vault, this.deps.mirror, file, newPath);
    const result = await this.deps.writes.send<RenameResponse>(
      file instanceof TFolder ? "rename_folder" : "rename_note",
      { from: file.path, to: newPath, rewrite_links: true },
    );
    this.lastFailures = result.link_rewrite_failures;
    await this.deps.mirror.applyMutation(result.generation, affected);
  }

  /**
   * The inbound references the most recent rename could **not** repair.
   *
   * Exposed rather than logged so `host.info` and the compatibility report can
   * surface a partial repair; nothing swallows them. Empty after a rename that
   * repaired everything, which is the affirmative answer the protocol's empty
   * list means.
   *
   * **One slot, shared by every caller.** `renameFile` is not serialized by the
   * dispatch queue, so two renames in flight at once overwrite each other here
   * and a reader can be told about somebody else's rename. It is a diagnostic
   * for a report, and a caller that needs to branch on a specific rename's
   * failures needs a per-call return value rather than this.
   */
  lastRenameFailures(): readonly LinkRewriteFailureDto[] {
    return [...this.lastFailures];
  }

  // --- Composing a link -----------------------------------------------------

  /**
   * Compose a link to `file` as it would be written in `sourcePath`.
   *
   * Two settings decide the spelling, both read through `Vault.getConfig`:
   * `useMarkdownLinks` chooses between `[[Wikilink]]` and `[Markdown](link)`,
   * and `newLinkFormat` chooses the link text — `shortest` (the bare name when
   * it still reaches this file, the vault path when another file shares the
   * name), `relative` (from the source note's folder), or `absolute` (the vault
   * path, always). `shortest` is the default, and it asks the mirror the same
   * question `vaultd`'s own rename repair asks, so a link this host writes and
   * a link the daemon rewrites look identical.
   *
   * A Markdown destination is a URL, so it keeps the `.md` extension and
   * percent-encodes what a URL must — **the subpath included**, which is where
   * the naive version broke: `encodeURI` leaves `#` and a space alone, so
   * `[Solo](Solo.md#My Heading)` came out unresolvable and `[Hash #1](Hash
   * %231.md)` was not a link at all. Measured against this repo's own parser:
   * `Solo.md#My%20Heading` resolves with its heading subpath and
   * `Hash%20%231.md` resolves to `Hash #1.md`. The display text is encoded
   * nowhere, because a reader reads it.
   */
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    recordUse("FileManager.generateMarkdownLink");
    const format = this.linkFormat();
    const text = this.linktextFor(file, sourcePath, format, true);
    if (this.deps.vault.getConfig("useMarkdownLinks") !== true) {
      const display = alias === undefined || alias === "" ? "" : `|${alias}`;
      return `[[${text}${subpath ?? ""}${display}]]`;
    }
    const target = encodeLinkPart(this.linktextFor(file, sourcePath, format, false));
    const fragment = encodeSubpath(subpath);
    return `[${alias === undefined || alias === "" ? text : alias}](${target}${fragment})`;
  }

  // --- Where things go ------------------------------------------------------

  /**
   * The folder a new file belongs in, per the user's `newFileLocation`.
   *
   * `root` (and anything unset) is the vault root, `current` is the folder the
   * source note is in, and `folder` is `newFileFolderPath`. A configured folder
   * the vault does not hold falls back to the root rather than inventing one —
   * Obsidian's own behaviour, and the only answer that cannot hand a caller a
   * `TFolder` nothing will accept a write into.
   *
   * An explicit `newFilePath` wins over all of it: the caller has already said
   * where the file goes, and this is being asked only for the folder object.
   */
  getNewFileParent(sourcePath: string, newFilePath?: string): TFolder {
    recordUse("FileManager.getNewFileParent");
    if (newFilePath !== undefined && newFilePath !== "") {
      const named = this.folderAt(parentOf(newFilePath));
      if (named !== null) return named;
    }
    const location = this.deps.vault.getConfig("newFileLocation");
    if (location === "current") return this.folderAt(parentOf(sourcePath)) ?? this.root();
    if (location === "folder") {
      const configured = this.deps.vault.getConfig("newFileFolderPath");
      const path = typeof configured === "string" ? configured : "";
      return this.folderAt(path) ?? this.root();
    }
    return this.root();
  }

  /**
   * A free path for an attachment, in the user's attachment folder.
   *
   * `attachmentFolderPath` is read the way Obsidian writes it: empty or `/` is
   * the vault root, `./` is the folder the note being written lives in, `./sub`
   * is a subfolder of that folder, and anything else is a vault-absolute path.
   * A collision takes Obsidian's suffix form — ` 1`, ` 2`, … before the
   * extension, never after it.
   *
   * Asynchronous because Obsidian's is, and because the day this consults the
   * daemon rather than the mirror the signature must not have to change.
   */
  getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    recordUse("FileManager.getAvailablePathForAttachment");
    const folder = this.attachmentFolder(sourcePath);
    const wanted = folder === "" ? filename : `${folder}/${filename}`;
    return Promise.resolve(this.availablePath(wanted));
  }

  /**
   * Delete through the user's trash preference. See the module doc.
   *
   * A folder goes recursively, because a `trashFile` that refused a non-empty
   * folder would be refusing the only thing anybody calls it on — Obsidian's
   * own file menu deletes a folder and its contents together.
   */
  async trashFile(file: TAbstractFile): Promise<void> {
    recordUse("FileManager.trashFile");
    await this.remove(file, this.trashMode());
  }

  /**
   * Make a new folder under `parent`, named the way Obsidian names one.
   *
   * Undocumented, and load-bearing: folder-notes calls it. The real application
   * makes `Untitled` and opens an inline rename; headless there is nobody to
   * rename it, so the folder simply keeps the name — numbered past whatever is
   * already there, which is what the application would have offered.
   */
  createNewFolder(parent: TFolder): Promise<TFolder> {
    recordUse("FileManager.createNewFolder");
    const base = parent.isRoot() ? UNTITLED_FOLDER : `${parent.path}/${UNTITLED_FOLDER}`;
    return this.deps.vault.createFolder(this.availablePath(base));
  }

  // --- Asking a human -------------------------------------------------------

  /**
   * Install the thing that asks a human, or `null` for nobody.
   *
   * @internal Host seam. Task 18 owns the interaction handler; a plugin that
   * calls this is installing its own answer to its own question.
   */
  setConfirmBroker(broker: ConfirmBroker | null): void {
    this.confirmBroker = broker;
  }

  /**
   * Ask before deleting, and answer what the asking produced.
   *
   * **Implemented, not absent.** `obsidian.d.ts` has it as
   * `promptForDeletion(file: TAbstractFile): Promise<boolean>`, public since
   * 0.15.0, documented as resolving `true` if the prompt was confirmed and
   * `false` if it was canceled — so there is a real contract to honour and a
   * real answer to give.
   *
   * With a handler attached it brokers a `confirm` and, on `true`, performs the
   * deletion through {@link trashFile} — the same thing Obsidian does after its
   * own dialog. With no handler it resolves **`false`**: nobody was asked, so
   * nothing was confirmed, and the caller's own `if (confirmed)` branch does
   * the right thing with no special-casing. It never deletes silently and it
   * never throws, so folder-notes' delete path degrades into a no-op rather
   * than a crash. The unattended case records a `safe_stub` hit, so the
   * compatibility report can say the plugin asked.
   */
  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    const broker = this.confirmBroker;
    if (broker === null) return stub("FileManager.promptForDeletion", false);
    recordUse("FileManager.promptForDeletion");
    const confirmed = await broker.confirm({
      path: file.path,
      message: `Delete ${file.path}?`,
    });
    if (!confirmed) return false;
    await this.trashFile(file);
    return true;
  }

  /**
   * Absent, and refused asynchronously.
   *
   * Neither this nor {@link promptForFolderDeletion} appears in `obsidian.d.ts`
   * at all, so — unlike the confirm above — there is no documented return
   * contract to honour and no honest value to invent: "the rename dialog
   * resolved" has no meaningful headless answer.
   *
   * The refusal is a **rejected promise** rather than a synchronous throw,
   * because the surface a plugin holds is an async one and a caller that wrote
   * `.catch(…)` must reach its catch. The recorded hit and the error are
   * exactly what `unsupported()` produces — `recordUse` reports at the declared
   * policy, which for these two is `absent`.
   */
  promptForFileRename(file: TAbstractFile): Promise<void> {
    void file;
    return this.refuse("FileManager.promptForFileRename");
  }

  promptForFolderDeletion(folder: TFolder): Promise<void> {
    void folder;
    return this.refuse("FileManager.promptForFolderDeletion");
  }

  // --- Internals ------------------------------------------------------------

  /** One note's frontmatter as a fresh, mutable plain object. */
  private frontmatterOf(path: string): Record<string, unknown> {
    const row = this.deps.mirror.note(path);
    return row === undefined ? {} : plainFrontmatter(row.properties);
  }

  private refuse(symbol: string): Promise<never> {
    recordUse(symbol);
    return Promise.reject(new HeadlessUnsupported(symbol, currentPluginId()));
  }

  private root(): TFolder {
    return this.deps.vault.getRoot();
  }

  /** The folder at `path`, the root for `""`, and `null` for anything else. */
  private folderAt(path: string): TFolder | null {
    if (path === "") return this.root();
    return this.deps.vault.getFolderByPath(path);
  }

  private linkFormat(): LinkFormat {
    const configured = this.deps.vault.getConfig("newLinkFormat");
    if (configured === "relative" || configured === "absolute") return configured;
    return "shortest";
  }

  /**
   * The text that reaches `file` from `sourcePath`, in the configured format.
   *
   * `shortest` is the mirror's question and is asked through the metadata
   * cache, which asks the mirror's resolver; the other two are arithmetic on
   * paths and are done here.
   */
  private linktextFor(
    file: TFile,
    sourcePath: string,
    format: LinkFormat,
    omitExtension: boolean,
  ): string {
    if (format === "shortest") {
      return this.deps.metadataCache.fileToLinktext(file, sourcePath, omitExtension);
    }
    const path =
      format === "absolute" ? file.path : relativeFrom(parentOf(sourcePath), file.path);
    return omitExtension && file.extension.toLowerCase() === "md"
      ? path.slice(0, path.length - file.extension.length - 1)
      : path;
  }

  /** Where an attachment for `sourcePath` belongs, as a vault path or `""`. */
  private attachmentFolder(sourcePath?: string): string {
    const configured = this.deps.vault.getConfig("attachmentFolderPath");
    const setting = typeof configured === "string" ? configured.trim() : "";
    const sourceFolder = sourcePath === undefined ? "" : parentOf(sourcePath);
    if (setting === "" || setting === "/") return "";
    if (setting === "./") return sourceFolder;
    if (setting.startsWith("./")) {
      const under = setting.slice(2);
      return sourceFolder === "" ? under : `${sourceFolder}/${under}`;
    }
    return setting;
  }

  /**
   * `path` if nothing holds it, else `path` with Obsidian's ` N` suffix.
   *
   * **It asks the mirror, which is this host's idea of the vault.** A path the
   * daemon holds but the mirror has not seen yet — a file created outside this
   * host a moment ago — is reported free, and the write that follows meets
   * `target_exists`. The same is true of every other "does this exist" read in
   * the shim; the alternative is a synchronous round trip Obsidian's API has
   * nowhere to await.
   */
  private availablePath(path: string): string {
    if (this.deps.mirror.entry(path) === undefined) return path;
    const cut = path.lastIndexOf("/");
    const folder = cut === -1 ? "" : path.slice(0, cut + 1);
    const name = cut === -1 ? path : path.slice(cut + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const extension = dot <= 0 ? "" : name.slice(dot);
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${folder}${stem} ${String(suffix)}${extension}`;
      if (this.deps.mirror.entry(candidate) === undefined) return candidate;
    }
  }

  private trashMode(): DeleteModeDto {
    const option = this.deps.vault.getConfig("trashOption");
    if (option === "local") return "trash_local";
    if (option === "none") return "permanent";
    // Obsidian's own default, and the daemon's, for a setting that is missing
    // or unreadable: a delete must not fail on a configuration file.
    return "trash_system";
  }

  /**
   * One deletion, in the shape the wire wants.
   *
   * No `expected` on either verb. `delete_folder` rejects the field outright,
   * and a precondition on the note form would make a delete fail with
   * `revision_conflict` because somebody edited the file first — which is not a
   * reason to keep a file the user asked to remove, and is not something
   * Obsidian's own delete does. `Vault.trash` sends none either.
   */
  private async remove(file: TAbstractFile, mode: DeleteModeDto): Promise<void> {
    const folder = file instanceof TFolder;
    const result = folder
      ? await this.deps.writes.send<GenerationResponse>("delete_folder", {
          path: file.path,
          mode,
          recursive: true,
        })
      : await this.deps.writes.send<GenerationResponse>("delete_note", {
          path: file.path,
          mode,
        });
    if (result.generation === undefined) return;
    // The same subtree rule the rename has: a deleted folder's descendants are
    // rows that moved and the wire names none of them.
    const affected = folder
      ? [file.path, ...this.deps.vault.descendantsOf(file.path)]
      : [file.path];
    await this.deps.mirror.applyMutation(result.generation, affected);
  }
}

/**
 * Every property as a fresh plain-JS tree.
 *
 * A near-twin of the conversion behind `CachedMetadata.frontmatter`, and
 * deliberately its own: that one's result is **memoized and shared** — every
 * reader of `getFileCache` holds the same object — so handing it to a callback
 * that is expected to mutate it would let one plugin's edit rewrite what every
 * other plugin reads. This one allocates per call precisely so the callback can
 * scribble on it.
 *
 * `float` is the trap it shares: the wire carries it as a **string**, and a
 * host that forgot to `Number` it would send a frontmatter number back as a
 * quoted string the first time a plugin touched the note.
 */
function plainFrontmatter(properties: readonly PropertyDto[]): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  for (const property of properties) frontmatter[property.key] = plainValue(property.value);
  return frontmatter;
}

function plainValue(value: PropertyValueDto): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "boolean":
      return value.value;
    case "integer":
      return value.value;
    case "float":
      return Number(value.value);
    case "string":
      return value.value;
    case "sequence":
      return value.value.map((element) => plainValue(element.value));
    case "mapping": {
      const mapping: Record<string, unknown> = {};
      for (const entry of value.value) mapping[entry.key] = plainValue(entry.value.value);
      return mapping;
    }
  }
}

/**
 * The addressed edits that turn `before` into `after`.
 *
 * Changes and additions come first, in the callback's own key order, and
 * deletions last in the document's order — a deleted key no longer has a place
 * in the new object, so the old one is the only order left to give it. See the
 * module doc for the four emission rules, why every `key_path` is a segment
 * array, and why a dotted key is refused rather than sent.
 *
 * `path` is the note, and is here only so a refusal can name it: a plugin told
 * "this key cannot be addressed" needs to know which note it was writing.
 */
export function diffFrontMatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
): FrontmatterEditDto[] {
  const edits: FrontmatterEditDto[] = [];
  collect([], before, after, edits, path);
  return edits;
}

function collect(
  prefix: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  edits: FrontmatterEditDto[],
  path: string,
): void {
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const keyPath = [...prefix, key];
    const previous = Object.hasOwn(before, key) ? before[key] : undefined;
    if (isBranch(value) && isBranch(previous)) {
      collect(keyPath, previous, value, edits, path);
      continue;
    }
    if (sameValue(previous, value)) continue;
    guardKeyPath(keyPath, path);
    // A YAML null, written *into* the key. `value: null` would have removed it.
    if (value === null) {
      edits.push({ key_path: keyPath, set_null: true });
      continue;
    }
    guardValue(value, keyPath, path);
    edits.push({ key_path: keyPath, value: value as PatchValueDto });
  }
  for (const key of Object.keys(before)) {
    const stillThere = Object.hasOwn(after, key) && after[key] !== undefined;
    if (stillThere) continue;
    const keyPath = [...prefix, key];
    guardKeyPath(keyPath, path);
    edits.push({ key_path: keyPath, value: null });
  }
}

/** Refuse a key no `key_path` can name. A dot is fine; an empty segment is not. */
function guardKeyPath(keyPath: readonly string[], path: string): void {
  if (keyPath.length > 0 && !keyPath.some((segment) => segment === "")) return;
  throw new UnaddressableFrontmatterKey(path, keyPath);
}

/**
 * Refuse a number JSON cannot carry, at whatever depth it sits.
 *
 * The walk is the point: `fm.stats = { mean: NaN }` sends the whole `stats`
 * subtree, and the `NaN` inside it would reach the daemon as `null` — a
 * perfectly well-formed mapping with a silently emptied field.
 */
function guardValue(value: unknown, keyPath: readonly string[], path: string): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new UnrepresentableFrontmatterValue(path, keyPath, value);
  }
  if (Array.isArray(value)) {
    for (const element of value) guardValue(element, keyPath, path);
    return;
  }
  if (isBranch(value)) {
    for (const nested of Object.values(value)) guardValue(nested, keyPath, path);
  }
}

/** A mapping, and therefore something a dot-path can descend into. */
function isBranch(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality, which is what "the callback did not change this" means. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, at) => sameValue(item, right[at]));
  }
  if (isBranch(left) && isBranch(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

/**
 * One piece of a Markdown destination, percent-encoded.
 *
 * `encodeURI` handles the spaces and the non-ASCII, and leaves `#` and `?`
 * alone because in a URL they are delimiters — which is exactly the problem
 * here, since both are ordinary characters in a vault path. A file literally
 * named `Hash #1.md` produced no reference at all until they were escaped.
 */
function encodeLinkPart(part: string): string {
  return encodeURI(part).replaceAll("#", "%23").replaceAll("?", "%3F");
}

/**
 * A subpath as a URL fragment: one `#`, then the encoded heading or block id.
 *
 * **The block marker `^` is left literal**, and that is measured rather than
 * chosen: `encodeURI` turns it into `%5E`, and while vaultd decodes that back
 * to `^` it then reads the subpath as a *heading* named `^blockid` and answers
 * `missing_subpath`. Written plainly — `Note.md#^blockid`, file part encoded or
 * not — it resolves as a block. Obsidian writes the caret plainly too.
 */
function encodeSubpath(subpath?: string): string {
  if (subpath === undefined || subpath === "") return "";
  const body = subpath.startsWith("#") ? subpath.slice(1) : subpath;
  const block = body.startsWith("^");
  return `#${block ? "^" : ""}${encodeLinkPart(block ? body.slice(1) : body)}`;
}

/** The path of `target` as written from inside `sourceFolder`. */
function relativeFrom(sourceFolder: string, target: string): string {
  const from = sourceFolder === "" ? [] : sourceFolder.split("/");
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const up: string[] = [];
  for (let step = shared; step < from.length; step += 1) up.push("..");
  return [...up, ...to.slice(shared)].join("/");
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * What this surface claims about itself, for Task 11b's compatibility report.
 *
 * Declared at import rather than in the constructor, for the reason
 * `shim/metadata-cache.ts` states: the table is the host's statement about its
 * own surface, so a report path that never assembles a host must not silently
 * omit these rows.
 *
 * `promptForDeletion` is `implemented` — it is a real documented API this host
 * really answers — and records a `safe_stub` *hit* only for the unattended
 * case, which is a fact about that call rather than about the surface.
 */
declarePolicy("FileManager.processFrontMatter", "implemented");
declarePolicy("FileManager.renameFile", "implemented");
declarePolicy("FileManager.generateMarkdownLink", "implemented");
declarePolicy("FileManager.getNewFileParent", "implemented");
declarePolicy("FileManager.getAvailablePathForAttachment", "implemented");
declarePolicy("FileManager.trashFile", "implemented");
declarePolicy("FileManager.createNewFolder", "implemented");
declarePolicy("FileManager.promptForDeletion", "implemented");
declarePolicy("FileManager.promptForFileRename", "absent");
declarePolicy("FileManager.promptForFolderDeletion", "absent");
