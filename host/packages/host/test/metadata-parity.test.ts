import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { CachedMetadataError, buildCachedMetadata } from "../src/mirror/metadata";
import { buildPositionIndex } from "../src/mirror/positions";
import { parseFixtureRow } from "../src/testing/fixture-vault";
import type { CachedMetadata, ReferenceCache, SectionCache } from "../src/mirror/metadata";
import type { MirrorNoteRow } from "../src/mirror/types";
import type { PositionIndex } from "../src/mirror/positions";

/**
 * `buildCachedMetadata` against eighteen `CachedMetadata` objects captured from
 * a live stock Obsidian 1.13.4, driven by rows the **real `vaultd` parser**
 * produced. Both halves matter: a parity test fed hand-written rows compares one
 * person's idea of the parse against another's and agrees with itself whatever
 * the daemon does, so `parseFixtureRow` runs Task 6b's `fixture-row` binary and
 * this file compares vaultd's semantics through the shim against Obsidian's own
 * answer.
 *
 * It is data-driven over the capture directory, so a new fixture needs no new
 * test code.
 *
 * ## The corpus is exact, and it did not start that way
 *
 * All eighteen fixtures now match field for field. The first parity run found
 * four places where `vault-core` parsed a note differently from Obsidian — a
 * standalone `^id` line not folded onto a preceding heading, Markdown links
 * inside property values never scanned, nested **ordered** list item spans one
 * byte early, and a tag character class that admitted no Unicode symbol. None
 * was a compatibility *divergence*: Tier 1's contract is "match documented
 * Obsidian behavior", and the four divergences `VAULTD-COMPATIBILITY.md`
 * records are all things `vaultd` does not model at all, while these were
 * things it modelled and got wrong. So they were carried here as known-failing
 * expectations until `vault-core` 734f500 fixed all four, and this file went
 * back to one exact comparison per fixture.
 *
 * Two things that bought, worth keeping in mind before anyone loosens a
 * comparison again. A test that edits the capture into the daemon's shape —
 * which is what the first draft of this file did — passes, and retires the
 * defect. And the fixture cache key names the generator binary, so a parser fix
 * invalidates every cached row rather than leaving these cases comparing
 * against the answer that was wrong.
 */
const dir = join(__dirname, "..", "..", "..", "fixtures", "metadata-parity");
const cases = readdirSync(dir)
  .filter((name) => name.endsWith(".expected.json"))
  .map((name) => name.replace(".expected.json", ""));

// The three fields vaultd does not parse. Declared absent-with-policy in the
// shim, so the comparison drops them from Obsidian's side rather than
// pretending they matched — and the assertion below proves the fixture corpus
// actually contains at least one note that has them, so this is a measured gap
// and not a blanket excuse.
const UNSERVED = ["footnotes", "footnoteRefs", "referenceLinks"] as const;
const without = (cache: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...cache };
  for (const key of UNSERVED) delete copy[key];
  return copy;
};

/**
 * Obsidian emits **zero-width phantom sections** at end of file — `parity-footnotes`
 * carries a `text` and an `element`, both at line 5, whose start offset equals
 * their end offset. `vaultd` emits no such section, which is Tier 1 divergence
 * two in `VAULTD-COMPATIBILITY.md` and what the capture README means by
 * "comparisons filter zero-width sections". Dropping them from Obsidian's side
 * is the documented allowance; inventing them in `buildCachedMetadata` would be
 * fabricating a shape the daemon never reported.
 *
 * Returns the count it removed, so the corpus-wide filter can be held to the
 * same non-vacuity discipline as everything else here: it must fire exactly
 * where the corpus says it should, and nowhere else, or it could quietly start
 * masking a section `vaultd` simply failed to report.
 */
const PHANTOM_SECTIONS: Readonly<Record<string, number>> = { "parity-footnotes": 2 };

function withoutPhantomSections(cache: Record<string, unknown>): {
  cache: Record<string, unknown>;
  removed: number;
} {
  const sections = cache.sections;
  if (!Array.isArray(sections)) return { cache, removed: 0 };
  const kept = (sections as SectionCache[]).filter(
    (section) => section.position.start.offset !== section.position.end.offset,
  );
  return { cache: { ...cache, sections: kept }, removed: sections.length - kept.length };
}

/** The row and the index a case drives the assembler with. */
function parseCase(name: string): { row: MirrorNoteRow; positions: PositionIndex } {
  const source = readFileSync(join(dir, `${name}.md`), "utf8");
  const row = parseFixtureRow(`${name}.md`, source);
  return {
    row,
    positions: buildPositionIndex(
      source,
      row.outgoing.map((reference) => reference.span),
    ),
  };
}

function build(name: string): Record<string, unknown> {
  const { row, positions } = parseCase(name);
  return JSON.parse(JSON.stringify(buildCachedMetadata(row, positions))) as Record<string, unknown>;
}

function captured(name: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
    obsidianVersion: string;
    cache: Record<string, unknown>;
  };
  return withoutPhantomSections(without(parsed.cache)).cache;
}

/**
 * Read every fixture once, before the first case, from a cache the pre-test
 * warm-up has already filled.
 *
 * `host/scripts/warm-fixtures.js` runs as npm's `pretest`, so by the time vitest
 * starts, all eighteen rows exist and this hook is a series of file reads. The
 * budget is therefore five minutes rather than the fifteen it carried while the
 * regeneration happened here — and five minutes now means "something is wrong",
 * not "the machine is busy".
 *
 * Regenerating inside this hook was the old shape and it failed badly: a cold
 * standalone run took 1188 s, blew a 900 s hook budget, and reported `28
 * skipped` — a parity suite failing with no failing assertion. Raising the
 * number again would only move it. If this hook ever does go slow, the cache is
 * cold and the warm-up did not run; the message below says so.
 */
beforeAll(() => {
  for (const name of cases) {
    try {
      parseCase(name);
    } catch (error) {
      throw new Error(
        `${name} is not in the fixture cache and could not be generated: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Run \`node host/scripts/warm-fixtures.js\` (npm's pretest does this ` +
          `automatically) — it rebuilds the generator and refills the corpus ` +
          `outside any test timeout.`,
      );
    }
  }
}, 300_000);

describe("CachedMetadata parity", () => {
  it("covers every captured fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    expect(cases).toContain("parity-frontmatter-links");
    expect(cases).toContain("parity-sections");
    expect(cases).toContain("parity-list-flat");
    expect(cases).toContain("parity-list-tasks");
    expect(cases).toContain("parity-footnotes");
    expect(cases).toContain("parity-wide-offsets");
  });

  it("measures the unserved fields rather than assuming they are always empty", () => {
    const parsed = JSON.parse(
      readFileSync(join(dir, "parity-footnotes.expected.json"), "utf8"),
    ) as { cache: Record<string, unknown> };
    // If this fails, the footnote fixture does not actually exercise the gap
    // and UNSERVED is hiding nothing — fix the fixture, not this test.
    expect(UNSERVED.some((key) => parsed.cache[key] !== undefined)).toBe(true);
  });

  it("drops zero-width sections only where the corpus has them", () => {
    const removedBy: Record<string, number> = {};
    for (const name of cases) {
      const parsed = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
        cache: Record<string, unknown>;
      };
      const { removed } = withoutPhantomSections(parsed.cache);
      if (removed > 0) removedBy[name] = removed;
    }
    // A filter that started firing somewhere new would be masking a section
    // vaultd failed to report, which is the opposite of what it is for.
    expect(removedBy).toEqual(PHANTOM_SECTIONS);
  });

  for (const name of cases) {
    it(`matches real Obsidian for ${name}`, () => {
      expect(build(name)).toEqual(captured(name));
    });
  }

  it("gives every reference an original that is exactly its own source span", () => {
    // `original` is what a plugin searches the note body for, so a value one
    // character short is a find-and-replace that hits the wrong text. The span
    // is the daemon's and is right; this asserts the slice is the span's own
    // width in the units `position` is measured in.
    //
    // **This is a forward invariant, not B2's protection**, and the difference
    // matters. Every one of the twenty-one references in this corpus is a plain
    // `[[link]]`, `[text](target)` or embed, and all of those reconstruct
    // exactly — so restoring the old reconstruction leaves this guard green
    // (measured: it did). What actually catches the defect is
    // `AWKWARD_LINKS_VAULT` in `shim-metadata-cache.test.ts` — a link title, an
    // angle-bracket target and an empty alias, none of which the corpus holds —
    // together with the "refuses to guess" case below. Keep this one because it
    // catches a *future* fixture whose `original` and span disagree, which the
    // awkward-link cases cannot see; do not mistake it for the thing standing
    // between a plugin and a wrong find-and-replace.
    let checked = 0;
    for (const name of cases) {
      const built = build(name) as { links?: ReferenceCache[]; embeds?: ReferenceCache[] };
      for (const entry of [...(built.links ?? []), ...(built.embeds ?? [])]) {
        expect(entry.original.length).toBe(
          entry.position.end.offset - entry.position.start.offset,
        );
        checked += 1;
      }
    }
    // Non-vacuity, at the corpus's exact total rather than under it. Removing a
    // link from any fixture reds this line rather than quietly shrinking what
    // the guard covers — which is the point: the corpus changing is a decision,
    // and this makes it a conscious one.
    expect(checked).toBe(21);
  });

  it("emits frontmatter links with no position field", () => {
    const { row, positions } = parseCase("parity-frontmatter-links");
    const built = buildCachedMetadata(row, positions);
    expect(built.frontmatterLinks?.length).toBeGreaterThan(0);
    for (const entry of built.frontmatterLinks ?? []) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.displayText === undefined
          ? ["key", "link", "original"]
          : ["displayText", "key", "link", "original"],
      );
    }
  });

  it("numbers a frontmatter list element and leaves a scalar bare", () => {
    const { row, positions } = parseCase("parity-frontmatter-links");
    const built = buildCachedMetadata(row, positions);
    // Both list elements and the scalar: `related.1` is the Markdown link, which
    // is where the W2 derivation has to descend into a sequence rather than stop
    // at the property's own key.
    expect(built.frontmatterLinks?.map((entry) => entry.key)).toEqual([
      "related.0",
      "related.1",
      "single",
    ]);
    expect(built.frontmatterLinks?.map((entry) => entry.link)).toEqual([
      "Parity target",
      "Parity target.md",
      "Parity target",
    ]);
  });

  it("reads a float back as a number, not the string the wire carries", () => {
    const { row, positions } = parseCase("parity-frontmatter");
    const built: CachedMetadata = buildCachedMetadata(row, positions);
    expect(built.frontmatter?.ratio).toBe(3.14);
    expect(built.frontmatter?.count).toBe(42);
    expect(built.frontmatter?.missing).toBeNull();
  });

  it("keeps frontmatter tags out of cache.tags", () => {
    const { row, positions } = parseCase("parity-tags-frontmatter");
    const built = buildCachedMetadata(row, positions);
    expect(built.tags).toBeUndefined();
    expect(built.frontmatter?.tags).toEqual(["alpha", "beta/gamma", "Tag_With-Chars"]);
  });

  it("answers the empty note with Obsidian's bare version marker", () => {
    const { row, positions } = parseCase("parity-empty");
    expect(buildCachedMetadata(row, positions)).toEqual({ v: 1 });
  });

  it("refuses to guess an original the index did not retain", () => {
    const source = readFileSync(join(dir, "parity-links.md"), "utf8");
    const row = parseFixtureRow("parity-links.md", source);
    // An index built without the row's reference spans cannot answer `original`
    // exactly, and a reconstruction would be wrong for ordinary Markdown — so
    // the assembler says so rather than inventing one.
    //
    // The refusal is **typed**, because `buildCachedMetadata` is reached from
    // the plugin-facing `getFileCache`: a host has to be able to tell this apart
    // from a plugin's own failure, and a bare `Error` in a stack trace is not
    // that. The fields say which note and which span, which is what a report
    // would need to name the defect.
    let refusal: unknown;
    try {
      buildCachedMetadata(row, buildPositionIndex(source));
      expect.unreachable("an index with no retained spans must refuse");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CachedMetadataError);
    const typed = refusal as CachedMetadataError;
    expect(typed.code).toBe("cached_metadata_assembly");
    expect(typed.name).toBe("CachedMetadataError");
    expect(typed.path).toBe("parity-links.md");
    expect(typed.span).toEqual(row.outgoing[0]?.span);
    expect(typed.message).toMatch(/has no retained source for the reference/);
  });
});
