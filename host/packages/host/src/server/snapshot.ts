/**
 * The four snapshot ops, answered from the **mirror** (Ruling 5).
 *
 * A client hydrating through this host would otherwise need two connections:
 * one to the host for everything a plugin can do, and one to the daemon for the
 * vault itself. It already has a coherent copy of the vault sitting in this
 * process — the mirror, which is what every shim surface answers from — so the
 * host serves the walk from there and the client needs one door.
 *
 * **A host snapshot pins nothing daemon-side.** No `open_snapshot` is sent, no
 * read transaction is held, no WAL frame is kept alive. What a session freezes
 * is two arrays in this process: the tree rows and the note paths, as the mirror
 * held them at the generation the session opened at. That is why the cap here is
 * the host's own {@link HostConfig.snapshotSessionCap} rather than the daemon's
 * four, and why a forgotten session costs memory rather than a deferred
 * checkpoint.
 *
 * **The field names are `vaultd`'s own.** The pages answer `entries` and
 * `notes`, matching `SnapshotTreeResponse` and `SnapshotNotesResponse`, because
 * the point of Ruling 5 is that a client pages the host exactly as it would page
 * the daemon. Renaming either field would force every client to branch on which
 * door its page came through, which is the coupling this exists to remove.
 *
 * **A moved generation is `generation_mismatch`, not a stale page.** The session
 * could serve its frozen arrays forever — nothing else is holding them — but a
 * client that asked for a coherent view of generation 12 and silently got one
 * that the vault has moved past would have no way to know. The daemon answers
 * `generation_mismatch` with `current_generation` in exactly this situation, so
 * that is what this answers, and a client's retry loop is the same one either
 * way.
 */

import { HostError } from "./wire";
import { toWireTreeEntry } from "./wire";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { MirrorNoteRow } from "../mirror/types";
import type {
  CloseSnapshotResponse,
  NoteFacetDto,
  OpenSnapshotResponse,
  ResolutionDto,
  SnapshotNoteDto,
  SnapshotNotesResponse,
  SnapshotTreeResponse,
} from "../client/protocol";

/** Which per-note row-sets a page may carry. `vaultd`'s set, exactly. */
const FACETS: readonly NoteFacetDto[] = [
  "metadata",
  "references",
  "resolutions",
  "backlinks",
  "sections",
  "list_items",
];

/** One frozen view of the mirror, addressed by id. */
interface Session {
  readonly id: string;
  readonly owner: object;
  readonly generation: number;
  /** Path-ordered, as the mirror held them at {@link Session.generation}. */
  readonly entries: readonly string[];
  readonly notes: readonly string[];
}

/**
 * The cursor, as a client sees it: opaque.
 *
 * It is an index inside one session's frozen array, base64url of a small JSON
 * document. Opaque is the contract rather than the encoding — a client that
 * decoded this and did arithmetic on the index would be relying on something the
 * host is free to change — and the session id is carried inside it so that a
 * cursor from one session handed to another is `invalid_cursor` rather than a
 * page of somebody else's vault.
 */
interface Cursor {
  readonly s: string;
  readonly i: number;
}

export class SnapshotStore {
  private readonly sessions = new Map<string, Session>();
  private sequence = 0;

  constructor(
    private readonly mirror: Mirror,
    private readonly config: HostConfig,
  ) {}

  /** How many sessions are open across every client. */
  count(): number {
    return this.sessions.size;
  }

  /** How many sessions this one client holds — the number the cap bounds. */
  countFor(owner: object): number {
    let held = 0;
    for (const session of this.sessions.values()) if (session.owner === owner) held += 1;
    return held;
  }

  open(owner: object): OpenSnapshotResponse {
    // **Per client, not host-wide.** A host-wide cap lets one leaking client
    // lock every other client out of hydration until it disconnects — which is
    // a denial of service by accident, from a peer that is only guilty of
    // forgetting to close its sessions. Each client gets its own budget, and a
    // client that exhausts it has only itself to blame.
    if (this.countFor(owner) >= this.config.snapshotSessionCap) {
      throw new HostError(
        "too_many_snapshots",
        `this connection may hold ${String(this.config.snapshotSessionCap)} snapshot sessions at ` +
          "once; close one before opening another",
      );
    }
    this.sequence += 1;
    const id = `host-snap-${String(this.sequence)}`;
    const entries = this.mirror.entries();
    const session: Session = {
      id,
      owner,
      generation: this.mirror.generation(),
      entries: entries.map((entry) => entry.path),
      // A note entry whose semantic row the mirror does not hold is not paged
      // out: `snapshot_notes` promises rows, and a path with no row would be a
      // note the page could only describe by inventing one.
      notes: entries
        .filter((entry) => entry.kind === "note" && this.mirror.note(entry.path) !== undefined)
        .map((entry) => entry.path),
    };
    this.sessions.set(id, session);
    return {
      snapshot_id: id,
      generation: session.generation,
      note_count: session.notes.length,
      entry_count: session.entries.length,
    };
  }

  tree(owner: object, params: { snapshotId: string; cursor: string | null; limit?: number }): SnapshotTreeResponse {
    const session = this.sessionFor(owner, params.snapshotId);
    const from = this.offset(session, params.cursor);
    const limit = this.limitOf(params.limit);
    const page = session.entries.slice(from, from + limit);
    const next = from + page.length;
    return {
      snapshot_id: session.id,
      generation: session.generation,
      // Read from the mirror **now** rather than copied at open: a row that has
      // moved since is a row this session should not be serving at all, and the
      // generation check above has already refused that case. What this avoids
      // is a second copy of every tree row per open session.
      entries: page.flatMap((path) => {
        const entry = this.mirror.entry(path);
        return entry === undefined ? [] : [toWireTreeEntry(entry)];
      }),
      next_cursor: next >= session.entries.length ? null : encodeCursor({ s: session.id, i: next }),
    };
  }

  notes(
    owner: object,
    params: {
      snapshotId: string;
      cursor: string | null;
      limit?: number;
      include?: readonly string[];
    },
  ): SnapshotNotesResponse {
    const session = this.sessionFor(owner, params.snapshotId);
    const include = facetsOf(params.include);
    const from = this.offset(session, params.cursor);
    const limit = this.limitOf(params.limit);
    const page = session.notes.slice(from, from + limit);
    const next = from + page.length;
    return {
      snapshot_id: session.id,
      generation: session.generation,
      notes: page.flatMap((path) => {
        const row = this.mirror.note(path);
        return row === undefined ? [] : [this.noteDto(row, include)];
      }),
      next_cursor: next >= session.notes.length ? null : encodeCursor({ s: session.id, i: next }),
    };
  }

  close(owner: object, snapshotId: string): CloseSnapshotResponse {
    const session = this.sessions.get(snapshotId);
    if (session === undefined || session.owner !== owner) throw notFound(snapshotId);
    this.sessions.delete(snapshotId);
    return { snapshot_id: snapshotId };
  }

  /**
   * Drop every session one client held.
   *
   * A disconnect releases them, exactly as a disconnect releases a daemon
   * session, so a crashed client cannot leave a frozen view of the vault in this
   * host's memory for the life of the process.
   */
  closeAll(owner: object): void {
    for (const [id, session] of [...this.sessions]) {
      if (session.owner === owner) this.sessions.delete(id);
    }
  }

  /**
   * One note's requested facets.
   *
   * **`sections` and `list_items` are top-level facets, siblings of `metadata`
   * rather than nested inside it** — the daemon's shape, and a client that found
   * them under `metadata` here would have to special-case the host.
   *
   * A facet a client did not ask for is **absent**, never empty, so "I did not
   * ask" and "there are none" stay distinguishable.
   */
  private noteDto(row: MirrorNoteRow, include: ReadonlySet<NoteFacetDto>): SnapshotNoteDto {
    const dto: SnapshotNoteDto = { path: row.path, revision: row.revision };
    if (include.has("metadata")) {
      dto.metadata = {
        properties: [...row.properties],
        aliases: [...row.aliases],
        headings: [...row.headings],
        blocks: [...row.blocks],
        tags: [...row.tags],
        diagnostics: [...row.diagnostics],
      };
    }
    if (include.has("references")) dto.references = [...row.outgoing];
    if (include.has("resolutions")) {
      // The answers-only projection of `references`, which is what the daemon's
      // own `resolutions` facet is: every answer is already on
      // `outgoing[].resolution`, so this is a narrowing rather than a second
      // source that could disagree with the first.
      dto.resolutions = row.outgoing.map((reference): ResolutionDto => reference.resolution);
    }
    if (include.has("backlinks")) dto.backlinks = [...this.mirror.backlinks(row.path)];
    if (include.has("sections")) dto.sections = [...row.sections];
    if (include.has("list_items")) dto.list_items = [...row.listItems];
    return dto;
  }

  /**
   * The session, if this client owns it and the mirror has not moved past it.
   *
   * A session another client opened answers `snapshot_not_found` rather than
   * `not_owner`: the id is one this client was never given, and saying "that one
   * is somebody else's" would confirm the existence of a session it cannot
   * address.
   */
  private sessionFor(owner: object, snapshotId: string): Session {
    const session = this.sessions.get(snapshotId);
    if (session === undefined || session.owner !== owner) throw notFound(snapshotId);
    const current = this.mirror.generation();
    if (current !== session.generation) {
      throw new HostError(
        "generation_mismatch",
        `snapshot ${snapshotId} was pinned at generation ${String(session.generation)} and this ` +
          `host is now at ${String(current)}; reopen the session`,
        { current_generation: current },
      );
    }
    return session;
  }

  private offset(session: Session, cursor: string | null): number {
    if (cursor === null || cursor === undefined) return 0;
    const decoded = decodeCursor(cursor);
    if (decoded.s !== session.id) {
      throw new HostError("invalid_cursor", `that cursor belongs to another snapshot session`);
    }
    return decoded.i;
  }

  /**
   * The page size, clamped rather than refused.
   *
   * The daemon clamps a snapshot `limit` into `1..=max` — including `0`, which
   * becomes 1 — where an out-of-range `limit` on the *collection* operations is
   * `invalid_cursor`. The difference is deliberate there and copied here: a
   * hydration loop that asks for too much should page more times, not fail half
   * way through a vault.
   */
  private limitOf(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return this.config.snapshotPageSize;
    return Math.max(1, Math.min(Math.floor(limit), this.config.snapshotPageSizeMax));
  }
}

function notFound(snapshotId: string): HostError {
  return new HostError(
    "snapshot_not_found",
    `no open snapshot session ${snapshotId}; it was never opened, or it has been closed`,
  );
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new HostError("invalid_cursor", "that cursor is not one this host issued");
  }
  const body = parsed as { s?: unknown; i?: unknown } | null;
  // **`i >= 0`, and the check is not decoration.** A cursor is opaque but a
  // client holds the bytes, so a forged `{ i: -5 }` used to slice from the *end*
  // of the frozen array and mint a `next_cursor` carrying `-4` — a page of the
  // wrong rows, answered as though it were the right ones.
  if (
    typeof body?.s !== "string" ||
    typeof body.i !== "number" ||
    !Number.isInteger(body.i) ||
    body.i < 0
  ) {
    throw new HostError("invalid_cursor", "that cursor is not one this host issued");
  }
  return { s: body.s, i: body.i };
}

/**
 * The facets a page was asked for.
 *
 * **An unknown value inside `include` is `invalid_request`**, which is the
 * daemon's rule and is the one place its tolerance of unknown *fields* does not
 * extend: ignoring a misspelled facet name would serve a page silently missing
 * the facet the client asked for.
 */
function facetsOf(include: readonly string[] | undefined): ReadonlySet<NoteFacetDto> {
  if (include === undefined) return new Set();
  const known = new Set<NoteFacetDto>();
  for (const facet of include) {
    if (!(FACETS as readonly string[]).includes(facet)) {
      throw new HostError(
        "invalid_request",
        `"${facet}" is not a note facet; the facets are ${FACETS.join(", ")}`,
      );
    }
    known.add(facet as NoteFacetDto);
  }
  return known;
}
