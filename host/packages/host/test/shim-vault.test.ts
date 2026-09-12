import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

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
    void harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
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
    void harness.answerRefetch(2, [{ path: "New.md", revision: "blake3:n1" }]);
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
    void harness.answerRefetch(8, [{ path: "A.md", revision: "blake3:a3" }]);

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
