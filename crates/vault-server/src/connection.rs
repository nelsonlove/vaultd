//! One connection: one reader, one dispatcher, one writer, one registry.
//!
//! This is the loop the stdio transport shipped with, made transport-neutral.
//! Everything that loop argued still holds, **per connection**:
//!
//! * **Nothing tears.** Exactly one thread ever serializes an envelope or
//!   writes a byte to this connection's stream, so a response line can never
//!   be split by an event line.
//! * **Registration is unambiguous.** Requests and runtime notices share the
//!   dispatcher's single input queue, so a subscription is definitively
//!   registered before or after each commit notice.
//! * **Ordering is structural.** A `subscribe_events` response is written
//!   before its subscription is activated; an `unsubscribe` response is
//!   written after that subscription's queue is drained.
//!
//! What is now per connection rather than per process: the
//! [`SubscriptionRegistry`] the dispatcher owns, and the three threads. What
//! stays shared: the [`Server`], behind an `Arc`, and through it the runtime's
//! single coordinator — so two connections cannot interleave a mutation — and
//! the snapshot sessions, which are still one process-wide registry on
//! `Server` that any dispatcher's sweep reaches. Those sessions are scoped by
//! ownership rather than by storage: each is recorded against the
//! [`ConnectionId`] that opened it, a stranger naming one is answered
//! `snapshot_not_found`, and [`serve`] closes what this connection owned on
//! its way out.
//!
//! Backpressure still never reaches the runtime. A connection's notice
//! producer (the coordinator's own channel for stdio, the broadcaster's inbox
//! for a socket) is fed with a non-blocking send by whoever owns it, so a
//! dispatcher busy inside `refresh_index` cannot deadlock the coordinator: the
//! notice is dropped, the gap latched, and announced later as a resync. Inside
//! the connection both remaining legs may block, deliberately: the forwarder
//! may block feeding the dispatcher, and the dispatcher may block feeding the
//! writer if a client has stopped reading its own end of the stream. Neither
//! can stall indexing.

use std::io::{self, BufRead, Write};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::JoinHandle;

use serde::Deserialize;
use vault_protocol::{
    ErrorCode, EventEnvelope, ProtocolError, Request, RequestEnvelope, ResponseEnvelope,
    validate_version,
};

use crate::Server;
use crate::broadcast::ConnectionId;
use crate::runtime::RuntimeNotice;
use crate::subscriptions::SubscriptionRegistry;

/// How many inputs may wait for one dispatcher. Deep enough that an ordinary
/// request burst never blocks a producer, shallow enough that a wedged
/// dispatcher is felt rather than buffered indefinitely.
pub(crate) const INPUT_CAPACITY: usize = 256;

/// How many finished envelopes may wait for one writer.
pub(crate) const OUTPUT_CAPACITY: usize = 256;

/// First parse stage: the envelope with the request left undecoded, so the
/// version can be validated before the version-specific method enum is
/// applied.
///
/// `request` is the raw, unparsed JSON text for the `request` field rather
/// than a `serde_json::Value`: `serde_json::Map` is a `BTreeMap` in this
/// build, so routing through `Value` would alphabetize every nested JSON
/// object before the method-specific params ever see it — silently reordering,
/// for example, a frontmatter patch's `Mapping` keys. Decoding straight from
/// `request.get()`'s bytes (see [`respond`]) preserves document order end to
/// end.
#[derive(Debug, Deserialize)]
pub struct RawRequestEnvelope {
    pub version: u16,
    pub id: String,
    pub request: Box<serde_json::value::RawValue>,
}

/// Everything one dispatcher can be handed, from either producer.
#[derive(Debug)]
pub enum ServerInput {
    Request(Box<RawRequestEnvelope>),
    Notice(Box<RuntimeNotice>),
    /// The connection's input reached end of file. A normal close.
    InputClosed,
    /// Input arrived that has no usable envelope at all. Fatal for this
    /// connection: it cannot be answered, and cannot be identified.
    FatalInput(String),
}

/// One finished line, ready for this connection's single writer.
#[derive(Debug)]
pub enum OutputEnvelope {
    Response(Box<ResponseEnvelope>),
    Event(Box<EventEnvelope>),
}

/// What this connection's threads are called, so a panic names the door.
pub(crate) struct ThreadLabels {
    pub reader: String,
    pub writer: String,
    pub notices: String,
}

impl ThreadLabels {
    /// The three labels for one connection, suffixed with `suffix`.
    pub fn for_connection(suffix: &str) -> Self {
        Self {
            reader: format!("vaultd-read-{suffix}"),
            writer: format!("vaultd-write-{suffix}"),
            notices: format!("vaultd-notices-{suffix}"),
        }
    }
}

/// Two-stage validation, retained exactly: the version is checked against the
/// undecoded envelope, so an unsupported version is refused even when it names
/// a method this server has never heard of.
fn respond(
    server: &Server,
    connection: ConnectionId,
    subscriptions: &mut SubscriptionRegistry,
    raw: RawRequestEnvelope,
) -> ResponseEnvelope {
    if let Err(error) = validate_version(raw.version) {
        return ResponseEnvelope::error(raw.id, error);
    }
    match serde_json::from_str::<Request>(raw.request.get()) {
        Ok(request) => server.handle(
            connection,
            RequestEnvelope {
                version: raw.version,
                id: raw.id,
                request,
            },
            subscriptions,
        ),
        Err(error) => ResponseEnvelope::error(
            raw.id,
            ProtocolError {
                code: ErrorCode::InvalidRequest,
                message: format!("invalid request: {error}"),
                supported_version: None,
                current_generation: None,
                current_revision: None,
            },
        ),
    }
}

/// Read newline-delimited requests until end of file. Parses only the
/// envelope; the method is decoded by the dispatcher.
fn read_input(reader: impl BufRead, inputs: SyncSender<ServerInput>) {
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let _ = inputs.send(ServerInput::FatalInput(error.to_string()));
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<RawRequestEnvelope>(&line) {
            Ok(raw) => {
                if inputs.send(ServerInput::Request(Box::new(raw))).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = inputs.send(ServerInput::FatalInput(error.to_string()));
                return;
            }
        }
    }
    let _ = inputs.send(ServerInput::InputClosed);
}

/// Move runtime notices onto this dispatcher's single input queue. Blocking
/// here is safe and deliberate: whoever feeds this receiver never blocks, so a
/// slow dispatcher costs dropped notices (announced later as a resync) rather
/// than a stalled producer.
fn forward_notices(notices: Receiver<RuntimeNotice>, inputs: SyncSender<ServerInput>) {
    while let Ok(notice) = notices.recv() {
        if inputs.send(ServerInput::Notice(Box::new(notice))).is_err() {
            return;
        }
    }
}

/// The only code that serializes an envelope or writes a byte to this
/// connection's stream. Stops at the first write failure and reports it.
fn write_output(mut sink: impl Write, outputs: Receiver<OutputEnvelope>) -> io::Result<()> {
    for envelope in outputs {
        match envelope {
            OutputEnvelope::Response(response) => serde_json::to_writer(&mut sink, &response)?,
            OutputEnvelope::Event(event) => serde_json::to_writer(&mut sink, &event)?,
        }
        writeln!(sink)?;
        sink.flush()?;
    }
    Ok(())
}

/// A thread this connection needs, or the reason the OS would not start it.
///
/// One helper for all three of `serve`'s spawns, so the seam below sits in
/// one place rather than three.
fn spawn_named<T: Send + 'static>(
    name: String,
    body: impl FnOnce() -> T + Send + 'static,
) -> io::Result<JoinHandle<T>> {
    #[cfg(test)]
    if spawn_refuses() {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "a test seam standing in for pthread_create refusing with EAGAIN",
        ));
    }
    std::thread::Builder::new().name(name).spawn(body)
}

// Make the next `spawn_named` **on this thread** refuse.
//
// Thread-local and not global: the lib tests run in parallel in one process,
// and a global switch would make every other connection in flight fail too.
// A connection's threads are all spawned from the thread that called `serve`,
// so this reaches exactly the one connection the test is driving.
#[cfg(test)]
thread_local! {
    static SPAWN_REFUSES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn spawn_refuses() -> bool {
    SPAWN_REFUSES.with(std::cell::Cell::get)
}

/// Everything a connection owes on its way out, run exactly once and on
/// **every** exit from [`serve`] — the ordinary one, an early return because a
/// thread could not be spawned, and an unwind out of the dispatcher.
///
/// A straight-line call cannot promise that. `serve` returns early through `?`
/// three times before the dispatcher is even reached, and a panic inside
/// `dispatch` leaves the same two debts unpaid: the connection's snapshot
/// sessions, whose WAL frames nobody else can release, and its broadcaster
/// inbox, which the fan-out deliberately will not remove for it (removal
/// belongs to the connection, or it would race one). Both are then held until
/// the process ends.
///
/// The ordinary path calls [`Teardown::run`] explicitly, because the order
/// matters there — the unregister has to happen before the forwarder is
/// joined, not at the end of the function — and `run` leaves nothing for
/// `Drop` to do.
struct Teardown<'a, F: FnOnce()> {
    server: &'a Server,
    connection: ConnectionId,
    after_dispatch: Option<F>,
}

impl<'a, F: FnOnce()> Teardown<'a, F> {
    fn new(server: &'a Server, connection: ConnectionId, after_dispatch: F) -> Self {
        Self {
            server,
            connection,
            after_dispatch: Some(after_dispatch),
        }
    }

    /// Pay both debts, in order, once. A second call does nothing.
    fn run(&mut self) {
        let Some(after_dispatch) = self.after_dispatch.take() else {
            return;
        };
        // **Before `after_dispatch`, which unregisters this connection's
        // notice inbox.** The sessions are this connection's and nobody
        // else's, and the WAL frames they pin are held until they are
        // closed — the idle sweep cannot reach them, because it only runs on
        // some *other* connection's input. So the connection that opened them
        // closes them on its way out.
        self.server.close_sessions_of(self.connection);
        after_dispatch();
    }
}

impl<F: FnOnce()> Drop for Teardown<'_, F> {
    fn drop(&mut self) {
        self.run();
    }
}

/// Serve one connection until its input ends, its input becomes unparseable,
/// or its writer fails. Always joins every thread it started before returning.
///
/// `after_dispatch` runs once, between dropping the output sender and joining
/// the threads. It is the seam where a caller makes this connection's
/// producers finish: stdio stops the runtime (which drops the coordinator's
/// notice sender), and a socket connection unregisters its broadcaster inbox.
/// Without it this function would have to know which of the two it is serving.
/// It is held in a [`Teardown`], so an early return or an unwind runs it too.
pub(crate) fn serve(
    server: &Server,
    connection: ConnectionId,
    reader: impl BufRead + Send + 'static,
    writer: impl Write + Send + 'static,
    notices: Option<Receiver<RuntimeNotice>>,
    labels: ThreadLabels,
    after_dispatch: impl FnOnce(),
) -> Result<(), String> {
    let (inputs, mailbox) = sync_channel(INPUT_CAPACITY);
    let (outputs, pending) = sync_channel(OUTPUT_CAPACITY);
    // Armed before the first fallible step, so the three `?`s below cannot
    // leave this connection's inbox registered or its sessions open.
    let mut teardown = Teardown::new(server, connection, after_dispatch);

    let reader = spawn_named(labels.reader, {
        let inputs = inputs.clone();
        move || read_input(reader, inputs)
    })
    .map_err(|error| format!("failed to start the input thread: {error}"))?;
    let writer = spawn_named(labels.writer, move || write_output(writer, pending))
        .map_err(|error| format!("failed to start the output thread: {error}"))?;
    let forwarder = notices
        .map(|notices| {
            spawn_named(labels.notices, {
                let inputs = inputs.clone();
                move || forward_notices(notices, inputs)
            })
            .map_err(|error| format!("failed to start the notice thread: {error}"))
        })
        .transpose()?;
    // The dispatcher's own copy is the last one that must go, or the reader
    // and forwarder could not be joined after the loop ends.
    drop(inputs);

    let outcome = dispatch(server, connection, mailbox, &outputs);

    // Order matters. Dropping the output sender is what lets the writer
    // finish; `after_dispatch` is what lets the forwarder finish; and this
    // connection's input having ended is what lets the reader finish.
    drop(outputs);
    // Here rather than at the end of the function: the unregister inside it
    // is what lets the forwarder's `recv` return, so it has to happen before
    // the join below and not when the guard falls out of scope.
    teardown.run();
    let writer = join(writer, "output");
    if let Some(forwarder) = forwarder {
        let _ = forwarder.join();
    }
    let _ = reader.join();

    // A write failure outranks a clean end of input: the client never received
    // what it was owed.
    match (outcome, writer) {
        (_, Err(error)) => Err(error),
        (outcome, Ok(())) => outcome,
    }
}

fn join(handle: JoinHandle<io::Result<()>>, label: &str) -> Result<(), String> {
    match handle.join() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("{label} failed: {error}")),
        Err(_) => Err(format!("the {label} thread panicked")),
    }
}

/// The single owner of this connection's `SubscriptionRegistry`.
///
/// One input is processed at a time, and every event queued by that input is
/// written before the next one is taken. That is the whole ordering argument:
/// requests and notices are interleaved by the channel, not by chance.
pub(crate) fn dispatch(
    server: &Server,
    connection: ConnectionId,
    mailbox: Receiver<ServerInput>,
    outputs: &SyncSender<OutputEnvelope>,
) -> Result<(), String> {
    let mut subscriptions = SubscriptionRegistry::new();
    while let Ok(input) = mailbox.recv() {
        // Idle snapshot sessions are reclaimed here rather than by a timer,
        // and on **every** input rather than only on requests: a client that
        // opens a session and then stops asking is still alive on the notice
        // path, and its session would otherwise pin WAL frames for the life of
        // the connection. This loop is the one place both arms meet.
        server.sweep_snapshots();
        match input {
            ServerInput::Request(raw) => {
                // Pre-drain, defensive. What actually fulfils "already-queued
                // events reach the client before the response that ends the
                // subscription" is the Notice arm below draining to
                // completion: the only code that enqueues an event is reached
                // from there, so the queue is already empty every time this
                // line runs. It stays because it is cheap and it is what keeps
                // the invariant true the moment anything enqueues outside that
                // arm.
                if !drain(&mut subscriptions, outputs) {
                    return Ok(());
                }
                let response = respond(server, connection, &mut subscriptions, *raw);
                if outputs
                    .send(OutputEnvelope::Response(Box::new(response)))
                    .is_err()
                {
                    return Ok(());
                }
                // The response has been handed to the single writer, so a
                // subscription created by it can now receive events without
                // any chance of preceding its own response.
                subscriptions.activate_new();
            }
            ServerInput::Notice(notice) => {
                subscriptions.enqueue_notice(*notice);
                if !drain(&mut subscriptions, outputs) {
                    return Ok(());
                }
            }
            ServerInput::InputClosed => return Ok(()),
            ServerInput::FatalInput(message) => return Err(message),
        }
    }
    Ok(())
}

/// Hand every queued event to the writer. `false` means the writer is gone,
/// which is a clean stop rather than an error here — the writer thread reports
/// the failure itself.
fn drain(subscriptions: &mut SubscriptionRegistry, outputs: &SyncSender<OutputEnvelope>) -> bool {
    while let Some(event) = subscriptions.pop_event() {
        if outputs
            .send(OutputEnvelope::Event(Box::new(event)))
            .is_err()
        {
            return false;
        }
    }
    true
}

/// The dispatcher is where snapshot residency is actually bounded, and the
/// sweep has no wire-visible effect — every entry point a client can reach
/// (`open`, any page, `close`) reaps before it answers, so no response can
/// distinguish "swept" from "not swept". The registry's own length is
/// therefore the only honest instrument, and this loop is the only place the
/// two arms can be told apart.
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use vault_index::{IndexConfig, LiveState};
    use vault_protocol::{OpenSnapshotParams, RefreshIndexParams};

    use super::*;
    use crate::runtime::RuntimeOptions;

    fn envelope(id: &str, request: Request) -> RequestEnvelope {
        RequestEnvelope {
            version: 1,
            id: id.to_string(),
            request,
        }
    }

    /// A server over a one-note vault whose sessions go idle in 50 ms, with
    /// the watcher and the periodic tick off so nothing but this test moves
    /// the index.
    fn server(vault: &tempfile::TempDir, index: &tempfile::TempDir) -> Server {
        server_idle_after(vault, index, Duration::from_millis(50))
    }

    /// The same server, with the idle timeout the caller needs. A test about
    /// anything **other** than the sweep must set this long enough that the
    /// sweep cannot be what closed a session — otherwise it proves nothing.
    fn server_idle_after(
        vault: &tempfile::TempDir,
        index: &tempfile::TempDir,
        idle: Duration,
    ) -> Server {
        std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
        let mut config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
            .expect("sweep config");
        config.snapshot_idle_timeout = idle;
        let (server, notices) = Server::start(
            config,
            RuntimeOptions {
                watch: false,
                reconcile_interval: None,
                ..RuntimeOptions::default()
            },
        )
        .expect("start a runtime");
        // The coordinator only ever `try_send`s notices, so a dropped
        // receiver costs a dropped notice and never blocks it.
        drop(notices);
        server
    }

    /// A client that opens a session and then stops sending requests is not a
    /// client that opened no sessions: opening **was** its last request, and
    /// it can stay alive on the notice path indefinitely — subscribed, or
    /// simply holding the pipe open while the watcher keeps committing. If
    /// only the request arm swept, that session would pin WAL frames for the
    /// life of the connection.
    #[test]
    fn a_runtime_notice_reaps_an_idle_session_from_a_client_that_stopped_asking() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server(&vault, &index);
        let mut subscriptions = SubscriptionRegistry::new();

        server.handle(
            ConnectionId::STANDALONE,
            envelope("r", Request::RefreshIndex(RefreshIndexParams::default())),
            &mut subscriptions,
        );
        server.handle(
            ConnectionId::STANDALONE,
            envelope("o", Request::OpenSnapshot(OpenSnapshotParams::default())),
            &mut subscriptions,
        );
        assert_eq!(server.snapshot_session_count(), 1, "the session opened");

        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(
            server.snapshot_session_count(),
            1,
            "the registry has not been touched, so nothing has reaped yet"
        );

        // One notice and nothing else — the arm a quiet client is alive on.
        let (inputs, mailbox) = sync_channel(4);
        let (outputs, _pending) = sync_channel(4);
        inputs
            .send(ServerInput::Notice(Box::new(RuntimeNotice::State {
                generation: None,
                state: LiveState::Watching,
                error: None,
            })))
            .expect("queue one notice");
        drop(inputs);
        dispatch(&server, ConnectionId::STANDALONE, mailbox, &outputs)
            .expect("the loop ends when its mailbox closes");

        assert_eq!(
            server.snapshot_session_count(),
            0,
            "an idle session must be reclaimed on the notice path too, not only on requests"
        );
        server.shutdown();
    }

    /// A sink the test still holds after `serve` has moved a writer into its
    /// output thread, so the test can read what the connection actually
    /// answered. Without it this test could pass on a session that never
    /// opened, which would prove nothing about closing one.
    #[derive(Clone)]
    struct SharedSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl Write for SharedSink {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Ending a connection closes the snapshot sessions it opened, releasing
    /// the WAL frames they pinned — and it is **`serve`** that does it, not
    /// some later caller. The two `session_ownership` tests drive
    /// `Server::close_sessions_of` directly, so they pin the method and not
    /// the call; delete the call from `serve`'s teardown and they stay green.
    ///
    /// The idle timeout is ten minutes here on purpose: with the sweep's own
    /// 50 ms it would close the session anyway and this test would pass with
    /// the teardown gone.
    #[test]
    fn serve_closes_the_sessions_its_own_connection_opened() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server_idle_after(&vault, &index, Duration::from_secs(600));
        let connection = ConnectionId::for_test(1);

        let requests = concat!(
            r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#,
            "\n",
            r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#,
            "\n",
        );
        let answered = SharedSink(std::sync::Arc::new(std::sync::Mutex::new(Vec::new())));
        // End of the cursor is end of input, so `serve` runs its whole
        // teardown and returns — no socket and no second thread needed.
        serve(
            &server,
            connection,
            io::BufReader::new(io::Cursor::new(requests.as_bytes().to_vec())),
            answered.clone(),
            None,
            ThreadLabels::for_connection("test"),
            || {},
        )
        .expect("the connection ends cleanly at end of input");

        let written = answered.0.lock().unwrap_or_else(|error| error.into_inner());
        let written = String::from_utf8(written.clone()).expect("utf-8 answers");
        assert!(
            written.contains("\"snapshot_id\""),
            "the session must really have opened, or this test proves nothing: {written}"
        );
        assert_eq!(
            server.snapshot_session_count(),
            0,
            "the connection that opened the session is gone, so the session \
             and the WAL frames it pinned must be gone with it"
        );
        assert_eq!(
            server.sessions_owned_by(connection),
            0,
            "and nothing is left claiming an owner that no longer exists"
        );
        server.shutdown();
    }

    /// `serve` returns early, through `?`, if the OS will not start one of
    /// its three threads — before the dispatcher, and so before the line that
    /// used to pay this connection's debts. Both must still be paid: the
    /// sessions it opened (nobody else can release their WAL frames) and its
    /// broadcaster inbox (the fan-out deliberately will not remove it, since
    /// doing so would race the connection's own removal). That is what the
    /// `Teardown` guard is for, and this is the path that proves it.
    #[test]
    fn a_connection_whose_threads_cannot_start_still_pays_its_debts() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server_idle_after(&vault, &index, Duration::from_secs(600));
        let broadcaster = crate::broadcast::Broadcaster::new();
        let (connection, inbox) = broadcaster.register();

        // A session this connection owns, opened before it ever serves.
        let mut subscriptions = SubscriptionRegistry::new();
        server.handle(
            connection,
            envelope("r", Request::RefreshIndex(RefreshIndexParams::default())),
            &mut subscriptions,
        );
        server.handle(
            connection,
            envelope("o", Request::OpenSnapshot(OpenSnapshotParams::default())),
            &mut subscriptions,
        );
        assert_eq!(server.snapshot_session_count(), 1, "the session opened");
        assert_eq!(broadcaster.connection_count(), 1, "and the inbox is live");

        SPAWN_REFUSES.with(|refuses| refuses.set(true));
        let outcome = serve(
            &server,
            connection,
            io::BufReader::new(io::Cursor::new(Vec::new())),
            Vec::new(),
            Some(inbox),
            ThreadLabels::for_connection("unstartable"),
            || broadcaster.unregister(connection),
        );
        SPAWN_REFUSES.with(|refuses| refuses.set(false));

        assert!(
            outcome.is_err(),
            "a connection that cannot start its threads is not a served one: {outcome:?}"
        );
        assert_eq!(
            broadcaster.connection_count(),
            0,
            "the inbox must be unregistered on this exit too, or the fan-out \
             offers forever to a connection that never existed"
        );
        assert_eq!(
            server.snapshot_session_count(),
            0,
            "and the sessions it owned must be closed, or their WAL frames \
             are pinned for the life of the process"
        );
        server.shutdown();
    }
}
