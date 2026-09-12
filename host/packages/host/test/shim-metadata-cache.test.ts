import { describe, expect, it } from "vitest";

import { declaredSymbols, policyOf } from "../src/shim/policy";
import { parseFixtureRow } from "../src/testing/fixture-vault";
import { ShimHarness } from "../src/testing/shim-harness";
import type { FixtureNote } from "../src/testing/mirror-harness";
import type { CachedMetadata } from "../src/mirror/metadata";
import type { TFile } from "../src/shim/files";

/**
 * The `MetadataCache` facade over a hydrated mirror.
 *
 * Three of the brief's cases were written against fixtures that could not
 * exercise what the case claimed, and are corrected here rather than passed
 * vacuously — each correction is noted at the case. The fourth, the `changed`
 * event, is driven through the sequencer seam because subscribing this surface
 * to `Mirror.onBatch` is Task 15's job and doing it here would give one batch
 * two event streams.
 */
describe("MetadataCache", () => {
  it("answers the three undocumented methods tag-wrangler needs", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "---\ntags: [alpha, beta]\naliases: [Ay]\n---\n#gamma\n",
      "B.md": "#alpha\n",
    });
    const cache = harness.app.metadataCache;
    expect(cache.getCachedFiles().sort()).toEqual(["A.md", "B.md"]);
    expect(cache.getCache("A.md")?.frontmatter).toMatchObject({ tags: ["alpha", "beta"] });
    expect(cache.getCache("missing.md")).toBeNull();
    // Frontmatter tags count too: a note tagged only through `tags:` is not an
    // untagged note, and Obsidian's own tag pane counts it.
    expect(cache.getTags()).toEqual({ "#alpha": 2, "#beta": 1, "#gamma": 1 });
  });

  it("returns null before a note's position index is warm and the cache after", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# Title\n" }, { warm: false });
    const file = harness.vault.getFileByPath("A.md");
    expect(file).not.toBeNull();
    expect(harness.app.metadataCache.getFileCache(file as TFile)).toBeNull();
    await harness.mirror.warmPositions();
    expect(harness.app.metadataCache.getFileCache(file as TFile)?.headings?.[0]?.heading).toBe(
      "Title",
    );
  });

  it("memoizes per revision and hands back the same object", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# Title\n" });
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const first = harness.app.metadataCache.getFileCache(file);
    expect(first).not.toBeNull();
    expect(harness.app.metadataCache.getFileCache(file)).toBe(first);
    expect(harness.app.metadataCache.getCache("A.md")).toBe(first);
  });

  it("resolves a linkpath through vaultd resolution, not a filename guess", async () => {
    // The brief's fixture wrote `Target` as bare prose, which is no link at all
    // — the case would have passed on the name-search fallback and proved
    // nothing about resolution. A real wikilink makes the daemon answer:
    // `[[Target]]` from `Folder/Source.md` is genuinely ambiguous between the
    // two `Target.md` files, the daemon reports both candidates in its own
    // order, and `firstLinkpathDest` takes that answer rather than re-deciding.
    const harness = await ShimHarness.withVault({
      "Folder/Target.md": "body\n",
      "Other/Target.md": "body\n",
      "Folder/Source.md": "[[Target]]\n",
    });
    const dest = harness.app.metadataCache.getFirstLinkpathDest("Target", "Folder/Source.md");
    expect(dest?.path).toBe("Folder/Target.md");
    expect(harness.app.metadataCache.getFirstLinkpathDest("Nope", "Folder/Source.md")).toBeNull();
  });

  it("shortens a link text only when the bare name still reaches the file", async () => {
    const harness = await ShimHarness.withVault({
      "Folder/Target.md": "body\n",
      "Other/Target.md": "body\n",
      "Unique.md": "body\n",
    });
    const cache = harness.app.metadataCache;
    const unique = harness.vault.getFileByPath("Unique.md") as TFile;
    expect(cache.fileToLinktext(unique, "Folder/Target.md")).toBe("Unique");
    // Two files share the name, and from `Other/` the bare name reaches the
    // other one — so the full path is the only honest link text.
    const target = harness.vault.getFileByPath("Folder/Target.md") as TFile;
    expect(cache.fileToLinktext(target, "Other/Source.md")).toBe("Folder/Target");
    expect(cache.fileToLinktext(unique, "Folder/Target.md", false)).toBe("Unique.md");
  });

  it("exposes resolvedLinks, unresolvedLinks, and backlinks from the mirror", async () => {
    // The brief's `"A.md": "B and Ghost\n"` contains no links, so nothing could
    // have landed in either table. Written as links, it does.
    const harness = await ShimHarness.withVault({
      "A.md": "[[B]] and [[Ghost]]\n",
      "B.md": "body\n",
    });
    const cache = harness.app.metadataCache;
    expect(cache.resolvedLinks["A.md"]).toEqual({ "B.md": 1 });
    expect(cache.unresolvedLinks["A.md"]).toEqual({ Ghost: 1 });
    const backlinks = cache.getBacklinksForFile(harness.vault.getFileByPath("B.md") as TFile);
    expect(backlinks.keys()).toEqual(["A.md"]);
    expect(backlinks.get("A.md")).toHaveLength(1);
    expect(backlinks.count()).toBe(1);
    expect(backlinks.get("A.md")?.[0]).toMatchObject({ link: "B", original: "[[B]]" });
    // The position is the referring note's, converted through its own index.
    expect(backlinks.get("A.md")?.[0]?.position.start.offset).toBe(0);
    expect(backlinks.get("missing.md")).toBeNull();
  });

  it("fires changed with file, data, and cache in Obsidian's argument order", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# One\n" });
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const seen: Array<[string, string, string | undefined]> = [];
    harness.app.metadataCache.on("changed", (...args) => {
      const [changed, data, cache] = args as unknown as [TFile, string, CachedMetadata | null];
      seen.push([changed.path, data, cache?.headings?.[0]?.heading]);
    });

    // A real write, answered with a really-parsed row, so the mirror holds the
    // new heading and a position index rebuilt from the new bytes. The harness's
    // own `writeNote` helper answers the refetch with an empty row, which would
    // have made the cache assertion below pass on `undefined`.
    const row = parseFixtureRow("A.md", "# Two\n");
    const writing = harness.vault.adapter.write("A.md", "# Two\n");
    const request = await harness.expectRequest("write_note");
    harness.respondOk(request.id, "write_note", { generation: 2, revision: row.revision });
    harness.setFileContent("A.md", "# Two\n");
    await harness.answerRefetch(2, [asFixtureNote(row)]);
    await writing;

    // The seam Task 15's lifecycle sequencer calls. It is not wired to
    // `Mirror.onBatch` here on purpose: one batch must produce one ordered run
    // of events, and that ordering is the sequencer's to own.
    harness.app.metadataCache.notifyChanged(file, "# Two\n");
    expect(seen).toEqual([["A.md", "# Two\n", "Two"]]);
  });

  it("declares its own surface, and the three fields vaultd does not parse", async () => {
    await ShimHarness.withVault({ "A.md": "# One\n" });
    const declared = declaredSymbols();
    expect(declared).toContain("MetadataCache.getFileCache");
    expect(declared).toContain("MetadataCache.getBacklinksForFile");
    expect(policyOf("MetadataCache.getCachedFiles")).toBe("implemented");
    // Absent with policy, not forgotten: the compatibility report has to be
    // able to say the footnote gap exists.
    expect(policyOf("CachedMetadata.footnotes")).toBe("absent");
    expect(policyOf("CachedMetadata.footnoteRefs")).toBe("absent");
    expect(policyOf("CachedMetadata.referenceLinks")).toBe("absent");
  });

  it("carries the last known cache into deleted and then forgets it", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# One\n" });
    const file = harness.vault.getFileByPath("A.md") as TFile;
    const before = harness.app.metadataCache.getFileCache(file);
    const seen: Array<CachedMetadata | null> = [];
    harness.app.metadataCache.on("deleted", (...args) => {
      seen.push((args as unknown as [TFile, CachedMetadata | null])[1]);
    });
    harness.app.metadataCache.notifyDeleted(file);
    expect(seen).toEqual([before]);
    // Fired twice, the second carries nothing: the memo is gone.
    harness.app.metadataCache.notifyDeleted(file);
    expect(seen[1]).toBeNull();
  });
});

/** A parsed row as the refetch answer wants it. */
function asFixtureNote(row: ReturnType<typeof parseFixtureRow>): FixtureNote {
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
