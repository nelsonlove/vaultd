# Reading-view parity fixture

A small Obsidian vault for capturing what Obsidian's reading view renders, so vaultd-web's renderer (`renderBody`, `renderProperties` and `renderRef` in `spikes/htmx-client/server.js`, and the host renderer that stock plugins call through `MarkdownRenderer.render`) can be compared with it. See `docs/design/web-plugins-meta-bind.md`, sections 2 and 4.

It is written by hand. It is not made from, and holds nothing from, any real vault. It has no plugin and the default theme. `.obsidian/app.json` sets readable line width on and strict line breaks off.

## One note per construct

| Note | Holds |
| --- | --- |
| `headings.md` | headings 1 to 6 |
| `inline-formatting.md` | emphasis, strong, strikethrough, highlight, inline code |
| `wikilinks.md` | plain, alias, heading, block, missing-note and same-note links |
| `links.md` | markdown links, external links, bare URLs |
| `embeds.md` | note, heading, block, image and `.base` embeds, and a missing embed |
| `images.md` | internal and external images, with sizes |
| `lists.md` | unordered, ordered and nested lists |
| `task-lists.md` | tasks: open, done, other states |
| `blockquotes.md` | blockquotes, nested |
| `callouts.md` | plain, titled, folded `+` and `-`, nested, custom type |
| `code-blocks.md` | fenced with a language, without, an unknown `mb` language, indented |
| `tables.md` | alignment, inline formatting in cells |
| `horizontal-rules.md` | rules |
| `footnotes.md` | reference and inline footnotes |
| `math.md` | inline and block math |
| `comments.md` | `%% %%` comments |
| `tags.md` | tags inline and in frontmatter |
| `frontmatter-types.md` | every YAML type, `show-properties` |
| `inline-html.md` | inline and block HTML |
| `escaped-characters.md` | escapes and entities |
| `hard-line-breaks.md` | two spaces, backslash, plain newline |
| `view-field-code.md` | a `VIEW[...]` field as inline code |

Support notes: `Link Target.md`, `Target With Headings.md`, `Block Target.md`, `Embedded Base.base` and `assets/pixel.png`.

## Opening it and capturing

1. Copy the vault to a scratch path outside the repository: `cp -R host/fixtures/reading-view/vault ~/Downloads/rv-fixture/rv-fixture-vault`.
2. In Obsidian, "Open folder as vault" on that copy, and trust it if asked.
3. Run `node host/scripts/reading-view-capture.js capture --vault ~/Downloads/rv-fixture/rv-fixture-vault --out host/fixtures/reading-view/expected`. Add `--dry` first to read the eval code. The script refuses any other vault.

The output is described at the top of the script, with the normalisations it applies.
