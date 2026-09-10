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
  HeadingDto,
  ListItemDto,
  PropertyDto,
  ReferenceDto,
  SectionDto,
  TagDto,
  TreeEntryKindDto,
} from "../client/protocol";

export type {
  AliasDto,
  BlockDto,
  DiagnosticDto,
  HeadingDto,
  ListItemDto,
  NoteFacetDto,
  NoteMetadataDto,
  OpenSnapshotResponse,
  PropertyDto,
  PropertyValueDto,
  ReferenceDto,
  ResolutionDto,
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

/** The snapshot session one hydration walk is pinned to. */
export interface SnapshotSession {
  readonly snapshotId: string;
  readonly generation: number;
  /** How many notes the session will page out, as `open_snapshot` reported it. */
  readonly noteCount: number;
  /** How many tree entries it will page out. Always at least `noteCount`. */
  readonly entryCount: number;
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
 */
export interface MirrorSink {
  begin(session: SnapshotSession): void;
  applyTreePage(entries: readonly MirrorEntry[], page: number): void;
  applyNotePage(notes: readonly MirrorNoteRow[], page: number): void;
  commit(generation: number): void;
}
