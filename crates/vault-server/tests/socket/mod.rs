//! A spawned `vaultd --listen`, and one client connection per `connect`.
//!
//! Deliberately close in shape to `tests/daemon/mod.rs` — `send`, `response`,
//! `wait_for_event` — because the conformance test in Task 7 runs one fixture
//! set through both and any difference in the harnesses would show up as a
//! difference in the transports.
//!
//! One harness, several test binaries, and each one compiles the whole module
//! and uses part of it — so `dead_code` here means "no binary needs this
//! yet", not "nothing needs this". Allowed once at the top rather than
//! item by item, which would otherwise have to be edited on both sides of
//! every test added in Tasks 5, 7 and 8.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vault_protocol::{EventEnvelope, ResponseEnvelope};

/// The scratch root for a test that must keep a Unix socket path short:
/// `<this crate>/../../target/tmp`, canonicalized and created if it does not
/// exist yet.
///
/// Deliberately **not** `std::env::temp_dir()`. That resolves `$TMPDIR`, and
/// a bare `cargo test` — one of the invocations these tests must also pass
/// under — leaves it unset, which would then bind a test's socket under the
/// real OS temp directory rather than this repo's own scratch tree. This
/// path is fixed and in-repo regardless of the environment a test runs in.
pub fn tmp_root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

/// Counts calls to [`short_runtime_dir`]. Only ever a per-process counter —
/// each test binary that links this module is its own process — so it gives
/// no guarantee across binaries, only within one.
static RUN_COUNTER: AtomicU32 = AtomicU32::new(0);

/// A short, freshly-created subdirectory of [`tmp_root`], for a test that
/// binds its own socket beneath it.
///
/// One base-36 digit and nothing more: a `TempDir`'s random `.tmpXXXXXX`
/// suffix is exactly what pushes a default socket path over the ~103-byte
/// `sockaddr_un` limit on a checkout nested this deep, so the subdirectory
/// name has to spend as little of that budget as the daemon's own path
/// still leaves room for. It is a counter rather than a strong unique id for
/// the same reason two different tests can already share a vault-scratch
/// tempdir's parent without colliding: every socket this directory ever
/// holds is also named for its own vault's digest, so two runs landing on
/// the same one-character subdirectory — even two different test binaries,
/// whose counters both start at zero — never collide on a filename.
pub fn short_runtime_dir() -> PathBuf {
    let n = RUN_COUNTER.fetch_add(1, Ordering::Relaxed) % 36;
    let digit = char::from_digit(n, 36).expect("n % 36 is a single base-36 digit");
    let dir = tmp_root().join(digit.to_string());
    std::fs::create_dir_all(&dir).expect("create the run subdirectory");
    dir
}

/// Generous on purpose: this bound turns a hang into a failing test, and
/// asserts nothing about timing.
pub const LINE_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a daemon is given to create its socket file and answer on it.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How long one readiness probe waits for its answer before trying again.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// One bounded question at `socket`: is a daemon answering `health` there?
///
/// **A socket file that accepts is not a daemon.** A stale listener left
/// behind by some other process accepts the connection and then never
/// answers, and the daemon under test replaces such a file only after its own
/// liveness probe has timed out — so a readiness check that blocked on the
/// first connection that succeeded would spend its whole budget talking to
/// the wrong socket while the daemon was still binding. Every probe is
/// therefore bounded and a silent one is simply retried.
fn answers(socket: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return false;
    };
    if stream.set_read_timeout(Some(PROBE_TIMEOUT)).is_err() {
        return false;
    }
    if writeln!(
        stream,
        r#"{{"version":1,"id":"ready","request":{{"method":"health"}}}}"#
    )
    .is_err()
    {
        return false;
    }
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .is_ok_and(|read| {
            read > 0 && line.contains(r#""id":"ready""#) && line.contains(r#""outcome""#)
        })
}

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
        Self::spawn_daemon(vault, index, Some(socket), None, socket.to_path_buf())
    }

    /// A daemon given `--listen` with **no value**, which is the branch that
    /// decides the default path for itself. `runtime_dir` becomes its
    /// `XDG_RUNTIME_DIR`, so the path it lands on is
    /// `<runtime_dir>/vaultd/<digest>.sock` and the caller can say where that
    /// is without the daemon telling it.
    ///
    /// Keep `runtime_dir` short. A Unix socket address is 103 bytes on this
    /// platform and this path spends 29 of them after the directory, so a
    /// deep scratch directory is refused by `PathTooLong` before anything
    /// binds — which is the listener working, not the test failing.
    pub fn start_on_its_default_socket(
        vault: &TempDir,
        index: &TempDir,
        runtime_dir: &Path,
        expected: PathBuf,
    ) -> Self {
        Self::spawn_daemon(vault, index, None, Some(runtime_dir), expected)
    }

    fn spawn_daemon(
        vault: &TempDir,
        index: &TempDir,
        socket: Option<&Path>,
        runtime_dir: Option<&Path>,
        expected: PathBuf,
    ) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_vaultd"));
        command.args([
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
        ]);
        // `--listen` takes 0 or 1 values: with a path it binds that, and with
        // none it works the path out itself.
        if let Some(socket) = socket {
            command.arg(socket.to_str().expect("utf-8 socket path"));
        }
        if let Some(runtime_dir) = runtime_dir {
            command.env("XDG_RUNTIME_DIR", runtime_dir);
        }
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd --listen");
        let daemon = Self {
            child,
            socket: expected,
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
            if answers(&self.socket) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "vaultd never answered health at {} within {READY_TIMEOUT:?}",
            self.socket.display()
        );
    }

    /// Unused until the shutdown tests, which assert the socket file is gone.
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// Unused until the shutdown tests, which signal the daemon by pid.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Poll for the daemon's exit, bounded. `None` means it was still running
    /// when `within` had passed.
    ///
    /// Never a bare `wait`: the failure this is written to catch is a daemon
    /// that does not stop, and a bare `wait` would hang the whole suite on it
    /// rather than fail one test.
    pub fn wait_for_exit(&mut self, within: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + within;
        loop {
            match self.child.try_wait().expect("poll the daemon") {
                Some(status) => return Some(status),
                None if Instant::now() >= deadline => return None,
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
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

    /// The next response line, as the bytes the daemon wrote.
    ///
    /// The twin of `daemon::Daemon::call_raw`, duplicated rather than shared
    /// because the two harnesses are two crates' worth of different plumbing
    /// around the same two questions, and a shared trait here would couple the
    /// thing being compared to the thing comparing it.
    pub fn call_raw(&mut self, line: &str) -> String {
        self.send(line);
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
                return raw;
            }
            self.events.push(raw);
        }
    }

    /// Every event line this connection has been sent and no call has claimed,
    /// plus whatever is still in flight after a short settle. The twin of
    /// `daemon::Daemon::drain_events`, with the same bound and the same
    /// reasoning: a slow writer can only make this transcript short, and a
    /// short transcript fails the length assertion loudly.
    pub fn drain_events(&mut self) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            match self.lines.recv_timeout(Duration::from_millis(50)) {
                Ok(raw) => self.events.push(raw),
                Err(_) => continue,
            }
        }
        std::mem::take(&mut self.events)
    }

    /// Wait for the first event satisfying `wanted`, including events already
    /// stepped over by an earlier [`Client::response`].
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

    /// The same search, bounded, and `None` when nothing matching arrived.
    ///
    /// For asserting an event does **not** come. The bound is one-sided on
    /// purpose: a slow machine can only make an absent event stay absent, so
    /// this cannot flake into a failure — only into a weaker pass, which is
    /// the right way round for a negative.
    pub fn try_wait_for_event(
        &mut self,
        wanted: impl Fn(&EventEnvelope) -> bool,
        within: Duration,
    ) -> Option<EventEnvelope> {
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
        if found.is_some() {
            return found;
        }
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            let raw = match self.lines.recv_timeout(left) {
                Ok(raw) => raw,
                Err(_) => return None,
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            if value
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"))
            {
                self.events.push(raw);
                continue;
            }
            let event: EventEnvelope = serde_json::from_str(&raw).expect("decode an event");
            if wanted(&event) {
                return Some(event);
            }
            self.events.push(raw);
        }
    }

    /// Stop reading, without closing the connection. The slow-client case in
    /// Task 8 needs exactly this: a peer that is alive and not draining.
    pub fn stop_reading(&mut self) -> Receiver<String> {
        std::mem::replace(&mut self.lines, channel().1)
    }

    /// Close this connection and let the daemon reap it.
    pub fn disconnect(self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
