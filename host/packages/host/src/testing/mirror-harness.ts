/**
 * A hydrated {@link Mirror} over a {@link FakeDaemon}, driven from fixtures.
 *
 * This is Task 6b's `mirror-harness.ts`, built here because Task 6 is its first
 * consumer, with the shape that task specifies.
 *
 * The fixtures are deliberately **thin**: a path, a kind, a revision, and
 * whatever facets a case actually cares about. Everything else the wire carries
 * is filled in here, in one place, so a case that is about backlinks does not
 * have to spell out six empty facet arrays to say so — and so the day a DTO
 * gains a field, one file changes rather than forty.
 */

import { Mirror } from "../mirror/mirror";
import { DaemonHarness, revisionOfSource } from "./daemon-harness";
import type { HostConfig } from "../config";
import type {
  AliasDto,
  BlockDto,
  DiagnosticDto,
  HeadingDto,
  ListItemDto,
  NoteDto,
  PropertyDto,
  ReferenceDto,
  SectionDto,
  SnapshotNoteDto,
  TagDto,
  TreeEntryDto,
  TreeEntryKindDto,
} from "../client/protocol";

/** Fixed so a case that asserts on `stat` has something stable to assert. */
const FIXTURE_CTIME_MS = 1_700_000_000_000;
const FIXTURE_MTIME_MS = 1_700_000_001_000;

export interface FixtureEntry {
  path: string;
  kind: TreeEntryKindDto;
  revision?: string;
  size?: number;
  ctimeMs?: number;
  mtimeMs?: number;
}

export interface FixtureNote {
  path: string;
  revision: string;
  properties?: PropertyDto[];
  aliases?: AliasDto[];
  headings?: HeadingDto[];
  blocks?: BlockDto[];
  tags?: TagDto[];
  sections?: SectionDto[];
  listItems?: ListItemDto[];
  outgoing?: ReferenceDto[];
}

export interface HydrationSpec {
  generation: number;
  entries: FixtureEntry[];
  notes: FixtureNote[];
}

/** How a refetch answer departs from "every asked path is one of these notes". */
export interface RefetchAnswer {
  /** Tree rows for paths that are not notes, or whose kind a case chose. */
  entries?: FixtureEntry[];
  /** Paths the daemon has no row for. They come back in `absent`. */
  absent?: string[];
  /** The generation `get_note` answers at, when it differs from the tree's. */
  noteGeneration?: number;
}

export class MirrorHarness extends DaemonHarness {
  private mirrorValue: Mirror | null = null;

  private constructor(overrides: Partial<HostConfig>) {
    super(overrides);
  }

  /** Open a Mirror and answer its whole hydration handshake from the spec. */
  static async hydrated(
    spec: HydrationSpec,
    overrides: Partial<HostConfig> = {},
  ): Promise<MirrorHarness> {
    const harness = new MirrorHarness(overrides);
    const opening = Mirror.open(harness.client, harness.config);
    await harness.answerHydration(spec);
    harness.mirrorValue = await opening;
    harness.clearMethodLog();
    return harness;
  }

  get mirror(): Mirror {
    if (!this.mirrorValue) throw new Error("the harness has no mirror yet");
    return this.mirrorValue;
  }

  /** Answer a full hydration walk — open, tree, notes, close — from a spec. */
  answerHydration(spec: HydrationSpec): Promise<void> {
    return answerHydrationOn(this, spec);
  }

  /**
   * Answer the refetch a pending `applyEvent` / `applyMutation` is waiting on.
   *
   * Returns the set of paths the subject actually asked for — which is how a
   * case asserts that the mirror expanded a change set on its own (the
   * ancestors of a created path, say) without the answer having named them.
   *
   * **Asynchronous, and it has to be.** A request crosses a `PassThrough`
   * before the daemon has parsed it, so there is no instant at which a
   * synchronous answer could see the request it is answering. A test that
   * awaits this and then awaits the application is asserting the real order.
   */
  async answerRefetch(
    generation: number,
    notes: FixtureNote[],
    answer: RefetchAnswer = {},
  ): Promise<ReadonlySet<string>> {
    const byPath = new Map(notes.map((note) => [note.path, note]));
    const overrides = new Map((answer.entries ?? []).map((entry) => [entry.path, entry]));
    const absent = new Set(answer.absent ?? []);

    const request = await this.expectRequest("get_tree_entries");
    const asked = (request.request.params as { paths: string[] }).paths;
    const entries: TreeEntryDto[] = [];
    const missing: string[] = [];
    for (const path of asked) {
      if (absent.has(path)) {
        missing.push(path);
        continue;
      }
      const override = overrides.get(path);
      if (override) {
        entries.push(treeEntryDto(override));
        continue;
      }
      const note = byPath.get(path);
      if (note) {
        entries.push(treeEntryDto({ path, kind: "note", revision: note.revision }));
        continue;
      }
      missing.push(path);
    }
    this.respondOk(request.id, "get_tree_entries", { generation, entries, absent: missing });

    const notePaths = entries.filter((entry) => entry.kind === "note");
    for (let i = 0; i < notePaths.length; i += 1) {
      const noteRequest = await this.expectRequest("get_note");
      const path = (noteRequest.request.params as { path: string }).path;
      const fixture = byPath.get(path);
      if (!fixture) {
        this.respondErr(noteRequest.id, {
          code: "note_not_found",
          message: `${path} has no fixture in this refetch answer`,
        });
        continue;
      }
      this.respondOk(noteRequest.id, "get_note", {
        generation: answer.noteGeneration ?? generation,
        note: noteDto(fixture),
      });
    }
    return new Set(asked);
  }

  /**
   * Answer every `read_file` the position warm-up issues, one per source.
   *
   * The revision answered is the one the mirror's own row carries, because a
   * warm-up that meets a revision it did not expect deliberately skips the
   * note — so a fixture that answered some other revision would be testing the
   * skip rather than the warm.
   */
  async answerWarm(sources: Record<string, string>): Promise<number> {
    const remaining = new Set(Object.keys(sources));
    let served = 0;
    while (remaining.size > 0) {
      const request = await this.expectRequest("read_file");
      const path = (request.request.params as { path: string }).path;
      const content = sources[path];
      if (content === undefined) {
        this.respondErr(request.id, { code: "not_found", message: `${path} has no fixture source` });
        continue;
      }
      this.respondReadFile(request.id, content, this.mirror.note(path)?.revision ?? revisionOfSource(content));
      remaining.delete(path);
      served += 1;
    }
    return served;
  }
}

let snapshotSequence = 0;

/**
 * Answer one whole hydration handshake on any {@link DaemonHarness}.
 *
 * Free rather than a method because a mirror driven by a **client supplier** —
 * which is every mirror behind a supervisor, since the connection dies with its
 * engine — hydrates on one harness and re-hydrates on another. A method on
 * `MirrorHarness` could only ever answer for its own.
 */
export async function answerHydrationOn(
  harness: DaemonHarness,
  spec: HydrationSpec,
): Promise<void> {
  snapshotSequence += 1;
  const snapshotId = `snap-${String(snapshotSequence)}`;
  const open = await harness.expectRequest("open_snapshot");
  harness.respondOk(open.id, "open_snapshot", {
    snapshot_id: snapshotId,
    generation: spec.generation,
    note_count: spec.notes.length,
    entry_count: spec.entries.length,
  });
  const tree = await harness.expectRequest("snapshot_tree");
  harness.respondOk(tree.id, "snapshot_tree", {
    snapshot_id: snapshotId,
    generation: spec.generation,
    entries: spec.entries.map(treeEntryDto),
    next_cursor: null,
  });
  const notes = await harness.expectRequest("snapshot_notes");
  harness.respondOk(notes.id, "snapshot_notes", {
    snapshot_id: snapshotId,
    generation: spec.generation,
    notes: spec.notes.map(snapshotNoteDto),
    next_cursor: null,
  });
  const close = await harness.expectRequest("close_snapshot");
  harness.respondOk(close.id, "close_snapshot", { snapshot_id: snapshotId });
}

/**
 * A resolved (or unresolved) wikilink from `sourcePath`.
 *
 * `resolvedTarget` of `null` builds an unresolved reference, which is what puts
 * it in `unresolvedLinks` rather than `resolvedLinks`.
 */
export function harness_ref(
  sourcePath: string,
  rawTarget: string,
  resolvedTarget: string | null,
): ReferenceDto {
  return {
    source_path: sourcePath,
    kind: "wikilink",
    origin: "body",
    raw_target: rawTarget,
    file_target: rawTarget,
    subpath: null,
    display: null,
    span: { start: 0, end: rawTarget.length + 4 },
    target_span: { start: 2, end: rawTarget.length + 2 },
    resolution:
      resolvedTarget === null
        ? { kind: "unresolved" }
        : { kind: "resolved", target: resolvedTarget, subpath: null },
  };
}

/**
 * A fixture entry as the wire spells it.
 *
 * A folder has no `size` and no `revision`; **an attachment has no `revision`
 * either** — the index stores no content revision for a non-note file, which is
 * ratified correction #13 and is measured against the real daemon in
 * `mirror-hydrate-real-daemon.test.ts`.
 */
function treeEntryDto(fixture: FixtureEntry): TreeEntryDto {
  const base: TreeEntryDto = {
    path: fixture.path,
    kind: fixture.kind,
    ctime_unix_ms: fixture.ctimeMs ?? FIXTURE_CTIME_MS,
    mtime_unix_ms: fixture.mtimeMs ?? FIXTURE_MTIME_MS,
  };
  if (fixture.kind === "folder") return base;
  const sized: TreeEntryDto = { ...base, size: fixture.size ?? 1 };
  if (fixture.kind !== "note") return sized;
  return { ...sized, revision: fixture.revision ?? revisionOfSource(fixture.path) };
}

/** Every facet a hydration asks for is present, because a hydration asks. */
function snapshotNoteDto(fixture: FixtureNote): SnapshotNoteDto {
  return {
    path: fixture.path,
    revision: fixture.revision,
    metadata: {
      properties: fixture.properties ?? [],
      aliases: fixture.aliases ?? [],
      headings: fixture.headings ?? [],
      blocks: fixture.blocks ?? [],
      tags: fixture.tags ?? [],
      diagnostics: [],
    },
    references: fixture.outgoing ?? [],
    sections: fixture.sections ?? [],
    list_items: fixture.listItems ?? [],
  };
}

/**
 * The same fixture as `get_note` answers it: flat metadata, `outgoing` rather
 * than `references`, a `source`, and `sections` / `list_items` present because
 * the refetch named them in `include`.
 */
function noteDto(fixture: FixtureNote): NoteDto {
  return {
    path: fixture.path,
    revision: fixture.revision,
    source: "",
    properties: fixture.properties ?? [],
    aliases: fixture.aliases ?? [],
    headings: fixture.headings ?? [],
    blocks: fixture.blocks ?? [],
    tags: fixture.tags ?? [],
    diagnostics: [] as DiagnosticDto[],
    outgoing: fixture.outgoing ?? [],
    sections: fixture.sections ?? [],
    list_items: fixture.listItems ?? [],
  };
}
