import { afterEach, describe, expect, it } from "vitest";

import { MirrorHarness, harness_ref } from "../src/testing/mirror-harness";
import type { GenerationCommittedEventDto, RuntimeEventDto } from "../src/client/protocol";
import type { MirrorChangeBatch } from "../src/mirror/types";

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
      entries: [
        { path: "Folder/pixel.png", kind: "file", size: 16 },
        // The folder's own row comes back with it — see the ancestor case
        // below for why the mirror asked for it.
        { path: "Folder", kind: "folder", mtimeMs: 1_700_000_009_000 },
      ],
    });
    await applying;

    expect([...asked].sort()).toEqual(["Folder", "Folder/pixel.png"]);
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

  it("refetches the referrers of a deleted path, which the daemon never names", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "Y.md", kind: "note", revision: "blake3:y1" },
      ],
      notes: [
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "Y.md")] },
        { path: "Y.md", revision: "blake3:y1" },
      ],
    });
    expect(harness.mirror.resolvedLinks()).toEqual({ "X.md": { "Y.md": 1 } });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["Y.md"] },
        affected_note_count: 1,
        // The daemon says a reference moved. It never says whose.
        affected_reference_count: 1,
      }),
    );
    // X.md is not in the change set and the mirror asked for it anyway, from
    // its own backlink index, before the delete could erase the evidence.
    const asked = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", null)] },
    ]);
    await applying;

    expect([...asked]).toEqual(["X.md"]);
    expect(harness.mirror.resolvedLinks()).toEqual({});
    expect(harness.mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });
    expect(harness.mirror.backlinks("Y.md")).toHaveLength(0);
    expect(harness.mirror.note("X.md")?.outgoing[0]?.resolution.kind).toBe("unresolved");
  });

  it("refetches the referrers of a created path, matched by name as well as by path", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "Deep/Z.md", kind: "note", revision: "blake3:z1" },
        { path: "Deep", kind: "folder" },
      ],
      notes: [
        // Three spellings of one file, all unresolved until it exists.
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", null)] },
        {
          path: "Deep/Z.md",
          revision: "blake3:z1",
          outgoing: [harness_ref("Deep/Z.md", "Sub/Y.md", null)],
        },
      ],
    });
    expect(harness.mirror.unresolvedLinks()).toEqual({
      "X.md": { Y: 1 },
      "Deep/Z.md": { "Sub/Y.md": 1 },
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["Sub/Y.md"], modified: [], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 2,
      }),
    );
    const asked = await harness.answerRefetch(
      6,
      [
        { path: "Sub/Y.md", revision: "blake3:y1" },
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "Sub/Y.md")] },
        {
          path: "Deep/Z.md",
          revision: "blake3:z1",
          outgoing: [harness_ref("Deep/Z.md", "Sub/Y.md", "Sub/Y.md")],
        },
      ],
      { entries: [{ path: "Sub", kind: "folder" }] },
    );
    await applying;

    // The created path, its unseen ancestor, and both referrers: one found by
    // basename (`Y`) and one by full path (`Sub/Y.md`).
    expect([...asked].sort()).toEqual(["Deep/Z.md", "Sub", "Sub/Y.md", "X.md"]);
    expect(harness.mirror.unresolvedLinks()).toEqual({});
    expect(harness.mirror.resolvedLinks()).toEqual({
      "X.md": { "Sub/Y.md": 1 },
      "Deep/Z.md": { "Sub/Y.md": 1 },
    });
    expect(harness.mirror.backlinks("Sub/Y.md")).toHaveLength(2);
  });

  it("refetches a referrer whose link already resolved, when a rival for the name appears", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "Src.md", kind: "note", revision: "blake3:s1" },
        { path: "A", kind: "folder" },
        { path: "A/N.md", kind: "note", revision: "blake3:n1" },
      ],
      notes: [
        // Already **resolved** — so it is in no unresolved bucket, and an index
        // of unresolved keys alone would never find it.
        { path: "Src.md", revision: "blake3:s1", outgoing: [harness_ref("Src.md", "N", "A/N.md")] },
        { path: "A/N.md", revision: "blake3:n1" },
      ],
    });
    expect(harness.mirror.resolvedLinks()).toEqual({ "Src.md": { "A/N.md": 1 } });

    // A second file of the same name. `[[N]]` now names two things, and the
    // daemon answers `ambiguous` — a different answer for a note the change set
    // does not mention.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["B/N.md"], modified: [], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 1,
      }),
    );
    const asked = await harness.answerRefetch(
      6,
      [
        { path: "B/N.md", revision: "blake3:n2" },
        {
          path: "Src.md",
          revision: "blake3:s1",
          outgoing: [
            {
              ...harness_ref("Src.md", "N", "A/N.md"),
              resolution: { kind: "ambiguous", candidates: ["A/N.md", "B/N.md"] },
            },
          ],
        },
      ],
      { entries: [{ path: "B", kind: "folder" }] },
    );
    await applying;

    expect([...asked].sort()).toEqual(["B", "B/N.md", "Src.md"]);
    expect(harness.mirror.note("Src.md")?.outgoing[0]?.resolution.kind).toBe("ambiguous");
    // The daemon orders the candidates and the mirror takes the first, as
    // Obsidian does — so the edge stays visible to the graph rather than
    // vanishing because a reader could follow it two ways.
    expect(harness.mirror.resolvedLinks()).toEqual({ "Src.md": { "A/N.md": 1 } });
    expect(harness.mirror.backlinks("A/N.md")).toHaveLength(1);
  });

  it("finds a referrer whose link text names no path, through the backlink index", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "Y.md", kind: "note", revision: "blake3:y1" },
      ],
      notes: [
        // Written as an alias. The text names no path and no basename, so the
        // link-key index cannot answer for it — only the backlink index knows
        // this note points at `Y.md`, because only the daemon's resolution did.
        {
          path: "X.md",
          revision: "blake3:x1",
          outgoing: [harness_ref("X.md", "The Long Alias", "Y.md")],
        },
        { path: "Y.md", revision: "blake3:y1" },
      ],
    });
    expect(harness.mirror.resolvedLinks()).toEqual({ "X.md": { "Y.md": 1 } });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["Y.md"] },
        affected_reference_count: 1,
      }),
    );
    const asked = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "The Long Alias", null)] },
    ]);
    await applying;

    expect([...asked]).toEqual(["X.md"]);
    expect(harness.mirror.resolvedLinks()).toEqual({});
    expect(harness.mirror.unresolvedLinks()).toEqual({ "X.md": { "The Long Alias": 1 } });
  });

  it("finds a referrer of a deleted path by link text when the backlink index cannot", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "A", kind: "folder" },
        { path: "A/Y.md", kind: "note", revision: "blake3:a1" },
        { path: "B", kind: "folder" },
        { path: "B/Y.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        {
          path: "X.md",
          revision: "blake3:x1",
          // Ambiguous: two files answer `[[Y]]`. The mirror files the backlink
          // under the **first** candidate only, as Obsidian does, so deleting
          // the second leaves the backlink index with nothing to say.
          outgoing: [
            {
              ...harness_ref("X.md", "Y", "A/Y.md"),
              resolution: { kind: "ambiguous", candidates: ["A/Y.md", "B/Y.md"] },
            },
          ],
        },
        { path: "A/Y.md", revision: "blake3:a1" },
        { path: "B/Y.md", revision: "blake3:b1" },
      ],
    });
    expect(harness.mirror.backlinks("B/Y.md")).toHaveLength(0);
    expect(harness.mirror.backlinks("A/Y.md")).toHaveLength(1);

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["B/Y.md"] },
        affected_reference_count: 1,
      }),
    );
    // `[[Y]]` is no longer ambiguous, and the only way the mirror knew to ask
    // was the text `X.md` wrote.
    const asked = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "A/Y.md")] },
    ]);
    await applying;

    expect([...asked].sort()).toEqual(["B", "X.md"]);
    expect(harness.mirror.note("X.md")?.outgoing[0]?.resolution.kind).toBe("resolved");
  });

  it("refetches the referrers of a path that turned out to be absent", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "Y.md", kind: "note", revision: "blake3:y1" },
      ],
      notes: [
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "Y.md")] },
        { path: "Y.md", revision: "blake3:y1" },
      ],
    });

    // The event called it a modification. By the time the refetch landed the
    // path was gone — so it is a removal nobody planned for, and its referrers
    // were never in the first request.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["Y.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const first = await harness.answerRefetch(6, [], { absent: ["Y.md"] });
    expect([...first]).toEqual(["Y.md"]);
    // A **second** `get_tree_entries`, for the referrer alone.
    const second = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", null)] },
    ]);
    await applying;

    expect([...second]).toEqual(["X.md"]);
    expect(harness.mirror.entry("Y.md")).toBeUndefined();
    expect(harness.mirror.resolvedLinks()).toEqual({});
    expect(harness.mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });
  });

  it("asks for the ancestors of a modified path, because an edit moves the folder", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "F", kind: "folder", mtimeMs: 100 },
        { path: "F/A.md", kind: "note", revision: "blake3:a1" },
      ],
      notes: [{ path: "F/A.md", revision: "blake3:a1" }],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["F/A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    // The daemon writes a note atomically, through a temporary file renamed
    // into place, so a plain **edit** moves the containing folder's `mtime` —
    // and the change set names only the note. Measured against the shipped
    // daemon: six sequential `write_note`s into one folder moved that folder's
    // stored row in every one of the six generations.
    const asked = await harness.answerRefetch(
      6,
      [{ path: "F/A.md", revision: "blake3:a2" }],
      { entries: [{ path: "F", kind: "folder", mtimeMs: 900 }] },
    );
    await applying;

    expect([...asked].sort()).toEqual(["F", "F/A.md"]);
    expect(harness.mirror.entry("F")?.mtimeMs).toBe(900);
  });

  it("asks for every ancestor of a created or deleted path, seen or not", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "F", kind: "folder", mtimeMs: 100 },
        { path: "F/Old.md", kind: "note", revision: "blake3:o1" },
      ],
      notes: [{ path: "F/Old.md", revision: "blake3:o1" }],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: {
          kind: "detailed",
          created: ["F/New.md"],
          modified: [],
          deleted: ["F/Old.md"],
        },
        affected_note_count: 2,
      }),
    );
    const asked = await harness.answerRefetch(
      6,
      [{ path: "F/New.md", revision: "blake3:n1" }],
      // The folder's own mtime moved, twice over, and the daemon named neither
      // the add nor the removal against it.
      { entries: [{ path: "F", kind: "folder", mtimeMs: 900 }] },
    );
    await applying;

    // The deleted path itself is still never fetched — the mirror already knows
    // everything it is about to forget — but its **folder** is.
    expect([...asked].sort()).toEqual(["F", "F/New.md"]);
    expect(harness.mirror.entry("F")?.mtimeMs).toBe(900);
    expect(harness.mirror.entry("F/Old.md")).toBeUndefined();
    expect(harness.mirror.children("F").map((entry) => entry.path)).toEqual(["F/New.md"]);
  });

  it("refuses a get_note answer that omitted the sections facet", async () => {
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
    const tree = await harness.expectRequest("get_tree_entries");
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
    const note = await harness.expectRequest("get_note");
    // The mirror image of the case above: `list_items` present, `sections`
    // absent. Each half of the guard has to be tested on its own, or defaulting
    // one of them to `[]` survives every case in the file.
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
        list_items: [],
      },
    });

    await expect(applying).rejects.toThrow(/sections/);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a1");
  });

  it("reports a note whose content moved past its tree row as modified", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const batches: Array<{ modified: string[] }> = [];
    harness.mirror.onBatch((batch) => batches.push({ modified: [...batch.modified] }));

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    // `get_tree_entries` and `get_note` answered at different generations for
    // one path: the tree row still carries the old revision while the note row
    // carries the new one. A note's two revisions are the same hash, so this is
    // defence in depth rather than something the daemon does — but classifying
    // on the tree stamp alone would report a note whose content moved as
    // unchanged, and the batch would be suppressed as empty.
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }], {
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
    });
    await applying;

    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    expect(batches).toEqual([{ modified: ["A.md"] }]);
  });

  it("never skips a mutation for a generation the subscription already applied", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));

    // The echo wins the race: the subscription's event for generation 6 is
    // applied before this host's own write response comes back.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await applying;
    expect(harness.mirror.appliedThrough()).toBe(6);
    harness.clearMethodLog();

    // **The staleness guard must not touch this.** `applyMutation`'s whole job
    // is to have refetched these paths before the shim's write resolves, and a
    // race in which the subscription happened to arrive first must not turn
    // read-your-writes into a maybe. So it asks again.
    const mutating = harness.mirror.applyMutation(6, ["A.md"]);
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await mutating;

    expect(harness.methodsSeen()).toEqual(["get_tree_entries", "get_note"]);
    // **And exactly one batch for one write**, whichever side produced it: the
    // second apply changed nothing, so it reported nothing. Without that the
    // plugin that did the writing sees two `changed` events for its one write.
    expect(batches).toEqual([6]);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
  });

  it("carries the revision of every path it names, including a deleted one", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "Kept.md", kind: "note", revision: "blake3:k1" },
        { path: "Gone.md", kind: "note", revision: "blake3:g1" },
        { path: "Folder", kind: "folder" },
      ],
      notes: [
        { path: "Kept.md", revision: "blake3:k1" },
        { path: "Gone.md", revision: "blake3:g1" },
      ],
    });
    const batches: MirrorChangeBatch[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch));

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: {
          kind: "detailed",
          created: ["Folder/pixel.png"],
          modified: ["Kept.md"],
          deleted: ["Gone.md"],
        },
        affected_note_count: 2,
      }),
    );
    await harness.answerRefetch(6, [{ path: "Kept.md", revision: "blake3:k2" }], {
      entries: [
        { path: "Folder/pixel.png", kind: "file", size: 4 },
        { path: "Folder", kind: "folder" },
      ],
    });
    await applying;

    // Task 7 pairs a rename's delete with its create by the deleted path's
    // **last-known** revision, and by now that row is gone from the mirror.
    expect(harness.mirror.entry("Gone.md")).toBeUndefined();
    expect(batches[0]?.revisions).toEqual({
      "Gone.md": "blake3:g1",
      "Kept.md": "blake3:k2",
      // An attachment has no revision, and the batch says so rather than
      // inventing one.
      "Folder/pixel.png": null,
    });
  });

  it("drops the note row when a path stops being a note", async () => {
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

    // The shipped daemon cannot produce this — a row's kind follows its
    // extension and the extension is part of the path, so a kind change is a
    // *different* path — which is exactly why the guard needs a case: it is
    // there so "the mirror never serves a note row for something that is not a
    // note" is true by construction rather than by that argument, and an
    // argument is not something a test can hold on to.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
      }),
    );
    await harness.answerRefetch(6, [], { entries: [{ path: "A.md", kind: "file", size: 9 }] });
    await applying;

    expect(harness.mirror.entry("A.md")?.kind).toBe("file");
    expect(harness.mirror.note("A.md")).toBeUndefined();
    // And its edges went with it, rather than being served out of an index the
    // row that owned them has left.
    expect(harness.mirror.backlinks("B.md")).toHaveLength(0);
    expect(harness.mirror.resolvedLinks()["A.md"]).toBeUndefined();
    expect(harness.mirror.positions("A.md")).toBeUndefined();
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
