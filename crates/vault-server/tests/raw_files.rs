//! Raw file I/O and the configuration zone. Bytes pass through; nothing in
//! the zone becomes semantic.
//!
//! The guards `write_file` adds, and the test that is the witness for each —
//! delete a guard and exactly one row goes red:
//!
//! | guard | witness |
//! | --- | --- |
//! | an *indexable* `.md` path is refused (pre-resolve) | `a_raw_write_to_a_markdown_path_is_refused_so_it_cannot_skip_the_generation` |
//! | the same predicate again, post-resolve | `an_alias_out_of_the_zone_cannot_land_a_note` |
//! | the write payload cap | `a_payload_past_the_cap_names_the_deferred_alternative` |
//! | the **read** payload cap | `a_read_past_the_cap_is_refused_with_the_write_paths_own_code` |
//! | a read refuses a non-regular occupant | `a_read_of_a_folder_is_refused_as_target_exists`, `a_read_of_a_fifo_is_refused_and_the_daemon_keeps_answering` |
//! | a zone write joins no generation | `a_zone_write_joins_no_generation_and_announces_itself` |
//! | a zone write announces itself | same test, second half |
//! | an attachment write *does* name its path | `an_attachment_write_joins_a_generation_because_the_tree_holds_it` |
//! | every semantic verb still refuses the zone | `every_semantic_operation_refuses_the_zone` |
//! | the wire's `semantic` is the indexed-universe test | `the_wire_answers_semantic_by_whether_the_path_is_indexed_at_all` |
//! | …decided from where the bytes **landed** | `a_write_through_an_alias_into_the_zone_answers_for_where_it_landed`, `a_write_that_escapes_the_zone_reports_the_generation_it_published`, `a_case_folded_zone_spelling_is_still_a_zone_write` |
//! | the notice names the landed path | `an_alias_into_the_zone_announces_the_zone_path_it_reached` |
//! | hidden Markdown is raw, not refused | `a_trashed_note_round_trips_through_the_raw_pair` |
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

/// `write_file` over the wire, returning the whole envelope so a refusal can
/// be asserted on as easily as a success.
fn raw_write(daemon: &mut Daemon, path: &str, bytes: &[u8]) -> ResponseOutcome {
    let encoded = STANDARD.encode(bytes);
    daemon
        .call(&format!(
            r#"{{"version":1,"id":"w","request":{{"method":"write_file","params":{{"path":"{path}","content_base64":"{encoded}","expected":{{"any":true}}}}}}}}"#
        ))
        .outcome
}

fn read_file(daemon: &mut Daemon, path: &str) -> ResponseOutcome {
    daemon
        .call(&format!(
            r#"{{"version":1,"id":"f","request":{{"method":"read_file","params":{{"path":"{path}"}}}}}}"#
        ))
        .outcome
}

/// Whether this filesystem folds case, decided by asking it rather than by
/// naming a platform: the zone's case-variant spelling reaches the real zone
/// on APFS and names a different, absent folder on ext4.
fn folds_case(vault: &TempDir) -> bool {
    vault.path().join(".OBSIDIAN").is_dir()
}

/// **B1.** An alias whose *resolved* target is the zone is a zone write, and
/// every part of the answer has to say so: no generation, `semantic: false`,
/// and the notice names the zone path rather than the alias. Reporting from
/// the caller's spelling answers `semantic: true` with a generation for a
/// write that silently changed the host's configuration.
#[cfg(unix)]
#[test]
fn a_write_through_an_alias_into_the_zone_answers_for_where_it_landed() {
    let (vault, _index, mut daemon) = wired();
    std::os::unix::fs::symlink(
        vault.path().join(".obsidian"),
        vault.path().join("ZoneAlias"),
    )
    .expect("link an innocuous name at the zone");

    let response = match raw_write(&mut daemon, "ZoneAlias/app.json", b"PROBE") {
        ResponseOutcome::Ok(Response::WriteFile(response)) => response,
        other => panic!("the alias resolves into the zone, which is writable: {other:?}"),
    };
    assert!(
        !response.semantic,
        "the bytes landed in the zone, which is not indexed: {response:?}"
    );
    assert_eq!(
        response.generation, None,
        "no generation contains a zone write, whatever the caller called it: {response:?}"
    );
    assert_eq!(
        std::fs::read(vault.path().join(".obsidian/app.json")).expect("read back"),
        b"PROBE"
    );
}

/// The same claim on the notice, which only the in-process runtime can see.
#[cfg(unix)]
#[test]
fn an_alias_into_the_zone_announces_the_zone_path_it_reached() {
    let live = live();
    std::os::unix::fs::symlink(
        live.vault.path().join(".obsidian"),
        live.vault.path().join("ZoneAlias"),
    )
    .expect("link an innocuous name at the zone");

    live.handle
        .mutate(Mutation::WriteFile {
            path: path("ZoneAlias/app.json"),
            content: b"PROBE".to_vec(),
            expected: Precondition::Any,
        })
        .expect("write through the alias");

    let mut announced = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::ConfigChanged { path } = notice {
            announced.push(path.as_str().to_string());
        }
    }
    assert_eq!(
        announced,
        vec![".obsidian/app.json".to_string()],
        "a host watching its own configuration must be told which file changed, \
         under the name it knows it by"
    );
}

/// **B1, the mirror lie.** An alias *out* of the zone lands in the indexed
/// vault and really does publish a generation. Reporting from the caller's
/// spelling withholds it, and the client cannot read its own write back.
#[cfg(unix)]
#[test]
fn a_write_that_escapes_the_zone_reports_the_generation_it_published() {
    let (vault, _index, mut daemon) = wired();
    std::os::unix::fs::symlink("..", vault.path().join(".obsidian/up"))
        .expect("link the zone back at the vault root");

    let response = match raw_write(&mut daemon, ".obsidian/up/escaped.bin", b"PROBE") {
        ResponseOutcome::Ok(Response::WriteFile(response)) => response,
        other => panic!("the write lands inside the vault: {other:?}"),
    };
    assert!(
        response.semantic,
        "the bytes landed in the indexed vault, whatever the caller called the \
         path: {response:?}"
    );
    let generation = response
        .generation
        .expect("a write the tree holds must name the generation that holds it");

    let info = daemon.call(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#);
    match info.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => assert_eq!(
            info.generation, generation,
            "the reported generation must be the one the daemon actually published"
        ),
        other => panic!("get_vault_info failed: {other:?}"),
    }
    assert_eq!(
        std::fs::read(vault.path().join("escaped.bin")).expect("read back"),
        b"PROBE"
    );
}

/// **B1, without a symlink.** A caller that spells the zone folder with
/// different case reaches the real zone on any case-folding filesystem. The
/// answer must still be a zone answer.
#[test]
fn a_case_folded_zone_spelling_is_still_a_zone_write() {
    let (vault, _index, mut daemon) = wired();
    if !folds_case(&vault) {
        // On a case-sensitive filesystem `.OBSIDIAN` is a different, absent
        // folder, and the honest answer is that its parent does not exist.
        match raw_write(&mut daemon, ".OBSIDIAN/app.json", b"PROBE") {
            ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::ParentNotFound),
            other => panic!("a case-sensitive filesystem has no .OBSIDIAN: {other:?}"),
        }
        return;
    }

    let response = match raw_write(&mut daemon, ".OBSIDIAN/app.json", b"PROBE") {
        ResponseOutcome::Ok(Response::WriteFile(response)) => response,
        other => panic!("the folded spelling reaches the real zone: {other:?}"),
    };
    assert!(!response.semantic, "{response:?}");
    assert_eq!(response.generation, None, "{response:?}");
    assert_eq!(
        std::fs::read(vault.path().join(".obsidian/app.json")).expect("read back"),
        b"PROBE",
        "the real zone file is what changed"
    );
}

/// **I2.** The post-resolve note check, which had no witness of its own.
/// Delete it and a raw write lands a note in the indexed vault under a zone
/// spelling.
#[cfg(unix)]
#[test]
fn an_alias_out_of_the_zone_cannot_land_a_note() {
    let (vault, _index, mut daemon) = wired();
    std::os::unix::fs::symlink("..", vault.path().join(".obsidian/up"))
        .expect("link the zone back at the vault root");

    match raw_write(&mut daemon, ".obsidian/up/Evil.md", b"# raw\n") {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{error:?}");
            assert!(
                error.message.contains("write_note"),
                "the refusal must name the verb that serves this path: {}",
                error.message
            );
        }
        other => panic!("a raw write must never land a note in the indexed vault: {other:?}"),
    }
    assert!(!vault.path().join("Evil.md").exists());
}

/// **B2.** A FIFO in the vault must not block the dispatcher. `read_file` runs
/// on the thread that answers everything, so one open that waits for a writer
/// is a permanent liveness loss for the whole daemon — and closing stdin does
/// not end it.
#[cfg(unix)]
#[test]
fn a_read_of_a_fifo_is_refused_and_the_daemon_keeps_answering() {
    let (vault, _index, mut daemon) = wired();
    let status = std::process::Command::new("mkfifo")
        .arg(vault.path().join("pipe.bin"))
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo failed: {status:?}");

    match read_file(&mut daemon, "pipe.bin") {
        ResponseOutcome::Err(error) => assert_eq!(
            error.code,
            ErrorCode::TargetExists,
            "a fifo is something else occupying the name: {error:?}"
        ),
        other => panic!("a fifo must be refused, not opened: {other:?}"),
    }

    // The claim that matters: the daemon is still there.
    match read_file(&mut daemon, "One.md") {
        ResponseOutcome::Ok(Response::ReadFile(read)) => assert_eq!(
            STANDARD.decode(&read.content_base64).expect("valid base64"),
            b"# One\n"
        ),
        other => panic!("the daemon stopped answering after the fifo: {other:?}"),
    }
}

/// **B2, the other half.** A directory answered `storage_failure` — a claim
/// the daemon is broken, and an invitation to retry a request that can never
/// succeed.
#[test]
fn a_read_of_a_folder_is_refused_as_target_exists() {
    let (_vault, _index, mut daemon) = wired();
    match read_file(&mut daemon, ".obsidian") {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::TargetExists, "{error:?}"),
        other => panic!("a folder is not a file to read: {other:?}"),
    }
}

/// **I1.** The cap is symmetric, and the refusal names the same deferred
/// alternative the write path names. A file past it is not serialised into a
/// single JSON line no streaming client can chunk.
#[test]
fn a_read_past_the_cap_is_refused_with_the_write_paths_own_code() {
    let (vault, _index, mut daemon) = wired();
    // Written straight to disk: the write verb would refuse this, which is
    // precisely the asymmetry under test — the file is already there, the way
    // a real vault's video and PDF attachments are.
    std::fs::write(vault.path().join("huge.bin"), vec![0u8; 17 * 1024 * 1024])
        .expect("write past the cap");

    match read_file(&mut daemon, "huge.bin") {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::PayloadTooLarge, "{error:?}");
            assert!(error.message.contains("16777216"), "{}", error.message);
            assert!(
                error.message.contains("chunked transfer"),
                "the refusal must name what a caller should do instead: {}",
                error.message
            );
        }
        other => panic!("a file past the cap must not be serialised: {other:?}"),
    }
}

/// The partition ruling's user-visible reason. `delete_note { mode: local }`
/// puts notes in `.trash/`; every semantic verb then refuses to touch them, on
/// purpose. A host restoring one reads the bytes and writes them to a real
/// path — and a host implementing its own trash needs to put them there in the
/// first place. The raw verb is the only place that can serve either.
#[test]
fn a_trashed_note_round_trips_through_the_raw_pair() {
    let (vault, _index, mut daemon) = wired();
    std::fs::create_dir_all(vault.path().join(".trash")).expect("create the local trash");

    let response = match raw_write(&mut daemon, ".trash/Deleted.md", b"# Deleted\n") {
        ResponseOutcome::Ok(Response::WriteFile(response)) => response,
        other => panic!("the local trash is raw bytes: {other:?}"),
    };
    assert!(
        !response.semantic,
        "the scan never lists .trash, so nothing there is indexed: {response:?}"
    );
    assert_eq!(response.generation, None, "{response:?}");
    assert_eq!(response.revision, revision_of(b"# Deleted\n"));

    match read_file(&mut daemon, ".trash/Deleted.md") {
        ResponseOutcome::Ok(Response::ReadFile(read)) => {
            assert_eq!(
                STANDARD.decode(&read.content_base64).expect("valid base64"),
                b"# Deleted\n",
                "the bytes a host would write back to a real path"
            );
            assert_eq!(read.revision, response.revision);
        }
        other => panic!("read_file must read what write_file wrote: {other:?}"),
    }
}
