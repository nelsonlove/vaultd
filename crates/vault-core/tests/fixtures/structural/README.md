# Structural metadata fixtures

Sixteen markdown cases with `CachedMetadata.sections` and `.listItems` captured from a live, stock Obsidian — **version 1.13.4** (installer: Electron; macOS) — via the `obsidian` CLI's `eval` against `app.metadataCache.getFileCache(...)` on 2026-08-30. Captured by observing runtime behavior through the public plugin API; nothing was derived from Obsidian's source or `app.asar`.

Each `<case>.md` is the exact input; each `<case>.expected.json` is `{ obsidianVersion, sections, listItems }` verbatim as Obsidian returned it (pretty-printed only).

Empirical conventions these fixtures pin, which tests must honor:

- **Offsets are UTF-16 code units, not bytes.** Proven by `15-wide-offsets`: line 4 begins at UTF-16 offset 89 (byte offset 106, char offset 87), and Obsidian reports 89. vault-core's spans are bytes; comparisons convert vault-core byte spans to UTF-16 units through the source text, never the reverse.
- **`listItems[].parent`:** a nested item carries its parent item's start line (positive). A top-level item carries the negated line number of the list's start — with the observed edge that a list starting at line 0 uses `-1` (see `07` vs `14`/`15`).
- **`task`** is the raw character between the brackets (`" "`, `"x"`, `"/"` all observed), absent for non-task items.
- **Block ids** surface as `sections[].id` on the owning section (`13-block-ids`); a `^id` on a list item does not produce a `list` section id.
- **An empty note** has `sections` and `listItems` absent (captured as `null`), not empty arrays.
- Callouts are `type: "callout"` sections (not `blockquote`); setext headings are `heading`; raw HTML blocks are `html`.

Section-type vocabulary observed across the corpus: `yaml`, `heading`, `paragraph`, `code`, `blockquote`, `table`, `thematicBreak`, `list`, `callout`, `html`.

Re-capture procedure: stage these `.md` files into a scratch folder of a live vault, wait for the metadata cache, run `app.metadataCache.getFileCache(file)` per file, save `{obsidianVersion, sections, listItems}`, and update the version above. If a re-capture changes any shape, that is an upstream behavior change and belongs in a commit of its own.

## Second capture (2026-08-30, same Obsidian 1.13.4): cases 17-21, disputed edges

Captured to settle review findings 4-6 and to test a prescribed fix before applying it. Pinned by these fixtures:

- `footnoteDefinition` and `definition` are real Obsidian section types (17) — the vocabulary above is not closed, and `Other(String)` passing mdast names through matches reality for these two.
- `math` is a real section type (18); `$$` blocks must not degrade to `paragraph`.
- Obsidian can emit **zero-width phantom sections** (`text` and `element`, both `113..113` in 17) at end-of-file after a footnote reference. Comparisons filter zero-width sections and this clause documents why; vault-core does not reproduce them.
- A task marker requires whitespace (or line end) after `]` (19): `- [x]nospace` and `- [x](link)` have NO task state; `- [a] text` has state `a`.
- A callout requires the `[!type]` marker on the quote's FIRST line (20: marker on second line → `blockquote`), and the type may contain spaces (20: `[!my type]` → `callout`); uppercase and fold markers confirmed.
- A parent list item's span INCLUDES lists nested deeper than direct children (21: item `0..55` contains a blockquote-wrapped list at `15..55`); only DIRECT child lists are excluded from the parent's span (07/14). Items inside the nested quote are emitted as list items of their own inner list (`parent=-1` via the line formula).
- Clause refinement for case 13: a `^id` on a list item appears as `id` on the *listItem* entry in Obsidian's cache; the pinned storage model deliberately does not persist per-item ids (sections only) — a recorded divergence, not an oversight.

## Third capture (2026-08-30, same Obsidian 1.13.4): case 22, re-review edges

- An indented blockquote (up to CommonMark's three leading spaces) carrying a `[!type]` marker IS a callout (`   > [!note]` → `callout`).
- A wikilink inside a `$$…$$` math block produces NO link in Obsidian's cache (`links: []` captured alongside the sections) — vault-core's reference extraction skipping math blocks matches, and this fixture pins it. The `links` key in this one expected.json exists for that ruling; the structural test loader ignores it.
