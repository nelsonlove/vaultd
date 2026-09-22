import { describe, expect, it } from "vitest";

import { DataAdapter, FileSystemAdapter } from "../src/shim/adapter";
import { ShimHarness } from "../src/testing/shim-harness";

/**
 * `vault.adapter`: which wire op each method sends, and what it answers without
 * sending anything.
 *
 * The routing is the part worth pinning. `write` goes to `write_note` or
 * `write_file` depending on the path — the daemon refuses each op for the other
 * kind of path — and a delete goes to `delete_note` or `delete_folder`
 * depending on what the mirror says is there. Neither choice is visible to the
 * plugin that made the call, so neither is visible in a failure either.
 */

async function harnessWithTree(): Promise<ShimHarness> {
  return ShimHarness.withEntries([
    { path: "A.md", kind: "note", revision: "blake3:a1", size: 3 },
    { path: "Folder", kind: "folder" },
    { path: "Folder/B.md", kind: "note", revision: "blake3:b1" },
    { path: "Folder/img.png", kind: "file", size: 40 },
  ]);
}

describe("DataAdapter identity", () => {
  it("is a DataAdapter and is never a FileSystemAdapter", async () => {
    const harness = await harnessWithTree();
    // quickadd branches on exactly this. A `true` here sends it down a
    // `getBasePath()`-then-file-system path that would write vault bytes behind
    // the daemon's back, so the class exists, compiles, and matches nothing.
    expect(harness.vault.adapter).toBeInstanceOf(DataAdapter);
    expect(harness.vault.adapter).not.toBeInstanceOf(FileSystemAdapter);
    expect(FileSystemAdapter.prototype).toBeInstanceOf(DataAdapter);
  });

  it("answers the vault's name and paths without a round trip", async () => {
    const harness = await harnessWithTree();
    const adapter = harness.vault.adapter;
    expect(adapter.getName()).toBe("vault");
    expect(adapter.getBasePath()).toBe("/vault");
    expect(adapter.getFullPath("Folder/B.md")).toBe("/vault/Folder/B.md");
    expect(() => adapter.getFullPath("../escape")).toThrow("climbs out of the vault");
    expect(adapter.getResourcePath("Folder/img.png")).toBe("app://headless/Folder/img.png");
    expect(
      harness.policyRecorder
        .entries()
        .map((entry) => `${entry.symbol}:${entry.policy}`),
    ).toContain("DataAdapter.getResourcePath:safe_stub");
    await harness.quiesce();
    expect(harness.pendingRequests()).toEqual([]);
  });

  it("lists and stats from the mirror", async () => {
    const harness = await harnessWithTree();
    await expect(harness.vault.adapter.list("Folder")).resolves.toEqual({
      files: ["Folder/B.md", "Folder/img.png"],
      folders: [],
    });
    await expect(harness.vault.adapter.list("")).resolves.toEqual({
      files: ["A.md"],
      folders: ["Folder"],
    });
    await expect(harness.vault.adapter.stat("Folder")).resolves.toMatchObject({ type: "folder" });
    await expect(harness.vault.adapter.stat("A.md")).resolves.toMatchObject({
      type: "file",
      size: 3,
    });
    await expect(harness.vault.adapter.stat("Nowhere.md")).resolves.toBeNull();
  });

  it("answers exists from the mirror, and refuses a folded spelling when asked to be exact", async () => {
    const harness = await harnessWithTree();
    await expect(harness.vault.adapter.exists("A.md")).resolves.toBe(true);
    await expect(harness.vault.adapter.exists("a.MD")).resolves.toBe(true);
    await expect(harness.vault.adapter.exists("a.MD", true)).resolves.toBe(false);
  });
});

describe("DataAdapter op routing", () => {
  it("writes a note with write_note and a zone file with write_file", async () => {
    const harness = await harnessWithTree();

    void harness.vault.adapter.write("New.md", "# New\n");
    const note = await harness.nextRequest();
    expect(note.request).toEqual({
      method: "write_note",
      params: { path: "New.md", content: "# New\n" },
    });

    // A `.md` file inside the config zone is bytes, not a note: nothing under a
    // dot-segment is indexed, and `write_note` would refuse it.
    void harness.vault.adapter.write(".obsidian-headless/notes.md", "text\n");
    const zone = await harness.nextRequest();
    expect(zone.request).toEqual({
      method: "write_file",
      params: {
        path: ".obsidian-headless/notes.md",
        content_base64: Buffer.from("text\n", "utf8").toString("base64"),
      },
    });

    void harness.vault.adapter.writeBinary("Folder/img.png", new ArrayBuffer(2));
    const binary = await harness.nextRequest();
    expect(binary.request).toEqual({
      method: "write_file",
      params: {
        path: "Folder/img.png",
        content_base64: Buffer.from(new Uint8Array(2)).toString("base64"),
      },
    });
  });

  it("appends through a read and a precondition", async () => {
    const harness = await harnessWithTree();
    void harness.vault.adapter.append("A.md", "tail\n");
    const read = await harness.expectRequest("read_file");
    harness.respondReadFile(read.id, "head\n", "blake3:a1");
    const write = await harness.expectRequest("write_note");
    expect(write.request.params).toEqual({
      path: "A.md",
      content: "head\ntail\n",
      expected: { revision: "blake3:a1" },
    });
  });

  it("maps the folder and deletion ops", async () => {
    const harness = await harnessWithTree();

    void harness.vault.adapter.mkdir("Made");
    expect((await harness.nextRequest()).request).toEqual({
      method: "create_folder",
      params: { path: "Made" },
    });

    void harness.vault.adapter.remove("A.md");
    expect((await harness.nextRequest()).request).toEqual({
      method: "delete_note",
      params: { path: "A.md", mode: "permanent" },
    });

    void harness.vault.adapter.rmdir("Folder", true);
    expect((await harness.nextRequest()).request).toEqual({
      method: "delete_folder",
      params: { path: "Folder", mode: "permanent", recursive: true },
    });

    void harness.vault.adapter.trashSystem("A.md");
    expect((await harness.nextRequest()).request).toEqual({
      method: "delete_note",
      params: { path: "A.md", mode: "trash_system" },
    });

    void harness.vault.adapter.trashLocal("A.md");
    expect((await harness.nextRequest()).request).toEqual({
      method: "delete_note",
      params: { path: "A.md", mode: "trash_local" },
    });

    // A folder trashes as a folder, recursively, and by the same mode.
    void harness.vault.adapter.trashSystem("Folder");
    expect((await harness.nextRequest()).request).toEqual({
      method: "delete_folder",
      params: { path: "Folder", mode: "trash_system", recursive: true },
    });
  });

  it("renames by kind and copies with if_exists error", async () => {
    const harness = await harnessWithTree();

    void harness.vault.adapter.rename("A.md", "Renamed.md");
    expect((await harness.nextRequest()).request).toEqual({
      method: "rename_note",
      params: { from: "A.md", to: "Renamed.md", rewrite_links: true },
    });

    void harness.vault.adapter.rename("Folder", "Moved");
    expect((await harness.nextRequest()).request).toEqual({
      method: "rename_folder",
      params: { from: "Folder", to: "Moved", rewrite_links: true },
    });

    void harness.vault.adapter.copy("A.md", "Copy.md");
    expect((await harness.nextRequest()).request).toEqual({
      method: "copy_file",
      params: { from: "A.md", to: "Copy.md", if_exists: "error" },
    });
  });

  it("refetches a renamed folder's whole subtree, at both ends", async () => {
    const harness = await harnessWithTree();
    const pending = harness.vault.adapter.rename("Folder", "Moved");
    const sent = await harness.expectRequest("rename_folder");
    harness.respondOk(sent.id, "rename_folder", {
      generation: 9,
      links_rewritten: 0,
      link_rewrite_failures: [],
    });
    // The mirror can expand the *source* folder on its own, but not the
    // destination: those rows do not exist there yet. So this half of the fix
    // is load-bearing rather than defence in depth, and it is asserted here.
    const asked = await harness.answerRefetch(9, [{ path: "Moved/B.md", revision: "blake3:b1" }], {
      entries: [
        { path: "Moved", kind: "folder" },
        { path: "Moved/img.png", kind: "file", size: 40 },
      ],
    });
    await pending;
    expect([...asked].sort()).toEqual([
      "Folder",
      "Folder/B.md",
      "Folder/img.png",
      "Moved",
      "Moved/B.md",
      "Moved/img.png",
    ]);
    expect(harness.mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "A.md",
      "Moved",
      "Moved/B.md",
      "Moved/img.png",
    ]);
  });

  it("drives a write all the way through the gate, the daemon and the mirror", async () => {
    const harness = await harnessWithTree();
    await harness.writeNote("Folder/B.md", "# B again\n");
    expect(harness.revisionOf("Folder/B.md")).toBe("blake3:written-2");
    expect(harness.fileContent("Folder/B.md")).toBe("# B again\n");
    // The containing folder survived the refetch: a path answered by nothing
    // comes back absent, and an absent folder takes its subtree with it.
    expect(harness.vault.getFolderByPath("Folder")).not.toBeNull();
  });
});
