//! Storage-path validation and writer-lease contention.
//!
//! Two concerns share this file because they are two halves of the same
//! guarantee: a cache can never be created inside the vault it indexes, and
//! once created it can never be written by two processes at once.

use std::sync::Mutex;

use vault_index::{IndexConfig, IndexError, IndexLease, IndexService};

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

/// A path lexically outside the vault whose parent directory is *already* a
/// symlink into the vault at construction time must be refused immediately:
/// `explicit`'s ancestor-resolution walk finds the symlink existing, so it
/// canonicalizes straight through it and catches this without needing
/// `prepare_storage` to create anything first.
#[cfg(unix)]
#[test]
fn explicit_refuses_an_index_path_whose_existing_parent_symlinks_into_the_vault() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let vault_subdir = vault.path().join("cache-target");
    std::fs::create_dir(&vault_subdir).unwrap();
    let link = outside.path().join("linked-into-vault");
    std::os::unix::fs::symlink(&vault_subdir, &link).unwrap();

    let error = IndexConfig::explicit(vault.path(), link.join("index.sqlite3")).unwrap_err();
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

// --- Symlinked-ancestor coverage (deterministic fixtures, not environment
// luck: every case below builds its own symlink rather than depending on
// TMPDIR happening to traverse one, per the reviewed test-strategy ruling). ---

/// A vault root reached through a symlinked ancestor — exactly the shape of
/// every macOS temp directory (`/tmp` -> `/private/tmp`) — must not let an
/// index path built from that same symlinked prefix slip past the
/// containment check. A lexical-only comparison against the *canonicalized*
/// vault root would miss this, because the index path keeps the
/// non-canonical prefix while the vault root does not.
#[cfg(unix)]
#[test]
fn explicit_refuses_an_index_path_inside_a_vault_reached_through_a_symlinked_ancestor() {
    let root = tempfile::tempdir().unwrap();
    let actual_vault = root.path().join("actual-vault");
    std::fs::create_dir(&actual_vault).unwrap();
    let vault_link = root.path().join("vault-link");
    std::os::unix::fs::symlink(&actual_vault, &vault_link).unwrap();

    let inside = vault_link.join(".derived/index.sqlite3");
    let error = IndexConfig::explicit(&vault_link, &inside).unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
}

/// `prepare_storage` must validate the *projected* parent before it creates
/// anything. Here the config is built while the redirecting symlink does not
/// exist yet (so `explicit`'s ancestor walk stops one level short and
/// accepts it, the same way a caller who built its config before a symlink
/// attack occurred would be); the symlink appears only afterward, so this
/// exercises `prepare_storage`'s own check, not construction's.
#[cfg(unix)]
#[test]
fn prepare_storage_creates_nothing_inside_the_vault_before_refusing_a_parent_planted_after_construction()
 {
    let vault = tempfile::tempdir().unwrap();
    let vault_target = vault.path().join("target");
    std::fs::create_dir(&vault_target).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let link = outside.path().join("link");

    let mut config =
        IndexConfig::explicit(vault.path(), link.join("nested/index.sqlite3")).unwrap();

    // Only now does the symlink appear, redirecting the not-yet-created
    // parent chain into the vault.
    std::os::unix::fs::symlink(&vault_target, &link).unwrap();

    let error = config.prepare_storage().unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
    assert!(
        !vault_target.join("nested").exists(),
        "prepare_storage must not create anything inside the vault before refusing"
    );
}

/// The final path component itself can be a symlink into the vault, planted
/// after construction (when it was still dangling and therefore
/// unresolvable). `prepare_storage` must catch it once it resolves, before
/// anything opens it for writing.
#[cfg(unix)]
#[test]
fn prepare_storage_refuses_a_final_symlink_whose_target_appears_inside_the_vault_after_construction()
 {
    let vault = tempfile::tempdir().unwrap();
    let cache_dir = tempfile::tempdir().unwrap();
    let planted_target = vault.path().join("leaked.sqlite3");
    let index_link = cache_dir.path().join("index.sqlite3");
    std::os::unix::fs::symlink(&planted_target, &index_link).unwrap();

    let mut config = IndexConfig::explicit(vault.path(), &index_link).unwrap();

    // The symlink's target now comes into existence inside the vault — the
    // way SQLite itself would create it if nothing stopped it first.
    std::fs::write(&planted_target, b"content the symlink now resolves to").unwrap();

    let error = config.prepare_storage().unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
}

// --- The task's actual guarantee: one writer at a time, end to end. ---

#[test]
fn a_second_production_service_is_refused_before_sqlite_recovery() {
    let vault = tempfile::tempdir().unwrap();
    let index_dir = tempfile::tempdir().unwrap();
    let config =
        IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3")).unwrap();

    let first = IndexService::open(config.clone()).expect("first service opens the cache");
    let error = match IndexService::open(config.clone()) {
        Ok(_) => panic!("a second writer must be refused"),
        Err(error) => error,
    };
    assert!(matches!(error, IndexError::IndexInUse));

    drop(first);
    IndexService::open(config).expect("the lease is released with the first service");
}

/// A lease file left behind by a crashed writer — content and all, since
/// nothing ever cleans it up — must not block the next writer: the lock is
/// what matters, not the file's bytes.
#[test]
fn a_stale_non_empty_lease_file_does_not_block_the_next_writer() {
    let vault = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut config =
        IndexConfig::explicit(vault.path(), cache.path().join("index.sqlite3")).unwrap();
    config.prepare_storage().unwrap();
    std::fs::write(config.lease_path(), b"stale bytes from a crashed writer").unwrap();

    IndexLease::acquire(&config).expect("a stale non-empty lease file must not block acquisition");
}
