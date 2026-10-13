import { afterEach, describe, expect, it } from "vitest";

import { MirrorHarness, harness_ref } from "../src/testing/mirror-harness";
import { ShimHarness } from "../src/testing/shim-harness";
import type { GenerationCommittedEventDto, RuntimeEventDto } from "../src/client/protocol";

/**
 * Every Markdown note is a key in both link tables, even with no links.
 *
 * Obsidian's `MetadataCache.resolveLinks` writes `resolvedLinks[path]` and
 * `unresolvedLinks[path]` for every note it resolves, an empty `{}` for a note
 * that links nowhere. A plugin may use "every Markdown file is a key" as its
 * signal that the link index is ready: vault-mcp's `linkIndexReady()` does, and
 * before this rule its `obsidian_get_backlinks` answered `index_loading` for
 * the life of the host on any vault that held one link-less note (the
 * 2026-10-13 probe, `.superpowers/sdd/vault-mcp-on-host-probe.md`).
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

describe("Link tables key every note", () => {
  it("gives a link-less note an empty entry in both tables, and a non-note none", async () => {
    const harness = await hydrated({
      generation: 3,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "Quiet.md", kind: "note", revision: "blake3:q1" },
        { path: "pixel.png", kind: "file", size: 4 },
      ],
      notes: [
        {
          path: "A.md",
          revision: "blake3:a1",
          outgoing: [harness_ref("A.md", "Quiet", "Quiet.md"), harness_ref("A.md", "Ghost", null)],
        },
        { path: "Quiet.md", revision: "blake3:q1" },
      ],
    });

    expect(harness.mirror.resolvedLinks()).toEqual({ "A.md": { "Quiet.md": 1 }, "Quiet.md": {} });
    expect(harness.mirror.unresolvedLinks()).toEqual({ "A.md": { Ghost: 1 }, "Quiet.md": {} });
  });

  it("keeps the keys current across a create, a rename and a delete", async () => {
    const harness = await hydrated({
      generation: 3,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    expect(Object.keys(harness.mirror.resolvedLinks())).toEqual(["A.md"]);

    // Create a link-less note.
    const creating = harness.mirror.applyEvent(
      committed({
        generation: 4,
        changes: { kind: "detailed", created: ["B.md"], modified: [], deleted: [] },
        affected_note_count: 1,
      }),
    );
    await harness.answerRefetch(4, [{ path: "B.md", revision: "blake3:b1" }], {
      entries: [{ path: "B.md", kind: "note", revision: "blake3:b1" }],
    });
    await creating;
    expect(harness.mirror.resolvedLinks()).toEqual({ "A.md": {}, "B.md": {} });
    expect(harness.mirror.unresolvedLinks()).toEqual({ "A.md": {}, "B.md": {} });

    // Rename B to C: the wire's deleted-plus-created.
    const renaming = harness.mirror.applyEvent(
      committed({
        generation: 5,
        changes: { kind: "detailed", created: ["C.md"], modified: [], deleted: ["B.md"] },
        affected_note_count: 2,
      }),
    );
    await harness.answerRefetch(5, [{ path: "C.md", revision: "blake3:b1" }], {
      entries: [{ path: "C.md", kind: "note", revision: "blake3:b1" }],
    });
    await renaming;
    expect(harness.mirror.resolvedLinks()).toEqual({ "A.md": {}, "C.md": {} });
    expect(harness.mirror.unresolvedLinks()).toEqual({ "A.md": {}, "C.md": {} });

    // Delete A.
    await harness.mirror.applyEvent(
      committed({
        generation: 6,
        changes: { kind: "detailed", created: [], modified: [], deleted: ["A.md"] },
        affected_note_count: 1,
      }),
    );
    expect(harness.mirror.resolvedLinks()).toEqual({ "C.md": {} });
    expect(harness.mirror.unresolvedLinks()).toEqual({ "C.md": {} });
  });
});

describe("MetadataCache link tables through the shim", () => {
  it("has a key for every Markdown file, so a readiness check over getMarkdownFiles passes", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/Lonely.md", kind: "note", revision: "blake3:l1" },
      { path: "Top.md", kind: "note", revision: "blake3:t1" },
    ]);
    harnesses.push(harness);
    const cache = harness.app.metadataCache;
    const markdown = harness.vault.getMarkdownFiles().map((file) => file.path).sort();
    expect(markdown).toEqual(["Folder/Lonely.md", "Top.md"]);
    // vault-mcp's `linkIndexReady()`: every Markdown path is a key.
    expect(markdown.every((path) => path in cache.resolvedLinks)).toBe(true);
    expect(markdown.every((path) => path in cache.unresolvedLinks)).toBe(true);
    expect(cache.resolvedLinks["Folder/Lonely.md"]).toEqual({});
  });
});
