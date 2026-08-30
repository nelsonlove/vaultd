//! Schema v3: the structural rows (`sections`, `list_items`) join the store.
//!
//! The corpus under test is vault-core's captured Obsidian fixture set
//! (`crates/vault-core/tests/fixtures/structural/`): every case is parsed,
//! persisted through the ordinary `replace_note` write path, hydrated back,
//! and compared against the parsed original. Nothing here compares against
//! Obsidian — vault-core's own tests own that pinning; this file owns storage
//! fidelity.

mod common;

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use vault_core::{ListItemParent, ParsedNote, SectionKind, SourceDocument, VaultPath, parse_note};
use vault_index::{
    FileFingerprint, IndexConfig, IndexStore, SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION,
};

/// The same explicit case list vault-core's structural tests use: a directory
/// scan would let a new, not-yet-reviewed fixture join the suite silently.
const CASES: &[&str] = &[
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

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vault-core/tests/fixtures/structural")
}

fn parse_case(name: &str) -> ParsedNote {
    let source_text = std::fs::read_to_string(fixtures_dir().join(format!("{name}.md")))
        .unwrap_or_else(|error| panic!("reading {name}.md: {error}"));
    let path = VaultPath::new(format!("{name}.md")).expect("fixture vault path");
    parse_note(SourceDocument::new(path, source_text))
}

struct StructuralStore {
    store: IndexStore,
    config: IndexConfig,
    _vault: TempDir,
    _index: TempDir,
}

fn structural_store() -> StructuralStore {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("structural config");
    let store = IndexStore::open_for_test(&config).expect("open structural store");
    StructuralStore {
        store,
        config,
        _vault: vault,
        _index: index,
    }
}

#[test]
fn schema_version_constants_are_three() {
    assert_eq!(SQL_SCHEMA_VERSION, 3);
    assert_eq!(SEMANTIC_FORMAT_VERSION, 3);
}

#[test]
fn a_fresh_index_carries_the_structural_tables() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("fresh config");
    let connection = vault_index::open_index_for_test(&config).expect("open fresh index");

    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    assert_eq!(user_version, 3);

    for table in ["sections", "list_items"] {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .expect("table lookup");
        assert_eq!(count, 1, "missing {table}");
    }
}

/// Every captured case parses, persists, hydrates, and compares equal — the
/// whole `ParsedNote`, so a structural field that survives while some other
/// field regresses still fails here.
#[test]
fn every_structural_fixture_round_trips_through_the_store() {
    let mut fixture = structural_store();
    for &name in CASES {
        let original = parse_case(name);
        let path = original.source.path().clone();
        let fingerprint = FileFingerprint {
            size: original.source.text().len() as u64,
            modified_seconds: 7,
            modified_nanos: 11,
        };
        fixture
            .store
            .write_note_for_test(&original, fingerprint)
            .unwrap_or_else(|error| panic!("{name}: persist: {error}"));
        let loaded = fixture
            .store
            .load_note_for_test(&path)
            .unwrap_or_else(|error| panic!("{name}: load: {error}"))
            .unwrap_or_else(|| panic!("{name}: stored note missing"));

        assert_eq!(
            loaded.sections, original.sections,
            "{name}: sections did not round-trip"
        );
        assert_eq!(
            loaded.list_items, original.list_items,
            "{name}: list items did not round-trip"
        );
        assert_eq!(loaded, original, "{name}: note did not round-trip");
    }
}

/// The round trip above is only meaningful if the corpus actually exercises
/// every shape storage has to encode: an unrecognized kind, a block id, both
/// parent shapes, and a task character.
#[test]
fn the_fixture_corpus_covers_every_encoded_structural_shape() {
    let notes: Vec<ParsedNote> = CASES.iter().map(|&name| parse_case(name)).collect();
    let sections = || notes.iter().flat_map(|note| note.sections.iter());
    let items = || notes.iter().flat_map(|note| note.list_items.iter());

    assert!(
        sections().any(|section| matches!(section.kind, SectionKind::Other(_))),
        "no fixture produces an unrecognized section kind"
    );
    assert!(
        sections().any(|section| section.block_id.is_some()),
        "no fixture produces a section block id"
    );
    assert!(
        items().any(|item| matches!(item.parent, ListItemParent::Root { .. })),
        "no fixture produces a top-level list item"
    );
    assert!(
        items().any(|item| matches!(item.parent, ListItemParent::Item { .. })),
        "no fixture produces a nested list item"
    );
    assert!(
        items().any(|item| item.task.is_some()),
        "no fixture produces a task item"
    );
    assert!(
        items().any(|item| item.task.is_none()),
        "no fixture produces a non-task item"
    );
}

/// The pinned DDL's XOR constraint: exactly one parent column is ever set, so
/// a row claiming both (or neither) is rejected by SQLite rather than decoded
/// into a guess.
#[test]
fn a_list_item_row_may_not_set_both_parent_columns() {
    let mut fixture = structural_store();
    let note = parse_case("07-unordered-nested");
    let path = note.source.path().as_str().to_string();
    fixture
        .store
        .write_note_for_test(
            &note,
            FileFingerprint {
                size: note.source.text().len() as u64,
                modified_seconds: 1,
                modified_nanos: 0,
            },
        )
        .expect("persist note");

    // A second connection on the same committed cache (safe under WAL), so
    // the constraint is proven against the real stored table rather than
    // through a bespoke accessor on the store.
    let connection =
        rusqlite::Connection::open(&fixture.config.index_path).expect("reopen structural cache");
    for (list_start_line, parent_start_line) in [(Some(0), Some(1)), (None, None)] {
        let error = connection
            .execute(
                "INSERT INTO list_items \
                 (note_path, ordinal, span_start, span_end, list_start_line, \
                  parent_start_line, task) \
                 VALUES (?1, 9999, 0, 1, ?2, ?3, NULL)",
                rusqlite::params![path, list_start_line, parent_start_line],
            )
            .expect_err("both-or-neither parent columns must be refused");
        assert!(
            error.to_string().to_lowercase().contains("constraint"),
            "expected a constraint failure, got: {error}"
        );
    }
}
