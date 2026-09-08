//! Mutations through the live runtime: the write lands, its generation is
//! published before the response is sent, and a read at that generation sees
//! it.

mod daemon;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, sync_channel};

use tempfile::TempDir;
use vault_core::{TreeEntryKind, VaultPath};
use vault_index::{IndexConfig, IndexError, Mutation, MutationError, Precondition, revision_of};
use vault_protocol::{
    ErrorCode, ExpectedDto, Request, RequestEnvelope, Response, ResponseOutcome, WriteNoteParams,
};
use vault_server::Server;
use vault_server::runtime::{
    MutationFailure, Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions, RuntimeTestHooks,
};
use vault_server::subscriptions::SubscriptionRegistry;

use daemon::Daemon;

struct Live {
    handle: RuntimeHandle,
    notices: Receiver<RuntimeNotice>,
    vault: TempDir,
    _index: TempDir,
}

/// A runtime with no watcher and no periodic tick: every generation in these
/// tests is one a mutation caused, so nothing has to be filtered out.
///
/// The fixture links with a wikilink rather than a bare name because a bare
/// name is not a reference: the shipped parser recognises wikilinks and
/// Markdown links only, so a bare-text fixture would assert against zero
/// outgoing references and pass for the wrong reason.
fn live() -> Live {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\n[[One]]\n").expect("write Two");
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
fn a_write_is_readable_at_the_generation_it_reports() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# One changed\n[[Two]]\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("write through the runtime");
    let generation = report
        .generation
        .expect("a semantic write joins a generation");

    let note = live
        .handle
        .reader()
        .get_note(&path("One.md"))
        .expect("read back the note this call just wrote");
    assert_eq!(note.generation, generation, "read-your-writes");
    assert_eq!(note.note.source.text(), "# One changed\n[[Two]]\n");
    assert_eq!(
        note.outgoing.len(),
        1,
        "the new reference must be resolved in the same generation"
    );
    assert_eq!(
        report.revision.as_deref(),
        Some(revision_of(b"# One changed\n[[Two]]\n").as_str())
    );
    assert!(report.semantic, "a note write is a semantic mutation");
}

#[test]
fn a_delete_is_gone_at_the_generation_it_reports() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect("delete through the runtime");
    assert!(report.generation.is_some());
    assert!(
        report.revision.is_none(),
        "a deleted file has no revision to report"
    );
    let error = live
        .handle
        .reader()
        .get_note(&path("One.md"))
        .expect_err("read-your-deletes");
    assert!(
        matches!(error, IndexError::NoteNotFound(_)),
        "expected note_not_found, got {error:?}"
    );
}

#[test]
fn a_mutation_publishes_a_generation_whose_cause_is_mutation() {
    let live = live();
    live.handle
        .mutate(Mutation::WriteNote {
            path: path("Three.md"),
            content: "# Three\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a note");

    let mut causes = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::Generation(report) = notice {
            causes.push(report.cause);
        }
    }
    assert!(
        causes.contains(&vault_index::ChangeCause::Mutation),
        "expected a mutation-caused generation, saw {causes:?}"
    );
}

#[test]
fn the_watchers_own_hint_for_a_mutation_publishes_no_second_generation() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# One again\n".into(),
            expected: Precondition::Any,
        })
        .expect("write through the runtime");
    let after_write = report
        .generation
        .expect("a semantic write joins a generation");

    // Exactly what the watcher would deliver a debounce window later. The
    // fingerprint already matches what was published, so this must be a
    // no-op — an own-mutation hint must never manufacture a second
    // generation.
    assert!(
        live.handle
            .hint(vault_watch::ChangeHint::Paths(BTreeSet::from([path(
                "One.md"
            )]))),
        "the runtime must still be accepting hints"
    );
    let refreshed = live.handle.refresh(false).expect("drain the pending hint");
    assert_eq!(
        refreshed.generation.get(),
        after_write.get(),
        "the watcher's echo of our own write must publish nothing"
    );
}

#[test]
fn a_stale_revision_is_refused_without_moving_the_generation() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let error = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Revision("blake3:0000".into()),
        })
        .expect_err("a stale revision must lose");
    // Matched on the type, not on the message: a Display string is a
    // presentation detail, and asserting on it makes a reworded error a test
    // failure while a genuinely wrong *code* still passes.
    assert!(
        matches!(
            error,
            MutationFailure::Failed(IndexError::Mutation(MutationError::RevisionConflict { .. }))
        ),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(live.vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert_eq!(
        live.handle
            .reader()
            .vault_info()
            .expect("vault info")
            .generation,
        before,
        // Conditional on purpose: `apply_mutation` flushes before it calls
        // the engine, so with pending watcher hints a refused mutation can
        // coincide with a generation move — one that belongs to the watcher,
        // not to the refusal. This fixture has no watcher and nothing
        // pending, so the refusal is the only thing that could have moved it.
        "with nothing else pending, a refused mutation must not move the generation"
    );
}

/// A folder holds no notes, but it *is* a row in the file tree, and the tree
/// has been generational since the pre-task that made `snapshot_tree`
/// possible. So a folder creation publishes: the plan's original "nothing the
/// index tracks moved" wording describes a build that no longer exists, and
/// the shipped behaviour — the folder named in `changed_paths`, reconciled
/// through the tree axis — is what gets pinned here. The note counters must
/// stay at zero all the same: `affected_note_count` counts notes, and a tree
/// path joining a generation must never inflate it.
#[test]
fn a_folder_creation_publishes_a_tree_generation_that_counts_no_notes() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let report = live
        .handle
        .mutate(Mutation::CreateFolder {
            path: path("Folder"),
        })
        .expect("create a folder");
    let generation = report
        .generation
        .expect("the folder's tree row joins a generation");
    assert!(
        generation > before,
        "the tree moved, so the generation must have moved: {generation:?} vs {before:?}"
    );
    assert!(
        !report.semantic,
        "a folder holds no indexed semantics, whatever the tree did"
    );
    assert!(live.vault.path().join("Folder").is_dir());

    let (tree_generation, entries) = live
        .handle
        .reader()
        .tree_entries()
        .expect("read the published tree");
    assert_eq!(tree_generation, generation);
    assert!(
        entries
            .iter()
            .any(|entry| entry.path == path("Folder") && entry.kind == TreeEntryKind::Folder),
        "the folder must be a published tree row, not merely a directory on disk"
    );

    let mut mutation_reports = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::Generation(report) = notice {
            if report.cause == vault_index::ChangeCause::Mutation {
                mutation_reports.push(report);
            }
        }
    }
    let published = mutation_reports
        .last()
        .expect("the folder creation published a mutation generation");
    assert_eq!(published.generation, generation);
    assert_eq!(
        published.note_changes.total(),
        0,
        "a tree-only generation must report no note changes"
    );
}

/// The dispatch layer, end to end: a JSON line in, a typed answer out, for a
/// write, a delete, and a raw read. Three operations rather than one because
/// they take three different response shapes — `MutationResponse`,
/// `GenerationResponse`, and the not-yet-wired raw pair — and a dispatch table
/// is exactly the kind of code where nine arms are right and the tenth is
/// pasted wrong.
#[test]
fn the_protocol_reaches_the_engine_for_a_write_a_delete_and_a_read() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let written = daemon.call(
        r##"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Two.md","content":"# Two\n[[One]]\n","expected":{"absent":true}}}}"##,
    );
    let generation = match written.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => {
            assert_eq!(
                response.revision,
                vault_index::revision_of(b"# Two\n[[One]]\n")
            );
            response.generation
        }
        other => panic!("write_note did not reach the engine: {other:?}"),
    };

    // Read-your-writes over the transport, not merely in-process: the note is
    // readable at the generation the write reported, with no refresh between.
    let read_back = daemon.call(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"Two.md"}}}"#,
    );
    match read_back.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => {
            assert_eq!(response.generation, generation);
            assert_eq!(response.note.outgoing.len(), 1);
        }
        other => panic!("get_note failed: {other:?}"),
    }

    let deleted = daemon.call(
        r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"Two.md","mode":"permanent","expected":{"any":true}}}}"#,
    );
    match deleted.outcome {
        ResponseOutcome::Ok(Response::DeleteNote(response)) => {
            assert!(response.generation >= generation);
        }
        other => panic!("delete_note did not reach the engine: {other:?}"),
    }
    assert!(!vault.path().join("Two.md").exists());

    // The raw pair is still the placeholder until Task 16, and it must refuse
    // in a typed way rather than pretend the zone rules are in place.
    let raw = daemon.call(
        r#"{"version":1,"id":"f","request":{"method":"read_file","params":{"path":"One.md"}}}"#,
    );
    match raw.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::RuntimeNotReady),
        other => panic!("read_file must refuse until Task 16 wires it: {other:?}"),
    }
}

/// A precondition naming two fields is a client bug, and silently preferring
/// one would turn a typo into an unconditional overwrite. `convert::precondition`
/// is the only thing standing between that typo and a lost update, so it is
/// tested through the wire it guards.
#[test]
fn a_precondition_naming_two_fields_is_refused_before_anything_is_written() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    for params in [
        r#"{"path":"One.md","content":"x\n","expected":{"revision":"blake3:abc","any":true}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"absent":true,"any":true}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"any":false}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"absent":false}}"#,
        // Present but naming nothing: correction #12's other half. Omitting
        // `expected` altogether is the unconditional spelling; an empty
        // object is the typo shape and must never be read as one.
        r#"{"path":"One.md","content":"x\n","expected":{}}"#,
    ] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"p","request":{{"method":"write_note","params":{params}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::InvalidRequest,
                "wrong code for {params}: {error:?}"
            ),
            other => panic!("{params} was not refused: {other:?}"),
        }
    }
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n",
        "a refused precondition must never have written"
    );
}

/// The one refusal that is produced from an `io::Error`, and therefore the one
/// that could carry a filesystem path — or the vault's location on this
/// machine — out to a client that has no business knowing either. Proven on
/// the wire rather than at the conversion function, because the redaction is
/// only worth anything if it survives the whole dispatch path.
#[cfg(unix)]
#[test]
fn an_io_refusal_never_leaks_a_filesystem_path_on_the_wire() {
    use std::os::unix::fs::PermissionsExt as _;

    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let folder = vault.path().join("Folder");
    std::fs::create_dir(&folder).expect("create Folder");
    std::fs::write(folder.join("A.md"), "# a\n").expect("write A");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o500))
        .expect("make the folder unwritable");
    let refused = daemon.call(
        r##"{"version":1,"id":"i","request":{"method":"write_note","params":{"path":"Folder/A.md","content":"# clobbered\n","expected":{"any":true}}}}"##,
    );
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755))
        .expect("restore the folder so the tempdir can be cleaned up");

    let error = match refused.outcome {
        ResponseOutcome::Err(error) => error,
        other => panic!("a write into an unwritable folder must be refused: {other:?}"),
    };
    assert_eq!(error.code, ErrorCode::StorageFailure);
    assert_eq!(error.message, "the vault filesystem write failed");
    // The absent half of the `storage_failure` split: the engine writes
    // temp-then-rename, so a failure here means nothing landed, and no
    // revision exists to report. A client that sees no `current_revision` may
    // retry safely. The present half is pinned by
    // `a_write_that_landed_but_could_not_publish_names_the_revision_on_disk`.
    assert!(
        error.current_revision.is_none(),
        "nothing was written, so there is no revision to name: {error:?}"
    );
    let root = vault.path().to_string_lossy().into_owned();
    assert!(
        !error.message.contains(&root) && !error.message.contains("Folder"),
        "an io refusal must name no filesystem path: {:?}",
        error.message
    );
    assert_eq!(
        std::fs::read(folder.join("A.md")).expect("read back"),
        b"# a\n",
        "the refused write must have changed nothing"
    );
}

/// The Task 12 tripwire, flipped — it was
/// `task_12_must_flip_this_rename_still_breaks_inbound_links` while link
/// repair was unbuilt, and it pinned the honest-but-broken shape so the gap
/// stayed visible in the suite rather than only in a plan document.
///
/// What it pins now is the promise itself: `rewrite_links` defaults `true` on
/// the wire, so a client that spells nothing gets its inbound links repaired.
/// `links_rewritten` counts them, `link_rewrite_failures` stays empty because
/// nothing was skipped, the referrer's bytes name the new path, and the index
/// agrees the reference still resolves — the honest reading of those bytes,
/// not a stale row.
#[test]
fn a_rename_repairs_every_inbound_link_by_default() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\n[[One]]\n").expect("write Two");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    // `rewrite_links` is deliberately not spelled: the wire default is `true`,
    // so this is the request an ordinary client sends.
    let renamed = daemon.call(
        r#"{"version":1,"id":"n","request":{"method":"rename_note","params":{"from":"One.md","to":"Renamed.md","expected":{"any":true}}}}"#,
    );
    match renamed.outcome {
        ResponseOutcome::Ok(Response::RenameNote(response)) => {
            assert_eq!(response.links_rewritten, 1);
            assert!(
                response.link_rewrite_failures.is_empty(),
                "nothing was skipped, so nothing may be reported as skipped: {:?}",
                response.link_rewrite_failures
            );
        }
        other => panic!("rename_note did not reach the engine: {other:?}"),
    }

    assert!(vault.path().join("Renamed.md").is_file());
    assert_eq!(
        std::fs::read_to_string(vault.path().join("Two.md")).expect("read Two back"),
        "# Two\n[[Renamed]]\n",
    );

    // And the index agrees the link still resolves — the honest reading of the
    // bytes above, not a stale row.
    let read_back = daemon.call(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"Two.md"}}}"#,
    );
    match read_back.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => {
            assert_eq!(response.note.outgoing.len(), 1);
            assert!(
                matches!(
                    &response.note.outgoing[0].resolution,
                    vault_protocol::ResolutionDto::Resolved { target, .. }
                        if target == "Renamed.md"
                ),
                "the repaired reference must resolve at the new path: {:?}",
                response.note.outgoing[0].resolution
            );
        }
        other => panic!("get_note failed: {other:?}"),
    }
}

/// The bytes a landed-but-unpublished write puts on disk.
const LANDED: &[u8] = b"# One changed\n";

/// Drive one `write_note` whose engine write lands and whose publication then
/// fails, and hand back the vault it wrote into and the error a client sees.
///
/// `fault` is a factory rather than a value because `IndexError` is not
/// `Clone` and the retryable shapes are injected on *every* attempt: a fault
/// that fired once would be retried straight into a success and never reach
/// the failure path under test.
///
/// Driven in-process rather than through a spawned daemon on purpose. The
/// failure has to happen *inside* the coordinator, after the engine's rename
/// and before publication, and no external lever reaches there: chmod cannot
/// revoke write access from a file descriptor SQLite already holds open, so
/// souring the index under a running daemon is not possible on Unix. The
/// injected fault is the only instrument that reaches this window, and the
/// request still travels the real `Server::handle` dispatch arm and the real
/// `convert::mutation_failure` conversion — everything the wire shape depends
/// on.
fn a_write_that_lands_but_cannot_publish(
    fault: impl Fn() -> IndexError + Send + Sync + 'static,
) -> (TempDir, vault_protocol::ProtocolError) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("runtime config");
    let (sink, _notices) = sync_channel(64);

    // Stage 0 is disarmed. The test moves it to 1 immediately before the
    // write; the next call into the `IndexService` is the engine's own, which
    // must succeed, and every call after it fails. Counting from the arming
    // point rather than from process start keeps this immune to a retry
    // renumbering the startup catch-up.
    let stage = Arc::new(AtomicUsize::new(0));
    let hooks = RuntimeTestHooks {
        mutation_fault: Some(Arc::new({
            let stage = Arc::clone(&stage);
            move |_| match stage.load(Ordering::Acquire) {
                0 => None,
                1 => {
                    stage.store(2, Ordering::Release);
                    None
                }
                _ => Some(fault()),
            }
        })),
        ..RuntimeTestHooks::default()
    };
    let options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    let handle =
        Runtime::start_with_hooks(config, options, sink, hooks).expect("start the runtime");
    handle.refresh(false).expect("cold build");

    let server = Server::for_runtime(handle);
    let mut subscriptions = SubscriptionRegistry::new();
    stage.store(1, Ordering::Release);
    let response = server.handle(
        RequestEnvelope {
            version: 1,
            id: "w".into(),
            request: Request::WriteNote(WriteNoteParams {
                path: "One.md".into(),
                content: String::from_utf8(LANDED.to_vec()).expect("utf-8 fixture"),
                expected: Some(ExpectedDto {
                    revision: None,
                    absent: None,
                    any: Some(true),
                }),
            }),
        },
        &mut subscriptions,
    );

    let error = match response.outcome {
        ResponseOutcome::Err(error) => error,
        other => {
            panic!("the reconciliation failed, so the write must not report success: {other:?}")
        }
    };
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        LANDED,
        "the point of the whole distinction: the bytes really are on disk"
    );
    (vault, error)
}

/// The other half of `storage_failure`, and the one a client can act on
/// wrongly. `MutationError::Io` means **nothing landed** — retry is safe. A
/// reconciliation that fails *after* the engine's rename means **the bytes are
/// on disk** and only the index is behind — a retry under
/// `expected: {"absent": true}` will now meet `target_exists`, and one under
/// the old revision will meet `revision_conflict`. Same code, opposite next
/// move, so the two are told apart by the payload the protocol already
/// carries: `current_revision` names the revision the write put on disk.
#[test]
fn a_write_that_landed_but_could_not_publish_names_the_revision_on_disk() {
    let (_vault, error) = a_write_that_lands_but_cannot_publish(|| {
        IndexError::Storage("injected publication failure".into())
    });
    assert_eq!(error.code, ErrorCode::StorageFailure);
    assert_eq!(
        error.current_revision.as_deref(),
        Some(revision_of(LANDED).as_str()),
        "a write that reached disk must name the revision it wrote, so the client \
         knows not to retry blindly: {error:?}"
    );
}

/// **One code for one situation.** A landed-but-unpublished write must reach
/// the client as `storage_failure` *whatever* the reconciliation happened to
/// fail with — because the code is what a client branches on, and the two
/// facts it needs are "the index is behind" and "your bytes are there".
///
/// `vault_changed_during_refresh` is the shape that proves the point. Its own
/// documented meaning is "nothing was published", which is true of a refresh
/// and false of this: the write *did* land. Letting that code through here
/// would tell a client the exact opposite of what happened and recreate the
/// blind-retry hazard one code over from where it was fixed. So the mapping is
/// unconditional, and `current_revision` — present here, absent for a
/// pre-write `Io` failure — stays the only thing a client reads to tell the
/// two states apart.
#[test]
fn a_landed_write_reports_storage_failure_whatever_the_reconciliation_failed_with() {
    let (_vault, error) =
        a_write_that_lands_but_cannot_publish(|| IndexError::VaultChangedDuringRefresh);
    assert_eq!(
        error.code,
        ErrorCode::StorageFailure,
        "vault_changed_during_refresh means nothing was published; this write was: {error:?}"
    );
    assert_eq!(
        error.current_revision.as_deref(),
        Some(revision_of(LANDED).as_str()),
        "the proof the bytes landed must survive the normalisation: {error:?}"
    );
}

/// The Task 12 tripwire's folder twin, flipped — it was
/// `task_12_must_flip_this_folder_rename_still_breaks_inbound_links` while
/// link repair was unbuilt.
///
/// A folder rename moves every note under it at once, so it is the shape with
/// the most inbound references to repair and the most to break by not
/// repairing them. The design says `rename_folder` "repairs inbound references
/// for every contained note", and `rewrite_links` defaults `true`.
///
/// The claim is pinned with a before/after pair: the reference resolves while
/// the folder is where it was, and still resolves — at the new path — once it
/// has moved. The path form is what makes that mean something, and the
/// spelling stays a path form: shortening `[[Renamed/One]]` to `[[One]]`
/// would resolve too, and would be a rewrite the author never asked for.
#[test]
fn a_folder_rename_repairs_every_inbound_link_by_default() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir(vault.path().join("Folder")).expect("create Folder");
    std::fs::write(vault.path().join("Folder/One.md"), "# One\n").expect("write One");
    // The path form, not `[[One]]`: a bare basename would still resolve after
    // the folder moved, since the file keeps its name, and the test would
    // prove nothing.
    std::fs::write(vault.path().join("Two.md"), "# Two\n[[Folder/One]]\n").expect("write Two");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let before = daemon.call(
        r#"{"version":1,"id":"b","request":{"method":"get_note","params":{"path":"Two.md"}}}"#,
    );
    match before.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => assert!(
            matches!(
                response.note.outgoing[0].resolution,
                vault_protocol::ResolutionDto::Resolved { .. }
            ),
            "the fixture must start with a reference that actually resolves, or the \
             after-assertion proves nothing: {:?}",
            response.note.outgoing[0].resolution
        ),
        other => panic!("get_note failed: {other:?}"),
    }

    // `rewrite_links` deliberately unspelled: the wire default is `true`.
    let renamed = daemon.call(
        r#"{"version":1,"id":"n","request":{"method":"rename_folder","params":{"from":"Folder","to":"Renamed"}}}"#,
    );
    match renamed.outcome {
        ResponseOutcome::Ok(Response::RenameFolder(response)) => {
            assert_eq!(response.links_rewritten, 1);
            assert!(
                response.link_rewrite_failures.is_empty(),
                "nothing was skipped, so nothing may be reported as skipped: {:?}",
                response.link_rewrite_failures
            );
            assert!(
                response.revision.is_none(),
                "a folder has no bytes to hash, so it reports no revision at all"
            );
        }
        other => panic!("rename_folder did not reach the engine: {other:?}"),
    }

    assert!(vault.path().join("Renamed/One.md").is_file());
    assert_eq!(
        std::fs::read_to_string(vault.path().join("Two.md")).expect("read Two back"),
        "# Two\n[[Renamed/One]]\n",
    );

    let after = daemon.call(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"Two.md"}}}"#,
    );
    match after.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => {
            assert_eq!(response.note.outgoing.len(), 1);
            assert!(
                matches!(
                    &response.note.outgoing[0].resolution,
                    vault_protocol::ResolutionDto::Resolved { target, .. }
                        if target == "Renamed/One.md"
                ),
                "the repaired reference must resolve at the new path: {:?}",
                response.note.outgoing[0].resolution
            );
        }
        other => panic!("get_note failed: {other:?}"),
    }
}
