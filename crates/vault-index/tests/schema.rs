use std::fs;

use tempfile::tempdir;
use vault_index::{
    IndexConfig, IndexLocation, SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION, open_index_for_test,
};

#[test]
fn derived_config_uses_xdg_cache_and_binds_the_canonical_vault() {
    let vault = tempdir().expect("vault tempdir");
    let cache = tempdir().expect("cache tempdir");
    let old = std::env::var_os("XDG_CACHE_HOME");
    unsafe { std::env::set_var("XDG_CACHE_HOME", cache.path()) };

    let config = IndexConfig::derived(vault.path()).expect("derived config");

    match old {
        Some(value) => unsafe { std::env::set_var("XDG_CACHE_HOME", value) },
        None => unsafe { std::env::remove_var("XDG_CACHE_HOME") },
    }
    assert_eq!(config.location, IndexLocation::Derived);
    assert!(
        config
            .index_path
            .starts_with(cache.path().join("vaultd/vaults"))
    );
    assert_eq!(
        config
            .index_path
            .file_name()
            .and_then(|value| value.to_str()),
        Some("semantic-v1.sqlite3")
    );
    assert!(!config.index_path.starts_with(vault.path()));
}

#[test]
fn schema_records_versions_identity_and_required_pragmas() {
    let vault = tempdir().expect("vault tempdir");
    let index_dir = tempdir().expect("index tempdir");
    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("explicit config");
    let connection = open_index_for_test(&config).expect("open schema");

    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    let foreign_keys: u32 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .expect("foreign_keys");
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .expect("journal_mode");
    let (semantic_version, identity): (u32, String) = connection
        .query_row(
            "SELECT semantic_format_version, vault_identity FROM index_metadata WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("index metadata");

    assert_eq!(user_version, SQL_SCHEMA_VERSION);
    assert_eq!(semantic_version, SEMANTIC_FORMAT_VERSION);
    assert_eq!(identity, config.vault_identity);
    assert_eq!(foreign_keys, 1);
    assert_eq!(journal_mode.to_lowercase(), "wal");
    assert!(
        fs::metadata(&config.index_path)
            .expect("database exists")
            .is_file()
    );
}
