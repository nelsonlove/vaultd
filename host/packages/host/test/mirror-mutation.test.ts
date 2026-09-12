import { describe, expect, it } from "vitest";

import { MirrorHarness } from "../src/testing/mirror-harness";
import type { FixtureEntry } from "../src/testing/mirror-harness";

/**
 * What `Mirror.applyMutation` asks for.
 *
 * One rule, and it exists because of a bug that shipped: **a folder named by a
 * mutation is expanded into its subtree before the refetch**. A caller that
 * renames or deletes a folder knows one path. The rows that move are every row
 * under it, and the wire's answer names none of them — so a mirror that
 * refetched the named path alone advanced `appliedThrough` past the generation
 * that moved them, dropped the `generation_committed` that would have described
 * it as stale, and lost every descendant permanently.
 *
 * The shim names the destination paths it can compute (`Vault.rename`); this is
 * the half the shim cannot do anything about, because a caller naming only a
 * folder must not be able to orphan what is under it whatever it forgets.
 */

const TREE: FixtureEntry[] = [
  { path: "Root.md", kind: "note", revision: "blake3:root" },
  { path: "Folder", kind: "folder" },
  { path: "Folder/A.md", kind: "note", revision: "blake3:a" },
  { path: "Folder/pic.png", kind: "file" },
  { path: "Folder/Sub", kind: "folder" },
  { path: "Folder/Sub/B.md", kind: "note", revision: "blake3:b" },
];

const NOTES = [
  { path: "Root.md", revision: "blake3:root" },
  { path: "Folder/A.md", revision: "blake3:a" },
  { path: "Folder/Sub/B.md", revision: "blake3:b" },
];

describe("Mirror.applyMutation", () => {
  it("expands a folder it holds into its whole subtree before refetching", async () => {
    const harness = await MirrorHarness.hydrated({ generation: 1, entries: TREE, notes: NOTES });
    const applying = harness.mirror.applyMutation(2, ["Folder"]);
    // Nothing is answered as present: this is the shape of a folder that was
    // deleted, or renamed away, which is what makes the subtree disappear.
    const asked = await harness.answerRefetch(2, []);
    await applying;

    expect([...asked].sort()).toEqual([
      "Folder",
      "Folder/A.md",
      "Folder/Sub",
      "Folder/Sub/B.md",
      "Folder/pic.png",
    ]);
    expect(harness.mirror.entries().map((entry) => entry.path)).toEqual(["Root.md"]);
    await harness.stop();
  });

  it("passes a path that is not a folder through as itself", async () => {
    const harness = await MirrorHarness.hydrated({ generation: 1, entries: TREE, notes: NOTES });
    const applying = harness.mirror.applyMutation(2, ["Folder/A.md"]);
    const asked = await harness.answerRefetch(2, [
      { path: "Folder/A.md", revision: "blake3:a2" },
    ]);
    await applying;

    // The folder itself comes along as an ancestor — a folder's `mtime` moves
    // when a child is rewritten — but nothing else under it does.
    expect([...asked].sort()).toEqual(["Folder", "Folder/A.md"]);
    expect(harness.mirror.note("Folder/A.md")?.revision).toBe("blake3:a2");
    await harness.stop();
  });
});
