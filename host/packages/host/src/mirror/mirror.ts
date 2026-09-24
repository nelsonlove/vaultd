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
 * ## The change set is not the whole of what moved
 *
 * `vaultd` names the paths that actually changed, and two things change with
 * them that it does not name. Both were found by comparing a live mirror
 * against a fresh hydration over three hundred random mutations
 * (`mirror-fuzz-real-daemon.test.ts`), and both were silent, permanent drift
 * before that comparison existed.
 *
 * - **The referrers of a path that appeared or disappeared.** The daemon
 *   re-resolves references and reports `affected_reference_count`, but the
 *   referring note did not change, so it is not in `modified`. The mirror adds
 *   it from its own indexes: the backlinks of everything a delete removes, and
 *   the sources of any unresolved link key a creation now answers.
 * - **The ancestors of every changed path.** A folder's `mtime` moves when a
 *   child appears, disappears **or is rewritten** — the daemon writes a note
 *   atomically, through a temporary file renamed into place — and the folder is
 *   never named.
 *
 * Both are refetches rather than escalations: one more row in a
 * `get_tree_entries` batch that is already going out, plus one `get_note` each.
 *
 * ## The invariant an apply installs under
 *
 * **Every installed row was fetched at or after the generation at which every
 * path it resolves to was last observed.**
 *
 * That is a stronger bar than "fetched at or after this change set's
 * generation", and the difference is the whole of two bugs. A refetch is
 * answered at whatever generation is current when it lands, so one apply's
 * rounds are answered at *increasing* generations: a row served in the first
 * round can name a path a later round has only just found gone, and installing
 * it leaves a resolved link to a path this mirror does not hold. That is not a
 * stale read that the next event repairs — the generation that really deletes
 * the path finds the row already gone, expands an empty subtree, and asks
 * nobody — so it is permanent, and it is invisible to everything except a
 * check on the mirror's own tables.
 *
 * So the late-removal walk keeps going until a pass finds nothing new, and any
 * row already fetched in this apply that resolves into a path a later pass
 * removed is **asked again**, once. A row still stale after that re-ask means
 * the vault is moving faster than this host can read it, and the apply takes
 * the resync road rather than installing something it knows is wrong.
 *
 * Two words in that sentence are load-bearing and were each got wrong once.
 * *"Removed"* means **the paths this apply will not hold afterwards** — not
 * the paths it removes, because Ruling W6's replace-in-place removes a path and
 * puts a different thing there under the same name, and a link to it does not
 * dangle. And *"resolves into"* means whatever the **link indexes** file under
 * a target (`resolvedTargetOf`, which covers `missing_subpath` and the first
 * candidate of an `ambiguous`), not `resolution.kind === "resolved"`: a guard
 * that is not congruent with the index it protects agrees with the bug on
 * exactly the shapes it forgot.
 *
 * `mirror-fuzz-real-daemon.test.ts` asserts the observable half of this on
 * every batch: no resolved link may name a path the mirror does not hold.
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
 *
 * Two of those reasons are the mirror's own rather than the daemon's, and both
 * exist to turn an invisible permanent hole into a bounded, loud recovery — see
 * `MirrorResyncReason`. `apply_failed` is an event that could not be applied at
 * all; `generation_gap` is an event whose `previous_generation` says a change
 * set went missing.
 *
 * The re-hydration also **re-warms the position index of every note whose
 * revision moved**, exactly as the delta path does. A note whose index was
 * dropped and never rebuilt reads as "not cached" to every plugin for the rest
 * of the session, and after a recovery that is every note that changed while
 * this host was blind.
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
  RuntimeEventDto,
  TreeEntryDto,
} from "../client/protocol";
import type { PositionIndex } from "./positions";
import type {
  MirrorChangeBatch,
  MirrorEntry,
  MirrorNoteRow,
  MirrorQuery,
  MirrorResyncReason,
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

/**
 * Where a mirror gets its client — **a supplier, never a client**.
 *
 * The connection dies with its engine, so a mirror that captured one client
 * could not issue the re-hydration an engine restart asks for: it would keep
 * talking to a socket nobody is listening on, and it would stop resynchronizing
 * with no error anywhere. Narrowing the type to the supplier is what stops that
 * call compiling at all.
 */
export type MirrorClientSource = () => VaultdClient;

/**
 * The refusal codes that mean "there are no bytes to read at that path".
 *
 * The position warm-up swallows exactly these, because every one of them is an
 * ordinary answer about a note that vanished or a path this host may not read,
 * and a note without a position index is a state Obsidian's own API has a word
 * for. Everything else — `invalid_request`, `invalid_path`, `index_unavailable`
 * — is either a protocol mistake by this host or a real fault, and swallowing
 * one would report a wrong `read_file` shape as "the whole vault is uncached".
 *
 * Three of the five were put here by measurement rather than by reasoning, and
 * the list is only as good as that:
 *
 * - `parent_not_found` — the fuzz oracle. A note whose whole folder went
 *   between the row and the read answers this, not `not_found`.
 * - `payload_too_large` — `docs/protocol.md` §Mutations: `read_file` bounds a
 *   file by its size on disk, and the cap is 16 MiB. **A file too big to read
 *   is exactly "there are no bytes I can read at that path"**, which is the
 *   same fact as `not_found` and must be treated the same way. Rethrowing it
 *   made one oversized note reject the whole-vault warm-up and leave every
 *   *other* note uncached — the precise symptom this narrowing exists to
 *   prevent, caused by the narrowing.
 * - `target_exists` — the same section: a `read_file` whose path is not a
 *   regular file answers this. A directory has no bytes either.
 */
const WARM_ABSENCE_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "note_not_found",
  "parent_not_found",
  "zone_violation",
  "payload_too_large",
  "target_exists",
]);

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

/**
 * The link text a reference wrote, lowercased — the key it is indexed under.
 *
 * `null` for an external URL, which names no vault path and so can never be
 * answered, orphaned, or made ambiguous by one appearing or disappearing.
 */
function linkKeyOf(reference: ReferenceDto): string | null {
  if (reference.resolution.kind === "non_vault") return null;
  const written = stripSubpath(reference.file_target ?? reference.raw_target).trim();
  return written.length > 0 ? written.toLowerCase() : null;
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
  /**
   * Lowercased link text to the notes that wrote it — **every** reference, not
   * only the unresolved ones.
   *
   * The delta path asks "whose links might this path have changed the meaning
   * of?", and answering it by scanning every note is O(vault) on every create.
   * Neither `resolvedBySource` nor `unresolvedBySource` is keyed for it, and
   * the backlink index answers only half: it is keyed by resolved *target*, so
   * it finds a note whose link already points at the path and misses one whose
   * link the path is about to start, stop, or begin competing for.
   *
   * All three of those are real and all three were caught by the fuzz oracle:
   * a creation that answers a link nobody could resolve, a creation that makes
   * an already-resolved link **ambiguous** by adding a second file of the same
   * name, and a deletion of a note linked by path rather than by name. So the
   * index holds the text as written, and the backlink index stays beside it for
   * the case text cannot answer — a link that resolved through an alias, whose
   * spelling names no path at all.
   */
  private readonly linkKeyIndex = new Map<string, Set<string>>();
  /** Per source note, the lowercased link keys it contributed. */
  private readonly linkKeysBySource = new Map<string, Set<string>>();
  private linkEpoch = 0;
  private entryEpoch = 0;
  private readonly childrenCache = new Map<string, readonly MirrorEntry[]>();
  private childrenCacheEpoch = -1;
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
    this.linkKeyIndex.clear();
    this.linkKeysBySource.clear();
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
    // A path that stopped being a note takes its note row with it. Unreachable
    // today — a row's kind follows its extension and the extension is part of
    // the path, so a kind change is a different path — but it is one line, and
    // it makes "the mirror never serves a note row for something that is not a
    // note" true by construction rather than by that argument.
    if (entry.kind !== "note" && this.notes.has(entry.path)) {
      this.removeLinks(entry.path);
      this.notes.delete(entry.path);
      this.positionIndexes.delete(entry.path);
    }
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
   * Returns **the rows** that actually went away, which is what the change
   * batch reports: the shim cannot apply the subtree rule for itself once the
   * mirror has forgotten the subtree, and it cannot read a deleted path's
   * last-known revision out of a mirror that no longer holds it either.
   */
  removeSubtree(path: string): MirrorEntry[] {
    if (!this.entries.has(path)) return [];
    const removed: MirrorEntry[] = [];
    for (const current of this.subtreePaths(path)) {
      const entry = this.entries.get(current);
      if (!entry) continue;
      this.detach(entry);
      this.entries.delete(current);
      if (this.notes.has(current)) {
        this.removeLinks(current);
        this.notes.delete(current);
      }
      this.positionIndexes.delete(current);
      removed.push(entry);
    }
    this.entryEpoch += 1;
    return removed;
  }

  /**
   * A path and everything under it, **without removing any of it**.
   *
   * The same walk {@link removeSubtree} does — through {@link childIndex}, so
   * `Deeper.md` is not under `Deep` — and it exists separately because the
   * delta path has to ask who *referred* to a subtree before it forgets that
   * the subtree existed.
   */
  subtreePaths(path: string): string[] {
    if (!this.entries.has(path)) return [];
    const paths: string[] = [];
    const stack = [path];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const children = this.childIndex.get(current);
      if (children) for (const child of children) stack.push(child);
      paths.push(current);
    }
    return paths;
  }

  /**
   * Keep the position indexes of every note whose revision did not change, and
   * report the rows that need re-warming.
   *
   * A note whose revision moved loses its index — one built from the old bytes
   * would put every span in that note a few characters off, silently. The
   * returned rows are exactly those whose index existed *and* is now void, so
   * the caller re-warms what was warm and leaves a cold mirror cold.
   */
  adoptPositions(previous: MirrorState): MirrorNoteRow[] {
    const restale: MirrorNoteRow[] = [];
    for (const [path, index] of previous.positionIndexes) {
      const after = this.notes.get(path);
      if (!after) continue;
      const before = previous.notes.get(path);
      if (before && before.revision === after.revision) {
        this.positionIndexes.set(path, index);
        continue;
      }
      restale.push(after);
    }
    return restale;
  }

  // --- Queries --------------------------------------------------------------

  sortedEntries(): readonly MirrorEntry[] {
    if (this.sortedCache?.epoch === this.entryEpoch) return this.sortedCache.value;
    const value = [...this.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.sortedCache = { epoch: this.entryEpoch, value };
    return value;
  }

  /**
   * The direct children of a folder, path-sorted — and cached under the same
   * epoch {@link sortedEntries} uses.
   *
   * Task 7's `FileIndex.rebuild` calls this once per folder, so an uncached
   * implementation allocates and sorts on every call and is O(n log n) per
   * folder per rebuild. The epoch is bumped by every tree mutation, so a stale
   * answer is not possible: the whole cache is dropped the moment one row
   * moves.
   */
  children(folderPath: string): readonly MirrorEntry[] {
    if (this.childrenCacheEpoch !== this.entryEpoch) {
      this.childrenCache.clear();
      this.childrenCacheEpoch = this.entryEpoch;
    }
    const cached = this.childrenCache.get(folderPath);
    if (cached) return cached;
    const paths = this.childIndex.get(folderPath);
    const value: MirrorEntry[] = [];
    if (paths) {
      for (const path of paths) {
        const entry = this.entries.get(path);
        if (entry) value.push(entry);
      }
      value.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    this.childrenCache.set(folderPath, value);
    return value;
  }

  /**
   * The notes whose links a path appearing or disappearing would re-resolve.
   *
   * Three spellings, because all three name one file in Obsidian and the
   * daemon's own resolver accepts all three: the full path, the path with `.md`
   * dropped, and the bare basename. Case-insensitive, like link resolution.
   */
  linkSourcesFor(path: string): readonly string[] {
    const sources = new Set<string>();
    const withoutExtension = path.endsWith(".md") ? path.slice(0, -3) : path;
    for (const key of [path, withoutExtension, basenameOf(path)]) {
      const bucket = this.linkKeyIndex.get(key.toLowerCase());
      if (bucket) for (const source of bucket) sources.add(source);
    }
    return [...sources];
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

  /**
   * Every mirrored path against its **real** revision, `null` where there is
   * none.
   *
   * Not the same map as {@link revisionStamps}: a stamp is a comparison token
   * and invents one for a folder and an attachment, and handing an invented
   * token to a consumer pairing renames by revision would be worse than
   * handing it nothing. This is what {@link MirrorChangeBatch.revisions}
   * reports for a path a re-hydration found gone.
   */
  revisionMap(): Map<string, string | null> {
    const revisions = new Map<string, string | null>();
    for (const entry of this.entries.values()) revisions.set(entry.path, entry.revision);
    return revisions;
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
    const keys = new Set<string>();
    for (const reference of row.outgoing) {
      const written = linkKeyOf(reference);
      if (written !== null) keys.add(written);
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
    if (keys.size > 0) this.linkKeysBySource.set(row.path, keys);
    for (const key of keys) {
      const bucket = this.linkKeyIndex.get(key);
      if (bucket) bucket.add(row.path);
      else this.linkKeyIndex.set(key, new Set([row.path]));
    }
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
    const keys = this.linkKeysBySource.get(source);
    if (keys) {
      // Only the keys this note actually wrote, for the same reason the
      // backlink buckets above are visited by target rather than swept.
      for (const key of keys) {
        const bucket = this.linkKeyIndex.get(key);
        if (!bucket) continue;
        bucket.delete(source);
        if (bucket.size === 0) this.linkKeyIndex.delete(key);
      }
      this.linkKeysBySource.delete(source);
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
  /** See {@link Mirror.snapshotHydrationMs}. Set once, by {@link Mirror.open}. */
  private snapshotHydrationMsValue = 0;
  private queue: Promise<void> = Promise.resolve();
  private resyncingValue = false;
  /** Set by {@link Mirror.stop}: the queue is closed and applies nothing more. */
  private stopped = false;
  /**
   * Failures already announced through {@link onApplyError}.
   *
   * A `WeakSet`, so an error object is held only as long as something else
   * holds it: this is a dedup key, never a log.
   */
  private readonly reported = new WeakSet<object>();
  private pendingResync: { reason: MirrorResyncReason } | null = null;
  private lastResyncReasonValue: MirrorResyncReason | null = null;
  private resyncCountValue = 0;
  private readonly resyncReasonCounts = new Map<MirrorResyncReason, number>();
  private readonly batchListeners = new Set<(batch: MirrorChangeBatch) => void>();
  private readonly configListeners = new Set<(path: string) => void | Promise<void>>();
  private readonly applyErrorListeners = new Set<
    (error: unknown, event: RuntimeEventDto | null) => void
  >();

  private constructor(clientSource: MirrorClientSource, config: HostConfig) {
    this.clientSource = clientSource;
    this.config = config;
  }

  /**
   * Hydrate a mirror and return it.
   *
   * `client` is a **supplier**, read at the moment each request is made, and
   * that is the whole signature deliberately: the connection dies with its
   * engine, and the resync that follows a restart has to be issued on the *new*
   * engine's client. A mirror handed one captured client compiles just as well,
   * runs just as well, and silently stops resynchronizing after the first
   * restart — so the type does not allow one.
   */
  static async open(client: MirrorClientSource, config: HostConfig): Promise<Mirror> {
    const mirror = new Mirror(client, config);
    const staging = new MirrorState();
    // **Timed, because nothing else could time it.** The snapshot walk runs
    // inside `startHost` *before* `lifecycle.start()`, so `StartupReport`'s
    // `hydrationMs` — which measures from the sequencer's own first line —
    // never covered it, and the baseline document had to report the design's
    // "mirror hydration time" as instrumented in part and refuse to estimate
    // the rest by subtraction. See {@link Mirror.snapshotHydrationMs}.
    const startedAt = config.clock.now();
    const summary = await hydrateInto(mirror.client(), config, staging);
    mirror.snapshotHydrationMsValue = config.clock.now() - startedAt;
    mirror.state = staging;
    mirror.generationValue = summary.generation;
    mirror.appliedThroughValue = summary.generation;
    return mirror;
  }

  /**
   * What the snapshot hydration in {@link Mirror.open} cost, in milliseconds.
   *
   * **The opening walk only.** A later re-hydration — a resync, an engine
   * replacement — does not change it, and must not: this is a startup figure,
   * read once by {@link LifecycleSequencer.start} into its report, and a number
   * that moved under a mid-session resync would make two runs of the same
   * baseline incomparable for a reason that has nothing to do with startup.
   */
  snapshotHydrationMs(): number {
    return this.snapshotHydrationMsValue;
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

  /**
   * The reason of the most recent resync. Recorded, never branched on.
   *
   * Two members of {@link MirrorResyncReason} are this host's own and never
   * appear on the wire: `apply_failed` and `generation_gap`.
   */
  lastResyncReason(): MirrorResyncReason | null {
    return this.lastResyncReasonValue;
  }

  /**
   * How many re-hydrations this mirror has run, for any reason.
   *
   * {@link lastResyncReason} records *that* one happened and is overwritten by
   * the next, so a guard that escalates on one apply in fifty is invisible to
   * every gate. Counting synthetic batches cannot stand in for it either:
   * `runResync` emits nothing when the re-hydration found the vault exactly as
   * the mirror already held it, which is precisely the repair case worth
   * seeing. One integer, and Task 22's compatibility report wants it anyway.
   */
  resyncCount(): number {
    return this.resyncCountValue;
  }

  /**
   * How many re-hydrations this mirror has run, by reason.
   *
   * {@link resyncCount} is a cost number and conflates the daemon's business
   * with this host's: `watcher_overflow` and `subscriber_lag` are the daemon
   * asking, while `generation_gap`, `apply_failed` and `refetch_oversized` are
   * this mirror's own judgement. Only the split can say which of those a run
   * actually exercised, which is what an assertion about *this host's*
   * behaviour needs — and what Task 22's compatibility report should print,
   * since a total reads one trigger as thirty-one problems.
   */
  resyncCounts(): ReadonlyMap<MirrorResyncReason, number> {
    return this.resyncReasonCounts;
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

  /**
   * Compare a previous revision map against the current one.
   *
   * `previousRevisions` is optional and is the only way a deleted path can
   * carry a revision in the batch: a stamp map invents `"folder"` and
   * `"size:…@…"` for rows that have no revision, and those are comparison
   * tokens rather than revisions. Without it a deleted path reports `null`,
   * which is honest — the caller simply did not keep the map.
   */
  synthesizeDiff(
    previous: ReadonlyMap<string, string>,
    previousRevisions?: ReadonlyMap<string, string | null>,
  ): MirrorChangeBatch {
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
    const revisions: Record<string, string | null> = {};
    for (const path of [...created, ...modified]) {
      revisions[path] = this.state.entries.get(path)?.revision ?? null;
    }
    for (const path of deleted) revisions[path] = previousRevisions?.get(path) ?? null;
    return {
      generation: this.generationValue,
      created: created.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
      revisions,
      // No cause: this batch is the difference between two coherent views and
      // describes no one generation. `synthetic` is what says so.
      cause: null,
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

  /**
   * Subscribe to applications that could not complete. Returns the detach.
   *
   * The seam exists for **reporting**, not for repair: the mirror's own answer
   * to an event it could not apply is already a resync (see {@link applyEvent}),
   * so a listener here is a place to log, count, or surface the failure in
   * Task 22's compatibility report — not a place that has to arrange recovery.
   *
   * Without it every caller writes its own `.catch`, and Task 15's subscription
   * handler is a `(event) => void` with nowhere to put one.
   */
  onApplyError(listener: (error: unknown, event: RuntimeEventDto | null) => void): () => void {
    this.applyErrorListeners.add(listener);
    return (): void => {
      this.applyErrorListeners.delete(listener);
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
   *
   * **An application that could not complete takes the resync road.** The
   * rejection is still delivered, and {@link onApplyError} still fires, but the
   * mirror does not stop there: `appliedThrough` was correctly left
   * un-advanced, which means that generation's paths are now stale and *nothing
   * retries them*. Only an unrelated future event naming the same paths, or a
   * resync that a quiet vault never has, would ever repair them. "I could not
   * get to this generation one path at a time" is the definition of the resync
   * road, so the mirror asks for one itself and the hole becomes a bounded,
   * loud recovery.
   */
  applyEvent(event: RuntimeEventDto): Promise<void> {
    return this.dispatch(event).catch((error: unknown) => {
      // The engine went away. The supervisor's marker is already on its way and
      // will re-hydrate everything; asking for a second resync here would be
      // noise about a recovery that is already arranged.
      if (error instanceof EngineLostError) throw error;
      this.fanOutApplyError(error, event);
      this.requestResync("apply_failed").catch((resyncError: unknown) => {
        // The recovery itself failed. Reported through the same seam rather
        // than swallowed, and not retried: a second re-hydration against an
        // engine that just refused one buys nothing, and the next event's
        // continuity check will ask again.
        this.fanOutApplyError(resyncError, event);
      });
      throw error;
    });
  }

  /** {@link applyEvent}'s body, before the failure policy wraps it. */
  private dispatch(event: RuntimeEventDto): Promise<void> {
    if (!isKnownRuntimeEvent(event)) return Promise.resolve();
    switch (event.type) {
      case "generation_committed":
        return this.onCommitted(event.value, event);
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
   *
   * Also unlike an event, a mutation that fails does **not** fan out through
   * {@link onApplyError} and does not ask for a resync. The caller is the shim
   * write that is still in progress, it is holding this promise, and a failure
   * is its answer to give to the plugin — not a background condition to
   * recover from behind its back.
   *
   * **A re-warm failure underneath it is the exception**, and it reaches the
   * seam with a `null` event. Rebuilding a position index happens after the
   * rows are installed, so it is no longer part of the answer this promise
   * carries — the write succeeded — and it is attributable to no event,
   * because there was none. See `reWarm`.
   *
   * **A folder named here is expanded into its subtree**, against the state
   * this mirror holds at the moment the mutation runs. A caller that renames or
   * deletes a folder knows one path; the rows that move are every row under it,
   * and the wire's answer names none of them. Without the expansion the mirror
   * advanced `appliedThrough` past the generation that moved them, the
   * `generation_committed` describing it was then dropped by the staleness
   * guard, and the descendants were gone from this host until a resync — a
   * silent, permanent loss, found in review against the real daemon. The shim
   * also names the destination paths it can compute; this closes the half the
   * shim cannot, because a caller that names only a folder can never orphan
   * what is under it.
   */
  applyMutation(generation: number, paths: readonly string[]): Promise<void> {
    // **Nothing to come forward to under `--dry-run`.** The mutation this is
    // about was recorded by the write gate and never reached the daemon, so
    // there is no new generation and these paths hold exactly the bytes this
    // mirror already has. Refetching them would send `get_tree_entries` and a
    // `get_note` per path to answer a question nobody asked — traffic on a run
    // whose whole promise is that it touches nothing, and a read-your-writes
    // that would install the *old* content over the write the plugin thinks it
    // just made. The honest answer is that a dry run's mirror does not move;
    // `dryrun/dry-run.ts` says so in its header, because it is the one thing a
    // dry run cannot pretend.
    if (this.config.dryRun) return Promise.resolve();
    return this.enqueue(async () => {
      // `event: null` — a mutation is this host's own write, not a generation
      // somebody told it about, so a warm failure here is attributable to no
      // event.
      await this.applyChangeSet(generation, "mutation", [], this.expandFolders(paths), [], {
        guarded: false,
        event: null,
      });
    });
  }

  /**
   * Every path in `paths`, plus the whole subtree of any of them this mirror
   * currently holds as a folder.
   *
   * Read inside the queued task, so the state it walks is the state the
   * refetch is about to correct. A destination folder that does not exist here
   * yet expands to nothing, which is why the shim names the destination paths
   * as well.
   */
  private expandFolders(paths: readonly string[]): string[] {
    const expanded = new Set<string>();
    for (const path of paths) {
      expanded.add(path);
      if (this.state.entries.get(path)?.kind !== "folder") continue;
      for (const under of this.state.subtreePaths(path)) expanded.add(under);
    }
    return [...expanded];
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

  /**
   * The current engine's client — **and an engine that is not there is the
   * resync road, not a rejection nobody can act on.**
   *
   * `Supervisor.client()` refuses in the window between an engine dying and its
   * replacement being ready. That window is real and ordinary: the supervisor
   * is already bringing another engine up, and its synthesized
   * `runtime_recovered` will re-hydrate everything. It used to refuse with a
   * bare `Error("no engine is running")`, and letting that out of here made it
   * a *different* kind of failure from {@link EngineLostError}, which every
   * other layer already treats as "wait for the recovery" — so a refetch that
   * happened to be in flight rejected with something nothing recognised, and on
   * a promise the caller had dropped it took the whole process down. Measured:
   * it is one of the two unhandled rejections that made the golden suite exit
   * non-zero in half its runs. **Since 2026-09-24 the supervisor raises
   * `EngineLostError` itself**, so the shim's road is typed too; this catch
   * stays because the conversion is not the only thing it does — the resync
   * mark below is the mirror's own, and a supplier that is not a supervisor is
   * still free to throw anything.
   *
   * So the conversion happens once, here, at the one place the mirror reaches
   * for a client: mark the resync (the road this generation's paths now have
   * to take) and raise the typed error the rest of the host knows.
   */
  private client(): VaultdClient {
    try {
      return this.clientSource();
    } catch (error) {
      this.markResync("runtime_recovered");
      throw new EngineLostError(
        `the engine was replaced while the mirror was reading it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Stop applying anything. **Idempotent, and the last thing a teardown does
   * to a mirror.**
   *
   * A host stops its supervisor as part of shutting down, and anything the
   * mirror had queued behind that moment would reach for a client that is
   * deliberately gone. Nothing useful can come of running it — the host is
   * going away — so the queue is closed instead: a task enqueued after this
   * resolves without running, and one already running finishes against the
   * engine it started on.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Run `task` after everything already queued, whatever became of it.
   *
   * A rejected application must not poison the chain: the next event is about
   * different paths and has its own answer to give.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // **Closed by `stop()`.** A task queued after the host began shutting down
    // would reach for an engine the teardown has already stopped.
    if (this.stopped) return Promise.resolve(undefined as T);
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    // **The returned promise is handled here as well as by its caller, and
    // that is the whole of the fix for a class of process-killing failure.**
    // Several callers drop this promise on purpose — a mutation's refetch is
    // fire-and-forget behind a plugin that dropped its own promise, and a
    // subscription fan-out is a `void` by design — so a rejection inside the
    // chain had nobody holding it and Node killed the process. Attaching a
    // handler to `run` (rather than returning a wrapped promise) means the
    // caller that *does* await it still sees the rejection, exactly as before,
    // while one that drops it gets a reported failure instead of a dead host.
    //
    // It goes to {@link onApplyError}, which is the seam an application
    // failure already reports through, with a `null` event: nobody told this
    // mirror to do the work, so no event is to blame for it.
    run.catch((error: unknown) => {
      // **Attached now, reported at the end of the turn.** Attaching the
      // handler is what stops Node killing the process; *reporting* has to
      // wait, because this handler runs before the caller's own — `applyEvent`
      // announces every application failure with the event that caused it,
      // which is the more useful report, and it is registered later in the
      // chain. So the last-resort report is deferred by one turn and then
      // skipped if something better already made it.
      setImmediate(() => {
        if (typeof error === "object" && error !== null && this.reported.has(error)) return;
        this.fanOutApplyError(error, null);
      });
    });
    return run;
  }

  private onCommitted(value: GenerationCommittedEventDto, event: RuntimeEventDto): Promise<void> {
    // A cheap early exit for an event the chain would drop anyway. The real
    // guard is inside `applyChangeSet`, where `appliedThrough` is final.
    if (value.generation <= this.appliedThroughValue) return Promise.resolve();
    const changes = value.changes;
    // Narrowed through the guard rather than by comparing `kind`: the union is
    // open, and a third kind read as counts that are not there is exactly the
    // silent misapply the guard exists to prevent.
    if (!isKnownChangeSet(changes)) return this.requestResync(`unknown_change_set:${changes.kind}`);
    // The daemon sends `resync_required { oversized_change_set }` immediately
    // after a `counts_only` generation, so this escalation and that event
    // normally ask for the same thing twice — and `requestResync` coalesces
    // them, so only one re-hydration actually runs. Do not "fix" the apparent
    // duplication by deleting this: a counts-only change set with no follow-up
    // would otherwise leave the mirror believing it is current when it holds
    // nothing about that generation at all.
    if (changes.kind === "counts_only") return this.requestResync("oversized_change_set");
    // `affected_note_count` is not consulted here and must not be: it counts
    // notes alone, and a generation that moved only the file tree reports zero
    // with its paths still spelled out.
    if (changes.created.length + changes.modified.length > this.config.mirrorDeltaPathLimit) {
      return this.requestResync("oversized_change_set");
    }
    return this.enqueue(async () => {
      // **Stale before gap.** An event at or below `appliedThrough` is already
      // covered by what this mirror holds — `applyChangeSet`'s own guard drops
      // it a moment later — and it is emphatically *not* a continuity break.
      // Without this line the check below reads a queued burst as a chain of
      // gaps: one re-hydration moves `appliedThrough` to the snapshot's
      // generation, and every event still queued for a generation at or below
      // it then mismatches and asks for a whole-vault re-hydration of its own,
      // one per event. Measured against the real daemon at 227 re-hydrations
      // over thirty seed-runs, against 10 with this line.
      //
      // It masks nothing. A genuine continuity break is always an event
      // *above* `appliedThrough` — if 7 is lost and 8 arrives, 8 > 7 and the
      // check still fires — and an event at or below it cannot be a gap by
      // definition, because everything up to that generation is installed.
      if (value.generation <= this.appliedThroughValue) return;
      // **Continuity, checked where `appliedThrough` is final.** If generation
      // 7's event were lost and 8's arrived, 8 would apply, `appliedThrough`
      // would jump to 8, and 7's paths would be wrong forever with nothing to
      // notice. One comparison converts that invisible permanent hole into a
      // bounded recovery.
      //
      // The placement is the whole of it. In `onCommitted`'s synchronous
      // arrival path an earlier event's application may still be queued and
      // `appliedThrough` is a number from the past, so the check would fire on
      // every burst. Inside the queued task two cases stay quiet — the echo of
      // this host's own write, because `applyMutation` already advanced
      // `appliedThrough` to that generation; and the *first* event after a
      // resync, because the re-hydration set `appliedThrough` to the snapshot's
      // generation, which is what that event's `previous_generation` names.
      // That is not a completeness claim, and reading it as one is what hid the
      // cascade above: in a burst the events behind that first one name
      // generations the snapshot already passed, and only the staleness check
      // keeps them quiet.
      if (
        this.appliedThroughValue !== 0 &&
        value.previous_generation !== this.appliedThroughValue
      ) {
        // `runResync` directly, not `requestResync`: this task is already on
        // the queue, and enqueuing behind itself would wait forever.
        this.markResync("generation_gap");
        await this.runResync();
        return;
      }
      await this.applyChangeSet(
        value.generation,
        value.cause,
        changes.created,
        changes.modified,
        changes.deleted,
        { guarded: true, event },
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
    options: { guarded: boolean; event: RuntimeEventDto | null },
  ): Promise<void> {
    if (options.guarded && generation <= this.appliedThroughValue) return;

    const wanted = new Set<string>([...created, ...modified]);

    // **Every ancestor of every changed path, seen or not.** Two reasons in one
    // loop. A created path in a folder this mirror has never seen needs that
    // folder's row, or the shim has a file with nowhere to put it. And a
    // folder's own `mtime` moves whenever a child appears, disappears **or is
    // rewritten** — the daemon writes a note atomically, through a temporary
    // file renamed into place, so even a plain edit bumps the directory — while
    // the change set names only what actually moved. A mirror that asked for
    // the unseen ancestors alone would serve a stale folder `mtime` forever:
    // Task 7's `DataAdapter.stat` reports it, and `stampOf` cannot even notice
    // the drift, because a folder's stamp is the literal "folder".
    //
    // Measured against the shipped daemon rather than assumed: the fuzz oracle
    // in `mirror-fuzz-real-daemon.test.ts` caught folders whose only recent
    // generation was a `modified` child. Asking twice for one path is free —
    // `get_tree_entries` takes a set — and a vault is not deep, so this adds a
    // handful of rows to a request that is already going out.
    for (const path of [...created, ...modified, ...deleted]) {
      for (const ancestor of ancestorsOf(path)) wanted.add(ancestor);
    }

    // **The referrers of a path that moved, which the daemon never names.**
    // `vaultd` re-resolves references when a link target appears or disappears
    // and says so — the generation carries `affected_reference_count` — but the
    // change set names only the path that actually moved. A mirror that
    // refetched only those paths would keep the referring note's old
    // resolutions: `resolvedLinks`, `unresolvedLinks`, `backlinks` and
    // `note(path).outgoing[].resolution` all wrong, silently, until a resync
    // that a quiet vault never has. Task 8 hands all four straight to plugin
    // code, so a wrong answer here is a wrong answer inside a plugin.
    //
    // Two indexes, because neither answers the whole question, and both are
    // O(affected) rather than O(vault).
    const doomed = new Set<string>();
    for (const path of deleted) for (const gone of this.state.subtreePaths(path)) doomed.add(gone);
    // **By resolved target.** Whoever already pointed at a path that is going
    // away. This must read the backlinks *before* the removals — which is the
    // order this method already uses, fetch first and install second — and a
    // folder delete is walked as a subtree for the same reason it is removed as
    // one. It is the only half that can find a link written as an **alias**,
    // whose text names no path at all.
    for (const path of doomed) {
      for (const reference of this.state.backlinks(path)) {
        if (!doomed.has(reference.source_path)) wanted.add(reference.source_path);
      }
    }
    // **By link text.** Whoever wrote the name, however it resolved — or did
    // not. A note that already wrote `[[Y]]` is the referrer of a `Y.md` that
    // has just appeared, and **filling in a link somebody already wrote is the
    // most ordinary thing that happens in a vault**. It also catches the two
    // shapes the backlink index cannot: a creation that makes an
    // already-resolved link *ambiguous* by adding a second file of that name,
    // and a deletion of one candidate of an ambiguous link, which is filed
    // under the other one.
    // **`doomed`, not `deleted`.** The daemon names a deleted *folder* alone
    // and leaves the subtree implied, so iterating the change set's own list
    // would never consult the link keys of anything inside it — and the shapes
    // that reach only this index are exactly the ones the backlink index
    // cannot answer, so nothing else would catch them. A folder delete would
    // leave every ambiguous link naming a path inside it pointing at a path
    // that no longer exists, permanently.
    // **`deleted` as well as `doomed`, which is not the same list.** `doomed`
    // is built from `subtreePaths`, which answers `[]` for a path this mirror
    // has already forgotten — so a generation that deletes something the mirror
    // lost track of earlier consults nothing and repairs nothing. `linkSources`
    // is keyed by link *text* and answers perfectly well for a path whose row
    // is gone, so naming `deleted` here costs one index lookup and converts
    // "permanent" into "one generation" for every hole of this family: the two
    // this file has already had, and the next one. It is a mitigation and not a
    // fix — it cannot find a link written as an **alias**, which needs the
    // backlink index, which went with the row.
    for (const path of [...created, ...deleted, ...doomed]) {
      for (const source of this.state.linkSourcesFor(path)) {
        if (!doomed.has(source)) wanted.add(source);
      }
    }

    // **The limit bounds the refetch, not the change set.** The pre-queue
    // check in `onCommitted` sizes `created + modified`, which is the number
    // the daemon sent; by here that number has grown by every referrer and
    // every ancestor. Deleting or creating a note that a thousand others link
    // to is a one-path change set and a thousand-path refetch, and past the
    // measured crossover a re-hydration is both cheaper and more coherent.
    // Checked after the expansion because that is the only place the real size
    // is known.
    if (wanted.size > this.config.mirrorDeltaPathLimit) {
      // `runResync` directly: this method always runs inside a queued task, and
      // enqueuing behind that task would wait forever.
      this.markResync("refetch_oversized");
      await this.runResync();
      return;
    }

    let plan: RefetchPlan;
    try {
      plan = await this.refetch([...wanted]);
      // **A late removal has referrers too, and so does the removal a late
      // removal uncovers.** A path that comes back `absent` was deleted again
      // between the event and the refetch, so nothing knew it was going to be a
      // removal when `wanted` was built and its referrers were never asked for
      // — leaving them resolved to a path that no longer exists, which is the
      // same permanent silent drift the deleted half above exists to prevent.
      //
      // **Every pass, not one pass.** A referrer asked for in the second batch
      // can be gone by the time that batch lands, and its own referrers are one
      // more link out. Stopping after one pass removed that row and left
      // whatever pointed at it resolved to a path this host no longer holds —
      // *permanently*, because the generation that really deletes it finds the
      // row already gone and expands an empty subtree, so nothing ever asks
      // again. Measured, not reasoned: the fuzz oracle produced the three-deep
      // chain (a modified note absent, its referrer absent, *its* referrer
      // alive and stale) about one run in ten, and the drift survived every
      // later generation — it looked transient only because an unrelated
      // `watcher_overflow` resync happened to repair it.
      //
      // **Why it terminates**, which is worth being exact about, because the
      // last reader reasoned from a comment that was merely confident. `wanted`
      // only grows, every round subtracts it from `late`, and the universe a
      // round can draw from is fixed: the change set's paths, their ancestors
      // (pure string work), and the paths this mirror's own indexes name —
      // `this.state` is not mutated until after the loop, so no round adds to
      // it. A round therefore either breaks or strictly grows `wanted` inside a
      // bounded set. The re-ask below adds at most one further ask per path,
      // capped by `restaleAsked`. `expanded` is a **work saver** and not the
      // guard — dropping it leaves the loop correct and terminating, just
      // re-walking absences it has already walked — so nothing observable pins
      // it, and that is on purpose rather than a gap. The oversize escalation
      // bounds the cost a second time, at `mirrorDeltaPathLimit`.
      const expanded = new Set<string>();
      const restaleAsked = new Set<string>();
      for (;;) {
        const late = new Set<string>();
        for (const path of plan.absent) {
          if (expanded.has(path)) continue;
          expanded.add(path);
          // A late removal moves its folder's `mtime` as surely as a planned
          // one, and the folder was not an ancestor of anything in `wanted`
          // either.
          for (const ancestor of ancestorsOf(path)) late.add(ancestor);
          for (const gone of this.state.subtreePaths(path)) {
            doomed.add(gone);
            // Both indexes here too, for the same reason the planned removal
            // consults both: neither answers the whole question.
            for (const reference of this.state.backlinks(gone)) late.add(reference.source_path);
            for (const source of this.state.linkSourcesFor(gone)) late.add(source);
          }
        }
        for (const path of doomed) late.delete(path);
        // Already fetched in this apply. That is *not* the same as "fetched
        // late enough", which is what the re-ask below is for.
        for (const path of wanted) late.delete(path);
        // **`wanted` means "asked once", not "asked at or past the absence".**
        // Each round is answered at whatever generation is current when it
        // lands, and those generations increase: a row answered in round 0 was
        // served while a path round 2 has only just found gone was still
        // there — and it still resolves to it. Subtracting `wanted` above is
        // exactly how such a row reached the install pointing at a path this
        // apply was about to remove, and it stayed that way, because the
        // generation that really deletes that path finds the row gone and
        // expands an empty subtree. Measured against the shipped daemon: the
        // fuzz oracle's per-batch check counted up to ninety-six such rows in
        // one three-hundred-mutation seed-run.
        //
        // One re-ask each — `restaleAsked` — answered past the absence, which
        // is a generation at which the daemon has already re-resolved. A row
        // that is *still* stale after its re-ask is a vault moving faster than
        // this host can read it, and that is the resync road, taken below.
        const goneNow = notHeldAfter(doomed, plan);
        for (const [path, row] of plan.notes) {
          if (goneNow.has(path) || restaleAsked.has(path)) continue;
          if (!resolvesInto(row, goneNow)) continue;
          restaleAsked.add(path);
          late.add(path);
        }
        if (late.size === 0) break;
        for (const path of late) wanted.add(path);
        // The same escalation the first expansion takes, for the same reason:
        // past the measured crossover a re-hydration is cheaper and more
        // coherent than chasing a vault that is moving this fast.
        if (wanted.size > this.config.mirrorDeltaPathLimit) {
          this.markResync("refetch_oversized");
          await this.runResync();
          return;
        }
        plan = mergedPlans(plan, await this.refetch([...late]));
      }
    } catch (error) {
      // The engine went away mid-refetch. A `runtime_recovered` marker is on
      // its way and will re-hydrate the whole mirror; nothing here is worth
      // failing a subscription fan-out over.
      if (error instanceof EngineLostError) return;
      throw error;
    }

    // **Nothing is installed that is already known to be wrong.** The re-ask
    // above is one per path; a row that still resolves into a path this apply
    // is removing has spent it, and installing it anyway would put back exactly
    // the dangling resolution this whole expansion exists to prevent — silently
    // and, because the row's real delete generation will find it gone, forever.
    // So the apply stops and re-hydrates instead: the house answer to "I cannot
    // get to this state one path at a time", and the same answer the oversize
    // road gives, under the same reason.
    // Two scans, because a row can arrive at the install from two directions
    // and only one of them is in the plan.
    //
    // - **A row this apply fetched** that resolves into a removal: the re-ask
    //   was spent, or the removal was found after it was answered.
    // - **A row this mirror already holds** whose target is being removed and
    //   which this apply is *not* replacing. The expansion asks for every such
    //   referrer, so reaching the install still holding one means the ask did
    //   not come back with it — a path that went absent between rounds, say.
    //   Scanning the backlink buckets of what is being removed is O(affected),
    //   which is the same order the expansion already runs at, and it makes the
    //   guarantee structural rather than a claim about the expansion being
    //   exhaustive.
    if (this.wouldDangle(plan, notHeldAfter(doomed, plan))) {
      this.markResync("refetch_oversized");
      await this.runResync();
      return;
    }

    const removed = new Set<string>();
    // Captured as the rows go, because that is the only moment they exist:
    // Task 7 pairs a delete with a create by the deleted path's **last-known**
    // revision, and by the time this batch fires `entry(path)` is `undefined`.
    const revisions: Record<string, string | null> = {};
    for (const path of [...deleted, ...plan.absent]) {
      for (const gone of this.state.removeSubtree(path)) {
        removed.add(gone.path);
        revisions[gone.path] = gone.revision;
      }
    }

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
      //
      // `|| noteMoved` is defence in depth and is unreachable in practice — a
      // note's tree revision and its note revision are the same hash — so it
      // fires only if `get_tree_entries` and `get_note` were answered at
      // different generations for one path, which the refetch does not
      // otherwise notice. Losing that would report a note whose content moved
      // as unchanged.
      //
      // A referrer refetched because its *resolutions* moved is normally in
      // neither list, and that is right: its bytes did not change, so its
      // revision did not either. The mirror's tables are corrected; the shim is
      // told about files that moved.
      if (previousStamp === null) {
        batchCreated.push(entry.path);
        revisions[entry.path] = entry.revision;
      } else if (previousStamp !== stampOf(entry) || noteMoved) {
        batchModified.push(entry.path);
        revisions[entry.path] = entry.revision;
      }
    }

    this.generationValue = Math.max(this.generationValue, plan.generation, generation);
    this.appliedThroughValue = Math.max(this.appliedThroughValue, generation);

    await this.reWarm(restale, options.event);

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
      revisions,
      cause,
      synthetic: false,
    });
  }

  /**
   * Would installing `plan` leave a resolved link to a path in `notHeld` —
   * the paths this apply will not hold afterwards?
   *
   * The install's last question, and the one the whole late-removal expansion
   * exists to be able to answer "no" to. Both directions a row can arrive
   * from are asked, and both use {@link resolvedTargetOf} — the function the
   * backlink index and `resolvedLinks` are themselves built from — so "resolves
   * into `doomed`" here means exactly "dangles afterwards".
   */
  private wouldDangle(plan: RefetchPlan, notHeld: ReadonlySet<string>): boolean {
    for (const [path, row] of plan.notes) {
      if (notHeld.has(path)) continue;
      if (resolvesInto(row, notHeld)) return true;
    }
    for (const gone of notHeld) {
      for (const reference of this.state.backlinks(gone)) {
        const source = reference.source_path;
        if (notHeld.has(source)) continue;
        // Replaced by this apply with a row that does not dangle: fine. Not
        // replaced at all, or replaced by one that still resolves into a
        // removal: not fine.
        const replacement = plan.notes.get(source);
        if (replacement && !resolvesInto(replacement, notHeld)) continue;
        return true;
      }
    }
    return false;
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
  private requestResync(reason: MirrorResyncReason): Promise<void> {
    this.markResync(reason);
    return this.enqueue(() => this.runResync());
  }

  /**
   * Record that a resync is wanted, without queueing the run.
   *
   * Separate from {@link requestResync} for exactly one caller: a task that is
   * already **on** the queue, which cannot enqueue behind itself and then wait
   * for it. That caller marks, then awaits {@link runResync} directly.
   */
  private markResync(reason: MirrorResyncReason): void {
    // **The first reason wins.** Two roads can ask for one re-hydration before
    // it starts — the daemon's `resync_required` and this host's own
    // continuity check — and exactly one run happens either way, so the only
    // question is which reason Task 22's compatibility report is told about.
    // The daemon's account of why it lost per-path detail is worth more than
    // this host's guess at it, and the daemon's is always the earlier one:
    // `requestResync` records synchronously on arrival, while the continuity
    // check records from inside a task that was queued before it.
    this.pendingResync ??= { reason };
    this.resyncingValue = true;
  }

  private async runResync(): Promise<void> {
    const requested = this.pendingResync;
    // Folded into an earlier run that had not started when this one arrived.
    // That run has since finished, so the mirror is already current.
    if (!requested) return;
    this.pendingResync = null;
    this.lastResyncReasonValue = requested.reason;
    this.resyncCountValue += 1;
    this.resyncReasonCounts.set(
      requested.reason,
      (this.resyncReasonCounts.get(requested.reason) ?? 0) + 1,
    );
    const previous = this.snapshotRevisions();
    const previousRevisions = this.state.revisionMap();
    try {
      // Into a staging state, never into the live one: the old mirror answers
      // every query until the swap, so nothing reads a half-filled vault.
      const staging = new MirrorState();
      const summary = await hydrateInto(this.client(), this.config, staging);
      const restale = staging.adoptPositions(this.state);
      this.state = staging;
      this.generationValue = Math.max(this.generationValue, summary.generation);
      this.appliedThroughValue = Math.max(this.appliedThroughValue, summary.generation);
      // **Re-warm what the swap invalidated**, exactly as the delta path does.
      // `adoptPositions` kept the index of every note whose revision did not
      // move — a `read_file` well saved — and a note whose revision *did* move
      // has no index at all until something builds one. Nothing else ever
      // would: `positions` would answer `undefined` and Task 8's `getFileCache`
      // would answer `null` for that note, to every plugin, for the rest of the
      // session. After `watcher_overflow`, `subscriber_lag` or an engine
      // restart, that is every note that changed while this host was blind.
      //
      // After the swap, because `warmOne` checks the row it is warming against
      // the live state. Before `emit`, so a listener that reads `positions` on
      // the batch finds them.
      await this.reWarm(restale, null);
      const batch = this.synthesizeDiff(previous, previousRevisions);
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

  /**
   * Rebuild the position indexes an apply invalidated — and **never let a
   * failure here cost a batch**.
   *
   * By the time this runs the rows are installed and `appliedThrough` has
   * advanced, so a throw would leave the mirror holding a change that no
   * consumer is ever told about. On the resync path it is worse than that: the
   * synthetic batch is the only thing that will ever describe a re-hydration,
   * and by then `previous` has been consumed, so no later resync can
   * reconstruct it. Silent and permanent, which is the class of bug this whole
   * task exists to remove.
   *
   * So every row is attempted, every failure is reported through
   * {@link onApplyError}, and nothing propagates. {@link warmOne} keeps
   * rethrowing what is not an absence — the distinction is worth having and is
   * what {@link warmPositions} still surfaces to its caller — it simply stops
   * being fatal *here*. A note without a byte-offset table is a state
   * Obsidian's own API has a word for; a change nobody was told about is not.
   */
  private async reWarm(
    rows: readonly MirrorNoteRow[],
    event: RuntimeEventDto | null,
  ): Promise<void> {
    if (rows.length === 0) return;
    const failures: unknown[] = [];
    await mapConcurrent(rows, this.config.mirrorWarmConcurrency, async (row) => {
      try {
        await this.warmOne(row);
      } catch (error) {
        failures.push(error);
      }
    });
    for (const error of failures) this.fanOutApplyError(error, event);
  }

  private async warmOne(row: MirrorNoteRow): Promise<boolean> {
    let response: ReadFileResponse;
    try {
      response = await this.client().request<ReadFileResponse>("read_file", { path: row.path });
    } catch (error) {
      // A note that vanished, a zone refusal, an engine that went away: none of
      // them is worth failing a warm-up over. The path simply stays uncached,
      // which is a state Obsidian's own API has a word for.
      //
      // **Narrowly**, though. Swallowing every `VaultdError` would report a
      // wrong `read_file` shape — `invalid_request`, this host's own protocol
      // mistake — as "the whole vault is uncached", which is the loudest
      // possible symptom for the quietest possible cause.
      if (error instanceof EngineLostError) return false;
      if (error instanceof VaultdError && WARM_ABSENCE_CODES.has(error.code)) return false;
      throw error;
    }
    // Two checks for the same hazard from two directions: the bytes moved past
    // the row, or a delta replaced the row while this read was in flight.
    if (response.revision !== row.revision) return false;
    const current = this.state.notes.get(row.path);
    if (!current || current.revision !== row.revision) return false;
    const source = Buffer.from(response.content_base64, "base64").toString("utf8");
    // The reference spans are retained with the table, because this is the one
    // moment the host holds both the row and the bytes. Task 8's `original` has
    // to be the **exact** source slice — a reconstruction from the reference's
    // parts is short for a link title, an angle-bracket target, or an empty
    // alias — and nothing downstream ever sees the source again. Spans only,
    // never the whole note: see `PositionIndex.originals`.
    this.state.positionIndexes.set(
      row.path,
      buildPositionIndex(
        source,
        row.outgoing.map((reference) => reference.span),
      ),
    );
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

  /** Every apply-error listener, and a throw stays local. */
  private fanOutApplyError(error: unknown, event: RuntimeEventDto | null): void {
    // **Once per failure, whichever road it came down.** The queue's own
    // rejection handler exists so a dropped promise cannot kill the process,
    // and it reports what it catches — but a failure that already went out
    // through `applyEvent`, with the event that caused it, travels through the
    // queue as well and would otherwise be announced twice. The first report
    // is the informative one, so the first report is the one that stands.
    if (typeof error === "object" && error !== null) {
      if (this.reported.has(error)) return;
      this.reported.add(error);
    }
    for (const listener of [...this.applyErrorListeners]) {
      try {
        listener(error, event);
      } catch (listenerError) {
        process.emitWarning(
          `a mirror apply-error listener threw: ${describe(listenerError)}. ` +
            "The remaining listeners still ran.",
          { type: "VaultdMirrorApplyErrorListenerFailed" },
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

/** Two refetch passes as one plan. The later answer wins for a path in both. */
function mergedPlans(first: RefetchPlan, second: RefetchPlan): RefetchPlan {
  const notes = new Map(first.notes);
  for (const [path, row] of second.notes) notes.set(path, row);
  // **Entries dedupe by path, later answer winning**, the same rule the notes
  // map gets for free. One path really can appear in two passes now that a
  // stale referrer is re-asked, and two rows for one path would otherwise be
  // installed in sequence — harmless only by luck, since the second upsert
  // moves no stamp, and a source of duplicate entries in the emitted batch the
  // moment the two rows differ.
  const entries = new Map<string, MirrorEntry>();
  for (const entry of first.entries) entries.set(entry.path, entry);
  for (const entry of second.entries) entries.set(entry.path, entry);
  // **The later answer wins for `absent` too**, and that is the half that
  // cannot be left as a concatenation. A path served as a row in one round and
  // reported gone in a later one is *gone*: keeping the earlier row makes the
  // install remove the path and then put it straight back from a stale
  // answer — a phantom row this mirror holds, resolved into whatever else the
  // apply removed, and named in the batch's `deleted` while it is still there.
  // The install guard cannot see it either: both of its scans skip a path that
  // is being removed, which is exactly what this one is.
  //
  // An earlier absence that a later round then *answered* is the same rule the
  // other way round, and it is why this is a set difference rather than a union
  // — a path can be re-created between two rounds as easily as deleted.
  const secondPresent = new Set(second.entries.map((entry) => entry.path));
  const absent = new Set<string>();
  for (const path of first.absent) if (!secondPresent.has(path)) absent.add(path);
  for (const path of second.absent) absent.add(path);
  for (const path of absent) {
    entries.delete(path);
    notes.delete(path);
  }
  return {
    generation: Math.max(first.generation, second.generation),
    entries: [...entries.values()],
    notes,
    absent: [...absent],
  };
}

/**
 * The doomed paths this apply will **not** put back.
 *
 * Ruling W6's replace-in-place names one path in `deleted` and `created` at
 * once, so it is in `doomed` *and* in the plan's rows: a link to it does not
 * dangle afterwards, and treating it as a removal buys a re-ask nothing needed
 * and then a whole re-hydration for a generation that wanted one upsert.
 *
 * So "resolves into a removal" means **"resolves to a path this apply will not
 * hold afterwards"**, which is neither `doomed` nor `plan.absent` on its own.
 */
function notHeldAfter(doomed: ReadonlySet<string>, plan: RefetchPlan): Set<string> {
  const installed = new Set(plan.entries.map((entry) => entry.path));
  const gone = new Set<string>();
  for (const path of doomed) if (!installed.has(path)) gone.add(path);
  return gone;
}

/**
 * Does any of `row`'s references resolve into `gone`?
 *
 * Through {@link resolvedTargetOf}, which is **the same function the backlink
 * index and `resolvedLinks` are built from** — so "this row resolves into a
 * path being removed" means exactly "installing this row would leave a
 * resolved link to a path the mirror does not hold". Testing
 * `resolution.kind === "resolved"` instead misses `missing_subpath` and
 * `ambiguous`, both of which the indexes file under a target, and both of which
 * the fuzz oracle then reports as dangling — measured, once in twelve
 * seed-runs, after the rest of this fix was in place.
 */
function resolvesInto(row: MirrorNoteRow, gone: ReadonlySet<string>): boolean {
  for (const reference of row.outgoing) {
    const target = resolvedTargetOf(reference);
    if (target !== null && gone.has(target)) return true;
  }
  return false;
}

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
 *
 * **Exported since Task 15**, which has the same shape and the same bound to
 * respect: the sequencer reads one source per changed note before it fires that
 * note's `changed` event, and a two-hundred-note batch done in series is two
 * hundred round trips of dead time with the tree already moved and no plugin
 * told. One implementation of "bounded fan-out" rather than two that drift.
 */
export async function mapConcurrent<T>(
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
