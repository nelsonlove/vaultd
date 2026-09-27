//! Every typed refusal, over the real transport, in one place. The claim is
//! narrow and worth pinning: a client branches on `code`, so a code that maps
//! to `internal` or to the wrong neighbour is a client bug this daemon caused.

mod daemon;

use std::sync::Arc;
use std::sync::mpsc::sync_channel;

use daemon::Daemon;
use tempfile::TempDir;
use vault_index::IndexConfig;
use vault_protocol::{
    ErrorCode, ExpectedDto, Request, RequestEnvelope, ResponseOutcome, WriteNoteParams,
};
use vault_server::Server;
use vault_server::broadcast::ConnectionId;
use vault_server::runtime::{Runtime, RuntimeOptions, RuntimeTestHooks};
use vault_server::subscriptions::SubscriptionRegistry;

/// A vault with one note, one attachment, one folder, and a configuration
/// zone: enough for every refusal below without a per-case fixture.
fn fixture() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create Folder");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(vault.path().join("image.png"), [1u8, 2, 3]).expect("write an attachment");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    (vault, index, daemon)
}

#[test]
fn every_state_refusal_reaches_the_wire_with_its_own_code() {
    let (vault, _index, mut daemon) = fixture();

    let cases: [(ErrorCode, &str, &str); 8] = [
        // The target is not there at all.
        (
            ErrorCode::NotFound,
            "delete_note",
            r#"{"path":"Gone.md","mode":"permanent","expected":{"any":true}}"#,
        ),
        // The target's *parent* is not there. Distinct from `not_found`
        // because the fix is different: create the folder, then retry.
        (
            ErrorCode::ParentNotFound,
            "write_note",
            r#"{"path":"Missing/New.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // There is no overwrite-on-rename.
        (
            ErrorCode::TargetExists,
            "rename_note",
            r#"{"from":"One.md","to":"Folder/Two.md","expected":{"any":true},"rewrite_links":false}"#,
        ),
        // Stricter than Obsidian, on purpose: APFS would silently overwrite.
        (
            ErrorCode::CaseCollision,
            "write_note",
            r#"{"path":"one.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // Nothing in the zone is ever semantic.
        (
            ErrorCode::ZoneViolation,
            "write_note",
            r#"{"path":".obsidian/note.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // The raw pair's own zone rule, and the mirror of the row above: a
        // `.md` path *outside* the zone is refused by `write_file` so a note
        // can never reach disk without joining a generation.
        (
            ErrorCode::InvalidRequest,
            "write_file",
            r#"{"path":"Raw.md","content_base64":"IyBSYXcK","expected":{"absent":true}}"#,
        ),
        // 16 MiB is the cap; ~22 MB of base64 is comfortably past it and
        // still cheap to build.
        (
            ErrorCode::PayloadTooLarge,
            "write_file",
            "PLACEHOLDER_OVERSIZED",
        ),
        // The fifth concurrent snapshot, against a cap of four.
        (
            ErrorCode::TooManySnapshots,
            "open_snapshot",
            "PLACEHOLDER_FIFTH_SNAPSHOT",
        ),
    ];

    for (expected, method, params) in cases {
        let params = match params {
            "PLACEHOLDER_OVERSIZED" => {
                // 17 MiB of zero bytes, base64-encoded: past the cap, and the
                // encoder is the same one the daemon decodes with.
                use base64::Engine as _;
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(vec![0u8; 17 * 1024 * 1024]);
                format!(
                    r#"{{"path":"huge.bin","content_base64":"{encoded}","expected":{{"absent":true}}}}"#
                )
            }
            "PLACEHOLDER_FIFTH_SNAPSHOT" => {
                // The default cap is four. Open four and leave them open; the
                // fifth is the case under test.
                for index in 0..4 {
                    let opened = daemon.call(&format!(
                        r#"{{"version":1,"id":"s{index}","request":{{"method":"open_snapshot","params":{{}}}}}}"#
                    ));
                    assert!(
                        matches!(opened.outcome, ResponseOutcome::Ok(_)),
                        "snapshot {index} of the first four must open: {:?}",
                        opened.outcome
                    );
                }
                "{}".to_string()
            }
            other => other.to_string(),
        };
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"e","request":{{"method":"{method}","params":{params}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => {
                assert_eq!(error.code, expected, "wrong code for {method}: {error:?}");
                // `invalid_request` is the one catch-all in the table — seven
                // distinct `MutationError`s map to it — so the code alone
                // would still pass if this row started failing for an
                // unrelated reason, a malformed precondition say. Pin the
                // refusal it is actually about.
                if expected == ErrorCode::InvalidRequest {
                    assert!(
                        error.message.contains("write_note"),
                        "the note refusal must name the verb that serves the path: {}",
                        error.message
                    );
                }
            }
            other => panic!("{method} was not refused: {other:?}"),
        }
    }

    // Every refusal above changed nothing.
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert_eq!(
        std::fs::read(vault.path().join("Folder/Two.md")).expect("read back"),
        b"# Two\n"
    );
    assert!(!vault.path().join("huge.bin").exists());
    assert!(!vault.path().join("Raw.md").exists());
    assert!(!vault.path().join("Missing").exists());
    assert!(!vault.path().join(".obsidian/note.md").exists());
}

#[test]
fn content_that_is_not_base64_is_refused_before_anything_is_written() {
    let (vault, _index, mut daemon) = fixture();
    for encoded in ["not base64 at all!", "AAE", "====", "AA=A"] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"b","request":{{"method":"write_file","params":{{"path":"raw.bin","content_base64":"{encoded}","expected":{{"absent":true}}}}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => {
                assert_eq!(
                    error.code,
                    ErrorCode::InvalidRequest,
                    "wrong code for {encoded:?}: {error:?}"
                );
                assert!(
                    error.message.contains("content_base64"),
                    "the refusal must name the field: {}",
                    error.message
                );
            }
            other => panic!("{encoded:?} was accepted as base64: {other:?}"),
        }
    }
    assert!(!vault.path().join("raw.bin").exists());
}

/// The two codes that are not mutation refusals at all: the mutation never
/// reached the engine. Both are produced by `Server::mutate`'s own path —
/// `runtime_not_ready` is built there directly rather than through
/// `convert::mutation_failure`, so nothing else in the suite would notice it
/// drifting.
#[test]
fn a_daemon_with_no_vault_refuses_a_mutation_as_runtime_not_ready() {
    // No `--vault`: health-only mode has no runtime, so there is nothing a
    // mutation could reach.
    let mut daemon = Daemon::start(&[]);
    let response = daemon.call(
        r#"{"version":1,"id":"n","request":{"method":"write_note","params":{"path":"One.md","content":"x\n","expected":{"any":true}}}}"#,
    );
    match response.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::RuntimeNotReady);
            assert!(
                error.message.contains("no vault"),
                "the refusal must say why: {}",
                error.message
            );
        }
        other => panic!("a vault-less daemon accepted a mutation: {other:?}"),
    }
}

/// A saturated command mailbox. In process rather than over stdio, because
/// the transport serialises requests and a client therefore cannot fill the
/// mailbox from outside — the only honest way to reach this arm is to park
/// the coordinator and fill it directly.
#[test]
fn a_mutation_that_cannot_reach_a_saturated_coordinator_is_runtime_overloaded() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("runtime config");

    // The coordinator parks inside the startup catch-up until this test
    // releases it, so nothing drains the mailbox meanwhile.
    let gate = Arc::new(std::sync::Barrier::new(2));
    let hooks = RuntimeTestHooks {
        before_catch_up: Some({
            let gate = Arc::clone(&gate);
            Arc::new(move || {
                gate.wait();
                gate.wait();
            })
        }),
        ..RuntimeTestHooks::default()
    };
    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        config,
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            command_capacity: 1,
            ..RuntimeOptions::default()
        },
        sink,
        hooks,
    )
    .expect("start the runtime");

    gate.wait();
    let note = vault_core::VaultPath::new("One.md").expect("valid vault path");
    assert!(handle.hint(vault_watch::ChangeHint::Paths([note].into_iter().collect())));

    // The mailbox now holds its one command and the coordinator is parked, so
    // this mutation cannot be queued at all.
    let server = Server::for_runtime(handle);
    let mut subscriptions = SubscriptionRegistry::new();
    let response = server.handle(
        ConnectionId::STANDALONE,
        RequestEnvelope {
            version: 1,
            id: "o".into(),
            request: Request::WriteNote(WriteNoteParams {
                path: "One.md".into(),
                content: "# changed\n".into(),
                expected: Some(ExpectedDto {
                    revision: None,
                    absent: None,
                    any: Some(true),
                }),
            }),
        },
        &mut subscriptions,
    );
    match response.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::RuntimeOverloaded),
        other => panic!("a mutation that never reached the coordinator reported {other:?}"),
    }
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n",
        "a mutation that never reached the coordinator wrote nothing"
    );

    gate.wait();
    server.shutdown();
}
