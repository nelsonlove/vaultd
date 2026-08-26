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
