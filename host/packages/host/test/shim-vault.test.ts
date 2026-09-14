import { beforeAll, describe, expect, it } from "vitest";
import { DispatchQueue } from "../src/runtime/queue";
import { ShimEventBus } from "../src/shim/events";
import { Vault } from "../src/shim/vault";
import { forwardingWriteGate } from "../src/testing/assemble";
import { warmFixtureCache } from "../src/testing/fixture-vault";
import { ShimHarness } from "../src/testing/shim-harness";

/** The one fixture in this file whose notes have to be really parsed. */
const LINKED_VAULT = { "A.md": "x\n", "B.md": "[[A]]\n" };

beforeAll(() => {
  warmFixtureCache(
    Object.keys(LINKED_VAULT)
      .sort()
      .map((path) => ({ path, source: LINKED_VAULT[path as keyof typeof LINKED_VAULT] })),
  );
}, 300_000);

describe("Vault writes", () => {
  it("routes modify to write_note with the mirror revision as the precondition", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const file = harness.vault.getFileByPath("A.md")!;
    const pending = harness.vault.modify(file, "# changed\n");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: { path: "A.md", content: "# changed\n", expected: { revision: "blake3:a1" } },
    });
    harness.respondOk(sent.id, "write_note", { generation: 6, revision: "blake3:a2" });
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await pending;
    expect(harness.mirror.generation()).toBe(6);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
  });

  it("routes create to write_note with an absent precondition and returns a TFile", async () => {
    const harness = await ShimHarness.withEntries([]);
    const pending = harness.vault.create("New.md", "body\n");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: { path: "New.md", content: "body\n", expected: { absent: true } },
    });
    harness.respondOk(sent.id, "write_note", { generation: 2, revision: "blake3:n1" });
    await harness.answerRefetch(2, [{ path: "New.md", revision: "blake3:n1" }]);
    const created = await pending;
    expect(created.path).toBe("New.md");
    expect(harness.vault.getFileByPath("New.md")).toBe(created);
  });

  it("retries process once on revision_conflict and never loses the update", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    harness.setFileContent("A.md", "one\n");
    const file = harness.vault.getFileByPath("A.md")!;
    const seen: string[] = [];
    const pending = harness.vault.process(file, (data) => { seen.push(data); return `${data}two\n`; });

    const readA = await harness.nextRequest();
    expect(readA.request.method).toBe("read_file");
    harness.respondReadFile(readA.id, "one\n", "blake3:a1");
    const writeA = await harness.nextRequest();
    expect(writeA.request.params).toMatchObject({ expected: { revision: "blake3:a1" } });
    harness.respondErr(writeA.id, {
      code: "revision_conflict", message: "revision moved", current_generation: 7,
    });

    const readB = await harness.nextRequest();
    expect(readB.request.method).toBe("read_file");
    harness.respondReadFile(readB.id, "one\nother\n", "blake3:a2");
    const writeB = await harness.nextRequest();
    expect(writeB.request.params).toEqual({
      path: "A.md", content: "one\nother\ntwo\n", expected: { revision: "blake3:a2" },
    });
    harness.respondOk(writeB.id, "write_note", { generation: 8, revision: "blake3:a3" });
    await harness.answerRefetch(8, [{ path: "A.md", revision: "blake3:a3" }]);

    await expect(pending).resolves.toBe("one\nother\ntwo\n");
    expect(seen).toEqual(["one\n", "one\nother\n"]);
  });

  it("serializes two process calls on the same path", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const file = harness.vault.getFileByPath("A.md")!;
    const order: string[] = [];
    const first = harness.vault.process(file, (d) => { order.push("first"); return `${d}1`; });
    const second = harness.vault.process(file, (d) => { order.push("second"); return `${d}2`; });
    await harness.settleProcess("A.md", "x", "blake3:a1", 6, "blake3:a2");
    await first;
    expect(order).toEqual(["first"]);
    await harness.settleProcess("A.md", "x1", "blake3:a2", 7, "blake3:a3");
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("renames a note with rename_note and a folder with rename_folder", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
      { path: "Folder", kind: "folder" },
      { path: "Folder/B.md", kind: "note", revision: "blake3:b1" },
    ]);
    void harness.vault.rename(harness.vault.getFileByPath("A.md")!, "Renamed.md");
    const note = await harness.nextRequest();
    expect(note.request).toEqual({
      method: "rename_note",
      params: { from: "A.md", to: "Renamed.md", rewrite_links: true },
    });

    void harness.vault.rename(harness.vault.getFolderByPath("Folder")!, "Moved");
    const folder = await harness.nextRequest();
    expect(folder.request).toEqual({
      method: "rename_folder",
      params: { from: "Folder", to: "Moved", rewrite_links: true },
    });
  });

  it("refetches the referrers of a renamed note, which the wire never names", async () => {
    // The same affected-set helper `FileManager.renameFile` uses. Before it was
    // shared, this surface refetched `from` and `to` and stopped — leaving
    // every note whose links the daemon had just rewritten stale in the mirror,
    // with wrong `resolvedLinks`, wrong `backlinks` and wrong resolutions, all
    // of them handed straight to plugin code.
    const harness = await ShimHarness.withVault(LINKED_VAULT);
    const pending = harness.vault.rename(harness.vault.getFileByPath("A.md")!, "Renamed.md");
    const sent = await harness.expectRequest("rename_note");
    harness.respondOk(sent.id, "rename_note", {
      generation: 4,
      revision: "blake3:r",
      links_rewritten: 1,
      link_rewrite_failures: [],
    });
    const refetching = harness.answerRefetch(
      4,
      [
        { path: "Renamed.md", revision: "blake3:r" },
        { path: "B.md", revision: "blake3:b2" },
      ],
      { absent: ["A.md"] },
    );
    await pending;
    expect([...(await refetching)].sort()).toEqual(["A.md", "B.md", "Renamed.md"]);
    expect(harness.mirror.note("B.md")?.revision).toBe("blake3:b2");
  });

  it("refetches a renamed folder's whole subtree, at both ends", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/B.md", kind: "note", revision: "blake3:b1" },
      { path: "Folder/Sub", kind: "folder" },
      { path: "Folder/Sub/C.md", kind: "note", revision: "blake3:c1" },
    ]);
    const pending = harness.vault.rename(harness.vault.getFolderByPath("Folder")!, "Moved");
    const sent = await harness.expectRequest("rename_folder");
    harness.respondOk(sent.id, "rename_folder", {
      generation: 9,
      links_rewritten: 0,
      link_rewrite_failures: [],
    });
    // The wire named two paths and moved six rows. Every one of them has to be
    // in the refetch, or the destination subtree is lost for good.
    const asked = await harness.answerRefetch(9, [
      { path: "Moved/B.md", revision: "blake3:b1" },
      { path: "Moved/Sub/C.md", revision: "blake3:c1" },
    ], {
      entries: [
        { path: "Moved", kind: "folder" },
        { path: "Moved/Sub", kind: "folder" },
      ],
    });
    await pending;
    expect([...asked].sort()).toEqual([
      "Folder",
      "Folder/B.md",
      "Folder/Sub",
      "Folder/Sub/C.md",
      "Moved",
      "Moved/B.md",
      "Moved/Sub",
      "Moved/Sub/C.md",
    ]);
    expect(harness.mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "Moved",
      "Moved/B.md",
      "Moved/Sub",
      "Moved/Sub/C.md",
    ]);
  });

  it("copies with if_exists error, so a copy never silently suffixes", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    void harness.vault.copy(harness.vault.getFileByPath("A.md")!, "B.md");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "copy_file",
      params: { from: "A.md", to: "B.md", if_exists: "error" },
    });
  });

  it("refuses to delete a folder that has something in it without force", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const folder = harness.vault.getFolderByPath("Folder")!;
    await expect(harness.vault.delete(folder)).rejects.toMatchObject({
      code: "folder_not_empty",
      path: "Folder",
    });
    // Nothing was sent: the refusal is this host's, before the wire.
    await harness.quiesce();
    expect(harness.pendingRequests()).toEqual([]);

    void harness.vault.delete(folder, true);
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "delete_folder",
      params: { path: "Folder", mode: "permanent", recursive: true },
    });
  });

  it("reads getConfig from .obsidian/app.json when the host directory has none", async () => {
    const harness = await ShimHarness.withEntries([], {
      configFiles: { ".obsidian/app.json": '{"attachmentFolderPath":"Attachments"}' },
    });
    await harness.vault.configReady();
    // Synchronous, and right on the first call: Obsidian's own signature has
    // nowhere to await, so the prime happens at assembly.
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Attachments");
    expect(harness.vault.getConfig("nothingIsHere")).toBeUndefined();
  });

  it("prefers the host directory's app.json over .obsidian's", async () => {
    const harness = await ShimHarness.withEntries([], {
      configFiles: {
        ".obsidian-headless/app.json": '{"attachmentFolderPath":"Headless"}',
        ".obsidian/app.json": '{"attachmentFolderPath":"Attachments"}',
      },
    });
    await harness.vault.configReady();
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Headless");
  });

  it("invalidates the getConfig cache when app.json is rewritten", async () => {
    // `task-12-brief.md` L447-457, verbatim: this is the acceptance case for
    // the invalidation contract, and it is a *synchronous* read-back — dropping
    // the cache without re-priming satisfies the letter and fails this.
    const harness = await ShimHarness.withVault({}, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Old" }) },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Old");
    harness.setConfigFile(".obsidian/app.json", JSON.stringify({ attachmentFolderPath: "New" }));
    await harness.mirror.applyEvent({
      type: "config_changed", value: { path: ".obsidian/app.json" },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("New");
  });

  it("re-primes after the host writes a config file itself", async () => {
    // The other arm. A write into the host's own directory raises no
    // `config_changed` — the daemon only raises one for `.obsidian/` — so this
    // is the only thing that can tell the cache its own bytes moved.
    const harness = await ShimHarness.withEntries([], {
      configFiles: {
        ".obsidian-headless/app.json": JSON.stringify({ attachmentFolderPath: "Old" }),
      },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Old");

    const writing = harness.vault.adapter.write(
      ".obsidian-headless/app.json",
      JSON.stringify({ attachmentFolderPath: "New" }),
    );
    const sent = await harness.expectRequest("write_file");
    harness.setConfigFile(
      ".obsidian-headless/app.json",
      JSON.stringify({ attachmentFolderPath: "New" }),
    );
    // No generation: nothing in the config zone is indexed.
    harness.respondOk(sent.id, "write_file", { revision: "blake3:cfg", semantic: false });
    await writing;
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("New");
  });

  it("records nothing for a getConfig while the cache is still cold", async () => {
    const harness = await ShimHarness.withEntries([], {
      configFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Attachments" }) },
    });
    // A `Vault` of its own, so the prime really is still in flight: the
    // harness's own vault was primed before the factory handed it back.
    const cold = new Vault({
      config: harness.config,
      client: harness.client,
      mirror: harness.mirror,
      events: new ShimEventBus(),
      writes: forwardingWriteGate(harness.client),
      queue: new DispatchQueue(),
    });
    expect(cold.getConfig("attachmentFolderPath")).toBeUndefined();
    // A cold cache is this host's state, not a fact about the plugin, so it is
    // not a `safe_stub` hit against the plugin's name.
    expect(
      harness.policyRecorder.entries().filter((entry) => entry.symbol.startsWith("Vault.getConfig")),
    ).toEqual([]);

    await cold.configReady();
    expect(cold.getConfig("attachmentFolderPath")).toBe("Attachments");
    // A key the file really does not carry is a hit, because that is a fact
    // about what the plugin asked for.
    expect(cold.getConfig("nothingIsHere")).toBeUndefined();
    expect(harness.policyRecorder.entries().map((entry) => entry.symbol)).toContain(
      "Vault.getConfig(nothingIsHere)",
    );
  });

  it("counts an upper-cased extension as markdown", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Lower.md", kind: "note", revision: "blake3:l" },
      { path: "Upper.MD", kind: "note", revision: "blake3:u" },
      { path: "img.png", kind: "file" },
    ]);
    // `Note.MD` is a note to the daemon and to the rename pairing; a vault where
    // those three disagree has a file that is a note for some purposes only.
    expect(harness.vault.getMarkdownFiles().map((file) => file.path).sort()).toEqual([
      "Lower.md",
      "Upper.MD",
    ]);
  });

  it("maps the three deletion forms to the three modes", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
      { path: "B.md", kind: "note", revision: "blake3:b1" },
      { path: "C.md", kind: "note", revision: "blake3:c1" },
    ]);
    const modes: string[] = [];
    void harness.vault.trash(harness.vault.getFileByPath("A.md")!, true);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    void harness.vault.trash(harness.vault.getFileByPath("B.md")!, false);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    void harness.vault.delete(harness.vault.getFileByPath("C.md")!);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    expect(modes).toEqual(["trash_system", "trash_local", "permanent"]);
  });
});
