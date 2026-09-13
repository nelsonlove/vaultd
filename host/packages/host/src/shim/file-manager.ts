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
 * actually changed. The daemon edits the addressed spans and preserves every
 * byte outside them. A callback that changes nothing sends nothing at all.
 *
 * Three rules decide what a diff emits, and each exists because the alternative
 * is wrong rather than merely different:
 *
 * - A key present before and absent after — deleted, or set to `undefined` —
 *   becomes `{ key_path, value: null }`, which is the mutation spec's deletion
 *   form. An explicit `null` from the callback is therefore also a deletion:
 *   `null` has exactly one meaning on this wire, and it is "remove this key".
 * - A **branch that changed shape** goes whole: an object that became a scalar,
 *   a scalar that became an object, or a new key whose value is a subtree. A
 *   dot-path into a branch that no longer has that shape addresses a span that
 *   does not exist.
 * - An **array goes whole whenever it differs at all**. `key_path` is a path of
 *   *keys* (`docs/protocol.md`: "a dot-path (`a.b.c`) addressing nested keys"),
 *   so there is no spelling for "element 2 of this list" to send even when only
 *   one element moved.
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
 * goes out it asks the mirror for what the mirror already tracks — the
 * referrers of the path about to move — and refetches `from`, `to` and every
 * one of them. The referrer set comes from the same resolved-link index
 * `vaultd` used to find the links it rewrote, so it is a superset of what
 * changed and never a subset; a superset only costs a refetch. Failed rewrites
 * are refetched too, because "the daemon could not rewrite `Busy.md`" and
 * "`Busy.md` is unchanged" are the same statement only if nothing else touched
 * it, which the mirror cannot know without asking.
 *
 * `from` is in that set, and has to be: after the move it holds nothing, the
 * refetch answers it absent, and that is what takes the row out of the mirror.
 * A set that named only the destination would leave a ghost row at the old path
 * until a resync.
 *
 * For a folder the subtree expansion is `Vault`'s — {@link Vault.movedPaths},
 * which Task 7 already built for the same reason — and the referrer set is the
 * union over every note under the folder, computed the same way before the
 * request goes out. `rename_folder` carries **no `expected`**: a folder has no
 * bytes and therefore no revision, and the daemon rejects the field itself with
 * `invalid_request`.
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
        const patch = diffFrontMatter(before, after);
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
    const from = file.path;
    const folder = file instanceof TFolder;
    // Captured BEFORE the mutation: once it lands, `from` no longer exists and
    // its backlink entry is gone with it.
    const moved = folder ? this.deps.vault.movedPaths(from, newPath) : [from, newPath];
    const sources = folder ? [from, ...this.deps.vault.descendantsOf(from)] : [from];
    const affected = new Set<string>(moved);
    for (const source of sources) {
      for (const reference of this.deps.mirror.backlinks(source)) {
        affected.add(reference.source_path);
      }
    }
    const result = await this.deps.writes.send<RenameResponse>(
      folder ? "rename_folder" : "rename_note",
      folder
        ? { from, to: newPath, rewrite_links: true }
        : {
            from,
            to: newPath,
            expected: this.deps.vault.expectedFor(from),
            rewrite_links: true,
          },
    );
    this.lastFailures = result.link_rewrite_failures;
    await this.deps.mirror.applyMutation(result.generation, [...affected]);
  }

  /**
   * The inbound references the most recent rename could **not** repair.
   *
   * Exposed rather than logged so `host.info` and the compatibility report can
   * surface a partial repair; nothing swallows them. Empty after a rename that
   * repaired everything, which is the affirmative answer the protocol's empty
   * list means.
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
   * percent-encodes what a URL must; the display text does neither.
   */
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    recordUse("FileManager.generateMarkdownLink");
    const format = this.linkFormat();
    const tail = subpath ?? "";
    const text = this.linktextFor(file, sourcePath, format, true);
    if (this.deps.vault.getConfig("useMarkdownLinks") !== true) {
      const display = alias === undefined || alias === "" ? "" : `|${alias}`;
      return `[[${text}${tail}${display}]]`;
    }
    const target = encodeURI(this.linktextFor(file, sourcePath, format, false));
    return `[${alias === undefined || alias === "" ? text : alias}](${target}${tail})`;
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

  /** `path` if nothing holds it, else `path` with Obsidian's ` N` suffix. */
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
 * module doc for what goes whole and why.
 */
export function diffFrontMatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FrontmatterEditDto[] {
  const edits: FrontmatterEditDto[] = [];
  collect("", before, after, edits);
  return edits;
}

function collect(
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  edits: FrontmatterEditDto[],
): void {
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const keyPath = prefix === "" ? key : `${prefix}.${key}`;
    const previous = Object.hasOwn(before, key) ? before[key] : undefined;
    if (isBranch(value) && isBranch(previous)) {
      collect(keyPath, previous, value, edits);
      continue;
    }
    if (!sameValue(previous, value)) edits.push({ key_path: keyPath, value: value as PatchValueDto });
  }
  for (const key of Object.keys(before)) {
    const stillThere = Object.hasOwn(after, key) && after[key] !== undefined;
    if (stillThere) continue;
    edits.push({ key_path: prefix === "" ? key : `${prefix}.${key}`, value: null });
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
