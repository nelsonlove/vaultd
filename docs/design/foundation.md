# vaultd Foundation Design

## North star

`vaultd` is an open, high-performance semantic runtime for Obsidian-compatible vaults. The ordinary vault filesystem remains authoritative persistence; Obsidian is one possible client.

The foundation must make future clients possible without importing their concerns into the runtime. MCP, command-line and URI adapters, an Obsidian accelerator plugin, a Node Obsidian API shim, Swift clients, a GNU Emacs/Elisp host, Sync adapters, and mobile or e-ink clients will consume stable runtime interfaces. None of those consumers is implemented in this phase.

## Initial deliverable

The first repository revision provides:

- a concise architectural README;
- `VAULTD-COMPATIBILITY.md`, defining compatibility tiers and contracts;
- an ADR comparing Rust and Go and selecting Rust;
- a versioned, transport-neutral protocol/schema design;
- a minimal compilable native core and daemon;
- tests covering core and protocol boundary invariants.

The foundation is intentionally smaller than a usable vault server. Parsing, indexing, filesystem watching, transactions, network transports, plugins, UI, and Sync remain subsequent milestones.

## Architecture

The Rust workspace begins with three crates:

```text
crates/
  vault-core/      semantic types and runtime ports
  vault-protocol/  versioned requests, responses, events, and errors
  vault-server/    daemon composition and executable entry point
```

Parser, storage, and index behavior start as explicit modules and traits inside `vault-core`. They become separate crates only when they acquire independent dependency or release boundaries. This avoids premature crate sprawl while preventing transport or client concerns from entering the semantic model.

### Boundary 1: storage format

An Obsidian vault directory is the system of record. Markdown source, YAML properties, attachments, `.canvas`, `.base`, and `.obsidian` configuration remain ordinary files and are never replaced by a proprietary canonical database. Rebuildable indexes, caches, and journals may support the runtime later.

The storage boundary deals in paths, bytes, file metadata, and revisions. It does not decide what a wikilink means or expose client protocol shapes.

### Boundary 2: semantic model

The semantic model represents notes, paths, optional stable semantic identifiers, revisions, properties, links, headings, blocks, embeds, tags, and source spans. Source spans make future edits surgical: changing one property must not require reserializing unrelated source.

Core types do not depend on HTTP, JSON-RPC, MCP, Obsidian plugin classes, UI widgets, or Sync wire behavior.

### Boundary 3: protocol

The protocol maps stable external identifiers and operations to core capabilities. It is versioned and transport-neutral so the same contract can cross an in-process call, Unix socket, HTTP connection, FFI boundary, or remote link.

The initial schema defines envelopes and representative operations for health, vault information, note retrieval, link resolution, semantic mutation, transactions, and subscriptions. Only health is wired end to end in the initial executable; other operations document reserved contract shapes without claiming implementation.

### Boundary 4: plugin API

Obsidian API compatibility is a client-side facade over the protocol, not part of `vault-core`. A future Node package may expose `App`, `Vault`, `MetadataCache`, and non-UI portions of `FileManager`. Headless plugin execution and DOM/editor compatibility remain separate milestones.

### Boundary 5: UI runtime

Desktop, Swift, mobile, web, and e-ink presentation are clients. The runtime exposes semantic objects, queries, mutations, and events; it does not expose pane layout or assume CodeMirror, Electron, WebKit, SwiftUI, or any refresh model.

### Boundary 6: synchronization

Sync adapters translate external blobs, revisions, conflicts, and tombstones into generic runtime operations. Undocumented Obsidian Sync behavior must not leak into the semantic core. Git, WebDAV, and other adapters can use the same boundary later.

## Data flow

The future read path is:

```text
filesystem -> lossless parse -> semantic model -> rebuildable index -> protocol -> client
```

The future mutation path is:

```text
client intent
  -> protocol validation
  -> expected-revision validation
  -> semantic mutation
  -> source-span patch
  -> journal
  -> atomic filesystem commit
  -> index update
  -> event publication
```

External filesystem changes follow the same semantic update path beginning at parsing. Filesystem watchers provide latency; reconciliation provides correctness.

## Identity and revisions

The runtime must work with any ordinary Obsidian vault and therefore cannot require custom frontmatter. Its identity model distinguishes:

- an internal runtime identifier;
- the current Obsidian-compatible path;
- an optional stable semantic identifier discovered from configured metadata.

All mutations will eventually accept an expected file or vault revision. Revision mismatch is a conflict, never an implicit overwrite.

## Errors

Core errors describe domain failures such as invalid paths, unsupported semantics, missing objects, revision conflicts, and storage failures. Protocol errors add stable machine-readable codes, request correlation, and compatibility/version failures. Transport adapters translate protocol errors without changing their meaning.

The daemon must fail startup clearly when configuration is invalid. It must not create, rewrite, or migrate vault content merely because it was started.

## Testing strategy

The first tests establish boundary behavior rather than pretending full Obsidian semantics exist:

- core identifiers and revisions retain their values without transport dependencies;
- protocol messages round-trip through the chosen serialization;
- unsupported protocol versions are rejected deterministically;
- the composed daemon answers a health request;
- workspace crates compile and documentation examples remain valid.

Later compatibility work will add a fixture corpus for links, aliases, headings, blocks, embeds, properties, Unicode, unusual filenames, Canvas, and Bases. Each fixture will assert semantic extraction, source spans, resolution behavior, and byte-preserving mutation where relevant.

## Language decision

Rust is recommended over Go because the expected ecosystem includes an embeddable library, Swift/mobile FFI, Node bindings, native clients, and high-performance lossless parsing. Go would reduce early daemon complexity, but its runtime and FFI model are a poorer fit for sharing the same core inside client processes. The ADR records this as a reversible architectural decision: protocol stability prevents the language choice from becoming a client contract.

## Success criteria

This foundation is complete when a fresh checkout can build the full Rust workspace and run all tests; the daemon can serve the minimal health operation; the protocol rejects incompatible versions; and the documentation makes the six boundaries and compatibility promises unambiguous.

## Non-goals

This phase does not implement Markdown parsing, indexing, filesystem watching, persistent databases, mutation journaling, production network transports, MCP, CLI or URI adapters, Obsidian plugins, JavaScript plugin execution, UI, Sync, Swift bindings, Elisp integration, mobile applications, or e-ink applications.
