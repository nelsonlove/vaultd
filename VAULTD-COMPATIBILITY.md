# vaultd Obsidian Compatibility Contract

Compatibility is tiered. A higher tier never weakens the filesystem guarantees below it.

## Tier 0 — Storage compatibility

**Contract:** An unmodified stock Obsidian installation can open the vault directory. `vaultd` preserves Markdown, YAML properties, attachments, `.canvas`, `.base`, and `.obsidian` content it does not own. The filesystem is authoritative; indexes and journals are rebuildable support data.

The foundation defines this contract but performs no vault writes.

## Tier 1 — Semantic compatibility

**Target contract:** Match documented Obsidian behavior for wikilinks, Markdown links, aliases, headings, blocks, embeds, tags, properties, backlinks, unresolved links, and path/link resolution. Compatibility claims require fixture tests against observed Obsidian behavior.

**Current status:** the semantic read path is implemented with committed fixture coverage (`fixtures/semantic-read-path/`) for:

- frontmatter properties, aliases, and property tags with exact source spans;
- headings, block identifiers, and body tags (including nested and Unicode tags);
- Markdown links and embeds with percent-decoded targets and exact destination spans;
- wikilinks and wiki embeds with display text and heading/block subpaths;
- deterministic read-only scans, backlinks, unresolved references, and ambiguous candidates;
- structured diagnostics for malformed frontmatter, wikilinks, tags, and block identifiers;
- structural **sections** — one per top-level block, in document order, with its kind, its exact span, and the block identifier that owns it — and **list items** with exact spans, the line-number parent convention, and raw task state;
- the **vault file tree**: every non-hidden folder and file, with its kind (`note`, `file`, `folder`), byte size for files, and creation and modification timestamps in Unix milliseconds.

**How the structural shapes are pinned.** Sections and list items are pinned against *observed* Obsidian behavior at version **1.13.4**, captured at runtime through the public plugin API (`app.metadataCache.getFileCache`) against a live stock Obsidian and committed verbatim as 22 fixtures in `crates/vault-core/tests/fixtures/structural/`. Nothing is derived from Obsidian's source or `app.asar`, and nothing is inferred from the published typings alone: where the typings and the capture disagreed, the capture won. The fixtures' own README records the conventions the capture settled — that Obsidian's offsets are UTF-16 code units while `vaultd`'s spans are bytes (converted for comparison, never the reverse), the negated-start-line parent convention for top-level items with its line-0 edge case, task state as the raw bracket character, and an empty note reporting absent rather than empty collections.

Four divergences are recorded rather than claimed away: `vaultd` does not persist a block identifier on an individual list item (sections carry theirs), it does not reproduce the zero-width phantom `text`/`element` sections Obsidian can emit at end of file, it computes no content revision for a non-Markdown file, and its "hidden" rule excludes only dot-prefixed *directories* — a dot-prefixed *file* (`.DS_Store`, `.gitignore`) becomes a tree row, where stock Obsidian excludes dot-prefixed entries of either kind from its vault object model entirely. Section kinds outside the observed vocabulary pass through literally rather than being normalized, so an unknown kind survives a storage round trip.

Resolution follows the documented forms; undocumented Obsidian resolution behavior is returned as an explicit ambiguous or unresolved result rather than guessed, and no full compatibility claim is made for it.

## Tier 2 — Behavioral and interface compatibility

**Target contract:** Provide documented operations for note lookup, search, resolution, backlinks, compare-and-swap mutation, recoverable transactions, events, CLI commands, and `obsidian://` URI handling. Protocol support is declared per operation and version.

**Current status:** protocol version 1 executes `health`, `get_vault_info`, `list_notes`, `get_note`, `resolve_link`, `get_backlinks`, `list_references`, `get_diagnostics`, `refresh_index`, `subscribe_events`, and `unsubscribe` against a persistent SQLite index kept live by a filesystem watcher; the filesystem remains authoritative and the daemon performs no vault writes. Subscriptions deliver bounded **post-commit** events — the generation an event names is already committed and readable — and every overflow degrades into a `resync_required` marker rather than a lost change. Mutation, transactions, search, CLI commands beyond daemon configuration, and URI handling remain targets, not implementations.

## Tier 3 — Headless Obsidian plugin API compatibility

**Research contract:** A separate Node runtime may implement documented non-UI portions of `App`, `Vault`, `MetadataCache`, and `FileManager` against `vaultd`. Plugin compatibility will be measured per plugin and API surface.

Undocumented Obsidian internals are best-effort and never part of the stable core contract.

## Tier 4 — UI runtime compatibility

**Out of scope for the semantic runtime:** Workspace layout, editor behavior, CodeMirror, DOM views, Electron behavior, themes, and CSS belong to client runtimes.

## Synchronization compatibility

Sync is orthogonal to the tiers. Adapters exchange generic blobs, revisions, conflicts, and tombstones. Obsidian Sync, Git, WebDAV, or another provider must not change core semantics or filesystem authority.

## Consumer matrix

| Consumer               | Foundation status    | Intended boundary                             |
| ---------------------- | -------------------- | --------------------------------------------- |
| MCP                    | Documented consumer  | Protocol adapter                              |
| CLI and URI handling   | Documented consumers | Protocol adapters                             |
| Obsidian accelerator   | Documented consumer  | Protocol client plugin                        |
| Node Obsidian API shim | Research target      | Plugin API facade                             |
| Swift clients          | Documented consumers | Protocol / future FFI                         |
| GNU Emacs/Elisp host   | Documented consumer  | Protocol client                               |
| Sync adapters          | Documented consumers | Generic sync boundary                         |
| Mobile / e-ink clients | Documented consumers | Cached protocol clients or future embedded core |
