import { afterEach, describe, expect, it } from "vitest";

import { MirrorHarness, harness_ref } from "../src/testing/mirror-harness";
import type { GenerationCommittedEventDto, RuntimeEventDto } from "../src/client/protocol";

/**
 * Applying one committed generation to a hydrated mirror.
 *
 * Everything here is the delta path: the mirror already holds a coherent view
 * of one generation, an event says what moved, and the mirror refetches exactly
 * those rows. The three rules that decide whether the result is right are all
 * invisible in the happy case and all silent when broken, so each one has a
 * case of its own:
 *
 * - **`deleted` applies before `created`** (Ruling W6, `client/events.ts`), so a
 *   path in both lists ends up holding the new thing rather than nothing.
 * - **A deleted folder takes its subtree**, whether or not the descendants were
 *   spelled out.
 * - **`affected_note_count` counts notes only**, so it can never size the tree
 *   work — a generation that moved only the file tree reports zero.
 */

const harnesses: MirrorHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

async function hydrated(...args: Parameters<typeof MirrorHarness.hydrated>): Promise<MirrorHarness> {
  const harness = await MirrorHarness.hydrated(...args);
  harnesses.push(harness);
  return harness;
}

/** A `generation_committed` with the boilerplate filled in. */
function committed(value: Partial<GenerationCommittedEventDto> & { generation: number }): RuntimeEventDto {
  return {
    type: "generation_committed",
    value: {
      previous_generation: value.generation - 1,
      cause: "watcher",
      changes: { kind: "detailed", created: [], modified: [], deleted: [] },
      affected_note_count: 0,
      affected_reference_count: 0,
      ...value,
    },
  };
}

describe("Mirror deltas", () => {
  it("applies a detailed generation_committed and notifies one batch", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1", headings: [] }],
    });
    const batches: Array<{ generation: number; modified: string[]; synthetic: boolean }> = [];
    harness.mirror.onBatch((batch) => {
      batches.push({
        generation: batch.generation,
        modified: [...batch.modified],
        synthetic: batch.synthetic,
      });
    });

    const applied = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(6, [
      {
        path: "A.md",
        revision: "blake3:a2",
        headings: [{ level: 1, text: "New", span: { start: 0, end: 5 } }],
      },
    ]);
    await applied;

    expect(harness.mirror.generation()).toBe(6);
    expect(harness.mirror.note("A.md")?.headings[0]?.text).toBe("New");
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    // The tree row moved with it: a modified note's size and mtime feed
    // `TFile.stat`, and `get_note` reports neither.
    expect(harness.mirror.entry("A.md")?.revision).toBe("blake3:a2");
    expect(batches).toEqual([{ generation: 6, modified: ["A.md"], synthetic: false }]);
  });

  it("drops a generation_committed the mirror already applied from a mutation response", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));

    const mutating = harness.mirror.applyMutation(6, ["A.md"]);
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await mutating;
    harness.clearMethodLog();

    await harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.quiesce();

    expect(batches).toEqual([6]);
    expect(harness.methodsSeen()).toEqual([]);
    expect(harness.pendingRequests()).toHaveLength(0);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
  });

  it("removes deleted paths and their backlinks", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "B", "B.md")] },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });
    expect(harness.mirror.backlinks("B.md")).toHaveLength(1);
    expect(harness.mirror.resolvedLinks()["A.md"]).toEqual({ "B.md": 1 });

    await harness.mirror.applyEvent(
      committed({
        generation: 7,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["A.md"] },
        affected_note_count: 1,
        affected_reference_count: 1,
      }),
    );

    expect(harness.mirror.entry("A.md")).toBeUndefined();
    expect(harness.mirror.note("A.md")).toBeUndefined();
    expect(harness.mirror.backlinks("B.md")).toHaveLength(0);
    expect(harness.mirror.resolvedLinks()["A.md"]).toBeUndefined();
    expect(harness.mirror.children("")).toHaveLength(1);
    // A delete needs no fetch at all.
    expect(harness.methodsSeen()).toEqual([]);
    expect(harness.mirror.generation()).toBe(7);
  });

  it("applies deleted before created, so a path in both lists holds the new thing", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "Journal", kind: "folder" },
        { path: "Journal/a.md", kind: "note", revision: "blake3:j1" },
      ],
      notes: [{ path: "Journal/a.md", revision: "blake3:j1" }],
    });
    const batches: Array<{ created: string[]; deleted: string[] }> = [];
    harness.mirror.onBatch((batch) => {
      batches.push({ created: [...batch.created], deleted: [...batch.deleted] });
    });

    const applied = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["Journal"], modified: [], deleted: ["Journal"] },
        // Zero notes: the tree moved, and sizing tree work by this number would
        // do nothing at all.
        affected_note_count: 0,
      }),
    );
    const asked = await harness.answerRefetch(6, [], {
      entries: [{ path: "Journal", kind: "file", size: 12 }],
    });
    await applied;

    expect([...asked]).toEqual(["Journal"]);
    expect(harness.mirror.entry("Journal")?.kind).toBe("file");
    expect(harness.mirror.entry("Journal/a.md")).toBeUndefined();
    expect(harness.mirror.note("Journal/a.md")).toBeUndefined();
    expect(harness.mirror.children("Journal")).toHaveLength(0);
    // The batch says both, in the wire's own terms: the shim replays the same
    // two steps, and one told only "created" would keep serving the folder's
    // children under a path that is now a file.
    expect(batches).toEqual([
      { created: ["Journal"], deleted: ["Journal", "Journal/a.md"] },
    ]);
  });

  it("takes a deleted folder's whole subtree, spelled out or not", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "Deep", kind: "folder" },
        { path: "Deep/Inner", kind: "folder" },
        { path: "Deep/Inner/a.md", kind: "note", revision: "blake3:d1" },
        { path: "Deep/Inner/pixel.png", kind: "file" },
        { path: "Deeper.md", kind: "note", revision: "blake3:x1" },
      ],
      notes: [
        {
          path: "Deep/Inner/a.md",
          revision: "blake3:d1",
          outgoing: [harness_ref("Deep/Inner/a.md", "Deeper", "Deeper.md")],
        },
        { path: "Deeper.md", revision: "blake3:x1" },
      ],
    });
    expect(harness.mirror.backlinks("Deeper.md")).toHaveLength(1);

    await harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        // The watcher named the folder alone. Every descendant goes with it.
        changes: { kind: "detailed", created: [], modified: [], deleted: ["Deep"] },
      }),
    );

    expect(harness.mirror.entries().map((entry) => entry.path)).toEqual(["Deeper.md"]);
    expect(harness.mirror.note("Deep/Inner/a.md")).toBeUndefined();
    expect(harness.mirror.backlinks("Deeper.md")).toHaveLength(0);
    // "Deeper.md" starts with "Deep" and is NOT under it: the subtree rule is a
    // path-segment rule, not a string prefix.
    expect(harness.mirror.entry("Deeper.md")).toBeDefined();
  });

  it("records the highest generation any row was fetched at, and still applies the ones in between", async () => {
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

    // The refetch for generation 6 is served at 9: `get_note` answers at the
    // currently published generation, which may be later than the one asked
    // about. The mirror records what it actually holds.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(9, [{ path: "A.md", revision: "blake3:a9" }]);
    await applying;

    expect(harness.mirror.generation()).toBe(9);
    // …and generation 6 is what the mirror has *applied through*, so the
    // generations between 6 and 9 are still news.
    expect(harness.mirror.appliedThrough()).toBe(6);

    const second = harness.mirror.applyEvent(
      committed({
        generation: 7,
        previous_generation: 6,
        changes: { kind: "detailed", created: [], modified: ["B.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(9, [{ path: "B.md", revision: "blake3:b9" }]);
    await second;

    expect(harness.mirror.note("B.md")?.revision).toBe("blake3:b9");
    expect(harness.mirror.appliedThrough()).toBe(7);
    expect(harness.mirror.generation()).toBe(9);
  });

  it("is a no-op for a generation it has already applied through", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));

    await harness.mirror.applyEvent(
      committed({
        generation: 5,
        previous_generation: 4,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
      }),
    );
    await harness.mirror.applyEvent(
      committed({
        generation: 4,
        previous_generation: 3,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["A.md"] },
      }),
    );
    await harness.quiesce();

    expect(batches).toEqual([]);
    expect(harness.methodsSeen()).toEqual([]);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a1");
    expect(harness.mirror.generation()).toBe(5);
  });

  it("refuses a get_note answer that omitted a facet the refetch asked for", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const tree = await harness.nextRequest();
    expect(tree.request.method).toBe("get_tree_entries");
    harness.respondOk(tree.id, "get_tree_entries", {
      generation: 6,
      entries: [
        {
          path: "A.md",
          kind: "note",
          size: 4,
          ctime_unix_ms: 1,
          mtime_unix_ms: 2,
          revision: "blake3:a2",
        },
      ],
      absent: [],
    });
    const note = await harness.nextRequest();
    expect(note.request.method).toBe("get_note");
    expect(note.request.params).toMatchObject({ include: ["sections", "list_items"] });
    // `sections` present, `list_items` absent — the daemon did not serve what
    // was asked for, and an empty array would be a lie the mirror keeps.
    harness.respondOk(note.id, "get_note", {
      generation: 6,
      note: {
        path: "A.md",
        revision: "blake3:a2",
        source: "x",
        properties: [],
        aliases: [],
        headings: [],
        blocks: [],
        tags: [],
        diagnostics: [],
        outgoing: [],
        sections: [],
      },
    });

    await expect(applying).rejects.toThrow(/list_items/);
    // The old row is untouched: a refused refetch is not a half-applied one.
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a1");
    expect(harness.mirror.appliedThrough()).toBe(5);
  });

  it("keeps an explicitly empty facet as empty", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
      }),
    );
    await harness.answerRefetch(6, [
      { path: "A.md", revision: "blake3:a2", sections: [], listItems: [] },
    ]);
    await applying;
    expect(harness.mirror.note("A.md")?.sections).toEqual([]);
    expect(harness.mirror.note("A.md")?.listItems).toEqual([]);
  });

  it("refetches a non-note path's tree row and asks for no note", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "Folder", kind: "folder" }],
      notes: [],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["Folder/pixel.png"], modified: [], deleted: [] },
        affected_note_count: 0,
      }),
    );
    const asked = await harness.answerRefetch(6, [], {
      entries: [{ path: "Folder/pixel.png", kind: "file", size: 16 }],
    });
    await applying;

    expect([...asked]).toEqual(["Folder/pixel.png"]);
    expect(harness.methodsSeen()).toEqual(["get_tree_entries"]);
    expect(harness.mirror.entry("Folder/pixel.png")).toMatchObject({
      kind: "file",
      revision: null,
      parent: "Folder",
      name: "pixel.png",
      size: 16,
    });
    expect(harness.mirror.children("Folder").map((entry) => entry.path)).toEqual([
      "Folder/pixel.png",
    ]);
  });

  it("asks for the ancestors of a created path the mirror has never seen", async () => {
    const harness = await hydrated({ generation: 5, entries: [], notes: [] });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["New/Deep/a.md"], modified: [], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const asked = await harness.answerRefetch(
      6,
      [{ path: "New/Deep/a.md", revision: "blake3:n1" }],
      {
        entries: [
          { path: "New", kind: "folder" },
          { path: "New/Deep", kind: "folder" },
          { path: "New/Deep/a.md", kind: "note", revision: "blake3:n1" },
        ],
      },
    );
    await applying;

    expect([...asked].sort()).toEqual(["New", "New/Deep", "New/Deep/a.md"]);
    expect(harness.mirror.children("").map((entry) => entry.path)).toEqual(["New"]);
    expect(harness.mirror.children("New/Deep").map((entry) => entry.path)).toEqual([
      "New/Deep/a.md",
    ]);
    expect(harness.mirror.note("New/Deep/a.md")?.revision).toBe("blake3:n1");
  });

  it("removes a path the daemon answers as absent", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    // The note was gone again by the time the refetch landed.
    await harness.answerRefetch(6, [], { absent: ["A.md"] });
    const batch = await applying;
    void batch;

    expect(harness.mirror.entry("A.md")).toBeUndefined();
    expect(harness.mirror.note("A.md")).toBeUndefined();
    expect(harness.methodsSeen()).toEqual(["get_tree_entries"]);
  });

  it("keeps one listener's throw local and unsubscribes on demand", async () => {
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
    const seen: string[] = [];
    harness.mirror.onBatch(() => {
      throw new Error("a listener blew up");
    });
    harness.mirror.onBatch(() => seen.push("second"));
    const off = harness.mirror.onBatch(() => seen.push("third"));

    await harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["A.md"] },
      }),
    );
    expect(seen).toEqual(["second", "third"]);

    off();
    await harness.mirror.applyEvent(
      committed({
        generation: 7,
        previous_generation: 6,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["B.md"] },
      }),
    );
    expect(seen).toEqual(["second", "third", "second"]);
  });

  it("ignores an event kind this build does not know", async () => {
    const harness = await hydrated({ generation: 5, entries: [], notes: [] });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));
    await harness.mirror.applyEvent({
      type: "some_future_event",
      value: { generation: 99 },
    });
    await harness.quiesce();
    expect(batches).toEqual([]);
    expect(harness.mirror.generation()).toBe(5);
    expect(harness.methodsSeen()).toEqual([]);
  });
});
