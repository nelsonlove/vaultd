//! One tolerant real-filesystem smoke test. Filesystem events on macOS
//! (FSEvents) coalesce and reorder, so this does not assert raw event
//! count, order, or rename pairing — only that a `Paths` hint containing
//! the touched file eventually arrives.

use std::fs;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_watch::{ChangeHint, WatchConfig, WatchStream};

#[test]
fn create_modify_delete_a_markdown_file_eventually_surfaces_a_paths_hint() {
    let root = TempDir::new().expect("temp vault");
    let mut stream = WatchStream::start(root.path(), WatchConfig::default()).expect("start watch");
    let expected = VaultPath::new("Note.md").expect("valid path");

    let note_path = root.path().join("Note.md");
    fs::write(&note_path, "# Note\n").expect("create note");
    fs::write(&note_path, "# Note\n\nmore\n").expect("modify note");
    fs::remove_file(&note_path).expect("delete note");

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut seen = false;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match stream.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(Some(ChangeHint::Paths(paths))) if paths.contains(&expected) => {
                seen = true;
                break;
            }
            Ok(_) => {}
            Err(error) => panic!("watch stream failed: {error}"),
        }
    }

    assert!(
        seen,
        "expected a Paths hint containing Note.md within the deadline"
    );
}

#[test]
fn renaming_a_folder_containing_a_note_eventually_surfaces_a_hint() {
    let root = TempDir::new().expect("temp vault");
    let mut stream = WatchStream::start(root.path(), WatchConfig::default()).expect("start watch");

    fs::create_dir_all(root.path().join("Folder")).expect("create folder");
    fs::write(root.path().join("Folder/Note.md"), "# Note\n").expect("create note");

    // Drain the create events from the setup above so they don't mask the
    // rename hint this test actually cares about.
    let drain_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < drain_deadline {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if stream
            .recv_timeout(remaining.min(Duration::from_millis(150)))
            .is_err()
        {
            panic!("watch stream failed while draining setup events");
        }
    }

    fs::rename(root.path().join("Folder"), root.path().join("Renamed")).expect("rename folder");

    // A directory rename with a note inside must never come back as zero
    // hints — either the renamed note surfaces directly, or the watcher
    // falls back to a reconcile-triggering hint. Either way, something.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut seen = false;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match stream.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(Some(_hint)) => {
                seen = true;
                break;
            }
            Ok(None) => {}
            Err(error) => panic!("watch stream failed: {error}"),
        }
    }

    assert!(
        seen,
        "expected some hint after renaming a folder containing a note"
    );
}
