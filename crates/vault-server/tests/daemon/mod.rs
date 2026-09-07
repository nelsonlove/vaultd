//! A spawned `vaultd` over stdio, for the tests that must cross the real
//! transport. Deliberately smaller than `tests/live_stdio.rs`'s harness: that
//! one classifies events as well as responses, and duplicating its `Line`
//! enum here would couple two suites' transport expectations together.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::ResponseEnvelope;

/// Generous on purpose: this bound exists to turn a hang into a failing test,
/// not to assert anything about timing.
pub const LINE_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
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
        }
    }

    /// A daemon over `vault` with its index in `index`, watcher and periodic
    /// tick off, so every generation in a test is one the test caused.
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

    /// Send one request line and return the next *response*, skipping any
    /// events that interleave.
    pub fn call(&mut self, line: &str) -> ResponseEnvelope {
        {
            let stdin = self.stdin.as_mut().expect("stdin is open");
            writeln!(stdin, "{line}").expect("write a request");
            stdin.flush().expect("flush the request");
        }
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

    /// Close stdin and wait. The daemon must exit rather than hang.
    ///
    /// Allowed dead because this module is compiled into each test binary
    /// separately and no current consumer calls it; Tasks 14/16/17 are its
    /// intended callers. The allow is on this one item rather than the file,
    /// so anything else that goes dead here still shows up.
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
