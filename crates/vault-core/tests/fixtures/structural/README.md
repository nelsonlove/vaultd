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
