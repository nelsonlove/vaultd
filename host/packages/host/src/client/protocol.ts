/**
 * The vaultd wire protocol, version 1, in TypeScript.
 *
 * **The authority for every shape here is the shipped Rust**, not any plan
 * document: `crates/vault-protocol/src/{envelope,error,operations,mutations,
 * semantic,snapshots,events}.rs`, with `docs/protocol.md` as the wire-verified
 * example set. A field that disagrees with those files is a bug in this file.
 *
 * Two conventions run through the whole module, and both are deliberate:
 *
 * 1. **Wire names stay snake_case in TypeScript.** Renaming `next_cursor` to
 *    `nextCursor` would put a translation layer between this host and the
 *    daemon, and a translation layer is where drift hides. The only camelCase
 *    in the client is on `VaultdError`, which is an `Error` subclass rather
 *    than a wire shape.
 * 2. **Open-ended enums carry `(string & {})`.** The daemon's own DTOs decode
 *    an unrecognized `live_state`, `cause`, `reason`, event `type`, error
 *    `code`, or tree-entry `kind` into an `Unknown` variant rather than
 *    failing the line. This is the mirror-image obligation: a variant a later
 *    daemon introduces must widen this client's behaviour, never crash it.
 *    The intersection with `{}` keeps editor completions for the known
 *    spellings while still accepting any string.
 *
 * Enums the daemon decodes *strictly* are typed strictly here, for the same
 * reason: `ReferenceKindDto`, `ReferenceOriginDto`, `SeverityDto`,
 * `NoteFacetDto`, `DeleteModeDto`, `CopyConflictDto`, and
 * `ReferenceStatusFilter` have no `Unknown` on the Rust side, so a value
 * outside their sets is a protocol violation rather than a forward-compatible
 * extension.
 */

/** The protocol version this client speaks. `vault_protocol::PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * One request line. `request` is `vault_protocol::Request`, an adjacently
 * tagged enum: `{ "method": …, "params": … }`, with `params` **omitted
 * entirely** for the two unit variants (`health`, `get_vault_info`). Sending
 * `"params": null` for those is not the shape the daemon serializes, so the
 * client omits the key rather than nulling it.
 */
export interface RequestEnvelope {
  version: number;
  id: string;
  request: { method: string; params?: unknown };
}

/**
 * A success payload: `vault_protocol::Response`, adjacently tagged on `type`
 * with the operation's own answer under `value`.
 */
export interface ResponsePayload {
  type: string;
  value: unknown;
}

export type ResponseOutcome =
  | { status: "ok"; value: ResponsePayload }
  | { status: "err"; value: ProtocolErrorBody };

export interface ResponseEnvelope {
  version: number;
  id: string;
  outcome: ResponseOutcome;
}

/** The stdio transport's second top-level shape: no `id`, no `outcome`. */
export interface EventEnvelope {
  version: number;
  subscription_id: string;
  event: RuntimeEventDto;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `vault_protocol::ProtocolError`. All three tails are `skip_serializing_if =
 * "Option::is_none"`, so an absent key is the common case.
 *
 * `current_revision` is the one the plan sketch omitted: a `revision_conflict`
 * carries the revision the target actually holds, precisely so a retry loop
 * does not have to re-read and race the next writer.
 */
export interface ProtocolErrorBody {
  code: ErrorCode;
  message: string;
  supported_version?: number;
  current_generation?: number;
  current_revision?: string;
  /** Accompanies `query_invalid`: the character position the parser stopped at. */
  position?: number;
}

/** `vault_protocol::ErrorCode`, code for code, plus unknown-variant tolerance. */
export type ErrorCode =
  | "incompatible_version"
  | "invalid_request"
  | "invalid_path"
  | "invalid_cursor"
  | "note_not_found"
  | "index_unavailable"
  | "generation_mismatch"
  | "vault_changed_during_refresh"
  | "incompatible_index"
  | "storage_failure"
  | "internal"
  | "index_in_use"
  | "watch_unavailable"
  | "subscription_not_found"
  | "runtime_not_ready"
  | "runtime_overloaded"
  | "revision_conflict"
  | "not_found"
  | "parent_not_found"
  | "target_exists"
  | "case_collision"
  | "zone_violation"
  | "payload_too_large"
  | "read_only"
  | "snapshot_not_found"
  | "too_many_snapshots"
  | "query_invalid"
  | "unsupported_operator"
  | (string & {});

// ---------------------------------------------------------------------------
// Semantic DTOs (`semantic.rs`)
// ---------------------------------------------------------------------------

/** Half-open UTF-8 byte offsets into a note's exact source. */
export interface SpanDto {
  start: number;
  end: number;
}

/**
 * `PropertyValueDto`, adjacently tagged on `kind` with the payload under
 * `value`. `null` is a unit variant and therefore carries no `value` key at
 * all; `float` carries a **string**, because a lossless YAML float has no
 * faithful `f64` round trip through JSON.
 */
export type PropertyValueDto =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "integer"; value: number }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "sequence"; value: SpannedPropertyValueDto[] }
  | { kind: "mapping"; value: PropertyMappingEntryDto[] };

/** A nested property value with its own span. */
export interface SpannedPropertyValueDto {
  value: PropertyValueDto;
  span: SpanDto;
}

/** One `key: value` pair inside a mapping property, with the key's span. */
export interface PropertyMappingEntryDto {
  key: string;
  key_span: SpanDto;
  value: SpannedPropertyValueDto;
}

export interface PropertyDto {
  key: string;
  value: PropertyValueDto;
  span: SpanDto;
  key_span: SpanDto;
  value_span: SpanDto;
}

/** An alias is a spanned string: the alias text lives in `value`. */
export interface AliasDto {
  value: string;
  span: SpanDto;
}

export interface HeadingDto {
  level: number;
  text: string;
  span: SpanDto;
}

/** A block anchor. Like `AliasDto`, the id lives in `value`. */
export interface BlockDto {
  value: string;
  span: SpanDto;
}

/** A tag. There is no `origin` field: the daemon does not record one here. */
export interface TagDto {
  value: string;
  comparison_key: string;
  span: SpanDto;
}

export type ReferenceKindDto = "markdown_link" | "wikilink" | "markdown_embed" | "wiki_embed";

/** Where a reference was written: in the body, or inside a frontmatter property. */
export type ReferenceOriginDto = "body" | "property";

/**
 * A subpath on a reference or a resolution. `view` names a view of a `.base`
 * target (phase 8). A daemon may add kinds: code that switches on `kind` must
 * treat one it does not know as unknown, never as an error.
 */
export type SubpathDto =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string }
  | { kind: "view"; value: string };

/**
 * `ResolutionDto`, **internally** tagged on `kind` — the variant's fields sit
 * beside the tag rather than under a `value` key.
 */
export type ResolutionDto =
  | { kind: "resolved"; target: string; subpath: SubpathDto | null }
  | { kind: "missing_subpath"; target: string; subpath: SubpathDto }
  | { kind: "unresolved" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "non_vault" };

/**
 * One outgoing reference. `display` is the reference's display text (the alias
 * after a `|`, or a Markdown link's label) and is `null` when it has none.
 * There is no `property_path`: `origin` is all the daemon reports about where
 * a property-borne reference came from.
 */
export interface ReferenceDto {
  source_path: string;
  kind: ReferenceKindDto;
  origin: ReferenceOriginDto;
  raw_target: string;
  file_target: string | null;
  subpath: SubpathDto | null;
  display: string | null;
  span: SpanDto;
  target_span: SpanDto;
  resolution: ResolutionDto;
}

export type SeverityDto = "warning" | "error";

export interface DiagnosticDto {
  code: string;
  severity: SeverityDto;
  message: string;
  path: string | null;
  span: SpanDto | null;
}

/** Adjacently tagged on `state`; `ready` is a unit variant with no `value`. */
export type IndexStateDto =
  | { state: "ready" }
  | { state: "stale"; value: { last_error: string } }
  | { state: "unavailable"; value: { last_error: string | null } };

export interface NoteSummaryDto {
  path: string;
  revision: string;
  title: string | null;
}

/**
 * One note in full.
 *
 * `sections` and `list_items` are the only two optional fields, and they are
 * optional in the strict sense the daemon means: **absent** unless
 * `get_note`'s `include` named them, and `[]` when named with nothing to
 * report. "I did not ask" and "there are none" stay distinguishable, so a
 * consumer must test `=== undefined`, never truthiness.
 */
export interface NoteDto {
  path: string;
  revision: string;
  source: string;
  properties: PropertyDto[];
  aliases: AliasDto[];
  headings: HeadingDto[];
  blocks: BlockDto[];
  tags: TagDto[];
  diagnostics: DiagnosticDto[];
  outgoing: ReferenceDto[];
  sections?: SectionDto[];
  list_items?: ListItemDto[];
}

// ---------------------------------------------------------------------------
// Snapshot DTOs (`snapshots.rs`)
// ---------------------------------------------------------------------------

/** Open-ended: a future `canvas` or `base` kind must degrade, not fail. */
export type TreeEntryKindDto = "folder" | "note" | "file" | (string & {});

/**
 * One vault-tree row. `size` is absent for a folder; `revision` is absent for
 * a folder **and** for a non-note file (the index stores no content revision
 * for attachments). Both timestamps are always present — they are the source a
 * host serves `TFile.stat` from — and both are Unix milliseconds.
 */
export interface TreeEntryDto {
  path: string;
  kind: TreeEntryKindDto;
  size?: number;
  ctime_unix_ms: number;
  mtime_unix_ms: number;
  revision?: string;
}

/** Which per-note row-sets a `snapshot_notes` page carries. Strictly decoded. */
export type NoteFacetDto =
  | "metadata"
  | "references"
  | "resolutions"
  | "backlinks"
  | "sections"
  | "list_items";

/**
 * The subset `get_note`'s `include` accepts. The other four facets are
 * `get_note`'s own unconditional fields, so naming one is `invalid_request`
 * rather than a silently redundant ask.
 */
export type GetNoteFacetDto = Extract<NoteFacetDto, "sections" | "list_items">;

export interface NoteMetadataDto {
  properties: PropertyDto[];
  aliases: AliasDto[];
  headings: HeadingDto[];
  blocks: BlockDto[];
  tags: TagDto[];
  diagnostics: DiagnosticDto[];
}

/** One parsed section. `block_id` is the trailing `^id` anchor, when present. */
export interface SectionDto {
  kind: string;
  span: SpanDto;
  block_id?: string;
}

/**
 * One parsed list item. The parent is a **line number**, never an index:
 * exactly one of `list_start_line` (a top-level item, naming its list's start
 * line) and `parent_start_line` (a nested item, naming its parent item's start
 * line) is present. `task` is the raw character inside the brackets.
 */
export interface ListItemDto {
  span: SpanDto;
  list_start_line?: number;
  parent_start_line?: number;
  task?: string;
}

/** One note's requested facets. Every facet field is absent unless requested. */
export interface SnapshotNoteDto {
  path: string;
  revision: string;
  metadata?: NoteMetadataDto;
  references?: ReferenceDto[];
  resolutions?: ResolutionDto[];
  backlinks?: ReferenceDto[];
  sections?: SectionDto[];
  list_items?: ListItemDto[];
}

// ---------------------------------------------------------------------------
// Mutation DTOs (`mutations.rs`)
// ---------------------------------------------------------------------------

/**
 * A content-bearing mutation's precondition, in exactly one of three shapes.
 *
 * Typed as a union rather than three optional fields **on purpose**: the
 * daemon answers `invalid_request` for a present-but-empty `expected` and for
 * a two-field one, so a shape that cannot be spelled here is a shape the
 * daemon would refuse. Unconditional is spelled by omitting `expected`
 * altogether, or by saying `{ any: true }` out loud — never by `{}`.
 *
 * Not every shape is valid on every verb: `{ absent: true }` is accepted only
 * by `write_note` and `write_file`, and `create_folder` / `delete_folder` /
 * `rename_folder` reject the field itself.
 */
export type ExpectedDto = { revision: string } | { absent: true } | { any: true };

export type DeleteModeDto = "trash_system" | "trash_local" | "permanent";

/** What `copy_file` does when its destination exists. `error` is the default. */
export type CopyConflictDto = "error" | "suffix";

/**
 * One frontmatter value a patch sets. The daemon hand-writes this codec so it
 * is plain JSON on the wire — no `kind`/`value` tagging, unlike the *read*
 * side's `PropertyValueDto`. A mapping keeps the key order it was written in.
 */
export type PatchValueDto =
  | boolean
  | number
  | string
  | PatchValueDto[]
  | { [key: string]: PatchValueDto };

/**
 * How a patch entry addresses a key.
 *
 * Two spellings, and the array one is **additive** — the daemon accepts both.
 * The dotted string (`"a.b.c"`) is version 1's original, and it is unusable for
 * a key whose own name contains a dot: the daemon splits on `.` with no
 * escaping mechanism of any kind, so `my.key` addresses `my` → `key`, finds no
 * `my`, and *creates* one while leaving the real key untouched. The array form
 * (`["my.key"]`) says what each segment is, so a dot inside a name is an
 * ordinary character.
 *
 * This host emits the array form exclusively: there is no key a segment list
 * cannot address, so there is no reason to keep a second spelling alive at the
 * call sites.
 */
export type FrontmatterKeyPathDto = string | string[];

/**
 * One addressed key and what becomes of it.
 *
 * Three outcomes, two shapes. `value` is **required** in the ordinary shape: an
 * explicit `null` deletes, and an absent `value` key is a decode error on the
 * daemon rather than a deletion, so "forgot to set a value" never becomes
 * "delete this key". The `set_null` shape is the **additive** third outcome —
 * write a YAML `null` *into* the key rather than removing it — which the
 * ordinary shape cannot express, because `PatchValueDto` has no null variant
 * and `value: null` is already spoken for.
 */
export type FrontmatterEditDto =
  | { key_path: FrontmatterKeyPathDto; value: PatchValueDto | null; set_null?: never }
  | { key_path: FrontmatterKeyPathDto; set_null: true; value?: never };

/** One referencing note a rename could not rewrite, and why. */
export interface LinkRewriteFailureDto {
  path: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Request parameters (`operations.rs`, `mutations.rs`, `snapshots.rs`)
// ---------------------------------------------------------------------------

/**
 * Every mutation params struct is `deny_unknown_fields` on the daemon: a
 * misspelled key is `invalid_request` rather than a silently dropped
 * precondition. Read params tolerate unknown fields, which is why only the
 * mutation types below are worth being pedantic about.
 */
export interface PageParams {
  cursor?: string | null;
  limit?: number | null;
}

export interface NotePathParams {
  path: string;
  include?: GetNoteFacetDto[];
}

/**
 * `get_tree_entries` names exact paths, in the order it wants them answered.
 * Not a page and not a filter; capped at the transport's 1024-path detail
 * limit, above which the answer is `invalid_request`.
 */
export interface GetTreeEntriesParams {
  paths: string[];
}

export interface PathPageParams {
  path: string;
  cursor?: string | null;
  limit?: number | null;
}

export interface ResolveLinkParams {
  source_path: string;
  destination: string;
}

export type ReferenceStatusFilter = "resolved" | "unresolved" | "ambiguous";

export interface ListReferencesParams {
  source_path?: string | null;
  status?: ReferenceStatusFilter | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface GetDiagnosticsParams {
  path?: string | null;
  severity?: SeverityDto | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface RefreshIndexParams {
  verify?: boolean;
}

/** `subscribe_events` takes an empty params object, not an absent one. */
export type SubscribeEventsParams = Record<string, never>;

export interface UnsubscribeParams {
  subscription_id: string;
}

export interface WriteNoteParams {
  path: string;
  content: string;
  expected?: ExpectedDto;
}

/** `create_folder`'s params. It takes no precondition — a folder has no bytes. */
export interface FolderParams {
  path: string;
}

export interface RenameNoteParams {
  from: string;
  to: string;
  expected?: ExpectedDto;
  rewrite_links?: boolean;
}

/** No `expected`: `rename_folder` rejects the field with `invalid_request`. */
export interface RenameFolderParams {
  from: string;
  to: string;
  rewrite_links?: boolean;
}

export interface CopyFileParams {
  from: string;
  to: string;
  expected_source?: ExpectedDto;
  if_exists?: CopyConflictDto;
}

export interface DeleteNoteParams {
  path: string;
  mode?: DeleteModeDto;
  expected?: ExpectedDto;
}

/** No `expected`: `delete_folder` rejects the field with `invalid_request`. */
export interface DeleteFolderParams {
  path: string;
  mode?: DeleteModeDto;
  recursive?: boolean;
}

export interface PatchFrontmatterParams {
  path: string;
  patch: FrontmatterEditDto[];
  expected?: ExpectedDto;
}

export interface WriteFileParams {
  path: string;
  content_base64: string;
  expected?: ExpectedDto;
}

export interface ReadFileParams {
  path: string;
}

/** `open_snapshot` takes an empty params object. */
export type OpenSnapshotParams = Record<string, never>;

/**
 * A snapshot `limit` is *clamped* into `1..=2000` rather than refused — unlike
 * the collection operations, where an out-of-range `limit` is `invalid_cursor`.
 */
export interface SnapshotTreeParams {
  snapshot_id: string;
  cursor?: string | null;
  limit?: number;
}

export interface SnapshotNotesParams {
  snapshot_id: string;
  cursor?: string | null;
  limit?: number;
  include?: NoteFacetDto[];
}

export interface CloseSnapshotParams {
  snapshot_id: string;
}

// ---------------------------------------------------------------------------
// Search (`search.rs`)
// ---------------------------------------------------------------------------

/** `SearchSortDto`. The daemon's default is `file_name_asc`. */
export type SearchSortDto =
  | "file_name_asc"
  | "file_name_desc"
  | "modified_desc"
  | "modified_asc"
  | "created_desc"
  | "created_asc";

/** `SearchContextDto`: whether each content match carries its line. Default `line`. */
export type SearchContextDto = "none" | "line";

/**
 * `SearchParams`. Every key but `query` is `serde(default)` on the daemon, so a
 * client may omit any of them.
 */
export interface SearchParams {
  query: string;
  match_case?: boolean;
  sort?: SearchSortDto;
  context?: SearchContextDto;
  cursor?: string | null;
  limit?: number | null;
}

/** `DocumentKindDto`, with the unknown-variant tolerance the daemon's own decoder has. */
export type DocumentKindDto = "note" | "canvas" | "file" | (string & {});

/** Half-open UTF-16 code-unit offsets, as a JavaScript string indexes. */
export interface Utf16SpanDto {
  start: number;
  end: number;
}

/** A position in a note: zero-based line, UTF-16 column, and UTF-16 offset. */
export interface LocDto {
  line: number;
  col: number;
  offset: number;
}

/**
 * One match in a document's text. `span` is UTF-8 bytes into the source;
 * `start` and `end` are UTF-16. The two line keys are skipped, not `null`, when
 * the request asked for `context: "none"`.
 */
export interface ContentMatchDto {
  span: SpanDto;
  start: LocDto;
  end: LocDto;
  line_text?: string;
  line_text_start?: number;
}

export interface SearchHitDto {
  path: string;
  kind: DocumentKindDto;
  path_matches: Utf16SpanDto[];
  content_matches: ContentMatchDto[];
  matches_truncated: boolean;
}

export interface SearchResponse {
  generation: number;
  total_files: number;
  total_matches: number;
  items: SearchHitDto[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Response payloads (`operations.rs`, `mutations.rs`, `snapshots.rs`)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  service: string;
  status: string;
}

export interface PageResponse<T> {
  generation: number;
  items: T[];
  next_cursor: string | null;
}

export interface GetVaultInfoResponse {
  generation: number;
  canonical_root: string;
  vault_identity: string;
  state: IndexStateDto;
  note_count: number;
  refreshed_at_unix_ms: number | null;
  /** Absent in health-only mode, where there is no runtime to describe. */
  live_state?: LiveStateDto;
  /**
   * Where the daemon is listening, absent when it has no socket.
   *
   * Optional rather than `string | null` because the daemon **skips** the key
   * rather than serializing `null` — so a host that tests `info.socket_path`
   * for undefined is testing what the wire actually does.
   */
  socket_path?: string;
}

export interface GetNoteResponse {
  generation: number;
  note: NoteDto;
}

/**
 * `entries` comes back in request order with the absentees left out; `absent`
 * names those, spelled the way the request spelled them. A path with no row is
 * an answer, not a failure.
 */
export interface GetTreeEntriesResponse {
  generation: number;
  entries: TreeEntryDto[];
  absent: string[];
}

export interface ResolveLinkResponse {
  generation: number;
  resolution: ResolutionDto;
}

export interface RefreshIndexResponse {
  previous_generation: number | null;
  generation: number;
  added: number;
  changed: number;
  deleted: number;
  unchanged: number;
  reparsed: number;
  verified: boolean;
}

export interface SubscribeEventsResponse {
  subscription_id: string;
  /** `null` when the subscription opened before anything had been committed. */
  generation: number | null;
  live_state: LiveStateDto;
}

export interface UnsubscribeResponse {
  subscription_id: string;
}

/** A content-bearing mutation's answer. */
export interface MutationResponse {
  generation: number;
  revision: string;
}

/**
 * A mutation with no content revision to report: a folder operation, or a
 * delete.
 *
 * `generation` is **absent** — not `0` — for exactly one case: a
 * `create_folder` that landed on an unindexable path (the `.obsidian` zone, or
 * any hidden folder). Nothing there is scanned, so no generation will ever
 * contain it, and `0` is a well-formed generation a client would act on.
 */
export interface GenerationResponse {
  generation?: number;
}

/** `revision` is absent for `rename_folder`: a folder has no bytes to hash. */
export interface RenameResponse {
  generation: number;
  revision?: string;
  links_rewritten: number;
  link_rewrite_failures: LinkRewriteFailureDto[];
}

/**
 * `semantic` answers "did these bytes land inside the indexed universe", and
 * `generation` is present exactly when `semantic` is true. Both answer about
 * where the bytes *landed*, not about the path the request carried.
 */
export interface WriteFileResponse {
  generation?: number;
  revision: string;
  semantic: boolean;
}

export interface ReadFileResponse {
  content_base64: string;
  revision: string;
}

/**
 * A `read_dir` entry's kind, from its own `lstat`.
 *
 * Open-ended for the same reason `TreeEntryKindDto` is: `docs/protocol.md`'s
 * evolution rule names this enum explicitly among the values a client must
 * treat as *unknown* rather than as a protocol error. `other` is already the
 * daemon's catch-all for a fifo, a socket or a device, so an unrecognized
 * spelling here means a later daemon split one of those out — not that the
 * listing is malformed.
 *
 * **`symlink` is its own kind and is never `folder`.** A link to a directory
 * classifies as `symlink`, because the daemon classifies from `lstat` and does
 * not follow. A client that wants what is behind one asks for the link's own
 * path and meets the same containment `read_file` takes.
 */
export type ReadDirEntryKindDto = "file" | "folder" | "symlink" | "other" | (string & {});

/**
 * One entry of a directory listing.
 *
 * `name` is the entry's own name and never a path — the request already fixed
 * where the directory is — and it is the filesystem's own spelling. `size` is
 * present for a regular file and absent for everything else: a folder has no
 * size worth reporting, and a symlink's would be the length of its target
 * string rather than of anything a client could read.
 */
export interface ReadDirEntryDto {
  name: string;
  kind: ReadDirEntryKindDto;
  size?: number;
}

/**
 * The immediate entries of one directory. No recursion, and no `generation`:
 * nothing a listing reports is indexed, so there is no generation it could be
 * true at, and naming one would invite a client to treat a listing as a delta.
 *
 * `entries` is sorted by `name` in **byte order** — a directory yields in
 * whatever order the filesystem stored, and a client diffing two listings needs
 * one. `path` echoes the spelling the *request* used, never the canonicalized
 * or case-folded filesystem path, so pairing answers to asks needs no
 * re-derivation.
 */
export interface ReadDirResponse {
  path: string;
  entries: ReadDirEntryDto[];
}

export interface OpenSnapshotResponse {
  snapshot_id: string;
  generation: number;
  note_count: number;
  /** Every tree entry the session will page out. Always at least `note_count`. */
  entry_count: number;
}

export interface SnapshotTreeResponse {
  snapshot_id: string;
  generation: number;
  entries: TreeEntryDto[];
  next_cursor: string | null;
}

export interface SnapshotNotesResponse {
  snapshot_id: string;
  generation: number;
  notes: SnapshotNoteDto[];
  next_cursor: string | null;
}

export interface CloseSnapshotResponse {
  snapshot_id: string;
}

// ---------------------------------------------------------------------------
// Event DTOs (`events.rs`)
// ---------------------------------------------------------------------------

/** The runtime's observational status. Open-ended. */
export type LiveStateDto =
  | "starting"
  | "catching_up"
  | "watching"
  | "polling_fallback"
  | "stopped"
  | (string & {});

/** Why a generation advanced. Open-ended. */
export type GenerationCauseDto =
  | "watcher"
  | "startup"
  | "periodic"
  | "manual"
  | "verified"
  /** This daemon's own write path, distinct from `watcher`. */
  | "mutation"
  | (string & {});

/**
 * The two change-set shapes this build understands. Internally tagged on
 * `kind`. A generation larger than the transport's detail limit (1024 paths)
 * is reported counts-only, followed immediately by
 * `resync_required { reason: oversized_change_set }`.
 */
export type KnownChangeSetDto =
  | { kind: "detailed"; created: string[]; modified: string[]; deleted: string[] }
  | { kind: "counts_only"; created: number; modified: number; deleted: number };

/**
 * A change-set shape a later daemon introduced.
 *
 * `ChangeSetDto` is the one open union here whose Rust counterpart is **not**
 * open: `vault_protocol::events::ChangeSetDto` derives `Deserialize` with no
 * `#[serde(other)]`, so today's daemon emits `detailed` or `counts_only` and
 * nothing else. The member exists anyway, because the hazard it removes is
 * real and one-directional: a two-member union lets a consumer write
 * `kind === "detailed" ? … : <read the counts>`, and a third kind would then
 * be silently read as counts that are not there. With this member the compiler
 * demands {@link isKnownChangeSet} first, and an unrecognized kind is handled
 * as what it is — a generation whose detail this build cannot interpret, which
 * is a resync.
 */
export interface UnknownChangeSetDto {
  kind: string & {};
}

export type ChangeSetDto = KnownChangeSetDto | UnknownChangeSetDto;

/** Every change-set `kind` this build understands, in `events.rs` order. */
export const KNOWN_CHANGE_SET_KINDS = [
  "detailed",
  "counts_only",
] as const satisfies ReadonlyArray<KnownChangeSetDto["kind"]>;

/**
 * Narrow a change set to the shapes this build knows.
 *
 * Same reason {@link isKnownRuntimeEvent} exists: the open member's `kind` is
 * comparable to every literal, so `kind === "detailed"` alone never removes
 * it. Call this first, then switch on `kind` inside the guard.
 */
export function isKnownChangeSet(changes: ChangeSetDto): changes is KnownChangeSetDto {
  return (KNOWN_CHANGE_SET_KINDS as readonly string[]).includes(changes.kind);
}

/** Why per-path detail is unavailable for a generation move. Open-ended. */
export type ResyncReasonDto =
  | "subscriber_lag"
  | "oversized_change_set"
  | "runtime_recovered"
  | "watcher_overflow"
  | "root_invalidated"
  | (string & {});

/**
 * One committed generation's change. `changes` spans both axes the cache
 * indexes, so a path here is not necessarily a note, while
 * `affected_note_count` counts notes alone. A folder in `changes.deleted`
 * implies its whole subtree.
 */
export interface GenerationCommittedEventDto {
  previous_generation: number | null;
  generation: number;
  cause: GenerationCauseDto;
  changes: ChangeSetDto;
  affected_note_count: number;
  affected_reference_count: number;
}

/** `error_code` is reserved for a future typed code and is never populated yet. */
export interface RuntimeStateChangedEventDto {
  generation: number | null;
  live_state: LiveStateDto;
  error_code?: string;
  message?: string;
}

export interface ResyncRequiredEventDto {
  current_generation: number | null;
  reason: ResyncReasonDto;
}

/** A file under `.obsidian/` changed. Carries no generation: nothing there is indexed. */
export interface ConfigChangedEventDto {
  path: string;
}

/** The four event shapes this build understands. */
export type KnownRuntimeEventDto =
  | { type: "generation_committed"; value: GenerationCommittedEventDto }
  | { type: "runtime_state_changed"; value: RuntimeStateChangedEventDto }
  | { type: "resync_required"; value: ResyncRequiredEventDto }
  | { type: "config_changed"; value: ConfigChangedEventDto };

/**
 * An event kind a later daemon introduced. Its payload is whatever it is, and
 * this build must not touch it.
 */
export interface UnknownRuntimeEventDto {
  type: string & {};
  value?: unknown;
}

export type RuntimeEventDto = KnownRuntimeEventDto | UnknownRuntimeEventDto;

/** Every event `type` this build understands, in `events.rs` declaration order. */
export const KNOWN_EVENT_TYPES = [
  "generation_committed",
  "runtime_state_changed",
  "resync_required",
  "config_changed",
] as const satisfies ReadonlyArray<KnownRuntimeEventDto["type"]>;

/**
 * Narrow an event to the shapes this build knows.
 *
 * Discriminating on `type` alone cannot do it: the open member's `type` is
 * comparable to every literal, so it survives every `===` narrowing. Call this
 * first, then switch on `type` inside the guard — an event that fails it is a
 * kind a later daemon introduced, and the correct response is to ignore it.
 */
export function isKnownRuntimeEvent(event: RuntimeEventDto): event is KnownRuntimeEventDto {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(event.type);
}
