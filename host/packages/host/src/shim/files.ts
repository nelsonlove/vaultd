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
 */

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
}

/** The vault root's path, as Obsidian spells it. */
const ROOT_PATH = "/";

export class FileIndex {
  private readonly nodes = new Map<string, TAbstractFile>();
  private rootFolder: TFolder;

  constructor(
    private readonly mirror: MirrorQuery,
    private readonly vault: Vault,
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
   * 4. Re-stat the modified ones.
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

    for (const pair of this.pairRenames(batch)) {
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

    for (const path of batch.created) {
      if (renamedTo.has(path)) continue;
      const node = this.materialize(path, batch, options);
      if (node !== null) applied.created.push(node);
    }

    for (const path of batch.modified) {
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
    const entry = this.mirror.entry(path);
    if (entry === undefined) {
      const gone = this.nodes.get(path);
      if (gone !== undefined) {
        this.detach(gone);
        this.nodes.delete(path);
      }
      return null;
    }
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

  get(path: string): TAbstractFile | undefined {
    if (path === ROOT_PATH || path === "") return this.rootFolder;
    return this.nodes.get(path);
  }

  root(): TFolder {
    return this.rootFolder;
  }

  allFiles(): TFile[] {
    const files: TFile[] = [];
    for (const node of this.nodes.values()) if (node instanceof TFile) files.push(node);
    return files;
  }

  allFolders(): TFolder[] {
    const folders: TFolder[] = [];
    for (const node of this.nodes.values()) if (node instanceof TFolder) folders.push(node);
    return folders;
  }

  allLoaded(): TAbstractFile[] {
    return [...this.nodes.values()];
  }

  // --- Internals ------------------------------------------------------------

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
    if (existing !== undefined) return existing;
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
