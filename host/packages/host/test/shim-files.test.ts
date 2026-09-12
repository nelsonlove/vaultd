import { describe, expect, it } from "vitest";
import { TAbstractFile, TFile, TFolder } from "../src/shim/files";
import { ShimHarness } from "../src/testing/shim-harness";

describe("FileIndex", () => {
  it("builds real TFile and TFolder instances with working instanceof", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/Note.md", kind: "note", revision: "blake3:n1", size: 12 },
      { path: "Folder/img.png", kind: "file", revision: "blake3:i1", size: 40 },
    ]);
    const note = harness.vault.getAbstractFileByPath("Folder/Note.md");
    expect(note).toBeInstanceOf(TFile);
    expect(note).toBeInstanceOf(TAbstractFile);
    expect(note).not.toBeInstanceOf(TFolder);
    const file = note as TFile;
    expect(file.basename).toBe("Note");
    expect(file.extension).toBe("md");
    expect(file.name).toBe("Note.md");
    expect(file.parent).toBeInstanceOf(TFolder);
    expect(file.parent?.path).toBe("Folder");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- `expect.any` is typed `any`
    expect(file.stat).toEqual({ ctime: expect.any(Number), mtime: expect.any(Number), size: 12 });
    expect(harness.vault.getFolderByPath("Folder")?.children.map((c) => c.name).sort())
      .toEqual(["Note.md", "img.png"]);
    expect(harness.vault.getMarkdownFiles().map((f) => f.path)).toEqual(["Folder/Note.md"]);
    expect(harness.vault.getFiles().map((f) => f.path).sort())
      .toEqual(["Folder/Note.md", "Folder/img.png"]);
    expect(harness.vault.getRoot().isRoot()).toBe(true);
  });

  it("keeps TFile identity stable across a modification", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1", size: 3 },
    ]);
    const before = harness.vault.getFileByPath("A.md");
    await harness.emitBatch({ generation: 2, modified: ["A.md"], revisions: { "A.md": "blake3:a2" }, sizes: { "A.md": 9 } });
    const after = harness.vault.getFileByPath("A.md");
    expect(after).toBe(before);
    expect(after?.stat.size).toBe(9);
  });

  it("detaches a deleted file from its parent folder", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/A.md", kind: "note", revision: "blake3:a1" },
    ]);
    await harness.emitBatch({ generation: 3, deleted: ["Folder/A.md"] });
    expect(harness.vault.getAbstractFileByPath("Folder/A.md")).toBeNull();
    expect(harness.vault.getFolderByPath("Folder")?.children).toEqual([]);
  });

  it("pairs a same-revision delete and create into a rename, reusing the instance", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const before = harness.vault.getFileByPath("Folder/A.md");
    // The wire has no rename: this is what vaultd actually emits for a move.
    const applied = await harness.emitBatch({
      generation: 4,
      deleted: ["Folder/A.md"],
      created: ["Folder/Renamed.md"],
      revisions: { "Folder/Renamed.md": "blake3:a1" },
    });
    expect(applied.renamed).toEqual([
      { from: "Folder/A.md", to: "Folder/Renamed.md", file: before },
    ]);
    // `toEqual` above is structural, and Task 15 hands this exact object to
    // `vault.trigger("rename", file, oldPath)`: a clone here would defeat the
    // `Map<TFile, …>` promise the whole identity rule exists for.
    expect(applied.renamed[0]?.file).toBe(before);
    expect(applied.created).toEqual([]);
    expect(applied.deleted).toEqual([]);
    const after = harness.vault.getFileByPath("Folder/Renamed.md");
    expect(after).toBe(before);
    expect(after?.name).toBe("Renamed.md");
    expect(after?.basename).toBe("Renamed");
    expect(harness.vault.getAbstractFileByPath("Folder/A.md")).toBeNull();
  });

  it("refuses to pair a path named by both created and deleted", async () => {
    // Ruling W6: the thing that was there was removed and a *different* thing
    // was put in its place. Pairing would marry the path to itself and report a
    // rename from `X.md` to `X.md`.
    const harness = await ShimHarness.withEntries([
      { path: "X.md", kind: "note", revision: "blake3:x" },
    ]);
    const before = harness.vault.getFileByPath("X.md");
    const applied = await harness.emitBatch({
      generation: 6,
      deleted: ["X.md"],
      created: ["X.md"],
      revisions: { "X.md": "blake3:x" },
    });
    expect(applied.renamed).toEqual([]);
    expect(applied.deleted.map((f) => f.path)).toEqual(["X.md"]);
    expect(applied.created.map((f) => f.path)).toEqual(["X.md"]);
    // Delete before create, or the create is immediately undone: the node in
    // the tree is the new one, and it is not the old instance.
    const after = harness.vault.getFileByPath("X.md");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("replays a folder replaced by a file as a delete and then a create", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Thing", kind: "folder" },
      { path: "Thing/Inside.md", kind: "note", revision: "blake3:inside" },
    ]);
    const before = harness.vault.getFolderByPath("Thing");
    expect(before).not.toBeNull();
    const applied = await harness.emitBatch({
      generation: 7,
      // The mirror expands a deleted folder's subtree, so the batch names both.
      deleted: ["Thing", "Thing/Inside.md"],
      created: ["Thing"],
      revisions: { Thing: "blake3:thing" },
    });
    expect(applied.renamed).toEqual([]);
    // Delete first, then create: a create that ran first would be spliced out
    // by the delete that followed it, and `Thing` would be gone entirely.
    const after = harness.vault.getAbstractFileByPath("Thing");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(harness.vault.getAbstractFileByPath("Thing/Inside.md")).toBeNull();
    // Exactly one node at that path in the parent, not two.
    expect(harness.vault.getRoot().children.map((child) => child.path)).toEqual(["Thing"]);
  });

  it("pairs notes only, never an attachment that happens to share a revision", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/img.png", kind: "file" },
    ]);
    const before = harness.vault.getFileByPath("Folder/img.png");
    const applied = await harness.emitBatch({
      generation: 8,
      deleted: ["Folder/img.png"],
      created: ["Folder/img2.png"],
      // An attachment carries no revision in the index at all; a batch that
      // supplied one anyway must still not produce a rename, because pairing by
      // content revision is a claim only a note can make.
      revisions: { "Folder/img.png": "blake3:same", "Folder/img2.png": "blake3:same" },
    });
    expect(applied.renamed).toEqual([]);
    expect(applied.deleted.map((f) => f.path)).toEqual(["Folder/img.png"]);
    expect(applied.created.map((f) => f.path)).toEqual(["Folder/img2.png"]);
    expect(harness.vault.getFileByPath("Folder/img2.png")).not.toBe(before);
  });

  it("never pairs across kinds, whichever end is the attachment", async () => {
    // Pairing by content revision is a claim only a note can make: the index
    // stores no revision for an attachment at all. A batch that supplied one
    // anyway must not turn a delete and a create into a move — in either
    // direction, because the guard is on both ends of the pair.
    const harness = await ShimHarness.withEntries([
      { path: "img.png", kind: "file" },
      { path: "Note.md", kind: "note", revision: "blake3:note" },
    ]);
    const attachmentToNote = await harness.emitBatch({
      generation: 9,
      deleted: ["img.png"],
      created: ["Made.md"],
      revisions: { "img.png": "blake3:shared", "Made.md": "blake3:shared" },
    });
    expect(attachmentToNote.renamed).toEqual([]);

    const noteToAttachment = await harness.emitBatch({
      generation: 10,
      deleted: ["Note.md"],
      created: ["made.png"],
      revisions: { "Note.md": "blake3:note", "made.png": "blake3:note" },
    });
    expect(noteToAttachment.renamed).toEqual([]);
    expect(noteToAttachment.deleted.map((f) => f.path)).toEqual(["Note.md"]);
    expect(noteToAttachment.created.map((f) => f.path)).toEqual(["made.png"]);
  });

  it("pairs a real move in the same batch as a folder replaced by a file", async () => {
    // `X.md` is named by both lists — Ruling W6 — and it shares its revision
    // with the move happening beside it. Letting it into either side of the
    // pairing makes that side ambiguous and suppresses a rename that really
    // happened, so both ends exclude it.
    const harness = await ShimHarness.withEntries([
      { path: "Old.md", kind: "note", revision: "blake3:shared" },
      { path: "X.md", kind: "note", revision: "blake3:shared" },
    ]);
    const before = harness.vault.getFileByPath("Old.md");
    const applied = await harness.emitBatch({
      generation: 11,
      deleted: ["Old.md", "X.md"],
      created: ["X.md", "New.md"],
      revisions: { "X.md": "blake3:shared", "New.md": "blake3:shared" },
    });
    expect(applied.renamed.map((one) => `${one.from} -> ${one.to}`)).toEqual(["Old.md -> New.md"]);
    expect(applied.renamed[0]?.file).toBe(before);
    expect(applied.deleted.map((f) => f.path)).toEqual(["X.md"]);
    expect(applied.created.map((f) => f.path)).toEqual(["X.md"]);
  });

  it("refuses to guess when one revision matches two created paths", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:same" },
    ]);
    const applied = await harness.emitBatch({
      generation: 5,
      deleted: ["A.md"],
      created: ["Copy1.md", "Copy2.md"],
      revisions: { "Copy1.md": "blake3:same", "Copy2.md": "blake3:same" },
    });
    // A wrong rename fires a handler with a lying oldPath. Two plain creates
    // and one plain delete is the honest report.
    expect(applied.renamed).toEqual([]);
    expect(applied.created.map((f) => f.path).sort()).toEqual(["Copy1.md", "Copy2.md"]);
    expect(applied.deleted.map((f) => f.path)).toEqual(["A.md"]);
  });
});
