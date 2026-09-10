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
 * And one refusal that is not retried: a page whose `generation` differs from
 * the session's own. That is a daemon that is not pinning, and no recovery
 * exists for it — merging the page anyway produces exactly the torn mirror the
 * session was opened to prevent.
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
 * `backlinks` is deliberately absent: the mirror derives every note's backlinks
 * from the other notes' `outgoing`, so asking for them would page the same
 * edges a second time in the opposite direction.
 */
export const HYDRATION_FACETS: readonly NoteFacetDto[] = [
  "metadata",
  "references",
  "resolutions",
  "sections",
  "list_items",
];

/**
 * The `open_snapshot` retry ladder, in milliseconds.
 *
 * Its **length is the number of attempts**, not the number of retries, so the
 * last rung is never waited on: four attempts, three waits. Every wait is asked
 * of `config.clock`, which is what lets a test prove the ladder without
 * spending 1.5 s of wall clock on it.
 */
export const SNAPSHOT_RETRY_BACKOFF_MS: readonly number[] = [100, 200, 400, 800];

/** How many snapshot sessions one hydration may open before giving up. */
export const HYDRATION_ATTEMPTS = SNAPSHOT_RETRY_BACKOFF_MS.length;

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
  "clock" | "snapshotPageSize" | "snapshotPageSizeMax"
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

/**
 * A page arrived carrying a generation that is not its session's.
 *
 * Separate from {@link VaultdError} on purpose: this is not something the
 * daemon said, it is something this host noticed the daemon doing, and it is
 * never retried.
 */
export class HydrationCoherenceError extends Error {
  readonly sessionGeneration: number;
  readonly pageGeneration: number;

  constructor(method: string, sessionGeneration: number, pageGeneration: number) {
    super(
      `${method} answered generation ${pageGeneration} inside a session pinned at ` +
        `${sessionGeneration}: the snapshot is not coherent and the mirror refuses to mix generations`,
    );
    this.name = "HydrationCoherenceError";
    this.sessionGeneration = sessionGeneration;
    this.pageGeneration = pageGeneration;
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

  for (let attempt = 0; attempt < HYDRATION_ATTEMPTS; attempt += 1) {
    const last = attempt + 1 === HYDRATION_ATTEMPTS;
    let session: SnapshotSession;
    try {
      session = await openSession(client);
      sessions += 1;
    } catch (error) {
      // The cap is the daemon's, not a fault: wait and ask again.
      if (!last && isCode(error, "too_many_snapshots")) {
        await delay(config.clock, SNAPSHOT_RETRY_BACKOFF_MS[attempt]!);
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
      void releaseSession(client, session.snapshotId).catch(() => undefined);
      if (!last && isSessionLost(error)) continue;
      throw error;
    }
  }

  // Unreachable: every arm above either returns, continues, or throws, and the
  // last attempt never continues.
  throw new Error("hydration exhausted its attempts without an outcome");
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
 * An absent facet becomes an empty array here, and only here: a hydration asked
 * for all five, so absence means the daemon did not serve what was asked. On
 * `get_note`, where `include` is a genuine choice, absent and empty stay
 * distinguishable and a consumer must test `=== undefined`.
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
    sink.applyNotePage(page.notes.map(mirrorNoteRow), pages);
    cursor = page.next_cursor;
    if (cursor === null) break;
  }

  return { entries, notes, count: pages };
}

async function openSession(client: VaultdClient): Promise<SnapshotSession> {
  const response = await client.request<OpenSnapshotResponse>("open_snapshot", {});
  return {
    snapshotId: response.snapshot_id,
    generation: response.generation,
    noteCount: response.note_count,
    entryCount: response.entry_count,
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
  throw new HydrationCoherenceError(method, session.generation, generation);
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
