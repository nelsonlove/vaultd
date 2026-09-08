# vaultd Vault Mutation and Bulk Read Design (DRAFT v2)

## Status

Draft v2 for the maintainer's cut. v1 was reviewed by three independent fresh-context reviewers (codebase fit, consumer fit, internal rigor); every Blocking and Important finding is resolved in the text below or converted to an explicit OPEN. Sources: the phase-4 design (`docs/design/live-incremental-runtime.md`), the plugin research ([Headless plugin compatibility research for vaultd](../research/headless-plugin-compatibility.md), including its 2026-08-29 census corrections), and the review findings. Terminology: "the live runtime" means the merged phase-4 work; citations like "task 8" refer to tasks of that phase's plan. Open questions are marked **OPEN** inline. Nothing here is accepted.

## Summary

This phase gives `vaultd` a write path, raw file I/O, and a bulk read path. Semantic writes are single-file mutations guarded by content-revision compare-and-swap, executed serially on the existing coordinator, reconciled for their own paths before the response is sent, and published as ordinary generations — a client that completes a write can immediately read its result at the returned generation. Raw file I/O covers attachments and the `.obsidian` configuration zone in both directions, closing the gap that would otherwise force a plugin host to read disk behind the daemon's back. Bulk reads are snapshot sessions: a client opens a pinned, generation-stable snapshot and pages through the entire vault tree and semantic state with ordinary request/response calls, so hydration takes a handful of round trips instead of thousands and never tears across generations.

The mutation surface is sized by measurement, with the census corrected during review: across the 56 reference-vault plugins, every vault mutation flows through six primitives plus three extras — create, create-folder, modify, read-modify-write, rename, delete/trash, plus copy, frontmatter patching, and raw file writes. Read-modify-write is deliberately served as a client-side CAS loop, not a protocol operation. Transactions, multi-file atomicity, conflict merging, journaling, and Sync remain out of scope.

The consumer this phase unblocks is the headless plugin host ([Headless plugin host design for vaultd (draft)](headless-plugin-host.md)): with this phase, the host mirrors state via snapshot sessions plus `subscribe_events`, routes every plugin write through `vaultd`, and reads plugin configuration through the same door it writes it.

## Goals

- Implement the measured write surface as protocol-v1 additive operations: `write_note`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`, `patch_frontmatter`, `write_file`. Content-bearing operations are CAS-guarded; folder operations are guarded by existence semantics (they have no content revision to compare).
- Serve read-modify-write (`vault.process`, 13 plugins) as a documented client CAS-retry loop over `get_note` + `write_note`.
- `read_file`: raw reads for attachments and the `.obsidian` zone — the read half of `loadData`, `adapter.read`, and config round-trips.
- Read-your-writes: every successful mutation returns the generation containing it; reads at that generation see it. The fence is implicit; no client-side `refresh_index` choreography.
- Byte fidelity: a mutation writes exactly the bytes given; `patch_frontmatter` surgically edits only the addressed keys' spans (per-key spans exist in the index down to key/value granularity) and leaves every other byte untouched.
- Rename with inbound-link repair, spelling-preserving, with per-file CAS so a concurrently-edited referrer is skipped-and-reported, never clobbered.
- Snapshot sessions: open → page (tree entries, then per-note semantic rows) → close, pinned at one generation, without blocking the writer and without occupying the dispatcher.
- Wire-compatibility hardening: before any event enum grows a variant, protocol consumers gain a documented unknown-variant tolerance (see below) — this phase ships it as a prerequisite, because it is what makes "additive" true.
- The vault filesystem remains authoritative; `vaultd`'s writes are ordinary filesystem writes its own reconciler would accept from anyone else.

## Non-goals

- Multi-file transactions or atomicity beyond one file. Rename link-repair is a serialized burst with per-file CAS (see below), not a transaction.
- Conflict resolution beyond detect-and-refuse; retrying is the caller's loop.
- Write-authority arbitration between daemons (the writer lease already excludes a second `vaultd`).
- Journaling, undo, versioning, Sync semantics.
- Indexing `.obsidian` or attachment contents (raw I/O passes bytes through; nothing in the zone becomes semantic).
- A server-side RMW operation. **OPEN** (genuinely): reviewers noted the client loop is weaker than Obsidian's internally-queued `process()` under multi-caller contention. Draft position stands — primitive-only, with the host serializing same-path `process` calls itself — but if the maintainer prefers server-side `process_note` with bounded retry, it slots in additively later.
- Fixing the cold-open hydration miss inside `IndexService::open` (snapshot sessions help hosts; lazy open-hydration stays deferred).

## Wire-compatibility prerequisite

Review found that `GenerationCauseDto` (and its sibling closed enums) tolerate no unknown variants: adding `cause: "mutation"` would hard-fail deserialization in every existing subscriber the moment any client mutates. Before any new variant ships, this phase adds an unknown-variant convention to the protocol: every open-ended wire enum (`GenerationCauseDto`, `ResyncReasonDto`, `LiveStateDto`, `RuntimeEventDto`'s tag) gains a documented catch-all (`#[serde(other)] Unknown`) on the consumer side, `docs/protocol.md` states the rule ("clients MUST treat unrecognized variants of these enums as unknown, not as errors"), and a protocol test pins that yesterday's fixtures still parse and tomorrow's variants degrade to `Unknown`. Closed enums that only answer requests a client itself sent (`ErrorCode`) need no catch-all but get one for uniformity. This is its own task with its own tests, sequenced first.

## Revisions and preconditions

Every note carries a content-derived revision (`blake3:<hex>` — the full stored format, prefix included). Raw files use the same scheme over raw bytes. Content-bearing mutations carry `expected`:

- `expected: { revision: "blake3:<hex>" }` — the target must currently have this revision.
- `expected: { absent: true }` — the target must not exist.
- `expected: { any: true }` — unconditional; allowed, discouraged, exists for append-style flows that genuinely do not care.

Per-operation validity: `write_note`/`write_file` accept all three; `patch_frontmatter`, `rename_note`, `copy_file` (source), `delete_note` accept `revision` or `any` (never `absent`); `create_folder`, `rename_folder`, `delete_folder` carry no `expected` (existence semantics only). On mismatch: typed `revision_conflict` with the current revision and generation, nothing changed. Delete responses return `{ generation }` only (a deleted file has no revision); deleting an already-absent path with `expected.any` is a typed `not_found`, not success — deletion is never idempotent-silent, because the caller's model was wrong and should hear so.

Path validation at mutation time is the canonicalize-and-containment check from the live runtime's storage-validation work (the `FileSystemVaultSource`-style resolve-then-`starts_with`, symlink-aware), invoked per operation — `VaultPath`'s constructor alone is string-level and insufficient, which the implementation must not forget. Parent folders are never implicitly created: a write into a missing folder is typed `parent_not_found` (matching Obsidian, where plugins call `createFolder` first). Invalid UTF-8 in `write_note` content is structurally impossible over JSON strings, and the implementation asserts it rather than validating it. **OPEN:** case-insensitive filesystem collisions (APFS default): `create` with `expected.absent` where a case-variant exists, and case-only renames. Draft position: detect via directory enumeration and refuse with typed `case_collision` (Obsidian itself mishandles this; we should not), with case-only rename supported via a two-step temp name internally.

## Operations

- `write_note { path, content, expected }` → `{ generation, revision }`. Create or replace a UTF-8 note.
- `create_folder { path }` → `{ generation }`. `mkdir` semantics for one segment or a chain; idempotent success if a folder already exists at `path`; typed error if a file occupies it.
- `rename_note { from, to, expected, rewrite_links }` → `{ generation, revision, links_rewritten, link_rewrite_failures }`. Refuses if `to` exists (typed `target_exists`) — there is no overwrite-on-rename; movers who mean replace must delete first, visibly. `rewrite_links` defaults true.
- `rename_folder { from, to, rewrite_links }` → same shape; refuses if `to` exists; repairs inbound references for every contained note.
- `copy_file { from, to, expected_source, if_exists }` → `{ generation, revision }`. Raw byte copy of any vault file (note or attachment). `if_exists: "error"` (default) or `"suffix"` (Obsidian's auto-numbering behavior, for `getAvailablePath` parity). Serves `vault.copy` (census correction: stashpad).
- `delete_note { path, mode, expected }` → `{ generation }`. `mode`: `"trash_system"`, `"trash_local"` (the vault's `.trash/`, matching this vault's live `trashOption: "local"`; `.trash` is a dot-directory and therefore already excluded from scanning and watching by the existing hidden-dir rule — now stated, not assumed), or `"permanent"`. Default **OPEN**: read Obsidian's `app.json` `trashOption` and mirror it, or require the caller to say? Draft position: caller states mode explicitly; the host reads `app.json` and supplies the user's preference.
- `delete_folder { path, mode, recursive }` → `{ generation }`. Refuses non-empty without `recursive: true`.
- `patch_frontmatter { path, patch, expected }` → `{ generation, revision }`. `patch` is a list of `{ key_path, value }` entries — `key_path` is a dot-path (`a.b.c`) addressing nested keys, because the census's own exemplar (nested-properties) edits leaves inside nested objects; `value: null` deletes. Span-based editing applies at the deepest addressed span the index stores; edits below stored-span granularity re-serialize only the smallest enclosing stored span, preserving all bytes outside it. Key deletion removes the key's span extended through its trailing line terminator (review caught that the stored span excludes it). Serialization dialect for new/replaced values is pinned by byte-exact fixtures (**OPEN:** the dialect choice itself — draft: match the obsidian-linter-formatted style dominant in the reference vault).
- `write_file { path, content_base64, expected }` → `{ generation, revision }` (or `{ revision, semantic: false }` for the `.obsidian` zone). Raw bytes; size-capped (**OPEN:** cap; draft 64 MiB, boundary-tested).
- `read_file { path }` → `{ content_base64, revision }`. Raw reads for any vault file including the `.obsidian` zone; the read half of `loadData` and `adapter.read`. Notes are readable this way too (byte-identical to `get_note`'s source, without the semantics).

The `.obsidian` zone: `write_file`/`read_file` accept paths under `.obsidian/`; all semantic ops refuse them. Zone writes join no generation and emit a `config_changed` notice (shipped this phase — the host wants it on day one). Zone semantics get their own tests: refusal by semantic ops, no-generation on zone writes, `config_changed` delivery, round-trip fidelity.

## Rename link repair

Two-tier mechanism, stated precisely because review found the v1 wording pointed implementers at the wrong layer: the live graph's reverse-dependency index answers *which* references target the renamed note (IDs only — the compact graph deliberately stores no spans or spellings); the durable SQL layer (`note_references` rows: `raw_target`, `display`, spans; plus `notes.source_bytes`) supplies *how to rewrite each one*. Each referencing note is edited by span substitution preserving spelling style (shortest-form stays shortest-form while unambiguous; ambiguity introduced by the rename upgrades the spelling to the explicit path form — over-specifying is safe, silently retargeting is not), CAS-guarded against the revision the index knew.

Execution shape: the entire burst — the file move plus all referencing-note edits — runs as **one coordinator command**: serialized against all other mutations (queued writes wait; at the 500 ms-class target this is acceptable, and the alternative — interleaving — would let a queued write race a repair edit on the same file). Order: referencing notes are rewritten first, the file moves last; a crash mid-burst therefore leaves some references already pointing at the new path of a note that still sits at the old path — visible as unresolved references that self-heal when the client retries the rename, and never the reverse (a moved note with stale inbound links that look resolved but aren't). One reconciliation pass, one generation, containing the move and every successful rewrite; skipped files are reported in `link_rewrite_failures` and are not in the change set.

## Snapshot sessions (bulk reads)

Review killed v1's streaming design twice over: the dispatcher answers exactly one response per request (the handler has no access to the output channel), and even restructured, a multi-second stream would deafen the single dispatch loop precisely when a resync makes hydration urgent. And the claimed pinning mechanism — the reader barrier — is per-call and cannot hold a snapshot across calls without blocking the writer. Snapshot sessions replace it:

- `open_snapshot {}` → `{ snapshot_id, generation, note_count, entry_count }`. Opens a dedicated long-lived SQLite read transaction on a snapshot-owned connection (not the shared reader), pinned at the current generation. WAL semantics: the writer proceeds; the pinned reader sees its generation forever. Cost stated honestly: an open snapshot pins WAL frames and defers checkpoint truncation for its lifetime, so sessions carry an idle timeout (**OPEN:** value; draft 60 s since last page) and a hard cap on concurrent snapshots (draft: 4).
- `snapshot_tree { snapshot_id, cursor }` → a page of tree entries — folders, notes, and non-markdown files with size and revision — because the host's mirror needs the full `TFile`/`TFolder` tree, not just notes (review caught that v1's note-only frames could not back `getFiles` or folder lookups).
- `snapshot_notes { snapshot_id, cursor, include }` → a page of per-note semantic row-sets (`metadata`, `references`, `resolutions`, `backlinks` per `include`; bodies stay per-note via `get_note` — unchanged draft position).
- `close_snapshot { snapshot_id }` → releases the transaction. Client disconnect releases all of that client's snapshots (the daemon is single-peer today, so disconnect detection is stdio EOF — stated so the cleanup path is designed, not discovered).

Every call is ordinary request/response — no new framing, no dispatcher occupation beyond one page, events flow between pages. Pagination bounds each page (**OPEN:** page size; draft 500 entries). This subsumes v1's `export_snapshot`/`export_snapshot_page` pair entirely.

## Architecture

Mutations are a `mutate.rs` module in `vault-index` invoked from the coordinator; snapshot sessions live beside the reader; protocol DTOs extend `vault-protocol`. Flow for a semantic write: dispatcher → `RuntimeCommand::Mutate` with reply channel (the existing `Refresh { reply }` pattern) → coordinator validates path + CAS against the index → temp-file-write-then-rename in the target directory → the live runtime's `refresh_paths` for the affected paths with new `ChangeCause::Mutation` → barrier publish → reply `{ generation, revision }`. The watcher's later hint for the same path no-ops by fingerprint match — the same idempotence external atomic saves already exercise; a test pins "own mutation followed immediately by its watcher hint yields no second generation."

Subscribers see ordinary `generation_committed` events with `cause: "mutation"` (legal only after the wire-compatibility prerequisite lands).

## Failure handling

- Per-file atomicity via temp+rename; a crash leaves old or new content, never torn.
- Crash mid-rename-burst: see the ordering guarantee above; convergent, visible, retryable.
- All precondition and validation failures are typed and change nothing: `revision_conflict`, `not_found`, `parent_not_found`, `target_exists`, `case_collision`, zone violations, size cap.
- `--read-only`: refuses every mutating op (including zone writes) with a dedicated code; snapshot and read ops unaffected. Tested.
- Existing taxonomy (`Busy`, `LiveStateStale`, lease) unchanged.

## Testing

- **Oracle extension:** the live runtime's randomized equivalence oracle gains mutation operations routed through the protocol; assert-matches-fresh-scan holds after every batch — mutations and external edits must be indistinguishable to the semantic layer.
- **Byte-fidelity properties:** `patch_frontmatter` preserves every byte outside addressed spans for arbitrary documents and patches, including nested dot-paths and deletion (terminator rule); no-op patches are byte-identical; dialect fixtures byte-exact.
- **Rename repair:** fixture matrix incl. spelling preservation, ambiguity upgrade, per-file CAS skip, crash-ordering convergence (kill between rewrite and move via test hook), and fan-out benchmarks at 0/10/100/1000 inbound links (matching the phase-4 benchmark-matrix practice, not one arbitrary point).
- **CAS races:** two racing writers through the real daemon per op class; loser gets `revision_conflict`, never a lost update (reuses the live runtime's race-proof harness and hooks — the phase-4 plan's task-13 machinery).
- **Snapshot coherence:** a session opened before a write storm pages to completion at its pinned generation; timeout reclamation; concurrent-cap refusal; disconnect cleanup.
- **Read-your-writes and read-your-deletes** at the process level: write → `get_note` sees content at returned generation; delete → `get_note` typed not-found.
- **Zone, folder-op, size-cap, `--read-only`, wire-tolerance tests** as named in their sections.

## Instrumentation and targets

Counters extend to mutations (rows written, links rewritten, snapshot pages/bytes served, open-snapshot gauge + WAL-pin duration). Baselines, not contracts (the phase-4 policy), each tied to a named benchmark case; the 133 ms comparison figure below is from `docs/performance/live-incremental-baseline.md`:

- `write_note` → committed: p50 < 25 ms, p95 < 100 ms at 100k notes (vs 133 ms p50 for the watcher path — mutations skip the debounce).
- `rename_note` at the 120-inbound-link case: p50 < 500 ms including rewrites; curve reported at 0/10/100/1000.
- Full hydration via snapshot session (tree + semantic rows, no bodies) at 100k notes: < 10 s wall, < 256 MiB peak added RSS in the daemon (a number, so it can fail).

## Deferred follow-on

The headless plugin host consumes this phase ([Headless plugin host design for vaultd (draft)](headless-plugin-host.md)). Server-side RMW, multi-file transactions, journaling, undo, Sync, lazy open-hydration: deferred, unchanged.

## Rulings (2026-08-30) — supersedes every inline OPEN above

Inline **OPEN** markers are retained as a record of what was undecided and why; where this section conflicts with one, this section wins. Attribution matters for later re-litigation: (N) = the maintainer's call, (A) = agent's call within delegated scope, reversible unless noted.

1. **`sections`/`listItems` parse extension — standalone pre-task, before this phase (N).** A focused change of its own: extend `ParsedNote`, add the two row types, bump to schema v3, one cache rebuild. This phase then treats both as ordinary `snapshot_notes` facets from day one, and the host phase carries no cross-phase dependency. Rationale: schema bumps force a rebuild, so pay it once, early, rather than twice.
2. **Read-modify-write — client CAS loop only; no path leases (A).** Decided on failure modes rather than contention: locks introduce stuck state (a client dying mid-lease forces a break-timeout guess with two bad answers), CAS retry has none. Decisive asymmetry: leases can be added later additively if real contention appears; unused lock machinery cannot be removed. The host serializes same-path `process` calls internally, so plugin-vs-plugin ordering is preserved; only cross-process contention — which Obsidian never handled at all — falls back to retry.
3. **Delete modes — the shim passes the plugin's own choice through; direct-client `delete_note` defaults from `app.json`'s `trashOption` (N, corrected by evidence).** Verified: plugins do **not** consult `trashOption`. Obsidian's API is `vault.trash(file, system: boolean)` and the plugin chooses per call — folder-notes switches on its own `deleteFilesAction` setting, governor hardcodes `trash(x, true)` at all three sites. `trashOption` governs Obsidian's own UI deletions only. So `trash(f, true)` → `trash_system`, `trash(f, false)` → `trash_local`, `delete(f)` → `permanent`, no config consultation on the plugin path. The `trashOption` default applies only when a client deletes with no plugin involved, and is overridable per call.
4. **Case-insensitive collisions — detect and refuse (A).** `create` with `expected.absent` where a case-variant exists, and case-only renames, both return typed `case_collision`; case-only rename is supported internally via a two-step temporary name. This is stricter than Obsidian (which mishandles the case), and data safety wins over bug-compatibility.
5. **`patch_frontmatter` serialization dialect (A):** new and replaced values serialize in the reference vault's dominant obsidian-linter-formatted style, pinned by byte-exact fixtures. Existing values are never re-serialized — only the addressed span changes — so the dialect applies to additions alone.
6. **`write_file` size cap — 16 MiB, revised down from the 64 MiB draft (A).** Base64 over JSON inflates roughly a third, so 64 MiB of bytes is an ~85 MB single JSON line, which strains a line-delimited reader for no measured benefit. 16 MiB covers every attachment class in the reference vault. **Chunked transfer for larger files is deferred follow-on**, and the cap returns a typed error naming it.
7. **Snapshot session calibration (A):** idle timeout 60 s since the last page; 4 concurrent snapshots per daemon; page size client-requestable, defaulting to 500 entries and capped at 2000. All three are `IndexConfig` fields so they are tunable without a protocol change.

**Sequencing consequence:** this phase is now preceded by the schema-v3 parse pre-task. The order is: parse extension → wire-tolerance hardening (already a task here) → mutations → snapshot sessions.

## Corrections from plan drafting (2026-08-30)

Writing the implementation plan against the codebase surfaced three items. These supersede the text above, including Rulings §5.

8. **CAS compares against the bytes on disk, not against the index.** The Architecture section said "validates path + CAS against the index"; the Revisions section said the target "must currently have this revision". Those are not the same thing, and the difference is the whole point of the mechanism: the index lags the filesystem by a debounce window, so an index-based comparison would be blind to an external edit that has not yet reconciled — and would overwrite it. That is precisely the lost update CAS exists to prevent. **The precondition is checked by hashing the file at mutation time**, inside the coordinator, immediately before the write.

9. **Ruling 5 was too absolute: a nested patch re-serializes its enclosing top-level property.** The index stores spans per *top-level* frontmatter key, so a dot-path addressing a leaf inside a nested object is below stored-span granularity. Refusing those outright — the plan's initial reading — would make `nested-properties` unserviceable, which is the exact plugin the dot-path support was added for. The correct rule: **an edit at or above a stored key's granularity rewrites only that key's span; an edit below it re-serializes the smallest enclosing stored value span, and nothing outside that property is touched.** The goal was never byte-perfection for its own sake — it was to stop weak YAML round-tripping from silently rewriting every note. Rewriting one property's value while leaving key order, comments, whitespace, and the body byte-identical honours that fully. Storing per-nested-key spans would remove even this, and is deferred follow-on (it would make the property model recursive).

10. **Snapshot sessions are generation-pinned for semantics and point-in-time for the tree — and the spec must say so.** The index stores neither folders nor attachments (indexing attachment contents is an explicit non-goal), so a pinned SQL transaction cannot produce tree entries for them. `snapshot_tree` therefore captures folders and non-Markdown files from the **filesystem at `open_snapshot`**, a point-in-time observation; `snapshot_notes` continues to come from the pinned transaction and remains generation-exact. Consequence a consumer must know: a file created after the session opened may be missing from the tree while the note half stays coherent — the mirror closes that gap from `subscribe_events`, which it is already consuming. Attachment revisions are hashed **per page** rather than at open, so a session's cost stays proportional to what is actually read.

Smaller plan-level calls, recorded: `write_note` at a non-`.md` path is a typed error rather than a raw write, because such a file would never be indexed and read-your-writes would silently break; the delete-mode default falls back to `trash_system` (Obsidian's own default) when `app.json` is missing or unparsable, since a delete must not fail on an unreadable config file; `trash_system` needs a platform crate (`trash 5.2`), whose MSRV-1.85 compatibility is verified as its own step before adoption; and the randomized oracle sweep runs in-process against the same engine path the coordinator drives, with a separate scripted full-surface scenario going through the real spawned daemon — a daemon per proptest case would be unusably slow without buying additional coverage.

## Supersedes correction #10 (2026-08-30)

**The snapshot tree is now fully generation-pinned; the point-in-time caveat is withdrawn.** The maintainer ruled that vaultd indexes a file tree (folders and non-Markdown files) as part of the schema-v3 pre-task, on the reasoning that the scan and watcher already observe every entry and merely discard the non-Markdown ones. With `tree_entries` in the index, `snapshot_tree` reads from the same pinned transaction as `snapshot_notes`, and an entire snapshot session — tree and semantics alike — is coherent at one generation. Attachment revisions come from the stored rows rather than being hashed per page, so the pagination cost note in correction #10 is also withdrawn.

Consequence for this phase: `snapshot_tree`'s implementation task loses its filesystem-walk branch entirely and becomes an ordinary paginated read, and the mirror no longer needs a reconciliation path for entries that arrived between open and close.

## Corrections from checkpoint 1 (2026-09-01, agent-recorded during execution)

11. **`rename_folder` reports no revision.** The "same shape" sentence for the two rename responses contradicted this spec's own rule that a thing with no content revision reports no `revision` key. A folder has no bytes to hash: `RenameResponse.revision` is optional on the wire, present for `rename_note`, absent for `rename_folder` — never an empty string.

12. **A present-but-empty `expected` is refused; only omission means unconditional.** The DTO comment said an empty precondition object is `invalid_request`; the plan's conversion mapped it to an unconditional write. Both intents survive, split precisely: omitting `expected` altogether is the unconditional spelling (ergonomic, deliberate), while an `expected` object that is present must name exactly one of `revision`/`absent`/`any` — an empty object is a typo-shaped client bug and fails loudly, the same reasoning that put `deny_unknown_fields` on these params.

13. **Attachment tree rows carry no stored revision — the Supersedes-#10 sentence claiming otherwise is withdrawn.** The merged pre-task writes `content_revision` NULL for every tree row and records that as a compatibility divergence; CAS never depended on stored revisions (correction #8 pins hashing at mutation time), and storing sometimes-hashes would give the column two meanings plus an upsert-preservation subtlety on the watcher path. `snapshot_tree` serves `revision` only for `note` entries. The column remains, so a later phase can fill it deliberately. (Flagged for the maintainer's review at checkpoint 4 — this correction rules against a spec sentence he has not yet seen challenged.)

## Corrections from execution (2026-09-08, agent-recorded)

14. **The rename crash state is a self-describing placeholder, not "visible as unresolved references" — the Rename link repair paragraph's crash sentence is superseded.** That sentence described a mid-burst crash as leaving referrers pointing at the new path of a note that still sits at the old one, "visible as unresolved references that self-heal when the client retries". The shipped order is stronger than that, and had to be: review demonstrated that referrers-first plus a plain move made the forbidden state *reachable* under a shadowed basename — a crash after the move could leave a rewritten reference resolving to a **different** note, which is exactly the "resolved but wrong" outcome the original ordering existed to prevent. The repair therefore reserves the destination first (`create_atomically`, so a taken destination is `target_exists` **before** any referrer is touched), rewrites the referrers, and finally moves the note over its own reservation. Every crash window now leaves either the old state or a destination holding a self-describing placeholder: visibly incomplete, never silently misresolved, and convergent on retry. A refusal after the reservation is taken keeps it rather than releasing it under referrers that already point at it. The design's guarantee is unchanged in intent and strictly stronger in fact; the "visible as unresolved" wording is withdrawn.
