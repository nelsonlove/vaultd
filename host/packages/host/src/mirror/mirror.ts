/**
 * The mirror: one hydrated view of the vault, kept current by deltas, and the
 * only read surface the shim is allowed to use.
 *
 * Hydration (Task 5) fills it once. Everything here is what happens next —
 * applying a committed generation, refetching what moved, resynchronizing when
 * the daemon says per-path detail is unavailable, and answering the synchronous
 * questions Obsidian's API asks. Obsidian's `Vault` and `MetadataCache` are
 * synchronous to the last method, and no plugin will await them, so the whole
 * point of this class is that the answer is already in memory.
 *
 * ---
 *
 * ## The refetch path is `get_note` + `get_tree_entries`, not a snapshot
 *
 * A delta costs one `get_tree_entries` batch for every changed path plus one
 * `get_note` per changed **note**, and nothing else. Two calls, two reasons:
 *
 * - `get_tree_entries { paths }` answers the tree row — `size`, `mtime`,
 *   `ctime`, `kind`, `revision` — which `get_note` does not carry and which
 *   `TFile.stat` is served from. A path with no row lands in `absent` rather
 *   than raising, so "it was deleted again before the refetch landed" is an
 *   answer rather than a failure.
 * - `get_note { path, include: ["sections", "list_items"] }` answers the
 *   semantic row. `include` names exactly the two facets that are optional on
 *   `NoteDto`; the rest are unconditional fields, and naming one of them is
 *   `invalid_request`.
 *
 * A **deleted** path needs no fetch at all: the mirror already knows everything
 * it is about to forget.
 *
 * ## The three rules a change set is applied under
 *
 * All three come from `docs/protocol.md` §Events by way of `client/events.ts`,
 * and every one of them is silent when broken.
 *
 * 1. **`deleted` applies before `created`.** One path may be in both lists in
 *    one generation, and the pairing means the thing there was removed and a
 *    *different* thing was created in its place. Apply `created` first and the
 *    delete wipes out the row that was just installed.
 * 2. **A deleted folder implies its whole subtree.** A watcher-driven delete
 *    names the folder alone; a full reconciliation names the folder *and* every
 *    descendant. Only a consumer that applies the subtree rule gets the same
 *    state from both.
 * 3. **`affected_note_count` counts notes only.** It can never size tree work:
 *    a generation that moved only the file tree reports zero affected notes
 *    with its paths still spelled out.
 *
 * ## Two generations, and why one number could not do the job
 *
 * A refetch for generation 6 is answered at whatever generation is *published*
 * when it lands, which may be later — the daemon has no way to answer "as of
 * 6", and would not want one. So the mirror keeps two numbers:
 *
 * - {@link Mirror.generation} — the highest generation any row was fetched at.
 *   It is what the mirror **holds**, it never moves backwards, and it is the
 *   number a caller means by "how current is this?".
 * - {@link Mirror.appliedThrough} — the highest generation whose *change set*
 *   has been applied. It is the staleness guard: an event at or below it is a
 *   no-op, which is what makes a shim write's own `generation_committed` echo
 *   free (`applyMutation` already installed those rows) and what makes a
 *   replayed event idempotent.
 *
 * Collapsing the two would lose events. If a refetch for generation 6 were
 * served at 9 and the mirror then claimed to have *applied* 9, the change sets
 * for 7 and 8 — which moved other paths, never fetched — would be dropped as
 * stale and those paths would stay wrong until the next resync. Keeping them
 * apart costs one number and loses nothing: re-applying a generation whose rows
 * are already current refetches them and installs the same bytes.
 *
 * ## A batch reports a change, so an apply that changed nothing reports nothing
 *
 * `applyMutation` refetches even when the subscription has already applied the
 * same generation, because read-your-writes must never be a maybe — and which
 * of the two arrives first is a genuine race, measured against the real daemon.
 * Emitting on both would hand the plugin that did the writing two identical
 * `changed` events. So a batch is emitted only when a row actually moved:
 * created, removed, or a changed stamp. Obsidian fires nothing for a write that
 * changed nothing either.
 *
 * ## Resync is one path, and every reason takes it
 *
 * `counts_only`, an unrecognized change-set kind, a change set larger than
 * {@link HostConfig.mirrorDeltaPathLimit}, and **every** `resync_required`
 * reason — known, unknown, or the supervisor's synthesized `runtime_recovered`
 * after an engine restart — all mean the same thing: this mirror cannot get to
 * the current state one path at a time. So it re-hydrates into a **staging**
 * state and swaps on commit. The old mirror answers every query until the swap,
 * so a reader never sees a torn view, and a re-hydration that fails leaves the
 * previous view intact. The reason is recorded ({@link Mirror.lastResyncReason})
 * for the compatibility report and is never branched on.
 */

import { VaultdError } from "../client/errors";
import { EngineLostError } from "../supervisor";
import { isKnownChangeSet, isKnownRuntimeEvent } from "../client/protocol";
import { buildPositionIndex } from "./positions";
import { hydrateInto, mirrorEntry } from "./hydrate";
import type { VaultdClient } from "../client/client";
import type { HostConfig } from "../config";
import type {
  ConfigChangedEventDto,
  GenerationCauseDto,
  GenerationCommittedEventDto,
  GetNoteFacetDto,
  GetNoteResponse,
  GetTreeEntriesResponse,
  NoteDto,
  ReadFileResponse,
  ReferenceDto,
  ResyncReasonDto,
  RuntimeEventDto,
  TreeEntryDto,
} from "../client/protocol";
import type { PositionIndex } from "./positions";
import type {
  MirrorChangeBatch,
  MirrorEntry,
  MirrorNoteRow,
  MirrorQuery,
  MirrorSink,
} from "./types";

/**
 * The facets a refetch asks `get_note` for.
 *
 * Exactly the two that are optional on `NoteDto`. Everything else the mirror
 * keeps — properties, aliases, headings, blocks, tags, diagnostics, outgoing —
 * is an unconditional field of the response, and naming one here would be
 * `invalid_request` rather than a redundant ask.
 */
export const REFETCH_FACETS: readonly GetNoteFacetDto[] = ["sections", "list_items"];

/**
 * How many paths one `get_tree_entries` may name.
 *
 * The transport's detail limit, and the daemon answers `invalid_request` above
 * it rather than truncating — so the batching is this host's job.
 */
export const TREE_ENTRIES_PATH_LIMIT = 1024;

/** A `MirrorQuery` plus everything only the owner of the mirror may call. */
export type MirrorClientSource = VaultdClient | (() => VaultdClient);

/** Why a refetch could not be turned into a row. */
export type MirrorRefetchReason = "facet_missing";

/**
 * The daemon answered a refetch with less than it was asked for.
 *
 * Only one reason today, and it is the one Task 5 carried forward: `get_note`'s
 * `sections` and `list_items` are **absent unless requested and `[]` when
 * requested with nothing to report**, so a refetch that named them and got
 * neither has not been served. Defaulting to `[]` there would put a note with
 * no structure into the mirror, silently and permanently — Task 8 would build a
 * `CachedMetadata` with no sections from it and no plugin could tell.
 *
 * Unlike hydration's own converter, where every facet is asked for and an
 * absence means the same thing, this is a distinction the wire deliberately
 * preserves, so this is the one place the mirror tests `=== undefined`.
 */
export class MirrorRefetchError extends Error {
  readonly reason: MirrorRefetchReason;
  readonly path: string;
  /** The facet that was asked for and not served. */
  readonly facet: string;

  private constructor(reason: MirrorRefetchReason, message: string, path: string, facet: string) {
    super(message);
    this.name = "MirrorRefetchError";
    this.reason = reason;
    this.path = path;
    this.facet = facet;
  }

  static missingFacet(path: string, facet: string): MirrorRefetchError {
    return new MirrorRefetchError(
      "facet_missing",
      `get_note ${path} was asked for the ${facet} facet and answered without it: the mirror ` +
        `refuses to record an absent facet as an empty one, because "not served" and "none" ` +
        "are different answers and nothing downstream could tell them apart",
      path,
      facet,
    );
  }
}

/**
 * A `NoteDto` — `get_note`'s answer — as a mirror row.
 *
 * Hydration's `mirrorNoteRow` cannot be reused and this is not duplication:
 * `SnapshotNoteDto` wraps the metadata fields in a `metadata` object, spells
 * the outgoing references `references`, and has every facet optional;
 * `NoteDto` has the metadata fields flat and top-level, spells them
 * `outgoing`, carries a `source` the mirror does not keep, and has exactly two
 * optional fields. One converter that took both would have to guess which
 * shape it held.
 */
export function mirrorNoteRowFromNote(dto: NoteDto): MirrorNoteRow {
  // `=== undefined`, never `?? []` — see MirrorRefetchError.
  if (dto.sections === undefined) throw MirrorRefetchError.missingFacet(dto.path, "sections");
  if (dto.list_items === undefined) throw MirrorRefetchError.missingFacet(dto.path, "list_items");
  return {
    path: dto.path,
    revision: dto.revision,
    properties: dto.properties,
    aliases: dto.aliases,
    headings: dto.headings,
    blocks: dto.blocks,
    tags: dto.tags,
    diagnostics: dto.diagnostics,
    sections: dto.sections,
    listItems: dto.list_items,
    outgoing: dto.outgoing,
  };
}

/**
 * Where a reference points, once, for both the link tables and the backlinks.
 *
 * `missing_subpath` counts as resolved **to the file**: a link to a real note
 * with a heading that is not there still points at that note, and Obsidian puts
 * it in `resolvedLinks` for exactly that reason. `ambiguous` takes the first
 * candidate — the daemon orders them, Obsidian also picks one, and dropping the
 * edge would make a link that a reader can follow invisible to the graph.
 * `non_vault` (an external URL) is in neither table, which is Obsidian's
 * behaviour too.
 */
export function resolvedTargetOf(reference: ReferenceDto): string | null {
  const resolution = reference.resolution;
  switch (resolution.kind) {
    case "resolved":
    case "missing_subpath":
      return resolution.target;
    case "ambiguous":
      return resolution.candidates[0] ?? null;
    default:
      return null;
  }
}

/** The link text an unresolved reference is filed under. */
function unresolvedKeyOf(reference: ReferenceDto): string | null {
  if (reference.resolution.kind === "non_vault") return null;
  const key = reference.file_target ?? reference.raw_target;
  return key.length > 0 ? key : null;
}

/**
 * One coherent set of rows, and every index derived from them.
 *
 * It is a {@link MirrorSink}, so a hydration writes straight into it, and it is
 * the unit the resync path swaps: a re-hydration fills a **new** one and the
 * old one keeps answering queries until the swap, which is what makes "never a
 * torn read" a structural fact rather than a discipline.
 *
 * Every index is maintained incrementally. A rebuild-the-world implementation
 * passes every test in this repository and falls over at 100k notes, so the
 * delta path is the implementation rather than an optimization.
 */
class MirrorState implements MirrorSink {
  readonly entries = new Map<string, MirrorEntry>();
  readonly notes = new Map<string, MirrorNoteRow>();
  readonly positionIndexes = new Map<string, PositionIndex>();
  /** Folder path (`""` at the root) to the paths of its direct children. */
  private readonly childIndex = new Map<string, Set<string>>();
  /** Lowercased name and basename to the paths carrying it, for linkpath search. */
  private readonly nameIndex = new Map<string, Set<string>>();
  private readonly backlinkIndex = new Map<string, ReferenceDto[]>();
  /** Per source note, the resolved targets it contributed a backlink to. */
  private readonly outgoingTargets = new Map<string, Set<string>>();
  private readonly resolvedBySource = new Map<string, Map<string, number>>();
  private readonly unresolvedBySource = new Map<string, Map<string, number>>();
  private linkEpoch = 0;
  private entryEpoch = 0;
  private resolvedCache: { epoch: number; value: Record<string, Record<string, number>> } | null =
    null;
  private unresolvedCache: { epoch: number; value: Record<string, Record<string, number>> } | null =
    null;
  private sortedCache: { epoch: number; value: readonly MirrorEntry[] } | null = null;
  committedGeneration = 0;

  // --- MirrorSink -----------------------------------------------------------

  /** A walk is starting, so whatever an abandoned one left here is void. */
  begin(): void {
    this.entries.clear();
    this.notes.clear();
    this.positionIndexes.clear();
    this.childIndex.clear();
    this.nameIndex.clear();
    this.backlinkIndex.clear();
    this.outgoingTargets.clear();
    this.resolvedBySource.clear();
    this.unresolvedBySource.clear();
    this.linkEpoch += 1;
    this.entryEpoch += 1;
  }

  applyTreePage(entries: readonly MirrorEntry[]): void {
    for (const entry of entries) this.upsertEntry(entry);
  }

  applyNotePage(notes: readonly MirrorNoteRow[]): void {
    for (const note of notes) this.upsertNote(note);
  }

  commit(generation: number): void {
    this.committedGeneration = generation;
  }

  // --- Mutation -------------------------------------------------------------

  upsertEntry(entry: MirrorEntry): void {
    const existing = this.entries.get(entry.path);
    if (existing) this.detach(existing);
    this.entries.set(entry.path, entry);
    this.attach(entry);
    this.entryEpoch += 1;
  }

  upsertNote(row: MirrorNoteRow): void {
    if (this.notes.has(row.path)) this.removeLinks(row.path);
    this.notes.set(row.path, row);
    this.installLinks(row);
  }

  /**
   * Remove a path and, if it is a folder, everything that was under it.
   *
   * The subtree is walked through {@link childIndex} rather than by scanning
   * every key for a prefix: a prefix scan is O(vault) per delete, and it is
   * also wrong in the obvious way — `Deeper.md` is not under `Deep`.
   *
   * Returns every path that actually went away, which is what the change batch
   * reports: the shim cannot apply the subtree rule for itself once the mirror
   * has forgotten the subtree.
   */
  removeSubtree(path: string): string[] {
    if (!this.entries.has(path)) return [];
    const removed: string[] = [];
    const stack = [path];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const children = this.childIndex.get(current);
      if (children) for (const child of children) stack.push(child);
      const entry = this.entries.get(current);
      if (!entry) continue;
      this.detach(entry);
      this.entries.delete(current);
      if (this.notes.has(current)) {
        this.removeLinks(current);
        this.notes.delete(current);
      }
      this.positionIndexes.delete(current);
      removed.push(current);
    }
    this.entryEpoch += 1;
    return removed;
  }

  /** Keep the position indexes of every note whose revision did not change. */
  adoptPositions(previous: MirrorState): void {
    for (const [path, index] of previous.positionIndexes) {
      const before = previous.notes.get(path);
      const after = this.notes.get(path);
      if (before && after && before.revision === after.revision) this.positionIndexes.set(path, index);
    }
  }

  // --- Queries --------------------------------------------------------------

  sortedEntries(): readonly MirrorEntry[] {
    if (this.sortedCache?.epoch === this.entryEpoch) return this.sortedCache.value;
    const value = [...this.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.sortedCache = { epoch: this.entryEpoch, value };
    return value;
  }

  children(folderPath: string): readonly MirrorEntry[] {
    const paths = this.childIndex.get(folderPath);
    if (!paths) return [];
    const value: MirrorEntry[] = [];
    for (const path of paths) {
      const entry = this.entries.get(path);
      if (entry) value.push(entry);
    }
    return value.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  backlinks(path: string): readonly ReferenceDto[] {
    return this.backlinkIndex.get(path) ?? [];
  }

  namedBy(key: string): readonly string[] {
    const paths = this.nameIndex.get(key.toLowerCase());
    return paths ? [...paths] : [];
  }

  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>> {
    if (this.resolvedCache?.epoch === this.linkEpoch) return this.resolvedCache.value;
    const value = materialize(this.resolvedBySource);
    this.resolvedCache = { epoch: this.linkEpoch, value };
    return value;
  }

  unresolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>> {
    if (this.unresolvedCache?.epoch === this.linkEpoch) return this.unresolvedCache.value;
    const value = materialize(this.unresolvedBySource);
    this.unresolvedCache = { epoch: this.linkEpoch, value };
    return value;
  }

  /**
   * Every mirrored path against the stamp a synthetic diff compares.
   *
   * A note's stamp is its content revision. A folder and an attachment have
   * none — the index stores no content revision for either — so they carry a
   * stamp built from what the tree row does report: `folder` for a folder, and
   * size plus mtime for a file. Without them a re-hydration could not report an
   * attachment that changed, and the shim's `TFile.stat` would stay wrong.
   */
  revisionStamps(): Map<string, string> {
    const stamps = new Map<string, string>();
    for (const entry of this.entries.values()) stamps.set(entry.path, stampOf(entry));
    return stamps;
  }

  // --- Index maintenance ----------------------------------------------------

  private attach(entry: MirrorEntry): void {
    const siblings = this.childIndex.get(entry.parent);
    if (siblings) siblings.add(entry.path);
    else this.childIndex.set(entry.parent, new Set([entry.path]));
    for (const key of nameKeysOf(entry)) {
      const named = this.nameIndex.get(key);
      if (named) named.add(entry.path);
      else this.nameIndex.set(key, new Set([entry.path]));
    }
  }

  private detach(entry: MirrorEntry): void {
    const siblings = this.childIndex.get(entry.parent);
    if (siblings) {
      siblings.delete(entry.path);
      if (siblings.size === 0) this.childIndex.delete(entry.parent);
    }
    for (const key of nameKeysOf(entry)) {
      const named = this.nameIndex.get(key);
      if (!named) continue;
      named.delete(entry.path);
      if (named.size === 0) this.nameIndex.delete(key);
    }
  }

  private installLinks(row: MirrorNoteRow): void {
    const resolved = new Map<string, number>();
    const unresolved = new Map<string, number>();
    const targets = new Set<string>();
    for (const reference of row.outgoing) {
      const target = resolvedTargetOf(reference);
      if (target !== null) {
        resolved.set(target, (resolved.get(target) ?? 0) + 1);
        targets.add(target);
        const bucket = this.backlinkIndex.get(target);
        if (bucket) bucket.push(reference);
        else this.backlinkIndex.set(target, [reference]);
        continue;
      }
      const key = unresolvedKeyOf(reference);
      if (key !== null) unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
    }
    if (resolved.size > 0) this.resolvedBySource.set(row.path, resolved);
    if (unresolved.size > 0) this.unresolvedBySource.set(row.path, unresolved);
    if (targets.size > 0) this.outgoingTargets.set(row.path, targets);
    this.linkEpoch += 1;
  }

  /**
   * Take one note's outgoing edges back out of every index they entered.
   *
   * Only the buckets that note actually touched are visited, which is what
   * keeps a single note's replacement O(its own links) rather than O(every
   * backlink in the vault).
   */
  private removeLinks(source: string): void {
    const targets = this.outgoingTargets.get(source);
    if (targets) {
      for (const target of targets) {
        const bucket = this.backlinkIndex.get(target);
        if (!bucket) continue;
        const kept = bucket.filter((reference) => reference.source_path !== source);
        if (kept.length > 0) this.backlinkIndex.set(target, kept);
        else this.backlinkIndex.delete(target);
      }
      this.outgoingTargets.delete(source);
    }
    this.resolvedBySource.delete(source);
    this.unresolvedBySource.delete(source);
    this.linkEpoch += 1;
  }
}

/** What one refetch brought back, before any of it has been installed. */
interface RefetchPlan {
  /** The highest generation any answer in this plan was served at. */
  readonly generation: number;
  readonly entries: readonly MirrorEntry[];
  readonly notes: ReadonlyMap<string, MirrorNoteRow>;
  /** Requested paths the daemon has no row for. They are removals. */
  readonly absent: readonly string[];
}

/**
 * The vault, mirrored — and kept mirrored.
 *
 * `open` hydrates once; after that the mirror is driven by exactly three calls:
 * {@link applyEvent} for the subscription, {@link applyMutation} for this
 * host's own writes, and {@link warmPositions} for the byte-offset tables the
 * metadata cache needs. Every other method answers a question synchronously.
 *
 * **Applications are serialized.** Events arrive in bursts and each one is an
 * async refetch, so they run on one internal chain: a second event never
 * interleaves its installs with the first one's. The chain is also what makes
 * the staleness guard meaningful — it is evaluated when the application runs,
 * not when the event arrived.
 */
export class Mirror implements MirrorQuery {
  private readonly clientSource: MirrorClientSource;
  private readonly config: HostConfig;
  private state = new MirrorState();
  private generationValue = 0;
  private appliedThroughValue = 0;
  private queue: Promise<void> = Promise.resolve();
  private resyncingValue = false;
  private pendingResync: { reason: ResyncReasonDto } | null = null;
  private lastResyncReasonValue: ResyncReasonDto | null = null;
  private readonly batchListeners = new Set<(batch: MirrorChangeBatch) => void>();
  private readonly configListeners = new Set<(path: string) => void | Promise<void>>();

  private constructor(clientSource: MirrorClientSource, config: HostConfig) {
    this.clientSource = clientSource;
    this.config = config;
  }

  /**
   * Hydrate a mirror and return it.
   *
   * `client` may be a supplier rather than a client, and for anything driven by
   * a {@link Supervisor} it must be: the connection dies with its engine, and
   * the resync that follows a restart has to be issued on the **new** engine's
   * client. A supplier is read at the moment each request is made.
   */
  static async open(client: MirrorClientSource, config: HostConfig): Promise<Mirror> {
    const mirror = new Mirror(client, config);
    const staging = new MirrorState();
    const summary = await hydrateInto(mirror.client(), config, staging);
    mirror.state = staging;
    mirror.generationValue = summary.generation;
    mirror.appliedThroughValue = summary.generation;
    return mirror;
  }

  // --- The read surface -----------------------------------------------------

  /** The highest generation any row in this mirror was fetched at. */
  generation(): number {
    return this.generationValue;
  }

  /**
   * The highest generation whose change set has been applied.
   *
   * At or below this, an event is a no-op. It is never above
   * {@link generation}, and it is often below it — see the class doc.
   */
  appliedThrough(): number {
    return this.appliedThroughValue;
  }

  entry(path: string): MirrorEntry | undefined {
    return this.state.entries.get(path);
  }

  entries(): readonly MirrorEntry[] {
    return this.state.sortedEntries();
  }

  children(folderPath: string): readonly MirrorEntry[] {
    return this.state.children(folderPath);
  }

  note(path: string): MirrorNoteRow | undefined {
    return this.state.notes.get(path);
  }

  positions(path: string): PositionIndex | undefined {
    return this.state.positionIndexes.get(path);
  }

  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>> {
    return this.state.resolvedLinks();
  }

  unresolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>> {
    return this.state.unresolvedLinks();
  }

  backlinks(path: string): readonly ReferenceDto[] {
    return this.state.backlinks(path);
  }

  /**
   * Obsidian's link resolution, answered from the mirror.
   *
   * The **first** source consulted is the daemon's own answer: if the source
   * note has an outgoing reference naming this linkpath, the daemon already
   * resolved it, and re-deriving it here would be a second opinion about
   * something that has one. That covers every call a plugin makes with a link
   * it read out of the cache, which is nearly all of them.
   *
   * The fallback is for a linkpath that is not written in the source note — a
   * plugin composing one. A linkpath **with a separator** is a path, and is
   * tried as written, with `.md` appended, and both again relative to the
   * source's folder. A bare name goes straight to the name search, because
   * Obsidian's own rule for one is "the file with that name closest to the
   * current file" — resolving `[[Note]]` from `Sub/src.md` to the vault-root
   * `Note.md` while `Sub/Note.md` sits beside the source would be the wrong
   * file, not merely a different one.
   *
   * The search ranks: a path that ends with the linkpath as written, then the
   * source's own folder, then the shallowest path, then alphabetical.
   * Obsidian's exact tie-break past that is undocumented, and a tie there means
   * two files a human could not tell apart either.
   */
  firstLinkpathDest(linkpath: string, sourcePath: string): MirrorEntry | undefined {
    const wanted = stripSubpath(linkpath).trim();
    if (wanted.length === 0) return this.state.entries.get(sourcePath);

    const row = this.state.notes.get(sourcePath);
    if (row) {
      for (const reference of row.outgoing) {
        const written = stripSubpath(reference.file_target ?? reference.raw_target).trim();
        if (written !== wanted) continue;
        const target = resolvedTargetOf(reference);
        if (target === null) continue;
        const entry = this.state.entries.get(target);
        if (entry) return entry;
      }
    }

    const sourceFolder = parentOf(sourcePath);
    if (wanted.includes("/")) {
      const relative = sourceFolder === "" ? wanted : `${sourceFolder}/${wanted}`;
      for (const form of [wanted, `${wanted}.md`, relative, `${relative}.md`]) {
        const entry = this.state.entries.get(form);
        if (entry && entry.kind !== "folder") return entry;
      }
    }

    const named = new Set<string>([
      ...this.state.namedBy(wanted),
      ...this.state.namedBy(basenameOf(wanted)),
    ]);
    const candidates = [...named]
      .map((path) => this.state.entries.get(path))
      .filter((entry): entry is MirrorEntry => entry !== undefined && entry.kind !== "folder");
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => {
      const suffix = Number(endsWithPath(b.path, wanted)) - Number(endsWithPath(a.path, wanted));
      if (suffix !== 0) return suffix;
      const closeness = Number(b.parent === sourceFolder) - Number(a.parent === sourceFolder);
      if (closeness !== 0) return closeness;
      const depth = depthOf(a.path) - depthOf(b.path);
      if (depth !== 0) return depth;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return candidates[0];
  }

  /** True from the moment a resync is requested until the last one settles. */
  resyncing(): boolean {
    return this.resyncingValue;
  }

  /** The reason of the most recent resync. Recorded, never branched on. */
  lastResyncReason(): ResyncReasonDto | null {
    return this.lastResyncReasonValue;
  }

  /**
   * Every mirrored path against its revision stamp.
   *
   * The input to {@link synthesizeDiff}, and the engine-restart continuity
   * mechanism: take one before a restart, one after the re-hydration, and the
   * difference is what the vault did while this host had no connection to it.
   */
  snapshotRevisions(): ReadonlyMap<string, string> {
    return this.state.revisionStamps();
  }

  /** Compare a previous revision map against the current one. */
  synthesizeDiff(previous: ReadonlyMap<string, string>): MirrorChangeBatch {
    const current = this.state.revisionStamps();
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [path, stamp] of current) {
      const before = previous.get(path);
      if (before === undefined) created.push(path);
      else if (before !== stamp) modified.push(path);
    }
    for (const path of previous.keys()) if (!current.has(path)) deleted.push(path);
    return {
      generation: this.generationValue,
      created: created.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
      cause: "resync",
      synthetic: true,
    };
  }

  // --- Listeners ------------------------------------------------------------

  /** Subscribe to applied change batches. Returns the detach. */
  onBatch(listener: (batch: MirrorChangeBatch) => void): () => void {
    this.batchListeners.add(listener);
    return (): void => {
      this.batchListeners.delete(listener);
    };
  }

  /**
   * Subscribe to `config_changed`. Returns the detach.
   *
   * The mirror is the one place that sees a write into the `.obsidian` zone, so
   * it is the one place that can tell a config reader its cached JSON is stale.
   * Task 7's `Vault.getConfig` cache and Task 12's plugin registry both listen
   * here.
   */
  onConfigChanged(listener: (path: string) => void | Promise<void>): () => void {
    this.configListeners.add(listener);
    return (): void => {
      this.configListeners.delete(listener);
    };
  }

  // --- Driving --------------------------------------------------------------

  /**
   * Apply one subscription event.
   *
   * An event kind this build does not know is ignored — that is the wire's
   * evolution rule, and guessing at a payload is how a host breaks on a daemon
   * newer than itself. `runtime_state_changed` moves nothing here: the
   * supervisor owns liveness.
   *
   * Rejects when a refetch was refused in a way the mirror cannot interpret.
   * An engine that went away is **not** one of those: the supervisor's
   * synthesized `runtime_recovered` is already on its way, and rejecting into a
   * subscription fan-out would be noise about a recovery that is already
   * arranged.
   */
  applyEvent(event: RuntimeEventDto): Promise<void> {
    if (!isKnownRuntimeEvent(event)) return Promise.resolve();
    switch (event.type) {
      case "generation_committed":
        return this.onCommitted(event.value);
      case "resync_required":
        return this.requestResync(event.value.reason);
      case "config_changed": {
        const { path } = event.value satisfies ConfigChangedEventDto;
        return this.enqueue(() => this.fanOutConfig(path));
      }
      case "runtime_state_changed":
        return Promise.resolve();
    }
  }

  /**
   * Install this host's own write, at the generation the daemon acknowledged.
   *
   * This is what makes read-your-writes true **inside plugin code**: a shim
   * write resolves only after this returns, so the very next synchronous read
   * sees the new row. The `generation_committed` that later describes the same
   * generation is dropped by the staleness guard, so the plugin never sees a
   * duplicate `changed` event for its own write.
   *
   * Unlike an event, a mutation is **never** skipped by the guard. Its whole
   * job is to have refetched these paths, and a race in which the subscription
   * happened to arrive first must not turn that into a maybe.
   */
  applyMutation(generation: number, paths: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.applyChangeSet(generation, "mutation", [], paths, [], { guarded: false });
    });
  }

  /**
   * Build a {@link PositionIndex} for every mirrored note that lacks one.
   *
   * Until a note's index exists, {@link positions} answers `undefined` and
   * Task 8's `getFileCache` answers `null` — which is Obsidian's own contract
   * for a file it has not cached yet rather than an invention. Task 15's
   * lifecycle sequencer fires `resolved` only after this completes, so no
   * plugin observes a half-warm cache through the gate that means "complete".
   *
   * A note whose bytes have already moved past the row is **skipped rather than
   * indexed**: an index built from newer source would put every span in that
   * note a few characters off, silently. The `generation_committed` for that
   * write is already coming, and it re-warms.
   */
  async warmPositions(): Promise<{ warmed: number; elapsedMs: number }> {
    const started = this.config.clock.now();
    const pending = [...this.state.notes.values()].filter(
      (row) => !this.state.positionIndexes.has(row.path),
    );
    let warmed = 0;
    await mapConcurrent(pending, this.config.mirrorWarmConcurrency, async (row) => {
      if (await this.warmOne(row)) warmed += 1;
    });
    return { warmed, elapsedMs: this.config.clock.now() - started };
  }

  // --- Internals ------------------------------------------------------------

  private client(): VaultdClient {
    return typeof this.clientSource === "function" ? this.clientSource() : this.clientSource;
  }

  /**
   * Run `task` after everything already queued, whatever became of it.
   *
   * A rejected application must not poison the chain: the next event is about
   * different paths and has its own answer to give.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private onCommitted(value: GenerationCommittedEventDto): Promise<void> {
    // A cheap early exit for an event the chain would drop anyway. The real
    // guard is inside `applyChangeSet`, where `appliedThrough` is final.
    if (value.generation <= this.appliedThroughValue) return Promise.resolve();
    const changes = value.changes;
    // Narrowed through the guard rather than by comparing `kind`: the union is
    // open, and a third kind read as counts that are not there is exactly the
    // silent misapply the guard exists to prevent.
    if (!isKnownChangeSet(changes)) return this.requestResync(`unknown_change_set:${changes.kind}`);
    if (changes.kind === "counts_only") return this.requestResync("oversized_change_set");
    // `affected_note_count` is not consulted here and must not be: it counts
    // notes alone, and a generation that moved only the file tree reports zero
    // with its paths still spelled out.
    if (changes.created.length + changes.modified.length > this.config.mirrorDeltaPathLimit) {
      return this.requestResync("oversized_change_set");
    }
    return this.enqueue(async () => {
      await this.applyChangeSet(
        value.generation,
        value.cause,
        changes.created,
        changes.modified,
        changes.deleted,
        { guarded: true },
      );
    });
  }

  /**
   * Fetch first, then install — so a refused refetch leaves the mirror exactly
   * as it was.
   *
   * The order inside the install is Ruling W6's: deletes, then the rows. It
   * matters for a path in both lists, which means "the thing there was removed
   * and a different thing was created in its place".
   */
  private async applyChangeSet(
    generation: number,
    cause: GenerationCauseDto,
    created: readonly string[],
    modified: readonly string[],
    deleted: readonly string[],
    options: { guarded: boolean },
  ): Promise<void> {
    if (options.guarded && generation <= this.appliedThroughValue) return;

    const wanted = new Set<string>([...created, ...modified]);
    // A created path in a folder this mirror has never seen needs that folder's
    // row too, or the shim has a file with nowhere to put it. The daemon may
    // well have named the folder itself; asking twice for one path is free,
    // because `get_tree_entries` takes a set.
    for (const path of [...wanted]) {
      for (const ancestor of ancestorsOf(path)) {
        if (!this.state.entries.has(ancestor)) wanted.add(ancestor);
      }
    }

    let plan: RefetchPlan;
    try {
      plan = await this.refetch([...wanted]);
    } catch (error) {
      // The engine went away mid-refetch. A `runtime_recovered` marker is on
      // its way and will re-hydrate the whole mirror; nothing here is worth
      // failing a subscription fan-out over.
      if (error instanceof EngineLostError) return;
      throw error;
    }

    const removed = new Set<string>();
    for (const path of deleted) for (const gone of this.state.removeSubtree(path)) removed.add(gone);
    for (const path of plan.absent) for (const gone of this.state.removeSubtree(path)) removed.add(gone);

    const batchCreated: string[] = [];
    const batchModified: string[] = [];
    const restale: MirrorNoteRow[] = [];
    for (const entry of plan.entries) {
      const existing = this.state.entries.get(entry.path);
      const previousStamp = existing ? stampOf(existing) : null;
      const previousRevision = this.state.notes.get(entry.path)?.revision ?? null;
      const hadIndex = this.state.positionIndexes.has(entry.path);
      this.state.upsertEntry(entry);
      const row = plan.notes.get(entry.path);
      let noteMoved = false;
      if (row) {
        noteMoved = previousRevision !== row.revision;
        this.state.upsertNote(row);
        if (noteMoved) {
          // The position index was built from the old bytes, so every span in
          // that note would now be a few characters off. Drop it, and re-warm
          // it only if it was warm before: a cold mirror stays cold, and a warm
          // one stays warm.
          this.state.positionIndexes.delete(entry.path);
          if (hadIndex) restale.push(row);
        }
      }
      // Classified against the state **after** the deletes, which is what makes
      // a path in both lists come out as a create: rule W6 says the thing there
      // was removed and a different thing was put in its place, and it stays in
      // `deleted` as well so the shim can replay the same two steps. A folder
      // replaced by a file of the same name is the case that produces it, and a
      // shim told only "created" would keep serving the folder's children.
      if (previousStamp === null) batchCreated.push(entry.path);
      else if (previousStamp !== stampOf(entry) || noteMoved) batchModified.push(entry.path);
    }

    this.generationValue = Math.max(this.generationValue, plan.generation, generation);
    this.appliedThroughValue = Math.max(this.appliedThroughValue, generation);

    if (restale.length > 0) {
      await mapConcurrent(restale, this.config.mirrorWarmConcurrency, async (row) => {
        await this.warmOne(row);
      });
    }

    // **A batch reports a change, so an apply that changed nothing reports
    // nothing.** That is not a tidiness rule, it is what keeps a shim write to
    // one `changed` event: `applyMutation` deliberately refetches even when the
    // subscription already applied the same generation — read-your-writes must
    // never be a maybe — and without this the plugin that did the writing would
    // see the event's batch and then a second, identical one.
    if (batchCreated.length + batchModified.length + removed.size === 0) return;
    this.emit({
      generation,
      created: batchCreated,
      modified: batchModified,
      deleted: [...removed].sort(),
      cause,
      synthetic: false,
    });
  }

  /** One `get_tree_entries` batch per 1024 paths, then one `get_note` per note. */
  private async refetch(paths: readonly string[]): Promise<RefetchPlan> {
    if (paths.length === 0) {
      return { generation: 0, entries: [], notes: new Map(), absent: [] };
    }
    const client = this.client();
    const dtos: TreeEntryDto[] = [];
    const absent: string[] = [];
    let generation = 0;
    for (const batch of chunked(paths, TREE_ENTRIES_PATH_LIMIT)) {
      const response = await client.request<GetTreeEntriesResponse>("get_tree_entries", {
        paths: batch,
      });
      dtos.push(...response.entries);
      absent.push(...response.absent);
      generation = Math.max(generation, response.generation);
    }

    const entries = dtos.map(mirrorEntry);
    const notes = new Map<string, MirrorNoteRow>();
    const notePaths = entries.filter((entry) => entry.kind === "note").map((entry) => entry.path);
    await mapConcurrent(notePaths, this.config.mirrorWarmConcurrency, async (path) => {
      try {
        const response = await client.request<GetNoteResponse>("get_note", {
          path,
          include: [...REFETCH_FACETS],
        });
        generation = Math.max(generation, response.generation);
        notes.set(path, mirrorNoteRowFromNote(response.note));
      } catch (error) {
        // Gone between the tree answer and this one. Not a failure: the path is
        // an absence, which is an answer the mirror knows how to apply.
        if (isCode(error, "note_not_found")) {
          absent.push(path);
          return;
        }
        throw error;
      }
    });

    const present = entries.filter((entry) => entry.kind !== "note" || notes.has(entry.path));
    return { generation, entries: present, notes, absent };
  }

  /**
   * Request a full re-hydration.
   *
   * The flag goes up **synchronously**, before the work is queued, because
   * "is this mirror resynchronizing?" is a question a caller asks the instant
   * it hands the event over. Requests coalesce: a resync queued behind one that
   * has not started yet is folded into it, since a re-hydration that has not
   * begun will read the same current state either way.
   */
  private requestResync(reason: ResyncReasonDto): Promise<void> {
    this.pendingResync = { reason };
    this.resyncingValue = true;
    return this.enqueue(() => this.runResync());
  }

  private async runResync(): Promise<void> {
    const requested = this.pendingResync;
    // Folded into an earlier run that had not started when this one arrived.
    // That run has since finished, so the mirror is already current.
    if (!requested) return;
    this.pendingResync = null;
    this.lastResyncReasonValue = requested.reason;
    const previous = this.snapshotRevisions();
    try {
      // Into a staging state, never into the live one: the old mirror answers
      // every query until the swap, so nothing reads a half-filled vault.
      const staging = new MirrorState();
      const summary = await hydrateInto(this.client(), this.config, staging);
      staging.adoptPositions(this.state);
      this.state = staging;
      this.generationValue = Math.max(this.generationValue, summary.generation);
      this.appliedThroughValue = Math.max(this.appliedThroughValue, summary.generation);
      const batch = this.synthesizeDiff(previous);
      // Same rule as the delta path: a re-hydration that found the vault
      // exactly as the mirror already held it has nothing to tell anyone.
      // `lastResyncReason()` is where the fact that it happened is recorded.
      if (batch.created.length + batch.modified.length + batch.deleted.length > 0) {
        this.emit(batch);
      }
    } catch (error) {
      // The engine died under the re-hydration. The next engine's marker will
      // ask for another one; until then the previous view keeps serving, which
      // is stale but coherent — the one thing a mirror must never be is torn.
      if (error instanceof EngineLostError) return;
      throw error;
    } finally {
      this.resyncingValue = this.pendingResync !== null;
    }
  }

  private async warmOne(row: MirrorNoteRow): Promise<boolean> {
    let response: ReadFileResponse;
    try {
      response = await this.client().request<ReadFileResponse>("read_file", { path: row.path });
    } catch (error) {
      // A note that vanished, a zone refusal, an engine that went away: none of
      // them is worth failing a warm-up over. The path simply stays uncached,
      // which is a state Obsidian's own API has a word for.
      if (error instanceof EngineLostError || error instanceof VaultdError) return false;
      throw error;
    }
    // Two checks for the same hazard from two directions: the bytes moved past
    // the row, or a delta replaced the row while this read was in flight.
    if (response.revision !== row.revision) return false;
    const current = this.state.notes.get(row.path);
    if (!current || current.revision !== row.revision) return false;
    const source = Buffer.from(response.content_base64, "base64").toString("utf8");
    this.state.positionIndexes.set(row.path, buildPositionIndex(source));
    return true;
  }

  /** Every batch listener, in registration order, and a throw stays local. */
  private emit(batch: MirrorChangeBatch): void {
    for (const listener of [...this.batchListeners]) {
      try {
        listener(batch);
      } catch (error) {
        process.emitWarning(
          `a mirror batch listener threw: ${describe(error)}. The remaining listeners still ran.`,
          { type: "VaultdMirrorListenerFailed" },
        );
      }
    }
  }

  /**
   * `config_changed` advances no generation, touches no row, and produces no
   * batch. Listeners are **awaited in registration order**, so a config reader
   * has finished re-reading before the next host operation runs.
   */
  private async fanOutConfig(path: string): Promise<void> {
    for (const listener of [...this.configListeners]) {
      try {
        await listener(path);
      } catch (error) {
        // Against the mirror, not against a plugin: no plugin is on this stack.
        process.emitWarning(
          `a mirror config listener threw for ${path}: ${describe(error)}. ` +
            "The remaining listeners still ran.",
          { type: "VaultdMirrorConfigListenerFailed" },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every ancestor folder of a path, shallowest first. `""` is not one. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let cut = path.indexOf("/");
  while (cut !== -1) {
    ancestors.push(path.slice(0, cut));
    cut = path.indexOf("/", cut + 1);
  }
  return ancestors;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** The last segment of a path with any extension removed. */
function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Does `path` end with `linkpath`, on a segment boundary, with or without `.md`? */
function endsWithPath(path: string, linkpath: string): boolean {
  for (const form of [linkpath, `${linkpath}.md`]) {
    if (path === form || path.endsWith(`/${form}`)) return true;
  }
  return false;
}

function depthOf(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i += 1) if (path[i] === "/") depth += 1;
  return depth;
}

/** Both keys an entry is findable by: its full name and its basename. */
function nameKeysOf(entry: MirrorEntry): string[] {
  const name = entry.name.toLowerCase();
  const base = basenameOf(entry.name).toLowerCase();
  return name === base ? [name] : [name, base];
}

/** Everything before the first `#` — a subpath is not part of the linkpath. */
function stripSubpath(linkpath: string): string {
  const hash = linkpath.indexOf("#");
  return hash === -1 ? linkpath : linkpath.slice(0, hash);
}

function stampOf(entry: MirrorEntry): string {
  if (entry.revision !== null) return entry.revision;
  if (entry.kind === "folder") return "folder";
  return `size:${String(entry.size ?? 0)}@${String(entry.mtimeMs)}`;
}

function materialize(
  source: ReadonlyMap<string, Map<string, number>>,
): Record<string, Record<string, number>> {
  const value: Record<string, Record<string, number>> = Object.fromEntries(
    [...source].map(([path, counts]) => [path, Object.fromEntries(counts)]),
  );
  return value;
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * The bound is the point: the daemon answers as fast as it is asked, and an
 * unbounded fan-out over a large vault holds every answer in memory at once.
 */
async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < width; i += 1) {
    workers.push(
      (async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          await task(items[index]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof VaultdError && error.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
