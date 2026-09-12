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
    expect(applied.created).toEqual([]);
    expect(applied.deleted).toEqual([]);
    const after = harness.vault.getFileByPath("Folder/Renamed.md");
    expect(after).toBe(before);
    expect(after?.name).toBe("Renamed.md");
    expect(after?.basename).toBe("Renamed");
    expect(harness.vault.getAbstractFileByPath("Folder/A.md")).toBeNull();
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
