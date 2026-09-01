//! Shared harness for the `tests/fixtures/structural/` corpus (see
//! `crates/vault-core/tests/fixtures/structural/README.md`). Twenty-two
//! cases captured from a live Obsidian 1.13.4 (16 original + 5 from the
//! second capture settling disputed edges + 1 from the third); each
//! `<case>.md` is fed through
//! `vault_core::parse_note` and compared against Obsidian's captured
//! `<case>.expected.json`.

use std::fs;
use std::path::{Path, PathBuf};

use vault_core::{ParsedNote, SourceDocument, VaultPath};

/// Every fixture case, in filename order. Kept as an explicit list (rather
/// than a directory scan) so a new, not-yet-wired fixture file doesn't
/// silently join the suite.
pub const CASES: &[&str] = &[
    "01-frontmatter-and-headings",
    "02-paragraphs-only",
    "03-fenced-code",
    "04-blockquote",
    "05-table",
    "06-thematic-break",
    "07-unordered-nested",
    "08-ordered-list",
    "09-task-list",
    "10-list-with-link-and-embed",
    "11-callout",
    "12-empty",
    "13-block-ids",
    "14-mixed-deep",
    "15-wide-offsets",
    "16-setext-and-html",
    "17-definitions-and-footnotes",
    "18-math-block",
    "19-task-nospace",
    "20-callout-edges",
    "21-list-in-blockquote-in-item",
    "22-indented-callout-and-math-link",
];

pub struct Fixture {
    pub source: String,
    pub parsed: ParsedNote,
    pub expected: serde_json::Value,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/structural")
}

/// Load and parse one fixture case by its basename (no extension).
pub fn load(name: &'static str) -> Fixture {
    let dir = fixtures_dir();
    let source = fs::read_to_string(dir.join(format!("{name}.md")))
        .unwrap_or_else(|error| panic!("reading {name}.md: {error}"));
    let expected_raw = fs::read_to_string(dir.join(format!("{name}.expected.json")))
        .unwrap_or_else(|error| panic!("reading {name}.expected.json: {error}"));
    let expected: serde_json::Value = serde_json::from_str(&expected_raw)
        .unwrap_or_else(|error| panic!("parsing {name}.expected.json: {error}"));

    let path = VaultPath::new(format!("{name}.md")).expect("fixture name is a valid vault path");
    let document = SourceDocument::new(path, source.clone());
    let parsed = vault_core::parse_note(document);

    Fixture {
        source,
        parsed,
        expected,
    }
}

/// Convert a byte offset into `source` to a UTF-16 code-unit offset.
///
/// Obsidian reports every position (`sections[].position`,
/// `listItems[].position`) in UTF-16 code units, proven by fixture
/// `15-wide-offsets`. vault-core's `SourceSpan` stays bytes (project
/// invariant) — comparisons against `expected.json` must convert vault-core
/// spans forward into UTF-16 units. Never convert the other direction.
pub fn utf16_offset(source: &str, byte_offset: usize) -> usize {
    source[..byte_offset].encode_utf16().count()
}
