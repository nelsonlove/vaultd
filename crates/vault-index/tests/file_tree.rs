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
