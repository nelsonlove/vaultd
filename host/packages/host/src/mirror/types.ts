/**
 * The mirror's own shapes — and **only** its own shapes.
 *
 * Every wire type this module needs is re-exported from `client/protocol.ts`,
 * never re-declared. That module was written field-for-field from the shipped
 * Rust (`crates/vault-protocol/src/{semantic,snapshots}.rs`) with
 * `docs/protocol.md` as the wire-verified example set, and a second declaration
 * of one of those shapes is a second thing to keep in step with a daemon that
 * moves — which is exactly how a mirror and a daemon come to disagree in
 * silence. (Ruling W1: the wire authority is the shipped Rust plus
 * `docs/protocol.md`; the phase plan's DTO sketches are superseded by it, and
 * three of them were wrong: `AliasDto`/`BlockDto` carry `value`, not `alias` /
 * `id`; `TagDto` carries `value` + `comparison_key` and **no** `origin`; and
 * `ResolutionDto` is internally tagged with no `status` field at all.)
 *
 * What lives here is the boundary itself: the two rows the mirror keeps, and
 * the seam a hydration writes through. The wire is `snake_case`; the rows the
 * host serves to Obsidian are camelCase; the conversion happens exactly once,
 * in `hydrate.ts`.
 */

import type {
  AliasDto,
  BlockDto,
  DiagnosticDto,
  GenerationCauseDto,
  HeadingDto,
  ListItemDto,
  PropertyDto,
  ReferenceDto,
  ResyncReasonDto,
  SectionDto,
  TagDto,
  TreeEntryKindDto,
} from "../client/protocol";
import type { PositionIndex } from "./positions";

export type {
  AliasDto,
  BlockDto,
  DiagnosticDto,
  GenerationCauseDto,
  GetNoteFacetDto,
  GetNoteResponse,
  GetTreeEntriesResponse,
  HeadingDto,
  ListItemDto,
  NoteDto,
  NoteFacetDto,
  NoteMetadataDto,
  OpenSnapshotResponse,
  PropertyDto,
  PropertyValueDto,
  ReferenceDto,
  ResolutionDto,
  ResyncReasonDto,
  SectionDto,
  SnapshotNoteDto,
  SnapshotNotesResponse,
  SnapshotTreeResponse,
  SpanDto,
  TagDto,
  TreeEntryDto,
  TreeEntryKindDto,
} from "../client/protocol";

/**
 * What a tree row can be.
 *
 * **Open-ended, deliberately.** The phase plan spelled this as a closed
 * `"note" | "file" | "folder"`, but `TreeEntryKindDto` is open on the wire and
 * `docs/protocol.md` §Evolution requires an unrecognized `kind` to degrade
 * rather than fail — a future `canvas` or `base` row must land in the mirror as
 * itself, not as a decode error and not silently as a `file`.
 */
export type EntryKind = TreeEntryKindDto;

/**
 * One row of the mirrored vault tree: a note, an attachment, or a folder.
 *
 * `revision` is `null` for a folder **and for every attachment** — correction
 * #13, ratified: the index stores no content revision for a non-note file, so
 * `TreeEntryDto.revision` is absent for both. Nothing downstream may pair an
 * attachment's move by revision, because there has never been a revision to
 * pair with.
 *
 * `parent` is `""` for a vault-root child, and `name` keeps its extension:
 * together they are what a `TFolder` / `TFile` shim needs without re-splitting
 * the path on every access.
 */
export interface MirrorEntry {
  /** Vault-relative, `/`-separated, no leading slash. */
  readonly path: string;
  readonly kind: EntryKind;
  /** Basename with extension. */
  readonly name: string;
  /** The containing folder's path; `""` at the vault root. */
  readonly parent: string;
  /** `null` for a folder and for every non-note file. */
  readonly revision: string | null;
  /** `null` for a folder. */
  readonly size: number | null;
  /** From `ctime_unix_ms` — birthtime, or mtime where the platform has none. */
  readonly ctimeMs: number;
  /** From `mtime_unix_ms`. */
  readonly mtimeMs: number;
}

/**
 * The mirror's per-note row: the camelCase side of the boundary.
 *
 * Task 8 builds Obsidian's `CachedMetadata` from exactly this shape plus a
 * `PositionIndex`, and Task 6b's `fixture-row` binary prints exactly this shape
 * as JSON.
 *
 * **Every array is present**, because a hydration asks for every facet it
 * mirrors: an absent facet on a `snapshot_notes` page means the daemon did not
 * serve what was asked for, and it is recorded here as empty. The wire's
 * absent-is-not-empty rule still binds everywhere it is *informative* — on
 * `get_note`, where `include` is a genuine choice, a consumer must test
 * `=== undefined` — but a mirror row that asked for everything has no such
 * distinction left to preserve.
 *
 * There is no `resolutions` field, and that is not an omission: the wire's
 * `resolutions` facet is the answers-only projection of `references`
 * (`vault-index/src/snapshot.rs` builds both from one query), and every one of
 * those answers is already on `outgoing[].resolution`.
 */
export interface MirrorNoteRow {
  readonly path: string;
  readonly revision: string;
  readonly properties: readonly PropertyDto[];
  readonly aliases: readonly AliasDto[];
  readonly headings: readonly HeadingDto[];
  readonly blocks: readonly BlockDto[];
  readonly tags: readonly TagDto[];
  readonly diagnostics: readonly DiagnosticDto[];
  readonly sections: readonly SectionDto[];
  /** The one renamed field: the wire's `list_items`. */
  readonly listItems: readonly ListItemDto[];
  /** The wire's `references` facet: this note's outgoing links and embeds. */
  readonly outgoing: readonly ReferenceDto[];
}

/**
 * The snapshot session one hydration walk is pinned to.
 *
 * The two counts are **promises**, not measurements: `open_snapshot` says how
 * many rows the session will page out, and the walk checks what it actually
 * walked against them before committing. They are named `promised…` for that
 * reason — a `HydrationSummary` carries the walked numbers under plain names,
 * and one hop between two fields called `entryCount` meaning different things
 * is how the comparison went unwritten in the first place.
 */
export interface SnapshotSession {
  readonly snapshotId: string;
  readonly generation: number;
  /** How many notes the session says it will page out. */
  readonly promisedNoteCount: number;
  /** How many tree entries it says it will page out. At least the note count. */
  readonly promisedEntryCount: number;
}

/**
 * The mirror's write seam.
 *
 * This is the whole contract between a hydration and whatever holds the mirrored
 * state, and it exists so Task 6's `Mirror` installs pages through a named
 * surface rather than reaching into hydration's internals — or hydration into
 * the mirror's. Four calls, in one order:
 *
 * 1. `begin(session)` — a walk is starting. **It is also the discard point**: a
 *    second `begin` means the previous walk was abandoned (its pin was lost) and
 *    everything applied for it is void. A sink that accumulates must clear here,
 *    not on `commit`.
 * 2. `applyTreePage(entries, page)` — one page of tree rows, in path order.
 * 3. `applyNotePage(notes, page)` — one page of note rows, in path order. Every
 *    note page follows every tree page of the same walk.
 * 4. `commit(generation)` — the walk completed. Called **once**, and never for a
 *    walk that threw, so a mirror is either the old complete one or the new
 *    complete one and never a mix of the two.
 *
 * `page` is the 1-based index of the page within its own walk, for a sink that
 * wants to report progress; a sink that does not care may ignore it.
 *
 * **There is no abort call, and that is a precondition rather than an
 * omission.** A walk that dies — a lost pin past its restart budget, a refused
 * page, a truncated one — tells the sink nothing directly: the only signal is
 * `hydrateInto`'s rejection. So a sink that stages must be driven by a caller
 * that awaits `hydrateInto` and treats a rejection as the abort. Calling it
 * from somewhere that does not await would strand a half-applied walk with
 * nothing to tell it so.
 *
 * **This is hydration's seam, not a delta surface.** Applying a
 * `generation_committed` change set needs per-path upsert and remove, with a
 * different atomicity story; that verb set belongs to Task 6's `Mirror` and
 * must not be bolted onto these four calls.
 */
export interface MirrorSink {
  begin(session: SnapshotSession): void;
  applyTreePage(entries: readonly MirrorEntry[], page: number): void;
  applyNotePage(notes: readonly MirrorNoteRow[], page: number): void;
  commit(generation: number): void;
}

/**
 * The mirror's read surface — the one every shim task consumes, and the one
 * nothing may bypass.
 *
 * It is declared here rather than beside the class so a consumer imports the
 * *shape* without importing the machine: Task 7's `FileIndex` takes a
 * `MirrorQuery`, and a test that hands it a fixture object should not have to
 * construct a `Mirror` with a client behind it.
 *
 * Every method is **synchronous**, and that is the whole point of a mirror: a
 * shim answers `vault.getFiles()` from memory because Obsidian's own API is
 * synchronous and no plugin will await it.
 */
export interface MirrorQuery {
  /**
   * The highest generation any row in this mirror was fetched at.
   *
   * **Not the same number as "the last change set I applied"** — see
   * `Mirror.appliedThrough`. A refetch for generation 6 is served at whatever
   * generation is published when it lands, which may be later, so this is what
   * the mirror actually holds and it never moves backwards.
   */
  generation(): number;
  entry(path: string): MirrorEntry | undefined;
  entries(): readonly MirrorEntry[];
  /** The direct children of a folder, path-sorted. `""` is the vault root. */
  children(folderPath: string): readonly MirrorEntry[];
  note(path: string): MirrorNoteRow | undefined;
  /** `undefined` until the note's source has been read — see `warmPositions`. */
  positions(path: string): PositionIndex | undefined;
  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  unresolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Every reference from anywhere in the vault that resolves to `path`. */
  backlinks(path: string): readonly ReferenceDto[];
  firstLinkpathDest(linkpath: string, sourcePath: string): MirrorEntry | undefined;
}

/**
 * Why the mirror re-hydrated.
 *
 * Every reason the daemon can send, plus the two the **host** raises on its own
 * initiative. They are named here rather than invented at the call site so a
 * consumer can see the whole set, and so it is plain which two never appear on
 * the wire:
 *
 * - `apply_failed` — a committed generation could not be applied one path at a
 *   time (a refused refetch, or a facet the daemon did not serve). "I cannot
 *   get to this generation path by path" is the definition of the resync road,
 *   and taking it turns a silent permanent hole into a bounded recovery.
 * - `generation_gap` — an event's `previous_generation` did not match the
 *   generation this mirror had applied through, so a change set went missing.
 *   The daemon signals a lost event with `resync_required` rather than silence,
 *   so this is belt and braces against a daemon that misbehaves.
 *
 * `ResyncReasonDto` is open, so a reason a later daemon introduces lands here
 * as itself and is recorded rather than branched on.
 */
export type MirrorResyncReason = ResyncReasonDto | "apply_failed" | "generation_gap";

/**
 * One applied change, as the shim's event layer consumes it.
 *
 * **No `renamed` field, deliberately.** The wire has none: `ChangeSetDto` is
 * `created` / `modified` / `deleted` and a `rename_note` reports the move as a
 * delete plus a create. So the mirror does not invent a rename it was never
 * told about; Task 7's `FileIndex.applyBatch` synthesizes `vault.on("rename")`
 * from the delete/create pair, pairing them through {@link revisions}. The
 * mirror models the wire; the shim models Obsidian.
 */
export interface MirrorChangeBatch {
  /**
   * The generation whose change set this batch describes.
   *
   * For a synthetic batch it is the generation the re-hydration landed on.
   */
  readonly generation: number;
  /**
   * Paths the mirror installed a row for and had no entry for before.
   *
   * May name a path that {@link deleted} also names — see that field.
   */
  readonly created: readonly string[];
  readonly modified: readonly string[];
  /**
   * **Every path the mirror removed, subtree-expanded.**
   *
   * This is *not* `ChangeSetDto.deleted`, and it is usually longer than it. A
   * deleted folder is named on the wire alone with its descendants implied; the
   * mirror expands the subtree because a consumer cannot — once the mirror has
   * forgotten those rows there is nothing left to expand from.
   *
   * **`created` and `deleted` may name the same path in one batch.** That is
   * Ruling W6's folder-replaced-by-a-file: the thing that was there was removed
   * and a *different* thing was put in its place, and a consumer must replay
   * both steps **in that order** — delete, then create. A rename pairing that
   * iterates `deleted` × `created` therefore has to tolerate a path present in
   * both, or it will pair that path with itself.
   */
  readonly deleted: readonly string[];
  /**
   * The revision of every path this batch names, in one lookup.
   *
   * Covers every path in {@link created}, {@link modified} and
   * {@link deleted}. A created or modified path carries the revision of the row
   * just installed — `null` for a folder and for every non-note file, neither
   * of which has one. A **deleted** path carries its **last-known** revision,
   * captured before the row was removed, which is the one Task 7's rename
   * pairing needs: by the time this batch fires the row is gone and
   * `mirror.entry(path)` answers `undefined`.
   *
   * A path in both `created` and `deleted` carries the **new** value. That
   * costs the pairing nothing, because a rename never re-creates the path it
   * deleted — the folder-replaced-by-a-file case is the only one that produces
   * such a path, and it is not a rename.
   */
  readonly revisions: Readonly<Record<string, string | null>>;
  /**
   * Why the generation advanced, exactly as the daemon reported it — and
   * `null` for a synthetic batch, which describes no one generation's cause.
   *
   * No `GenerationCauseDto` value is invented for the synthetic case. The union
   * is open, so a host-made member would type-check and would then be
   * indistinguishable, to a later consumer switching on `cause`, from something
   * that came off the wire. {@link synthetic} is the field that says where a
   * batch came from.
   */
  readonly cause: GenerationCauseDto | null;
  /**
   * True when the paths were derived by comparing revision maps rather than
   * read off a change set — a re-hydration, from any resync reason or from an
   * engine restart.
   *
   * A synthetic batch reports the difference between two coherent views. It
   * cannot say *why* any one path moved, in what order, or how many times, and
   * a consumer that needs per-generation causality has to treat it as "the
   * world changed while I was not looking" rather than as a change set.
   */
  readonly synthetic: boolean;
}
