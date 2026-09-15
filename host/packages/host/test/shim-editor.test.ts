/**
 * The `Editor`: one note's text, in memory, with Obsidian's editor surface over
 * it and exactly one write behind it.
 *
 * What the cases pin, in order: the read is one `get_note` and the buffer it
 * produces is line-addressable; an edit is flushed by a single `write_note`
 * carrying the read's revision as its precondition; a callback that only read
 * costs nothing; positions agree with `CachedMetadata` across an astral-plane
 * character, which is the one place a naive `split("\n")` editor and the
 * mirror's `PositionIndex` would disagree silently; and a selection round-trips
 * through `replaceSelection`.
 */

import { describe, expect, it } from "vitest";

import { Editor } from "../src/shim/editor";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Editor", () => {
  it("reads a note through get_note and exposes it line by line", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\ntwo\nthree\n" });
    const editor = await Editor.open({
      client: harness.client,
      mirror: harness.mirror,
      writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
    });
    expect(editor.getValue()).toBe("one\ntwo\nthree\n");
    expect(editor.lineCount()).toBe(4); // trailing newline yields an empty last line
    expect(editor.lastLine()).toBe(3);
    expect(editor.getLine(1)).toBe("two");
    expect(editor.getCursor()).toEqual({ line: 0, ch: 0 });
    expect(editor.somethingSelected()).toBe(false);
    expect(editor.dirty()).toBe(false);
  });

  it("replaceRange edits the buffer and flush writes it once", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\ntwo\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const editor = await Editor.open({
      client: harness.client,
      mirror: harness.mirror,
      writes: harness.writes,
      file,
    });
    editor.replaceRange("TWO", { line: 1, ch: 0 }, { line: 1, ch: 3 });
    expect(editor.getValue()).toBe("one\nTWO\n");
    expect(editor.dirty()).toBe(true);

    const flushing = editor.flush();
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: {
        path: "A.md",
        content: "one\nTWO\n",
        expected: { revision: harness.revisionOf("A.md") },
      },
    });
    harness.respondOk(sent.id, "write_note", { generation: 3, revision: "blake3:a2" });
    await harness.answerRefetch(3, [{ path: "A.md", revision: "blake3:a2" }]);
    await flushing;
    expect(editor.dirty()).toBe(false);
  });

  it("writes nothing when the callback only read", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\n" });
    const editor = await Editor.open({
      client: harness.client,
      mirror: harness.mirror,
      writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
    });
    void editor.getValue();
    harness.clearMethodLog();
    await editor.flush();
    expect(harness.methodsSeen()).toEqual([]);
  });

  it("agrees with CachedMetadata positions across astral-plane characters", async () => {
    const source = "a\u{1F600}b [[Link]]\n";
    const harness = await ShimHarness.withVault({ "A.md": source });
    const editor = await Editor.open({
      client: harness.client,
      mirror: harness.mirror,
      writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
    });
    const link = harness.app.metadataCache.getCache("A.md")!.links![0]!;
    expect(editor.offsetToPos(link.position.start.offset)).toEqual({
      line: link.position.start.line,
      ch: link.position.start.col,
    });
    expect(
      editor.posToOffset({ line: link.position.start.line, ch: link.position.start.col }),
    ).toBe(link.position.start.offset);
  });

  it("round-trips a selection and replaces it", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "hello world\n" });
    const editor = await Editor.open({
      client: harness.client,
      mirror: harness.mirror,
      writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
      initialSelection: { from: { line: 0, ch: 6 }, to: { line: 0, ch: 11 } },
    });
    expect(editor.somethingSelected()).toBe(true);
    expect(editor.getSelection()).toBe("world");
    editor.replaceSelection("vaultd");
    expect(editor.getValue()).toBe("hello vaultd\n");
    expect(editor.getCursor("head")).toEqual({ line: 0, ch: 12 });
  });
});
