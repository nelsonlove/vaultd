import { afterEach, describe, expect, it } from "vitest";

import { MirrorHarness, harness_ref } from "../src/testing/mirror-harness";
import { locate, span } from "../src/mirror/positions";
import type { ReferenceDto } from "../src/client/protocol";

/**
 * The read surface — everything Tasks 7 to 9 will consume, and nothing they
 * may bypass.
 *
 * Every method here is **synchronous**, and that is the point of the whole
 * mirror: `vault.getFiles()`, `metadataCache.getFileCache(file)` and
 * `getFirstLinkpathDest` are synchronous in Obsidian's own API, no plugin will
 * await them, and a host that had to ask the daemon could not answer at all.
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

/** A reference whose target exists but whose heading does not. */
function missingSubpath(source: string, raw: string, target: string): ReferenceDto {
  return {
    ...harness_ref(source, raw, target),
    subpath: { kind: "heading", value: "Nowhere" },
    resolution: { kind: "missing_subpath", target, subpath: { kind: "heading", value: "Nowhere" } },
  };
}

/** A Markdown link to somewhere outside the vault. */
function external(source: string, url: string): ReferenceDto {
  return {
    ...harness_ref(source, url, null),
    kind: "markdown_link",
    resolution: { kind: "non_vault" },
  };
}

describe("Mirror tree queries", () => {
  it("answers entries, children and parentage from one hydration", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "Folder", kind: "folder" },
        { path: "Folder/Sub", kind: "folder" },
        { path: "Folder/Sub/Deep.md", kind: "note", revision: "blake3:d1" },
        { path: "Folder/pixel.png", kind: "file", size: 16 },
        { path: "Top.md", kind: "note", revision: "blake3:t1", size: 9 },
      ],
      notes: [
        { path: "Folder/Sub/Deep.md", revision: "blake3:d1" },
        { path: "Top.md", revision: "blake3:t1" },
      ],
    });

    expect(harness.mirror.entries().map((entry) => entry.path)).toEqual([
      "Folder",
      "Folder/Sub",
      "Folder/Sub/Deep.md",
      "Folder/pixel.png",
      "Top.md",
    ]);
    expect(harness.mirror.children("").map((entry) => entry.path)).toEqual(["Folder", "Top.md"]);
    expect(harness.mirror.children("Folder").map((entry) => entry.path)).toEqual([
      "Folder/Sub",
      "Folder/pixel.png",
    ]);
    expect(harness.mirror.children("Folder/Sub/Deep.md")).toEqual([]);
    expect(harness.mirror.entry("Folder/Sub")).toMatchObject({
      kind: "folder",
      name: "Sub",
      parent: "Folder",
      revision: null,
      size: null,
    });
    // Correction #13: an attachment carries no content revision either.
    expect(harness.mirror.entry("Folder/pixel.png")).toMatchObject({
      kind: "file",
      revision: null,
      size: 16,
    });
    expect(harness.mirror.entry("Nowhere.md")).toBeUndefined();
  });

  it("keeps a stable answer for a repeated entries() call", async () => {
    const harness = await hydrated({
      generation: 1,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    expect(harness.mirror.entries()).toBe(harness.mirror.entries());
  });
});

describe("Mirror link tables", () => {
  it("counts resolved and unresolved links the way Obsidian's tables do", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [
            harness_ref("A.md", "B", "B.md"),
            // The same target twice: the table counts, it does not deduplicate.
            harness_ref("A.md", "B", "B.md"),
            // Resolved to the file even though the heading is missing: a link
            // to a real note with a bad anchor still points at that note.
            missingSubpath("A.md", "B", "B.md"),
            harness_ref("A.md", "Ghost", null),
            // An external URL is in neither table.
            external("A.md", "https://example.test/"),
          ],
        },
        { path: "B.md", revision: "blake3:b1" },
      ],
    });

    expect(harness.mirror.resolvedLinks()).toEqual({ "A.md": { "B.md": 3 } });
    expect(harness.mirror.unresolvedLinks()).toEqual({ "A.md": { Ghost: 1 } });
    expect(harness.mirror.backlinks("B.md")).toHaveLength(3);
    expect(harness.mirror.backlinks("Ghost.md")).toEqual([]);
  });

  it("takes a rewritten note's old edges back out of every index", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
        { path: "C.md", kind: "note", revision: "blake3:c1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "B", "B.md")] },
        { path: "B.md", revision: "blake3:b1", outgoing: [harness_ref("B.md", "C", "C.md")] },
        { path: "C.md", revision: "blake3:c1" },
      ],
    });
    expect(harness.mirror.backlinks("B.md")).toHaveLength(1);
    expect(harness.mirror.backlinks("C.md")).toHaveLength(1);

    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 4,
        generation: 5,
        cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 2,
      },
    });
    // A now links to C instead of B.
    await harness.answerRefetch(5, [
      { path: "A.md", revision: "blake3:a2", outgoing: [harness_ref("A.md", "C", "C.md")] },
    ]);
    await applying;

    expect(harness.mirror.backlinks("B.md")).toHaveLength(0);
    // B's own link to C survived: only A's edges were taken out.
    expect(harness.mirror.backlinks("C.md").map((reference) => reference.source_path).sort()).toEqual(
      ["A.md", "B.md"],
    );
    expect(harness.mirror.resolvedLinks()).toEqual({ "A.md": { "C.md": 1 }, "B.md": { "C.md": 1 } });
  });
});

describe("Mirror linkpath resolution", () => {
  it("answers from the daemon's own resolution before guessing at paths", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "B.md", kind: "note", revision: "blake3:b1" },
        { path: "Sub", kind: "folder" },
        { path: "Sub/B.md", kind: "note", revision: "blake3:s1" },
        { path: "A.md", kind: "note", revision: "blake3:a1" },
      ],
      notes: [
        // The daemon resolved this note's `[[B]]` to `Sub/B.md`. Re-deriving it
        // here would be a second opinion about something that has one.
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "B", "Sub/B.md")] },
        { path: "B.md", revision: "blake3:b1" },
        { path: "Sub/B.md", revision: "blake3:s1" },
      ],
    });
    expect(harness.mirror.firstLinkpathDest("B", "A.md")?.path).toBe("Sub/B.md");
    // A subpath is not part of the linkpath.
    expect(harness.mirror.firstLinkpathDest("B#Heading", "A.md")?.path).toBe("Sub/B.md");
  });

  it("finds the file with that name closest to the source", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "Note.md", kind: "note", revision: "blake3:r1" },
        { path: "Sub", kind: "folder" },
        { path: "Sub/Note.md", kind: "note", revision: "blake3:s1" },
        { path: "Sub/src.md", kind: "note", revision: "blake3:x1" },
        { path: "Other", kind: "folder" },
        { path: "Other/pixel.png", kind: "file" },
      ],
      notes: [
        { path: "Note.md", revision: "blake3:r1" },
        { path: "Sub/Note.md", revision: "blake3:s1" },
        { path: "Sub/src.md", revision: "blake3:x1" },
      ],
    });

    expect(harness.mirror.firstLinkpathDest("Note", "Sub/src.md")?.path).toBe("Sub/Note.md");
    expect(harness.mirror.firstLinkpathDest("Note", "Note.md")?.path).toBe("Note.md");
    // A linkpath with a separator is a path, and the vault-absolute form wins.
    expect(harness.mirror.firstLinkpathDest("Sub/Note", "Note.md")?.path).toBe("Sub/Note.md");
    expect(harness.mirror.firstLinkpathDest("Note.md", "Sub/src.md")?.path).toBe("Sub/Note.md");
    // A non-note file is findable by its full name, extension included.
    expect(harness.mirror.firstLinkpathDest("pixel.png", "Note.md")?.path).toBe("Other/pixel.png");
    // A folder is never a link destination.
    expect(harness.mirror.firstLinkpathDest("Sub", "Note.md")).toBeUndefined();
    expect(harness.mirror.firstLinkpathDest("Missing", "Note.md")).toBeUndefined();
    // An empty linkpath is the source itself — that is what `[[#Heading]]` means.
    expect(harness.mirror.firstLinkpathDest("#Heading", "Sub/src.md")?.path).toBe("Sub/src.md");
  });
});

describe("Mirror positions", () => {
  it("warms a position index per note and converts byte offsets through it", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          headings: [{ level: 1, text: "Tîtle", span: { start: 0, end: 8 } }],
        },
      ],
    });
    expect(harness.mirror.positions("A.md")).toBeUndefined();

    const warming = harness.mirror.warmPositions();
    await harness.answerWarm({ "A.md": "# Tîtle\nbody\n" });
    const result = await warming;

    expect(result.warmed).toBe(1);
    const index = harness.mirror.positions("A.md");
    expect(index).toBeDefined();
    // "î" is two UTF-8 bytes and one UTF-16 unit, so the two counts part ways
    // exactly where a host that conflated them would hand a plugin a bad slice.
    expect(index!.byteLength).toBe(14);
    expect(index!.u16Length).toBe(13);
    const heading = harness.mirror.note("A.md")!.headings[0]!;
    expect(span(index!, heading.span.start, heading.span.end)).toEqual({
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 0, col: 7, offset: 7 },
    });
    expect(locate(index!, 9)).toEqual({ line: 1, col: 0, offset: 8 });

    // Warming twice reads nothing again: the index is already there.
    harness.clearMethodLog();
    expect(await harness.mirror.warmPositions()).toMatchObject({ warmed: 0 });
    expect(harness.methodsSeen()).toEqual([]);
  });

  it("skips a note whose bytes have moved past the row it holds", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const warming = harness.mirror.warmPositions();
    const request = await harness.expectRequest("read_file");
    // The file was rewritten between the snapshot and this read. An index built
    // from these bytes would put every span in the note at the wrong offset.
    harness.respondReadFile(request.id, "# Something else entirely\n", "blake3:a2");
    expect(await warming).toMatchObject({ warmed: 0 });
    expect(harness.mirror.positions("A.md")).toBeUndefined();
  });

  it("survives a refusal on one note without failing the warm-up", async () => {
    const harness = await hydrated({
      generation: 4,
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
    for (let i = 0; i < 2; i += 1) {
      const request = await harness.expectRequest("read_file");
      const path = (request.request.params as { path: string }).path;
      if (path === "A.md") harness.respondReadFile(request.id, "# A\n", "blake3:a1");
      else harness.respondErr(request.id, { code: "not_found", message: "gone" });
    }
    expect(await warming).toMatchObject({ warmed: 1 });
    expect(harness.mirror.positions("A.md")).toBeDefined();
    expect(harness.mirror.positions("B.md")).toBeUndefined();
  });
});

describe("Mirror revision stamps", () => {
  it("stamps a folder and an attachment so a synthetic diff can see them move", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [
        { path: "Folder", kind: "folder" },
        { path: "Folder/pixel.png", kind: "file", size: 16, mtimeMs: 100 },
        { path: "A.md", kind: "note", revision: "blake3:a1" },
      ],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const before = harness.mirror.snapshotRevisions();
    expect([...before.keys()].sort()).toEqual(["A.md", "Folder", "Folder/pixel.png"]);
    expect(before.get("A.md")).toBe("blake3:a1");
    expect(before.get("Folder")).toBe("folder");

    const applying = harness.mirror.applyEvent({
      type: "resync_required",
      value: { current_generation: 9, reason: "watcher_overflow" },
    });
    await harness.answerHydration({
      generation: 9,
      entries: [
        { path: "Folder", kind: "folder" },
        // The attachment's bytes changed. It has no revision — the stamp is
        // what makes the move visible at all.
        { path: "Folder/pixel.png", kind: "file", size: 32, mtimeMs: 200 },
        { path: "A.md", kind: "note", revision: "blake3:a1" },
      ],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    await applying;

    expect(harness.mirror.synthesizeDiff(before)).toMatchObject({
      created: [],
      modified: ["Folder/pixel.png"],
      deleted: [],
      synthetic: true,
      cause: "resync",
    });
  });
});

describe("Mirror config fan-out", () => {
  it("tells every listener, in order, and advances nothing", async () => {
    const harness = await hydrated({
      generation: 4,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    const order: string[] = [];
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));
    harness.mirror.onConfigChanged(async (path) => {
      await Promise.resolve();
      order.push(`first:${path}`);
    });
    harness.mirror.onConfigChanged(() => {
      throw new Error("a config listener blew up");
    });
    const off = harness.mirror.onConfigChanged((path) => {
      order.push(`third:${path}`);
    });

    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian/app.json" },
    });

    // The first listener awaited before the third ran: a config reader has
    // finished re-reading before the next host operation.
    expect(order).toEqual(["first:.obsidian/app.json", "third:.obsidian/app.json"]);
    expect(batches).toEqual([]);
    expect(harness.mirror.generation()).toBe(4);
    expect(harness.methodsSeen()).toEqual([]);

    off();
    await harness.mirror.applyEvent({
      type: "config_changed",
      value: { path: ".obsidian/hotkeys.json" },
    });
    expect(order).toEqual([
      "first:.obsidian/app.json",
      "third:.obsidian/app.json",
      "first:.obsidian/hotkeys.json",
    ]);
  });
});
