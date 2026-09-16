/**
 * `TAbstractFile`, `TFile`, `TFolder`, and the index that keeps them.
 *
 * **Real classes, not structural fakes.** `instanceof TFile` is the corpus's
 * most-used discrimination — thirty-three plugins branch on it — and a plain
 * object with the right fields fails every one of those branches. So these are
 * classes, a plugin's `instanceof` is answered by the prototype chain, and the
 * index hands out the same instances it holds.
 *
 * **Identity is stable across updates.** A modified note keeps its `TFile` and
 * takes a new `stat`; a renamed note keeps its `TFile` and takes a new path.
 * Plugins hold file references across events and key caches by them —
 * tasknotes and breadcrumbs both keep a `Map<TFile, …>` — so swapping the
 * instance for an equal one silently empties those caches.
 *
 * ## Rename synthesis lives here, because the wire has no rename
 *
 * `vaultd`'s `generation_committed` change set is `created` / `modified` /
 * `deleted` and nothing else: the daemon models a move as a delete plus a
 * create, and its `RenameResponse` names no `from`/`to` pair. Obsidian's
 * `vault.on("rename", file, oldPath)` is nonetheless load-bearing — folder-notes'
 * tab manager is a rename handler — so {@link FileIndex.applyBatch} pairs them.
 *
 * Within **one** batch, a deleted path and a created path pair into a rename
 * when both are notes and the created path's new revision equals the deleted
 * path's last-known revision. A move is byte-identical content at a new path,
 * which is exactly what the revision proves.
 *
 * Ambiguity is resolved by refusing to guess: if one revision matches two or
 * more created paths (or two or more deleted paths), none of them pairs and all
 * are reported as a plain delete plus a plain create. A wrong rename fires a
 * handler with an `oldPath` that is a lie, which is worse than a missing one.
 * Cross-batch pairs are never attempted; a move whose halves land in different
 * generations is a delete and a create, which is also what a user watching
 * Obsidian's own event stream would see under the same conditions.
 *
 * ## A folder move pairs its notes and not the folder
 *
 * Pairing is by content revision, and a folder has none — the index stores one
 * for notes alone. So renaming `Folder` to `Folder2` pairs every note under it,
 * each with the right `oldPath`, and reports the two folder rows themselves as
 * a plain delete plus a plain create. Obsidian fires one `rename` for the
 * folder, and folder-notes — the plugin this whole rename path exists for — is
 * a folder plugin.
 *
 * **Task 15 decided, and the decision keeps the two confidence levels apart.**
 * For a **host-initiated** move the folder pair is known exactly, at the call
 * site that sent `rename_folder`: `Vault.rename` and `FileManager.renameFile`
 * record both ends, the lifecycle sequencer drains that record when the batch
 * arrives, and it hands the pairs down as {@link ApplyBatchOptions.renames} —
 * so the folder keeps its `TFolder` instance and fires one `vault.on("rename")`
 * like every other move. For an **external** one there is no record and nothing
 * here infers one: the descendants pair by revision as they always did, and the
 * folder row itself is reported as a plain delete plus a plain create. Which of
 * the two Obsidian does for the folder *object* under an external move is
 * uncaptured, so this host does not guess at it.
 */

import type { DryRunOverlay } from "../dryrun/dry-run";
import type { MirrorChangeBatch, MirrorEntry, MirrorQuery } from "../mirror/types";
import type { Vault } from "./vault";

export abstract class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null;
  vault: Vault;

  constructor(vault: Vault, path: string, name: string, parent: TFolder | null) {
    this.vault = vault;
    this.path = path;
    this.name = name;
    this.parent = parent;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(
    vault: Vault,
    path: string,
    name: string,
    parent: TFolder | null,
    stat: { ctime: number; mtime: number; size: number },
  ) {
    super(vault, path, name, parent);
    const split = splitName(name);
    this.basename = split.basename;
    this.extension = split.extension;
    this.stat = stat;
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  /**
   * Obsidian's own test is a path test, and so is this one.
   *
   * Not "has no parent": a folder the mirror will never hold — the config zone
   * folder a plugin host creates for a plugin's own data — is handed back
   * parentless because there is no tree to hang it in, and it is emphatically
   * not the vault root.
   */
  isRoot(): boolean {
    return this.path === ROOT_PATH;
  }
}

/**
 * What one applied batch did to the tree, in the shape Task 15's sequencer
 * turns into events.
 *
 * **One path can be in both {@link created} and {@link deleted}**, and that
 * pairing means a replacement: the thing that was there was removed and a
 * *different* thing took its name. It arrives two ways — Ruling W6's
 * created-and-deleted change set, and a `modified` path whose kind changed,
 * which is the spelling the real wire uses — and the sequencer replays both the
 * same way, delete first. The two entries are different instances.
 */
export interface AppliedBatch {
  created: TAbstractFile[];
  modified: TFile[];
  deleted: TAbstractFile[];
  /** Synthesized: see the module doc. `file` is the SAME instance that used to be at `from`. */
  renamed: Array<{ from: string; to: string; file: TAbstractFile }>;
}

/**
 * How a batch departs from what the mirror can answer on its own.
 *
 * The mirror is the source of a row's `stat`, and for every path a *real* batch
 * names the row is already installed by the time the batch fires. A test that
 * pushes a batch through the shim without moving the mirror underneath it has
 * no such row, so it says what the size became; nothing else needs this.
 */
export interface ApplyBatchOptions {
  sizes?: Readonly<Record<string, number>>;
  /**
   * Moves the **caller already knows about**, paired without consulting a
   * revision.
   *
   * Revision pairing cannot see a folder move: a folder has no content
   * revision, so `Folder` → `Folder2` reaches the index as a plain delete and a
   * plain create however obviously it is one move (see the module header). A
   * *host-initiated* move is the one case where the pair is known exactly — the
   * shim itself sent `rename_folder` and recorded both ends — so the sequencer
   * hands those pairs down here rather than leaving the index to guess.
   *
   * **A pair is honoured only when the batch really names both ends**: `from`
   * in `deleted`, `to` in `created`. A recorded move whose batch never arrived
   * (the mutation escalated to a resync, say) therefore pairs nothing rather
   * than moving a node the mirror has not moved.
   *
   * These are applied **before** the revision-paired ones and shallowest first,
   * so a moved folder is in the tree by the time its descendants re-parent into
   * it — otherwise each descendant would materialise a second folder at the new
   * path and the original `TFolder` instance a plugin is holding would be
   * orphaned.
   */
  renames?: readonly { from: string; to: string }[];
}

/** The vault root's path, as Obsidian spells it. */
const ROOT_PATH = "/";

export class FileIndex {
  private readonly nodes = new Map<string, TAbstractFile>();
  private rootFolder: TFolder;
  /**
   * Paths in {@link nodes} that no mirror row backs — Task 19b's dry-run
   * overlay, materialized.
   *
   * Tracked separately from the nodes themselves so that {@link dropSynthetic}
   * can take exactly them out again when the overlay is cleared, leaving the
   * mirror's own tree untouched. A node is in here or it is the daemon's; there
   * is no third kind.
   */
  private readonly synthetic = new Set<string>();
  /**
   * Removal roots whose node this index has taken out of its parent's
   * `children` — Task 19b fix round 1, review finding I3.
   *
   * A dry-run delete may not splice the node out of {@link nodes}: a later real
   * batch looks it up there to fire the `delete` event, and a node that had
   * quietly vanished would fire none. But leaving it in its parent's `children`
   * hands a plugin walking that folder a `TFile` whose `read` throws
   * `not_found` and whose path `getFileByPath` denies — the self-contradiction
   * the overlay exists to prevent, on a public field. So the node stays in
   * `nodes` and leaves `children`, and this set is what puts it back if the
   * overlay is cleared.
   */
  private readonly masked = new Set<string>();
  /** The overlay {@link version} this index last reconciled against. */
  private reconciled = -1;

  constructor(
    private readonly mirror: MirrorQuery,
    private readonly vault: Vault,
    /**
     * What a dry run pretends exists, or `null` in every real run.
     *
     * The index consults it **after** the mirror for a node, so a path the
     * daemon really holds is never shadowed by a synthetic one, and treats an
     * overlaid removal as authoritative — the precedence
     * `dryrun/dry-run.ts` states. Nothing here is ever written into the mirror.
     */
    private readonly overlay: DryRunOverlay | null = null,
  ) {
    this.rootFolder = new TFolder(vault, ROOT_PATH, "", null);
  }

  /**
   * Build the whole tree from the mirror, discarding what was there.
   *
   * Entries are walked path-sorted so a parent folder always exists before its
   * children, and a missing intermediate folder is materialized anyway:
   * `vaultd` reports folders, and a defensive `ensureFolder` is what keeps a
   * sparse tree from producing a `TFile` with a null parent.
   */
  rebuild(): void {
    this.nodes.clear();
    this.synthetic.clear();
    this.masked.clear();
    this.reconciled = -1;
    this.rootFolder = new TFolder(this.vault, ROOT_PATH, "", null);
    const entries = [...this.mirror.entries()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const entry of entries) this.install(entry);
  }

  /**
   * Apply one change batch and report what it did.
   *
   * Four passes, in this order:
   *
   * 1. Pair renames, and re-parent those instances in place.
   * 2. Splice out the remaining deleted paths.
   * 3. Attach the remaining created paths.
   * 4. Re-stat the modified ones — **except one whose kind changed**, which is
   *    a replacement and comes out as a delete plus a create.
   *
   * **Deletes run before creates**, which is the opposite of the order a
   * reader might expect and is required by Ruling W6: a folder replaced by a
   * file of the same name arrives as that path in *both* lists, and the two
   * steps have to be replayed in that order or the create is immediately
   * undone by the delete.
   */
  applyBatch(batch: MirrorChangeBatch, options: ApplyBatchOptions = {}): AppliedBatch {
    const applied: AppliedBatch = { created: [], modified: [], deleted: [], renamed: [] };
    const renamedFrom = new Set<string>();
    const renamedTo = new Set<string>();

    for (const pair of this.renamePairs(batch, options)) {
      const file = this.nodes.get(pair.from);
      if (file === undefined) continue;
      this.detach(file);
      this.nodes.delete(pair.from);
      file.path = pair.to;
      file.name = basenameOf(pair.to);
      if (file instanceof TFile) {
        const split = splitName(file.name);
        file.basename = split.basename;
        file.extension = split.extension;
        const stat = this.statFor(pair.to, batch, options);
        if (stat !== null) file.stat = stat;
      }
      file.parent = this.ensureFolder(parentOf(pair.to));
      file.parent.children.push(file);
      this.nodes.set(pair.to, file);
      applied.renamed.push({ from: pair.from, to: pair.to, file });
      renamedFrom.add(pair.from);
      renamedTo.add(pair.to);
    }

    for (const path of batch.deleted) {
      if (renamedFrom.has(path)) continue;
      const node = this.nodes.get(path);
      if (node === undefined) continue;
      this.detach(node);
      this.nodes.delete(path);
      applied.deleted.push(node);
    }

    // **Before the creates, and that ordering is load-bearing.** A path whose
    // kind changed is a replacement (see below); if the batch also creates
    // something *inside* the new folder — `Swap` becomes a folder and
    // `Swap/Inner.md` appears with it — then materializing that child first
    // makes `ensureFolder` meet a `TFile` at `Swap`, quietly put a fresh
    // `TFolder` over it, and leave nothing for this pass to notice. The old
    // node then left the tree with no event at all.
    //
    // **A path whose kind changed is a replacement, not a modification**, and
    // this is the spelling the real wire uses. Ruling W6 describes a path in
    // `created` and `deleted` at once; a folder replaced by a file of the same
    // name reaches this host as `modified` every time it was measured, and
    // `Mirror.synthesizeDiff` structurally cannot report it any other way,
    // because it compares one stamp per path. Left as a modification it fell
    // through the `TFile` test in the modified pass: no event reached any
    // plugin, and the tree kept a `TFolder` at a path the daemon says is a file
    // for the rest of the session.
    //
    // So it is reported as the same two steps W6 asks for — a delete of the old
    // node and a create of a new one — and the instance really is new, because
    // identity is a promise about *this file* and the file is gone.
    const replacedPaths = new Set<string>();
    for (const path of batch.modified) {
      const held = this.nodes.get(path);
      const entry = this.mirror.entry(path);
      if (held === undefined || entry === undefined || !changedKind(held, entry)) continue;
      replacedPaths.add(path);
      this.detach(held);
      this.nodes.delete(path);
      applied.deleted.push(held);
      const replacement = this.materialize(path, batch, options);
      if (replacement !== null) applied.created.push(replacement);
    }

    for (const path of batch.created) {
      if (renamedTo.has(path)) continue;
      const node = this.materialize(path, batch, options);
      if (node !== null) applied.created.push(node);
    }

    for (const path of batch.modified) {
      if (replacedPaths.has(path)) continue;
      const node = this.nodes.get(path) ?? this.materialize(path, batch, options);
      if (!(node instanceof TFile)) continue;
      const stat = this.statFor(path, batch, options);
      if (stat !== null) node.stat = stat;
      applied.modified.push(node);
    }

    return applied;
  }

  /**
   * Reconcile one path against the mirror: create it, re-stat it, or drop it.
   *
   * This is read-your-writes for the host's own mutations. `Vault.create`
   * returns the `TFile` a plugin then holds, and the only place that instance
   * can come from is the index — so after the mirror has been moved to the
   * generation the write landed in, the written path is synchronized here
   * rather than waiting for Task 15's sequencer to deliver the batch.
   */
  sync(path: string): TAbstractFile | null {
    this.reconcileOverlay();
    const entry = this.mirror.entry(path);
    if (entry === undefined) {
      // **The overlay's answer, after the mirror's and only after it.** Under
      // `--dry-run` the mirror never moves, so every path the run created,
      // copied or renamed into lands here — and `Vault.create` is about to
      // demand the `TFile` it promised its caller. `reconcileOverlay` has
      // already put the node in the tree, so this is a lookup rather than a
      // second materialization.
      if (this.overlay?.removed(path) !== true && this.synthetic.has(path)) {
        return this.nodes.get(path) ?? null;
      }
      const gone = this.nodes.get(path);
      if (gone !== undefined) {
        this.detach(gone);
        this.nodes.delete(path);
        this.synthetic.delete(path);
      }
      return null;
    }
    if (this.overlay?.removed(path) === true) return null;
    const existing = this.nodes.get(path);
    if (existing instanceof TFile) {
      existing.stat = statOfEntry(entry);
      return existing;
    }
    if (existing !== undefined) return existing;
    return this.install(entry);
  }

  /**
   * A `TFolder` for a path this index will never hold a row for.
   *
   * The config zone is not indexed, so `create_folder` there answers no
   * generation and the mirror never learns of it — but a plugin host has to
   * make `<configDir>/plugins/<id>/` and Obsidian hands back a `TFolder` when
   * it does. This is that folder: real enough to carry a path and a name, not
   * in the tree, and not the root (see {@link TFolder.isRoot}).
   */
  detachedFolder(path: string): TFolder {
    return new TFolder(this.vault, path, basenameOf(path), null);
  }

  /**
   * Bring the tree in line with the overlay now, rather than at the next
   * accessor.
   *
   * @internal Host seam. Every *read* of this index reconciles on its way in,
   * which is enough for everything the index answers itself — but `children` is
   * a plain public field on a `TFolder` a plugin is already holding, and a
   * plugin that deletes a note and then walks the folder reads that array
   * without asking this class anything. So the two mutation paths that do not
   * already `sync` a path — `Vault.rename` and `Vault.remove`, which leave the
   * tree to the batch, and under `--dry-run` no batch comes — call this
   * instead. A no-op in every real run: there is no overlay to reconcile
   * against.
   */
  refresh(): void {
    this.reconcileOverlay();
  }

  get(path: string): TAbstractFile | undefined {
    if (path === ROOT_PATH || path === "") return this.rootFolder;
    this.reconcileOverlay();
    if (this.overlay?.removed(path) === true) return undefined;
    return this.nodes.get(path);
  }

  root(): TFolder {
    this.reconcileOverlay();
    return this.rootFolder;
  }

  allFiles(): TFile[] {
    const files: TFile[] = [];
    for (const node of this.live()) if (node instanceof TFile) files.push(node);
    return files;
  }

  allFolders(): TFolder[] {
    const folders: TFolder[] = [];
    for (const node of this.live()) if (node instanceof TFolder) folders.push(node);
    return folders;
  }

  allLoaded(): TAbstractFile[] {
    return [...this.live()];
  }

  // --- Internals ------------------------------------------------------------

  /**
   * The nodes a caller may see: every node, less the ones a dry run removed.
   *
   * **A removed node is filtered rather than spliced out**, which is the one
   * asymmetry in how the overlay meets the tree. A synthetic *create* really is
   * attached, because a plugin is meant to hold the `TFolder` and read its
   * `children`; a removal is masked, because taking a mirror-backed node out of
   * `nodes` would leave a later batch — an external delete of the same path, a
   * resync — with nothing to fire a `delete` event about. The visible cost is
   * that a deleted file is still in its parent's `children` array for the rest
   * of the run; the alternative loses a real event, and the mirror is the thing
   * this index may never be wrong about.
   */
  private live(): TAbstractFile[] {
    this.reconcileOverlay();
    const overlay = this.overlay;
    const nodes = [...this.nodes.values()];
    return overlay === null ? nodes : nodes.filter((node) => !overlay.removed(node.path));
  }

  /**
   * Bring the synthetic nodes into line with the overlay: attach what it now
   * holds, detach what it no longer does.
   *
   * Idempotent, and cheap when nothing has changed — the overlay's `version()`
   * is a single integer that every record and every `clear()` bumps, and this
   * is called from every accessor, including the ones link resolution walks per
   * link.
   *
   * A path the **mirror** holds a row for is never synthesized: the daemon's
   * row wins for the node, exactly as the overlay's bytes win for a read.
   */
  private reconcileOverlay(): void {
    const overlay = this.overlay;
    if (overlay === null) return;
    const version = overlay.version();
    if (version === this.reconciled) return;
    this.reconciled = version;
    const wanted = this.overlayWanted(overlay);

    // Deepest first, so a folder leaves the tree after its children do.
    for (const path of [...this.synthetic].sort((a, b) => depthOf(b) - depthOf(a))) {
      if (wanted.has(path)) continue;
      const node = this.nodes.get(path);
      if (node !== undefined) {
        this.detach(node);
        this.nodes.delete(path);
      }
      this.synthetic.delete(path);
      this.masked.delete(path);
      // **The daemon may have overtaken this path, and then the row is its.**
      // `overlayWanted` stops wanting a path the moment the mirror holds a row
      // for it, so without this the one thing that really exists — the node the
      // daemon produced — would be evicted from the index and stay evicted for
      // the rest of the run, invisible to `getFiles` while `adapter.exists`
      // still answered `true` off the mirror. Measured in review finding B1
      // against the real daemon, on the daily-notes shape this task exists for.
      const real = this.mirror.entry(path);
      if (real !== undefined) this.install(real);
    }

    // Shallowest first, so a parent exists before anything hangs off it.
    const order = [...wanted.keys()].sort(
      (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const path of order) {
      if (this.nodes.has(path)) continue;
      this.installSynthetic(path, wanted.get(path) ?? "file", overlay.contentOf(path));
    }

    this.reconcileMasked(overlay);
  }

  /**
   * Take a removed path's node out of its parent's `children`, and put it back
   * if the overlay stops saying it is gone.
   *
   * **The removal roots only**, which is all the tree needs: everything under a
   * removed folder leaves with it, because the subtree hangs off the node that
   * has just been detached, and `get`/`live` mask descendants by prefix anyway.
   * It is also what keeps the cost proportional to how many paths this run
   * deleted rather than to how many the vault holds.
   *
   * The node itself stays in {@link nodes} — see {@link masked} — and
   * `applyBatch`'s own `detach` is idempotent (`indexOf` answers `-1` and
   * nothing is spliced), so a later real delete of the same path still fires
   * its event.
   */
  private reconcileMasked(overlay: DryRunOverlay): void {
    for (const root of overlay.removedPaths()) {
      if (this.masked.has(root) || !overlay.removed(root)) continue;
      const node = this.nodes.get(root);
      if (node === undefined) continue;
      this.detach(node);
      this.masked.add(root);
    }
    for (const root of [...this.masked]) {
      if (overlay.removed(root)) continue;
      const node = this.nodes.get(root);
      // Re-attached rather than re-created, so a plugin still holding the
      // `TFile` from before the delete is holding the node that comes back.
      if (node?.parent != null && !node.parent.children.includes(node)) {
        node.parent.children.push(node);
      }
      this.masked.delete(root);
    }
  }

  /**
   * Every path the overlay wants in the tree, **with its missing ancestors**.
   *
   * The ancestors matter because the daemon makes a write's parent folders
   * implicitly: a dry-run `create("New/Deep/A.md")` records one path, and a tree
   * that materialized only that one would hang it off a `TFolder` nobody tracks
   * and nobody takes away again on `clear()`.
   */
  private overlayWanted(overlay: DryRunOverlay): Map<string, "file" | "folder"> {
    const wanted = new Map<string, "file" | "folder">();
    for (const path of overlay.paths()) {
      if (this.mirror.entry(path) !== undefined) continue;
      const row = overlay.entry(path);
      if (row === null) continue;
      wanted.set(path, row.kind);
      for (let at = parentOf(path); at !== "" && at !== ROOT_PATH; at = parentOf(at)) {
        if (this.mirror.entry(at) !== undefined || wanted.has(at)) break;
        wanted.set(at, "folder");
      }
    }
    return wanted;
  }

  /**
   * One synthetic node, in the tree.
   *
   * The `stat` of a synthetic file is the recorded byte length and **zero
   * times**: a dry run writes nothing, so there is no ctime and no mtime to
   * report, and inventing `Date.now()` would make two runs of one fixture
   * differ. The same reasoning as {@link synthesizeStat}'s, which uses the
   * generation for the same reason.
   */
  private installSynthetic(
    path: string,
    kind: "file" | "folder",
    content: string | Uint8Array | null,
  ): void {
    const parent = this.ensureFolder(parentOf(path));
    const name = basenameOf(path);
    const node: TAbstractFile =
      kind === "folder"
        ? new TFolder(this.vault, path, name, parent)
        : new TFile(this.vault, path, name, parent, {
            ctime: 0,
            mtime: 0,
            size: byteLengthOf(content),
          });
    parent.children.push(node);
    this.nodes.set(path, node);
    this.synthetic.add(path);
  }

  /**
   * Every pair this batch is to replay as a move: the caller's own first, then
   * the ones the revisions prove.
   *
   * The caller's are the host-initiated folder moves (see
   * {@link ApplyBatchOptions.renames}) and they are filtered against the batch
   * rather than trusted: a pair whose ends the batch does not name is dropped,
   * and so is one whose `from` a revision pair has already claimed — two rules
   * that between them make a stale record inert instead of wrong.
   *
   * Shallowest first, so a folder is at its new path before anything under it
   * re-parents into it.
   */
  private renamePairs(
    batch: MirrorChangeBatch,
    options: ApplyBatchOptions,
  ): Array<{ from: string; to: string }> {
    const known = options.renames ?? [];
    if (known.length === 0) return this.pairRenames(batch);
    const created = new Set(batch.created);
    const deleted = new Set(batch.deleted);
    const explicit = known
      .filter((pair) => pair.from !== pair.to && deleted.has(pair.from) && created.has(pair.to))
      .sort((a, b) => depthOf(a.from) - depthOf(b.from));
    const claimed = new Set(explicit.map((pair) => pair.from));
    const alsoClaimed = new Set(explicit.map((pair) => pair.to));
    return [
      ...explicit,
      ...this.pairRenames(batch).filter(
        (pair) => !claimed.has(pair.from) && !alsoClaimed.has(pair.to),
      ),
    ];
  }

  /**
   * The delete/create pairs this batch's revisions prove are moves.
   *
   * A path named by both lists is excluded from both sides: that is the
   * folder-replaced-by-a-file case, where pairing would marry a path to itself.
   */
  private pairRenames(batch: MirrorChangeBatch): Array<{ from: string; to: string }> {
    const alsoCreated = new Set(batch.created);
    const alsoDeleted = new Set(batch.deleted);
    const goneByRevision = new Map<string, string[]>();
    for (const path of batch.deleted) {
      if (alsoCreated.has(path)) continue;
      if (!isNotePath(path)) continue;
      // The row is already gone by the time a real batch fires, which is why
      // `MirrorChangeBatch.revisions` carries a deleted path's last-known
      // revision. The mirror lookup is the fallback for a batch pushed through
      // the shim without the mirror having moved.
      const revision = batch.revisions[path] ?? this.mirror.entry(path)?.revision ?? null;
      if (revision === null) continue;
      append(goneByRevision, revision, path);
    }
    if (goneByRevision.size === 0) return [];

    const madeByRevision = new Map<string, string[]>();
    for (const path of batch.created) {
      if (alsoDeleted.has(path)) continue;
      if (!isNotePath(path)) continue;
      const revision = batch.revisions[path] ?? this.mirror.entry(path)?.revision ?? null;
      if (revision === null) continue;
      append(madeByRevision, revision, path);
    }

    const pairs: Array<{ from: string; to: string }> = [];
    for (const [revision, gone] of goneByRevision) {
      const made = madeByRevision.get(revision);
      // Exactly one of each, or nothing: two candidates on either side is an
      // ambiguity, and the honest report of an ambiguity is no rename at all.
      if (made === undefined || made.length !== 1 || gone.length !== 1) continue;
      const from = gone[0];
      const to = made[0];
      if (from === undefined || to === undefined || from === to) continue;
      pairs.push({ from, to });
    }
    return pairs;
  }

  /** Build the node for a path this batch created, from whatever is known. */
  private materialize(
    path: string,
    batch: MirrorChangeBatch,
    options: ApplyBatchOptions,
  ): TAbstractFile | null {
    const existing = this.nodes.get(path);
    if (existing !== undefined) {
      // **A real row beats a synthetic node at the same path.** Otherwise the
      // `create` event this batch is about to fire hands the plugin the dry
      // run's pretend `TFile` — `{ctime: 0, mtime: 0}` and the run's own byte
      // count — for a file the daemon really made, while `adapter.stat` already
      // answers the real one. Review finding B1's first contradiction. The
      // instance is replaced because the pretend file and the real file are not
      // the same file; identity is a promise about one file, and this path now
      // has a different one.
      if (!this.synthetic.has(path)) return existing;
      const real = this.mirror.entry(path);
      if (real === undefined) return existing;
      this.detach(existing);
      this.nodes.delete(path);
      this.synthetic.delete(path);
      this.masked.delete(path);
      return this.install(real);
    }
    const entry = this.mirror.entry(path);
    if (entry !== undefined) return this.install(entry);
    return this.install(synthesizeEntry(path, batch, options));
  }

  /** Put one mirror row in the tree, materializing its ancestors if need be. */
  private install(entry: MirrorEntry): TAbstractFile {
    const parent = this.ensureFolder(entry.parent);
    const node: TAbstractFile =
      entry.kind === "folder"
        ? new TFolder(this.vault, entry.path, entry.name, parent)
        : new TFile(this.vault, entry.path, entry.name, parent, statOfEntry(entry));
    parent.children.push(node);
    this.nodes.set(entry.path, node);
    return node;
  }

  private ensureFolder(path: string): TFolder {
    if (path === "" || path === ROOT_PATH) return this.rootFolder;
    const existing = this.nodes.get(path);
    if (existing instanceof TFolder) return existing;
    const parent = this.ensureFolder(parentOf(path));
    const folder = new TFolder(this.vault, path, basenameOf(path), parent);
    parent.children.push(folder);
    this.nodes.set(path, folder);
    return folder;
  }

  private detach(node: TAbstractFile): void {
    const parent = node.parent;
    if (parent === null) return;
    const at = parent.children.indexOf(node);
    if (at !== -1) parent.children.splice(at, 1);
  }

  private statFor(
    path: string,
    batch: MirrorChangeBatch,
    options: ApplyBatchOptions,
  ): { ctime: number; mtime: number; size: number } | null {
    const entry = this.mirror.entry(path);
    const size = options.sizes?.[path];
    if (entry === undefined) {
      if (size === undefined) return null;
      const previous = this.nodes.get(path);
      const base = previous instanceof TFile ? previous.stat : synthesizeStat(batch);
      return { ctime: base.ctime, mtime: base.mtime, size };
    }
    const stat = statOfEntry(entry);
    return size === undefined ? stat : { ...stat, size };
  }
}

function statOfEntry(entry: MirrorEntry): { ctime: number; mtime: number; size: number } {
  return { ctime: entry.ctimeMs, mtime: entry.mtimeMs, size: entry.size ?? 0 };
}

/** How big a synthetic file says it is: the bytes the dry run recorded, or none. */
function byteLengthOf(content: string | Uint8Array | null): number {
  if (content === null) return 0;
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

/**
 * A row for a path the mirror has no row for.
 *
 * Only reachable from a batch pushed through the shim without the mirror having
 * moved under it, which is a test. It is here rather than in the test so that
 * the one place that decides what a row without a row looks like is the same
 * place that decides what a row looks like.
 */
function synthesizeEntry(
  path: string,
  batch: MirrorChangeBatch,
  options: ApplyBatchOptions,
): MirrorEntry {
  const stat = synthesizeStat(batch);
  const revision = batch.revisions[path] ?? null;
  return {
    path,
    // A revision is the batch's own word for "this is a note": only a note has
    // one. The extension is the fallback for a batch that carried none.
    kind: revision !== null || isNotePath(path) ? "note" : "file",
    name: basenameOf(path),
    parent: parentOf(path),
    revision,
    size: options.sizes?.[path] ?? 0,
    ctimeMs: stat.ctime,
    mtimeMs: stat.mtime,
  };
}

function synthesizeStat(batch: MirrorChangeBatch): { ctime: number; mtime: number; size: number } {
  // The generation, not a wall clock: a `stat` invented from `Date.now()` would
  // make two runs of the same fixture differ, and nothing reads these as times.
  return { ctime: batch.generation, mtime: batch.generation, size: 0 };
}

function append(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
}

function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * Does this node's kind disagree with the row the mirror now holds?
 *
 * Folder-ness is the whole of the question: a `TFolder` has children and no
 * `stat`, a `TFile` has a `stat` and no children, and nothing else about a row's
 * kind changes what class the shim hands a plugin. A note that becomes an
 * attachment is still a `TFile`.
 */
function changedKind(node: TAbstractFile, entry: MirrorEntry): boolean {
  return node instanceof TFolder !== (entry.kind === "folder");
}

/** How many separators a path has — its depth below the vault root. */
function depthOf(path: string): number {
  let depth = 0;
  for (const character of path) if (character === "/") depth += 1;
  return depth;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function basenameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Obsidian's split: everything before the last dot is the basename, everything
 * after it is the extension. A leading dot is part of the basename, so
 * `.gitignore` has no extension rather than being an extensionless nothing.
 */
function splitName(name: string): { basename: string; extension: string } {
  const cut = name.lastIndexOf(".");
  if (cut <= 0) return { basename: name, extension: "" };
  return { basename: name.slice(0, cut), extension: name.slice(cut + 1) };
}
