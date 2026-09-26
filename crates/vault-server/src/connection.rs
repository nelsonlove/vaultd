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
//! `Server` that any dispatcher's sweep reaches. Scoping those sessions to the
//! connection that opened them is the socket transport's business, not this
//! module's.
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
    // Unused until the socket transport's accept loop calls it; kept here because
    // the label shape is this module's to own, not the listener's.
    #[allow(
        dead_code,
        reason = "the socket transport's accept loop is its first caller"
    )]
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
    subscriptions: &mut SubscriptionRegistry,
    raw: RawRequestEnvelope,
) -> ResponseEnvelope {
    if let Err(error) = validate_version(raw.version) {
        return ResponseEnvelope::error(raw.id, error);
    }
    match serde_json::from_str::<Request>(raw.request.get()) {
        Ok(request) => server.handle(
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

/// Serve one connection until its input ends, its input becomes unparseable,
/// or its writer fails. Always joins every thread it started before returning.
///
/// `after_dispatch` runs once, between dropping the output sender and joining
/// the threads. It is the seam where a caller makes this connection's
/// producers finish: stdio stops the runtime (which drops the coordinator's
/// notice sender), and a socket connection unregisters its broadcaster inbox.
/// Without it this function would have to know which of the two it is serving.
pub(crate) fn serve(
    server: &Server,
    reader: impl BufRead + Send + 'static,
    writer: impl Write + Send + 'static,
    notices: Option<Receiver<RuntimeNotice>>,
    labels: ThreadLabels,
    after_dispatch: impl FnOnce(),
) -> Result<(), String> {
    let (inputs, mailbox) = sync_channel(INPUT_CAPACITY);
    let (outputs, pending) = sync_channel(OUTPUT_CAPACITY);

    let reader = std::thread::Builder::new()
        .name(labels.reader)
        .spawn({
            let inputs = inputs.clone();
            move || read_input(reader, inputs)
        })
        .map_err(|error| format!("failed to start the input thread: {error}"))?;
    let writer = std::thread::Builder::new()
        .name(labels.writer)
        .spawn(move || write_output(writer, pending))
        .map_err(|error| format!("failed to start the output thread: {error}"))?;
    let forwarder = notices
        .map(|notices| {
            std::thread::Builder::new()
                .name(labels.notices)
                .spawn({
                    let inputs = inputs.clone();
                    move || forward_notices(notices, inputs)
                })
                .map_err(|error| format!("failed to start the notice thread: {error}"))
        })
        .transpose()?;
    // The dispatcher's own copy is the last one that must go, or the reader
    // and forwarder could not be joined after the loop ends.
    drop(inputs);

    let outcome = dispatch(server, mailbox, &outputs);

    // Order matters. Dropping the output sender is what lets the writer
    // finish; `after_dispatch` is what lets the forwarder finish; and this
    // connection's input having ended is what lets the reader finish.
    drop(outputs);
    after_dispatch();
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
                let response = respond(server, &mut subscriptions, *raw);
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
        std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
        let mut config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
            .expect("sweep config");
        config.snapshot_idle_timeout = Duration::from_millis(50);
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
            envelope("r", Request::RefreshIndex(RefreshIndexParams::default())),
            &mut subscriptions,
        );
        server.handle(
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
        dispatch(&server, mailbox, &outputs).expect("the loop ends when its mailbox closes");

        assert_eq!(
            server.snapshot_session_count(),
            0,
            "an idle session must be reclaimed on the notice path too, not only on requests"
        );
        server.shutdown();
    }
}
