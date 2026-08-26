//! Storage-path validation and writer-lease contention.
//!
//! Two concerns share this file because they are two halves of the same
//! guarantee: a cache can never be created inside the vault it indexes, and
//! once created it can never be written by two processes at once.

use std::sync::Mutex;

use vault_index::{IndexConfig, IndexError, IndexLease};

/// A couple of tests below change the process current directory via
/// `std::env::set_current_dir`, which is global state. Serialize just those
/// tests against each other; nothing else in this file (or crate) reads or
/// depends on the current directory.
static CWD_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn explicit_index_and_lease_inside_vault_are_refused_before_creation() {
    let vault = tempfile::tempdir().unwrap();
    let inside = vault.path().join(".derived/index.sqlite3");
    let error = IndexConfig::explicit(vault.path(), &inside).unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
    assert!(!inside.exists());
    assert!(!inside.with_extension("sqlite3.lock").exists());
}

#[test]
fn exactly_one_exclusive_lease_can_be_held() {
    let vault = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut config =
        IndexConfig::explicit(vault.path(), cache.path().join("index.sqlite3")).unwrap();
    config.prepare_storage().unwrap();
    let first = IndexLease::acquire(&config).unwrap();
    let second = IndexLease::acquire(&config).unwrap_err();
    assert!(matches!(second, IndexError::IndexInUse));
    drop(first);
    IndexLease::acquire(&config).expect("lease released with file handle");
}

/// A path lexically outside the vault whose parent directory is actually a
/// symlink into the vault must still be refused, once the parent exists to
/// canonicalize — `explicit` cannot catch this lexically, because the
/// symlink doesn't exist yet at construction time. `prepare_storage` is what
/// creates the parent and re-checks it after canonicalizing.
#[cfg(unix)]
#[test]
fn explicit_index_whose_parent_symlinks_into_the_vault_is_refused_at_prepare_storage() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let vault_subdir = vault.path().join("cache-target");
    std::fs::create_dir(&vault_subdir).unwrap();
    let link = outside.path().join("linked-into-vault");
    std::os::unix::fs::symlink(&vault_subdir, &link).unwrap();

    let mut config = IndexConfig::explicit(vault.path(), link.join("index.sqlite3")).unwrap();
    let error = config.prepare_storage().unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
}

/// A relative index path is resolved against the current directory before
/// the vault-containment check runs, and the resolved absolute path is what
/// gets stored — a caller cannot dodge validation, or end up with a path
/// that silently means something else once the process's cwd later changes.
#[test]
fn relative_index_path_is_resolved_against_current_directory_before_containment_check() {
    let _guard = CWD_LOCK.lock().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let original = std::env::current_dir().unwrap();
    std::env::set_current_dir(base.path()).unwrap();
    let expected_cwd = std::env::current_dir().unwrap();
    let result = IndexConfig::explicit(vault.path(), "index.sqlite3");
    std::env::set_current_dir(&original).unwrap();

    let config = result.expect("relative path outside the vault is accepted");
    assert_eq!(config.index_path, expected_cwd.join("index.sqlite3"));
}

/// A relative index path that resolves, once joined to the current
/// directory, to somewhere inside the vault must be refused just like an
/// absolute one would be.
#[test]
fn relative_index_path_resolving_inside_the_vault_is_refused() {
    let _guard = CWD_LOCK.lock().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let original = std::env::current_dir().unwrap();
    std::env::set_current_dir(vault.path()).unwrap();
    let result = IndexConfig::explicit(vault.path(), "index.sqlite3");
    std::env::set_current_dir(&original).unwrap();

    let error = result.unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
}

/// `..` segments are normalized lexically before the containment check, so a
/// path that merely *looks* like it might escape the vault but normalizes
/// back inside it is still refused.
#[test]
fn dot_dot_segments_that_normalize_back_inside_the_vault_are_refused() {
    let vault = tempfile::tempdir().unwrap();
    let subdir = vault.path().join("sub");
    std::fs::create_dir(&subdir).unwrap();
    let escaping_but_not_really = subdir.join("../sub/index.sqlite3");
    let error = IndexConfig::explicit(vault.path(), &escaping_but_not_really).unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
}

/// `..` segments that genuinely normalize outside the vault are accepted.
#[test]
fn dot_dot_segments_that_normalize_outside_the_vault_are_accepted() {
    let root = tempfile::tempdir().unwrap();
    let vault = root.path().join("vault");
    std::fs::create_dir(&vault).unwrap();
    let sibling_cache = vault.join("../cache/index.sqlite3");
    let config = IndexConfig::explicit(&vault, &sibling_cache).unwrap();
    assert!(!config.index_path.starts_with(&config.canonical_vault_root));
}
