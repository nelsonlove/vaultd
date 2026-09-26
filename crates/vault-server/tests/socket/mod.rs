//! A spawned `vaultd --listen`, and one client connection per `connect`.
//!
//! Deliberately close in shape to `tests/daemon/mod.rs` — `send`, `response`,
//! `wait_for_event` — because the conformance test in Task 7 runs one fixture
//! set through both and any difference in the harnesses would show up as a
//! difference in the transports.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vault_protocol::{EventEnvelope, ResponseEnvelope};

/// Generous on purpose: this bound turns a hang into a failing test, and
/// asserts nothing about timing.
pub const LINE_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a daemon is given to create its socket file and answer on it.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// A listening daemon. Its clients are [`Client`]s; it has no stdio client of
/// its own here, because `stdin` is inherited as a pipe and left unwritten.
pub struct ListeningDaemon {
    child: Child,
    socket: PathBuf,
}

impl ListeningDaemon {
    /// A daemon over `vault`, index in `index`, listening at a path inside
    /// `run`, with the watcher and the periodic tick off so every generation
    /// in a test is one the test caused.
    pub fn start(vault: &TempDir, index: &TempDir, run: &TempDir) -> Self {
        let socket = run.path().join("vaultd.sock");
        Self::start_at(vault, index, &socket)
    }

    pub fn start_at(vault: &TempDir, index: &TempDir, socket: &Path) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args([
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
                "--listen",
                socket.to_str().expect("utf-8 socket path"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd --listen");
        let daemon = Self {
            child,
            socket: socket.to_path_buf(),
        };
        daemon.await_ready();
        daemon
    }

    /// Readiness is exactly what the design says it is: the socket file exists
    /// and `health` answers. There is no ready line on stdout, because stdout
    /// is connection zero's protocol stream.
    fn await_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if self.socket.exists() {
                if let Ok(stream) = UnixStream::connect(&self.socket) {
                    let mut client = Client::over(stream);
                    let answer =
                        client.call(r#"{"version":1,"id":"ready","request":{"method":"health"}}"#);
                    assert_eq!(answer.id, "ready");
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "vaultd never answered health at {} within {READY_TIMEOUT:?}",
            self.socket.display()
        );
    }

    /// Unused until the shutdown tests, which assert the socket file is gone.
    #[allow(dead_code)]
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// Unused until the shutdown tests, which signal the daemon by pid.
    #[allow(dead_code)]
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// One new connection to this daemon.
    pub fn connect(&self) -> Client {
        Client::over(UnixStream::connect(&self.socket).expect("connect to the daemon"))
    }
}

impl Drop for ListeningDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One connection, with the same two questions `tests/daemon` answers: what
/// was the response, and did an event I asked about arrive.
pub struct Client {
    stream: UnixStream,
    lines: Receiver<String>,
    events: Vec<String>,
}

impl Client {
    pub fn over(stream: UnixStream) -> Self {
        let reading = stream
            .try_clone()
            .expect("clone the connection for reading");
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(reading).lines() {
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
            stream,
            lines,
            events: Vec::new(),
        }
    }

    pub fn send(&mut self, line: &str) {
        writeln!(self.stream, "{line}").expect("write a request");
        self.stream.flush().expect("flush the request");
    }

    /// The next *response* line, keeping any events that interleave.
    pub fn response(&mut self) -> ResponseEnvelope {
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed the connection"),
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

    pub fn call(&mut self, line: &str) -> ResponseEnvelope {
        self.send(line);
        self.response()
    }

    /// Wait for the first event satisfying `wanted`, including events already
    /// stepped over by an earlier [`Client::response`].
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
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed the connection"),
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

    /// Stop reading, without closing the connection. The slow-client case in
    /// Task 8 needs exactly this: a peer that is alive and not draining.
    #[allow(dead_code)]
    pub fn stop_reading(&mut self) -> Receiver<String> {
        std::mem::replace(&mut self.lines, channel().1)
    }

    /// Close this connection and let the daemon reap it.
    #[allow(dead_code)]
    pub fn disconnect(self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
