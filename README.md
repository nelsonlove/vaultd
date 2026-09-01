# vaultd

`vaultd` is an open, high-performance semantic runtime for Obsidian-compatible vaults. Obsidian is one client.

## North star

The vault's ordinary files are authoritative. `vaultd` adds semantics, safe coordination, queries, and events without converting Markdown into a proprietary database.

## Boundaries

### Filesystem persistence

Markdown, YAML properties, attachments, Canvas, Bases, and `.obsidian` remain Obsidian-compatible files.

### Semantic runtime

`vault-core` will own lossless document semantics, identities, revisions, resolution, and mutation rules.

### Protocol

`vault-protocol` exposes versioned transport-neutral requests, responses, events, and errors.

### Client runtimes

MCP, CLI, URI handling, Obsidian acceleration, the Node API shim, Swift, Elisp, Sync adapters, mobile, and e-ink clients remain consumers of the runtime.

## Workspace

- `vault-core`: semantic types and runtime ports
- `vault-protocol`: stable external contract
- `vault-server`: daemon composition and stdio proof transport

## Current milestone

### Completed: live incremental runtime and bounded event subscriptions

`vaultd` now keeps the cache live and streams what changed:

- one coordinator thread owns every mutation; reads answer from a `Send + Sync` reader over the last published generation and never wait for the writer;
- a debounced filesystem watcher drives targeted incremental reconciliation, with a periodic complete reconciliation behind it (`--no-watch`, `--watch-debounce-ms`, `--reconcile-interval-seconds`);
- `subscribe_events` and `unsubscribe` multiplex **post-commit events** onto the stdio stream — one JSON object per line, one writer, so an event can never split a response and a client that never subscribes sees byte-identical protocol version 1 output;
- `generation_committed` carries the exact per-path change set, `runtime_state_changed` the runtime's observational state, and `resync_required` every case where no per-path delta describes the move;
- every queue is bounded and every overflow degrades into a `resync_required` marker rather than into silence: the registry enforces **bounded per-subscriber** queues of 64 events (`subscriber_lag`) and 1024 paths of change-set detail per generation (`oversized_change_set`);
- reconciliation is never stalled by a client — the coordinator offers notices without ever waiting and drops what will not fit, so a client that stops reading its own stdout meets backpressure and is later told `resync_required { runtime_recovered }`, rather than slowing indexing or losing a change. Subscriptions on one connection share a writer, though, so such a client does delay its peers on that connection until it resumes.

10,000- and 100,000-note synthetic benchmarks, structural work proofs, and an honest comparison against the design's timing targets are in `docs/performance/live-incremental-baseline.md`. The recommended next milestone is the MCP and CLI consumer surface over these now-stable read and event contracts.

See `docs/protocol.md` and `docs/design/live-incremental-runtime.md`.

### Completed: persistent index and daemon read API

`vaultd` now persists the semantic graph in a normalized persistent SQLite cache and serves read operations over protocol version 1:

- normalized SQLite storage outside the vault (XDG cache by default, `--index` to override), with exact source bytes, spans, resolutions, backlinks, and diagnostics as rows;
- the vault file tree indexed alongside the semantic rows: every non-hidden folder and file with its kind, size, and creation/modification timestamps, kept current on the same watcher path as the notes;
- atomic, monotonically numbered generations published by compare-and-swap; readers never observe partial state;
- normal reconciliation that trusts path/size/mtime fingerprints and reads no unchanged bodies, plus verified reconciliation that hashes every file but reparses only changed revisions;
- change detection through startup and manual reconciliation (`refresh_index`); a filesystem watcher and live events arrived with the milestone above;
- all eight indexed operations: `get_vault_info`, `list_notes`, `get_note`, `resolve_link`, `get_backlinks`, `list_references`, `get_diagnostics`, and `refresh_index`, plus `health`;
- generation-bound opaque cursors, bounded pages, and stable error codes.

See `docs/design/persistent-index-and-daemon-read-api.md`, `docs/plans/persistent-index-and-daemon-read-api-implementation.md`, `docs/protocol.md`, and `docs/performance/persistent-index-baseline.md`.

### Completed: foundation

The foundation implements semantic identity primitives, protocol versioning, and health dispatch. See `VAULTD-COMPATIBILITY.md`, `docs/protocol.md`, and `docs/adr/0001-core-language.md`.

### Completed: semantic read path

`vault-core` now scans an ordinary Obsidian vault into a read-only, in-memory semantic graph:

- exact source preservation (`SourceDocument` keeps every UTF-8 byte) and content-derived revisions;
- read-only deterministic enumeration (`FileSystemVaultSource` sorts vault paths, skips `.obsidian` and hidden directories, and bounds symlinks to the vault root);
- semantic parsing with exact byte spans for properties, aliases, headings, blocks, tags, links, embeds, and wikilinks, plus explicit structured diagnostics for malformed content;
- structural parsing with exact byte spans for **sections** (one per top-level block, with its kind and owning block identifier) and **list items** (with the line-number parent convention and raw task state), whose shapes are pinned against observed Obsidian 1.13.4 behavior through committed runtime captures — never derived from Obsidian's source (`crates/vault-core/tests/fixtures/structural/`);
- in-memory resolution with outgoing, backlink, unresolved, and ambiguous indexes (`scan_vault` → `SemanticGraph`);
- a committed compatibility fixture corpus at `fixtures/semantic-read-path/` with golden public snapshots;
- deliberately no protocol or daemon exposure, no persistence, no filesystem watching, and no mutation — the graph is a library boundary only.

## Non-goals

`vaultd` does not mutate, rename, or delete vault files, run plugins, render UI, or implement Sync in any shipped milestone so far. The persistent index is rebuildable derived state, never canonical data.

## Development

Run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`.
