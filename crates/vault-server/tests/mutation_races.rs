//! Two racing writers through the real `vaultd` process. Exactly one wins,
//! the loser is told precisely why, and the file holds one of the two
//! payloads whole.
//!
//! The harness here is deliberately its own rather than `live_stdio.rs`'s or
//! Task 9's shared `tests/daemon/mod.rs`: a race sends **two requests before
//! reading either response**, and both of those helpers are `call`-shaped —
//! they write one line and block for its answer, which serialises exactly the
//! thing under test.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::{ErrorCode, ResponseEnvelope, ResponseOutcome};

/// Generous on purpose: this bound exists to turn a hang into a failing test,
/// not to assert anything about timing.
const LINE_TIMEOUT: Duration = Duration::from_secs(20);

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

impl Daemon {
    fn start(arguments: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        writeln!(stdin, "{line}").expect("write a request");
        stdin.flush().expect("flush the request");
    }

    /// The next *response* line, skipping any events that interleave.
    fn response(&mut self) -> ResponseEnvelope {
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            if value
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"))
            {
                return serde_json::from_str(&raw).expect("decode a response envelope");
            }
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[test]
fn two_writers_racing_on_one_note_produce_one_winner_and_one_typed_conflict() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let index_path = index.path().join("index.sqlite3");

    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index_path.to_str().expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
    ]);

    daemon.send(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.response();

    daemon.send(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"One.md"}}}"#,
    );
    let note = daemon.response();
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

    let first = daemon.response();
    let second = daemon.response();
    let outcomes = [first.outcome, second.outcome];
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
    let index_path = index.path().join("index.sqlite3");

    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index_path.to_str().expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
    ]);
    daemon.send(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.response();

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
