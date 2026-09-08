//! A spawned `vaultd` over stdio, for the tests that must cross the real
//! transport. Deliberately smaller than `tests/live_stdio.rs`'s harness:
//! that one classifies every line into a `Line` enum and asserts on the
//! classification, and duplicating it here would couple two suites'
//! transport expectations together. This one answers two questions only —
//! "what was the response" and "did an event I asked about arrive" — and
//! keeps event lines in a buffer rather than classifying them, so a
//! subscribed test can still use the ordinary `call` shape.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::{EventEnvelope, ResponseEnvelope};

/// Generous on purpose: this bound exists to turn a hang into a failing test,
/// not to assert anything about timing.
pub const LINE_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    /// Event lines [`Daemon::response`] stepped over on its way to an answer.
    ///
    /// Kept rather than dropped so a test can subscribe and still use the
    /// ordinary `call` shape: events and responses share one stdout, and an
    /// event that arrived while a response was outstanding is not noise — for
    /// `tests/mutation_oracle.rs` it is the only surface on which the daemon
    /// says anything about tree paths at all.
    events: Vec<String>,
}

impl Daemon {
    pub fn start(arguments: &[&str]) -> Self {
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
            events: Vec::new(),
        }
    }

    /// A daemon over `vault` with its index in `index`, watcher and periodic
    /// tick off, so every generation in a test is one the test caused.
    #[allow(dead_code)]
    pub fn for_vault(vault: &TempDir, index: &TempDir) -> Self {
        Self::start(&[
            "--vault",
            vault.path().to_str().expect("utf-8 vault path"),
            "--index",
            index
                .path()
                .join("index.sqlite3")
                .to_str()
                .expect("utf-8 index path"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
        ])
    }

    /// Send one request line without waiting for its answer.
    ///
    /// Split out from [`Daemon::call`] because a race test sends **two**
    /// requests before reading either response, and a `call`-shaped helper
    /// serialises exactly the pipelining such a test exists to exercise.
    pub fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        writeln!(stdin, "{line}").expect("write a request");
        stdin.flush().expect("flush the request");
    }

    /// The next *response* line, skipping any events that interleave.
    pub fn response(&mut self) -> ResponseEnvelope {
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
            self.events.push(raw);
        }
    }

    /// Wait for the first event satisfying `wanted`, including events already
    /// stepped over by an earlier [`Daemon::response`], and return it.
    ///
    /// Bounded by [`LINE_TIMEOUT`] and panicking on expiry, for the reason
    /// that constant exists: a missing event must fail the test rather than
    /// hang it. Events not matching `wanted` are kept, because a caller
    /// waiting for one generation's event has not consumed the next one's.
    ///
    /// Allowed dead because this module compiles into each test binary
    /// separately and only `tests/mutation_oracle.rs` subscribes.
    #[allow(dead_code)]
    pub fn wait_for_event(&mut self, wanted: impl Fn(&EventEnvelope) -> bool) -> EventEnvelope {
        let mut kept = Vec::new();
        let mut found = None;
        for raw in std::mem::take(&mut self.events) {
            let event: EventEnvelope = serde_json::from_str(&raw).expect("decode an event");
            if found.is_none() && wanted(&event) {
                found = Some(event);
            } else {
                kept.push(raw);
            }
        }
        self.events = kept;
        if let Some(event) = found {
            return event;
        }
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => {
                    panic!("no matching event within {LINE_TIMEOUT:?}")
                }
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            if value
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"))
            {
                panic!("expected an event, got a response: {raw}");
            }
            let event: EventEnvelope = serde_json::from_str(&raw).expect("decode an event");
            if wanted(&event) {
                return event;
            }
            self.events.push(raw);
        }
    }

    /// Send one request line and return its response — the ordinary shape,
    /// for a test that is not deliberately pipelining.
    pub fn call(&mut self, line: &str) -> ResponseEnvelope {
        self.send(line);
        self.response()
    }

    /// Close stdin and wait. The daemon must exit rather than hang.
    ///
    /// Allowed dead because this module is compiled into each test binary
    /// separately: `tests/snapshots.rs` calls it — a client that disconnects
    /// with a session open is the one release path a unit test cannot reach —
    /// and the other binaries do not. The allow is on this one item rather
    /// than the file, so anything else that goes dead here still shows up.
    #[allow(dead_code)]
    pub fn disconnect(&mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().expect("the daemon exits")
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
