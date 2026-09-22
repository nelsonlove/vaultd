import { afterEach, describe, expect, it } from "vitest";

import { DaemonHarness } from "../src/testing/daemon-harness";
import { EngineLostError } from "../src/supervisor";
import { Mirror } from "../src/mirror/mirror";
import { MirrorHarness, answerHydrationOn } from "../src/testing/mirror-harness";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { RuntimeEventDto } from "../src/client/protocol";

/**
 * Resynchronization: every road that leads away from per-path detail.
 *
 * `counts_only`, an unrecognized change-set kind, a change set too large to be
 * worth refetching, every `resync_required` reason known or not, and the
 * supervisor's synthesized `runtime_recovered` after an engine restart all end
 * in the same place — a full re-hydration into a staging state, swapped in on
 * commit, with the difference reported as a synthetic batch.
 *
 * The property that makes that safe is the one with a case of its own here:
 * **the old mirror keeps answering until the swap**. A resync that emptied the
 * mirror and refilled it would give every reader a window in which the vault
 * looks empty, and Obsidian's API is synchronous, so a plugin would read
 * straight into it.
 */

const harnesses: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

async function hydrated(...args: Parameters<typeof MirrorHarness.hydrated>): Promise<MirrorHarness> {
  const harness = await MirrorHarness.hydrated(...args);
  harnesses.push(harness);
  return harness;
}

function resync(reason: string, currentGeneration: number | null = null): RuntimeEventDto {
  return { type: "resync_required", value: { current_generation: currentGeneration, reason } };
}

function plain(batch: MirrorChangeBatch): Record<string, unknown> {
  return {
    generation: batch.generation,
    created: [...batch.created],
    modified: [...batch.modified],
    deleted: [...batch.deleted],
    revisions: { ...batch.revisions },
    synthetic: batch.synthetic,
  };
}

describe("Mirror resync", () => {
  it("re-hydrates on resync_required and reports a synthetic diff", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "Gone.md", kind: "note", revision: "blake3:g1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1" },
        { path: "Gone.md", revision: "blake3:g1" },
      ],
    });
    const batches: Array<Record<string, unknown>> = [];
    harness.mirror.onBatch((batch) => batches.push(plain(batch)));

    const applying = harness.mirror.applyEvent(resync("watcher_overflow", 11));
    // The flag is up before anything has been awaited: a caller asks this the
    // instant it hands the event over.
    expect(harness.mirror.resyncing()).toBe(true);

    await harness.answerHydration({
      generation: 11,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a2" },
        { path: "New.md", kind: "note", revision: "blake3:n1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a2" },
        { path: "New.md", revision: "blake3:n1" },
      ],
    });
    await applying;

    expect(harness.mirror.resyncing()).toBe(false);
    expect(harness.mirror.generation()).toBe(11);
    expect(harness.mirror.appliedThrough()).toBe(11);
    expect(harness.mirror.lastResyncReason()).toBe("watcher_overflow");
    expect(batches).toEqual([
      {
        generation: 11,
        created: ["New.md"],
        modified: ["A.md"],
        deleted: ["Gone.md"],
        // A synthetic batch carries revisions too, and the **deleted** path's
        // is its last-known one — the row is gone from the mirror by the time
        // any listener sees this, so there is nowhere else to read it from.
        revisions: {
          "New.md": "blake3:n1",
          "A.md": "blake3:a2",
          "Gone.md": "blake3:g1",
        },
        synthetic: true,
      },
    ]);
    expect(harness.mirror.note("Gone.md")).toBeUndefined();
    expect(harness.mirror.note("New.md")?.revision).toBe("blake3:n1");
  });

  it("escalates a counts_only change set to a re-hydration", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "periodic",
        changes: { kind: "counts_only", created: 2000, modified: 0, deleted: 0 },
        affected_note_count: 2000,
        affected_reference_count: 0,
      },
    });
    await harness.answerHydration({ generation: 6, entries: [], notes: [] });
    await applying;

    expect(harness.mirror.generation()).toBe(6);
    expect(harness.mirror.lastResyncReason()).toBe("oversized_change_set");
    // Not one path was guessed at: the first thing it did was open a snapshot.
    expect(harness.methodsSeen()[0]).toBe("open_snapshot");
    expect(harness.methodsSeen()).not.toContain("get_tree_entries");
  });

  it("survives an unknown resync reason", async () => {
    const harness = await hydrated({ generation: 1, entries: [], notes: [] });
    const applying = harness.mirror.applyEvent(resync("some_future_reason", 2));
    await harness.answerHydration({ generation: 2, entries: [], notes: [] });
    await expect(applying).resolves.toBeUndefined();
    expect(harness.mirror.generation()).toBe(2);
    // Recorded for the compatibility report, and never branched on.
    expect(harness.mirror.lastResyncReason()).toBe("some_future_reason");
  });

  it("escalates a change-set kind this build does not understand", async () => {
    const harness = await hydrated({ generation: 5, entries: [], notes: [] });
    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "watcher",
        // A third kind. Read as counts it does not have, this would be a silent
        // misapply; the change-set guard is what turns it into a resync.
        changes: { kind: "ranges" },
        affected_note_count: 3,
        affected_reference_count: 0,
      },
    });
    await harness.answerHydration({ generation: 6, entries: [], notes: [] });
    await applying;
    expect(harness.mirror.lastResyncReason()).toBe("unknown_change_set:ranges");
    expect(harness.mirror.generation()).toBe(6);
  });

  it("escalates a change set larger than the delta path limit", async () => {
    const harness = await hydrated(
      { generation: 5, entries: [], notes: [] },
      { mirrorDeltaPathLimit: 2 },
    );
    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "watcher",
        changes: { kind: "detailed", created: ["A.md", "B.md", "C.md"], modified: [], deleted: [] },
        affected_note_count: 3,
        affected_reference_count: 0,
      },
    });
    await harness.answerHydration({
      generation: 6,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    await applying;
    expect(harness.methodsSeen()).not.toContain("get_tree_entries");
    expect(harness.mirror.note("A.md")).toBeDefined();
  });

  it("keeps the old mirror answering until the swap", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "Old.md", kind: "note", revision: "blake3:o1" }],
      notes: [{ path: "Old.md", revision: "blake3:o1" }],
    });

    const applying = harness.mirror.applyEvent(resync("root_invalidated", 9));
    const open = await harness.expectRequest("open_snapshot");
    harness.respondOk(open.id, "open_snapshot", {
      snapshot_id: "swap-1",
      generation: 9,
      note_count: 1,
      entry_count: 1,
    });
    const tree = await harness.expectRequest("snapshot_tree");

    // Mid-walk: the staging state holds one tree page and no notes, and this
    // mirror still answers every question from the view it hydrated at 5.
    expect(harness.mirror.generation()).toBe(5);
    expect(harness.mirror.note("Old.md")?.revision).toBe("blake3:o1");
    expect(harness.mirror.entries().map((entry) => entry.path)).toEqual(["Old.md"]);

    harness.respondOk(tree.id, "snapshot_tree", {
      snapshot_id: "swap-1",
      generation: 9,
      entries: [
        {
          path: "Fresh.md",
          kind: "note",
          size: 3,
          ctime_unix_ms: 1,
          mtime_unix_ms: 2,
          revision: "blake3:f1",
        },
      ],
      next_cursor: null,
    });
    expect(harness.mirror.note("Old.md")?.revision).toBe("blake3:o1");

    const notes = await harness.expectRequest("snapshot_notes");
    harness.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "swap-1",
      generation: 9,
      notes: [
        {
          path: "Fresh.md",
          revision: "blake3:f1",
          metadata: {
            properties: [],
            aliases: [],
            headings: [],
            blocks: [],
            tags: [],
            diagnostics: [],
          },
          references: [],
          sections: [],
          list_items: [],
        },
      ],
      next_cursor: null,
    });
    const close = await harness.expectRequest("close_snapshot");
    harness.respondOk(close.id, "close_snapshot", { snapshot_id: "swap-1" });
    await applying;

    expect(harness.mirror.entries().map((entry) => entry.path)).toEqual(["Fresh.md"]);
    expect(harness.mirror.note("Old.md")).toBeUndefined();
  });

  it("keeps the previous view when the engine dies under the re-hydration", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "Old.md", kind: "note", revision: "blake3:o1" }],
      notes: [{ path: "Old.md", revision: "blake3:o1" }],
    });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));

    const applying = harness.mirror.applyEvent(resync("runtime_recovered", 9));
    await harness.expectRequest("open_snapshot");
    // The engine went away with the request in flight. `EngineLostError` is
    // what a caller meets, and it is not a failure worth propagating: the next
    // engine's own marker asks for another resync.
    harness.client.failAllPending(new EngineLostError("vaultd restarted"));
    await expect(applying).resolves.toBeUndefined();

    // Stale, and coherent. The one thing a mirror must never be is torn.
    expect(harness.mirror.generation()).toBe(5);
    expect(harness.mirror.note("Old.md")?.revision).toBe("blake3:o1");
    expect(batches).toEqual([]);
    expect(harness.mirror.resyncing()).toBe(false);
  });

  it("re-hydrates through the engine that exists now, not the one that died", async () => {
    const first = DaemonHarness.create();
    const second = DaemonHarness.create();
    harnesses.push(first, second);
    let current: DaemonHarness = first;

    const opening = Mirror.open(() => current.client, first.config);
    await answerHydrationOn(first, {
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const mirror = await opening;
    first.clearMethodLog();

    // The supervisor restarted the engine and delivered its synthesized marker
    // on the new one. A mirror holding the dead client could not answer it.
    current = second;
    const applying = mirror.applyEvent(resync("runtime_recovered", 9));
    await answerHydrationOn(second, {
      generation: 9,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    await applying;

    expect(mirror.generation()).toBe(9);
    expect(mirror.entry("B.md")).toBeDefined();
    expect(second.methodsSeen()).toContain("open_snapshot");
    expect(first.methodsSeen()).toEqual([]);
  });

  it("keeps the position index of a note whose revision did not change", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    const warming = harness.mirror.warmPositions();
    await harness.answerWarm({ "A.md": "# A\n", "B.md": "# B\n" });
    expect(await warming).toMatchObject({ warmed: 2 });
    expect(harness.mirror.positions("A.md")).toBeDefined();

    const applying = harness.mirror.applyEvent(resync("subscriber_lag", 9));
    await harness.answerHydration({
      generation: 9,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a2" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a2" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    // Exactly one `read_file`, for the one note whose revision moved. B is not
    // asked for: `answerWarm` returns when every fixture it was given has been
    // served, so a second request would hang this case rather than pass it.
    expect(await harness.answerWarm({ "A.md": "# A v2 — longer\n" })).toBe(1);
    await applying;

    // B did not move, so its table is still correct and is worth a `read_file`
    // never issued. A moved, so its old table would put every span in that note
    // at the wrong offset — it is dropped **and rebuilt**, because nothing else
    // ever would: `positions` would answer `undefined` for the rest of the
    // session and Task 8's `getFileCache` would answer `null` to every plugin.
    expect(harness.mirror.positions("B.md")).toBeDefined();
    expect(harness.mirror.positions("A.md")).toBeDefined();
    expect(harness.mirror.positions("A.md")?.byteLength).toBe(18);
  });

  it("re-hydrates when an event's previous_generation names a change set it never saw", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    // Generation 6's event was lost and 7's arrived. Applying it would advance
    // `appliedThrough` to 7 and leave 6's paths — which this mirror never
    // fetched — wrong forever, with nothing anywhere to notice.
    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 6,
        generation: 7,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerHydration({
      generation: 7,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a2" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a2" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("generation_gap");
    // Not one path was refetched: the first thing it did was open a snapshot.
    expect(harness.methodsSeen()[0]).toBe("open_snapshot");
    expect(harness.methodsSeen()).not.toContain("get_tree_entries");
    // And generation 6's path, which no change set ever named to this mirror,
    // is present.
    expect(harness.mirror.entry("B.md")).toBeDefined();
    expect(harness.mirror.appliedThrough()).toBe(7);
  });

  it("does not judge an event a re-hydration already covered for continuity", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    // A burst. The daemon asks for a resync, and generations 6, 7 and 8 arrive
    // behind it while the re-hydration is still in flight, so all three queue
    // up behind the resync's task: `onCommitted`'s synchronous early exit reads
    // an `appliedThrough` of 5, a number from before the swap.
    const resyncing = harness.mirror.applyEvent(resync("watcher_overflow", 8));
    const queued = [6, 7, 8].map((generation) =>
      harness.mirror.applyEvent({
        type: "generation_committed",
        value: {
          previous_generation: generation - 1,
          generation,
          cause: "watcher",
          changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
          affected_note_count: 1,
          affected_reference_count: 0,
        },
      }),
    );
    // Handled, so a build that leaves one of these pending or rejected fails on
    // the assertions below rather than as a stray rejection at teardown.
    for (const pending of queued) void pending.catch(() => undefined);

    // The snapshot lands at 8, which is at or above every queued event.
    await harness.answerHydration({
      generation: 8,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a4" }],
      notes: [{ path: "A.md", revision: "blake3:a4" }],
    });
    await resyncing;
    expect(harness.mirror.appliedThrough()).toBe(8);
    harness.clearMethodLog();
    await harness.quiesce();

    // Every one of 6, 7 and 8 is already covered by that snapshot, so every one
    // is a no-op. Judged for continuity instead, every one reads as a gap —
    // `previous_generation` 5, 6, 7 against an `appliedThrough` of 8 — and asks
    // for a whole-vault re-hydration of its own, one per event. Measured
    // against the real daemon at 227 re-hydrations over thirty seed-runs.
    expect(harness.mirror.resyncCount()).toBe(1);
    expect(harness.mirror.lastResyncReason()).toBe("watcher_overflow");
    // Not a single request went out for any of the three.
    expect(harness.methodsSeen()).toEqual([]);
    await Promise.all(queued);

    // A genuine gap is always an event *above* `appliedThrough`, and it still
    // fires. First one that is continuous with the snapshot, which applies as
    // an ordinary delta and asks for nothing but its own rows.
    const continuous = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 8,
        generation: 10,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerRefetch(10, [{ path: "A.md", revision: "blake3:a5" }]);
    await continuous;
    expect(harness.mirror.resyncCount()).toBe(1);
    expect(harness.mirror.appliedThrough()).toBe(10);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a5");

    // And now generation 11's event is lost. Generation 12 arrives naming it,
    // which is above `appliedThrough` and does not match it, so the continuity
    // check escalates exactly as it always did.
    const gapped = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 11,
        generation: 12,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerHydration({
      generation: 12,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a6" }],
      notes: [{ path: "A.md", revision: "blake3:a6" }],
    });
    await gapped;
    expect(harness.mirror.resyncCount()).toBe(2);
    expect(harness.mirror.lastResyncReason()).toBe("generation_gap");
    expect(harness.mirror.appliedThrough()).toBe(12);
  });

  it("stays quiet for this host's own write echo and for the first event after a resync", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    // The write's own response came back first, so `applyMutation` advanced
    // `appliedThrough` to 6. The echo for 6 is dropped by the staleness guard,
    // and the **next** event's `previous_generation` is 6 — which matches, so
    // the continuity check must not fire.
    const mutating = harness.mirror.applyMutation(6, ["A.md"]);
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await mutating;
    await harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });

    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 6,
        generation: 7,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerRefetch(7, [{ path: "A.md", revision: "blake3:a3" }]);
    await applying;
    expect(harness.mirror.lastResyncReason()).toBeNull();
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a3");

    // Now a resync, landing on generation 20. The next event's
    // `previous_generation` is that snapshot's generation, so it applies as a
    // delta rather than triggering a second re-hydration.
    const resyncing = harness.mirror.applyEvent(resync("watcher_overflow", 20));
    await harness.answerHydration({
      generation: 20,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a3" }],
      notes: [{ path: "A.md", revision: "blake3:a3" }],
    });
    await resyncing;
    expect(harness.mirror.appliedThrough()).toBe(20);
    harness.clearMethodLog();

    const after = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 20,
        generation: 21,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerRefetch(21, [{ path: "A.md", revision: "blake3:a4" }]);
    await after;

    expect(harness.mirror.lastResyncReason()).toBe("watcher_overflow");
    expect(harness.methodsSeen()).toEqual(["get_tree_entries", "get_note"]);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a4");
  });

  it("tells its listeners and takes the resync road when an apply cannot complete", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const failures: Array<{ message: string; eventType: string | null }> = [];
    harness.mirror.onApplyError((error, event) => {
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        // Nullable: a failure raised by a re-warm after this host's own
        // mutation is attributable to no event at all.
        eventType: event?.type ?? null,
      });
    });

    const event: RuntimeEventDto = {
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    };
    const applying = harness.mirror.applyEvent(event);
    const tree = await harness.expectRequest("get_tree_entries");
    harness.respondErr(tree.id, { code: "internal", message: "the daemon fell over" });
    await expect(applying).rejects.toThrow(/the daemon fell over/);

    // The seam fired, with the event that could not be applied.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.eventType).toBe("generation_committed");
    // **And the mirror did not stop there.** `appliedThrough` was correctly
    // left un-advanced, which means generation 6's paths are stale and nothing
    // retries them — so the mirror asks for the road it has: a re-hydration.
    expect(harness.mirror.resyncing()).toBe(true);
    await harness.answerHydration({
      generation: 6,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a2" }],
      notes: [{ path: "A.md", revision: "blake3:a2" }],
    });
    await harness.quiesce();

    expect(harness.mirror.lastResyncReason()).toBe("apply_failed");
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    expect(harness.mirror.appliedThrough()).toBe(6);
    expect(harness.mirror.resyncing()).toBe(false);
  });

  it("keeps the synthetic batch when the re-warm fails, and reports the failure instead", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    const warming = harness.mirror.warmPositions();
    await harness.answerWarm({ "A.md": "# A\n", "B.md": "# B\n" });
    await warming;

    const batches: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    harness.mirror.onBatch((batch) => batches.push(plain(batch)));
    harness.mirror.onApplyError((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });

    const applying = harness.mirror.applyEvent(resync("watcher_overflow", 9));
    await harness.answerHydration({
      generation: 9,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a2" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a2" },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    // The re-warm runs **after** the swap, so a throw here lands after the new
    // state is live and before `emit` — and the synthetic batch is the only
    // thing that will ever describe this re-hydration, because `previous` has
    // been consumed and no later resync can reconstruct it. Losing it is
    // permanent.
    const read = await harness.expectRequest("read_file");
    harness.respondErr(read.id, { code: "internal", message: "the reader fell over" });
    await expect(applying).resolves.toBeUndefined();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.modified).toEqual(["A.md"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/the reader fell over/);
    expect(harness.mirror.lastResyncReason()).toBe("watcher_overflow");
  });

  it("keeps the first resync reason when a second is raised before the run starts", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    // A generation with a gap is enqueued first, so its continuity check runs
    // **after** the daemon's own `resync_required` has already recorded its
    // reason — the ordering the reviewer found. Both want the same
    // re-hydration and exactly one runs; the question is which reason Task 22's
    // compatibility report is told about, and the daemon's is worth more than
    // this host's guess at it.
    const gapped = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 7,
        generation: 9,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    const asked = harness.mirror.applyEvent(resync("watcher_overflow", 12));

    // One hydration answers both: the second run finds the request already
    // consumed and returns.
    await harness.answerHydration({
      generation: 12,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a2" }],
      notes: [{ path: "A.md", revision: "blake3:a2" }],
    });
    await gapped;
    await asked;

    expect(harness.mirror.lastResyncReason()).toBe("watcher_overflow");
    expect(harness.mirror.appliedThrough()).toBe(12);
    expect(harness.methodsSeen().filter((method) => method === "open_snapshot")).toHaveLength(1);
  });

  it("re-warms a note the delta path replaced, when it was warm before", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const warming = harness.mirror.warmPositions();
    await harness.answerWarm({ "A.md": "# A\n" });
    await warming;
    const before = harness.mirror.positions("A.md");
    expect(before?.byteLength).toBe(4);

    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5,
        generation: 6,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await harness.answerWarm({ "A.md": "# A longer body — with an em dash\n" });
    await applying;

    const after = harness.mirror.positions("A.md");
    expect(after?.byteLength).toBe(36);
    expect(after?.u16Length).toBe(34);
  });
});
