//! The vault file tree: what a build indexes, what it excludes, and what one
//! ordinary watcher-path reconciliation does to it.
//!
//! Two claims run through every test here. First, the tree is *what the scan
//! already saw*: every non-hidden folder and file, with the kind that
//! distinguishes a note from an attachment from a folder, and nothing from
//! inside a hidden directory. Second, the tree is a second axis, not a change
//! to the first: a cycle that moves only tree rows leaves every semantic row
//! byte-identical, which `semantic_digest` below is the witness for.

use std::collections::BTreeMap;
use std::path::Path;

use tempfile::TempDir;
use vault_core::{TreeEntryKind, VaultPath};
use vault_index::{ChangeCause, IndexConfig, IndexService, StoredTreeEntry};

struct Fixture {
    service: IndexService,
    vault: TempDir,
    _index: TempDir,
}

impl Fixture {
    fn root(&self) -> &Path {
        self.vault.path()
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.root().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, bytes).expect("write file");
    }

    fn create_folder(&self, relative: &str) {
        std::fs::create_dir_all(self.root().join(relative)).expect("create folder");
    }

    fn remove_file(&self, relative: &str) {
        std::fs::remove_file(self.root().join(relative)).expect("remove file");
    }

    fn remove_folder(&self, relative: &str) {
        std::fs::remove_dir_all(self.root().join(relative)).expect("remove folder");
    }

    fn rename(&self, from: &str, to: &str) {
        let target = self.root().join(to);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::rename(self.root().join(from), target).expect("rename");
    }

    /// The ordinary watcher path: exactly the paths a hint named, reconciled
    /// through `refresh_paths` — the same call the runtime makes.
    fn refresh_paths(&mut self, paths: &[&str]) -> vault_index::LiveRefreshReport {
        let set = paths
            .iter()
            .map(|path| VaultPath::new(*path).expect("valid vault path"))
            .collect();
        self.service
            .refresh_paths(set, ChangeCause::Watcher)
            .expect("targeted refresh")
    }

    fn generation(&self) -> u64 {
        self.service
            .current_generation()
            .expect("generation")
            .expect("published")
            .get()
    }

    fn tree(&self) -> BTreeMap<String, StoredTreeEntry> {
        let (_, entries) = self.service.tree_entries().expect("tree entries");
        entries
            .into_iter()
            .map(|entry| (entry.path.as_str().to_string(), entry))
            .collect()
    }

    /// The stored tree as the facts a fresh walk can also state: path, kind,
    /// size. Timestamps are left out on purpose — a folder's move with any
    /// entry inside it, and comparing them would test the clock rather than
    /// the convergence.
    fn tree_facts(&self) -> Vec<(String, TreeEntryKind, Option<u64>)> {
        self.tree()
            .into_values()
            .map(|entry| (entry.path.as_str().to_string(), entry.kind, entry.size))
            .collect()
    }

    /// The same facts, from a walk of the vault right now.
    fn scanned_facts(&self) -> Vec<(String, TreeEntryKind, Option<u64>)> {
        let source =
            vault_core::FileSystemVaultSource::new(self.root()).expect("scan the fixture vault");
        source
            .scan()
            .expect("scan")
            .entries
            .into_iter()
            .map(|entry| (entry.path.as_str().to_string(), entry.kind, entry.size))
            .collect()
    }

    fn kinds(&self) -> BTreeMap<String, TreeEntryKind> {
        self.tree()
            .into_iter()
            .map(|(path, entry)| (path, entry.kind))
            .collect()
    }

    /// Everything the semantic half of the cache holds, as one string: the
    /// note rows with their revisions and fingerprints, the structural rows,
    /// the references, the resolutions, and the scan diagnostics. Any cycle
    /// that claims to have touched only the tree must leave this identical.
    fn semantic_digest(&self) -> String {
        let connection = self.service.connection_for_test();
        let mut digest = String::new();
        for sql in [
            "SELECT path || ' ' || content_revision || ' ' || observed_size || ' ' || \
             observed_mtime_seconds FROM notes ORDER BY path",
            "SELECT note_path || ' ' || ordinal || ' ' || kind || ' ' || span_start || ' ' || \
             span_end FROM sections ORDER BY note_path, ordinal",
            "SELECT note_path || ' ' || ordinal || ' ' || span_start FROM list_items \
             ORDER BY note_path, ordinal",
            "SELECT note_path || ' ' || ordinal || ' ' || raw_target FROM note_references \
             ORDER BY note_path, ordinal",
            "SELECT r.note_path || ' ' || r.ordinal || ' ' || s.kind || ' ' || \
             COALESCE(s.target_path, '-') FROM note_references r \
             JOIN resolutions s ON s.reference_id = r.id ORDER BY r.note_path, r.ordinal",
            "SELECT ordinal || ' ' || code || ' ' || message FROM scan_diagnostics ORDER BY ordinal",
            "SELECT note_path || ' ' || ordinal || ' ' || code FROM note_diagnostics \
             ORDER BY note_path, ordinal",
        ] {
            let mut statement = connection.prepare(sql).expect("digest query");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("digest rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("digest row");
            digest.push_str(&rows.join("\n"));
            digest.push_str("\n--\n");
        }
        digest
    }
}

/// A vault covering every case the tree has to classify: nested folders, an
/// empty folder, a note, an attachment, a `.canvas` file, and a dotfile
/// directory whose contents must never appear.
fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path();

    std::fs::write(root.join("Note.md"), "# Note\n[[Nested/Deep/Deep]]\n").expect("write note");
    std::fs::write(root.join("Board.canvas"), "{\"nodes\":[]}").expect("write canvas");
    std::fs::create_dir_all(root.join("Attachments")).expect("create attachments");
    std::fs::write(
        root.join("Attachments/Image.png"),
        [0x89u8, b'P', b'N', b'G'],
    )
    .expect("write image");
    std::fs::create_dir_all(root.join("Nested/Deep")).expect("create nested");
    std::fs::write(root.join("Nested/Deep/Deep.md"), "# Deep\n").expect("write deep note");
    std::fs::create_dir_all(root.join("Empty")).expect("create empty folder");
    std::fs::create_dir_all(root.join(".obsidian")).expect("create obsidian");
    std::fs::write(root.join(".obsidian/workspace.json"), "{}").expect("write workspace");
    std::fs::create_dir_all(root.join(".trash")).expect("create trash");
    std::fs::write(root.join(".trash/Gone.md"), "# Gone\n").expect("write trashed note");

    let config =
        IndexConfig::explicit(root, index.path().join("index.sqlite3")).expect("tree config");
    let mut service = IndexService::open(config).expect("tree service");
    service.refresh(false).expect("cold build");

    Fixture {
        service,
        vault,
        _index: index,
    }
}

#[test]
fn a_cold_build_indexes_every_non_hidden_entry_with_its_kind() {
    let fixture = fixture();
    let kinds = fixture.kinds();

    let expected: BTreeMap<String, TreeEntryKind> = [
        ("Attachments", TreeEntryKind::Folder),
        ("Attachments/Image.png", TreeEntryKind::File),
        ("Board.canvas", TreeEntryKind::File),
        ("Empty", TreeEntryKind::Folder),
        ("Nested", TreeEntryKind::Folder),
        ("Nested/Deep", TreeEntryKind::Folder),
        ("Nested/Deep/Deep.md", TreeEntryKind::Note),
        ("Note.md", TreeEntryKind::Note),
    ]
    .into_iter()
    .map(|(path, kind)| (path.to_string(), kind))
    .collect();

    assert_eq!(kinds, expected);
}

#[test]
fn hidden_directories_and_their_contents_are_excluded() {
    let fixture = fixture();
    let kinds = fixture.kinds();
    for path in kinds.keys() {
        assert!(
            !path.starts_with(".obsidian") && !path.starts_with(".trash"),
            "hidden territory leaked into the tree: {path}"
        );
    }
}

#[test]
fn an_empty_folder_is_still_an_entry() {
    let fixture = fixture();
    let entry = fixture.tree().remove("Empty").expect("the empty folder");
    assert_eq!(entry.kind, TreeEntryKind::Folder);
    assert_eq!(entry.size, None, "a folder has no byte size");
}

#[test]
fn a_files_row_carries_its_size_and_both_timestamps() {
    let fixture = fixture();
    let entry = fixture
        .tree()
        .remove("Attachments/Image.png")
        .expect("the attachment");
    assert_eq!(entry.kind, TreeEntryKind::File);
    assert_eq!(entry.size, Some(4));
    assert!(entry.mtime_unix_ms > 0, "an mtime is always available");
    assert!(
        entry.ctime_unix_ms > 0,
        "ctime falls back to mtime where the platform has no birthtime"
    );
    assert!(
        entry.ctime_unix_ms <= entry.mtime_unix_ms,
        "a file cannot have been modified before it was created"
    );
    assert_eq!(
        entry.content_revision, None,
        "no observation computes a revision for a non-note file yet"
    );
}

#[test]
fn a_notes_row_and_the_note_index_name_the_same_paths() {
    let fixture = fixture();
    let notes: Vec<String> = fixture
        .tree()
        .into_iter()
        .filter(|(_, entry)| entry.kind == TreeEntryKind::Note)
        .map(|(path, _)| path)
        .collect();
    let indexed: Vec<String> = fixture
        .service
        .list_notes(None, None)
        .expect("list notes")
        .items
        .into_iter()
        .map(|note| note.path.as_str().to_string())
        .collect();
    assert_eq!(notes, indexed);
}

#[test]
fn creating_an_attachment_updates_the_tree_without_touching_semantic_rows() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();
    let before_semantic = fixture.semantic_digest();

    fixture.write("Attachments/New.png", &[1, 2, 3]);
    let report = fixture.refresh_paths(&["Attachments/New.png"]);

    assert_eq!(
        report.generation.get(),
        before_generation + 1,
        "a tree-only change is still a generation a client must be told about"
    );
    assert_eq!(
        report.changes.created,
        vec![VaultPath::new("Attachments/New.png").expect("path")],
        "the committed generation names the path that changed"
    );
    let entry = fixture
        .tree()
        .remove("Attachments/New.png")
        .expect("the row");
    assert_eq!(entry.kind, TreeEntryKind::File);
    assert_eq!(entry.size, Some(3));
    assert_eq!(
        fixture.semantic_digest(),
        before_semantic,
        "a tree-only change must not move a single semantic row"
    );
}

#[test]
fn renaming_an_attachment_moves_its_row() {
    let mut fixture = fixture();
    let before_semantic = fixture.semantic_digest();

    fixture.rename("Attachments/Image.png", "Attachments/Renamed.png");
    let report = fixture.refresh_paths(&["Attachments/Image.png", "Attachments/Renamed.png"]);

    let tree = fixture.tree();
    assert!(!tree.contains_key("Attachments/Image.png"));
    assert_eq!(
        tree.get("Attachments/Renamed.png").map(|entry| entry.kind),
        Some(TreeEntryKind::File)
    );
    assert!(
        report
            .changes
            .deleted
            .contains(&VaultPath::new("Attachments/Image.png").expect("path"))
    );
    assert!(
        report
            .changes
            .created
            .contains(&VaultPath::new("Attachments/Renamed.png").expect("path"))
    );
    assert_eq!(fixture.semantic_digest(), before_semantic);
}

#[test]
fn deleting_an_attachment_removes_its_row() {
    let mut fixture = fixture();
    let before_semantic = fixture.semantic_digest();
    let before_generation = fixture.generation();

    fixture.remove_file("Attachments/Image.png");
    let report = fixture.refresh_paths(&["Attachments/Image.png"]);

    assert_eq!(report.generation.get(), before_generation + 1);
    assert!(!fixture.tree().contains_key("Attachments/Image.png"));
    assert_eq!(fixture.semantic_digest(), before_semantic);
}

#[test]
fn creating_a_folder_adds_its_row() {
    let mut fixture = fixture();
    let before_semantic = fixture.semantic_digest();

    fixture.create_folder("Fresh/Inner");
    let report = fixture.refresh_paths(&["Fresh/Inner"]);

    let kinds = fixture.kinds();
    assert_eq!(kinds.get("Fresh"), Some(&TreeEntryKind::Folder));
    assert_eq!(kinds.get("Fresh/Inner"), Some(&TreeEntryKind::Folder));
    assert!(
        report
            .changes
            .created
            .contains(&VaultPath::new("Fresh/Inner").expect("path")),
        "the folder the hint named is reported, and so is the parent it needed"
    );
    assert_eq!(fixture.semantic_digest(), before_semantic);
}

#[test]
fn renaming_a_folder_moves_its_row_and_everything_beneath_it() {
    let mut fixture = fixture();

    fixture.rename("Attachments", "Media");
    let report = fixture.refresh_paths(&["Attachments", "Media", "Media/Image.png"]);

    let kinds = fixture.kinds();
    assert!(!kinds.contains_key("Attachments"));
    assert!(
        !kinds.contains_key("Attachments/Image.png"),
        "a folder that left the vault takes its contents with it"
    );
    assert_eq!(kinds.get("Media"), Some(&TreeEntryKind::Folder));
    assert_eq!(kinds.get("Media/Image.png"), Some(&TreeEntryKind::File));
    assert!(
        report
            .changes
            .deleted
            .contains(&VaultPath::new("Attachments").expect("path"))
    );
}

#[test]
fn deleting_a_folder_removes_its_whole_subtree() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();

    fixture.remove_folder("Attachments");
    let report = fixture.refresh_paths(&["Attachments"]);

    assert_eq!(report.generation.get(), before_generation + 1);
    let kinds = fixture.kinds();
    assert!(!kinds.contains_key("Attachments"));
    assert!(!kinds.contains_key("Attachments/Image.png"));

    // The change set names the folder and stops there. The watcher event that
    // named it never named its contents, so neither does this: a client
    // applies the documented rule — a deleted folder implies its subtree —
    // rather than being handed a list the observation could not produce. The
    // complete route, which enumerated the vault and therefore does know each
    // path, spells them all out; `store/tree.rs` pins both shapes at the layer
    // that decides them.
    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Attachments").expect("path")],
        "a watcher-driven folder deletion names the folder alone"
    );
}

#[test]
fn a_note_still_reaches_both_axes_on_the_same_watcher_path() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();

    fixture.write("Nested/Deep/Deep.md", b"# Deep\n\nlonger body\n");
    let report = fixture.refresh_paths(&["Nested/Deep/Deep.md"]);

    assert_eq!(report.generation.get(), before_generation + 1);
    assert_eq!(
        report.changes.modified,
        vec![VaultPath::new("Nested/Deep/Deep.md").expect("path")]
    );
    let entry = fixture
        .tree()
        .remove("Nested/Deep/Deep.md")
        .expect("the note's own tree row");
    assert_eq!(entry.kind, TreeEntryKind::Note);
    assert_eq!(entry.size, Some(20));
    let indexed = fixture
        .service
        .get_note(&VaultPath::new("Nested/Deep/Deep.md").expect("path"))
        .expect("the note is still indexed");
    assert_eq!(indexed.note.source.text(), "# Deep\n\nlonger body\n");
}

#[test]
fn a_metadata_only_touch_refreshes_the_note_row_without_advancing_anything() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();
    let before = fixture.tree().remove("Note.md").expect("the note row");

    let path = fixture.root().join("Note.md");
    let metadata = std::fs::metadata(&path).expect("note metadata");
    let modified = filetime::FileTime::from_last_modification_time(&metadata);
    let bumped =
        filetime::FileTime::from_unix_time(modified.unix_seconds() + 5, modified.nanoseconds());
    filetime::set_file_mtime(&path, bumped).expect("bump mtime");

    let report = fixture.refresh_paths(&["Note.md"]);

    assert_eq!(
        report.generation.get(),
        before_generation,
        "a note's own metadata is not a tree event: the note rules already cover it"
    );
    assert_eq!(report.changes, vault_index::PathChanges::default());
    let after = fixture.tree().remove("Note.md").expect("the note row");
    assert!(
        after.mtime_unix_ms > before.mtime_unix_ms,
        "the row is still refreshed, exactly as the note fingerprint is"
    );
}

#[test]
fn a_complete_reconciliation_converges_on_the_same_tree_a_targeted_one_wrote() {
    let mut fixture = fixture();

    fixture.write("Attachments/New.png", &[1, 2, 3]);
    fixture.create_folder("Fresh");
    fixture.remove_file("Board.canvas");
    fixture.refresh_paths(&["Attachments/New.png", "Fresh", "Board.canvas"]);
    let targeted = fixture.tree();
    let generation = fixture.generation();

    // The complete path takes the same walk from scratch. It must find
    // nothing left to do — no rows to add, none to remove, and no generation
    // to manufacture.
    let report = fixture.service.refresh(false).expect("complete refresh");
    assert_eq!(report.generation.get(), generation);
    assert_eq!(fixture.tree(), targeted);
}

/// Editing an attachment moves nothing but its stat — and that is exactly
/// what a host serves as `TFile.stat`, so it publishes.
///
/// This is the clause that makes the "not every tree row move is
/// generational" rule non-trivial: a note's metadata and a folder's
/// timestamps are exempt, a file's are not.
#[test]
fn modifying_an_attachment_publishes_its_new_stat() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();
    let before_semantic = fixture.semantic_digest();
    let before = fixture
        .tree()
        .remove("Attachments/Image.png")
        .expect("the attachment");

    fixture.write(
        "Attachments/Image.png",
        &[0x89, b'P', b'N', b'G', 0, 1, 2, 3],
    );
    let report = fixture.refresh_paths(&["Attachments/Image.png"]);

    assert_eq!(
        report.generation.get(),
        before_generation + 1,
        "a file's stat is client-visible state"
    );
    assert_eq!(
        report.changes.modified,
        vec![VaultPath::new("Attachments/Image.png").expect("path")]
    );
    let after = fixture
        .tree()
        .remove("Attachments/Image.png")
        .expect("the attachment");
    assert_eq!(after.size, Some(8));
    assert!(after.size != before.size);
    assert_eq!(fixture.semantic_digest(), before_semantic);
}

/// A folder's own timestamps move whenever anything inside it is created or
/// removed, and nothing reads them — a folder carries no `stat` in the object
/// model. Publishing for that would put a second, contentless generation
/// behind every file written into a folder.
#[test]
fn a_folders_timestamps_moving_on_their_own_do_not_publish() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();
    let before = fixture.tree().remove("Empty").expect("the empty folder");

    let path = fixture.root().join("Empty");
    let metadata = std::fs::metadata(&path).expect("folder metadata");
    let modified = filetime::FileTime::from_last_modification_time(&metadata);
    let bumped =
        filetime::FileTime::from_unix_time(modified.unix_seconds() + 5, modified.nanoseconds());
    filetime::set_file_mtime(&path, bumped).expect("bump folder mtime");

    let report = fixture.refresh_paths(&["Empty"]);

    assert_eq!(
        report.generation.get(),
        before_generation,
        "a folder's timestamps are not state any client can observe"
    );
    assert_eq!(report.changes, vault_index::PathChanges::default());
    let after = fixture.tree().remove("Empty").expect("the empty folder");
    assert!(
        after.mtime_unix_ms > before.mtime_unix_ms,
        "the row is still refreshed — it just does not publish"
    );
}

/// A folder replaced by a file of the same name is not one row changing kind:
/// the folder ceased to exist, and everything stored beneath it ceased to
/// exist with it. A bare upsert would leave those descendant rows behind,
/// served as a subtree that is not there.
#[test]
fn a_folder_replaced_by_a_file_takes_its_subtree_with_it() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();

    fixture.remove_folder("Attachments");
    fixture.write("Attachments", b"a file now");
    let report = fixture.refresh_paths(&["Attachments"]);

    assert_eq!(
        report.generation.get(),
        before_generation + 1,
        "a kind change is client-visible"
    );
    let tree = fixture.tree();
    assert_eq!(
        tree.get("Attachments").map(|entry| entry.kind),
        Some(TreeEntryKind::File)
    );
    assert!(
        !tree.contains_key("Attachments/Image.png"),
        "the folder's descendants must not outlive the folder"
    );
    let path = VaultPath::new("Attachments").expect("path");
    assert!(
        report.changes.deleted.contains(&path) && report.changes.created.contains(&path),
        "both things happened, in that order: the folder went, the file arrived"
    );

    // And a complete walk agrees there is nothing left to fix.
    let complete = fixture.service.refresh(false).expect("complete refresh");
    assert_eq!(complete.generation.get(), report.generation.get());
    assert_eq!(fixture.tree(), tree);
}

/// The mirror case: a file replaced by a folder. Nothing can be orphaned —
/// a file has no subtree — but the kind still moved, so it still publishes.
#[test]
fn a_file_replaced_by_a_folder_publishes_the_kind_change() {
    let mut fixture = fixture();
    let before_generation = fixture.generation();

    fixture.remove_file("Board.canvas");
    fixture.create_folder("Board.canvas");
    let report = fixture.refresh_paths(&["Board.canvas"]);

    assert_eq!(report.generation.get(), before_generation + 1);
    assert_eq!(
        report.changes.modified,
        vec![VaultPath::new("Board.canvas").expect("path")]
    );
    let entry = fixture.tree().remove("Board.canvas").expect("the row");
    assert_eq!(entry.kind, TreeEntryKind::Folder);
    assert_eq!(entry.size, None);
}

/// A folder that appears **with contents already inside it** — `mv` of a
/// populated directory, an unarchive, a `git checkout` — is the one case the
/// targeted route cannot finish on its own, and this test tells the whole
/// two-step story rather than claiming it converges.
///
/// Step one: a hint that names only the folder leaves its descendants absent.
/// Nothing in this crate can do better — no hint names them, and enumerating
/// the folder would make the targeted route a walk.
///
/// Step two: the recovery is cross-crate. `vault_watch` classifies a folder
/// create/remove/rename that names no included Markdown path as structural
/// and forces `ChangeHint::Overflow`, which the runtime turns into the
/// complete reconciliation performed here — and that walks the vault and
/// finds the descendants. The dependency is stated in `observe_tree_paths`'
/// own doc comment; this is its executable half.
#[test]
fn a_populated_folder_appearing_converges_only_on_the_complete_route() {
    let mut fixture = fixture();

    // The shape a `mv` leaves behind: the folder and its contents are both
    // already there when the first hint arrives.
    fixture.create_folder("Bundle/Inner");
    fixture.write("Bundle/Inner/Deep.png", &[1, 2, 3]);
    fixture.write("Bundle/Note.md", b"# Bundled\n");

    let report = fixture.refresh_paths(&["Bundle"]);

    let kinds = fixture.kinds();
    assert_eq!(
        kinds.get("Bundle"),
        Some(&TreeEntryKind::Folder),
        "the path the hint named is indexed"
    );
    assert!(
        !kinds.contains_key("Bundle/Inner")
            && !kinds.contains_key("Bundle/Inner/Deep.png")
            && !kinds.contains_key("Bundle/Note.md"),
        "the gap is real: nothing named the descendants, so nothing indexed them"
    );
    assert_eq!(
        report.changes.created,
        vec![VaultPath::new("Bundle").expect("path")]
    );

    // Step two: the complete route the watcher's structural fallback triggers.
    fixture.service.refresh(false).expect("complete refresh");
    assert_eq!(
        fixture.tree_facts(),
        fixture.scanned_facts(),
        "the complete route converges the stored tree on a fresh walk"
    );
    let kinds = fixture.kinds();
    assert_eq!(kinds.get("Bundle/Inner"), Some(&TreeEntryKind::Folder));
    assert_eq!(
        kinds.get("Bundle/Inner/Deep.png"),
        Some(&TreeEntryKind::File)
    );
    assert_eq!(kinds.get("Bundle/Note.md"), Some(&TreeEntryKind::Note));
}

#[test]
fn hidden_paths_are_refused_even_when_a_caller_names_them_directly() {
    let mut fixture = fixture();
    let before = fixture.tree();

    fixture.write(".obsidian/plugins/thing.json", b"{}");
    let report = fixture.refresh_paths(&[".obsidian/plugins/thing.json", ".trash/Gone.md"]);

    assert_eq!(report.changes, vault_index::PathChanges::default());
    assert_eq!(
        fixture.tree(),
        before,
        "the exclusion is the index's rule, not merely the watcher's"
    );
}
