# Metadata parity fixtures

Eighteen markdown cases with the **complete** `CachedMetadata` captured from a live, stock Obsidian — **version 1.13.4** (macOS; Electron 43.1.1, Chrome 150) — on **2026-09-09**. Seventeen are the cases named in Task 0 Step 2; the eighteenth, `parity-wide-offsets`, is Step 3's non-ASCII position case.

Each `<case>.md` is the exact input. Each `<case>.expected.json` is `{ "obsidianVersion": string, "cache": CachedMetadata }`, the whole cache object as Obsidian returned it, pretty-printed only. Nothing is hand-picked: a subset is how a parity fixture silently stops covering a field.

## How these were captured

Every fixture was copied into a scratch folder of a running vault, left to index, and read back with `app.metadataCache.getFileCache(file)` through the `obsidian` CLI's `eval`. Nothing was derived from Obsidian's source or from `app.asar`; every claim below is a value that came out of the running app. After the capture the staged copies were diffed against the files in this directory byte-for-byte and were identical, so no plugin in the capture vault rewrote an input.

**On `obsidianVersion`.** Task 0's capture block reads `app.appVersion ?? "unknown"`. On 1.13.4 `app.appVersion` is **undefined** — the field does not exist on the app object — so the capture falls back to the version in `navigator.userAgent` (`obsidian/1.13.4`). Re-captures must record the version the same way, or they will all say `"unknown"`.

## What must be reproduced exactly

### Positions

Every `Pos` is `{ start: { line, col, offset }, end: { line, col, offset } }`. `line` and `col` are zero-based.

**`col` and `offset` are counted in JavaScript string units — UTF-16 code units — not in UTF-8 bytes and not in code points.** `parity-wide-offsets` is the proof. Its line 4 is `🙂 emoji outside the BMP [[Parity target]]`; 🙂 is U+1F642, a surrogate pair. The text before the wikilink is 24 code points, 25 UTF-16 units, 27 UTF-8 bytes. Obsidian reports `col: 25` and `offset: 146`. The line starts at offset 121 (identical in all three units, because everything before line 4 is BMP), so 121 + 25 = 146 — UTF-16 units. The same position is 159 in UTF-8 bytes and 145 in code points. `vaultd` returns byte offsets, so the comparison converts vaultd's byte spans to UTF-16 units through the source text, never the reverse.

### Section types

The vocabulary observed across this corpus:

`blockquote`, `callout`, `code`, `element`, `footnoteDefinition`, `heading`, `html`, `list`, `paragraph`, `table`, `text`, `thematicBreak`, `yaml`

The list is **not closed** — it is what these eighteen inputs produced. A callout is `callout`, never `blockquote`; a setext heading is `heading`; a raw HTML block is `html`. `parity-footnotes` also shows Obsidian emitting **zero-width phantom sections** (`text` and `element`, both at line 5, start offset == end offset) after the last footnote definition; comparisons filter zero-width sections.

### `listItems[].parent` is a line number, never an array index

`ListItemCache.parent` is "the line number of the parent list item; if the item has no parent it is the negative of the line number of the first list item". The captures pin the exact negation form, including the `-0` question:

| fixture | list starts at line | root items | nested items |
| --- | --- | --- | --- |
| `parity-list-flat` | 0 | lines 0, 1, 2 → `parent: -1` | — |
| `parity-list-flat` | 6 | lines 6, 7 → `parent: -6` | — |
| `parity-list-nested-3deep` | 2 | lines 2, 7 → `parent: -2` | line 3 → `2`; lines 4, 5 → `3`; line 6 → `2` |
| `parity-list-nested-3deep` | 9 | line 9 → `parent: -9` | line 10 → `9`; line 11 → `10` |
| `parity-list-tasks` | 0 | lines 0–3 → `parent: -1` | line 4 → `3` |

**A list starting on line 0 produces `-1`, not `-0` and not `0`.** Every other list produces the plain negation of its start line. Task 8's conversion is written against these captured values.

### `listItems[].task`

The raw character between the brackets: `" "`, `"x"`, and `"/"` all observed in `parity-list-tasks`. On a non-task item the key is **absent**, not `null` — line 3 of `parity-list-tasks` has no `task` key at all.

### `frontmatterLinks[]` entries carry no `position`

`FrontmatterLinkCache extends Reference`, not `ReferenceCache`. The observed field set is exactly `["displayText", "key", "link", "original"]` — no `position`. A shim that adds one fails parity.

Observed key spellings from `parity-frontmatter-links`:

| YAML | `key` | `link` | `displayText` |
| --- | --- | --- | --- |
| `related:` list item 0, `"[[Parity target]]"` | `related.0` | `Parity target` | `Parity target` |
| `related:` list item 1, `"[Markdown target](Parity%20target.md)"` | `related.1` | `Parity target.md` | `Markdown target` |
| `single: "[[Parity target\|Alias text]]"` | `single` | `Parity target` | `Alias text` |

A list element is `field.<index>`; a scalar is the bare `field`. A markdown link's `link` is percent-decoded and keeps its extension.

### Other observed field sets

| key | fields |
| --- | --- |
| `links[]`, `embeds[]` | `displayText`, `link`, `original`, `position` |
| `tags[]` | `position`, `tag` (the `tag` value **includes** the leading `#`) |
| `headings[]` | `heading`, `level`, `position` |
| `blocks` (a map, id → entry) | `id`, `position` |
| `listItems[]` | `parent`, `position`, `task` (absent on non-tasks), `id` (present **only** when the item carries a block id) |
| `footnotes[]`, `footnoteRefs[]` | `id`, `position` |

`parity-tags-frontmatter` pins one more thing: **frontmatter tags do not appear in `cache.tags`.** That file's `tags` key is absent entirely and the values live in `frontmatter.tags`; `cache.tags` only ever holds body tags. `parity-blocks` pins two things about block ids. A `^id` written inline on a heading line does register in `blocks` and as `sections[].id`, while the heading's own `heading` text still contains the literal `^heading-inline`. And **a `^id` on a list item appears as an `id` key on that `listItems[]` entry** — `parity-blocks` line 11 is `{ id: "item-block", parent: -11, position: … }` while line 12, the item without an id, has only `parent` and `position`. The key is present only when the item carries a block id, exactly like `task`. `buildCachedMetadata` written against the field table alone, without this row, omits the key and fails parity on `parity-blocks`; the pre-task structural corpus records the same behaviour (case 13 refinement), so the two corpora agree.

### The empty note

`parity-empty.md` is zero bytes. Its whole cache is:

```json
{ "v": 1 }
```

**Every content field is omitted — none is an empty array**, and a `v: 1` key is present that no non-empty note in this corpus carries. Across the corpus, `sections` appears in 17 of the 18 cases (absent only here), and `frontmatterLinks` is present as `[]` whenever frontmatter exists at all, even with no links in it (`parity-frontmatter`, `parity-tags-frontmatter`).

### Fields this phase does not serve

`footnotes`, `footnoteRefs`, and `referenceLinks` are real `CachedMetadata` fields in the current `obsidian.d.ts` (since 1.6.6 and 1.8.7) that `vaultd` does not parse. They are **absent-with-policy**, not forgotten: `buildCachedMetadata` omits the keys entirely — which is what Obsidian itself does for a note with none — the policy table records them as `absent`, and a plugin reading them sees `undefined`, exactly as it would for a note without footnotes.

`parity-footnotes` measures the gap rather than assuming it: Obsidian returns both `footnotes` and `footnoteRefs` for that file, with the field sets above. **The parity test skips these three keys by name.** No fixture in this corpus produced a `referenceLinks` key.

## Re-capture

Copy the `.md` files into a scratch folder of a live vault, wait for the metadata cache, read `app.metadataCache.getFileCache(file)` per file, save `{ obsidianVersion, cache }`, and update the version at the top. Diff the staged copies against this directory afterwards to prove no plugin rewrote an input. If a re-capture changes any shape, that is an upstream behaviour change and belongs in a commit of its own.
