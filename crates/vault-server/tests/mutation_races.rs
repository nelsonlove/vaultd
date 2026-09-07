//! Two pipelined writers on one note, through the real `vaultd` process.
//!
//! What this proves is compare-and-swap under pipelining, not a forced race,
//! and the distinction is worth stating rather than blurring: vaultd is
//! single-writer by lease and applies one mutation at a time in mailbox order,
//! so two requests sent before either response is read cannot interleave
//! inside the engine. What they *can* do is arrive with the same expected
//! revision, and the claim under test is that the second one is then refused,
//! told exactly what beat it, and leaves the file holding one payload whole.
//!
//! The forced-window proof — a writer parked mid-mutation while a foreign
//! process commits — lives in `vault-index`'s own `tests/mutation_races.rs`,
//! where a hook can open the window a lease cannot.
//!
//! Both requests really are written before either response is read; that is
//! why this suite uses `Daemon::send` / `Daemon::response` rather than the
//! `call` helper, which would serialise them.

mod daemon;

use tempfile::TempDir;
use vault_protocol::{ErrorCode, ResponseOutcome};

use daemon::Daemon;

#[test]
fn two_writers_racing_on_one_note_produce_one_winner_and_one_typed_conflict() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let note = daemon.call(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"One.md"}}}"#,
    );
    let revision = match note.outcome {
        ResponseOutcome::Ok(vault_protocol::Response::GetNote(response)) => response.note.revision,
        other => panic!("expected a note, got {other:?}"),
    };

    // Both writes name the same expected revision. Only one can be true by
    // the time the second is applied, and the daemon applies them in mailbox
    // order on one thread.
    daemon.send(&format!(
        r##"{{"version":1,"id":"w1","request":{{"method":"write_note","params":{{"path":"One.md","content":"# first\n","expected":{{"revision":"{revision}"}}}}}}}}"##
    ));
    daemon.send(&format!(
        r##"{{"version":1,"id":"w2","request":{{"method":"write_note","params":{{"path":"One.md","content":"# second\n","expected":{{"revision":"{revision}"}}}}}}}}"##
    ));

    let outcomes = [daemon.response().outcome, daemon.response().outcome];
    let winners = outcomes
        .iter()
        .filter(|outcome| matches!(outcome, ResponseOutcome::Ok(_)))
        .count();
    assert_eq!(winners, 1, "exactly one writer may win: {outcomes:?}");

    let conflict = outcomes
        .iter()
        .find_map(|outcome| match outcome {
            ResponseOutcome::Err(error) => Some(error),
            ResponseOutcome::Ok(_) => None,
        })
        .expect("the loser must be told");
    assert_eq!(conflict.code, ErrorCode::RevisionConflict);
    assert!(
        conflict.current_revision.is_some(),
        "the loser needs the revision it should retry against"
    );

    let bytes = std::fs::read(vault.path().join("One.md")).expect("read back");
    assert!(
        bytes == b"# first\n" || bytes == b"# second\n",
        "the file must hold one payload whole, not a blend: {bytes:?}"
    );
}

#[test]
fn a_create_that_loses_its_race_reports_the_revision_that_beat_it() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Seed.md"), "# Seed\n").expect("write Seed");

    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    daemon.send(
        r##"{"version":1,"id":"c1","request":{"method":"write_note","params":{"path":"New.md","content":"# first\n","expected":{"absent":true}}}}"##,
    );
    daemon.send(
        r##"{"version":1,"id":"c2","request":{"method":"write_note","params":{"path":"New.md","content":"# second\n","expected":{"absent":true}}}}"##,
    );
    let first = daemon.response();
    let second = daemon.response();
    assert!(matches!(first.outcome, ResponseOutcome::Ok(_)));
    match second.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::RevisionConflict);
            assert!(error.current_revision.is_some());
        }
        other => panic!("the second create must lose: {other:?}"),
    }
    assert_eq!(
        std::fs::read(vault.path().join("New.md")).expect("read back"),
        b"# first\n"
    );
}
