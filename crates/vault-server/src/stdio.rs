//! The stdio transport: one dispatcher, one output owner.
//!
//! Two things want to write to stdout — answers to requests, and unsolicited
//! events — and they arrive from different threads. Rather than lock stdout
//! and hope, everything funnels through one bounded channel into one
//! dispatcher thread, and the dispatcher hands finished envelopes to one
//! writer thread. So:
//!
//! * **Nothing tears.** Exactly one thread ever serializes an envelope or
//!   writes a byte to stdout, so a response line can never be split by an
//!   event line.
//! * **Registration is unambiguous.** Requests and runtime notices share the
//!   dispatcher's single input queue, so a subscription is definitively
//!   registered before or after each commit notice — there is no window in
//!   which it is half-registered.
//! * **Ordering is structural.** A `subscribe_events` response is written
//!   before its subscription is activated, so no event for it can precede
//!   it. An `unsubscribe` response is written after that subscription's
//!   queue is drained, so no event for it can follow it.
//!
//! Four threads, all joined before `run` returns: the stdin reader, the
//! notice forwarder, the stdout writer, and the dispatcher (the calling
//! thread). The runtime's own three sit behind [`Server`].
//!
//! Backpressure never reaches the runtime. The coordinator only ever
//! `try_send`s into the notice sink, so a dispatcher busy inside
//! `refresh_index` — which blocks on that same coordinator — cannot deadlock
//! it: the coordinator drops the notice, latches the gap, and announces it
//! later as a resync. The forwarder may block feeding the dispatcher, and
//! the dispatcher may block feeding the writer if a client has stopped
//! reading its own stdout; neither can stall indexing.

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

/// How many inputs may wait for the dispatcher. Deep enough that an ordinary
/// request burst never blocks a producer, shallow enough that a wedged
/// dispatcher is felt rather than buffered indefinitely.
const INPUT_CAPACITY: usize = 256;

/// How many finished envelopes may wait for the writer.
const OUTPUT_CAPACITY: usize = 256;

/// First parse stage: the envelope with the request left undecoded, so the
/// version can be validated before the version-specific method enum is
/// applied.
///
/// `request` is the raw, unparsed JSON text for the `request` field rather
/// than a `serde_json::Value`: `serde_json::Map` is a `BTreeMap` in this
/// build, so routing through `Value` would alphabetize every nested JSON
/// object before the method-specific params ever see it — silently
/// reordering, for example, a frontmatter patch's `Mapping` keys. Decoding
/// straight from `request.get()`'s bytes (see [`respond`]) preserves
/// document order end to end.
#[derive(Debug, Deserialize)]
pub struct RawRequestEnvelope {
    pub version: u16,
    pub id: String,
    pub request: Box<serde_json::value::RawValue>,
}

/// Everything the dispatcher can be handed, from either producer.
#[derive(Debug)]
pub enum ServerInput {
    Request(Box<RawRequestEnvelope>),
    Notice(Box<RuntimeNotice>),
    /// Stdin reached end of file. Normal shutdown.
    InputClosed,
    /// Input arrived that has no usable envelope at all. Fatal: the daemon
    /// cannot answer it, and cannot know what it was.
    FatalInput(String),
}

/// One finished line, ready for the single writer.
#[derive(Debug)]
pub enum OutputEnvelope {
    Response(Box<ResponseEnvelope>),
    Event(Box<EventEnvelope>),
}

/// Two-stage validation, retained exactly: the version is checked against
/// the undecoded envelope, so an unsupported version is refused even when it
/// names a method this server has never heard of.
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

/// Move runtime notices onto the dispatcher's single input queue. Blocking
/// here is safe and deliberate: the coordinator never blocks feeding this
/// thread, so a slow dispatcher costs dropped notices (announced later as a
/// resync) rather than a stalled writer.
fn forward_notices(notices: Receiver<RuntimeNotice>, inputs: SyncSender<ServerInput>) {
    while let Ok(notice) = notices.recv() {
        if inputs.send(ServerInput::Notice(Box::new(notice))).is_err() {
            return;
        }
    }
}

/// The only code in the process that serializes an envelope or writes to
/// stdout. Stops at the first write failure and reports it.
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

/// Serve the stdio loop until stdin closes, input becomes unparseable, or
/// the writer fails. Always shuts the runtime down and joins every thread
/// before returning.
pub fn run(server: Server, notices: Option<Receiver<RuntimeNotice>>) -> Result<(), String> {
    let (inputs, mailbox) = sync_channel(INPUT_CAPACITY);
    let (outputs, pending) = sync_channel(OUTPUT_CAPACITY);

    let reader = std::thread::Builder::new()
        .name("vaultd-stdin".into())
        .spawn({
            let inputs = inputs.clone();
            move || read_input(io::stdin().lock(), inputs)
        })
        .map_err(|error| format!("failed to start the input thread: {error}"))?;
    let writer = std::thread::Builder::new()
        .name("vaultd-stdout".into())
        .spawn(move || write_output(io::stdout().lock(), pending))
        .map_err(|error| format!("failed to start the output thread: {error}"))?;
    let forwarder = notices
        .map(|notices| {
            std::thread::Builder::new()
                .name("vaultd-notices".into())
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

    let outcome = dispatch(&server, mailbox, &outputs);

    // Order matters. Dropping the output sender is what lets the writer
    // finish; stopping the runtime is what lets the forwarder finish; and
    // closing stdin is what lets the reader finish.
    drop(outputs);
    server.shutdown();
    let writer = join(writer, "output");
    if let Some(forwarder) = forwarder {
        let _ = forwarder.join();
    }
    let _ = reader.join();

    // A write failure outranks a clean end of input: the client never
    // received what it was owed.
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

/// The single owner of `Server` and `SubscriptionRegistry`.
///
/// One input is processed at a time, and every event queued by that input is
/// written before the next one is taken. That is the whole ordering
/// argument: requests and notices are interleaved by the channel, not by
/// chance.
fn dispatch(
    server: &Server,
    mailbox: Receiver<ServerInput>,
    outputs: &SyncSender<OutputEnvelope>,
) -> Result<(), String> {
    let mut subscriptions = SubscriptionRegistry::new();
    while let Ok(input) = mailbox.recv() {
        match input {
            ServerInput::Request(raw) => {
                // Pre-drain. For `unsubscribe` this is what fulfils
                // "already-queued events reach the client before the
                // response that ends the subscription"; for every other
                // request it simply keeps the stream current.
                if !drain(&mut subscriptions, outputs) {
                    return Ok(());
                }
                // Idle snapshot sessions are reclaimed here rather than by a
                // timer: this loop already runs on every request, and a
                // session that nobody asks about otherwise holds its WAL
                // frames for as long as the client stays connected.
                server.sweep_snapshots();
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
/// which is a clean stop rather than an error here — the writer thread
/// reports the failure itself.
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
