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

/// One property's scalar columns: ordinal, key, kind, string value, number value.
type ScalarRow = (i64, String, String, Option<String>, Option<f64>);

fn scalars(service: &IndexService, path: &str) -> Vec<ScalarRow> {
    let connection = service.connection_for_test();
    let mut statement = connection
        .prepare(
            "SELECT ordinal, key_text, kind, string_value, number_value FROM properties \
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
fn a_fresh_index_has_the_bases_table_and_no_separate_scalar_table() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let service = open(&vault, &index);
    // Schema v5 folded `property_scalars` into `properties`.
    let scalars: i64 = service
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'property_scalars'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(scalars, 0, "no separate scalar table");
    let count: i64 = service
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'bases'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "bases exists");
    let bases: i64 = service
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM bases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        bases, 0,
        "a vault with no .base files leaves the bases table empty"
    );
}

/// The two routes a warm refresh can take over an index that already holds
/// a generation: the ordinary `refresh(false)`, which computes a dirty set and
/// publishes through the delta route, and the complete route
/// (`refresh_complete_for_test`), which re-inventories the whole vault and
/// publishes through `begin_publish` with a previous generation. Both must
/// leave every property's scalar columns classifying its value.
#[test]
fn both_warm_refresh_routes_keep_the_scalars_in_step() {
    for complete in [false, true] {
        let vault = TempDir::new_in(common::scratch_root()).unwrap();
        let index = TempDir::new_in(common::scratch_root()).unwrap();
        fs::write(
            vault.path().join("A.md"),
            "---\nstatus: open\nrank: 1\n---\n",
        )
        .unwrap();
        fs::write(vault.path().join("B.md"), "---\nowner: kim\n---\n").unwrap();
        let mut service = open(&vault, &index);
        let before = service.current_generation().unwrap().unwrap().get();

        fs::write(
            vault.path().join("A.md"),
            "---\nstatus: closed\nrank: 2.5\ndone: false\n---\n",
        )
        .unwrap();
        fs::write(
            vault.path().join("C.md"),
            "---\ndue: 2026-10-03\ntags: [x]\n---\n",
        )
        .unwrap();
        fs::remove_file(vault.path().join("B.md")).unwrap();
        let report = if complete {
            service.refresh_complete_for_test(false).unwrap()
        } else {
            service.refresh(false).unwrap()
        };
        assert_eq!(report.generation.get(), before + 1, "complete = {complete}");

        assert_eq!(
            scalars(&service, "A.md"),
            vec![
                (
                    0,
                    "status".into(),
                    "string".into(),
                    Some("closed".into()),
                    None
                ),
                (1, "rank".into(), "number".into(), None, Some(2.5)),
                (2, "done".into(), "boolean".into(), None, Some(0.0)),
            ],
            "complete = {complete}"
        );
        assert!(
            scalars(&service, "B.md").is_empty(),
            "complete = {complete}"
        );
        assert_eq!(
            scalars(&service, "C.md"),
            vec![
                (
                    0,
                    "due".into(),
                    "date".into(),
                    Some("2026-10-03".into()),
                    None
                ),
                (1, "tags".into(), "list".into(), None, None),
            ],
            "complete = {complete}"
        );
        common::property_scalars_mirror(service.connection_for_test())
            .unwrap_or_else(|message| panic!("complete = {complete}: {message}"));
    }
}

/// The `date` kind means what the schema comment says: `YYYY-MM-DD`,
/// optionally `[ T]HH:mm[:ss[.fff]]`, each field in range. Long strings,
/// out-of-range fields, other separators and zone suffixes are strings.
#[test]
fn only_a_date_shaped_string_is_a_date() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(
        vault.path().join("Dates.md"),
        "---\n\
         day: \"2026-10-03\"\n\
         minute: \"2026-10-03 14:30\"\n\
         second: \"2026-10-03T14:30:00\"\n\
         fraction: \"2025-01-01 10:15:30.250\"\n\
         words: \"hello world!\"\n\
         month: \"2026-13-45\"\n\
         compact: \"20261003\"\n\
         trailing: \"2025-01-01 notes\"\n\
         slash: \"2025/01/01\"\n\
         zulu: \"2025-01-01T10:15:30Z\"\n\
         hour: \"2026-10-03T24:00\"\n\
         ---\n",
    )
    .unwrap();
    let service = open(&vault, &index);
    let kinds: Vec<(String, String)> = scalars(&service, "Dates.md")
        .into_iter()
        .map(|(_, key, kind, _, _)| (key, kind))
        .collect();
    let expected: Vec<(String, String)> = [
        ("day", "date"),
        ("minute", "date"),
        ("second", "date"),
        ("fraction", "date"),
        ("words", "string"),
        ("month", "string"),
        ("compact", "string"),
        ("trailing", "string"),
        ("slash", "string"),
        ("zulu", "string"),
        ("hour", "string"),
    ]
    .into_iter()
    .map(|(key, kind)| (key.to_string(), kind.to_string()))
    .collect();
    assert_eq!(kinds, expected);
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
}

/// `key_fold` is the key lowercased in Rust, Unicode included, and it is the
/// lookup column: `Status` is found as `status`, `Größe` as `größe`.
#[test]
fn keys_are_folded_in_rust_for_lookup() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(
        vault.path().join("Keys.md"),
        "---\nStatus: open\nGRÖSSE: 3\nGröße: 4\n---\n",
    )
    .unwrap();
    let service = open(&vault, &index);
    let connection = service.connection_for_test();
    let found = |fold: &str| -> Vec<(String, String)> {
        let mut statement = connection
            .prepare(
                "SELECT note_path, key_text FROM properties WHERE key_fold = ?1 \
                 ORDER BY ordinal",
            )
            .unwrap();
        statement
            .query_map([fold], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(found("status"), vec![("Keys.md".into(), "Status".into())]);
    assert_eq!(found("größe"), vec![("Keys.md".into(), "Größe".into())]);
    assert_eq!(found("grösse"), vec![("Keys.md".into(), "GRÖSSE".into())]);
    assert!(found("Status").is_empty(), "the stored fold is lowercase");
    common::property_scalars_mirror(connection).expect("mirror");
}

/// Booleans are numbers in `number_value`: `true` is 1.0 and `false` is 0.0,
/// as the schema comment says, and the two never coincide.
#[test]
fn true_and_false_are_stored_as_one_and_zero() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(
        vault.path().join("Flags.md"),
        "---\nshown: true\nhidden: false\n---\n",
    )
    .unwrap();
    let service = open(&vault, &index);
    let rows = scalars(&service, "Flags.md");
    assert_eq!(
        rows,
        vec![
            (0, "shown".into(), "boolean".into(), None, Some(1.0)),
            (1, "hidden".into(), "boolean".into(), None, Some(0.0)),
        ]
    );
    assert_ne!(rows[0].4, rows[1].4);
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
}

/// The table's secondary indexes, as `sqlite_master` holds them.
fn scalar_indexes(connection: &rusqlite::Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' \
             AND tbl_name = 'properties' AND sql IS NOT NULL ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Task 14 fix round: the cold build drops `properties`' three
/// secondary indexes before its bulk load and creates them after. They come
/// back exactly as the schema declares them, the rows they index are the
/// mirror of `properties`, and the next (incremental) route keeps them.
#[test]
fn the_cold_build_recreates_the_property_indexes_as_the_schema_declares() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for at in 0..50 {
        fs::write(
            vault.path().join(format!("N{at:02}.md")),
            format!("---\ntitle: N{at}\nrank: {at}\n---\nbody\n"),
        )
        .unwrap();
    }
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("service");
    let declared = scalar_indexes(service.connection_for_test());
    assert_eq!(
        declared
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        [
            "properties_by_key",
            "properties_by_number",
            "properties_by_string"
        ]
    );
    service.refresh(false).expect("cold build");
    assert_eq!(scalar_indexes(service.connection_for_test()), declared);
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
    let edited = VaultPath::new("N07.md").unwrap();
    fs::write(vault.path().join("N07.md"), "---\ntitle: seven\n---\n").unwrap();
    service
        .refresh_paths(BTreeSet::from([edited]), ChangeCause::Watcher)
        .expect("edit");
    assert_eq!(scalar_indexes(service.connection_for_test()), declared);
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
}
