import { beforeAll, describe, expect, it } from "vitest";

import {
  UnaddressableFrontmatterKey,
  UnrepresentableFrontmatterValue,
} from "../src/shim/file-manager";
import { HeadlessUnsupported, declaredSymbols, policyOf } from "../src/shim/policy";
import { parseFixtureRow, warmFixtureCache } from "../src/testing/fixture-vault";
import { ShimHarness } from "../src/testing/shim-harness";
import type { FixtureNote } from "../src/testing/mirror-harness";
import type { MirrorNoteRow } from "../src/mirror/types";
import type { TFile, TFolder } from "../src/shim/files";

/**
 * `app.fileManager` over a hydrated mirror.
 *
 * Several of the brief's cases were written against fixtures or expectations
 * that could not hold, and are corrected here rather than passed vacuously.
 * Each correction is stated at the case it belongs to; the three that change
 * what the shim *does*, rather than what a case asserts, are collected here:
 *
 * 1. **A rename refetches `from` as well as `to` and the referrers.** The
 *    brief's sketch sent `[newPath, ...referrers]`, and its own case then
 *    asserted the mirror no longer holds a row for the old path — which is true
 *    only if the old path was refetched and answered absent.
 * 2. **`rename_folder` carries no `expected`.** `docs/protocol.md` has the
 *    folder operations rejecting the field with `invalid_request`: a folder has
 *    no bytes and therefore no revision. The brief's sketch passed one for both
 *    kinds.
 * 3. **`generateMarkdownLink` returns a link, not a link text.** The brief
 *    expected `"Solo"` and `"Alias"`; Obsidian's method composes `[[Solo]]` and
 *    `[[Solo#Heading|Alias]]`, which is the whole reason a plugin calls it
 *    rather than `fileToLinktext`.
 *
 * The fixture literals are named constants so the warm-up below can parse
 * exactly the document sets the cases use, in one spawn rather than one per
 * note.
 */
const FRONTMATTER_VAULT = {
  "A.md": "---\ntitle: Old\nkeep: yes\nnested:\n  inner: 1\n---\nbody\n",
};
/** What `A.md` holds once the first case's patch has landed. */
const PATCHED_SOURCE = "---\ntitle: New\nnested:\n  inner: 2\n---\nbody\n";
/** What a competing writer left behind, for the conflict cases. */
const CONFLICTED_SOURCE = "---\ntitle: Other\nkeep: yes\nnested:\n  inner: 1\n---\nbody\n";
const UNCHANGED_VAULT = { "A.md": "---\ntitle: Same\n---\nbody\n" };
/** A key whose own name contains a dot, which the dotted wire form cannot reach. */
const DOTTED_VAULT = { "A.md": "---\nmy.key: dotted\nplain: kept\n---\nbody\n" };
const SHAPED_VAULT = {
  "A.md": "---\nlist:\n  - one\n  - two\nbranch:\n  leaf: 1\nplain: text\n---\nbody\n",
};
const ONE_REFERRER_VAULT = { "A.md": "x\n", "B.md": "[[A]]\n" };
const TWO_REFERRERS_VAULT = { "A.md": "x\n", "B.md": "[[A]]\n", "Busy.md": "[[A]]\n" };
const FOLDER_VAULT = { "Folder/A.md": "x\n", "Outside.md": "[[A]]\n" };
const LINK_VAULT = {
  "Folder/Source.md": "x\n",
  "Folder/Target.md": "x\n",
  "Other/Target.md": "x\n",
  "Solo.md": "x\n",
  "My File.md": "x\n",
  "Hash #1.md": "x\n",
};
const ATTACHMENT_VAULT = { "Notes/Note.md": "x\n", "Attachments/img.png": "not markdown\n" };
const TRASH_VAULT = { "A.md": "x\n", "Folder/B.md": "x\n" };
const UNTITLED_VAULT = { "Untitled/kept.md": "x\n" };

const VAULTS = [
  FRONTMATTER_VAULT,
  UNCHANGED_VAULT,
  DOTTED_VAULT,
  SHAPED_VAULT,
  ONE_REFERRER_VAULT,
  TWO_REFERRERS_VAULT,
  FOLDER_VAULT,
  LINK_VAULT,
  ATTACHMENT_VAULT,
  TRASH_VAULT,
  UNTITLED_VAULT,
];

beforeAll(() => {
  for (const files of VAULTS) {
    // The same set `FixtureVault` builds: markdown only, path-sorted, one
    // request — anything else is a different cache key and warms nothing.
    warmFixtureCache(
      Object.keys(files)
        .filter((path) => path.toLowerCase().endsWith(".md"))
        .sort()
        .map((path) => ({ path, source: files[path as keyof typeof files] })),
    );
  }
  parseFixtureRow("A.md", PATCHED_SOURCE);
  parseFixtureRow("A.md", CONFLICTED_SOURCE);
}, 900_000);

/**
 * First, and deliberately before any harness exists: the table is the host's
 * claim about its own surface, so it has to be complete at import.
 */
describe("the FileManager policy rows", () => {
  it("are declared at import, with nothing constructed", () => {
    const declared = declaredSymbols();
    expect(declared).toContain("FileManager.processFrontMatter");
    expect(policyOf("FileManager.renameFile")).toBe("implemented");
    expect(policyOf("FileManager.generateMarkdownLink")).toBe("implemented");
    expect(policyOf("FileManager.getNewFileParent")).toBe("implemented");
    expect(policyOf("FileManager.getAvailablePathForAttachment")).toBe("implemented");
    expect(policyOf("FileManager.trashFile")).toBe("implemented");
    expect(policyOf("FileManager.createNewFolder")).toBe("implemented");
    // A real documented API with a real answer to give — not `absent`, and not
    // `Promise<void>`.
    expect(policyOf("FileManager.promptForDeletion")).toBe("implemented");
    // Neither appears in `obsidian.d.ts`, so there is no return contract to
    // honour and no honest value to invent.
    expect(policyOf("FileManager.promptForFileRename")).toBe("absent");
    expect(policyOf("FileManager.promptForFolderDeletion")).toBe("absent");
  });
});

describe("FileManager.processFrontMatter", () => {
  it("sends only the keys the callback actually changed", async () => {
    const harness = await ShimHarness.withVault(FRONTMATTER_VAULT);
    const patched = parseFixtureRow("A.md", PATCHED_SOURCE);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      expect(fm).toEqual({ title: "Old", keep: "yes", nested: { inner: 1 } });
      fm["title"] = "New";
      (fm["nested"] as Record<string, unknown>)["inner"] = 2;
      delete fm["keep"];
    });
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "patch_frontmatter",
      params: {
        path: "A.md",
        // Changes and additions in the callback's own key order, deletions
        // last: a deleted key no longer has a place in the new object, so the
        // document's order is the only one left to give it. Every `key_path` is
        // a segment array, never a dotted string — see the dotted-key case.
        patch: [
          { key_path: ["title"], value: "New" },
          { key_path: ["nested", "inner"], value: 2 },
          { key_path: ["keep"], value: null },
        ],
        expected: { revision: harness.revisionOf("A.md") },
      },
    });
    harness.respondOk(sent.id, "patch_frontmatter", { generation: 4, revision: patched.revision });
    await harness.answerRefetch(4, [asFixtureNote(patched)]);
    await pending;
    // Read-your-writes: the plugin's next synchronous read sees its own patch.
    expect(harness.app.metadataCache.getCache("A.md")?.frontmatter).toEqual({
      title: "New",
      nested: { inner: 2 },
    });
  });

  it("sends nothing at all when the callback changes nothing", async () => {
    const harness = await ShimHarness.withVault(UNCHANGED_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    await harness.app.fileManager.processFrontMatter(file, (fm) => {
      expect(fm["title"]).toBe("Same");
    });
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);
  });

  it("sends a reshaped branch whole, and never a dot-path into one", async () => {
    // A dot-path into a branch that changed shape addresses a span that no
    // longer exists, and an array has no key to address an element by at all —
    // `key_path` is a path of *keys*. So both go whole.
    const harness = await ShimHarness.withVault(SHAPED_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      expect(fm).toEqual({ list: ["one", "two"], branch: { leaf: 1 }, plain: "text" });
      (fm["list"] as unknown[]).push("three");
      fm["branch"] = "flattened";
      fm["added"] = { deep: true };
    });
    const sent = await harness.nextRequest();
    expect((sent.request.params as { patch: unknown[] }).patch).toEqual([
      { key_path: ["list"], value: ["one", "two", "three"] },
      { key_path: ["branch"], value: "flattened" },
      { key_path: ["added"], value: { deep: true } },
    ]);
    harness.respondOk(sent.id, "patch_frontmatter", { generation: 2, revision: "blake3:shaped" });
    await harness.answerRefetch(2, [{ path: "A.md", revision: "blake3:shaped" }]);
    await pending;
  });

  it("writes a YAML null through set_null, and deletes only on delete", async () => {
    // Two different outcomes that both look like "null" in JavaScript, and the
    // wire needs two spellings for them: `value: null` is the deletion marker,
    // so writing `key: null` into the note takes the additive `set_null` entry.
    // Obsidian's `fm.key = null` writes the null; it does not remove the key.
    const harness = await ShimHarness.withVault(FRONTMATTER_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      fm["title"] = null;
      fm["nested"] = undefined;
    });
    const sent = await harness.nextRequest();
    expect((sent.request.params as { patch: unknown[] }).patch).toEqual([
      { key_path: ["title"], set_null: true },
      { key_path: ["nested"], value: null },
    ]);
    harness.respondOk(sent.id, "patch_frontmatter", { generation: 2, revision: "blake3:nulled" });
    await harness.answerRefetch(2, [{ path: "A.md", revision: "blake3:nulled" }]);
    await pending;
  });

  it("refuses a key containing a dot rather than writing to the wrong one", async () => {
    // The daemon build in use splits `key_path` on `.` with no escaping, so
    // `my.key` addresses `my` → `key`, finds no `my`, creates one, and leaves
    // the real key stale — measured in review. Nothing is sent and nothing is
    // written; the plugin is told which key it was.
    const harness = await ShimHarness.withVault(DOTTED_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const handed: Record<string, unknown>[] = [];
    await expect(
      harness.app.fileManager.processFrontMatter(file, (fm) => {
        handed.push({ ...fm });
        fm["my.key"] = "changed";
      }),
    ).rejects.toBeInstanceOf(UnaddressableFrontmatterKey);
    // The callback still *saw* the key: reading one has never been the problem.
    expect(handed[0]).toEqual({ "my.key": "dotted", plain: "kept" });
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);

    // A deletion is refused the same way. The old daemon treated it as "delete
    // a key that is not there", which is a no-op the plugin never hears about.
    await expect(
      harness.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm["my.key"];
      }),
    ).rejects.toMatchObject({ code: "unaddressable_frontmatter_key", path: "A.md" });
    // A neighbouring key with no dot in it is unaffected.
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      fm["plain"] = "moved";
    });
    const sent = await harness.nextRequest();
    expect((sent.request.params as { patch: unknown[] }).patch).toEqual([
      { key_path: ["plain"], value: "moved" },
    ]);
    harness.respondOk(sent.id, "patch_frontmatter", { generation: 2, revision: "blake3:plain" });
    await harness.answerRefetch(2, [{ path: "A.md", revision: "blake3:plain" }]);
    await pending;
  });

  it("refuses a number JSON cannot carry, at any depth", async () => {
    // `NaN` and `Infinity` serialize to JSON `null`, and `null` on this wire
    // means *delete this key* — so the silent outcome is a property that
    // vanishes instead of being set.
    const harness = await ShimHarness.withVault(UNCHANGED_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    await expect(
      harness.app.fileManager.processFrontMatter(file, (fm) => {
        fm["count"] = Number.NaN;
      }),
    ).rejects.toBeInstanceOf(UnrepresentableFrontmatterValue);
    await expect(
      harness.app.fileManager.processFrontMatter(file, (fm) => {
        fm["stats"] = { mean: Number.POSITIVE_INFINITY };
      }),
    ).rejects.toMatchObject({ code: "unrepresentable_frontmatter_value" });
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);
  });

  it("re-reads and re-runs the callback after a revision conflict", async () => {
    const harness = await ShimHarness.withVault(FRONTMATTER_VAULT);
    const conflicted = parseFixtureRow("A.md", CONFLICTED_SOURCE);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const seen: unknown[] = [];
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      seen.push(fm["title"]);
      fm["title"] = "New";
    });

    const first = await harness.expectRequest("patch_frontmatter");
    expect((first.request.params as { expected: unknown }).expected).toEqual({
      revision: harness.revisionOf("A.md"),
    });
    harness.respondErr(first.id, {
      code: "revision_conflict",
      message: "somebody else wrote A.md",
      current_revision: conflicted.revision,
    });
    // The refresh: the shim asks the mirror for the row as it is now, because
    // an edit computed from bytes that no longer exist is the lost update the
    // precondition exists to prevent.
    await harness.answerRefetch(5, [asFixtureNote(conflicted)]);

    const second = await harness.expectRequest("patch_frontmatter");
    expect(second.request.params).toEqual({
      path: "A.md",
      patch: [{ key_path: ["title"], value: "New" }],
      expected: { revision: conflicted.revision },
    });
    harness.respondOk(second.id, "patch_frontmatter", { generation: 6, revision: "blake3:after" });
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:after" }]);
    await pending;
    // The callback ran against the *new* bytes the second time, not the stale
    // object it was handed first.
    expect(seen).toEqual(["Old", "Other"]);
  });

  it("gives up after three attempts and hands the plugin the typed error", async () => {
    const harness = await ShimHarness.withVault(FRONTMATTER_VAULT);
    const conflicted = parseFixtureRow("A.md", CONFLICTED_SOURCE);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    let attempts = 0;
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      attempts += 1;
      fm["title"] = "New";
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const request = await harness.expectRequest("patch_frontmatter");
      harness.respondErr(request.id, {
        code: "revision_conflict",
        message: "somebody else wrote A.md again",
        current_revision: conflicted.revision,
      });
      // The last attempt throws rather than refreshing: there is nothing left
      // to retry with.
      if (attempt < 3) await harness.answerRefetch(5 + attempt, [asFixtureNote(conflicted)]);
    }
    await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
    expect(attempts).toBe(3);
  });
});

describe("FileManager.renameFile", () => {
  it("routes a note to rename_note, with no precondition and link rewriting on", async () => {
    // The brief's fixture wrote `A` as bare prose, which is no link at all: the
    // mirror's backlink index would have been empty and the case would have
    // proved nothing about the referrer set. A real wikilink makes it answer.
    const harness = await ShimHarness.withVault(ONE_REFERRER_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const pending = harness.app.fileManager.renameFile(file, "Renamed.md");
    const sent = await harness.nextRequest();
    // No `expected`. Obsidian's `renameFile` has no compare-and-swap failure
    // mode, the mirror's revision lags the filesystem by a watcher round trip,
    // and a move does not depend on the bytes being moved — so a precondition
    // here refused a rename whenever anything had touched the note a moment
    // earlier. `Vault.rename` sends none either.
    expect(sent.request).toEqual({
      method: "rename_note",
      params: { from: "A.md", to: "Renamed.md", rewrite_links: true },
    });
    harness.respondOk(sent.id, "rename_note", {
      generation: 5,
      revision: "blake3:r",
      links_rewritten: 1,
      link_rewrite_failures: [],
    });
    // The refetch set is `from`, `to`, and every path the mirror knew was
    // linking to `from` BEFORE the rename — here `B.md`, whose `[[A]]` the
    // daemon rewrote. `links_rewritten: 1` names no path, so the list comes
    // from the mirror's backlink index rather than from the response.
    const refetching = harness.answerRefetch(
      5,
      [
        { path: "Renamed.md", revision: "blake3:r" },
        { path: "B.md", revision: "blake3:b2" },
      ],
      { absent: ["A.md"] },
    );
    await pending;
    expect([...(await refetching)].sort()).toEqual(["A.md", "B.md", "Renamed.md"]);
    expect(harness.mirror.note("B.md")?.revision).toBe("blake3:b2");
    expect(harness.mirror.entry("A.md")).toBeUndefined();
    expect(harness.app.fileManager.lastRenameFailures()).toEqual([]);
  });

  it("refetches the referrers a failed rewrite names, and the ones it does not", async () => {
    const harness = await ShimHarness.withVault(TWO_REFERRERS_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const pending = harness.app.fileManager.renameFile(file, "Renamed.md");
    const sent = await harness.expectRequest("rename_note");
    harness.respondOk(sent.id, "rename_note", {
      generation: 6,
      revision: "blake3:r",
      links_rewritten: 1,
      // Failures carry paths; successes carry only a count. Both referrers must
      // still be refetched, because the mirror cannot tell from the response
      // which of the two the count referred to — and "the daemon could not
      // rewrite Busy.md" and "Busy.md is unchanged" are the same statement only
      // if nothing else touched it.
      link_rewrite_failures: [{ path: "Busy.md", reason: "revision_conflict" }],
    });
    const refetching = harness.answerRefetch(
      6,
      [
        { path: "Renamed.md", revision: "blake3:r" },
        { path: "B.md", revision: "blake3:b2" },
        { path: "Busy.md", revision: "blake3:busy1" },
      ],
      { absent: ["A.md"] },
    );
    await pending;
    expect([...(await refetching)].sort()).toEqual(["A.md", "B.md", "Busy.md", "Renamed.md"]);
    // Surfaced, not swallowed: a caller that cares can read it.
    expect(harness.app.fileManager.lastRenameFailures()).toEqual([
      { path: "Busy.md", reason: "revision_conflict" },
    ]);
  });

  it("captures the referrers before the rename, not after it", async () => {
    // The mechanism the whole refetch set rests on, and the one a mutation
    // survived until this case existed: `mirror.backlinks(from)` is read at the
    // call, before anything has moved. Here the mirror learns that `B.md` no
    // longer links to `A.md` **while the rename is in flight** — which is
    // exactly what happens when the daemon's own rewrite reaches this host
    // before the rename's answer does. A shim that asked afterwards would find
    // no referrers and leave `B.md` stale for good.
    const harness = await ShimHarness.withVault(ONE_REFERRER_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    expect(harness.mirror.backlinks("A.md").map((reference) => reference.source_path)).toEqual([
      "B.md",
    ]);
    const pending = harness.app.fileManager.renameFile(file, "Renamed.md");
    const sent = await harness.expectRequest("rename_note");

    // The link is gone from the mirror's index before the response is handled.
    const applying = harness.mirror.applyMutation(4, ["B.md"]);
    await harness.answerRefetch(4, [{ path: "B.md", revision: "blake3:b-rewritten" }]);
    await applying;
    expect(harness.mirror.backlinks("A.md")).toEqual([]);

    harness.respondOk(sent.id, "rename_note", {
      generation: 5,
      revision: "blake3:r",
      links_rewritten: 1,
      link_rewrite_failures: [],
    });
    const refetching = harness.answerRefetch(
      5,
      [
        { path: "Renamed.md", revision: "blake3:r" },
        { path: "B.md", revision: "blake3:b3" },
      ],
      { absent: ["A.md"] },
    );
    await pending;
    expect([...(await refetching)].sort()).toEqual(["A.md", "B.md", "Renamed.md"]);
  });

  it("routes a folder to rename_folder, with no expected and the whole subtree", async () => {
    // `docs/protocol.md`: the folder operations reject `expected` with
    // `invalid_request`, because a folder has no bytes and therefore no
    // revision. The subtree expansion is Vault's, reused rather than rewritten.
    const harness = await ShimHarness.withVault(FOLDER_VAULT);
    const folder = harness.vault.getFolderByPath("Folder") as TFolder;
    const pending = harness.app.fileManager.renameFile(folder, "Moved");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "rename_folder",
      params: { from: "Folder", to: "Moved", rewrite_links: true },
    });
    harness.respondOk(sent.id, "rename_folder", {
      generation: 7,
      links_rewritten: 1,
      link_rewrite_failures: [],
    });
    const refetching = harness.answerRefetch(
      7,
      [
        { path: "Moved/A.md", revision: "blake3:moved" },
        { path: "Outside.md", revision: "blake3:outside2" },
      ],
      { entries: [{ path: "Moved", kind: "folder" }], absent: ["Folder", "Folder/A.md"] },
    );
    await pending;
    // Both ends of the move, every row under both ends, and the referrer of a
    // note inside the folder — which the wire named nowhere.
    expect([...(await refetching)].sort()).toEqual([
      "Folder",
      "Folder/A.md",
      "Moved",
      "Moved/A.md",
      "Outside.md",
    ]);
  });
});

describe("FileManager.generateMarkdownLink", () => {
  it("composes the shortest wikilink, and the folder-qualified one on ambiguity", async () => {
    const harness = await ShimHarness.withVault(LINK_VAULT);
    const fm = harness.app.fileManager;
    const solo = harness.vault.getFileByPath("Solo.md") as TFile;
    const target = harness.vault.getFileByPath("Folder/Target.md") as TFile;
    expect(fm.generateMarkdownLink(solo, "Folder/Source.md")).toBe("[[Solo]]");
    // From `Folder/`, the bare name reaches this very file — Obsidian resolves a
    // bare name to the one closest to the source — so the bare name is honest.
    expect(fm.generateMarkdownLink(target, "Folder/Source.md")).toBe("[[Target]]");
    // From `Other/`, it reaches `Other/Target.md` instead, so the shortest form
    // that still reaches this file is the folder-qualified one. (The brief
    // expected the qualified form from `Folder/Source.md`, where it does not
    // apply.)
    expect(fm.generateMarkdownLink(target, "Other/Note.md")).toBe("[[Folder/Target]]");
    expect(fm.generateMarkdownLink(solo, "Folder/Source.md", "#Heading", "Alias")).toBe(
      "[[Solo#Heading|Alias]]",
    );
    expect(fm.generateMarkdownLink(solo, "Folder/Source.md", undefined, "Alias")).toBe(
      "[[Solo|Alias]]",
    );
  });

  it("spells a link the way newLinkFormat asks: relative", async () => {
    const harness = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ newLinkFormat: "relative" }) },
    });
    const fm = harness.app.fileManager;
    expect(
      fm.generateMarkdownLink(harness.vault.getFileByPath("Solo.md") as TFile, "Folder/Source.md"),
    ).toBe("[[../Solo]]");
    expect(
      fm.generateMarkdownLink(
        harness.vault.getFileByPath("Folder/Target.md") as TFile,
        "Folder/Source.md",
      ),
    ).toBe("[[Target]]");
    expect(
      fm.generateMarkdownLink(
        harness.vault.getFileByPath("Other/Target.md") as TFile,
        "Folder/Source.md",
      ),
    ).toBe("[[../Other/Target]]");
  });

  it("spells a link the way newLinkFormat asks: absolute", async () => {
    const harness = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ newLinkFormat: "absolute" }) },
    });
    const fm = harness.app.fileManager;
    // The vault path, whatever the source note is and whatever else shares the
    // name — that is what "absolute" asks for.
    expect(
      fm.generateMarkdownLink(
        harness.vault.getFileByPath("Folder/Target.md") as TFile,
        "Folder/Source.md",
      ),
    ).toBe("[[Folder/Target]]");
    expect(
      fm.generateMarkdownLink(harness.vault.getFileByPath("Solo.md") as TFile, "Folder/Source.md"),
    ).toBe("[[Solo]]");
  });

  it("composes a Markdown link when useMarkdownLinks is on, extension and all", async () => {
    const harness = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ useMarkdownLinks: true }) },
    });
    const fm = harness.app.fileManager;
    expect(
      fm.generateMarkdownLink(harness.vault.getFileByPath("Solo.md") as TFile, "Folder/Source.md"),
    ).toBe("[Solo](Solo.md)");
    // A Markdown destination is a URL: the space is percent-encoded, and the
    // display text is not.
    expect(
      fm.generateMarkdownLink(
        harness.vault.getFileByPath("My File.md") as TFile,
        "Folder/Source.md",
      ),
    ).toBe("[My File](My%20File.md)");
    expect(
      fm.generateMarkdownLink(
        harness.vault.getFileByPath("Solo.md") as TFile,
        "Folder/Source.md",
        undefined,
        "Alias",
      ),
    ).toBe("[Alias](Solo.md)");
  });

  it("encodes the subpath and the delimiters a vault path may contain", async () => {
    // Measured against this repo's own parser, which is the thing that has to
    // read the result: `Solo.md#My Heading` is unresolved and `Hash %231.md`
    // written as `Hash #1.md` is not a link at all, because `encodeURI` leaves
    // `#` and a space in a fragment alone. `shim-real-daemon.test.ts` proves
    // the encoded forms resolve; this case pins the spelling.
    const harness = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ useMarkdownLinks: true }) },
    });
    const fm = harness.app.fileManager;
    const solo = harness.vault.getFileByPath("Solo.md") as TFile;
    expect(fm.generateMarkdownLink(solo, "Folder/Source.md", "#My Heading")).toBe(
      "[Solo](Solo.md#My%20Heading)",
    );
    expect(fm.generateMarkdownLink(harness.vault.getFileByPath("Hash #1.md") as TFile, "Solo.md")).toBe(
      "[Hash #1](Hash%20%231.md)",
    );
    // The block marker stays literal: `%5E` decodes back to `^` but vaultd then
    // reads the subpath as a heading named `^blockid` and answers
    // `missing_subpath`, where the plain caret resolves as a block.
    expect(fm.generateMarkdownLink(solo, "Folder/Source.md", "#^blockid")).toBe(
      "[Solo](Solo.md#^blockid)",
    );
    // A wikilink is not a URL and is encoded nowhere.
    const plain = await ShimHarness.withVault(LINK_VAULT);
    expect(
      plain.app.fileManager.generateMarkdownLink(
        plain.vault.getFileByPath("Hash #1.md") as TFile,
        "Solo.md",
        "#My Heading",
      ),
    ).toBe("[[Hash #1#My Heading]]");
  });
});

describe("FileManager: the rest of the surface", () => {
  it("puts a new file where newFileLocation says, and in the root by default", async () => {
    const plain = await ShimHarness.withVault(LINK_VAULT);
    expect(plain.app.fileManager.getNewFileParent("Folder/Source.md").isRoot()).toBe(true);

    const current = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ newFileLocation: "current" }) },
    });
    expect(current.app.fileManager.getNewFileParent("Folder/Source.md").path).toBe("Folder");

    const folder = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: {
        ".obsidian/app.json": JSON.stringify({
          newFileLocation: "folder",
          newFileFolderPath: "Other",
        }),
      },
    });
    expect(folder.app.fileManager.getNewFileParent("Folder/Source.md").path).toBe("Other");

    const missing = await ShimHarness.withVault(LINK_VAULT, {
      configFiles: {
        ".obsidian/app.json": JSON.stringify({
          newFileLocation: "folder",
          newFileFolderPath: "Nowhere",
        }),
      },
    });
    // A configured folder that is not there falls back to the root rather than
    // inventing a folder nothing holds.
    expect(missing.app.fileManager.getNewFileParent("Folder/Source.md").isRoot()).toBe(true);
    // An explicit destination wins over the preference: the caller already said
    // where the file goes.
    expect(plain.app.fileManager.getNewFileParent("Folder/Source.md", "Other/New.md").path).toBe(
      "Other",
    );
  });

  it("suffixes an attachment path on collision, in Obsidian's spelling", async () => {
    const harness = await ShimHarness.withVault(ATTACHMENT_VAULT, {
      configFiles: {
        ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Attachments" }),
      },
    });
    const fm = harness.app.fileManager;
    expect(await fm.getAvailablePathForAttachment("fresh.png", "Notes/Note.md")).toBe(
      "Attachments/fresh.png",
    );
    // ` 1` before the extension, not after it.
    expect(await fm.getAvailablePathForAttachment("img.png", "Notes/Note.md")).toBe(
      "Attachments/img 1.png",
    );
  });

  it("reads a ./ attachment folder as relative to the note being written", async () => {
    const harness = await ShimHarness.withVault(ATTACHMENT_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "./assets" }) },
    });
    expect(
      await harness.app.fileManager.getAvailablePathForAttachment("img.png", "Notes/Note.md"),
    ).toBe("Notes/assets/img.png");
    // No source note to be relative to: the subfolder lands under the root.
    expect(await harness.app.fileManager.getAvailablePathForAttachment("img.png")).toBe(
      "assets/img.png",
    );
  });

  it("trashes through the user's trashOption, which is the one place it is read", async () => {
    const local = await ShimHarness.withVault(TRASH_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ trashOption: "local" }) },
    });
    void local.app.fileManager.trashFile(local.vault.getFileByPath("A.md") as TFile);
    const sent = await local.nextRequest();
    // No `expected`: a delete that failed because somebody edited the file
    // first is not a reason to keep a file the user asked to remove, and
    // `Vault.trash` sends none either.
    expect(sent.request).toEqual({
      method: "delete_note",
      params: { path: "A.md", mode: "trash_local" },
    });

    // Obsidian's own default when the setting is missing.
    const fallback = await ShimHarness.withVault(TRASH_VAULT);
    void fallback.app.fileManager.trashFile(fallback.vault.getFileByPath("A.md") as TFile);
    expect(((await fallback.nextRequest()).request.params as { mode: string }).mode).toBe(
      "trash_system",
    );

    const none = await ShimHarness.withVault(TRASH_VAULT, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ trashOption: "none" }) },
    });
    void none.app.fileManager.trashFile(none.vault.getFolderByPath("Folder") as TFolder);
    expect((await none.nextRequest()).request).toEqual({
      method: "delete_folder",
      params: { path: "Folder", mode: "permanent", recursive: true },
    });
  });

  it("creates an untitled folder, and numbers it past what is already there", async () => {
    const harness = await ShimHarness.withVault(UNTITLED_VAULT);
    const pending = harness.app.fileManager.createNewFolder(harness.vault.getRoot());
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({ method: "create_folder", params: { path: "Untitled 1" } });
    harness.respondOk(sent.id, "create_folder", { generation: 2 });
    await harness.answerRefetch(2, [], { entries: [{ path: "Untitled 1", kind: "folder" }] });
    expect((await pending).path).toBe("Untitled 1");
  });

  it("resolves promptForDeletion false with no handler, and deletes nothing", async () => {
    const harness = await ShimHarness.withVault(TRASH_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    // Real API, real signature: `Promise<boolean>`, public since 0.15.0.
    await expect(harness.app.fileManager.promptForDeletion(file)).resolves.toBe(false);
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);
    expect(harness.vault.getFileByPath("A.md")).not.toBeNull();
    // The report has to be able to say the plugin asked.
    expect(
      harness.policyRecorder.entries().find((e) => e.symbol === "FileManager.promptForDeletion")
        ?.policy,
    ).toBe("safe_stub");
  });

  it("brokers a confirm when a handler is attached, and deletes on yes", async () => {
    const harness = await ShimHarness.withVault(TRASH_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const asked: string[] = [];
    harness.app.fileManager.setConfirmBroker({
      confirm: (request) => {
        asked.push(request.path);
        return Promise.resolve(true);
      },
    });
    const pending = harness.app.fileManager.promptForDeletion(file);
    const sent = await harness.expectRequest("delete_note");
    expect((sent.request.params as { mode: string }).mode).toBe("trash_system");
    harness.respondOk(sent.id, "delete_note", { generation: 3 });
    await harness.answerRefetch(3, [], { absent: ["A.md"] });
    await expect(pending).resolves.toBe(true);
    expect(asked).toEqual(["A.md"]);

    // And on no: answered, and nothing sent.
    const second = harness.vault.getFileByPath("Folder/B.md") as TFile;
    harness.app.fileManager.setConfirmBroker({ confirm: () => Promise.resolve(false) });
    await expect(harness.app.fileManager.promptForDeletion(second)).resolves.toBe(false);
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);
  });

  it("throws HeadlessUnsupported for the two undocumented prompt entry points", async () => {
    const harness = await ShimHarness.withVault(TRASH_VAULT);
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const folder = harness.vault.getRoot();
    await expect(harness.app.fileManager.promptForFileRename(file)).rejects.toBeInstanceOf(
      HeadlessUnsupported,
    );
    await expect(harness.app.fileManager.promptForFolderDeletion(folder)).rejects.toBeInstanceOf(
      HeadlessUnsupported,
    );
    await harness.app.fileManager.promptForFileRename(file).catch((error: HeadlessUnsupported) => {
      expect(error.symbol).toBe("FileManager.promptForFileRename");
      expect(error.pluginId).toBeNull();
    });
    await harness.quiesce();
    expect(harness.pendingRequests()).toHaveLength(0);
  });
});

/** A parsed row as the refetch answer wants it. */
function asFixtureNote(row: MirrorNoteRow): FixtureNote {
  return {
    path: row.path,
    revision: row.revision,
    properties: [...row.properties],
    aliases: [...row.aliases],
    headings: [...row.headings],
    blocks: [...row.blocks],
    tags: [...row.tags],
    sections: [...row.sections],
    listItems: [...row.listItems],
    outgoing: [...row.outgoing],
  };
}
