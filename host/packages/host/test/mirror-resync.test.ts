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
    await applying;

    // B did not move, so its table is still correct and is worth a `read_file`
    // never issued. A moved, so its old table would put every span in that note
    // at the wrong offset — it is dropped, and stays dropped until re-warmed.
    expect(harness.mirror.positions("B.md")).toBeDefined();
    expect(harness.mirror.positions("A.md")).toBeUndefined();
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
