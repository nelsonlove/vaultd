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
///
/// `pub` because it is one of the three published depths on the road between
/// the fan-out and a client's socket — the other two being
/// [`OUTPUT_CAPACITY`] and [`crate::broadcast::CONNECTION_NOTICE_CAPACITY`] —
/// and a test that has to fill that road needs to compute its length rather
/// than guess a margin.
pub const INPUT_CAPACITY: usize = 256;

/// How many finished envelopes may wait for one writer. `pub` for the same
/// reason as [`INPUT_CAPACITY`].
pub const OUTPUT_CAPACITY: usize = 256;

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
                position: None,
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

/// One connection's notice inbox, and the flag its forwarder raises on the
/// way out.
///
/// The flag is how the shutdown orders itself. The reader and the forwarder
/// are two senders on one mailbox, and `std::sync::mpsc` has no way to order
/// across senders — so "the `stopped` notice was offered before the read half
/// was closed" does **not** put it ahead of the reader's `InputClosed`. What
/// does is this: a forwarder raises its flag only after `forward_notices` has
/// returned, and that returns only once everything the inbox held has been
/// handed to the mailbox. So a `Service::stop` that offers, closes every
/// inbox, and then waits for every flag before it closes a single read half
/// has put the notice in the queue first, with nothing timed anywhere.
pub(crate) struct Notices {
    pub inbox: Receiver<RuntimeNotice>,
    pub ended: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Notices {
    /// One inbox and a fresh flag. Whoever wants the end keeps a clone of
    /// `ended` before handing this over; whoever does not — the stdio-only
    /// daemon, and every test that drives `serve` with no service around it —
    /// simply drops it, and the flag is raised into nothing.
    pub fn new(inbox: Receiver<RuntimeNotice>) -> Self {
        Self {
            inbox,
            ended: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

/// Raises the flag whatever happens — a clean return, or an unwind out of the
/// forwarder. A shutdown waiting on a flag that a panic could withhold would
/// spend its whole bound on a connection that had already stopped forwarding.
struct MarkEnded(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for MarkEnded {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// The forwarder thread's whole body: hand every notice over, then say so.
pub(crate) fn run_forwarder(
    notices: Receiver<RuntimeNotice>,
    inputs: SyncSender<ServerInput>,
    ended: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let _mark = MarkEnded(ended);
    forward_notices(notices, inputs);
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
///
/// **The sink is buffered here, for every transport.** `serde_json::to_writer`
/// writes its output in fragments — a brace, a key, a comma — so an unbuffered
/// sink turns one response into one `write(2)` per fragment: a 902-byte
/// `get_note` answer reached a socket client in 15 chunks and cost 0.145 ms
/// more than the same answer over stdio, which was measured in
/// `docs/performance/vaultd-socket-transport-baseline.md` and is the whole of
/// that document's one missed target. Stdio never paid it because
/// `std::io::stdout()` is internally line-buffered; a socket's `UnixStream`
/// buffers nothing at all. Wrapping the sink *here* rather than at one caller
/// is what makes the two doors identical, and what makes a third door correct
/// by construction.
///
/// **The explicit flush is load-bearing and is not the buffer's own.** A
/// `BufWriter` flushes when it is full or dropped, neither of which is "when a
/// response is ready", so without the `flush()` below a client would wait on
/// bytes the daemon considers sent. The guarantee is unchanged from the
/// unbuffered version — one flush per envelope, one writer thread, so nothing
/// tears and nothing is held back — and the buffer only changes how many
/// syscalls that one flush costs. An envelope larger than the buffer still
/// leaves in more than one write, which is the buffer doing its job rather
/// than failing at it.
fn write_output(sink: impl Write, outputs: Receiver<OutputEnvelope>) -> io::Result<()> {
    let mut sink = io::BufWriter::new(sink);
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
    notices: Option<Notices>,
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
            let Notices { inbox, ended } = notices;
            let outcome = spawn_named(labels.notices, {
                let inputs = inputs.clone();
                let ended = std::sync::Arc::clone(&ended);
                move || run_forwarder(inbox, inputs, ended)
            });
            if outcome.is_err() {
                // No forwarder means no end to announce, and a shutdown
                // waiting for one would spend its bound on a connection that
                // never had one.
                ended.store(true, std::sync::atomic::Ordering::Release);
            }
            outcome.map_err(|error| format!("failed to start the notice thread: {error}"))
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
                // Computed for every committed generation, whether or not this
                // connection has a subscription: the tracker must see each
                // generation to keep its base catalog current, and the answer
                // is memoized per generation, so N connections pay once. The
                // invalidations are queued right behind the generation's own
                // event; a resync carries none (its client re-reads views
                // with everything else). A change to the declared property
                // types is no generation but retypes every view, so every
                // known view is named behind its `config_changed`.
                let stale = match notice.as_ref() {
                    RuntimeNotice::Generation(report) => server.stale_views(report),
                    RuntimeNotice::ConfigChanged { path } => server.config_invalidated_views(path),
                    _ => Vec::new(),
                };
                subscriptions.enqueue_notice(*notice);
                // One generation can stale more views than a subscriber queue
                // holds, so they are queued a half-queue at a time and drained
                // in between: the bound is still the number of (base, view)
                // pairs, delivered with the output channel's backpressure,
                // rather than collapsing every such generation onto a lag
                // marker.
                for chunk in stale.chunks(crate::subscriptions::SUBSCRIBER_CAPACITY / 2) {
                    if !drain(&mut subscriptions, outputs) {
                        return Ok(());
                    }
                    subscriptions.enqueue_views_invalidated(chunk);
                }
                if !drain(&mut subscriptions, outputs) {
                    return Ok(());
                }
            }
            // End of input is the end of the connection, with no grace
            // period. Nothing can still be owed to this client: the shutdown
            // is what puts a notice in flight at this moment, and it waits
            // for every forwarder to have handed its inbox over **before** it
            // closes a single read half — so a `stopped` notice is already
            // ahead of this `InputClosed` in the queue, and has already been
            // written. See [`Notices`].
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
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use vault_index::{IndexConfig, LiveState};
    use vault_protocol::{OpenSnapshotParams, RefreshIndexParams, Response};

    use super::*;
    use crate::runtime::RuntimeOptions;

    /// A sink that counts what reaches the operating system.
    ///
    /// `write` is one syscall's worth and `flush` is one boundary, so the two
    /// tallies are exactly the thing
    /// `docs/performance/vaultd-socket-transport-baseline.md` measured from
    /// the client's side as chunks per response.
    #[derive(Clone, Default)]
    struct Counting(Arc<Mutex<Tally>>);

    #[derive(Default)]
    struct Tally {
        writes: usize,
        flushes: usize,
        bytes: Vec<u8>,
    }

    impl Counting {
        fn tally(&self) -> std::sync::MutexGuard<'_, Tally> {
            self.0.lock().expect("the tally is never poisoned")
        }
    }

    impl Write for Counting {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut tally = self.tally();
            tally.writes += 1;
            tally.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.tally().flushes += 1;
            Ok(())
        }
    }

    /// One envelope leaves as **one** write and one flush, however many
    /// fragments `serde_json` serialized it in.
    ///
    /// This is the pin for the write buffer in [`write_output`]. A health
    /// envelope is a dozen or so serde fragments, and without the buffer each
    /// of them is its own `write` — which is what a socket client measured as
    /// 15 chunks for one `get_note` answer and 0.145 ms of avoidable latency.
    /// Remove the `BufWriter` and `writes` goes to the fragment count while
    /// `bytes` stays identical: the bug was never about the bytes.
    ///
    /// The second envelope is here so that "one flush per envelope" cannot be
    /// satisfied by a writer that batches both lines into one flush at the
    /// end — a client waiting on the first answer must not wait for the
    /// second request to produce one.
    #[test]
    fn one_envelope_leaves_the_daemon_as_one_write_and_one_flush() {
        let sink = Counting::default();
        let (outputs, pending) = sync_channel(4);
        let first = ResponseEnvelope::success("h-1", Response::health("vaultd"));
        let second = ResponseEnvelope::success("h-2", Response::health("vaultd"));
        outputs
            .send(OutputEnvelope::Response(Box::new(first.clone())))
            .expect("queue the first envelope");
        outputs
            .send(OutputEnvelope::Response(Box::new(second.clone())))
            .expect("queue the second envelope");
        drop(outputs);

        write_output(sink.clone(), pending).expect("write both envelopes");

        let tally = sink.tally();
        assert_eq!(
            tally.writes, 2,
            "one write per envelope, not one per fragment"
        );
        assert_eq!(
            tally.flushes, 2,
            "one flush per envelope, not one at the end"
        );
        let expected = format!(
            "{}\n{}\n",
            serde_json::to_string(&first).expect("serialize the first"),
            serde_json::to_string(&second).expect("serialize the second"),
        );
        assert_eq!(
            String::from_utf8(tally.bytes.clone()).expect("the output is UTF-8"),
            expected,
            "the bytes on the wire are unchanged by the buffer",
        );
    }

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
    /// some later caller. The two `session_ownership` tests in `lib.rs` drive
    /// `Server::close_sessions_of` directly, so they pin the method and not
    /// the call. **This** test is the pin on the call: delete it from
    /// `serve`'s teardown and this test goes red (as does
    /// `a_connection_whose_threads_cannot_start_still_pays_its_debts`, which
    /// runs through the same guard, and
    /// `socket_clients::a_snapshot_session_belongs_to_the_connection_that_opened_it`,
    /// which is the pin over a real socket).
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
            Some(Notices::new(inbox)),
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

    /// A forwarder raises its flag only after it has handed **everything**
    /// over.
    ///
    /// This is the whole of the shutdown's ordering, in one property. The
    /// reader and the forwarder are two senders on one mailbox and
    /// `std::sync::mpsc` cannot order across senders, so `Service::stop`
    /// cannot put the `stopped` notice ahead of the reader's `InputClosed` by
    /// offering it first — it has to *know* the notice is already in the
    /// queue before it lets the reader send anything. The flag is that
    /// knowledge, and it is worth only as much as this test: when it is up,
    /// every notice the inbox held is in the mailbox.
    ///
    /// Nothing here is timed. The flag is observed first and the mailbox is
    /// read afterwards, so a `try_recv` that came back empty would be a real
    /// failure and not a slow machine.
    #[test]
    fn a_forwarder_marks_its_end_only_after_handing_over_everything_it_held() {
        let (notices, inbox) = std::sync::mpsc::channel();
        for _ in 0..3 {
            notices
                .send(RuntimeNotice::State {
                    generation: None,
                    state: LiveState::Stopped,
                    error: None,
                })
                .expect("queue a notice");
        }
        // End of notices, which is what `Broadcaster::close` does at a stop.
        drop(notices);

        // A mailbox one deep, which is a dispatcher that is slow to consume:
        // the forwarder gets one notice in and then **blocks**, holding the
        // other two. Nothing about the timing is guessed — while this test
        // reads nothing, the forwarder cannot make progress, so a flag that
        // is up in that state is up too early by construction.
        let (inputs, mailbox) = sync_channel(1);
        let ended = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::Builder::new()
            .name("forwarder-under-test".into())
            .spawn({
                let ended = std::sync::Arc::clone(&ended);
                move || run_forwarder(inbox, inputs, ended)
            })
            .expect("start the forwarder");

        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !ended.load(std::sync::atomic::Ordering::Acquire),
            "the forwarder said it had finished while it was still blocked \
             holding two notices: `Service::stop` reads that flag as \
             permission to close the read half, so `stopped` would go back to \
             racing end of input"
        );

        // The client catching up. Every notice must be here, and the flag
        // must come after the last of them.
        for nth in 0..3 {
            assert!(
                matches!(
                    mailbox.recv_timeout(Duration::from_secs(20)),
                    Ok(ServerInput::Notice(_))
                ),
                "notice {nth} never reached the mailbox"
            );
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !ended.load(std::sync::atomic::Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "the forwarder never marked its end, so a shutdown would wait \
                 out its whole bound on this connection"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            mailbox.try_recv().is_err(),
            "and it had nothing left in hand when it said so"
        );
    }

    /// `drop(outputs)` must precede `after_dispatch()`.
    ///
    /// Dropping the sender is what ends the writer's `for envelope in outputs`
    /// loop, which is what lets `write_output` return, which is what drops the
    /// sink. So a sink whose `Drop` signals, plus an `after_dispatch` that
    /// waits for that signal, is exactly the shape that distinguishes the two
    /// orders: in the right one the signal has already arrived, and in the
    /// wrong one it can never arrive, because the drop is queued behind the
    /// closure that is waiting for it.
    ///
    /// This became load-bearing with the bounded shutdown drain: an
    /// `after_dispatch` that waits on anything the writer must finish first is
    /// a deadlock, and the five-second budget would report it as a slow client.
    #[test]
    fn the_output_sender_is_dropped_before_after_dispatch_runs() {
        use std::sync::{Arc, Condvar, Mutex};

        /// A sink that says when it is dropped — which is when `write_output`
        /// returned, which is when the output channel closed.
        struct SignallingSink(Arc<(Mutex<bool>, Condvar)>);
        impl Write for SignallingSink {
            fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
                Ok(buffer.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Drop for SignallingSink {
            fn drop(&mut self) {
                let (finished, waiters) = &*self.0;
                *finished.lock().unwrap_or_else(|error| error.into_inner()) = true;
                waiters.notify_all();
            }
        }

        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server(&vault, &index);
        let signal = Arc::new((Mutex::new(false), Condvar::new()));
        let waited = Arc::new(Mutex::new(false));

        let outcome = serve(
            &server,
            crate::broadcast::ConnectionId::STANDALONE,
            // One request line, then end of input, so the dispatcher has
            // something to hand the writer and then returns.
            io::Cursor::new(
                br#"{"version":1,"id":"h","request":{"method":"health"}}
"#
                .to_vec(),
            ),
            SignallingSink(Arc::clone(&signal)),
            None,
            ThreadLabels::for_connection("teardown-order"),
            {
                let signal = Arc::clone(&signal);
                let waited = Arc::clone(&waited);
                move || {
                    let (finished, waiters) = &*signal;
                    let mut done = finished.lock().unwrap_or_else(|error| error.into_inner());
                    let deadline = std::time::Duration::from_secs(5);
                    while !*done {
                        let (guard, timed_out) = waiters
                            .wait_timeout(done, deadline)
                            .unwrap_or_else(|error| error.into_inner());
                        done = guard;
                        assert!(
                            !timed_out.timed_out() || *done,
                            "after_dispatch ran before the output sender was dropped, so the \
                             writer can never finish: this teardown order deadlocks under the \
                             bounded shutdown drain"
                        );
                    }
                    *waited.lock().unwrap_or_else(|error| error.into_inner()) = true;
                }
            },
        );

        assert!(outcome.is_ok(), "the connection ended cleanly: {outcome:?}");
        assert!(
            *waited.lock().unwrap_or_else(|error| error.into_inner()),
            "the closure ran at all, so the assertion inside it was reached"
        );
        server.shutdown();
    }

    /// `drop(inputs)` must precede the dispatch call.
    ///
    /// The dispatcher normally exits through an explicit `return` on
    /// `InputClosed` or `FatalInput`, so its own live sender is never observed
    /// — which is why Task 1's review could remove the drop and see 173 green
    /// tests. The one shape that observes it is a reader that ends **without**
    /// announcing it: a panicking reader thread drops its sender on the unwind
    /// and sends nothing, so with no notice forwarder the dispatcher's own
    /// clone is the only sender left. Dropped, the mailbox closes and `serve`
    /// returns; kept, `mailbox.recv()` blocks for ever and the daemon hangs on
    /// a connection that is already gone.
    #[test]
    fn the_input_sender_is_dropped_so_a_reader_that_dies_silently_still_ends_the_connection() {
        /// A reader whose first `fill_buf` panics, standing in for any reader
        /// that stops without sending `InputClosed`.
        struct PanickingReader;
        impl io::Read for PanickingReader {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                panic!("this reader dies without announcing end of input");
            }
        }

        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        // Behind an `Arc` so the call can run on a thread this test does not
        // join: `serve` takes `&Server`, and `Arc<Server>` derefs to it. A
        // scoped thread would not do — its scope's exit is itself a join, and
        // joining is the thing that hangs when the drop is missing.
        let server = std::sync::Arc::new(server(&vault, &index));

        let (done, finished) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("teardown-input-drop".into())
            .spawn({
                let server = std::sync::Arc::clone(&server);
                move || {
                    let outcome = serve(
                        &server,
                        crate::broadcast::ConnectionId::STANDALONE,
                        io::BufReader::new(PanickingReader),
                        io::sink(),
                        None,
                        ThreadLabels::for_connection("silent-reader"),
                        || {},
                    );
                    let _ = done.send(outcome.is_ok());
                }
            })
            .expect("start the worker thread");

        assert!(
            finished
                .recv_timeout(std::time::Duration::from_secs(10))
                .is_ok(),
            "serve never returned after its reader died silently: the dispatcher's own input \
             sender was not dropped, so its mailbox can never close"
        );
        server.shutdown();
    }
}
