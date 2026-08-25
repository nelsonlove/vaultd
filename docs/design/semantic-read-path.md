# vaultd Semantic Read Path Design

## Status

Approved direction for the phase following the foundation milestone.

## Summary

This phase turns an ordinary Obsidian vault into a read-only, in-memory semantic graph. It scans Markdown files, preserves their exact UTF-8 source, extracts Obsidian-relevant semantics with byte spans, resolves links deterministically, and exposes graph queries through a Rust API.

The phase stops at the `vault-core` boundary. It does not add SQLite, filesystem watching, mutations, daemon vault loading, or new protocol operations.

## Goals

- Read a vault without modifying any file or configuration.
- Preserve every Markdown source byte, including line endings and formatting.
- Extract frontmatter properties, aliases, headings, block identifiers, Markdown links, wikilinks, embeds, and tags.
- Attach an exact byte span to every extracted semantic element.
- Build deterministic outgoing-link, backlink, unresolved-link, and ambiguous-link indexes in memory.
- Return partial results with explicit diagnostics instead of silently dropping malformed notes.
- Establish a committed compatibility fixture corpus that can grow with observed Obsidian behavior.

## Non-goals

This phase does not:

- edit, create, rename, or delete vault files;
- serialize Markdown or YAML;
- persist an index or cache;
- watch the filesystem or reconcile changes;
- expose graph operations through `vault-protocol` or `vault-server`;
- implement search, Bases evaluation, Canvas semantics, attachments, transactions, journaling, plugins, UI, Sync, FFI, mobile, or e-ink clients;
- claim complete compatibility for undocumented or ambiguous Obsidian link-resolution behavior.

## Compatibility baseline

The phase implements the documented storage forms rather than inferring behavior from Obsidian's UI:

- Internal links may use wikilink or Markdown syntax, may include vault-root folder paths, and may target headings or block identifiers.
- Wikilink display text follows the `[[target|display]]` form.
- Embeds are links prefixed with `!` and retain the same target/subpath structure.
- Properties live in a YAML-compatible block beginning at the first byte of the file; `aliases` and `tags` are list-valued default properties.
- Tags may contain letters, numbers, underscores, hyphens, forward slashes, and supported Unicode characters, must contain a non-numeric character, and compare case-insensitively in Obsidian.
- Block identifiers consist of Latin letters, numbers, and dashes and may follow a paragraph or appear on a separate line for a structured block.

Primary references:

- [Obsidian internal links](https://obsidian.md/help/links)
- [Obsidian properties](https://obsidian.md/help/properties)
- [Obsidian aliases](https://obsidian.md/help/aliases)
- [Obsidian tags](https://obsidian.md/help/tags)
- [Obsidian embeds](https://obsidian.md/help/embeds)

Where documentation does not define resolution precedence, the runtime returns an ambiguous result rather than choosing an arbitrary file. A later compatibility corpus may promote an observed behavior into the contract.

## Architectural decisions

### 1. Keep the phase inside `vault-core`

The semantic read path is one cohesive library boundary. It begins as focused modules in `vault-core`, matching the foundation decision to split crates only when independent dependency or release boundaries exist.

```text
crates/vault-core/src/
  source.rs       exact source text, digest, and byte spans
  diagnostic.rs   structured non-fatal findings
  property.rs     transport-independent property values
  semantic.rs     extracted note elements and link targets
  frontmatter.rs  fenced property-block extraction
  markdown.rs     CommonMark/GFM analysis and Obsidian extensions
  parse.rs        one-source-document orchestration
  vault_source.rs read-only vault enumeration and reads
  resolver.rs     deterministic link candidate resolution
  graph.rs        immutable graph construction and queries
```

No module in this list depends on `vault-protocol` or `vault-server`.

### 2. Source text is primary

`SourceDocument` owns the exact UTF-8 text, its validated `VaultPath`, and a content-derived `Revision`. `SourceSpan` remains a half-open byte range. Every semantic value that originates in source is stored as `Spanned<T>`.

The invariant is:

```text
document.text()[element.span()] == element.raw_source()
```

Line and column values are derived for diagnostics only. Byte offsets are canonical because future mutations must patch source without reformatting unrelated content.

Invalid UTF-8 is a file diagnostic and the file is excluded from semantic parsing. The scanner never normalizes line endings or rewrites a byte-order mark.

### 3. Use robust positional parsers behind internal adapters

The CommonMark/GFM adapter uses the `markdown` crate's positional mdast. Its implementation accounts for source bytes, supplies start/end offsets, is pure Rust, and is exercised by CommonMark, GFM, coverage, and fuzz suites. Obsidian constructs not represented by mdast are scanned only inside source ranges classified as ordinary text, preventing false wikilinks and tags inside code spans or fenced code blocks.

The frontmatter adapter uses a YAML 1.2 parser that exposes marked nodes and source spans. `saphyr` is the intended implementation because its `MarkedYaml` nodes retain parser spans. The core converts parser-specific nodes into its own `PropertyValue` and `Spanned<Property>` types; third-party parser types do not cross the module boundary.

Both adapters are implementation details. Fixture behavior, not a third-party AST, is the stable contract.

Primary parser references:

- [`markdown` positional mdast](https://github.com/wooorm/markdown-rs)
- [`markdown::unist::Position`](https://docs.rs/markdown/latest/markdown/unist/struct.Position.html)
- [`saphyr::MarkedYaml`](https://docs.rs/saphyr/latest/saphyr/struct.MarkedYaml.html)

### 4. Model semantics without transport types

The public read model contains:

```text
ParsedNote
  path
  revision
  source
  properties[]
  aliases[]
  headings[]
  blocks[]
  tags[]
  references[]
  diagnostics[]
```

`PropertyValue` supports null, Boolean, integer, floating-point, string, sequence, and mapping values without exposing a YAML library type. Each property retains the full key/value span, key span, and value span when the parser supplies them.

`Reference` records:

- syntax kind: Markdown link, wikilink, Markdown embed, or wiki embed;
- origin: body or property value;
- raw target and optional display text;
- optional heading or block subpath;
- exact full-reference and target spans.

`Heading`, `BlockId`, `Tag`, `Alias`, and `Property` preserve original spelling. Any comparison key is stored separately so compatibility normalization never destroys source representation.

### 5. Make scanning read-only by construction

`VaultSource` is a read-only port with only enumeration and read operations. `FileSystemVaultSource` implements it for a directory. There is no write method, mutation trait, or filesystem handle exposed through `SemanticGraph`.

The filesystem scanner:

- enumerates `.md` files in deterministic vault-path order;
- excludes `.obsidian`, `.trash`, and hidden directories;
- does not follow directory symlinks;
- includes a symlinked Markdown file only when its canonical target remains inside the vault root;
- emits a diagnostic for an unreadable file, invalid UTF-8, or a symlink escaping the root;
- does not parse user-configured Obsidian exclusion patterns in this phase.

The content-derived revision is stable for identical bytes and changes whenever the bytes change. Filesystem timestamps are not semantic identity.

## Parsing behavior

### Frontmatter

A property block is recognized only when an opening `---` fence begins at the first byte and a valid closing fence follows. The entire fenced region retains a source span. A top-level mapping becomes properties in source order.

Malformed frontmatter produces a diagnostic. The body parser still analyzes content after the detected closing fence. If no closing fence exists, the file is parsed as Markdown and the unterminated-frontmatter diagnostic covers the opening fence.

The `aliases` and `tags` default properties are projected into `Alias` and `Tag` records while remaining ordinary properties. Wikilinks inside quoted text or list property values become property-origin references.

Nested properties remain representable as `PropertyValue::Mapping`, but this phase makes no Obsidian UI-compatibility claim for them because Obsidian documents nested properties as unsupported.

### Markdown and Obsidian extensions

The CommonMark/GFM adapter extracts headings and Markdown links/embeds with parser-provided positions. An Obsidian extension scanner processes only ordinary-text ranges for:

- `[[target]]` and `![[target]]`;
- optional `|display` text;
- `#heading` and `#^block-id` subpaths;
- inline tags and nested tags;
- paragraph and standalone block identifiers.

Fenced code, inline code, escaped syntax, and HTML blocks do not emit Obsidian references or tags unless a compatibility fixture explicitly establishes that Obsidian does so.

Markdown link destinations are percent-decoded for resolution while preserving their encoded raw target and span. External schemes and fragment-only external links remain references but are classified as non-vault targets and excluded from backlinks.

## Resolution and graph construction

Graph construction is a separate pass over parsed notes. Parsing never needs global vault state.

Each vault reference resolves through an ordered candidate pipeline:

1. an exact normalized vault path, with optional `.md` omission;
2. an explicit relative path normalized against the source note's parent;
3. a unique case-insensitive Markdown filename or stem match;
4. otherwise unresolved or ambiguous, with all candidates retained.

The resolver never chooses arbitrarily among multiple candidates. Heading and block subpaths are resolved only after the target file resolves. A missing heading or block produces a broken-subpath result without turning the file target into unresolved.

Aliases are metadata and suggestion inputs, not implicit link destinations: Obsidian writes an alias selection as display text on a link to the real note path.

`SemanticGraph` is immutable after construction and provides deterministic queries for:

- note by exact path;
- parsed semantics for one note;
- outgoing vault references;
- backlinks;
- unresolved references;
- ambiguous references and their candidates;
- graph-wide diagnostics.

All returned collections use stable vault-path and source-span ordering.

## Data flow

```text
vault root
  -> FileSystemVaultSource.enumerate_markdown()
  -> SourceDocument(path, exact bytes, content revision)
  -> frontmatter + Markdown + Obsidian-extension adapters
  -> ParsedNote + file diagnostics
  -> path/name candidate indexes
  -> reference resolution
  -> immutable SemanticGraph + scan diagnostics
```

The top-level result is `ScanReport`, containing a graph and diagnostics. Only an invalid or inaccessible vault root prevents a report from being produced.

## Diagnostics and failure handling

Diagnostics have a stable code, severity, message, vault path, and optional byte span. Initial codes cover:

- inaccessible vault root;
- unreadable file;
- invalid UTF-8;
- symlink outside the vault;
- unterminated or malformed frontmatter;
- unsupported property key/value shape;
- malformed wikilink, tag, or block identifier;
- unresolved or ambiguous file target;
- missing heading or block subpath.

Malformed content must never panic the process. Parser adapters return diagnostics and continue when recovery is possible. The fixture suite includes malformed examples, and fuzz/property tests assert that arbitrary UTF-8 input either produces a `ParsedNote` or a structured error without panicking.

## Compatibility fixture corpus

The corpus lives under `fixtures/semantic-read-path/` as ordinary Obsidian-compatible files plus human-readable expected results.

```text
fixtures/semantic-read-path/
  basic-vault/
    Properties and aliases.md
    Markdown links.md
    Wikilinks.md
    Headings and blocks.md
    Tags.md
    Unicode café.md
    Ambiguous/Foo.md
    Other/Foo.md
    Malformed frontmatter.md
  expected/
    parsed-notes.json
    resolution.json
    diagnostics.json
```

Golden results use public `vault-core` data-transfer snapshots rather than third-party parser debug output. Tests additionally assert that every recorded span is within bounds, lands on a UTF-8 boundary, and slices to the expected raw source.

The fixture files are never rewritten by tests. A before/after content digest assertion proves that a complete scan is read-only.

## Testing strategy

Implementation follows red-green-refactor in this order:

1. source documents, revisions, and span invariants;
2. frontmatter boundary detection and marked property extraction;
3. CommonMark headings and Markdown references;
4. wikilinks, embeds, tags, blocks, and property-origin links;
5. deterministic filesystem scanning and safety boundaries;
6. exact-path, relative-path, unique-name, ambiguous, and subpath resolution;
7. graph queries and the end-to-end compatibility corpus;
8. arbitrary-input no-panic tests and full workspace verification.

No wall-clock performance threshold is used in CI. The design requires linear parsing in total source bytes and index-backed candidate lookup rather than repeated whole-vault scans per link.

## Success criteria

The phase is complete when:

- a fixture vault scans into a deterministic `SemanticGraph` through the public Rust API;
- properties, aliases, headings, blocks, links, embeds, and tags have exact source spans;
- exact, relative, unique-name, ambiguous, unresolved, heading, and block targets produce their specified results;
- malformed notes yield structured diagnostics without aborting the scan;
- arbitrary UTF-8 parser inputs do not panic;
- scanning leaves every fixture byte unchanged;
- all workspace tests, formatting, Clippy, and documentation checks pass;
- `vault-protocol` and `vault-server` have no semantic read-path additions.

## Deferred follow-on

The next architectural phase may persist the graph in SQLite, reconcile watcher events, and expose read operations through the versioned protocol. That phase consumes `ParsedNote`, `SemanticGraph`, and diagnostics; it does not change the storage-authority decision.
