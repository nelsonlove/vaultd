//! Raw file I/O and the configuration zone. Bytes pass through; nothing in
//! the zone becomes semantic.
//!
//! The guards `write_file` adds, and the test that is the witness for each —
//! delete a guard and exactly one row goes red:
//!
//! | guard | witness |
//! | --- | --- |
//! | a `.md` path outside the zone is refused | `a_raw_write_to_a_markdown_path_is_refused_so_it_cannot_skip_the_generation` |
//! | the payload cap | `a_payload_past_the_cap_names_the_deferred_alternative` |
//! | a zone write joins no generation | `a_zone_write_joins_no_generation_and_announces_itself` |
//! | a zone write announces itself | same test, second half |
//! | an attachment write *does* name its path | `an_attachment_write_joins_a_generation_because_the_tree_holds_it` |
//! | every semantic verb still refuses the zone | `every_semantic_operation_refuses_the_zone` |
//! | the wire's `semantic` is the indexed-universe test | `the_wire_answers_semantic_by_whether_the_path_is_indexed_at_all` |
//! | a read reports the revision a write compares against | `a_read_returns_the_bytes_and_the_revision_a_write_would_compare_against` |

mod daemon;

use std::sync::mpsc::{Receiver, sync_channel};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use daemon::Daemon;
use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, Mutation, Precondition, revision_of};
use vault_protocol::{ErrorCode, Response, ResponseOutcome};
use vault_server::runtime::{Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions};

struct Live {
    handle: RuntimeHandle,
    notices: Receiver<RuntimeNotice>,
    vault: TempDir,
    _index: TempDir,
}

fn live() -> Live {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(
        vault.path().join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("runtime config");
    let (sink, notices) = sync_channel(64);
    let options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    let handle = Runtime::start(config, options, sink).expect("start the runtime");
    handle.refresh(false).expect("cold build");
    Live {
        handle,
        notices,
        vault,
        _index: index,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn an_attachment_round_trips_byte_for_byte() {
    let live = live();
    let bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let report = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("image.png"),
            content: bytes.clone(),
            expected: Precondition::Absent,
        })
        .expect("write an attachment");
    assert_eq!(
        report.revision.as_deref(),
        Some(revision_of(&bytes).as_str())
    );
    assert!(
        !report.semantic,
        "`MutationOutcome::semantic` means *the semantic layer's rows moved*, and an \
         attachment is not indexed. That this write is nonetheless inside the vault \
         proper is a different fact, answered on the wire by `WriteFileResponse::semantic`"
    );
    assert_eq!(
        std::fs::read(live.vault.path().join("image.png")).expect("read back"),
        bytes
    );
    // The same bytes survive the base64 round trip the protocol layer performs,
    // which is what `write_file`'s wire form actually carries.
    assert_eq!(
        STANDARD
            .decode(STANDARD.encode(&bytes))
            .expect("round trip"),
        bytes
    );
}

/// The half `MutationOutcome::semantic` deliberately does not answer. An
/// attachment is not *semantic*, but it **is** a tree row, and the change set
/// is what the tree is reconciled from — so a raw write inside the indexed
/// vault has to name its path or `snapshot_tree` would serve a tree missing
/// the daemon's own writes.
#[test]
fn an_attachment_write_joins_a_generation_because_the_tree_holds_it() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let report = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("image.png"),
            content: vec![1, 2, 3],
            expected: Precondition::Absent,
        })
        .expect("write an attachment");
    assert!(!report.semantic, "an attachment holds no semantics");
    let after = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    assert!(
        after > before,
        "the tree moved, so a generation must contain it: {before:?} -> {after:?}"
    );
    assert_eq!(
        report.generation,
        Some(after),
        "the report must name the generation the write reached, so a client reads \
         its own attachment back"
    );
}

#[test]
fn a_raw_write_to_a_markdown_path_is_refused_so_it_cannot_skip_the_generation() {
    let live = live();
    let error = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("Raw.md"),
            content: b"# Raw\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect_err("a note must go through write_note so it joins a generation");
    assert!(
        matches!(
            error,
            vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
                vault_index::MutationError::IsANote { .. }
            ))
        ),
        "expected is_a_note, got {error:?}"
    );
    assert!(!live.vault.path().join("Raw.md").exists());
}

#[test]
fn a_zone_write_joins_no_generation_and_announces_itself() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let report = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path(".obsidian/app.json"),
            content: br#"{"trashOption":"system"}"#.to_vec(),
            expected: Precondition::Any,
        })
        .expect("write into the zone");
    assert!(
        !report.semantic,
        "nothing in the zone is indexed, so nothing there is semantic"
    );
    assert_eq!(
        live.handle
            .reader()
            .vault_info()
            .expect("vault info")
            .generation,
        before,
        "a zone write must not move the generation"
    );

    let mut announced = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::ConfigChanged { path } = notice {
            announced.push(path.as_str().to_string());
        }
    }
    assert_eq!(announced, vec![".obsidian/app.json".to_string()]);
}

#[test]
fn every_semantic_operation_refuses_the_zone() {
    let live = live();
    for mutation in [
        Mutation::WriteNote {
            path: path(".obsidian/note.md"),
            content: "# nope\n".into(),
            expected: Precondition::Absent,
        },
        Mutation::DeleteNote {
            path: path(".obsidian/app.json"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        },
        Mutation::CreateFolder {
            path: path(".obsidian/plugins"),
        },
        Mutation::PatchFrontmatter {
            path: path(".obsidian/app.json"),
            patch: Vec::new(),
            expected: Precondition::Any,
        },
    ] {
        let error = live
            .handle
            .mutate(mutation)
            .expect_err("a semantic operation must refuse the zone");
        assert!(
            matches!(
                error,
                vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
                    vault_index::MutationError::ZoneViolation { .. }
                ))
            ),
            "expected a zone violation, got {error:?}"
        );
    }
    assert!(
        live.vault.path().join(".obsidian/app.json").is_file(),
        "nothing in the zone may be touched by a refused operation"
    );
}

#[test]
fn a_read_returns_the_bytes_and_the_revision_a_write_would_compare_against() {
    let live = live();
    let engine = vault_index::MutationEngine::new(
        live.vault
            .path()
            .canonicalize()
            .expect("canonical vault root"),
    );
    let (bytes, revision) = engine
        .read_file(&path(".obsidian/app.json"))
        .expect("read out of the zone");
    assert_eq!(bytes, br#"{"trashOption":"local"}"#.to_vec());
    assert_eq!(revision, revision_of(&bytes));

    let (note_bytes, note_revision) = engine.read_file(&path("One.md")).expect("read a note");
    assert_eq!(note_bytes, b"# One\n".to_vec());
    assert_eq!(
        note_revision,
        revision_of(b"# One\n"),
        "a note read raw must report the same revision get_note does"
    );
}

#[test]
fn a_payload_past_the_cap_names_the_deferred_alternative() {
    let live = live();
    let error = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("huge.bin"),
            content: vec![0u8; 17 * 1024 * 1024],
            expected: Precondition::Absent,
        })
        .expect_err("16 MiB is the cap");
    // Typed first: the code is the contract, and a client branches on it.
    match &error {
        vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
            vault_index::MutationError::TooLarge { limit, actual },
        )) => {
            assert_eq!(*limit, vault_index::DEFAULT_MAX_FILE_BYTES);
            assert_eq!(*actual, 17 * 1024 * 1024);
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    // Then the message, because this one refusal carries a genuine obligation:
    // it has to name the deferred alternative, or a caller hitting the cap has
    // nowhere to go.
    let message = format!("{error}");
    assert!(message.contains("16777216"), "{message}");
    assert!(
        message.contains("chunked transfer"),
        "the refusal must name what a caller should do instead: {message}"
    );
    assert!(!live.vault.path().join("huge.bin").exists());
}

/// A daemon over a vault holding a note, a configuration zone, and one hidden
/// folder that is not the zone — the three universes `semantic` has to tell
/// apart.
fn wired() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::create_dir_all(vault.path().join(".hidden")).expect("create a hidden folder");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(
        vault.path().join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    (vault, index, daemon)
}

fn write_file(daemon: &mut Daemon, path: &str, bytes: &[u8]) -> vault_protocol::WriteFileResponse {
    let encoded = STANDARD.encode(bytes);
    let response = daemon.call(&format!(
        r#"{{"version":1,"id":"w","request":{{"method":"write_file","params":{{"path":"{path}","content_base64":"{encoded}","expected":{{"any":true}}}}}}}}"#
    ));
    match response.outcome {
        ResponseOutcome::Ok(Response::WriteFile(response)) => response,
        other => panic!("write_file {path} failed: {other:?}"),
    }
}

/// `WriteFileResponse::semantic` answers **"is this path inside the indexed
/// universe"** — a question about the path, not about what moved. The indexed
/// universe is what the scan lists, which excludes the configuration zone
/// *and* every hidden folder alike, so a hidden write is `semantic: false`
/// exactly as a zone write is. It is also what decides whether a generation
/// accompanies the answer: claiming one for a write no generation contains is
/// a lie a client would act on.
#[test]
fn the_wire_answers_semantic_by_whether_the_path_is_indexed_at_all() {
    let (vault, _index, mut daemon) = wired();

    let attachment = write_file(&mut daemon, "image.png", &[1, 2, 3]);
    assert!(
        attachment.semantic,
        "an attachment is inside the indexed vault: {attachment:?}"
    );
    assert!(
        attachment.generation.is_some(),
        "a write the index tracks must name the generation that holds it: {attachment:?}"
    );
    assert_eq!(attachment.revision, revision_of(&[1, 2, 3]));

    let zone = write_file(
        &mut daemon,
        ".obsidian/app.json",
        br#"{"trashOption":"system"}"#,
    );
    assert!(!zone.semantic, "nothing in the zone is indexed: {zone:?}");
    assert_eq!(
        zone.generation, None,
        "no generation contains a zone write, so none may be reported: {zone:?}"
    );

    let hidden = write_file(&mut daemon, ".hidden/data.bin", &[4, 5, 6]);
    assert!(
        !hidden.semantic,
        "the scan never lists a hidden folder, so a write there is outside the \
         indexed universe exactly as a zone write is: {hidden:?}"
    );
    assert_eq!(
        hidden.generation, None,
        "claiming a generation for a path no generation can contain is the lie \
         `semantic` exists to prevent: {hidden:?}"
    );

    assert_eq!(
        std::fs::read(vault.path().join(".hidden/data.bin")).expect("read back"),
        [4, 5, 6]
    );
}

#[test]
fn a_read_over_the_wire_returns_the_bytes_of_a_note_and_of_the_zone_alike() {
    let (_vault, _index, mut daemon) = wired();

    for (path, expected) in [
        ("One.md", b"# One\n".to_vec()),
        (".obsidian/app.json", br#"{"trashOption":"local"}"#.to_vec()),
    ] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"f","request":{{"method":"read_file","params":{{"path":"{path}"}}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Ok(Response::ReadFile(read)) => {
                assert_eq!(
                    STANDARD.decode(&read.content_base64).expect("valid base64"),
                    expected,
                    "read_file {path} returned the wrong bytes"
                );
                assert_eq!(read.revision, revision_of(&expected));
            }
            other => panic!("read_file {path} failed: {other:?}"),
        }
    }

    let absent = daemon.call(
        r#"{"version":1,"id":"f","request":{"method":"read_file","params":{"path":"Gone.bin"}}}"#,
    );
    match absent.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::NotFound),
        other => panic!("a read of an absent path must be refused: {other:?}"),
    }
}
