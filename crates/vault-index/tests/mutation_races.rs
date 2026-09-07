//! A forced compare-and-swap race, made to open rather than waited for: the
//! second writer commits while the first is parked between its precondition
//! check and its write.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    HookPoint, IndexConfig, IndexError, IndexService, Mutation, MutationError, Precondition,
    TestHook, revision_of,
};

struct Once {
    point: HookPoint,
    fired: AtomicBool,
    action: Box<dyn Fn() + Send + Sync>,
}

impl TestHook for Once {
    fn reach(&self, point: HookPoint) {
        if point != self.point {
            return;
        }
        if self.fired.swap(true, Ordering::SeqCst) {
            return;
        }
        (self.action)();
    }
}

#[test]
fn a_writer_parked_after_its_precondition_still_loses_to_the_writer_that_committed() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    // The interloper writes between the parked writer's precondition check
    // and its own write. On a real daemon this is another process; here it is
    // a plain filesystem write, which is the same thing from the engine's
    // point of view.
    let interloper_root = root.clone();
    service.install_test_hook(Arc::new(Once {
        point: HookPoint::AfterMutationPrecondition,
        fired: AtomicBool::new(false),
        action: Box::new(move || {
            std::fs::write(interloper_root.join("One.md"), "# interloper\n")
                .expect("the interloper writes");
        }),
    }));

    let error = service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("One.md").expect("valid vault path"),
            content: "# parked writer\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect_err("the parked writer must re-check and lose");
    assert!(
        matches!(
            error,
            IndexError::Mutation(MutationError::RevisionConflict { .. })
        ),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(root.join("One.md")).expect("read back"),
        b"# interloper\n",
        "the interloper's bytes must survive; a lost update is the one forbidden outcome"
    );
}

#[test]
fn an_unconditional_writer_parked_at_the_same_point_still_wins_last() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    let interloper_root = root.clone();
    service.install_test_hook(Arc::new(Once {
        point: HookPoint::AfterMutationPrecondition,
        fired: AtomicBool::new(false),
        action: Box::new(move || {
            std::fs::write(interloper_root.join("One.md"), "# interloper\n")
                .expect("the interloper writes");
        }),
    }));

    service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("One.md").expect("valid vault path"),
            content: "# unconditional\n".into(),
            expected: Precondition::Any,
        })
        .expect("an unconditional write does not care who wrote last");
    assert_eq!(
        std::fs::read(root.join("One.md")).expect("read back"),
        b"# unconditional\n",
        "`any` is documented as last-writer-wins, and must behave that way"
    );
}

#[test]
fn a_refused_write_never_leaves_a_temporary_file_behind() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    let _ = service.apply_mutation(&Mutation::WriteNote {
        path: VaultPath::new("One.md").expect("valid vault path"),
        content: "# refused\n".into(),
        expected: Precondition::Revision("blake3:0000".into()),
    });
    let names: Vec<String> = std::fs::read_dir(&root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, vec!["One.md".to_string()], "{names:?}");
}
