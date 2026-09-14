# vaultd Obsidian Compatibility Contract

Compatibility is tiered. A higher tier never weakens the filesystem guarantees below it.

## Tier 0 — Storage compatibility

**Contract:** An unmodified stock Obsidian installation can open the vault directory. `vaultd` preserves Markdown, YAML properties, attachments, `.canvas`, `.base`, and `.obsidian` content it does not own. The filesystem is authoritative; indexes and journals are rebuildable support data.

**Current status: `vaultd` now writes, and the contract binds those writes.** Every write lands as ordinary files a stock Obsidian can open, through a temporary file in the target's own directory and an atomic same-directory rename, so a crash leaves the old bytes or the new bytes and never a torn note. The temporary name is dot-prefixed and extensionless, so it is invisible to Obsidian's own vault enumeration while it exists. A delete disposes of a file the way the caller asked: the platform trash, the vault's own `.trash/` (Obsidian's `trashOption: "local"`, a dot-directory that is never scanned, watched, or indexed), or permanent removal — defaulting to the vault's own `.obsidian/app.json` setting, and to `trash_system` (Obsidian's default) when that file is missing or unparsable. `patch_frontmatter` rewrites only the addressed span, so key order, comments, whitespace, and the body are preserved byte-for-byte. **"Span" is exact, and it is narrower than Obsidian's**, which has no such notion: `processFrontMatter` parses the YAML block, mutates the object, and re-serializes the **whole** frontmatter block, so one property edit can restyle every other property in it. `vaultd` rewrites one of three things instead. An edit addressing a top-level key splices that key's own value span (a deletion takes its whole entry line). An edit addressing a **scalar below** a top-level key — a leaf in a nested mapping, including one inside a block-style list of maps — splices that scalar's own span, so the `- ` that opens its item, that item's sibling keys, and the block indentation are not rewritten at all; a multi-line block scalar replaced by a plain scalar loses exactly the `|` and its own indented lines, and its siblings keep their bytes. Everything else below the stored granularity — a deletion, a new value that is a sequence or a mapping, a target that is itself a sequence or a mapping, a target that does not exist yet, a leaf addressed as a sequence element (`tags.0`), or two edits under one top-level key — re-serializes the smallest enclosing **top-level property** in the addition dialect. That is the remaining reflow, and it is bounded to one property: within it, block-style collections can come back in flow style (`- {name: a, value: 9}`), indentation is normalized to the dialect's two spaces, and comments between that property's own lines are dropped. Nothing outside that one property moves, in any case, which is the guarantee Obsidian's whole-block re-serialization does not make. Two spellings exist so a host can say what `processFrontMatter` can: a `key_path` given as an array of literal segments addresses a key whose own name contains a `.` (the dot-string form reads that dot as nesting), and `set_null` writes `key: null` — the bytes Obsidian writes for `fm.key = null` — where a JSON `value: null` deletes the key. Nothing is written into `.obsidian` except through the explicit raw `write_file`, and `--read-only` refuses every write in the process.

**One deliberate divergence, recorded rather than claimed away:** on a case-insensitive filesystem, a path that differs from an existing one only by case is refused with `case_collision` and nothing is written. Obsidian mishandles the same situation — it will happily act on a name the filesystem then folds onto a different file. `vaultd` prefers a typed refusal the caller can act on to a write that lands somewhere the caller did not name.

These claims are exactly as strong as the tests behind them: temp-then-rename atomicity, the case-collision refusal, byte fidelity outside patched spans, and containment (no traversal, no NUL, no symlink out of the vault) are each pinned by tests in `crates/vault-index` and `crates/vault-server`, and by a randomized oracle that requires a mutation and an external edit to be indistinguishable to the semantic layer.

The trash dispositions carry **one deliberate exception, stated rather than glossed**: `trash_local` and `permanent` disposal are pinned by tests (including the numbered-rather-than-clobbered second delete of the same name, and the refusal to delete inside the local trash), and the *selection* of all three modes from `.obsidian/app.json` is pinned — missing file, `"local"`, `"none"`, and a corrupt file each map to the documented mode. But `trash_system` **disposal is never executed by the suite**, by a written policy in the test files themselves: running it would put fixtures in the developer's own `~/.Trash`. So the mode a bare vault defaults to is verified to be *chosen* correctly and is not verified to *dispose* correctly. Nothing here is pinned against a *running* Obsidian: the storage-tier claims are about the filesystem, and only the Tier 1 structural shapes are capture-pinned (see below).

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

**Current status:** protocol version 1 executes `health`, `get_vault_info`, `list_notes`, `get_note`, `resolve_link`, `get_backlinks`, `list_references`, `get_diagnostics`, `refresh_index`, `subscribe_events`, and `unsubscribe` against a persistent SQLite index kept live by a filesystem watcher; the filesystem remains authoritative and the index is derived from it, never the other way round. Subscriptions deliver bounded **post-commit** events — the generation an event names is already committed and readable — and every overflow degrades into a `resync_required` marker rather than a lost change.

Compare-and-swap mutation is now implemented: `write_note`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`, `patch_frontmatter`, and the raw `write_file`/`read_file` pair, each with typed refusals that change nothing, preconditions checked against the bytes on disk, and a response sent only after the generation containing the write has published — so a client reads its own write at the generation it was handed. Rename repairs inbound links in that same generation, preserving each reference's spelling. Bulk reads are implemented as **snapshot sessions**: `open_snapshot`, `snapshot_tree`, `snapshot_notes`, and `close_snapshot` page a whole vault from one pinned read transaction, coherent at a single generation across the file tree and the semantic rows alike. Two per-path reads answer the same questions about a handful of paths rather than a whole vault: `get_note` takes an `include` naming the structural facets (`sections`, `list_items`), and `get_tree_entries` returns tree rows for exactly the paths a client names, reporting the rest as `absent` rather than as an error. `--read-only` refuses every write, the `.obsidian` zone included.

**Creating a folder inside the `.obsidian` zone is now possible**, which closes the gap earlier revisions of this document and `docs/protocol.md` recorded as the follow-up "Create folders inside the `.obsidian` zone". `create_folder` serves the configuration zone and every hidden folder as a raw create: no generation is published (the `generation` key is absent, not zero), and a `config_changed` event announces it when the folder landed inside `.obsidian/`. A plugin host can therefore make `.obsidian/plugins/<id>/` and its own configuration directory and then write into them. `delete_folder` and `rename_folder` still refuse both — making a directory is undone by removing it, while emptying `.trash/` or removing `.git/` is not — and every other containment gate on `create_folder` is unchanged, including the refusal of an ordinary-looking path that *resolves* onto an unindexable one.

Recoverable transactions, search, CLI commands beyond daemon configuration, and URI handling remain targets, not implementations — as do multi-file atomicity, conflict merging, journaling, and undo, which this milestone deliberately does not attempt.

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
