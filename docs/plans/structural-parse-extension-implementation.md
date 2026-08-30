# Structural Parse Extension Implementation Plan (DRAFT)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract block-level `sections` and `listItems` during parsing and persist them, so a future plugin host can build Obsidian-compatible `CachedMetadata` without inventing structural data vaultd never captured.

**Architecture:** Two new domain types in `vault-core` (`Section`, `ListItem`), populated by the existing mdast visitor in `markdown.rs`, carried on `ParsedNote`, persisted as two new tables in a schema bump (v2 → v3), and returned by the existing hydration/read paths. No new crate, no protocol change, no behavior change to resolution or reconciliation.

**Tech Stack:** Rust 1.85 (MSRV, no let-chains), `markdown` 1.0 (mdast), rusqlite/SQLite, existing `vault-core` + `vault-index` crates.

**Spec:** [Headless plugin host design for vaultd (draft)](../design/headless-plugin-host.md) §"The `sections`/`listItems` dependency" and its Rulings §1. Evidence: [Headless plugin compatibility research for vaultd](../research/headless-plugin-compatibility.md) census corrections (tasknotes reads `.listItems` for line counting and `.sections` to test for yaml blocks; breadcrumbs combines `.listItems` with links and embeds to build graph edges).

## Global Constraints

- MSRV Rust 1.85. **Never use let-chains** (`if let … &&`); gate every task with `rustup run 1.85.0 cargo check --workspace --all-targets`.
- The vault filesystem is authoritative and read-only in production code.
- Schema v3 invalidates existing caches by design: opening a v2 cache must land in `OpenIssue::Obsolete` → rebuild, never corruption. `SQLITE_BUSY` remains `Busy`, never corruption.
- Byte spans are exact and must round-trip: every emitted span must slice the source without panicking, verified by a property test.
- Additive only: no existing `ParsedNote` field, table, or read op changes shape.
- Prefix test commands with `TMPDIR="$PWD/target/tmp"`; export `PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"`.
- Gate before every commit: `cargo fmt --all`; `cargo clippy --workspace --all-targets -- -D warnings`; `TMPDIR="$PWD/target/tmp" cargo test --workspace`; `rustup run 1.85.0 cargo check --workspace --all-targets`.

---

## Task 0: Capture ground truth from real Obsidian

**This task produces fixtures, not code, and it gates Tasks 1–3.** Obsidian's core plugins and metadata shapes are closed-source; parity comes from observed behavior, never from reading `app.asar`. The `js-engine` plugin (installed, evaluates arbitrary JS in a live Obsidian) is the capture tool.

**Files:**
- Create: `crates/vault-core/tests/fixtures/structural/<case>.md` (the inputs)
- Create: `crates/vault-core/tests/fixtures/structural/<case>.expected.json` (Obsidian's output)

- [ ] **Step 1: Write the capture note**

Create a scratch note in the vault containing a `js-engine` code block that dumps real `CachedMetadata` for a target file:

```js
const file = app.vault.getAbstractFileByPath("Fixtures/structural-case-1.md");
const cache = app.metadataCache.getFileCache(file);
return engine.markdown.createCodeBlock("json", JSON.stringify({
    sections: cache.sections ?? null,
    listItems: cache.listItems ?? null,
}, null, 2));
```

- [ ] **Step 2: Author the fixture corpus** — one `.md` per case, covering: a note with frontmatter (yaml section first), headings, paragraphs, fenced code, a blockquote, a table, a thematic break, an unordered list nested three deep, an ordered list, a task list with `[ ]`, `[x]`, and a non-standard state such as `[/]`, a list containing a link and an embed (breadcrumbs' case), a callout, and an empty note.

- [ ] **Step 3: Capture and commit** — run the block per fixture, save each result as `<case>.expected.json`. **Record the Obsidian version in a `README.md` beside the fixtures**, because these are version-observed, not specified.

- [ ] **Step 4: Note the two shapes that must be reproduced exactly**, from what the capture shows — do not assume:
  - `sections[].type` — the exact string vocabulary Obsidian emits.
  - `listItems[].parent` — Obsidian's convention where a top-level item's `parent` is a **negative** number derived from the containing list's start line, and a nested item's `parent` is the **array index** of its parent item. Getting this wrong is silent breakage for breadcrumbs.
  - `listItems[].task` — the raw character inside the brackets, absent for non-task items.

- [ ] **Step 5: Commit**

```bash
git add crates/vault-core/tests/fixtures/structural
git commit -m "test(core): capture Obsidian structural metadata fixtures"
```

---

## Task 1: Domain types

**Files:**
- Modify: `crates/vault-core/src/semantic.rs` (add `Section`, `SectionKind`, `ListItem`; extend `ParsedNote`)
- Modify: `crates/vault-core/src/lib.rs` (exports)
- Test: `crates/vault-core/tests/structural_types.rs`

**Interfaces:**
- Produces: `Section { kind: SectionKind, span: SourceSpan, block_id: Option<String> }`; `SectionKind` as a total enum over the vocabulary Task 0 captured, plus `Other(String)` so an unrecognized Obsidian type is preserved rather than dropped; `ListItem { span: SourceSpan, parent: ListItemParent, task: Option<char> }` where `ListItemParent` is `Root { list_start_line: u32 }` or `Item { index: usize }` — modeling Obsidian's negative-vs-index convention as a type instead of a sign trick.
- Consumes: existing `SourceSpan`.

- [ ] **Step 1: Write the failing test** — construct a `ParsedNote` with one section and one nested list item; assert the fields round-trip and that `ParsedNote::empty` yields empty vectors for both.
- [ ] **Step 2: Run it, watch it fail** (`cargo test -p vault-core --test structural_types`; expect "no field `sections`").
- [ ] **Step 3: Add the types and the two `ParsedNote` fields**, defaulted in `empty()`.
- [ ] **Step 4: Run it, watch it pass.** Then `cargo test --workspace` — nothing else may break, because both fields are additive.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): model structural sections and list items"`

---

## Task 2: Extract sections

**Files:**
- Modify: `crates/vault-core/src/markdown.rs` (the mdast visitor at `Node::` match)
- Test: `crates/vault-core/tests/structural_sections.rs`

**Interfaces:**
- Consumes: `Section`/`SectionKind` from Task 1.
- Produces: populated `ParsedNote.sections`, ordered by span start, one entry per **top-level block** (never nested inside another block).

- [ ] **Step 1: Write the failing tests** — one per fixture from Task 0, asserting the parsed section list matches the captured `sections` array on `type` and byte offsets. Frontmatter must appear as the first section with the yaml kind; the existing frontmatter char→byte span table is the source for its span, not a re-derivation.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — walk only the root node's direct children; map each mdast block node to a `SectionKind`; carry a trailing block-id through to `Section.block_id` where one is present (the block-id spans already exist in `ParsedNote.blocks`; reuse, do not re-parse).
- [ ] **Step 4: Run, watch pass.**
- [ ] **Step 5: Add a span property test** — for arbitrary generated markdown, every emitted section span slices the source without panicking and spans are non-overlapping and ascending.
- [ ] **Step 6: Commit** — `git commit -m "feat(core): extract block sections during parsing"`

---

## Task 3: Extract list items

**Files:**
- Modify: `crates/vault-core/src/markdown.rs`
- Test: `crates/vault-core/tests/structural_list_items.rs`

- [ ] **Step 1: Write the failing tests** from the Task 0 fixtures, asserting: spans, the parent convention (root items vs nested items), task characters including the non-standard state, and that a list item containing a link still yields its reference in `ParsedNote.references` (the two extractions must not interfere — this is breadcrumbs' actual case).
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — descend list nodes tracking a parent stack; emit items in document order so that `ListItemParent::Item { index }` always refers to an already-emitted entry (assert this invariant in a debug assertion).
- [ ] **Step 4: Run, watch pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): extract list items with parent and task state"`

---

## Task 4: Persist and hydrate

**Files:**
- Create: `crates/vault-index/src/schema_v3.sql`
- Modify: `crates/vault-index/src/schema.rs` (version constants → 3; `initialize` runs v3)
- Modify: `crates/vault-index/src/store.rs`, `crates/vault-index/src/store/hydrate.rs`, `crates/vault-index/src/codec.rs`
- Test: `crates/vault-index/tests/schema_v3.rs`, plus additions to `crates/vault-index/tests/recovery.rs`

**Interfaces:**
- Produces: `sections` and `list_items` tables keyed by note path with ordinals; rows written by the existing `replace_note` path; read back by an accessor the host phase will consume.

- [ ] **Step 1: Write the failing tests** — (a) a note's stored sections and list items round-trip byte-identically to what parsing produced, for every Task 0 fixture; (b) opening a **genuine v2 database** (built from the committed `schema_v2.sql`, not a bumped pragma) lands in `Obsolete` → rebuild, ending at `user_version = 3` with the new tables present; (c) the busy-cache test still refuses to delete a healthy locked cache.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — `schema_v3.sql` derived from v2 verbatim plus the two tables and their per-note ordinal indexes; `SectionKind::Other(String)` encodes as its literal string so an unknown kind survives a round trip; `ListItemParent` encodes as a nullable parent-ordinal plus a list-start-line column, never as a negative-number trick in storage.
- [ ] **Step 4: Run, watch pass.**
- [ ] **Step 5: Verify the write path is on the incremental route too** — a targeted single-note reconciliation updates both tables (extend the existing live-reconciliation equivalence assertions rather than adding a parallel oracle).
- [ ] **Step 6: Commit** — `git commit -m "feat(index): persist structural rows in schema three"`

---

## Task 5: Documentation and baselines

**Files:**
- Modify: `VAULTD-COMPATIBILITY.md` (Tier 1 gains sections/listItems)
- Modify: `README.md` (parse coverage line)
- Modify: `docs/performance/persistent-index-baseline.md` or a new note, if row counts move materially

- [ ] **Step 1: Re-run the committed benchmarks** and record whether cold-build time or row counts moved; two extra row types per note is a real write-volume change and should be measured, not assumed.
- [ ] **Step 2: Update the compatibility contract** to state that structural sections and list items are extracted with exact spans, and that their shape is pinned against observed Obsidian behavior at a named version — never derived from Obsidian's source.
- [ ] **Step 3: Commit** — `git commit -m "docs: document structural parse coverage"`

---

## Execution notes

Task 0 gates everything and needs the maintainer at a live Obsidian; Tasks 1–3 are pure `vault-core` and independently reviewable; Task 4 is the only one touching storage and carries the rebuild risk; Task 5 is documentation. A checkpoint review after Task 3 (parse correct, nothing persisted yet) and after Task 4 (storage migrated) is proportionate for a change this size.

---

## Addendum (2026-08-30): the file tree joins this pre-task

The maintainer's ruling: vaultd indexes a file tree — folders and non-Markdown files — folded into this same schema-v3 bump. Rationale: `scan_vault` already walks every entry and the watcher already sees every event; both simply filter to `.md` and discard the rest, so this captures what is already observed rather than adding new observation. Folding it here means **one** cache rebuild covers both changes, and it makes phase 5's snapshot sessions fully generation-pinned instead of semantic-pinned-with-a-point-in-time-tree.

This task slots **between Task 4 (persist structural rows) and Task 5 (docs)**; renumber Task 5 to Task 6 when executing.

### Task 5: Index the file tree

**Files:**
- Modify: `crates/vault-core/src/vault_source.rs` (the enumeration currently filtering to `.md`)
- Modify: `crates/vault-index/src/schema_v3.sql`, `crates/vault-index/src/store.rs`, `crates/vault-index/src/store/hydrate.rs`, `crates/vault-index/src/live_reconcile.rs`
- Modify: `crates/vault-watch/src/filter.rs` (hints currently narrowed to included Markdown)
- Test: `crates/vault-index/tests/file_tree.rs`

**Interfaces:**
- Produces: a `tree_entries` table — `path` (primary key), `kind` (`note` | `file` | `folder`), `size` (null for folders), `mtime`, `content_revision` (null for folders and notes; notes already carry theirs on `notes`) — plus a read accessor phase 5's `snapshot_tree` consumes.
- Consumes: nothing new from Tasks 1–4; this is an independent axis of the same schema bump.

- [ ] **Step 1: Write the failing test** — a fixture vault containing nested folders, an empty folder, a `.md` note, a `.png` attachment, a `.canvas` file, and a dotfile directory. Assert: every folder and non-hidden file appears with the right `kind`; hidden directories (`.obsidian`, `.trash`) and their contents are **excluded**, matching the existing scan and watcher exclusion rules exactly; an empty folder still appears.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Extend enumeration** so the walk reports every entry with its kind, keeping the existing `.md`-only path as a filtered view over it — the semantic pipeline must be byte-for-byte unchanged, which the full existing suite proves.
- [ ] **Step 4: Run it, watch it pass.** Then `cargo test --workspace` — no semantic test may change behavior.
- [ ] **Step 5: Write the failing incremental test** — creating, renaming, and deleting an attachment and a folder each update `tree_entries` on the ordinary watcher path, without touching any semantic row or advancing anything a note-only client would observe. **This requires widening the watcher's hint filter**, which today discards non-Markdown events; the widening must preserve the hidden-directory exclusion and the existing debounce and overflow behavior.
- [ ] **Step 6: Run, watch fail. Implement. Run, watch pass.**
- [ ] **Step 7: Verify the cost** — re-run the committed 10k and 100k benchmarks and record the delta in row count, cold-build time, and index size. A vault with many attachments gains real rows; if the cost is material, say so in the baseline note rather than discovering it in phase 5.
- [ ] **Step 8: Commit** — `git commit -m "feat(index): index the vault file tree"`

**Scope note:** this pre-task has grown from "extract two structural fields" to "extract two structural fields and index the file tree." Both are the same shape of change — persist what the scan and watcher already see — and both ride one schema bump, but the task is no longer trivial and should get its own checkpoint review after Task 5 before phase 5 begins.

---

## Pinned DDL and corrections (2026-08-30, post plan-review round) — supersedes conflicting text above

Six independent reviews of the three plans triangulated on this plan being the schema authority both siblings must consume. Two corrections and one pinned artifact follow.

**Correction 1 — the `listItems.parent` convention described in Task 0 Step 4 and modeled in Task 1 is wrong.** Real `obsidian.d.ts` (3760–3769): `parent` is always a **line number** — the negated line number of the list's start for a top-level item, or the **parent item's own start line** (positive) for a nested item. It is never an array index. Task 1's domain type is therefore `ListItemParent::Root { list_start_line: u32 }` or `::Item { parent_start_line: u32 }`, and Task 0's capture exists to confirm the exact encoding empirically (including the precise negation form) rather than to trust the typings or this plan. Task 3's tests assert the captured values, whatever they turn out to be.

**Correction 2 — `tree_entries` gains a `ctime` column.** The host must serve `TFile.stat = { ctime, mtime, size }`; review found no op supplying `ctime` anywhere. Store it here: filesystem birthtime where the platform provides it, mtime as the documented fallback. Both stored as Unix milliseconds.

**The pinned schema-v3 DDL.** Task 4 Step 3 and Addendum Task 5 Step 3 implement exactly this; the phase-5 plan reads exactly this; neither invents variations:

```sql
-- sections: one row per top-level block, document order.
CREATE TABLE sections (
    note_path  TEXT    NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal    INTEGER NOT NULL,           -- 0-based, document order
    kind       TEXT    NOT NULL,           -- SectionKind wire string; Other(s) stores s literally
    span_start INTEGER NOT NULL,
    span_end   INTEGER NOT NULL,
    block_id   TEXT,                       -- nullable; carried through to every read path
    PRIMARY KEY (note_path, ordinal)
);

-- list_items: one row per list item, document order. Line-number parent model
-- per Correction 1; exactly one of the two parent columns is set.
CREATE TABLE list_items (
    note_path         TEXT    NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    span_start        INTEGER NOT NULL,
    span_end          INTEGER NOT NULL,
    list_start_line   INTEGER,             -- set iff top-level (ListItemParent::Root)
    parent_start_line INTEGER,             -- set iff nested (ListItemParent::Item)
    task              TEXT,                -- the raw character inside the brackets; NULL for non-task items
    PRIMARY KEY (note_path, ordinal),
    CHECK ((list_start_line IS NULL) <> (parent_start_line IS NULL))
);

-- tree_entries: the vault file tree (Addendum Task 5).
CREATE TABLE tree_entries (
    path             TEXT PRIMARY KEY,
    kind             TEXT    NOT NULL CHECK (kind IN ('note','file','folder')),
    size             INTEGER,              -- NULL for folders
    ctime_unix_ms    INTEGER NOT NULL,     -- birthtime; mtime fallback where unavailable (Correction 2)
    mtime_unix_ms    INTEGER NOT NULL,
    content_revision TEXT                  -- NULL for folders and notes (notes carry theirs on `notes`)
);
```

**Wire conventions the consumers hold to:** `task` is `Option<char>` in the domain and a one-character string on the wire (`Option<String>`, length 1 — stated so the widening is a convention, not drift); `sections` and `list_items` are separate, explicitly-requested snapshot facets, siblings of `metadata`, never nested inside it.
