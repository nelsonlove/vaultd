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

### Completed: persistent index and daemon read API

`vaultd` now persists the semantic graph in a normalized persistent SQLite cache and serves read operations over protocol version 1:

- normalized SQLite storage outside the vault (XDG cache by default, `--index` to override), with exact source bytes, spans, resolutions, backlinks, and diagnostics as rows;
- atomic, monotonically numbered generations published by compare-and-swap; readers never observe partial state;
- normal reconciliation that trusts path/size/mtime fingerprints and reads no unchanged bodies, plus verified reconciliation that hashes every file but reparses only changed revisions;
- change detection through startup and manual reconciliation (`refresh_index`) — there is deliberately no filesystem watcher yet; always-live watching and events are the next milestone;
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
- in-memory resolution with outgoing, backlink, unresolved, and ambiguous indexes (`scan_vault` → `SemanticGraph`);
- a committed compatibility fixture corpus at `fixtures/semantic-read-path/` with golden public snapshots;
- deliberately no protocol or daemon exposure, no persistence, no filesystem watching, and no mutation — the graph is a library boundary only.

## Non-goals

`vaultd` does not mutate, rename, or delete vault files, run plugins, render UI, or implement Sync in any shipped milestone so far. The persistent index is rebuildable derived state, never canonical data.

## Development

Run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`.
