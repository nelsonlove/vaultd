mod common;

use std::fs;

use tempfile::tempdir;
use vault_index::{
    Generation, IndexConfig, IndexError, IndexLocation, IndexService, IndexState,
    SQL_SCHEMA_VERSION,
};

#[test]
fn vault_change_between_inventories_preserves_previous_generation() {
    let mut fixture = common::source_that_changes_on_second_inventory();
    fixture.service.refresh(false).expect("initial build");
    fixture.arm_change();

    let error = fixture
        .service
        .refresh(false)
        .expect_err("refresh must fail");

    assert!(matches!(error, IndexError::VaultChangedDuringRefresh));
    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(Generation::new(1))
    );
}

#[test]
fn wrong_vault_explicit_index_is_refused() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    let index = index_dir.path().join("shared.sqlite3");
    let first_config = IndexConfig::explicit(first.path(), &index).unwrap();
    IndexService::open(first_config).unwrap();

    let second_config = IndexConfig::explicit(second.path(), &index).unwrap();
    let error = match IndexService::open(second_config) {
        Ok(_) => panic!("wrong-vault index must be refused"),
        Err(error) => error,
    };

    assert!(matches!(error, IndexError::IncompatibleIndex(_)));
}

#[test]
fn failed_refresh_with_a_generation_becomes_stale_but_readable() {
    let mut fixture = common::service_with_injected_refresh_failure();
    fixture.service.refresh(false).expect("initial build");
    let error = fixture
        .service
        .refresh(false)
        .expect_err("injected failure");
    fixture.service.record_refresh_failure(&error).unwrap();

    assert!(matches!(
        fixture.service.state().unwrap(),
        IndexState::Stale { .. }
    ));
    assert!(fixture.service.snapshot_for_test().is_ok());
}

#[test]
fn missing_cache_directory_builds_cleanly() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let config = IndexConfig::explicit(
        vault.path(),
        index_dir.path().join("deep/nested/index.sqlite3"),
    )
    .unwrap();
    let mut service = IndexService::open(config).unwrap();
    let report = service.refresh(false).unwrap();
    assert_eq!(report.generation, Generation::new(1));
}

#[test]
fn corrupt_derived_cache_is_replaced_and_rebuilt() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("derived.sqlite3");
    fs::write(&index_path, b"this is not a sqlite database").unwrap();

    let mut config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    config.location = IndexLocation::Derived;
    let mut service = IndexService::open(config).unwrap();
    let report = service.refresh(false).unwrap();
    assert_eq!(report.generation, Generation::new(1));
}

#[test]
fn corrupt_explicit_cache_is_refused() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    let index_path = index_dir.path().join("explicit.sqlite3");
    fs::write(&index_path, b"this is not a sqlite database").unwrap();

    let config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    let error = match IndexService::open(config) {
        Ok(_) => panic!("corrupt explicit index must be refused"),
        Err(error) => error,
    };
    assert!(matches!(error, IndexError::IncompatibleIndex(_)));
}

#[test]
fn obsolete_schema_version_rebuilds_derived_data() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("derived.sqlite3");

    let mut config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    config.location = IndexLocation::Derived;
    {
        let mut service = IndexService::open(config.clone()).unwrap();
        service.refresh(false).unwrap();
    }
    {
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
    }

    let mut service = IndexService::open(config).unwrap();
    assert_eq!(service.current_generation().unwrap(), None);
    let report = service.refresh(false).unwrap();
    assert_eq!(report.generation, Generation::new(1));
}

#[test]
fn a_genuine_version_one_derived_cache_is_replaced_by_schema_two() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("derived.sqlite3");

    let mut config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    config.location = IndexLocation::Derived;
    {
        // Build an authentic version-1 cache by hand: the real version-1
        // schema DDL, stamped with the matching vault identity and
        // user_version = 1 — not just an artificially bumped user_version —
        // so the rebuild path is proven against real old-shaped data, not a
        // version number alone.
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute_batch(include_str!("../src/schema_v1.sql"))
            .unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute(
                "INSERT INTO index_metadata \
                 (singleton, semantic_format_version, vault_identity, generation, \
                  created_at_unix_ms) \
                 VALUES (1, 1, ?1, NULL, 0)",
                rusqlite::params![config.vault_identity],
            )
            .unwrap();
    }

    let mut service = IndexService::open(config).unwrap();
    assert_eq!(service.current_generation().unwrap(), None);
    let report = service.refresh(false).unwrap();
    assert_eq!(report.generation, Generation::new(1));

    let connection = rusqlite::Connection::open(&index_path).unwrap();
    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, SQL_SCHEMA_VERSION);
    let has_dependencies: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
             AND name = 'resolution_dependencies'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(has_dependencies, 1);
}

#[test]
fn a_genuine_version_one_explicit_cache_with_matching_identity_is_replaced_by_schema_two() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("explicit.sqlite3");

    let config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    {
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute_batch(include_str!("../src/schema_v1.sql"))
            .unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute(
                "INSERT INTO index_metadata \
                 (singleton, semantic_format_version, vault_identity, generation, \
                  created_at_unix_ms) \
                 VALUES (1, 1, ?1, NULL, 0)",
                rusqlite::params![config.vault_identity],
            )
            .unwrap();
    }

    // An obsolete *explicit* index with the right identity is rebuilt in
    // place, same as a derived one — only wrong identity and corruption are
    // refused for explicit indexes.
    let mut service = IndexService::open(config).unwrap();
    assert_eq!(service.current_generation().unwrap(), None);
    let report = service.refresh(false).unwrap();
    assert_eq!(report.generation, Generation::new(1));
}

#[test]
fn publication_failure_before_commit_preserves_all_rows() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("index.sqlite3");
    let config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();

    let blocker = rusqlite::Connection::open(&index_path).unwrap();
    blocker
        .busy_timeout(std::time::Duration::from_millis(100))
        .unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();

    fs::write(vault.path().join("Note.md"), "# Note changed\n").unwrap();
    let error = service.refresh(false).expect_err("blocked publication");
    assert!(matches!(error, IndexError::Storage(_)));

    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        service.current_generation().unwrap(),
        Some(Generation::new(1))
    );
    let snapshot = service.snapshot_for_test().unwrap();
    let note = snapshot
        .graph
        .note(&vault_core::VaultPath::new("Note.md").unwrap())
        .unwrap();
    assert_eq!(note.source.text(), "# Note\n");
}

#[test]
fn racing_services_force_one_retry_and_converge() {
    let mut fixture = common::racing_services();
    let report = fixture.service.refresh(false).expect("refresh with race");

    assert_eq!(report.generation, Generation::new(3));
    let snapshot = fixture
        .service
        .snapshot_for_test()
        .expect("converged graph");
    assert!(
        snapshot
            .graph
            .note(&vault_core::VaultPath::new("Racer.md").unwrap())
            .is_some()
    );
}

#[test]
fn no_completed_generation_is_unavailable() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    let config =
        IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3")).unwrap();
    let service = IndexService::open(config).unwrap();

    assert!(matches!(
        service.state().unwrap(),
        IndexState::Unavailable { .. }
    ));
}

#[test]
fn a_busy_healthy_derived_cache_is_not_deleted_as_corrupt() {
    let vault = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index_dir.path().join("derived.sqlite3");
    let mut config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    config.location = IndexLocation::Derived;
    {
        let mut service = IndexService::open(config.clone()).unwrap();
        service.refresh(false).unwrap();
    }

    let blocker = rusqlite::Connection::open(&index_path).unwrap();
    blocker
        .pragma_update(None, "locking_mode", "EXCLUSIVE")
        .unwrap();
    blocker
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE index_metadata SET last_refresh_error = NULL WHERE 0 = 1;",
        )
        .unwrap();

    let error = match IndexService::open(config.clone()) {
        Ok(_) => panic!("a busy database must not open"),
        Err(error) => error,
    };
    assert!(
        matches!(error, IndexError::Storage(_)),
        "busy must be retryable, not corruption: {error:?}"
    );

    blocker.execute_batch("ROLLBACK").unwrap();
    drop(blocker);
    let service = IndexService::open(config).unwrap();
    assert_eq!(
        service.current_generation().unwrap(),
        Some(Generation::new(1)),
        "the healthy database must survive with its generation intact"
    );
}
