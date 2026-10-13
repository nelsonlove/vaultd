import { afterEach, describe, expect, it } from "vitest";

import { MirrorHarness, harness_ref, linkEdges } from "../src/testing/mirror-harness";
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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "X.md": { "Y.md": 1 } });

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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "X.md": { Y: 1 } });
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
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({
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
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({
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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "Src.md": { "A/N.md": 1 } });

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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "Src.md": { "A/N.md": 1 } });
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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "X.md": { "Y.md": 1 } });

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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "X.md": { "The Long Alias": 1 } });
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
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "X.md": { Y: 1 } });
  });

  it("consults link text for every path under a deleted folder, not only the folder", async () => {
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
    // The backlink index files an ambiguous link under the **first** candidate
    // only, so it has nothing at all to say about `B/Y.md`.
    expect(harness.mirror.backlinks("B/Y.md")).toHaveLength(0);

    // The daemon names the **folder** and leaves the subtree implied. The
    // referrer that only link text can find is `X.md`, and its key names
    // `B/Y.md` — a path the change set never spells out.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["B"] },
        affected_reference_count: 1,
      }),
    );
    const asked = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "A/Y.md")] },
    ]);
    await applying;

    expect([...asked]).toEqual(["X.md"]);
    expect(harness.mirror.entry("B/Y.md")).toBeUndefined();
    // The resolution must not still name a path that no longer exists.
    expect(harness.mirror.note("X.md")?.outgoing[0]?.resolution).toEqual({
      kind: "resolved",
      target: "A/Y.md",
      subpath: null,
    });
  });

  it("keeps the batch when a re-warm fails, and reports the failure instead", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const warming = harness.mirror.warmPositions();
    await harness.answerWarm({ "A.md": "# A\n" });
    await warming;
    expect(harness.mirror.positions("A.md")).toBeDefined();

    const batches: MirrorChangeBatch[] = [];
    const failures: string[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch));
    harness.mirror.onApplyError((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    // The re-warm is refused with something that is **not** an absence, so
    // `warmOne` rightly rethrows it — and the apply must still finish. The row
    // is already installed and `appliedThrough` already advanced by the time
    // the warm runs; losing the batch here would mean the mirror knows about a
    // change that no consumer is ever told about.
    const read = await harness.expectRequest("read_file");
    harness.respondErr(read.id, { code: "internal", message: "the reader fell over" });
    await expect(applying).resolves.toBeUndefined();

    expect(batches.map((batch) => [...batch.modified])).toEqual([["A.md"]]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/the reader fell over/);
    // The note is current; only its byte-offset table is missing, which is a
    // state Obsidian's own API has a word for.
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    expect(harness.mirror.positions("A.md")).toBeUndefined();
  });

  it("escalates when the referrer expansion pushes the refetch past the path limit", async () => {
    const referrers = ["R1.md", "R2.md", "R3.md", "R4.md", "R5.md"];
    const harness = await hydrated(
      {
        generation: 5,
        entries: referrers.map((path) => ({ path, kind: "note" as const, revision: `blake3:${path}` })),
        notes: referrers.map((path) => ({
          path,
          revision: `blake3:${path}`,
          outgoing: [harness_ref(path, "Hub", null)],
        })),
      },
      { mirrorDeltaPathLimit: 3 },
    );

    // The change set is one path — well under the limit, so the pre-queue check
    // lets it through. The **refetch** is six: the created note plus every note
    // that was waiting for that name. Past the limit the delta stops being the
    // cheaper road, and a re-hydration has the better coherence story anyway.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["Hub.md"], modified: [], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 5,
      }),
    );
    await harness.answerHydration({
      generation: 6,
      entries: [{ path: "Hub.md", kind: "note", revision: "blake3:h1" }],
      notes: [{ path: "Hub.md", revision: "blake3:h1" }],
    });
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("refetch_oversized");
    expect(harness.methodsSeen()[0]).toBe("open_snapshot");
    expect(harness.methodsSeen()).not.toContain("get_tree_entries");
    expect(harness.mirror.note("Hub.md")).toBeDefined();
  });

  it("consults link text for a path that turned out to be absent, not only backlinks", async () => {
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

    // A late removal whose referrer only link text can find: the backlink index
    // filed the ambiguous link under the *other* candidate, so consulting it
    // alone finds nobody — the same hole as the planned-removal road, on the
    // road nothing planned.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["B/Y.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(6, [], {
      absent: ["B/Y.md"],
      entries: [{ path: "B", kind: "folder" }],
    });
    const second = await harness.answerRefetch(6, [
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "Y", "A/Y.md")] },
    ]);
    await applying;

    expect([...second]).toEqual(["X.md"]);
    expect(harness.mirror.entry("B/Y.md")).toBeUndefined();
    expect(harness.mirror.note("X.md")?.outgoing[0]?.resolution).toEqual({
      kind: "resolved",
      target: "A/Y.md",
      subpath: null,
    });
  });

  it("re-asks a referrer fetched earlier in this apply when a later pass finds its target gone", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "T.md", kind: "note", revision: "blake3:t1" },
        { path: "X.md", kind: "note", revision: "blake3:x1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "T", "T.md")] },
        { path: "T.md", revision: "blake3:t1", outgoing: [harness_ref("T.md", "X", "X.md")] },
        { path: "X.md", revision: "blake3:x1" },
      ],
    });

    // **"Already fetched in this apply" is not "fetched late enough".** Each
    // round of the late-removal walk is answered at whatever generation is
    // current when it lands, and those generations increase: a row answered in
    // round 0 can name a path round 2 has only just found gone. Subtracting
    // everything already asked for is exactly how such a row reached the
    // install still resolved to a path the same apply was about to remove — and
    // it stayed that way, because the generation that really deletes that path
    // finds the row gone and expands an empty subtree.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md", "X.md"], deleted: [] },
        affected_note_count: 2,
      }),
    );
    // Round 0, answered at 8: `X.md` has gone, and `A.md` — asked in the same
    // batch — still resolves to `T.md`, which is alive at 8.
    const first = await harness.answerRefetch(
      8,
      [{ path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "T", "T.md")] }],
      { absent: ["X.md"] },
    );
    // Round 1, answered at 9: `X.md`'s referrer `T.md` has gone too.
    const second = await harness.answerRefetch(9, [], { absent: ["T.md"] });
    // Round 2, answered at 10: the re-ask. Started but not awaited, so the case
    // fails on the assertions below rather than hanging when the ask is not
    // made; the `catch` is what keeps an unmade ask from surfacing as an
    // unhandled rejection at teardown.
    const third = harness
      .answerRefetch(10, [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "T", null)] },
      ])
      .catch(() => new Set<string>());
    await applying;

    expect([...first].sort()).toEqual(["A.md", "X.md"]);
    expect([...second]).toEqual(["T.md"]);
    expect(harness.mirror.entry("T.md")).toBeUndefined();
    expect(harness.mirror.entry("X.md")).toBeUndefined();
    // The invariant, stated as the oracle states it: nothing resolved names a
    // path the mirror does not hold.
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "A.md": { T: 1 } });
    expect([...(await third)]).toEqual(["A.md"]);
  });

  it("drops a row a later refetch pass reported absent, rather than re-installing it", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "P.md", kind: "note", revision: "blake3:p1" },
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "K.md", kind: "note", revision: "blake3:k1" },
      ],
      notes: [
        { path: "P.md", revision: "blake3:p1", outgoing: [harness_ref("P.md", "X", "X.md")] },
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "K", "K.md")] },
        { path: "K.md", revision: "blake3:k1" },
      ],
    });
    const batches: MirrorChangeBatch[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch));

    // **A later answer's absence wins.** A path served as a row in one round
    // and reported gone in a later one is gone: merging the two answers by
    // keeping both leaves the install removing the path and then putting it
    // straight back from the stale row — a phantom this mirror holds, resolved
    // into something else the same apply removed, and named in the batch's
    // `deleted` while the row is still there. Neither scan of the install guard
    // can see it, because both skip a path that is being removed.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["P.md", "K.md"], deleted: [] },
        affected_note_count: 2,
      }),
    );
    // Round 0 @ 8: `K.md` has gone; `P.md` is served, still resolved to `X.md`.
    await harness.answerRefetch(
      8,
      [{ path: "P.md", revision: "blake3:p1", outgoing: [harness_ref("P.md", "X", "X.md")] }],
      { absent: ["K.md"] },
    );
    // Round 1 @ 9: `K.md`'s referrer `X.md` has gone too.
    await harness.answerRefetch(9, [], { absent: ["X.md"] });
    // Round 2 @ 10: the re-ask of `P.md` — which has gone as well.
    await harness.answerRefetch(10, [], { absent: ["P.md"] });
    await applying;

    expect(harness.mirror.entry("P.md")).toBeUndefined();
    expect(harness.mirror.entry("X.md")).toBeUndefined();
    expect(harness.mirror.entry("K.md")).toBeUndefined();
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    // Nothing needed a re-hydration: every removal was applied as a removal.
    expect(harness.mirror.lastResyncReason()).toBeNull();
    expect(batches).toHaveLength(1);
    expect([...batches[0]!.deleted].sort()).toEqual(["K.md", "P.md", "X.md"]);
  }, 20_000);

  it("does not re-ask or escalate for a path replaced in place", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "P.md", kind: "note", revision: "blake3:p1" },
      ],
      notes: [
        { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "P", "P.md")] },
        { path: "P.md", revision: "blake3:p1" },
      ],
    });

    // Ruling W6: one path in `deleted` *and* `created` means the thing there
    // was removed and a different thing put in its place. It is a removal the
    // apply immediately undoes, so a link to it does not dangle — and treating
    // it as a removal costs a second refetch round nothing needed and then a
    // whole re-hydration for a generation that wanted one upsert.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: ["P.md"], modified: [], deleted: ["P.md"] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(6, [
      { path: "P.md", revision: "blake3:p2" },
      { path: "X.md", revision: "blake3:x1", outgoing: [harness_ref("X.md", "P", "P.md")] },
    ]);
    await applying;

    expect(harness.methodsSeen().filter((method) => method === "get_tree_entries")).toHaveLength(1);
    expect(harness.mirror.lastResyncReason()).toBeNull();
    expect(harness.mirror.entry("P.md")?.revision).toBe("blake3:p2");
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "X.md": { "P.md": 1 } });
  });

  it("escalates when a held referrer the plan never replaced still resolves into a removal", async () => {
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

    // `Y.md` goes late, so `X.md` is asked as its referrer — and `X.md` comes
    // back as a **folder**, which `refetch` asks no `get_note` for. So it is
    // not an absence, the plan has no row to replace it with, and the note row
    // this mirror still holds is resolved straight into the removal. Only the
    // guard's second scan — the backlink sweep over what is being removed —
    // can see that one.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["Y.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(8, [], { absent: ["Y.md"] });
    await harness.answerRefetch(9, [], { entries: [{ path: "X.md", kind: "folder" }] });
    // Started, not awaited, so a guard that never escalates fails on the
    // assertion below instead of hanging on an answer nobody asked for.
    const rehydrated = harness
      .answerHydration({ generation: 10, entries: [{ path: "X.md", kind: "folder" }], notes: [] })
      .then(() => true)
      .catch(() => false);
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("refetch_oversized");
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(await rehydrated).toBe(true);
  }, 20_000);

  it("treats every resolution the link index files under a target as resolving into it", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "Y.md", kind: "note", revision: "blake3:y1" },
      ],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [
            {
              ...harness_ref("A.md", "Y", "Y.md"),
              resolution: {
                kind: "missing_subpath",
                target: "Y.md",
                subpath: { kind: "heading", value: "gone" },
              },
            },
          ],
        },
        { path: "Y.md", revision: "blake3:y1" },
      ],
    });
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "A.md": { "Y.md": 1 } });

    // **`missing_subpath` is filed under a target**, and so is the first
    // candidate of an `ambiguous`. `resolvedLinks`, the backlink index and the
    // guard must all agree about what "resolves into" means, or the guard
    // agrees with the bug on precisely the shapes it forgot: measured against
    // the real daemon, testing `resolution.kind === "resolved"` instead let one
    // seed-run in twelve install a dangling link.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["Y.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const stale = {
      path: "A.md",
      revision: "blake3:a1",
      outgoing: [
        {
          ...harness_ref("A.md", "Y", "Y.md"),
          resolution: {
            kind: "missing_subpath" as const,
            target: "Y.md",
            subpath: { kind: "heading" as const, value: "gone" },
          },
        },
      ],
    };
    await harness.answerRefetch(8, [], { absent: ["Y.md"] });
    // The referrer, asked and then re-asked, answered stale both times.
    await harness.answerRefetch(9, [stale]);
    await harness.answerRefetch(10, [stale]);
    await harness.answerHydration({
      generation: 11,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "Y", null)] }],
    });
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("refetch_oversized");
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
  }, 20_000);

  it("installs one row for a path two passes both answered", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "T.md", kind: "note", revision: "blake3:t1" },
        { path: "X.md", kind: "note", revision: "blake3:x1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "T", "T.md")] },
        { path: "T.md", revision: "blake3:t1", outgoing: [harness_ref("T.md", "X", "X.md")] },
        { path: "X.md", revision: "blake3:x1" },
      ],
    });
    const batches: MirrorChangeBatch[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch));

    // The re-ask is the first thing that can answer a path already in the plan,
    // so the two answers must merge to one row rather than being installed in
    // sequence — otherwise one path moves twice and is named twice in one
    // batch, which a consumer replaying the batch would apply twice.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md", "X.md"], deleted: [] },
        affected_note_count: 2,
      }),
    );
    await harness.answerRefetch(
      8,
      [{ path: "A.md", revision: "blake3:a2", outgoing: [harness_ref("A.md", "T", "T.md")] }],
      { absent: ["X.md"] },
    );
    await harness.answerRefetch(9, [], { absent: ["T.md"] });
    await harness.answerRefetch(10, [
      { path: "A.md", revision: "blake3:a3", outgoing: [harness_ref("A.md", "T", null)] },
    ]);
    await applying;

    expect(harness.mirror.entry("A.md")?.revision).toBe("blake3:a3");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.modified).toEqual(["A.md"]);
  }, 20_000);

  it("escalates when a row still resolves into a removal after its one re-ask", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "T1.md", kind: "note", revision: "blake3:t1" },
        { path: "T2.md", kind: "note", revision: "blake3:t2" },
        { path: "X.md", kind: "note", revision: "blake3:x1" },
      ],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [harness_ref("A.md", "T1", "T1.md"), harness_ref("A.md", "T2", "T2.md")],
        },
        { path: "T1.md", revision: "blake3:t1", outgoing: [harness_ref("T1.md", "X", "X.md")] },
        { path: "T2.md", revision: "blake3:t2", outgoing: [harness_ref("T2.md", "X", "X.md")] },
        { path: "X.md", revision: "blake3:x1" },
      ],
    });

    // The re-ask is **one per path**, deliberately: chasing a vault that keeps
    // moving one round at a time is what `resync_required` is for. So when the
    // re-asked row still names a removal — here because a *second* target went
    // in a round after the re-ask was answered — the apply installs nothing and
    // takes the re-hydration road, rather than installing a row it knows is
    // wrong.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["A.md", "X.md"], deleted: [] },
        affected_note_count: 2,
      }),
    );
    await harness.answerRefetch(
      8,
      [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [harness_ref("A.md", "T1", "T1.md"), harness_ref("A.md", "T2", "T2.md")],
        },
      ],
      { absent: ["X.md"] },
    );
    // Round 1: `X.md`'s referrers are both `T1.md` and `T2.md`. `T1.md` has
    // gone; `T2.md` is answered from before `X.md` went, so it is itself stale
    // and earns a re-ask of its own.
    await harness.answerRefetch(
      9,
      [{ path: "T2.md", revision: "blake3:t2", outgoing: [harness_ref("T2.md", "X", "X.md")] }],
      { absent: ["T1.md"] },
    );
    // Round 2: the one re-ask each of `A.md` (for `T1.md`) and `T2.md` (for
    // `X.md`) — and `T2.md` turns out to have gone too, which `A.md`'s fresh
    // row, served in this same round, cannot possibly account for.
    await harness.answerRefetch(
      10,
      [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [harness_ref("A.md", "T1", null), harness_ref("A.md", "T2", "T2.md")],
        },
      ],
      { absent: ["T2.md"] },
    );
    await harness.answerHydration({
      generation: 11,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [harness_ref("A.md", "T1", null), harness_ref("A.md", "T2", null)],
        },
      ],
    });
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("refetch_oversized");
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "A.md": { T1: 1, T2: 1 } });
  });

  it("walks a chain of late removals one round per link, and asks each path once", async () => {
    const harness = await hydrated({
      generation: 5,
      entries: [
        { path: "X.md", kind: "note", revision: "blake3:x1" },
        { path: "P.md", kind: "note", revision: "blake3:p1" },
        { path: "Q.md", kind: "note", revision: "blake3:q1" },
        { path: "Other", kind: "folder" },
        { path: "Other/P.md", kind: "note", revision: "blake3:op1" },
      ],
      notes: [
        { path: "X.md", revision: "blake3:x1" },
        { path: "P.md", revision: "blake3:p1", outgoing: [harness_ref("P.md", "X", "X.md")] },
        {
          path: "Q.md",
          revision: "blake3:q1",
          // Asked in round 1 because it wrote the *text* `X`; a referrer of
          // `P.md` by text too, while resolving that name somewhere else.
          outgoing: [harness_ref("Q.md", "X", "X.md"), harness_ref("Q.md", "P", "Other/P.md")],
        },
        { path: "Other/P.md", revision: "blake3:op1" },
      ],
    });

    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["X.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const first = await harness.answerRefetch(8, [], { absent: ["X.md"] });
    // Round 1: both of `X.md`'s referrers, one of which has gone as well.
    const second = await harness.answerRefetch(
      9,
      [
        {
          path: "Q.md",
          revision: "blake3:q1",
          outgoing: [harness_ref("Q.md", "X", null), harness_ref("Q.md", "P", "Other/P.md")],
        },
      ],
      { absent: ["P.md"] },
    );
    await applying;

    expect([...first]).toEqual(["X.md"]);
    expect([...second].sort()).toEqual(["P.md", "Q.md"]);
    // **And no third round.** Expanding `P.md`'s absence derives `Q.md` again —
    // by link text, since `Q.md` wrote that name — and folding each round's
    // asks into `wanted` is the only thing that stops it being asked twice.
    // `Q.md` needs no re-ask either: its round-1 answer was served after both
    // removals were observed, so it resolves into neither.
    expect(harness.methodsSeen().filter((method) => method === "get_tree_entries")).toHaveLength(2);
    expect(harness.pendingRequests()).toHaveLength(0);
    expect(harness.mirror.entry("X.md")).toBeUndefined();
    expect(harness.mirror.entry("P.md")).toBeUndefined();
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({ "Q.md": { "Other/P.md": 1 } });
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({ "Q.md": { X: 1 } });
  });

  it("escalates when the *late-removal loop* pushes the refetch past the path limit", async () => {
    const referrers = ["R1.md", "R2.md", "R3.md", "R4.md", "R5.md"];
    const harness = await hydrated(
      {
        generation: 5,
        entries: [
          { path: "X.md", kind: "note" as const, revision: "blake3:x1" },
          ...referrers.map((path) => ({ path, kind: "note" as const, revision: `blake3:${path}` })),
        ],
        notes: [
          { path: "X.md", revision: "blake3:x1" },
          ...referrers.map((path) => ({
            path,
            revision: `blake3:${path}`,
            outgoing: [harness_ref(path, "X", "X.md")],
          })),
        ],
      },
      { mirrorDeltaPathLimit: 3 },
    );

    // One modified path: the pre-queue check and the pre-loop escalation both
    // let it through, because `wanted` is one. Only the loop's own expansion
    // crosses the limit — when the late removal of `X.md` drags in five
    // referrers nothing planned for — so this is the only road to that branch,
    // and `mirrorDeltaPathLimit` defaults to 512, which a hub note reaches.
    const applying = harness.mirror.applyEvent(
      committed({
        generation: 6,
        previous_generation: 5,
        changes: { kind: "detailed", created: [], modified: ["X.md"], deleted: [] },
        affected_note_count: 1,
      }),
    );
    const asked = await harness.answerRefetch(8, [], { absent: ["X.md"] });
    expect([...asked]).toEqual(["X.md"]);
    await harness.answerHydration({
      generation: 9,
      entries: referrers.map((path) => ({
        path,
        kind: "note" as const,
        revision: `blake3:${path}`,
      })),
      notes: referrers.map((path) => ({
        path,
        revision: `blake3:${path}`,
        outgoing: [harness_ref(path, "X", null)],
      })),
    });
    await applying;

    expect(harness.mirror.lastResyncReason()).toBe("refetch_oversized");
    expect(harness.mirror.entry("X.md")).toBeUndefined();
    expect(linkEdges(harness.mirror.resolvedLinks())).toEqual({});
    expect(linkEdges(harness.mirror.unresolvedLinks())).toEqual({
      "R1.md": { X: 1 },
      "R2.md": { X: 1 },
      "R3.md": { X: 1 },
      "R4.md": { X: 1 },
      "R5.md": { X: 1 },
    });
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
