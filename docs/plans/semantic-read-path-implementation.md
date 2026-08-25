# vaultd Semantic Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan an ordinary Obsidian vault into a deterministic, read-only in-memory semantic graph with exact source spans, explicit diagnostics, link resolution, and compatibility fixtures.

**Architecture:** Extend only `vault-core`: immutable source documents feed positional frontmatter and Markdown adapters, then an Obsidian-extension scanner, deterministic filesystem reader, resolver, and graph builder. Parser-specific types remain private; public semantic types remain transport-independent and preserve exact source spelling and byte ranges.

**Tech Stack:** Rust 1.85 or newer, edition 2024, Cargo resolver 3, `markdown` 1.0, `saphyr` 0.0.12, `blake3`, `percent-encoding`, `regex`, `serde_json`, `tempfile`, `walkdir`, and `proptest`.

## Global Constraints

- Read `docs/design/foundation.md`, `docs/design/semantic-read-path.md`, and `docs/plans/foundation-implementation.md` in full before editing.
- Start only after the foundation work has been reviewed and merged onto `main`. Confirm that version validation precedes method dispatch and that a future-version request with an unknown method receives `incompatible_version` without killing the daemon.
- Use the `superpowers:using-git-worktrees` skill and create a fresh worktree from the updated `main`; do not reuse the foundation worktree.
- Follow strict red-green-refactor: add each behavioral test first, run the focused test and confirm the intended failure, then write the minimum production code.
- Keep this milestone inside `vault-core`, plus compatibility fixtures and the two contract documents named in Task 8. Do not add semantic operations to `vault-protocol` or `vault-server` yet.
- The ordinary Obsidian vault filesystem remains authoritative persistence. Every production filesystem operation in this milestone is read-only.
- Preserve source as exact UTF-8 bytes represented by `Arc<str>`. Every public `SourceSpan` uses half-open byte offsets into that exact source; do not normalize line endings, Unicode, or Markdown spelling.
- Keep `markdown` and `saphyr` node types private to their adapters. Public types must not expose parser-specific ASTs, JSON, transport envelopes, UI state, or synchronization behavior.
- Do not implement filesystem watching, SQLite, incremental invalidation, mutations, journaling, transactions, query execution, protocol operations, daemon vault loading, MCP, CLI/URI adapters, the Obsidian accelerator plugin, the Node API shim, Swift/Elisp hosts, Sync, UI, mobile, or e-ink behavior.
- Do not add a GitHub remote, push, open a pull request, or merge without the maintainer's authorization.
- Leave the pre-existing untracked `.permission-check` file untouched and uncommitted.
- Use the exact scoped commit message specified for each task.

## Preflight Gate

- [ ] **Step 1: Confirm the foundation is on `main` and the worktree is clean enough to branch**

Run from the permanent checkout:

```bash
cd ~/repos/system/vaultd
git status --short --branch
git worktree list
git log --oneline --decorate -12
cargo test --workspace --all-targets
rg -n "validate_version|incompatible_version|future-version" crates docs/protocol.md
```

Expected:

- `main` contains the foundation commits and the semantic-read-path design.
- All workspace tests pass.
- The server performs envelope parsing and version validation before typed method decoding.
- Only the known `.permission-check` file is untracked; do not stage it.

If any expectation fails, stop and reconcile the foundation before creating the next worktree.

- [ ] **Step 2: Create the isolated implementation worktree**

Use `superpowers:using-git-worktrees` to create a branch such as `feat/semantic-read-path` from the updated `main`. In the new worktree, re-run:

```bash
git status --short --branch
cargo test --workspace --all-targets
```

Expected: the new worktree is clean and the foundation suite passes before semantic work begins.

## Planned File Map

```text
Cargo.toml                                      Shared dependency versions
Cargo.lock                                      Updated reproducible dependency resolution
README.md                                       Completed semantic-read-path milestone summary
VAULTD-COMPATIBILITY.md                         Evidence-backed Tier 1 status updates
crates/vault-core/Cargo.toml                    Core parser, hashing, walk, and test dependencies
crates/vault-core/src/lib.rs                    Public semantic-read-path exports
crates/vault-core/src/domain.rs                 Ordered/hashable path, revision, and span primitives
crates/vault-core/src/source.rs                 Immutable exact source documents and spanned values
crates/vault-core/src/diagnostic.rs             Structured non-fatal scan diagnostics
crates/vault-core/src/property.rs               Ordered, source-spanned YAML property model
crates/vault-core/src/semantic.rs               Headings, blocks, tags, aliases, and references
crates/vault-core/src/frontmatter.rs             Private marked-YAML adapter
crates/vault-core/src/markdown.rs                Private positional CommonMark/GFM adapter
crates/vault-core/src/obsidian.rs                Private wikilink/tag/block extension scanner
crates/vault-core/src/parse.rs                   Per-note semantic parse composition
crates/vault-core/src/vault_source.rs            Read-only vault source abstraction and filesystem adapter
crates/vault-core/src/resolver.rs                Deterministic Obsidian-style target resolution
crates/vault-core/src/graph.rs                   Immutable semantic graph and reverse indexes
crates/vault-core/tests/source_documents.rs      Source preservation and revision tests
crates/vault-core/tests/semantic_model.rs        Parser-independent public model tests
crates/vault-core/tests/frontmatter.rs           Marked property, alias, and tag tests
crates/vault-core/tests/markdown.rs              Markdown heading/link/embed positional tests
crates/vault-core/tests/obsidian_syntax.rs       Wikilink, tag, block, and combined parse tests
crates/vault-core/tests/vault_source.rs          Deterministic read-only filesystem scan tests
crates/vault-core/tests/resolution.rs            Resolution precedence and subpath tests
crates/vault-core/tests/semantic_graph.rs        Fixture graph and public query tests
crates/vault-core/tests/no_panics.rs             Arbitrary UTF-8 parser robustness test
fixtures/semantic-read-path/                    Versioned Obsidian compatibility corpus and snapshots
```

---

### Task 1: Exact source documents and stable revisions

**Files:**

- Modify: `Cargo.toml`
- Modify: `crates/vault-core/Cargo.toml`
- Modify: `crates/vault-core/src/domain.rs`
- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/source.rs`
- Create: `crates/vault-core/tests/source_documents.rs`
- Update through Cargo: `Cargo.lock`

**Interfaces:**

- Consumes: foundation `VaultPath`, `Revision`, `SourceSpan`, and `DomainError`.
- Produces: `SourceDocument`, `SourceError`, and `Spanned<T>`; makes core domain keys orderable and hashable for deterministic indexes.

- [ ] **Step 1: Add the shared dependencies**

Append to `[workspace.dependencies]` in `Cargo.toml`:

```toml
blake3 = "1.8"
markdown = "1.0"
percent-encoding = "2.3"
proptest = "1.9"
regex = "1.12"
saphyr = { version = "0.0.12", default-features = false }
tempfile = "3.23"
walkdir = "2.5"
```

Add to `crates/vault-core/Cargo.toml`:

```toml
[dependencies]
blake3.workspace = true
markdown.workspace = true
percent-encoding.workspace = true
regex.workspace = true
saphyr.workspace = true
thiserror.workspace = true
walkdir.workspace = true

[dev-dependencies]
proptest.workspace = true
serde_json.workspace = true
tempfile.workspace = true
```

Keep the existing `thiserror.workspace = true` entry only once.

- [ ] **Step 2: Make domain keys usable in deterministic maps**

In `crates/vault-core/src/domain.rs`, add `Hash`, `Ord`, and `PartialOrd` to `VaultPath`, `NoteId`, and `Revision`. Add `Copy`, `Hash`, `Ord`, and `PartialOrd` to `SourceSpan`. Do not change validation behavior or make the inner strings public.

- [ ] **Step 3: Write the failing exact-source tests**

Create `crates/vault-core/tests/source_documents.rs`:

```rust
use vault_core::{SourceDocument, SourceError, SourceSpan, VaultPath};

fn path() -> VaultPath {
    VaultPath::new("Notes/Unicode.md").expect("valid path")
}

#[test]
fn preserves_utf8_and_crlf_bytes_exactly() {
    let text = "---\r\ntitle: café\r\n---\r\n# Héllo\r\n";
    let document = SourceDocument::new(path(), text);

    assert_eq!(document.text(), text);
    let start = text.find("café").expect("fixture contains value");
    let span = SourceSpan::new(start, start + "café".len()).expect("valid span");
    assert_eq!(document.slice(span), Some("café"));
}

#[test]
fn revision_is_stable_for_identical_bytes_and_changes_with_content() {
    let first = SourceDocument::new(path(), "same");
    let second = SourceDocument::new(path(), "same");
    let changed = SourceDocument::new(path(), "different");

    assert_eq!(first.revision(), second.revision());
    assert_ne!(first.revision(), changed.revision());
    assert!(first.revision().as_str().starts_with("blake3:"));
}

#[test]
fn rejects_invalid_utf8_without_lossy_conversion() {
    assert!(matches!(
        SourceDocument::from_utf8(path(), vec![0xff, 0xfe]),
        Err(SourceError::InvalidUtf8 { .. })
    ));
}

#[test]
fn slice_rejects_non_utf8_boundaries() {
    let document = SourceDocument::new(path(), "é");
    let middle = SourceSpan::new(1, 2).expect("ordered byte range");
    assert_eq!(document.slice(middle), None);
}
```

- [ ] **Step 4: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test source_documents
```

Expected: compilation fails because the source-document API does not exist.

- [ ] **Step 5: Implement the immutable source boundary**

Create `crates/vault-core/src/source.rs` with this public shape:

```rust
use std::sync::Arc;

use thiserror::Error;

use crate::{Revision, SourceSpan, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceDocument {
    path: VaultPath,
    revision: Revision,
    text: Arc<str>,
}

impl SourceDocument {
    pub fn new(path: VaultPath, text: impl Into<Arc<str>>) -> Self {
        let text = text.into();
        let digest = blake3::hash(text.as_bytes());
        let revision = Revision::new(format!("blake3:{digest}"))
            .expect("a formatted BLAKE3 revision is non-empty");
        Self { path, revision, text }
    }

    pub fn from_utf8(path: VaultPath, bytes: Vec<u8>) -> Result<Self, SourceError> {
        let text = String::from_utf8(bytes)
            .map_err(|error| SourceError::InvalidUtf8 { path: path.clone(), error })?;
        Ok(Self::new(path, text))
    }

    pub fn path(&self) -> &VaultPath { &self.path }
    pub fn revision(&self) -> &Revision { &self.revision }
    pub fn text(&self) -> &str { &self.text }

    pub fn slice(&self, span: SourceSpan) -> Option<&str> {
        self.text.get(span.start()..span.end())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spanned<T> {
    pub value: T,
    pub span: SourceSpan,
}

impl<T> Spanned<T> {
    pub fn new(value: T, span: SourceSpan) -> Self { Self { value, span } }
}

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("{path:?} is not valid UTF-8")]
    InvalidUtf8 {
        path: VaultPath,
        #[source]
        error: std::string::FromUtf8Error,
    },
}
```

Declare `mod source;` and re-export `SourceDocument`, `SourceError`, and `Spanned` from `crates/vault-core/src/lib.rs`.

- [ ] **Step 6: Verify and commit Task 1**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test source_documents
cargo test -p vault-core --test domain_types
git diff --check
git add Cargo.toml Cargo.lock crates/vault-core
git diff --cached --check
git commit -m "feat(core): add exact source documents"
```

Expected: all focused tests pass; `.permission-check` is not staged.

---

### Task 2: Parser-independent semantic model and diagnostics

**Files:**

- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/diagnostic.rs`
- Create: `crates/vault-core/src/property.rs`
- Create: `crates/vault-core/src/semantic.rs`
- Create: `crates/vault-core/tests/semantic_model.rs`

**Interfaces:**

- Consumes: Task 1 `SourceDocument`, `Spanned<T>`, `VaultPath`, and `SourceSpan`.
- Produces: the parser-independent public vocabulary consumed by all remaining tasks.

- [ ] **Step 1: Write the failing semantic-model tests**

Create `crates/vault-core/tests/semantic_model.rs`:

```rust
use vault_core::{
    Alias, Diagnostic, DiagnosticCode, ParsedNote, Property, PropertyValue, Reference,
    ReferenceKind, ReferenceOrigin, Severity, SourceDocument, SourceSpan, Spanned, Subpath, Tag,
    VaultPath,
};

#[test]
fn public_model_preserves_source_spelling_and_order() {
    let path = VaultPath::new("Notes/Example.md").expect("valid path");
    let source = SourceDocument::new(path, "aliases: [Alpha, Beta]");
    let alpha = SourceSpan::new(10, 15).expect("valid span");
    let beta = SourceSpan::new(17, 21).expect("valid span");

    let parsed = ParsedNote {
        aliases: vec![
            Alias { value: "Alpha".into(), span: alpha },
            Alias { value: "Beta".into(), span: beta },
        ],
        ..ParsedNote::empty(source)
    };

    assert_eq!(parsed.aliases[0].value, "Alpha");
    assert_eq!(parsed.aliases[1].value, "Beta");
}

#[test]
fn property_values_preserve_nested_sequence_spans() {
    let value = PropertyValue::Sequence(vec![Spanned::new(
        PropertyValue::String("project".into()),
        SourceSpan::new(8, 15).expect("valid span"),
    )]);
    let property = Property {
        key: Spanned::new("tags".into(), SourceSpan::new(0, 4).expect("valid span")),
        value: Spanned::new(value, SourceSpan::new(6, 16).expect("valid span")),
        span: SourceSpan::new(0, 16).expect("valid span"),
    };

    assert_eq!(property.key.value, "tags");
}

#[test]
fn references_distinguish_syntax_origin_and_subpath() {
    let reference = Reference {
        kind: ReferenceKind::Wikilink,
        origin: ReferenceOrigin::Body,
        raw_target: "Plan#^decision".into(),
        file_target: Some("Plan".into()),
        subpath: Some(Subpath::Block("decision".into())),
        display: None,
        span: SourceSpan::new(4, 22).expect("valid span"),
        target_span: SourceSpan::new(6, 20).expect("valid target span"),
    };

    assert_eq!(reference.subpath, Some(Subpath::Block("decision".into())));
}

#[test]
fn diagnostics_are_structured_and_source_addressable() {
    let diagnostic = Diagnostic::new(
        DiagnosticCode::MalformedWikilink,
        Severity::Warning,
        "unclosed wikilink",
    )
    .with_path(VaultPath::new("Broken.md").expect("valid path"))
    .with_span(SourceSpan::new(0, 8).expect("valid span"));

    assert_eq!(diagnostic.code, DiagnosticCode::MalformedWikilink);
    assert_eq!(diagnostic.span.expect("span").start(), 0);
}

#[test]
fn tags_preserve_original_spelling() {
    let tag = Tag {
        value: "Project/PhaseOne".into(),
        comparison_key: "project/phaseone".into(),
        span: SourceSpan::new(0, 17).expect("valid span"),
    };
    assert_eq!(tag.value, "Project/PhaseOne");
}
```

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test semantic_model
```

Expected: compilation fails because the semantic model is not defined.

- [ ] **Step 3: Define structured diagnostics**

Create `crates/vault-core/src/diagnostic.rs`:

```rust
use crate::{SourceSpan, VaultPath};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Severity { Warning, Error }

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DiagnosticCode {
    InaccessibleVaultRoot,
    UnreadableFile,
    InvalidUtf8,
    SymlinkOutsideVault,
    UnterminatedFrontmatter,
    MalformedFrontmatter,
    UnsupportedPropertyShape,
    MarkdownParseError,
    MalformedWikilink,
    MalformedTag,
    MalformedBlockId,
    UnresolvedReference,
    AmbiguousReference,
    MissingHeading,
    MissingBlock,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,
    pub message: String,
    pub path: Option<VaultPath>,
    pub span: Option<SourceSpan>,
}

impl Diagnostic {
    pub fn new(code: DiagnosticCode, severity: Severity, message: impl Into<String>) -> Self {
        Self { code, severity, message: message.into(), path: None, span: None }
    }

    pub fn with_path(mut self, path: VaultPath) -> Self {
        self.path = Some(path);
        self
    }

    pub fn with_span(mut self, span: SourceSpan) -> Self {
        self.span = Some(span);
        self
    }
}
```

- [ ] **Step 4: Define ordered property values**

Create `crates/vault-core/src/property.rs`:

```rust
use crate::{SourceSpan, Spanned};

#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<Spanned<PropertyValue>>),
    Mapping(Vec<(Spanned<String>, Spanned<PropertyValue>)>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Property {
    pub key: Spanned<String>,
    pub value: Spanned<PropertyValue>,
    pub span: SourceSpan,
}
```

Do not use a hash map: YAML source order is part of the compatibility evidence.

- [ ] **Step 5: Define semantic elements and the per-note result**

Create `crates/vault-core/src/semantic.rs` with public structs whose fields remain data-only:

```rust
use crate::{Diagnostic, Property, SourceDocument, SourceSpan};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Heading { pub level: u8, pub text: String, pub span: SourceSpan }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockId { pub value: String, pub span: SourceSpan }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tag { pub value: String, pub comparison_key: String, pub span: SourceSpan }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Alias { pub value: String, pub span: SourceSpan }

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ReferenceKind { MarkdownLink, Wikilink, MarkdownEmbed, WikiEmbed }

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ReferenceOrigin { Body, Property }

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Subpath { Heading(String), Block(String) }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reference {
    pub kind: ReferenceKind,
    pub origin: ReferenceOrigin,
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<Subpath>,
    pub display: Option<String>,
    pub span: SourceSpan,
    pub target_span: SourceSpan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedNote {
    pub source: SourceDocument,
    pub properties: Vec<Property>,
    pub aliases: Vec<Alias>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockId>,
    pub tags: Vec<Tag>,
    pub references: Vec<Reference>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ParsedNote {
    pub fn empty(source: SourceDocument) -> Self {
        Self {
            source,
            properties: Vec::new(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            references: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn source_spans(&self) -> Vec<SourceSpan> {
        fn value_spans(value: &Spanned<PropertyValue>, spans: &mut Vec<SourceSpan>) {
            spans.push(value.span);
            match &value.value {
                PropertyValue::Sequence(values) => {
                    for value in values { value_spans(value, spans); }
                }
                PropertyValue::Mapping(entries) => {
                    for (key, value) in entries {
                        spans.push(key.span);
                        value_spans(value, spans);
                    }
                }
                _ => {}
            }
        }

        let mut spans = Vec::new();
        for property in &self.properties {
            spans.extend([property.span, property.key.span]);
            value_spans(&property.value, &mut spans);
        }
        spans.extend(self.aliases.iter().map(|value| value.span));
        spans.extend(self.headings.iter().map(|value| value.span));
        spans.extend(self.blocks.iter().map(|value| value.span));
        spans.extend(self.tags.iter().map(|value| value.span));
        for reference in &self.references {
            spans.extend([reference.span, reference.target_span]);
        }
        spans.sort_unstable();
        spans.dedup();
        spans
    }
}
```

Import `PropertyValue` and `Spanned` into `semantic.rs` for this traversal.

Declare the three modules in `lib.rs` and re-export all public types used by the test.

- [ ] **Step 6: Verify and commit Task 2**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test semantic_model
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/semantic_model.rs
git diff --cached --check
git commit -m "feat(core): define semantic read model"
```

Expected: the semantic model tests and all earlier core tests pass.

---

### Task 3: Source-spanned YAML frontmatter

**Files:**

- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/frontmatter.rs`
- Create: `crates/vault-core/tests/frontmatter.rs`

**Interfaces:**

- Consumes: Task 2 `Property`, `PropertyValue`, `Alias`, `Tag`, and diagnostics.
- Produces: crate-private `FrontmatterParse` and `parse_frontmatter(&SourceDocument)` for Task 5.

- [ ] **Step 1: Write the failing frontmatter tests**

Create `crates/vault-core/tests/frontmatter.rs` as an integration test of the eventual public `parse_note` function. Begin with these cases:

```rust
use vault_core::{DiagnosticCode, PropertyValue, SourceDocument, VaultPath, parse_note};

fn parse(text: &str) -> vault_core::ParsedNote {
    let path = VaultPath::new("Properties.md").expect("valid path");
    parse_note(SourceDocument::new(path, text))
}

#[test]
fn parses_properties_aliases_and_tags_with_exact_spans() {
    let text = "---\r\ntitle: Café\r\naliases: [Coffee, Java]\r\ntags:\r\n  - Project/PhaseOne\r\nscore: 4.5\r\n---\r\nBody\r\n";
    let parsed = parse(text);

    assert_eq!(parsed.properties.len(), 4);
    assert_eq!(parsed.aliases.iter().map(|a| a.value.as_str()).collect::<Vec<_>>(), ["Coffee", "Java"]);
    assert_eq!(parsed.tags[0].value, "Project/PhaseOne");
    assert_eq!(parsed.tags[0].comparison_key, "project/phaseone");
    assert_eq!(
        parsed.source.slice(parsed.aliases[0].span),
        Some("Coffee")
    );
    assert!(matches!(parsed.properties[3].value.value, PropertyValue::Float(value) if value == 4.5));
    assert!(parsed.diagnostics.is_empty());
}

#[test]
fn malformed_closed_frontmatter_recovers_the_markdown_body() {
    let text = "---\ntags: [broken\n---\n# Recoverable\n";
    let parsed = parse(text);

    assert!(parsed.source.text().ends_with("# Recoverable\n"));
    assert!(parsed.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == DiagnosticCode::MalformedFrontmatter
    }));
}

#[test]
fn unterminated_frontmatter_is_diagnosed_without_discarding_source() {
    let text = "---\ntitle: Never closed\n# Still source\n";
    let parsed = parse(text);

    assert_eq!(parsed.source.text(), text);
    assert!(parsed.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == DiagnosticCode::UnterminatedFrontmatter
    }));
}
```

Add a private `#[cfg(test)]` test beside `parse_frontmatter` that parses the malformed-closed fixture and asserts `body_start == text.find("# Recoverable").unwrap()`. This directly proves recovery before the Markdown adapter exists.

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test frontmatter
```

Expected: the test fails because marked frontmatter is not parsed.

- [ ] **Step 3: Detect frontmatter fences without normalizing the source**

In `crates/vault-core/src/frontmatter.rs`, define:

```rust
pub(crate) struct FrontmatterParse {
    pub properties: Vec<Property>,
    pub aliases: Vec<Alias>,
    pub tags: Vec<Tag>,
    pub body_start: usize,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn parse_frontmatter(document: &SourceDocument) -> FrontmatterParse;
```

Fence rules for this milestone:

- Recognize an opening fence only at byte 0 when the first line is exactly `---\n` or `---\r\n`.
- Find the first later line whose content, excluding `\n` and an optional preceding `\r`, is exactly `---`.
- Record the YAML payload start/end and `body_start` as offsets into the original document.
- If there is no opening fence, return empty frontmatter with `body_start = 0`.
- If the opening fence has no closing fence, return `UnterminatedFrontmatter`, no properties, and `body_start = 0`; the Markdown adapter may still inspect all exact source.

- [ ] **Step 4: Convert marked YAML nodes into the public property model**

Use `saphyr::{LoadableYamlNode, MarkedYaml, Scalar, YamlData}` and call `MarkedYaml::load_from_str` on the exact YAML payload. Keep `MarkedYaml` private.

Implement private conversion helpers with this behavior:

```rust
fn span_from_marked(node: &MarkedYaml, payload_start: usize) -> SourceSpan;
fn convert_value(node: &MarkedYaml, payload_start: usize) -> Result<Spanned<PropertyValue>, Diagnostic>;
fn convert_mapping(root: &MarkedYaml, payload_start: usize) -> Result<Vec<Property>, Diagnostic>;
```

Map `YamlData` as follows:

- `Scalar::Null`, `Boolean`, `Integer`, `FloatingPoint`, and `String` map to their matching `PropertyValue` variant.
- Sequences map recursively while retaining element spans and order.
- Mappings map recursively to ordered key/value pairs. Non-string mapping keys produce `UnsupportedPropertyShape` instead of a panic.
- Tagged values unwrap and convert their value while retaining its span.
- Alias or bad-value nodes produce `UnsupportedPropertyShape`.
- Add the YAML payload's absolute byte offset to each marked span.
- Require exactly one top-level mapping document. An empty payload yields no properties; any other top-level shape yields `UnsupportedPropertyShape` and no projected aliases/tags.

If the YAML loader fails, emit `MalformedFrontmatter`, leave properties/aliases/tags empty, retain the computed `body_start`, and continue.

- [ ] **Step 5: Derive aliases and tags without erasing properties**

After converting the root mapping:

- Match property keys `aliases` and `alias` case-insensitively.
- Match property keys `tags` and `tag` case-insensitively.
- Accept a scalar string or a sequence of strings. Diagnose other shapes with `UnsupportedPropertyShape` while retaining the original property.
- For each property tag, remove one optional leading `#` for semantic validation, require at least one non-numeric character, and apply the same allowed-character/segment rules as body tags. Emit `MalformedTag` for an invalid tag while retaining the property itself.
- Store the validated tag text without a syntactic leading `#` in `Tag::value` while preserving its source case; set `Tag::comparison_key` with Unicode lowercase. The scalar's `SourceSpan` remains the raw-source authority, including any YAML quoting or syntactic `#` prefix.

- [ ] **Step 6: Compose enough of `parse_note` to make the frontmatter tests green**

Create `crates/vault-core/src/parse.rs` if it does not yet exist. Its stable public signature is:

```rust
pub fn parse_note(source: SourceDocument) -> ParsedNote;
```

For this task, copy frontmatter properties, aliases, tags, and diagnostics into `ParsedNote`. Leave the remaining semantic collections empty; Task 4 will add the only heading parser.

- [ ] **Step 7: Verify and commit Task 3**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test frontmatter
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/frontmatter.rs
git diff --cached --check
git commit -m "feat(core): parse marked frontmatter properties"
```

Expected: valid CRLF frontmatter, malformed closed frontmatter, and unterminated frontmatter all behave as specified; earlier tests remain green.

---

### Task 4: Positional CommonMark/GFM semantics

**Files:**

- Modify: `crates/vault-core/src/parse.rs`
- Create: `crates/vault-core/src/markdown.rs`
- Create: `crates/vault-core/tests/markdown.rs`

**Interfaces:**

- Consumes: Task 3 `body_start` and Task 2 semantic types.
- Produces: crate-private `MarkdownParse`, including ordinary-text ranges that constrain Task 5's extension scanner.

- [ ] **Step 1: Write the failing positional Markdown tests**

Create `crates/vault-core/tests/markdown.rs`:

```rust
use vault_core::{ReferenceKind, ReferenceOrigin, SourceDocument, VaultPath, parse_note};

fn parse(text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new("Folder/Current.md").expect("valid path"),
        text,
    ))
}

#[test]
fn extracts_headings_with_source_spans() {
    let text = "# Café heading\n\n## Second *heading*\n";
    let parsed = parse(text);

    assert_eq!(parsed.headings.len(), 2);
    assert_eq!(parsed.headings[0].level, 1);
    assert_eq!(parsed.headings[0].text, "Café heading");
    assert_eq!(parsed.source.slice(parsed.headings[0].span), Some("# Café heading"));
    assert_eq!(parsed.headings[1].text, "Second heading");
}

#[test]
fn extracts_markdown_links_and_embeds_without_rewriting_targets() {
    let text = "[label](../Target%20Note.md#Section) ![alt](asset.png)";
    let parsed = parse(text);

    assert_eq!(parsed.references.len(), 2);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Body);
    assert_eq!(parsed.references[0].kind, ReferenceKind::MarkdownLink);
    assert_eq!(parsed.references[0].raw_target, "../Target%20Note.md#Section");
    assert_eq!(parsed.references[0].file_target.as_deref(), Some("../Target Note.md"));
    assert_eq!(parsed.source.slice(parsed.references[0].target_span), Some("../Target%20Note.md#Section"));
    assert_eq!(parsed.references[1].kind, ReferenceKind::MarkdownEmbed);
    assert_eq!(parsed.source.slice(parsed.references[1].span), Some("![alt](asset.png)"));
}

#[test]
fn obsidian_extensions_inside_code_html_and_link_labels_are_not_scanned() {
    let text = "`[[Code]]` <span>#html</span> [#label](Target.md)\n\n```md\n[[Fence]] #tag\n```\n";
    let parsed = parse(text);

    assert!(parsed.tags.is_empty());
    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].raw_target, "Target.md");
}
```

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test markdown
```

Expected: heading/link behavior is missing or extension syntax is falsely detected in excluded ranges.

- [ ] **Step 3: Parse a body slice with `markdown` and translate positions**

Create `crates/vault-core/src/markdown.rs`:

```rust
pub(crate) struct MarkdownParse {
    pub headings: Vec<Heading>,
    pub references: Vec<Reference>,
    pub text_ranges: Vec<SourceSpan>,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn parse_markdown(
    document: &SourceDocument,
    body_start: usize,
) -> MarkdownParse;
```

Implementation rules:

- Parse `&document.text()[body_start..]` with `markdown::to_mdast` and `ParseOptions::gfm()`.
- Recursively traverse nodes via `Node::children()` and read positions through `Node::position()`.
- Convert every mdast offset to an absolute offset by adding `body_start`.
- For `Heading`, recursively concatenate descendant textual content while omitting Markdown delimiters. Preserve the full heading source span.
- For `Link`, create `ReferenceKind::MarkdownLink`; for `Image`, create `ReferenceKind::MarkdownEmbed`. Both have `ReferenceOrigin::Body`. Use the full syntax span in `span`, the exact destination span in `target_span`, exact URL spelling in `raw_target`, decoded file target in `file_target`, and link label/alt text as `display`.
- Derive `target_span` from the exact source slice covered by the mdast node, not by searching the whole document for the decoded URL. Starting after the label's closing `]`, locate the inline destination opener `(`, skip Markdown destination whitespace, then handle either an angle-bracket destination or an unbracketed destination with backslash escapes and balanced parentheses. The span excludes `<`, `>`, surrounding whitespace, and an optional title. If the mdast node cannot be mapped back to one unambiguous destination slice, emit `MarkdownParseError` for that reference and omit only that reference.
- Percent-decode Markdown URL targets before resolution, split the first `#` into file and subpath portions, and classify `#^block` as `Subpath::Block`; otherwise use `Subpath::Heading`.
- A URL with a recognized URI scheme is retained as a reference with `file_target = None`; the resolver will classify it as `NonVault`.
- Collect `text_ranges` only from ordinary prose text nodes. Exclude code, fenced code, inline HTML, HTML blocks, link labels, image alt text, and any node already translated into a reference.
- If mdast parsing returns an error, emit `MarkdownParseError` spanning the body where possible and return an otherwise empty `MarkdownParse`; never panic.

- [ ] **Step 4: Compose the Markdown adapter into `parse_note`**

Call `parse_markdown(&source, frontmatter.body_start)`. Merge headings, Markdown references, and diagnostics into the `ParsedNote`. Retain the private `text_ranges` for Task 5 rather than exposing them publicly.

Sort Markdown-derived collections by `(span.start(), span.end())`; parsing traversal order must not leak as an unstable public contract.

- [ ] **Step 5: Verify and commit Task 4**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test markdown
cargo test -p vault-core --test frontmatter
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/markdown.rs
git diff --cached --check
git commit -m "feat(core): extract positional markdown semantics"
```

Expected: headings and Markdown references point back to exact source slices; extension-like syntax in excluded nodes is ignored.

---

### Task 5: Obsidian syntax extensions and complete per-note parsing

**Files:**

- Modify: `crates/vault-core/src/frontmatter.rs`
- Modify: `crates/vault-core/src/parse.rs`
- Create: `crates/vault-core/src/obsidian.rs`
- Create: `crates/vault-core/tests/obsidian_syntax.rs`

**Interfaces:**

- Consumes: Task 4 ordinary-text ranges and Task 3 string-valued properties.
- Produces: the complete `parse_note` behavior used by vault scanning and graph construction.

- [ ] **Step 1: Write the failing Obsidian-syntax tests**

Create `crates/vault-core/tests/obsidian_syntax.rs`:

```rust
use vault_core::{
    DiagnosticCode, ReferenceKind, ReferenceOrigin, SourceDocument, Subpath, VaultPath, parse_note,
};

fn parse(text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new("Notes/Source.md").expect("valid path"),
        text,
    ))
}

#[test]
fn parses_wikilinks_embeds_displays_and_subpaths() {
    let text = "[[Target|Shown]] ![[Other#Heading]] [[#^local-block]]";
    let parsed = parse(text);

    assert_eq!(parsed.references.len(), 3);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Body);
    assert_eq!(parsed.references[0].kind, ReferenceKind::Wikilink);
    assert_eq!(parsed.references[0].display.as_deref(), Some("Shown"));
    assert_eq!(parsed.references[1].kind, ReferenceKind::WikiEmbed);
    assert_eq!(parsed.references[1].subpath, Some(Subpath::Heading("Heading".into())));
    assert_eq!(parsed.references[2].file_target, None);
    assert_eq!(parsed.references[2].subpath, Some(Subpath::Block("local-block".into())));
}

#[test]
fn parses_nested_tags_and_block_ids_only_from_prose() {
    let text = "Text #Project/PhaseOne ^decision\n\n`#Code ^fake`\n";
    let parsed = parse(text);

    assert_eq!(parsed.tags.len(), 1);
    assert_eq!(parsed.tags[0].value, "Project/PhaseOne");
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(parsed.blocks[0].value, "decision");
}

#[test]
fn property_strings_can_contribute_references() {
    let parsed = parse("---\nrelated: '[[Target]]'\n---\nBody\n");

    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Property);
    assert_eq!(parsed.references[0].kind, ReferenceKind::Wikilink);
    assert_eq!(parsed.references[0].raw_target, "Target");
}

#[test]
fn malformed_wikilinks_are_diagnostics_not_panics() {
    let parsed = parse("Before [[never closed\nAfter\n");

    assert!(parsed.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == DiagnosticCode::MalformedWikilink
    }));
}
```

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test obsidian_syntax
```

Expected: wikilinks, body tags, blocks, or property-origin references are missing.

- [ ] **Step 3: Implement one range-constrained scanner**

Create `crates/vault-core/src/obsidian.rs` as a crate-private adapter. Compile regexes once with `std::sync::LazyLock<regex::Regex>`; do not expose regex captures.

For every ordinary-text range supplied by `markdown.rs`, scan left-to-right with these rules:

- Recognize `[[target]]`/`[[target|display]]` as `ReferenceKind::Wikilink` and `![[target]]`/`![[target|display]]` as `ReferenceKind::WikiEmbed`; body occurrences have `ReferenceOrigin::Body`.
- A backslash immediately before `[` or `!` escapes the construct.
- Split the display portion on the first unescaped `|`; preserve exact `raw_target` spelling.
- Split a target on the first `#`. An empty file portion means the current note. A `^` immediately after `#` introduces a block subpath; otherwise it is a heading subpath.
- Diagnose an opener without a closing `]]` as `MalformedWikilink` at the opener-to-range-end span, then continue with the next text range.
- Store the entire `[[...]]` or `![[...]]` range in `span` and only the target portion before an optional display separator in `target_span`; both are absolute offsets into the document.
- Recognize a body tag beginning with `#` only at a Unicode-safe token boundary and containing letters/numbers plus `_`, `-`, and `/`. A valid tag must contain at least one non-numeric character. Reject an empty segment such as `#one//two` with `MalformedTag`.
- Recognize a block ID `^id` only at the end of a prose line after optional spaces. Allow ASCII letters, digits, and `-`; diagnose an invalid non-empty candidate as `MalformedBlockId`.
- Never rescan a byte range consumed by a wikilink as a tag or block.

Use checked string slicing and character iteration; no parser path may panic on a valid UTF-8 document.

- [ ] **Step 4: Scan string-valued properties with their scalar spans**

Add a private visitor over `PropertyValue` that yields every string value and its exact scalar span, including nested sequences and mappings. Slice the original `SourceDocument` at that scalar span and scan the raw scalar representation for `[[...]]`; this keeps full-reference and target offsets anchored to source even when the YAML value was quoted. Feed findings through the wikilink scanner with `ReferenceOrigin::Property` while preserving the wiki link/embed kind. Do not extract body tags or block IDs from properties; property tags already come from Task 3. Add a regression assertion that `source.slice(reference.target_span) == Some("Target")` for the quoted property fixture.

- [ ] **Step 5: Finalize deterministic `parse_note` composition**

`parse_note` now performs exactly this sequence:

1. Parse frontmatter and determine `body_start`.
2. Parse CommonMark/GFM body semantics and ordinary-text ranges.
3. Scan ordinary body ranges for Obsidian syntax.
4. Scan string-valued properties for property-origin wikilinks.
5. Merge property tags with body tags.
6. Sort aliases, headings, blocks, tags, references, and diagnostics by source start/end; use the semantic value as a final tie-breaker where two spans coincide.
7. Deduplicate only byte-identical findings with the same semantic kind and span. Preserve repeated references at distinct spans.

Do not resolve references in `parse_note`; resolution is a graph-level operation.

- [ ] **Step 6: Verify and commit Task 5**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test obsidian_syntax
cargo test -p vault-core --test markdown
cargo test -p vault-core --test frontmatter
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/obsidian_syntax.rs
git diff --cached --check
git commit -m "feat(core): parse obsidian markdown extensions"
```

Expected: the complete per-note parser is deterministic, source-addressable, and non-panicking for all regression cases.

---

### Task 6: Deterministic, read-only vault scanning

**Files:**

- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/vault_source.rs`
- Create: `crates/vault-core/tests/vault_source.rs`

**Interfaces:**

- Consumes: Task 1 source documents and Task 5 `parse_note`.
- Produces: the read-only `VaultSource` port, `FileSystemVaultSource`, `VaultListing`, `VaultDocuments`, `ScanError`, and `read_documents`.

- [ ] **Step 1: Write the failing filesystem-boundary tests**

Create `crates/vault-core/tests/vault_source.rs`. Use `tempfile::TempDir`, `std::fs`, and platform symlink support behind `#[cfg(unix)]`. Cover:

```rust
use std::fs;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, VaultSource, read_documents};

#[test]
fn lists_markdown_in_vault_path_order_and_excludes_internal_directories() {
    let root = TempDir::new().expect("temp vault");
    fs::create_dir_all(root.path().join("Zed")).expect("create Zed");
    fs::create_dir_all(root.path().join(".obsidian")).expect("create internal dir");
    fs::create_dir_all(root.path().join(".hidden")).expect("create hidden dir");
    fs::write(root.path().join("Zed/B.md"), "B").expect("write B");
    fs::write(root.path().join("A.md"), "A").expect("write A");
    fs::write(root.path().join("ignored.txt"), "text").expect("write text");
    fs::write(root.path().join(".obsidian/config.md"), "config").expect("write config");
    fs::write(root.path().join(".hidden/note.md"), "hidden").expect("write hidden");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let listing = source.markdown_paths().expect("list vault");
    let paths = listing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>();

    assert_eq!(paths, ["A.md", "Zed/B.md"]);
    assert!(listing.diagnostics.is_empty());
}

#[test]
fn invalid_utf8_is_diagnosed_and_other_notes_continue() {
    let root = TempDir::new().expect("temp vault");
    fs::write(root.path().join("Good.md"), "# Good\n").expect("write good note");
    fs::write(root.path().join("Bad.md"), [0xff, 0xfe]).expect("write invalid note");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let result = read_documents(&source).expect("root remains scannable");

    assert_eq!(result.documents.len(), 1);
    assert_eq!(result.documents[0].path().as_str(), "Good.md");
    assert!(result.diagnostics.iter().any(|d| {
        d.path.as_ref().is_some_and(|path| path.as_str() == "Bad.md")
    }));
}
```

Add Unix-only cases proving:

- a directory symlink is not traversed;
- a symlinked `.md` file whose canonical target remains inside the vault is included;
- a symlinked `.md` file whose target escapes the canonical vault root is skipped with `SymlinkOutsideVault`.

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test vault_source
```

Expected: compilation fails because the read-only vault source API does not exist.

- [ ] **Step 3: Define a read-only source port**

Create `crates/vault-core/src/vault_source.rs` with this public boundary:

```rust
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{Diagnostic, SourceDocument, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultListing {
    pub paths: Vec<VaultPath>,
    pub diagnostics: Vec<Diagnostic>,
}

pub trait VaultSource {
    fn markdown_paths(&self) -> Result<VaultListing, ScanError>;
    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError>;
}

#[derive(Clone, Debug)]
pub struct FileSystemVaultSource { root: PathBuf, canonical_root: PathBuf }

impl FileSystemVaultSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ScanError>;
    pub fn root(&self) -> &Path;
}

#[derive(Clone, Debug)]
pub struct VaultDocuments {
    pub documents: Vec<SourceDocument>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn read_documents(source: &impl VaultSource) -> Result<VaultDocuments, ScanError>;

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("vault root is inaccessible: {message}")]
    InaccessibleRoot { message: String },
    #[error("cannot read {path:?}: {message}")]
    UnreadableFile { path: VaultPath, message: String },
}
```

There is deliberately no create, write, rename, delete, metadata-update, or raw filesystem-handle method.

- [ ] **Step 4: Implement deterministic filesystem enumeration**

Use `walkdir::WalkDir` with link following disabled. Apply these rules:

- Canonicalize and validate the root in `FileSystemVaultSource::new`; a missing, non-directory, or inaccessible root returns `ScanError::InaccessibleRoot`.
- Filter directory entries before descending. Exclude `.obsidian`, `.trash`, and every directory whose filename begins with `.`; do not exclude ordinary files merely because a parent-independent filename begins with `.`.
- Include regular files whose extension compares to `md` case-insensitively.
- For a file symlink ending in `.md`, canonicalize its target. Include it under the symlink's vault-relative path only if the canonical target starts with `canonical_root`; otherwise add `SymlinkOutsideVault` and skip it.
- Never traverse a directory symlink.
- Convert relative paths to `/`-separated `VaultPath` values without accepting `.` or `..` components.
- Sort and deduplicate paths before returning `VaultListing`.
- Convert recoverable enumeration errors that identify a vault-relative path into `UnreadableFile` diagnostics. Only loss of the root itself is a hard `ScanError`.

Re-canonicalize a symlink target inside `read_bytes` and repeat the containment check immediately before reading. A symlink swapped after enumeration must not become a read path outside the vault.

- [ ] **Step 5: Read exact bytes while continuing past file failures**

`read_documents` must:

1. Obtain `VaultListing` and start with its diagnostics.
2. Call `read_bytes` in sorted vault-path order.
3. Convert successful bytes with `SourceDocument::from_utf8`.
4. Convert invalid UTF-8 into `DiagnosticCode::InvalidUtf8` and omit that document.
5. Convert per-file `ScanError::UnreadableFile` into `DiagnosticCode::UnreadableFile` and continue.
6. Return documents and diagnostics in stable path order.

Do not parse notes here; this function establishes an independently testable storage boundary. Task 8 will parse the returned documents.

- [ ] **Step 6: Prove the production boundary has no mutation API**

Run:

```bash
rg -n "fn (write|create|remove|rename|delete|truncate|append)|OpenOptions|File::create" crates/vault-core/src
```

Expected: no matches in the production source. Test fixture setup may use `std::fs::write` only under `tests/`.

- [ ] **Step 7: Verify and commit Task 6**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test vault_source
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/vault_source.rs
git diff --cached --check
git commit -m "feat(core): scan vault sources read only"
```

Expected: enumeration is deterministic, symlink behavior is bounded by the root, and invalid files do not prevent good documents from loading.

---

### Task 7: Deterministic reference resolution

**Files:**

- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/resolver.rs`
- Create: `crates/vault-core/tests/resolution.rs`

**Interfaces:**

- Consumes: parsed notes from Task 5.
- Produces: `Resolver`, `ResolvedReference`, and explicit `Resolution` outcomes for Task 8.

- [ ] **Step 1: Write the failing resolution tests**

Create `crates/vault-core/tests/resolution.rs`. Build `ParsedNote` values through `parse_note`, then construct a resolver over them. Cover each candidate stage independently:

```rust
use vault_core::{
    Resolution, Resolver, SourceDocument, VaultPath, parse_note,
};

fn note(path: &str, text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new(path).expect("valid path"),
        text,
    ))
}

#[test]
fn resolves_exact_root_and_md_omitted_paths_first() {
    let notes = vec![
        note("Folder/Source.md", "[[Target]] [[Folder/Target.md]]"),
        note("Folder/Target.md", "# Target"),
        note("Target.md", "# Root"),
    ];
    let resolver = Resolver::new(&notes);
    let results = resolver.resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Target.md"
    ));
    assert!(matches!(
        &results[1].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Folder/Target.md"
    ));
}

#[test]
fn resolves_explicit_relative_paths_against_the_source_parent() {
    let notes = vec![
        note("A/B/Source.md", "[up](../Target.md)"),
        note("A/Target.md", "# Target"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "A/Target.md"
    ));
}

#[test]
fn returns_all_candidates_for_an_ambiguous_unique_name_stage() {
    let notes = vec![
        note("Source.md", "[[Foo]]"),
        note("One/Foo.md", "one"),
        note("Two/Foo.md", "two"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Ambiguous { candidates }
            if candidates.iter().map(|p| p.as_str()).collect::<Vec<_>>()
                == ["One/Foo.md", "Two/Foo.md"]
    ));
}
```

Also add focused cases for:

- unique case-insensitive filename/stem resolution;
- empty-file wikilink subpaths resolving to the source note;
- a resolved file plus case-insensitive heading match;
- a resolved file plus exact block-ID match;
- missing heading/block yielding `MissingSubpath`, not `Unresolved`;
- external URI schemes yielding `NonVault`;
- aliases not becoming implicit link destinations;
- path normalization that rejects escaping above the vault root.

- [ ] **Step 2: Run the focused test and confirm the red state**

```bash
cargo test -p vault-core --test resolution
```

Expected: compilation fails because the resolver API does not exist.

- [ ] **Step 3: Define explicit resolution outcomes**

Create `crates/vault-core/src/resolver.rs` with these public result types:

```rust
use crate::{ParsedNote, Reference, SourceSpan, Subpath, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resolution {
    Resolved { target: VaultPath, subpath: Option<Subpath> },
    MissingSubpath { target: VaultPath, subpath: Subpath },
    Unresolved,
    Ambiguous { candidates: Vec<VaultPath> },
    NonVault,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedReference {
    pub source: VaultPath,
    pub source_span: SourceSpan,
    pub reference: Reference,
    pub resolution: Resolution,
}

pub struct Resolver { /* private deterministic indexes */ }

impl Resolver {
    pub fn new(notes: &[ParsedNote]) -> Self;
    pub fn resolve_note(&self, note: &ParsedNote) -> Vec<ResolvedReference>;
}
```

Build private `BTreeMap` indexes for:

- exact vault path;
- exact vault path with a terminal `.md` omitted;
- case-insensitive Markdown filename;
- case-insensitive Markdown stem;
- per-path case-insensitive heading keys and exact block IDs.

Own the indexed paths/subpath keys inside `Resolver`; the resolver must not expose parser lifetimes. Do not index aliases as destinations.

- [ ] **Step 4: Implement the ordered candidate pipeline**

For each vault reference:

1. Classify a recognized URI scheme (`http:`, `https:`, `mailto:`, `obsidian:`, and any RFC-style alphabetic scheme followed by valid scheme characters and `:`) as `NonVault`.
2. If the file target is empty because the syntax is `[[#Heading]]`, `[[#^block]]`, or a Markdown fragment link, choose the source note.
3. Try a normalized vault-root path exactly as written, with optional terminal `.md` omission.
4. If the spelling begins `./` or `../`, normalize it against the source note's parent. If normalization escapes above the root, return `Unresolved`.
5. Look up the case-insensitive filename/stem candidate set. One candidate resolves; zero is `Unresolved`; more than one is `Ambiguous` with lexically sorted paths.

Apply every stage in the approved pipeline in order. When a stage returns multiple candidates, stop and return `Ambiguous` rather than choosing one.

- [ ] **Step 5: Resolve subpaths only after the file resolves**

- Compare heading text case-insensitively using Unicode lowercase, retaining the source spelling in the result.
- Compare block IDs exactly.
- If the file resolves but no matching subpath exists, return `MissingSubpath { target, subpath }`.
- Keep output sorted by source path and then `source_span`.

- [ ] **Step 6: Verify and commit Task 7**

```bash
cargo fmt --all -- --check
cargo test -p vault-core --test resolution
cargo test -p vault-core
git diff --check
git add crates/vault-core/src crates/vault-core/tests/resolution.rs
git diff --cached --check
git commit -m "feat(core): resolve vault references deterministically"
```

Expected: every resolution state is explicit and stable; ambiguous candidates are never silently collapsed.

---

### Task 8: Immutable semantic graph and compatibility corpus

**Files:**

- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/graph.rs`
- Create: `crates/vault-core/tests/semantic_graph.rs`
- Create: `crates/vault-core/tests/no_panics.rs`
- Create: `fixtures/semantic-read-path/basic-vault/Properties and aliases.md`
- Create: `fixtures/semantic-read-path/basic-vault/Markdown links.md`
- Create: `fixtures/semantic-read-path/basic-vault/Wikilinks.md`
- Create: `fixtures/semantic-read-path/basic-vault/Headings and blocks.md`
- Create: `fixtures/semantic-read-path/basic-vault/Tags.md`
- Create: `fixtures/semantic-read-path/basic-vault/Unicode café.md`
- Create: `fixtures/semantic-read-path/basic-vault/Ambiguous/Foo.md`
- Create: `fixtures/semantic-read-path/basic-vault/Other/Foo.md`
- Create: `fixtures/semantic-read-path/basic-vault/Malformed frontmatter.md`
- Create: `fixtures/semantic-read-path/expected/parsed-notes.json`
- Create: `fixtures/semantic-read-path/expected/resolution.json`
- Create: `fixtures/semantic-read-path/expected/diagnostics.json`
- Modify: `README.md`
- Modify: `VAULTD-COMPATIBILITY.md`

**Interfaces:**

- Consumes: Task 6 documents, Task 5 parser, and Task 7 resolver.
- Produces: `scan_vault`, immutable `SemanticGraph`, `ScanReport`, deterministic graph queries, and the committed Tier 1 evidence corpus.

- [ ] **Step 1: Create the compatibility fixture vault**

Create the nine Markdown files as ordinary vault notes, with no explanatory HTML comments inside the fixtures:

`Properties and aliases.md`:

```markdown
---
title: Properties
aliases:
  - Props
  - Metadata note
tags: [Project/PhaseOne, metadata]
related: "[[Headings and blocks#Decision]]"
score: 4.5
---
# Properties

Property body.
```

`Markdown links.md`:

```markdown
# Markdown links

[Unicode](Unicode%20café.md)
[Decision](Headings%20and%20blocks.md#Decision)
![Missing attachment](asset.png)
```

`Wikilinks.md`:

```markdown
# Wikilinks

[[Properties and aliases|Properties]]
![[Headings and blocks#^decision]]
[[Missing note]]
[[Foo]]
```

`Headings and blocks.md`:

```markdown
# Headings and blocks

## Decision

Keep the filesystem authoritative. ^decision
```

`Tags.md`:

```markdown
# Tags

#Project/PhaseOne #unicode/café

`#not-a-tag` and escaped \#also-not-a-tag.
```

`Unicode café.md`:

```markdown
# Unicode café

Exact UTF-8 source.
```

Both `Ambiguous/Foo.md` and `Other/Foo.md` contain only distinct plain body text and no headings. `Malformed frontmatter.md` contains exactly:

```markdown
---
tags: [broken
---
# Recoverable
```

- [ ] **Step 2: Write the expected public snapshots**

The JSON files summarize only stable public behavior, never third-party AST debug output.

`expected/parsed-notes.json` must list all nine paths in lexical order and these named findings:

- aliases `Props` and `Metadata note` on `Properties and aliases.md`;
- headings `Properties`, `Markdown links`, `Wikilinks`, `Headings and blocks`, `Decision`, `Tags`, `Unicode café`, and `Recoverable`;
- block `decision`;
- property and body tags with original spelling plus lowercase comparison keys;
- every reference's kind, origin, raw target, full-reference source slice, and target source slice.

`expected/resolution.json` must encode:

- five resolved references;
- two unresolved file targets: `asset.png` and `Missing note`;
- one ambiguous `Foo` with candidates `Ambiguous/Foo.md` and `Other/Foo.md`;
- three backlinks to `Headings and blocks.md`.

`expected/diagnostics.json` must encode one malformed-frontmatter diagnostic, two unresolved-reference diagnostics, and one ambiguous-reference diagnostic in deterministic order.

- [ ] **Step 3: Write the failing end-to-end graph test**

Create `crates/vault-core/tests/semantic_graph.rs` around the public entry point:

```rust
use std::{collections::BTreeMap, fs, path::Path};

use blake3::Hash;
use serde_json::Value;
use vault_core::{FileSystemVaultSource, Resolution, scan_vault};

fn fixture_root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/semantic-read-path/basic-vault"))
}

fn digest_tree(root: &Path) -> BTreeMap<String, Hash> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            let relative = entry.path().strip_prefix(root).expect("inside fixture root");
            let bytes = fs::read(entry.path()).expect("read fixture");
            (relative.to_string_lossy().replace('\\', "/"), blake3::hash(&bytes))
        })
        .collect()
}

fn expected(name: &str) -> Value {
    let path = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/semantic-read-path/expected"))
        .join(name);
    serde_json::from_slice(&fs::read(path).expect("read expected snapshot"))
        .expect("valid expected JSON")
}

#[test]
fn scans_the_compatibility_vault_without_modifying_it() {
    let before = digest_tree(fixture_root());
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("fixture root is accessible");
    let after = digest_tree(fixture_root());

    assert_eq!(before, after);
    assert_eq!(report.graph.note_paths().len(), 9);
    assert_eq!(snapshot_notes(&report.graph), expected("parsed-notes.json"));
    assert_eq!(snapshot_resolution(&report.graph), expected("resolution.json"));
    assert_eq!(snapshot_diagnostics(&report), expected("diagnostics.json"));
}

#[test]
fn every_public_span_is_in_bounds_and_slices_exact_source() {
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("scan fixture");

    for note in report.graph.notes() {
        for span in note.source_spans() {
            assert!(span.end() <= note.source.text().len());
            assert!(note.source.text().is_char_boundary(span.start()));
            assert!(note.source.text().is_char_boundary(span.end()));
            assert!(note.source.slice(span).is_some());
        }
    }
}

#[test]
fn graph_queries_are_stably_ordered() {
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("scan fixture");
    let graph = &report.graph;

    let headings = vault_core::VaultPath::new("Headings and blocks.md").expect("valid path");
    assert_eq!(graph.note_paths().len(), 9);
    assert_eq!(graph.backlinks(&headings).len(), 3);
    assert_eq!(graph.unresolved().len(), 2);
    assert_eq!(graph.ambiguous().len(), 1);
    assert!(matches!(
        graph.ambiguous()[0].resolution,
        Resolution::Ambiguous { .. }
    ));
}
```

In the same integration test, implement local `snapshot_notes`, `snapshot_resolution`, and `snapshot_diagnostics` helpers using `serde_json::json!` and only the public graph/report fields and query methods. Their JSON object keys must match the three committed expected files, and every path/list must be emitted in the API's existing order. Do not add snapshot methods to production or make `vault-core` depend on `serde_json` merely for golden tests.

- [ ] **Step 4: Run the focused graph test and confirm the red state**

```bash
cargo test -p vault-core --test semantic_graph
```

Expected: compilation fails because the graph API does not exist.

- [ ] **Step 5: Implement graph construction and queries**

Create `crates/vault-core/src/graph.rs` with this public boundary:

```rust
use crate::{
    Diagnostic, ParsedNote, ResolvedReference, ScanError, VaultPath, VaultSource,
};

#[derive(Clone, Debug)]
pub struct SemanticGraph { /* private immutable indexes */ }

#[derive(Clone, Debug)]
pub struct ScanReport {
    pub graph: SemanticGraph,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn scan_vault(source: &impl VaultSource) -> Result<ScanReport, ScanError>;

impl SemanticGraph {
    pub fn notes(&self) -> impl ExactSizeIterator<Item = &ParsedNote>;
    pub fn note_paths(&self) -> Vec<&VaultPath>;
    pub fn note(&self, path: &VaultPath) -> Option<&ParsedNote>;
    pub fn outgoing(&self, path: &VaultPath) -> &[ResolvedReference];
    pub fn backlinks(&self, path: &VaultPath) -> &[ResolvedReference];
    pub fn unresolved(&self) -> &[ResolvedReference];
    pub fn ambiguous(&self) -> &[ResolvedReference];
    pub fn diagnostics(&self) -> &[Diagnostic];
}
```

Use owned `BTreeMap`/`Vec` collections internally so the graph is immutable after construction and has no lifetime tied to temporary parser state. `scan_vault` must:

1. call `read_documents`;
2. parse documents in sorted vault-path order;
3. build one `Resolver` after all notes are parsed;
4. resolve all references;
5. build outgoing and reverse backlink indexes;
6. retain unresolved and ambiguous results separately;
7. convert unresolved and ambiguous results into their matching diagnostics, and convert missing heading/block subpaths into `MissingHeading`/`MissingBlock` respectively;
8. merge listing, file, parse, and resolution diagnostics in `(path, span, code, message)` order.

`NonVault` references remain visible in outgoing results but never enter backlinks, unresolved, or ambiguous collections.

If ergonomic query methods accept `&str`, make them fallible through `Result<_, DomainError>` rather than hiding invalid `VaultPath` construction. Otherwise keep the exact `&VaultPath` API above and construct paths in tests.

- [ ] **Step 6: Add arbitrary-input no-panic coverage**

Create `crates/vault-core/tests/no_panics.rs`:

```rust
use proptest::prelude::*;
use vault_core::{SourceDocument, VaultPath, parse_note};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn arbitrary_utf8_never_panics(
        chars in proptest::collection::vec(any::<char>(), 0..=1024)
    ) {
        let text = chars.into_iter().collect::<String>();
        let source = SourceDocument::new(
            VaultPath::new("Fuzz.md").expect("valid path"),
            text,
        );
        let parsed = parse_note(source);
        prop_assert!(parsed.source.text().is_char_boundary(parsed.source.text().len()));
    }
}
```

If this finds a panic, preserve the minimal regression as a named ordinary unit test before fixing it.

- [ ] **Step 7: Update the north star and compatibility claims**

In `README.md`, add a completed semantic-read-path milestone that names:

- exact source preservation and content revisions;
- read-only deterministic enumeration;
- semantic parsing and explicit diagnostics;
- in-memory resolution/backlinks;
- the fixture corpus;
- the deliberate absence of protocol/daemon exposure, persistence, watching, and mutation.

In `VAULTD-COMPATIBILITY.md`, update only Tier 1 rows proved by tests. Use wording such as `implemented with committed fixture coverage` for properties, aliases, headings, blocks, links, embeds, tags, diagnostics, and deterministic read-only scans. Leave unsupported/deferred tiers unchanged, and do not claim full undocumented Obsidian resolution compatibility.

- [ ] **Step 8: Run the complete phase verification**

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
git diff --check
rg -n "fn (write|create|remove|rename|delete|truncate|append)|OpenOptions|File::create" crates/vault-core/src
git diff --exit-code main...HEAD -- crates/vault-protocol crates/vault-server docs/protocol.md
```

Expected:

- all formatting, tests, Clippy, and docs checks pass;
- the production mutation-API search has no matches;
- `vault-protocol`, `vault-server`, and `docs/protocol.md` are unchanged by this phase.

- [ ] **Step 9: Commit Task 8**

```bash
git add README.md VAULTD-COMPATIBILITY.md crates/vault-core fixtures/semantic-read-path
git diff --cached --check
git status --short
git commit -m "feat(core): build semantic vault graph"
```

Expected: the fixture corpus, graph, tests, and evidence-backed documentation land together; `.permission-check` remains unstaged.

## Completion Gate

- [ ] Confirm Tasks 1-8 produced exactly these scoped commits, in order:

```text
feat(core): add exact source documents
feat(core): define semantic read model
feat(core): parse marked frontmatter properties
feat(core): extract positional markdown semantics
feat(core): parse obsidian markdown extensions
feat(core): scan vault sources read only
feat(core): resolve vault references deterministically
feat(core): build semantic vault graph
```

- [ ] Run the final audit from the semantic worktree:

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
git diff --check
git diff --stat main...HEAD
git diff --exit-code main...HEAD -- crates/vault-protocol crates/vault-server docs/protocol.md
git status --short --branch
git log --oneline --decorate main..HEAD
```

- [ ] Self-review the entire `main...HEAD` diff against `docs/design/semantic-read-path.md`, with special attention to:

- exact-source spans and UTF-8 boundaries;
- frontmatter recovery behavior;
- parser exclusions for code, HTML, escapes, and link labels;
- deterministic path and candidate ordering;
- symlink containment;
- missing-subpath versus missing-file semantics;
- read-only fixture evidence;
- absence of protocol/server changes and unsupported compatibility claims.

- [ ] Request an independent code review before any merge. Address every high-confidence correctness finding with a focused commit and re-run the final audit.

- [ ] Stop before pushing, opening a pull request, merging, or changing any external state unless the maintainer explicitly authorizes that next action.

## Handoff to the Implementing Agent

Before implementation, report the foundation commit present on `main`, the new worktree path/branch, and the passing baseline command. During execution, check off each step in this file and preserve the eight commit boundaries. At completion, report the verification output, independent-review result, final commit list, any remaining diagnostics/compatibility gaps, and confirmation that neither the fixture vault nor protocol/server surfaces were modified outside this plan.
