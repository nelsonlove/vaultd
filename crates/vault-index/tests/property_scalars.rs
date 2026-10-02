mod common;

use std::collections::BTreeSet;
use std::fs;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexService};

fn open(vault: &TempDir, index: &TempDir) -> IndexService {
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("service");
    service.refresh(false).expect("cold build");
    service
}

/// One `property_scalars` row: ordinal, key, kind, string value, number value.
type ScalarRow = (i64, String, String, Option<String>, Option<f64>);

fn scalars(service: &IndexService, path: &str) -> Vec<ScalarRow> {
    let connection = service.connection_for_test();
    let mut statement = connection
        .prepare(
            "SELECT ordinal, key_text, kind, string_value, number_value FROM property_scalars \
             WHERE note_path = ?1 ORDER BY ordinal",
        )
        .unwrap();
    statement
        .query_map([path], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn a_cold_build_classifies_every_property() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(
        vault.path().join("Kinds.md"),
        "---\ntitle: Dune\nprice: 12.5\ncount: 3\ndone: true\ndue: 2025-01-01\nstamp: 2025-01-01T10:15\nempty:\ntags: [a, b]\nmeta:\n  x: 1\n---\n",
    )
    .unwrap();
    let service = open(&vault, &index);
    assert_eq!(
        scalars(&service, "Kinds.md"),
        vec![
            (
                0,
                "title".into(),
                "string".into(),
                Some("Dune".into()),
                None
            ),
            (1, "price".into(), "number".into(), None, Some(12.5)),
            (2, "count".into(), "number".into(), None, Some(3.0)),
            (3, "done".into(), "boolean".into(), None, Some(1.0)),
            (
                4,
                "due".into(),
                "date".into(),
                Some("2025-01-01".into()),
                None
            ),
            (
                5,
                "stamp".into(),
                "date".into(),
                Some("2025-01-01T10:15".into()),
                None
            ),
            (6, "empty".into(), "null".into(), None, None),
            (7, "tags".into(), "list".into(), None, None),
            (8, "meta".into(), "object".into(), None, None),
        ]
    );
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
}

#[test]
fn an_edit_and_a_delete_move_the_scalars_with_the_note() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(vault.path().join("A.md"), "---\nstatus: open\n---\n").unwrap();
    let mut service = open(&vault, &index);
    assert_eq!(scalars(&service, "A.md")[0].3.as_deref(), Some("open"));

    fs::write(
        vault.path().join("A.md"),
        "---\nstatus: closed\nrank: 2\n---\n",
    )
    .unwrap();
    let paths: BTreeSet<VaultPath> = [VaultPath::new("A.md").unwrap()].into();
    service
        .refresh_paths(paths.clone(), ChangeCause::Watcher)
        .unwrap();
    let after = scalars(&service, "A.md");
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].3.as_deref(), Some("closed"));
    assert_eq!(after[1].4, Some(2.0));
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror after edit");

    fs::remove_file(vault.path().join("A.md")).unwrap();
    service.refresh_paths(paths, ChangeCause::Watcher).unwrap();
    assert!(
        scalars(&service, "A.md").is_empty(),
        "the rows cascade with the note"
    );
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror after delete");
}

#[test]
fn a_fresh_index_has_both_new_tables() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let service = open(&vault, &index);
    for table in ["property_scalars", "bases"] {
        let count: i64 = service
            .connection_for_test()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "{table} exists");
    }
    let bases: i64 = service
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM bases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        bases, 0,
        "a vault with no .base files leaves the bases table empty"
    );
}
