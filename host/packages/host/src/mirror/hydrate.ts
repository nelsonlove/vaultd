/**
 * Filling the mirror from one snapshot session.
 *
 * A snapshot session is the only way to read a whole vault without tearing.
 * `open_snapshot` pins one read transaction; every page served from it —
 * tree rows and semantic rows alike — comes from that same pinned transaction
 * and echoes its generation. Writes land while a hydration runs; the session
 * never sees them. That is the guarantee this module turns into a mirror
 * invariant: **a hydration is one generation, or it is nothing.**
 *
 * The alternative the plan rejected is worth naming, because it is the obvious
 * one: paging `list_notes` and then calling `get_note` per path costs one round
 * trip per note *and* tears across generations while it runs. Hydration issues
 * no per-note request at all.
 *
 * Three refusals shape the control flow, and every one of them is a real thing
 * a busy daemon does:
 *
 * - **`too_many_snapshots`** — the daemon caps concurrent sessions at four.
 *   A host that treated the cap as fatal could not start while any other client
 *   was paging, so `open_snapshot` is retried on a bounded ladder
 *   ({@link SNAPSHOT_RETRY_BACKOFF_MS}) waited on `config.clock`, never on the
 *   global timer.
 * - **`generation_mismatch`** — the second of that code's two causes: the
 *   session's WAL pin was lost. The cursor in hand belongs to a generation that
 *   is gone, so the walk **restarts from the beginning** on a fresh session.
 *   Resuming the old cursor is what would splice two generations together.
 * - **`snapshot_not_found`** — the session was reclaimed (60 s idle) or never
 *   existed. Same answer: reopen and walk again.
 *
 * And two refusals that are not retried, both {@link HydrationCoherenceError}:
 * a page whose `generation` differs from the session's own — a daemon that is
 * not pinning — and a walk whose row counts differ from the ones
 * `open_snapshot` promised. The second is the quiet one: without it, a cursor
 * bug or a `next_cursor: null` one page early produces a mirror silently
 * missing notes, which commits cleanly and reports a coherent generation.
 *
 * Whatever happens, the session is released: on the way out of a completed
 * walk, awaited, so a caller that resolved knows the pin is gone; on the way
 * out of a failed one, fired and not awaited, so a caller's rejection is not
 * held hostage to a daemon that is already misbehaving.
 */

import { VaultdError } from "../client/errors";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type {
  CloseSnapshotResponse,
  NoteFacetDto,
  OpenSnapshotResponse,
  SnapshotNoteDto,
  SnapshotNotesResponse,
  SnapshotTreeResponse,
  TreeEntryDto,
} from "../client/protocol";
import type { MirrorEntry, MirrorNoteRow, MirrorSink, SnapshotSession } from "./types";

/**
 * The facets a hydration asks for, by name.
 *
 * `sections` and `list_items` are **top-level facets, siblings of `metadata`**,
 * not fields inside it. A client that asks for `["metadata"]` and expects
 * `metadata.sections` gets nothing — silently, forever, with no error — which
 * is the failure the wire-convention note exists to prevent.
 *
 * Two of the six facets are deliberately absent, for the same reason: the
 * mirror already holds the answer.
 *
 * - `backlinks` — derived from the other notes' `outgoing`, so asking would
 *   page the same edges a second time in the opposite direction.
 * - `resolutions` — the **answers-only projection of `references`**. The daemon
 *   loads `outgoing` once when either facet is asked for and builds
 *   `resolutions` as `outgoing.map(|r| r.resolution.clone())`
 *   (`vault-index/src/snapshot.rs`), and every `ReferenceDto` carries its own
 *   `resolution` on the wire. Asking for it costs the daemon nothing to compute
 *   and a whole second copy to serialize, and `MirrorNoteRow` has no field for
 *   that copy. Dropped after the wire was read: the plan's five-facet list came
 *   from the same DTO model that gave `AliasDto` an `alias` field.
 */
export const HYDRATION_FACETS: readonly NoteFacetDto[] = [
  "metadata",
  "references",
  "sections",
  "list_items",
];

/**
 * The `open_snapshot` retry ladder, in milliseconds.
 *
 * One rung per retry: retry `i` waits `SNAPSHOT_RETRY_BACKOFF_MS[i]` before
 * asking again, and `HostConfig.snapshotCapRetries` says how many retries there
 * are. A retry past the end of the ladder reuses the last rung. Every wait is
 * asked of `config.clock`, which is what lets a test prove the ladder without
 * spending 1.5 s of wall clock on it.
 *
 * **How many attempts a hydration makes is configuration, not this constant.**
 * The two budgets live on `HostConfig` — `snapshotCapRetries` for the cap arm,
 * `hydrationPinLossRestarts` for the pin-loss arm — because the two failures
 * have different physics, and one shared counter let ordinary cap contention at
 * startup eat the restarts a long walk needs.
 */
export const SNAPSHOT_RETRY_BACKOFF_MS: readonly number[] = [100, 200, 400, 800];

/**
 * What hydration needs from {@link HostConfig} — and nothing else.
 *
 * Spelled as a `Pick` so a caller passes its `HostConfig` straight through, and
 * so the calibration values stay in the one place the phase plan put them: a
 * page size of 500 capped at 2000 is configuration, never a literal in a
 * request builder.
 */
export type HydrationConfig = Pick<
  HostConfig,
  | "clock"
  | "snapshotPageSize"
  | "snapshotPageSizeMax"
  | "snapshotCapRetries"
  | "hydrationPinLossRestarts"
>;

/** What one completed hydration did, without the rows it did it to. */
export interface HydrationSummary {
  /** The single generation every row in this hydration came from. */
  readonly generation: number;
  readonly entryCount: number;
  readonly noteCount: number;
  /** Pages served in the walk that completed; abandoned walks are not counted. */
  readonly pages: number;
  /**
   * Sessions the daemon actually granted, including any abandoned to a lost
   * pin. An `open_snapshot` the daemon refused opened nothing and is not
   * counted; the retries behind such a refusal are visible on the clock, not
   * here.
   */
  readonly sessions: number;
  readonly elapsedMs: number;
}

/** A completed hydration, with the rows it collected. */
export interface HydrationResult extends HydrationSummary {
  readonly entries: readonly MirrorEntry[];
  readonly notes: readonly MirrorNoteRow[];
}

/** Which way a session failed to be the coherent thing it claimed to be. */
export type HydrationCoherenceReason = "generation_drift" | "count_mismatch";

/**
 * The session did not serve one coherent view of one vault.
 *
 * Separate from {@link VaultdError} on purpose: this is not something the
 * daemon said, it is something this host noticed the daemon doing, and it is
 * never retried — a session that is not pinning, or that pages out a different
 * number of rows than it promised, has no recovery that is not a guess.
 *
 * Two reasons, and the second is the one that took a review to notice:
 *
 * - `generation_drift` — a page's `generation` is not the session's.
 * - `count_mismatch` — the walk did not page out exactly what `open_snapshot`
 *   promised. A cursor bug, or a daemon answering `next_cursor: null` one page
 *   early, otherwise yields a mirror silently missing notes that commits
 *   cleanly and reports a coherent generation. The over-count half also bounds
 *   the page loop, which is what makes a daemon repeating one cursor forever an
 *   error rather than a slow death by memory.
 */
export class HydrationCoherenceError extends Error {
  readonly reason: HydrationCoherenceReason;
  readonly sessionGeneration: number;
  /** The page's generation, for `generation_drift`; `null` otherwise. */
  readonly pageGeneration: number | null;

  private constructor(
    reason: HydrationCoherenceReason,
    message: string,
    sessionGeneration: number,
    pageGeneration: number | null,
  ) {
    super(message);
    this.name = "HydrationCoherenceError";
    this.reason = reason;
    this.sessionGeneration = sessionGeneration;
    this.pageGeneration = pageGeneration;
  }

  static generationDrift(
    method: string,
    sessionGeneration: number,
    pageGeneration: number,
  ): HydrationCoherenceError {
    return new HydrationCoherenceError(
      "generation_drift",
      `${method} answered generation ${pageGeneration} inside a session pinned at ` +
        `${sessionGeneration}: the snapshot is not coherent and the mirror refuses to mix generations`,
      sessionGeneration,
      pageGeneration,
    );
  }

  static shortWalk(
    session: SnapshotSession,
    entries: number,
    notes: number,
  ): HydrationCoherenceError {
    return new HydrationCoherenceError(
      "count_mismatch",
      `snapshot ${session.snapshotId} promised ${session.promisedEntryCount} tree entries and ` +
        `${session.promisedNoteCount} notes, but the walk had ${entries} and ${notes} when its ` +
        "pages ran out: the mirror would be silently incomplete, so it is refused",
      session.generation,
      null,
    );
  }

  static overWalk(session: SnapshotSession, kind: "tree" | "note"): HydrationCoherenceError {
    const promised = kind === "tree" ? session.promisedEntryCount : session.promisedNoteCount;
    const rows = kind === "tree" ? "tree entries" : "notes";
    return new HydrationCoherenceError(
      "count_mismatch",
      `snapshot ${session.snapshotId} paged out more ${rows} than the ${promised} it promised: ` +
        "the session is not serving one coherent view, and a walk that keeps paging never ends",
      session.generation,
      null,
    );
  }
}

/**
 * Hydrate into a caller's {@link MirrorSink}.
 *
 * This is the seam Task 6's `Mirror` builds on: pages are handed over as they
 * arrive, `begin` is the discard point for an abandoned walk, and `commit` runs
 * once and only for a walk that completed. Nothing here retains the rows, so a
 * 100k-note vault is not held twice.
 */
export async function hydrateInto(
  client: VaultdClient,
  config: HydrationConfig,
  sink: MirrorSink,
): Promise<HydrationSummary> {
  const started = config.clock.now();
  const limit = pageLimit(config);
  let sessions = 0;
  // Two budgets, counted separately, because the two failures they bound have
  // nothing to do with each other.
  let capRetriesLeft = config.snapshotCapRetries;
  let restartsLeft = config.hydrationPinLossRestarts;

  for (;;) {
    let session: SnapshotSession;
    try {
      session = await openSession(client);
      sessions += 1;
    } catch (error) {
      // The cap is the daemon's, not a fault: wait and ask again.
      if (capRetriesLeft > 0 && isCode(error, "too_many_snapshots")) {
        const rung = config.snapshotCapRetries - capRetriesLeft;
        capRetriesLeft -= 1;
        await delay(config.clock, backoffFor(rung));
        continue;
      }
      throw error;
    }

    sink.begin(session);
    try {
      const pages = await walk(client, session, limit, sink);
      // Awaited: a resolved hydration means the pin really is released.
      await releaseSession(client, session.snapshotId);
      sink.commit(session.generation);
      return {
        generation: session.generation,
        entryCount: pages.entries,
        noteCount: pages.notes,
        pages: pages.count,
        sessions,
        elapsedMs: config.clock.now() - started,
      };
    } catch (error) {
      // Not awaited: the caller's failure must not wait on a daemon that is
      // already refusing. A close that fails is warned about, once, in
      // `releaseSession` — and a session that is already gone is not a failure.
      //
      // The *line* is already written, though: `VaultdClient.request` frames and
      // writes it synchronously, and the daemon's stdio reader feeds one FIFO
      // dispatch loop, so a stale close really does reach the daemon ahead of
      // the reopen below. That ordering is load-bearing — a host that reopened
      // without closing would burn one of the daemon's four session slots per
      // lost pin — and it is an assumption about someone else's process, so it
      // is written down rather than assumed.
      void releaseSession(client, session.snapshotId).catch(() => undefined);
      if (restartsLeft > 0 && isSessionLost(error)) {
        restartsLeft -= 1;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Hydrate and return the rows.
 *
 * The convenience form for a caller that wants the whole answer in hand — the
 * real-daemon tests, Task 6b's fixtures, and any first hydration whose result
 * is about to be installed wholesale.
 */
export async function hydrate(
  client: VaultdClient,
  config: HydrationConfig,
): Promise<HydrationResult> {
  const collector = new HydrationCollector();
  const summary = await hydrateInto(client, config, collector);
  return { ...summary, entries: collector.entries, notes: collector.notes };
}

/**
 * A tree row, camelCased.
 *
 * `revision` and `size` become `null` rather than staying absent, because a
 * mirror row is answered synchronously to a shim that must not have to know
 * which flavour of nothing the wire omitted. `null` for `revision` covers both
 * of the wire's absences: a folder, and **any non-note file** — the index
 * stores no content revision for an attachment.
 */
export function mirrorEntry(dto: TreeEntryDto): MirrorEntry {
  const cut = dto.path.lastIndexOf("/");
  return {
    path: dto.path,
    kind: dto.kind,
    name: cut === -1 ? dto.path : dto.path.slice(cut + 1),
    parent: cut === -1 ? "" : dto.path.slice(0, cut),
    revision: dto.revision ?? null,
    size: dto.size ?? null,
    ctimeMs: dto.ctime_unix_ms,
    mtimeMs: dto.mtime_unix_ms,
  };
}

/**
 * A note row, camelCased — the one place in the host where the wire's
 * `snake_case` becomes the Obsidian-facing spelling.
 *
 * `list_items` → `listItems` is the only renamed field; the DTOs *inside* the
 * arrays keep their wire spelling, because they are wire types and re-spelling
 * them would mean re-declaring them.
 *
 * **`SnapshotNoteDto` only — the `get_note` path needs its own converter.**
 * `GetNoteResponse.note` is a `NoteDto`, a different shape: the metadata fields
 * are flat and top-level with no `metadata` wrapper, the outgoing references
 * live under `outgoing` (there is no `references` key), there is a `source`,
 * and `sections` / `list_items` are the only optional fields. This function
 * cannot be handed one. Unlike `mirrorEntry`, which *is* reusable —
 * `GetTreeEntriesResponse.entries` really is `TreeEntryDto[]`.
 *
 * And the difference matters beyond the field names: an absent facet becomes an
 * empty array **here** because a hydration asked for every facet it mirrors, so
 * absence means the daemon did not serve what was asked. On `get_note`,
 * `include` is a genuine choice — it accepts only `sections` and `list_items`,
 * and naming any other facet is `invalid_request` — so absent and empty stay
 * distinguishable there and that converter must test `=== undefined` rather
 * than defaulting.
 */
export function mirrorNoteRow(dto: SnapshotNoteDto): MirrorNoteRow {
  const metadata = dto.metadata;
  return {
    path: dto.path,
    revision: dto.revision,
    properties: metadata?.properties ?? [],
    aliases: metadata?.aliases ?? [],
    headings: metadata?.headings ?? [],
    blocks: metadata?.blocks ?? [],
    tags: metadata?.tags ?? [],
    diagnostics: metadata?.diagnostics ?? [],
    sections: dto.sections ?? [],
    listItems: dto.list_items ?? [],
    outgoing: dto.references ?? [],
  };
}

/** The default sink: keep every row, in page order. */
class HydrationCollector implements MirrorSink {
  entries: MirrorEntry[] = [];
  notes: MirrorNoteRow[] = [];

  /** A walk is starting, so whatever an abandoned one accumulated is void. */
  begin(): void {
    this.entries = [];
    this.notes = [];
  }

  applyTreePage(entries: readonly MirrorEntry[]): void {
    this.entries.push(...entries);
  }

  applyNotePage(notes: readonly MirrorNoteRow[]): void {
    this.notes.push(...notes);
  }

  commit(): void {
    // Nothing to do: the arrays are the answer, and `hydrate` reads them only
    // after `hydrateInto` has returned, which happens only after a commit.
  }
}

interface WalkTotals {
  readonly entries: number;
  readonly notes: number;
  readonly count: number;
}

/** Page the whole tree, then the whole note set, inside one pinned session. */
async function walk(
  client: VaultdClient,
  session: SnapshotSession,
  limit: number,
  sink: MirrorSink,
): Promise<WalkTotals> {
  let pages = 0;
  let entries = 0;
  let notes = 0;

  let cursor: string | null = null;
  for (;;) {
    const page: SnapshotTreeResponse = await client.request<SnapshotTreeResponse>("snapshot_tree", {
      snapshot_id: session.snapshotId,
      cursor,
      limit,
    });
    requireGeneration("snapshot_tree", session, page.generation);
    pages += 1;
    entries += page.entries.length;
    // Checked before the rows are handed over, so a runaway walk is refused
    // rather than staged: this is the bound on the page loop.
    if (entries > session.promisedEntryCount) throw HydrationCoherenceError.overWalk(session, "tree");
    sink.applyTreePage(page.entries.map(mirrorEntry), pages);
    cursor = page.next_cursor;
    if (cursor === null) break;
  }

  cursor = null;
  for (;;) {
    const page: SnapshotNotesResponse = await client.request<SnapshotNotesResponse>(
      "snapshot_notes",
      {
        snapshot_id: session.snapshotId,
        cursor,
        limit,
        include: [...HYDRATION_FACETS],
      },
    );
    requireGeneration("snapshot_notes", session, page.generation);
    pages += 1;
    notes += page.notes.length;
    if (notes > session.promisedNoteCount) throw HydrationCoherenceError.overWalk(session, "note");
    sink.applyNotePage(page.notes.map(mirrorNoteRow), pages);
    cursor = page.next_cursor;
    if (cursor === null) break;
  }

  // The promise `open_snapshot` made, kept or not. Until this comparison
  // existed, a walk that ended early produced a mirror silently missing notes
  // that committed cleanly and reported a coherent generation.
  if (entries !== session.promisedEntryCount || notes !== session.promisedNoteCount) {
    throw HydrationCoherenceError.shortWalk(session, entries, notes);
  }

  return { entries, notes, count: pages };
}

async function openSession(client: VaultdClient): Promise<SnapshotSession> {
  const response = await client.request<OpenSnapshotResponse>("open_snapshot", {});
  return {
    snapshotId: response.snapshot_id,
    generation: response.generation,
    promisedNoteCount: response.note_count,
    promisedEntryCount: response.entry_count,
  };
}

/**
 * Release a session.
 *
 * A session that is already gone — reclaimed, or lost with its pin — answers
 * `snapshot_not_found`, and that is the *expected* outcome of closing one, not
 * a failure worth a word. Anything else is warned about: it means a pin the
 * daemon is still holding for a host that has stopped reading it.
 */
async function releaseSession(client: VaultdClient, snapshotId: string): Promise<void> {
  try {
    await client.request<CloseSnapshotResponse>("close_snapshot", { snapshot_id: snapshotId });
  } catch (error) {
    if (isCode(error, "snapshot_not_found")) return;
    process.emitWarning(
      `vaultd snapshot ${snapshotId} could not be closed: ${describe(error)}. ` +
        "Its WAL pin is held until the daemon's idle timeout reclaims it.",
      { type: "VaultdSnapshotCloseFailed" },
    );
  }
}

/** The page size, from configuration, clamped to the daemon's documented range. */
function pageLimit(config: HydrationConfig): number {
  const capped = Math.min(config.snapshotPageSize, config.snapshotPageSizeMax);
  return Math.max(1, Math.trunc(capped));
}

function requireGeneration(method: string, session: SnapshotSession, generation: number): void {
  if (generation === session.generation) return;
  throw HydrationCoherenceError.generationDrift(method, session.generation, generation);
}

/** The wait before retry `index`; a retry past the ladder reuses its last rung. */
function backoffFor(index: number): number {
  const rung = Math.min(index, SNAPSHOT_RETRY_BACKOFF_MS.length - 1);
  return SNAPSHOT_RETRY_BACKOFF_MS[rung]!;
}

/** Both ways a session can stop existing under a walk that is still using it. */
function isSessionLost(error: unknown): boolean {
  return isCode(error, "generation_mismatch") || isCode(error, "snapshot_not_found");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof VaultdError && error.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait on the host's one time source. Never the global timer. */
function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}
