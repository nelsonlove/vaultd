import { describe, expect, it } from "vitest";

import { VaultdClient } from "../src/client/client";
import { defaultHostConfig } from "../src/config";
import { FakeDaemon } from "../src/testing/fake-daemon";
import { SNAPSHOT_RETRY_BACKOFF_MS, hydrate, hydrateInto } from "../src/mirror/hydrate";
import type { HostConfig } from "../src/config";
import type { MirrorEntry, MirrorNoteRow, MirrorSink, SnapshotSession } from "../src/mirror/types";
import { FakeClock } from "./fake-clock";

/**
 * Hydration against `FakeDaemon`.
 *
 * Everything here is a claim about **this host's** behaviour — the exact params
 * it sends, what it does with a refusal, and that a session is never leaked —
 * so a fake is the right instrument: it is exact and it can be made to refuse
 * on demand, which is the only way to reach the pin-loss and cap-reached arms
 * at all (a daemon cannot be made to lose a pin from outside).
 * `mirror-hydrate-real-daemon.test.ts` carries the other half: that the wire
 * this file asserts is the wire `vaultd` actually speaks, and that one
 * hydration is coherent at one generation while the vault is being written.
 */

function configFor(overrides: Partial<HostConfig> = {}): HostConfig {
  return { ...defaultHostConfig("/vault"), ...overrides };
}

function clientFor(daemon: FakeDaemon): VaultdClient {
  return new VaultdClient({
    stdout: daemon.stdout,
    stdin: daemon.stdin,
    onEvent: () => {},
    onFatal: () => {},
    onHandlerError: () => {},
  });
}

/**
 * The four facets a hydration asks for, in the order it asks for them.
 *
 * `resolutions` is **not** among them and must not come back: it is the
 * answers-only projection of `references` (`vault-index/src/snapshot.rs` builds
 * both from one load), every `ReferenceDto` already carries its own
 * `resolution`, and `MirrorNoteRow` has no field for the copy.
 */
const INCLUDE = ["metadata", "references", "sections", "list_items"];

const EMPTY_METADATA = {
  properties: [],
  aliases: [],
  headings: [],
  blocks: [],
  tags: [],
  diagnostics: [],
};

describe("hydrate", () => {
  it("pages tree and notes inside one snapshot session and always closes it", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 2 }));

    const open = (await daemon.received(1))[0]!;
    expect(open.request).toEqual({ method: "open_snapshot", params: {} });
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-1",
      generation: 42,
      note_count: 1,
      entry_count: 4,
    });

    const treeA = (await daemon.received(2))[1]!;
    expect(treeA.request).toEqual({
      method: "snapshot_tree",
      params: { snapshot_id: "snap-1", cursor: null, limit: 2 },
    });
    // `entries`, not `items`. A folder carries neither `size` nor `revision`,
    // and — correction #13, ratified — **neither does an attachment**: the
    // index stores no content revision for a non-note file.
    daemon.respondOk(treeA.id, "snapshot_tree", {
      snapshot_id: "snap-1",
      generation: 42,
      next_cursor: "c1",
      entries: [
        { path: "Folder", kind: "folder", ctime_unix_ms: 1, mtime_unix_ms: 1 },
        {
          path: "Folder/A.md",
          kind: "note",
          revision: "blake3:aa",
          size: 10,
          ctime_unix_ms: 2,
          mtime_unix_ms: 2,
        },
      ],
    });

    const treeB = (await daemon.received(3))[2]!;
    expect(treeB.request).toEqual({
      method: "snapshot_tree",
      params: { snapshot_id: "snap-1", cursor: "c1", limit: 2 },
    });
    daemon.respondOk(treeB.id, "snapshot_tree", {
      snapshot_id: "snap-1",
      generation: 42,
      next_cursor: null,
      entries: [
        {
          path: "B.md",
          kind: "note",
          revision: "blake3:bb",
          size: 4,
          ctime_unix_ms: 3,
          mtime_unix_ms: 3,
        },
        { path: "img.png", kind: "file", size: 99, ctime_unix_ms: 4, mtime_unix_ms: 4 },
      ],
    });

    const notes = (await daemon.received(4))[3]!;
    // `sections` and `list_items` are requested BY NAME as top-level facets. A
    // client that omits them gets no structural data and no error.
    expect(notes.request).toEqual({
      method: "snapshot_notes",
      params: { snapshot_id: "snap-1", cursor: null, limit: 2, include: INCLUDE },
    });
    // `notes`, not `items`; sections and list_items are siblings of metadata.
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-1",
      generation: 42,
      next_cursor: null,
      notes: [
        {
          path: "Folder/A.md",
          revision: "blake3:aa",
          metadata: {
            ...EMPTY_METADATA,
            headings: [{ level: 1, text: "A", span: { start: 0, end: 3 } }],
          },
          references: [
            {
              source_path: "Folder/A.md",
              kind: "wikilink",
              origin: "body",
              raw_target: "B",
              file_target: "B",
              subpath: null,
              display: null,
              span: { start: 4, end: 9 },
              target_span: { start: 6, end: 7 },
              resolution: { kind: "resolved", target: "B.md", subpath: null },
            },
          ],
          sections: [{ kind: "heading", span: { start: 0, end: 3 } }],
          list_items: [{ span: { start: 4, end: 9 }, list_start_line: 1, task: " " }],
        },
      ],
    });

    const close = (await daemon.received(5))[4]!;
    expect(close.request).toEqual({
      method: "close_snapshot",
      params: { snapshot_id: "snap-1" },
    });
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-1" });

    const result = await pending;
    expect(result.generation).toBe(42);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "Folder",
      "Folder/A.md",
      "B.md",
      "img.png",
    ]);
    expect(result.entries[1]).toEqual({
      path: "Folder/A.md",
      kind: "note",
      name: "A.md",
      parent: "Folder",
      revision: "blake3:aa",
      size: 10,
      ctimeMs: 2,
      mtimeMs: 2,
    });
    // A folder and an attachment both carry `revision: null` — the folder
    // because it has no bytes, the attachment because the index stores no
    // content revision for one. Nothing downstream may pair an attachment move
    // by revision, because there is never a revision to pair with.
    expect(result.entries[0]).toMatchObject({ kind: "folder", revision: null, size: null });
    expect(result.entries[3]).toMatchObject({ kind: "file", revision: null, size: 99 });
    expect(result.entries[2]).toMatchObject({ parent: "", name: "B.md" });
    expect(result.notes).toHaveLength(1);
    const row = result.notes[0]!;
    expect(row.headings[0]?.text).toBe("A");
    // The one camelCase rename at the boundary: `list_items` → `listItems`.
    expect(row.listItems[0]?.list_start_line).toBe(1);
    expect(row.sections[0]?.kind).toBe("heading");
    // The resolution answers survive the dropped `resolutions` facet, because
    // they were never in it: every reference carries its own.
    expect(row.outgoing[0]?.resolution).toEqual({
      kind: "resolved",
      target: "B.md",
      subpath: null,
    });
    expect(result.pages).toBe(3);
    expect(result.sessions).toBe(1);
  });

  it("closes the snapshot even when a page fails", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor());

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-9",
      generation: 1,
      note_count: 0,
      entry_count: 0,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondErr(tree.id, { code: "storage_failure", message: "disk went away" });

    await expect(pending).rejects.toThrow(/storage_failure/);
    const close = (await daemon.received(3))[2]!;
    expect(close.request).toEqual({
      method: "close_snapshot",
      params: { snapshot_id: "snap-9" },
    });
  });

  it("takes its page size from config and clamps it to the configured cap", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(
      client,
      configFor({ snapshotPageSize: 50_000, snapshotPageSizeMax: 2_000 }),
    );

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-c",
      generation: 7,
      note_count: 0,
      entry_count: 0,
    });
    const tree = (await daemon.received(2))[1]!;
    expect(tree.request).toEqual({
      method: "snapshot_tree",
      params: { snapshot_id: "snap-c", cursor: null, limit: 2_000 },
    });
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "snap-c",
      generation: 7,
      next_cursor: null,
      entries: [],
    });
    const notes = (await daemon.received(3))[2]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-c",
      generation: 7,
      next_cursor: null,
      notes: [],
    });
    const close = (await daemon.received(4))[3]!;
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-c" });

    await expect(pending).resolves.toMatchObject({ generation: 7, sessions: 1 });
  });

  /**
   * The pin-loss arm. `generation_mismatch` on a snapshot page means the
   * session's pin is gone — the second of that code's two causes — and the only
   * correct answer is to reopen and walk again from the beginning. Resuming the
   * old cursor against a new session would splice two generations together,
   * which is the one thing a hydration must never produce.
   */
  it("reopens the session and restarts the walk when the pin is lost", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 1 }));

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-1",
      generation: 42,
      note_count: 1,
      entry_count: 3,
    });
    const treeA = (await daemon.received(2))[1]!;
    daemon.respondOk(treeA.id, "snapshot_tree", {
      snapshot_id: "snap-1",
      generation: 42,
      next_cursor: "c1",
      entries: [
        {
          path: "Gone.md",
          kind: "note",
          revision: "blake3:old",
          size: 1,
          ctime_unix_ms: 1,
          mtime_unix_ms: 1,
        },
      ],
    });
    const treeB = (await daemon.received(3))[2]!;
    daemon.respondErr(treeB.id, {
      code: "generation_mismatch",
      message: "snapshot session pin was lost",
      current_generation: 43,
    });

    // The dead session is released before another is opened — a host that
    // reopened without closing would burn one of the daemon's four slots per
    // lost pin.
    const closeStale = (await daemon.received(4))[3]!;
    expect(closeStale.request).toEqual({
      method: "close_snapshot",
      params: { snapshot_id: "snap-1" },
    });
    daemon.respondErr(closeStale.id, {
      code: "snapshot_not_found",
      message: "already reclaimed",
    });

    const reopen = (await daemon.received(5))[4]!;
    expect(reopen.request).toEqual({ method: "open_snapshot", params: {} });
    daemon.respondOk(reopen.id, "open_snapshot", {
      snapshot_id: "snap-2",
      generation: 43,
      note_count: 1,
      entry_count: 1,
    });
    // The walk restarts at the beginning: `cursor: null`, not the stale "c1".
    const treeRetry = (await daemon.received(6))[5]!;
    expect(treeRetry.request).toEqual({
      method: "snapshot_tree",
      params: { snapshot_id: "snap-2", cursor: null, limit: 1 },
    });
    daemon.respondOk(treeRetry.id, "snapshot_tree", {
      snapshot_id: "snap-2",
      generation: 43,
      next_cursor: null,
      entries: [
        {
          path: "Fresh.md",
          kind: "note",
          revision: "blake3:new",
          size: 2,
          ctime_unix_ms: 5,
          mtime_unix_ms: 5,
        },
      ],
    });
    const notes = (await daemon.received(7))[6]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-2",
      generation: 43,
      next_cursor: null,
      notes: [
        {
          path: "Fresh.md",
          revision: "blake3:new",
          metadata: EMPTY_METADATA,
          references: [],
          sections: [],
          list_items: [],
        },
      ],
    });
    const close = (await daemon.received(8))[7]!;
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-2" });

    const result = await pending;
    expect(result.generation).toBe(43);
    expect(result.sessions).toBe(2);
    // Nothing of generation 42 survives into the answer.
    expect(result.entries.map((entry) => entry.path)).toEqual(["Fresh.md"]);
    expect(result.notes.map((note) => note.revision)).toEqual(["blake3:new"]);
  });

  it("backs off through the config clock when the snapshot cap is reached", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const clock = new FakeClock();
    const pending = hydrate(client, configFor({ clock, snapshotPageSize: 10 }));

    const first = (await daemon.received(1))[0]!;
    daemon.respondErr(first.id, {
      code: "too_many_snapshots",
      message: "4 sessions are already open",
    });

    // The rendezvous: the retry is armed on the config clock, so the test
    // advances that clock rather than sleeping. A hydration reaching for the
    // global `setTimeout` would hang here instead of passing.
    await clock.armed(1);
    expect(clock.armedWaits()).toEqual([SNAPSHOT_RETRY_BACKOFF_MS[0]]);
    clock.advance(SNAPSHOT_RETRY_BACKOFF_MS[0]!);

    const second = (await daemon.received(2))[1]!;
    expect(second.request).toEqual({ method: "open_snapshot", params: {} });
    daemon.respondOk(second.id, "open_snapshot", {
      snapshot_id: "snap-late",
      generation: 3,
      note_count: 0,
      entry_count: 0,
    });
    const tree = (await daemon.received(3))[2]!;
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "snap-late",
      generation: 3,
      next_cursor: null,
      entries: [],
    });
    const notes = (await daemon.received(4))[3]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-late",
      generation: 3,
      next_cursor: null,
      notes: [],
    });
    const close = (await daemon.received(5))[4]!;
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-late" });

    const result = await pending;
    expect(result.generation).toBe(3);
    // One session, not two: a refused `open_snapshot` opened nothing, so the
    // count stays a count of sessions the daemon actually granted.
    expect(result.sessions).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("gives up after the configured cap retries and reports the daemon's refusal", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const clock = new FakeClock();
    const config = configFor({ clock });
    const pending = hydrate(client, config);
    const settled = expect(pending).rejects.toThrow(/too_many_snapshots/);

    // `snapshotCapRetries` counts **retries**, so the first attempt plus that
    // many more, and every retry waits its own rung.
    const attempts = config.snapshotCapRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const open = (await daemon.received(attempt + 1))[attempt]!;
      daemon.respondErr(open.id, { code: "too_many_snapshots", message: "cap reached" });
      if (attempt + 1 === attempts) break;
      await clock.armed(attempt + 1);
      clock.advance(SNAPSHOT_RETRY_BACKOFF_MS[attempt]!);
    }

    await settled;
    expect(clock.armedWaits()).toEqual(
      SNAPSHOT_RETRY_BACKOFF_MS.slice(0, config.snapshotCapRetries),
    );
  });

  /**
   * The count check. `open_snapshot` says how many rows the session **will**
   * page out, and until this comparison existed nothing ever read that promise:
   * a cursor bug, or a daemon that answers `next_cursor: null` one page early,
   * produced a mirror silently missing notes that committed cleanly and
   * reported a coherent generation. That is the same failure class the
   * generation guard refuses by name, and it is one comparison away.
   */
  it("refuses a walk that pages out fewer rows than the session promised", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 10 }));

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-short",
      generation: 11,
      note_count: 2,
      entry_count: 2,
    });
    const tree = (await daemon.received(2))[1]!;
    // The page ends the walk one row early: `next_cursor` is null, and the
    // second entry never arrives.
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "snap-short",
      generation: 11,
      next_cursor: null,
      entries: [
        {
          path: "Only.md",
          kind: "note",
          revision: "blake3:only",
          size: 1,
          ctime_unix_ms: 1,
          mtime_unix_ms: 1,
        },
      ],
    });
    const notes = (await daemon.received(3))[2]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-short",
      generation: 11,
      next_cursor: null,
      notes: [
        {
          path: "Only.md",
          revision: "blake3:only",
          metadata: EMPTY_METADATA,
          references: [],
          sections: [],
          list_items: [],
        },
      ],
    });

    await expect(pending).rejects.toThrow(
      /promised 2 tree entries and 2 notes, but the walk had 1 and 1/,
    );
    const close = (await daemon.received(4))[3]!;
    expect(close.request).toEqual({
      method: "close_snapshot",
      params: { snapshot_id: "snap-short" },
    });
  });

  /**
   * The same comparison from the other side, and the reason the page loop is
   * bounded at all: a daemon that answers the same non-null cursor forever
   * would otherwise page until the host died of memory rather than of an error.
   */
  it("refuses a walk that pages out more rows than the session promised", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 1 }));

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-loop",
      generation: 12,
      note_count: 0,
      entry_count: 1,
    });
    for (let page = 0; page < 2; page += 1) {
      const tree = (await daemon.received(page + 2))[page + 1]!;
      daemon.respondOk(tree.id, "snapshot_tree", {
        snapshot_id: "snap-loop",
        generation: 12,
        // The same cursor, forever.
        next_cursor: "stuck",
        entries: [
          {
            path: `Loop ${String(page)}.md`,
            kind: "note",
            revision: "blake3:loop",
            size: 1,
            ctime_unix_ms: 1,
            mtime_unix_ms: 1,
          },
        ],
      });
    }

    await expect(pending).rejects.toThrow(/more tree entries than the 1 it promised/);
  });

  /**
   * The pin-loss budget is its own number now. Cap contention and pin loss have
   * different physics — one is other clients starting together, the other
   * scales with walk duration times write rate — and a shared counter meant a
   * couple of ordinary cap retries at startup could leave a long walk with no
   * restarts left.
   */
  it("gives up after the configured pin-loss restarts", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const config = configFor({ hydrationPinLossRestarts: 1, snapshotPageSize: 10 });
    const pending = hydrate(client, config);
    const settled = expect(pending).rejects.toThrow(/generation_mismatch/);

    // One walk, one restart, and the second loss is the end of it.
    for (let walk = 0; walk < config.hydrationPinLossRestarts + 1; walk += 1) {
      const open = (await daemon.received(walk * 3 + 1))[walk * 3]!;
      daemon.respondOk(open.id, "open_snapshot", {
        snapshot_id: `snap-${String(walk)}`,
        generation: 20 + walk,
        note_count: 0,
        entry_count: 0,
      });
      const tree = (await daemon.received(walk * 3 + 2))[walk * 3 + 1]!;
      daemon.respondErr(tree.id, {
        code: "generation_mismatch",
        message: "snapshot session pin was lost",
        current_generation: 21 + walk,
      });
      const close = (await daemon.received(walk * 3 + 3))[walk * 3 + 2]!;
      daemon.respondOk(close.id, "close_snapshot", { snapshot_id: `snap-${String(walk)}` });
    }

    await settled;
  });

  /**
   * The write seam Task 6 builds its mirror on. A sink sees every page as it
   * arrives, and `begin` is the discard point: a restarted walk announces a new
   * session, and whatever the sink accumulated for the abandoned one is void.
   * `commit` runs once, at the end, and only for a walk that completed.
   */
  it("drives a sink through begin / apply / commit and re-begins on a restart", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const trace: string[] = [];
    const sink: MirrorSink = {
      begin(session: SnapshotSession): void {
        trace.push(`begin ${session.snapshotId}@${session.generation}`);
      },
      applyTreePage(entries: readonly MirrorEntry[]): void {
        trace.push(`tree ${entries.map((entry) => entry.path).join(",")}`);
      },
      applyNotePage(notes: readonly MirrorNoteRow[]): void {
        trace.push(`notes ${notes.map((note) => note.path).join(",")}`);
      },
      commit(generation: number): void {
        trace.push(`commit ${generation}`);
      },
    };
    const pending = hydrateInto(client, configFor({ snapshotPageSize: 10 }), sink);

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-1",
      generation: 8,
      note_count: 0,
      entry_count: 0,
    });
    const treeA = (await daemon.received(2))[1]!;
    daemon.respondErr(treeA.id, {
      code: "generation_mismatch",
      message: "pin lost",
      current_generation: 9,
    });
    const closeStale = (await daemon.received(3))[2]!;
    daemon.respondOk(closeStale.id, "close_snapshot", { snapshot_id: "snap-1" });
    const reopen = (await daemon.received(4))[3]!;
    daemon.respondOk(reopen.id, "open_snapshot", {
      snapshot_id: "snap-2",
      generation: 9,
      note_count: 1,
      entry_count: 1,
    });
    const treeB = (await daemon.received(5))[4]!;
    daemon.respondOk(treeB.id, "snapshot_tree", {
      snapshot_id: "snap-2",
      generation: 9,
      next_cursor: null,
      entries: [
        {
          path: "N.md",
          kind: "note",
          revision: "blake3:n",
          size: 1,
          ctime_unix_ms: 1,
          mtime_unix_ms: 1,
        },
      ],
    });
    const notes = (await daemon.received(6))[5]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-2",
      generation: 9,
      next_cursor: null,
      notes: [
        {
          path: "N.md",
          revision: "blake3:n",
          metadata: EMPTY_METADATA,
          references: [],
          sections: [],
          list_items: [],
        },
      ],
    });
    const close = (await daemon.received(7))[6]!;
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-2" });

    const summary = await pending;
    expect(summary).toMatchObject({ generation: 9, sessions: 2, pages: 2, entryCount: 1, noteCount: 1 });
    expect(trace).toEqual([
      "begin snap-1@8",
      "begin snap-2@9",
      "tree N.md",
      "notes N.md",
      "commit 9",
    ]);
  });

  /**
   * A page that reports a different generation from the session that served it
   * is a daemon that is not pinning. Nothing recovers from that, and merging
   * the page anyway would produce exactly the torn mirror the session exists to
   * prevent, so hydration refuses it by name.
   */
  it("refuses a page whose generation is not the session's", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor());

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-x",
      generation: 4,
      note_count: 0,
      entry_count: 0,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "snap-x",
      generation: 5,
      next_cursor: null,
      entries: [],
    });

    await expect(pending).rejects.toThrow(/generation 5 inside a session pinned at 4/);
    const close = (await daemon.received(3))[2]!;
    expect(close.request).toEqual({
      method: "close_snapshot",
      params: { snapshot_id: "snap-x" },
    });
  });
});

/**
 * The reviewer's own probes for Task 5's five surviving mutations, kept.
 *
 * Each of these was written against the *finished* hydration code by someone
 * who had not written it, to answer one question apiece: does that guard
 * actually fire? They live here rather than in a scratch file because a guard
 * with no case of its own is a guard that can be deleted without a test going
 * red — which is exactly what a mutation probe is for.
 */
const ENTRY = (path: string): Record<string, unknown> => ({
  path,
  kind: "note",
  revision: "blake3:x",
  size: 1,
  ctime_unix_ms: 1,
  mtime_unix_ms: 1,
});

const NOTE = (path: string): Record<string, unknown> => ({
  path,
  revision: "blake3:x",
  metadata: EMPTY_METADATA,
  references: [],
  sections: [],
  list_items: [],
});

describe("hydration coherence probes", () => {
  /** N5: the NOTE loop's over-walk guard — does it actually fire? */
  it("refuses a NOTE walk that pages out more rows than promised", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 1 }));

    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "s",
      generation: 5,
      note_count: 1,
      entry_count: 1,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "s",
      generation: 5,
      next_cursor: null,
      entries: [ENTRY("A.md")],
    });
    // The note loop repeats its cursor forever.
    for (let page = 0; page < 2; page += 1) {
      const notes = (await daemon.received(page + 3))[page + 2]!;
      daemon.respondOk(notes.id, "snapshot_notes", {
        snapshot_id: "s",
        generation: 5,
        next_cursor: "stuck",
        notes: [NOTE(`N${String(page)}.md`)],
      });
    }
    await expect(pending).rejects.toThrow(/more notes than the 1 it promised/);
  });

  /** N2: the entry half of the short-walk check, alone. */
  it("refuses a short TREE walk even when the note count is exactly right", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 10 }));
    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "s",
      generation: 6,
      note_count: 1,
      entry_count: 2,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "s",
      generation: 6,
      next_cursor: null,
      entries: [ENTRY("A.md")],
    });
    const notes = (await daemon.received(3))[2]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "s",
      generation: 6,
      next_cursor: null,
      notes: [NOTE("A.md")],
    });
    await expect(pending).rejects.toThrow(
      /promised 2 tree entries and 1 notes, but the walk had 1 and 1/,
    );
  });

  /** N3: the note half of the short-walk check, alone. */
  it("refuses a short NOTE walk even when the entry count is exactly right", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const pending = hydrate(client, configFor({ snapshotPageSize: 10 }));
    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "s",
      generation: 7,
      note_count: 2,
      entry_count: 1,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "s",
      generation: 7,
      next_cursor: null,
      entries: [ENTRY("A.md")],
    });
    const notes = (await daemon.received(3))[2]!;
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "s",
      generation: 7,
      next_cursor: null,
      notes: [NOTE("A.md")],
    });
    await expect(pending).rejects.toThrow(
      /promised 1 tree entries and 2 notes, but the walk had 1 and 1/,
    );
  });

  /** N6: is the runaway page really refused BEFORE it reaches the sink? */
  it("refuses a runaway page before staging it in the sink", async () => {
    const daemon = new FakeDaemon();
    const client = clientFor(daemon);
    const staged: string[] = [];
    const sink: MirrorSink = {
      begin(): void {
        staged.push("begin");
      },
      applyTreePage(entries: readonly MirrorEntry[]): void {
        staged.push(`tree ${entries.map((entry) => entry.path).join(",")}`);
      },
      applyNotePage(notes: readonly MirrorNoteRow[]): void {
        staged.push(`notes ${notes.map((note) => note.path).join(",")}`);
      },
      commit(): void {
        staged.push("commit");
      },
    };
    const pending = hydrateInto(client, configFor({ snapshotPageSize: 1 }), sink);
    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "s",
      generation: 8,
      note_count: 0,
      entry_count: 1,
    });
    for (let page = 0; page < 2; page += 1) {
      const tree = (await daemon.received(page + 2))[page + 1]!;
      daemon.respondOk(tree.id, "snapshot_tree", {
        snapshot_id: "s",
        generation: 8,
        next_cursor: "stuck",
        entries: [ENTRY(`Loop ${String(page)}.md`)],
      });
    }
    await expect(pending).rejects.toThrow(/more tree entries/);
    // The first page was legal and staged; the second exceeded the promise and
    // must never have reached the sink.
    expect(staged).toEqual(["begin", "tree Loop 0.md"]);
  });

  /** N12 / N13: are the shipped defaults what the ruling asked for? */
  it("ships the ruled default budgets", () => {
    const config = defaultHostConfig("/vault");
    expect(config.snapshotCapRetries).toBe(4);
    expect(config.hydrationPinLossRestarts).toBe(3);
  });
});
