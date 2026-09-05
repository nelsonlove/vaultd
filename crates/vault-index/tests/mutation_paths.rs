//! Path containment and preconditions: the two checks every mutation runs
//! before it touches a byte.

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
    _outside: TempDir,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let outside = TempDir::new().expect("outside tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    let outside_root = outside
        .path()
        .canonicalize()
        .expect("canonical outside root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(outside_root.join("Secret.md"), "# Secret\n").expect("write Secret");
    let engine = MutationEngine::new(&root);
    Fixture {
        engine,
        root,
        _vault: vault,
        _outside: outside,
        outside: outside_root,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn a_path_inside_the_vault_resolves_under_the_canonical_root() {
    let fixture = fixture();
    let resolved = fixture
        .engine
        .resolve(&path("Folder/New.md"))
        .expect("a path with an existing parent resolves");
    assert_eq!(resolved, fixture.root.join("Folder").join("New.md"));
}

// Both symlink tests are gated whole rather than gating only the `symlink`
// call: with the call compiled out the assertion below would demand a refusal
// of an ordinary missing path, and the test would fail on the platform the
// gate was supposed to protect.
#[cfg(unix)]
#[test]
fn a_symlinked_folder_that_escapes_the_vault_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(&fixture.outside, fixture.root.join("Escape"))
        .expect("plant an escaping symlink");
    let error = fixture
        .engine
        .resolve(&path("Escape/Secret.md"))
        .expect_err("a write through an escaping symlink must be refused");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_file_that_escapes_the_vault_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(
        fixture.outside.join("Secret.md"),
        fixture.root.join("Linked.md"),
    )
    .expect("plant an escaping file symlink");
    let error = fixture
        .engine
        .resolve(&path("Linked.md"))
        .expect_err("a write through an escaping file symlink must be refused");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[test]
fn a_missing_parent_folder_is_never_created_implicitly() {
    let fixture = fixture();
    let error = fixture
        .engine
        .resolve(&path("Missing/New.md"))
        .expect_err("a write into a missing folder must be refused");
    assert!(
        matches!(error, MutationError::ParentNotFound { .. }),
        "expected parent_not_found, got {error:?}"
    );
    assert!(
        !fixture.root.join("Missing").exists(),
        "resolution must never create anything"
    );
}

#[test]
fn a_matching_revision_precondition_hands_back_the_current_bytes() {
    let fixture = fixture();
    let current = revision_of(b"# One\n");
    let bytes = fixture
        .engine
        .check(&path("One.md"), &Precondition::Revision(current))
        .expect("a matching revision satisfies the precondition")
        .expect("an existing file hands back its bytes");
    assert_eq!(bytes, b"# One\n");
}

#[test]
fn a_stale_revision_precondition_reports_the_revision_the_file_actually_holds() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(
            &path("One.md"),
            &Precondition::Revision("blake3:0000".into()),
        )
        .expect_err("a stale revision must be refused");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
}

#[test]
fn an_absent_precondition_against_an_existing_file_is_a_revision_conflict() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(&path("One.md"), &Precondition::Absent)
        .expect_err("expected-absent against an existing file must be refused");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
}

#[test]
fn a_revision_precondition_against_an_absent_file_is_not_found() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(&path("Gone.md"), &Precondition::Revision("blake3:0".into()))
        .expect_err("a revision precondition needs something to compare");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

#[test]
fn an_unconditional_precondition_accepts_both_presence_and_absence() {
    let fixture = fixture();
    assert_eq!(
        fixture
            .engine
            .check(&path("One.md"), &Precondition::Any)
            .expect("any accepts a present file"),
        Some(b"# One\n".to_vec())
    );
    assert_eq!(
        fixture
            .engine
            .check(&path("Gone.md"), &Precondition::Any)
            .expect("any accepts an absent file"),
        None
    );
}

#[test]
fn a_case_variant_of_an_absent_target_is_detected() {
    let fixture = fixture();
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("one.md"))
            .expect("enumerate the parent directory"),
        Some("One.md".to_string()),
        "a case-insensitive filesystem would silently overwrite One.md"
    );
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("One.md"))
            .expect("enumerate the parent directory"),
        None,
        "the exact spelling is not its own case variant"
    );
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("Folder/Anything.md"))
            .expect("enumerate an empty directory"),
        None
    );
}

#[test]
fn a_revision_is_the_same_blake3_spelling_the_index_stores() {
    assert_eq!(
        revision_of(b"# One\n"),
        format!("blake3:{}", blake3::hash(b"# One\n"))
    );
}
