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

This milestone does not mutate vault files, persist an index, run plugins, render UI, or implement Sync.

## Development

Run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`.
