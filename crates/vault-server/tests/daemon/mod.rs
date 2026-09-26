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

/// Which door a run goes through. Lives here rather than in `socket/mod.rs`
/// because the conformance test names one enum and picks a harness from it.
///
/// Allowed dead for the reason every other helper in this file is: the module
/// compiles into each test binary separately, and only
/// `tests/conformance.rs` parameterizes itself by transport.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    Stdio,
    Socket,
}

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
    ///
    /// Allowed dead for the same reason as [`Daemon::wait_for_event`] above:
    /// this module compiles into each test binary separately, and
    /// `tests/read_only.rs` needs its daemon to carry an extra flag
    /// (`--read-only`), so it spells its own argument list out with
    /// [`Daemon::start`] rather than calling this. Most binaries that declare
    /// `mod daemon;` do call it — unlike `wait_for_event`, this helper is not
    /// dead everywhere, only in that one binary's own compilation.
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
    ///
    /// Allowed dead for this file's usual reason: `tests/conformance.rs`
    /// compares raw bytes and so reaches only [`Daemon::call_raw`], which does
    /// not go through here.
    #[allow(dead_code)]
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
    ///
    /// Allowed dead for the same reason as [`Daemon::response`] above.
    #[allow(dead_code)]
    pub fn call(&mut self, line: &str) -> ResponseEnvelope {
        self.send(line);
        self.response()
    }

    /// The next response line, as the bytes the daemon wrote.
    ///
    /// Deserializing and re-serializing would defeat the one thing an
    /// additive-field test must prove: that the field is absent from the
    /// wire, not merely `None` after a decode that defaults it.
    #[allow(dead_code)]
    pub fn call_raw(&mut self, line: &str) -> String {
        self.send(line);
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
                return raw;
            }
            self.events.push(raw);
        }
    }

    /// Every line this daemon wrote in answer to `line`, **in arrival order**:
    /// the events that landed while the response was outstanding, then the
    /// response itself.
    ///
    /// The difference from [`Daemon::call_raw`] is the whole point: `call_raw`
    /// buries the events it steps over in a side buffer, which loses where
    /// they arrived relative to the responses. A transport that held every
    /// event back to the end of the connection, or delivered one before its
    /// `subscribe_events` response, is invisible to a transcript assembled
    /// that way and obvious in one assembled this way.
    #[allow(dead_code)]
    pub fn exchange(&mut self, line: &str) -> Vec<String> {
        let mut written = std::mem::take(&mut self.events);
        self.send(line);
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let is_response = serde_json::from_str::<serde_json::Value>(&raw)
                .expect("a JSON line")
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"));
            written.push(raw);
            if is_response {
                return written;
            }
        }
    }

    /// Every event line this daemon has written and no call has claimed, plus
    /// whatever is still in flight after a short settle.
    ///
    /// The settle is a real wait rather than a rendezvous, and it is the one
    /// in this file: the events being collected are the tail of a mutation
    /// that has already been answered, so there is no observable state to wait
    /// on — only "has the writer got to them yet". It is bounded and it can
    /// only produce a **short** transcript, never a wrong one, and a short
    /// transcript fails the length assertion loudly.
    ///
    /// A closed stream ends the drain immediately rather than spinning out the
    /// budget on a channel that can never deliver again: `Disconnected` is a
    /// final answer, `Timeout` only a quiet moment.
    #[allow(dead_code)]
    pub fn drain_events(&mut self) -> Vec<String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            match self.lines.recv_timeout(Duration::from_millis(50)) {
                Ok(raw) => self.events.push(raw),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        std::mem::take(&mut self.events)
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
