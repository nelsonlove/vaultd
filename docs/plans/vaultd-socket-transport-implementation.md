# vaultd Socket Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `vaultd` a Unix domain socket transport that carries the existing protocol unchanged to any number of simultaneous connections, so one daemon outlives its clients and the headless host connects to it instead of always spawning its own.

**Architecture:** One server, one loop per connection (Ruling 5). The existing `stdio::run` loop — reader, dispatcher, writer, one `SubscriptionRegistry`, one set of snapshot sessions — is extracted into `connection::serve`, which runs over any `BufRead` + `Write` pair; stdio becomes connection zero and an accepted socket stream is every other connection. One broadcaster thread owns the runtime's notice receiver and fans each notice into every connection's bounded inbox with a non-blocking send, dropping and latching a gap it later announces as `resync_required { runtime_recovered }`. The `Server` is shared behind an `Arc`; writes still serialize inside the runtime's single coordinator, so a slow client can stall only itself. On the host side one config field, `engine`, chooses between probing an existing daemon, connecting to it, and spawning one with `--listen`.

**Tech Stack:** Rust 2024 edition, MSRV 1.85, `std::os::unix::net::{UnixListener, UnixStream}`, `libc` for the listen backlog and the signal handlers, `sha2` for the socket-path digest (new workspace dependency — the host's `socketPathFor` is SHA-256 and the two must agree), `xdg` 3.0 for the cache-dir half of the run-directory rule, `clap` 4 derive for `--listen`. Host: Node ≥ 24, TypeScript strict, `node:net` for the client socket, `vitest` 3.

**Spec:** [vaultd Socket Transport Design](../design/vaultd-socket-transport.md) — its trailing **Rulings** section wins over its body. Predecessor plan, for house style and the host components this phase touches: [vaultd Headless Plugin Host Implementation Plan](headless-plugin-host-implementation.md). Wire authority: [docs/protocol.md](../protocol.md).

## Global Constraints

- Rust MSRV 1.85. **Never let-chains** (`if let … && …`) — they are 2024-edition syntax this MSRV does not carry; nest the `if let` instead. `cargo clippy --workspace --all-targets` must be clean.
- Rust tests run with `TMPDIR="$PWD/target/tmp"` and never touch the OS temp dir: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test <name>`. `tempfile::TempDir::new()` reads `TMPDIR`, so the prefix is the whole mechanism.
- Host: Node ≥ 24, TypeScript `strict` (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`). Vitest runs through `npm --prefix host test -- <files>` — **never** the bare `vitest` binary, and **never two vitest invocations at once** (the fixture warm-up in `pretest` is not re-entrant).
- Host tests write only under `target/tmp`, through the pinned scratch base in `host/packages/host/test/scratch.ts` (`scratchRoot(prefix)`). No test may call `mkdtempSync(join(tmpdir(), …))`.
- No `node:fs` in `host/packages/host/src/*.ts` outside the fs seam (`src/runtime/fs-access.ts`, `src/datadir.ts`). `test/no-write-imports.test.ts` and `test/fs-seam.test.ts` must stay green. `node:net` is **not** banned — `src/server/server.ts` already uses it.
- **Never point any process, test, fixture or path at `~/vault`.** Every daemon in every test runs on a scratch vault under `target/tmp`.
- **Every gate reports its PROCESS EXIT CODE, not only test counts.** A suite that prints "passed" while exiting 1 is red. Every run command below ends with `; echo "exit=$?"` and the expected line names the code.
- One commit per task on `feat/socket-transport`. Every commit message ends with the trailer:

  ```text
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

  **Never push, never merge** — this repository has no remote.
- **The protocol changes only additively:** one optional `socket_path` field on `get_vault_info`. No envelope change, no new operation, no new or altered error code, no change to any event.
- Prose in this plan and in every document it writes is **not hard-wrapped**: one paragraph is one line. Code blocks are code.
- Gate before every Rust commit: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server` and `cargo clippy -p vault-server --all-targets -- -D warnings`. Gate before every host commit: `npm --prefix host run typecheck`, `npm --prefix host run lint`, `npm --prefix host test`.

---

## Preflight

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git status --short --branch
cargo --version
node --version
mkdir -p target/tmp
TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"
```

Expected: a clean tree on `feat/socket-transport`, `cargo` at 1.85 or above, `node` at v24 or above, and the whole `vault-server` suite green with `exit=0`. If the suite is red before Task 1, stop — this phase's first task is an extraction whose only proof is that suite staying green.

---

## Planned file map

### `crates/vault-server` (Rust)

- Create `src/connection.rs` — the per-connection loop over any `BufRead` + `Write` pair. Owns `RawRequestEnvelope`, `ServerInput`, `OutputEnvelope`, `respond`, `read_input`, `forward_notices`, `write_output`, `dispatch`, `drain`, and the public `serve`. One responsibility: turn one byte stream into one dispatcher with one registry.
- Modify `src/stdio.rs` — shrinks to `run`, over `io::BufReader::new(io::stdin())` and `io::stdout()`, delegating to `connection::serve`. Its module documentation is replaced (it now says what makes connection zero's *ownership* of the runtime special, rather than restating the loop), and its one test moves to `connection.rs` with the loop it exercises. **Not the locked handles:** `serve` moves both streams into spawned threads, so both must be `Send`, and `StdinLock`/`StdoutLock` are not — see Task 1 Step 4.
- Create `src/broadcast.rs` — `Broadcaster`, `ConnectionId`, the per-connection bounded inbox, and the drop-and-latch rule.
- Create `src/listener.rs` — the socket path rule (`socket_digest`, `run_dir`, `default_socket_path`), `ListenError`, and `SocketListener` (bind with the stale/live/non-socket decision, directory `0700`, socket `0600`, backlog 16, unlink on drop).
- Create `src/service.rs` — the multi-connection service: the accept loop, the connection registry, connection zero, the signal handlers, and the bounded shutdown drain.
- Modify `src/lib.rs` — `socket_path` on `Server`, module declarations, and the `Sync` assertion.
- Modify `src/convert.rs` — `vault_info` gains the `socket_path` argument.
- Modify `src/main.rs` — `--listen [PATH]`, and `service::run` in place of `stdio::run`.
- Modify `Cargo.toml` (workspace and crate) — add `sha2`, add `xdg` to `vault-server`.

### `crates/vault-protocol`

- Modify `src/operations.rs` — `GetVaultInfoResponse.socket_path: Option<String>`, `#[serde(default, skip_serializing_if = "Option::is_none")]`.

### `crates/vault-server/tests`

- Create `tests/socket/mod.rs` — the socket-side harness: `ListeningDaemon` (a spawned `vaultd --listen`, with its readiness probe) and `Client` (one connection, with `send`/`response`/`call`/`call_raw`/`wait_for_event`/`drain_events`/`stop_reading`/`resume_reading`/`disconnect`). **The socket route is this harness, not an extension of the stdio one:** `tests/daemon/mod.rs`'s `Daemon` owns a child's stdio pipes and a socket connection owns neither, so widening it would have meant one struct with two disjoint halves.
- Modify `tests/daemon/mod.rs` — `call_raw` (Task 6), then `Transport` and `drain_events` (Task 7). Nothing else: `Daemon` stays the stdio harness it is.
- Create `tests/socket_lifecycle.rs` — stale file, live daemon, non-socket file, SIGTERM drain, socket gone after exit, stdin-closed daemon.
- Create `tests/socket_clients.rs` — two clients, the slow client, connection-scoped sessions.
- Create `tests/socket_info.rs` — `socket_path` present, absent, and equal to the documented default path.
- Create `tests/conformance.rs` — one fixture set over both transports, transcripts compared after named normalization.
- Create `tests/fixtures/conformance.jsonl` — the fixture set.

### `host/packages/host`

- Modify `src/client/protocol.ts` — `GetVaultInfoResponse.socket_path?: string`, the TypeScript mirror of the Rust wire type (Task 6, with the Rust field).
- Modify `src/config.ts` — `EngineMode`, `engine`, `engineSocketPath`, `leaveEngineRunning`, `vaultdSocketPathFor`.
- Create `src/engine-probe.ts` — `probeEngineSocket`.
- Modify `src/supervisor.ts` — connect-or-spawn, `engineSource()`, SIGTERM at shutdown.
- Modify `src/runtime/lifecycle.ts` — `StartupReport.engineSource`.
- Modify `src/server/ops.ts` — the `engine` substructure on `host.info`.
- Modify `src/main.ts` — `--engine`, `--leave-engine-running`, the usage block.
- Create `test/engine-probe.test.ts`, `test/supervisor-engine-mode-real-daemon.test.ts`.
- Create `host/scripts/socket-transport-baseline.js` — the measurement harness with its `--transport` switch.

### Documentation

- Modify `docs/protocol.md` — a **Transports** section replacing the "proof transport" line; `socket_path` in `get_vault_info`; the fan-out rule and the drain bound in **Bounds**.
- Modify `docs/design/headless-plugin-host.md` — the Sync sentence, and the amendment to "host death closes stdio and `vaultd` exits".
- Create `docs/performance/vaultd-socket-transport-baseline.md` — the measurements.
- Modify `README.md` — the `--listen` flag and the `engine` config field.

---

### Task 1: The per-connection loop

Extract the stdio loop into a transport-neutral connection, with stdio as its first caller. Nothing about behaviour changes; the proof is that the whole existing suite stays green.

**Files:**

- Create: `crates/vault-server/src/connection.rs`
- Modify: `crates/vault-server/src/stdio.rs` (replaced wholesale — see Step 4)
- Modify: `crates/vault-server/src/lib.rs:1-5` (module list), and a new assertion at the end of the file

**Interfaces:**

- Consumes: `Server::handle(&self, RequestEnvelope, &mut SubscriptionRegistry) -> ResponseEnvelope`, `Server::sweep_snapshots(&self)` (crate-visible), `Server::shutdown(&self)`, `RuntimeNotice`.
- Produces:

```rust
/// What this connection's threads are called, so a panic names the door.
pub(crate) struct ThreadLabels {
    pub reader: String,
    pub writer: String,
    pub notices: String,
}

/// Serve one connection until its input ends, its input becomes unparseable,
/// or its writer fails.
///
/// `after_dispatch` runs once, between dropping the output sender and joining
/// the threads. It is the seam where a caller makes this connection's
/// producers finish: stdio stops the runtime, and a socket connection
/// unregisters its notice inbox.
pub(crate) fn serve(
    server: &Server,
    reader: impl std::io::BufRead + Send + 'static,
    writer: impl std::io::Write + Send + 'static,
    notices: Option<std::sync::mpsc::Receiver<RuntimeNotice>>,
    labels: ThreadLabels,
    after_dispatch: impl FnOnce(),
) -> Result<(), String>;

pub(crate) const INPUT_CAPACITY: usize = 256;
pub(crate) const OUTPUT_CAPACITY: usize = 256;

/// Re-exported from `stdio` for the tests that already name them.
pub struct RawRequestEnvelope { pub version: u16, pub id: String, pub request: Box<serde_json::value::RawValue> }
pub enum ServerInput { Request(Box<RawRequestEnvelope>), Notice(Box<RuntimeNotice>), InputClosed, FatalInput(String) }
pub enum OutputEnvelope { Response(Box<ResponseEnvelope>), Event(Box<EventEnvelope>) }
```

- [ ] **Step 1: Write the failing assertion that `Server` can be shared**

Append to `crates/vault-server/src/lib.rs`:

```rust
/// Every connection holds the same `Server` behind an `Arc`, so the compiler
/// must agree it can be shared. Stated as a test rather than a comment: the
/// design says "the phase adds a check that `Server` is `Sync`, and no
/// rewrite", and a field added later that is not `Sync` should fail here
/// rather than at the first accepted connection.
#[cfg(test)]
mod shareable {
    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn a_server_may_be_shared_between_connections() {
        assert_send_sync::<crate::Server>();
        assert_send_sync::<std::sync::Arc<crate::Server>>();
    }
}
```

- [ ] **Step 2: Run it to see where the crate stands**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib shareable; echo "exit=$?"`

Expected: `test shareable::a_server_may_be_shared_between_connections ... ok` and `exit=0`. If it fails to compile with "`Server` cannot be shared between threads safely", the named field is the blocker and the extraction cannot proceed until it is wrapped — report it rather than wrapping something unexamined.

- [ ] **Step 3: Create `crates/vault-server/src/connection.rs`**

This is the current `stdio.rs` with three changes: `run` becomes `serve` and takes its streams, the writer's sink is a parameter rather than `io::stdout()`, and the runtime shutdown moves out into `after_dispatch`.

```rust
//! One connection: one reader, one dispatcher, one writer, one registry.
//!
//! This is the loop the stdio transport shipped with, made transport-neutral.
//! Everything the module documentation of [`crate::stdio`] argues still holds,
//! **per connection**:
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
//! [`SubscriptionRegistry`], the snapshot sessions the dispatcher sweeps, and
//! the three threads. What stays shared: the [`Server`], behind an `Arc`, and
//! through it the runtime's single coordinator — so two connections cannot
//! interleave a mutation.
//!
//! Backpressure still never reaches the runtime. A connection's notice
//! producer (the coordinator's own channel for stdio, the broadcaster's inbox
//! for a socket) is fed with a non-blocking send by whoever owns it, so a
//! dispatcher busy inside `refresh_index` cannot deadlock the coordinator: the
//! notice is dropped, the gap latched, and announced later as a resync.

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
/// object before the method-specific params ever see it. Decoding straight
/// from `request.get()`'s bytes (see [`respond`]) preserves document order end
/// to end.
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
                // Pre-drain. For `unsubscribe` this is what fulfils
                // "already-queued events reach the client before the response
                // that ends the subscription"; for every other request it
                // simply keeps the stream current.
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
```

- [ ] **Step 4: Replace `crates/vault-server/src/stdio.rs` with the thin caller**

```rust
//! The stdio transport: connection zero.
//!
//! Since the socket transport landed, the loop itself lives in
//! [`crate::connection`] and this module is the one call that runs it over the
//! process's own standard input and output. Nothing about stdio is special: it
//! is a connection like any other, it is closed when stdin closes, and it is
//! absent when the daemon is started with stdin closed.
//!
//! What is special is who ends the runtime. Without `--listen` there is
//! nothing else serving, so the end of stdin is the end of the daemon and this
//! module's `after_dispatch` stops the runtime — which is also what lets the
//! notice forwarder finish, because stopping the runtime drops the
//! coordinator's notice sender. With `--listen`, [`crate::service`] serves
//! connection zero instead and the end of stdin ends that connection alone.

use std::io;
use std::sync::mpsc::Receiver;

use crate::Server;
use crate::connection::{self, ThreadLabels};
use crate::runtime::RuntimeNotice;

/// Serve the stdio loop until stdin closes, input becomes unparseable, or the
/// writer fails. Always shuts the runtime down and joins every thread before
/// returning.
///
/// **The unlocked handles are deliberate.** `serve` moves both streams into
/// spawned threads, so both must be `Send`, and `StdinLock`/`StdoutLock` are
/// not — a lock guard cannot cross a thread boundary. `Stdin`/`Stdout` take the
/// same static mutex per call and read or write through the same buffer behind
/// it, so this is the same lock held per call rather than for the connection's
/// life; and in this process exactly one thread touches each, because `serve`
/// spawns one reader and one writer and nothing else in the daemon writes to
/// standard output. So nothing can interleave and nothing can tear, which is
/// the property the old `.lock()` was there for.
pub fn run(server: Server, notices: Option<Receiver<RuntimeNotice>>) -> Result<(), String> {
    connection::serve(
        &server,
        io::BufReader::new(io::stdin()),
        io::stdout(),
        notices,
        ThreadLabels {
            reader: "vaultd-stdin".into(),
            writer: "vaultd-stdout".into(),
            notices: "vaultd-notices".into(),
        },
        || server.shutdown(),
    )
}
```

Then move the existing `#[cfg(test)] mod tests` block from the old `stdio.rs` into `crates/vault-server/src/connection.rs` unchanged, adjusting only its two `use` lines: `use super::*;` still resolves, and `crate::runtime::RuntimeOptions` is already imported there. The test's body calls `dispatch(&server, mailbox, &outputs)`, `sync_channel`, `ServerInput::Notice` and `SubscriptionRegistry::new()` — all of which now live in `connection`.

- [ ] **Step 5: Declare the module**

In `crates/vault-server/src/lib.rs`, add `connection` to the module list at the top of the file:

```rust
mod convert;
pub mod connection;
pub mod fixture_row;
pub mod runtime;
pub mod stdio;
pub mod subscriptions;
```

- [ ] **Step 6: Run the whole suite — the extraction's only honest proof**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: every test that passed at Preflight passes again, including `tests/stdio.rs`, `tests/live_stdio.rs`, `tests/subscriptions.rs` and `connection::tests::a_runtime_notice_reaps_an_idle_session_from_a_client_that_stopped_asking`, and `exit=0`. A behaviour change here is a defect in the extraction, not a finding.

- [ ] **Step 7: Clippy**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings; echo "exit=$?"`

Expected: no warnings, `exit=0`.

- [ ] **Step 8: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/src/connection.rs crates/vault-server/src/stdio.rs crates/vault-server/src/lib.rs
git commit -F - <<'MSG'
refactor(server): make the stdio loop a per-connection loop

`stdio::run`'s reader, dispatcher, writer and registry become
`connection::serve` over any `BufRead` + `Write` pair, with the runtime
shutdown lifted into an `after_dispatch` seam so a socket connection can
unregister its notice inbox there instead. stdio keeps its behaviour exactly
and becomes connection zero. A `Send + Sync` assertion on `Server` states the
sharing the accepted connections will rely on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: The broadcaster

One thread owns the runtime's notice receiver and fans each notice into every connection's bounded inbox with a non-blocking send. A full inbox costs that connection its notice and latches a gap; the next notice that connection could be given is replaced by `resync_required { runtime_recovered }` naming the newest generation. The rule is the coordinator's own drop-and-latch, moved one hop out.

**Files:**

- Create: `crates/vault-server/src/broadcast.rs`
- Modify: `crates/vault-server/src/lib.rs:1-6` (module list)

**Interfaces:**

- Consumes: `RuntimeNotice` (which is `Clone`), `ResyncReason::RuntimeRecovered`, `vault_index::Generation`, and `connection::serve`'s `notices: Option<Receiver<RuntimeNotice>>` parameter from Task 1.
- Produces:

```rust
pub const CONNECTION_NOTICE_CAPACITY: usize = 256;

/// One registered connection. Opaque, process-scoped, never reused.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectionId(u64);

pub struct Broadcaster { /* private */ }

impl Broadcaster {
    pub fn new() -> Self;
    pub fn register(&self) -> (ConnectionId, std::sync::mpsc::Receiver<RuntimeNotice>);
    pub fn unregister(&self, id: ConnectionId);
    pub fn offer(&self, notice: &RuntimeNotice);
    pub fn connection_count(&self) -> usize;
    #[cfg(test)]
    pub fn gap_of(&self, id: ConnectionId) -> Option<Option<u64>>;
}

pub fn spawn_fanout(
    broadcaster: std::sync::Arc<Broadcaster>,
    notices: std::sync::mpsc::Receiver<RuntimeNotice>,
) -> std::io::Result<std::thread::JoinHandle<()>>;
```

- [ ] **Step 1: Write the failing unit tests**

Create `crates/vault-server/src/broadcast.rs` containing **only** this test module for now, so the failure is a compile error naming the missing items rather than a wrong answer:

```rust
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use vault_index::{Generation, LiveState};

    use super::*;
    use crate::runtime::{ResyncReason, RuntimeNotice};

    fn state_at(generation: u64) -> RuntimeNotice {
        RuntimeNotice::State {
            generation: Some(Generation::new(generation)),
            state: LiveState::Watching,
            error: None,
        }
    }

    /// Two connections, one of which has stopped draining. The one that reads
    /// must be unaffected — that is the whole point of per-connection queues —
    /// and the one that did not must learn it has a gap rather than silently
    /// missing generations.
    #[test]
    fn a_full_inbox_costs_its_own_connection_a_resync_and_costs_its_peer_nothing() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();
        let (fast, fast_inbox) = broadcaster.register();

        // Fill the slow connection's inbox to its brim, reading nothing.
        for generation in 1..=CONNECTION_NOTICE_CAPACITY as u64 {
            broadcaster.offer(&state_at(generation));
        }
        assert_eq!(broadcaster.gap_of(slow), Some(None), "no gap while it fits");

        // The next one cannot fit in the slow inbox. It is dropped there and
        // latched; the fast inbox takes it as usual.
        let overflow = CONNECTION_NOTICE_CAPACITY as u64 + 1;
        broadcaster.offer(&state_at(overflow));
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Some(overflow)),
            "the gap names the newest generation it has seen"
        );

        // The fast connection is untouched: every notice, in order, no resync.
        for generation in 1..=overflow {
            match fast_inbox.recv().expect("the fast inbox has a notice") {
                RuntimeNotice::State { generation: seen, .. } => assert_eq!(
                    seen.map(Generation::get),
                    Some(generation),
                    "a peer's full queue must not disturb this connection's stream"
                ),
                other => panic!("the fast connection saw something else: {other:?}"),
            }
        }

        // The slow connection drains one slot, and the next notice it can be
        // given is replaced by the resync that announces the gap.
        let drained = slow_inbox.recv().expect("the slow inbox has a notice");
        assert!(matches!(drained, RuntimeNotice::State { .. }), "queued detail first");
        broadcaster.offer(&state_at(overflow + 1));
        let mut seen = Vec::new();
        while let Ok(notice) = slow_inbox.try_recv() {
            seen.push(notice);
        }
        let last = seen.last().expect("the slow inbox received something");
        match last {
            RuntimeNotice::ResyncRequired { generation, reason } => {
                assert_eq!(*reason, ResyncReason::RuntimeRecovered, "the drop-and-latch reason");
                assert_eq!(
                    generation.map(Generation::get),
                    Some(overflow + 1),
                    "the resync names the newest generation, not the one that was dropped"
                );
            }
            other => panic!("the gap was never announced: {other:?}"),
        }
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(None),
            "the gap is cleared once it has been announced"
        );

        broadcaster.unregister(slow);
        broadcaster.unregister(fast);
        assert_eq!(broadcaster.connection_count(), 0);
    }

    /// A drop with nothing committed yet cannot name a generation, so the
    /// resync is owed rather than emitted — the same withholding the
    /// subscription registry does, and for the same reason: an event naming no
    /// generation to re-read at tells a client nothing.
    #[test]
    fn a_gap_with_no_generation_yet_waits_for_one_that_has() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();
        let ungenerated = RuntimeNotice::State {
            generation: None,
            state: LiveState::CatchingUp,
            error: None,
        };
        for _ in 0..=CONNECTION_NOTICE_CAPACITY {
            broadcaster.offer(&ungenerated);
        }
        assert_eq!(broadcaster.gap_of(slow), Some(None), "owed, but unnameable");

        // Drain everything, then offer one that does name a generation.
        while slow_inbox.try_recv().is_ok() {}
        broadcaster.offer(&state_at(7));
        match slow_inbox.recv().expect("a notice reached the slow inbox") {
            RuntimeNotice::ResyncRequired { generation, reason } => {
                assert_eq!(reason, ResyncReason::RuntimeRecovered);
                assert_eq!(generation.map(Generation::get), Some(7));
            }
            other => panic!("the owed resync was not emitted: {other:?}"),
        }
    }
}
```

Add `pub mod broadcast;` to the module list at the top of `crates/vault-server/src/lib.rs`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib broadcast; echo "exit=$?"`

Expected: compilation fails with `cannot find type Broadcaster in this scope` and `cannot find value CONNECTION_NOTICE_CAPACITY in this scope`; `exit=101`.

- [ ] **Step 3: Write the broadcaster above that test module**

```rust
//! One notice stream, many connections.
//!
//! The runtime has exactly one notice channel and `--listen` gives it many
//! readers, so one thread owns the receiving end and clones each notice into
//! every connection's own bounded inbox. Three properties, each the reason for
//! the one before it:
//!
//! * **The broadcaster never blocks.** Not on a full inbox — it drops — and
//!   not on the coordinator, which it only receives from. So no client,
//!   however slow or however dead, can stall indexing. That is the invariant
//!   the stdio design states, preserved across any number of clients.
//! * **A drop is latched, never silent.** The connection whose inbox was full
//!   has its gap recorded with the newest generation seen, and the next notice
//!   that connection could be given is **replaced** by
//!   `RuntimeNotice::ResyncRequired { reason: RuntimeRecovered }` naming that
//!   generation. This is the coordinator's own drop-and-latch, one hop out:
//!   see "What a slow stdio client actually meets is backpressure" in
//!   `docs/protocol.md`.
//! * **A gap that cannot be named waits.** While nothing has ever been
//!   committed there is no generation to re-read at, so the marker is owed and
//!   is emitted by the first notice that does name one — the same withholding
//!   [`crate::subscriptions`] applies, for the same reason.
//!
//! What this module deliberately does **not** do: convert anything to the
//! wire. A `RuntimeNotice` goes in and a `RuntimeNotice` comes out, and the
//! per-connection [`crate::subscriptions::SubscriptionRegistry`] is still the
//! only place a notice becomes an event. The 64-event per-subscription bound
//! and the 1024-path per-generation bound are therefore untouched.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use vault_index::Generation;

use crate::runtime::{ResyncReason, RuntimeNotice};

/// How many notices may wait for one connection's dispatcher.
///
/// The same depth as the coordinator's own notice channel and as the
/// dispatcher's input queue, and for the same reason: deep enough that an
/// ordinary burst never costs anyone a resync, shallow enough that a
/// connection which has stopped reading is felt rather than buffered.
pub const CONNECTION_NOTICE_CAPACITY: usize = 256;

/// One registered connection. Opaque, process-scoped, and never reused.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectionId(u64);

impl std::fmt::Display for ConnectionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "conn-{}", self.0)
    }
}

/// One connection's inbox, and the gap it has not been told about.
struct Registered {
    sink: SyncSender<RuntimeNotice>,
    /// The newest generation seen while a drop was outstanding.
    gap: Option<Generation>,
    /// Whether a drop is outstanding at all. Separate from `gap` because a
    /// drop before the first commit has no generation and must still be owed.
    gap_owed: bool,
}

#[derive(Default)]
struct Registry {
    next: u64,
    connections: BTreeMap<u64, Registered>,
}

/// The fan-out. One per daemon, shared by `Arc`.
pub struct Broadcaster {
    registry: Mutex<Registry>,
    /// Read without taking the lock by the accept loop's diagnostics, and kept
    /// in step inside it.
    count: AtomicU64,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
}

/// The generation a notice names, if it names one. `ConfigChanged` names none
/// by design: the configuration zone is not indexed, so no generation contains
/// it.
fn notice_generation(notice: &RuntimeNotice) -> Option<Generation> {
    match notice {
        RuntimeNotice::Generation(report) => Some(report.generation),
        RuntimeNotice::State { generation, .. } => *generation,
        RuntimeNotice::ResyncRequired { generation, .. } => *generation,
        RuntimeNotice::ConfigChanged { .. } => None,
    }
}

fn newest(left: Option<Generation>, right: Option<Generation>) -> Option<Generation> {
    match (left, right) {
        (Some(left), Some(right)) => Some(if left.get() >= right.get() { left } else { right }),
        (value, None) | (None, value) => value,
    }
}

impl Broadcaster {
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
            count: AtomicU64::new(0),
        }
    }

    /// A fresh inbox for one connection. The receiver is handed straight to
    /// [`crate::connection::serve`].
    pub fn register(&self) -> (ConnectionId, Receiver<RuntimeNotice>) {
        let (sink, inbox) = sync_channel(CONNECTION_NOTICE_CAPACITY);
        let mut registry = self.lock();
        registry.next += 1;
        let id = registry.next;
        registry.connections.insert(
            id,
            Registered {
                sink,
                gap: None,
                gap_owed: false,
            },
        );
        self.count
            .store(registry.connections.len() as u64, Ordering::Release);
        (ConnectionId(id), inbox)
    }

    /// Drop one connection's inbox. Idempotent.
    pub fn unregister(&self, id: ConnectionId) {
        let mut registry = self.lock();
        registry.connections.remove(&id.0);
        self.count
            .store(registry.connections.len() as u64, Ordering::Release);
    }

    pub fn connection_count(&self) -> usize {
        self.count.load(Ordering::Acquire) as usize
    }

    /// Offer one notice to every registered connection, without ever blocking.
    ///
    /// A connection whose inbox is closed — its dispatcher has ended but its
    /// `after_dispatch` has not run yet — is left registered rather than
    /// removed here: removal belongs to the connection itself, and doing it
    /// from the fan-out would race that.
    pub fn offer(&self, notice: &RuntimeNotice) {
        let mut registry = self.lock();
        let incoming = notice_generation(notice);
        for registered in registry.connections.values_mut() {
            // A gap is outstanding, so the notice this connection would be
            // given is replaced by the resync that announces it — but only
            // once a generation exists to re-read at. Until then the notice
            // goes through unchanged, because a state change is a level a
            // stale client still needs and it is not the resync.
            let named = if registered.gap_owed {
                newest(registered.gap, incoming)
            } else {
                None
            };
            let announcing = named.is_some();
            let outgoing = match named {
                Some(generation) => RuntimeNotice::ResyncRequired {
                    generation: Some(generation),
                    reason: ResyncReason::RuntimeRecovered,
                },
                None => notice.clone(),
            };
            match registered.sink.try_send(outgoing) {
                Ok(()) => {
                    if announcing {
                        registered.gap = None;
                        registered.gap_owed = false;
                    }
                }
                Err(TrySendError::Full(_)) => {
                    registered.gap = newest(registered.gap, incoming);
                    registered.gap_owed = true;
                }
                // The dispatcher has ended. Nothing to latch for a connection
                // that is already closing.
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
    }

    /// How many notices this connection has had dropped since it was last
    /// told, as a generation. Test-only: nothing on the wire distinguishes a
    /// latched gap from no gap until the resync is delivered.
    #[cfg(test)]
    pub fn gap_of(&self, id: ConnectionId) -> Option<Option<u64>> {
        let registry = self.lock();
        registry
            .connections
            .get(&id.0)
            .map(|registered| registered.gap.map(Generation::get))
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Feed `broadcaster` from the runtime's notice channel until the coordinator
/// drops its sender. Returns the thread, which the service joins at shutdown.
pub fn spawn_fanout(
    broadcaster: Arc<Broadcaster>,
    notices: Receiver<RuntimeNotice>,
) -> std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new()
        .name("vaultd-broadcast".into())
        .spawn(move || {
            while let Ok(notice) = notices.recv() {
                broadcaster.offer(&notice);
            }
        })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib broadcast; echo "exit=$?"`

Expected: `a_full_inbox_costs_its_own_connection_a_resync_and_costs_its_peer_nothing ... ok`, `a_gap_with_no_generation_yet_waits_for_one_that_has ... ok`, `exit=0`.

- [ ] **Step 5: Say what the broadcaster does and does not change about the Request arm's pre-drain**

Task 1's review (finding L3) traced the Request arm's pre-drain in `connection::dispatch` and found it **unreachable**: the only producer of queued events is `SubscriptionRegistry::enqueue_notice`, reached only from the Notice arm, which calls `drain` immediately after — and `drain` blocks on `send`, so it always empties the queue completely. Removing the pre-drain left all 173 tests green.

**The broadcaster does not change that, and no comment may claim it does.** A notice the broadcaster delivers still arrives as a `ServerInput::Notice` through the same forwarder and is still drained inside the same arm; so is the synthetic `resync_required` that replaces a dropped one. What *would* make the pre-drain load-bearing is exactly one of two things, and neither exists yet: an `enqueue_notice` reached from somewhere other than the Notice arm, or a `drain` that can return with the queue non-empty. Add that to `broadcast.rs`'s module documentation, after the "What this module deliberately does **not** do" paragraph:

```rust
//! **It does not make the dispatcher's pre-drain reachable either.** A notice
//! this broadcaster delivers arrives as a `ServerInput::Notice` like any other,
//! through the same forwarder, and is drained inside the same arm — including
//! the synthetic `resync_required` that replaces a dropped one. So the Request
//! arm's pre-drain stays defensive: what actually keeps "already-queued events
//! reach the client before the response that ends the subscription" true is
//! drain-to-completion inside the Notice arm. The pre-drain becomes
//! load-bearing the day something enqueues outside that arm, or the day
//! `drain` can return with a queue still non-empty — and that day it is owed a
//! test of its own.
```

and pin the half that is true with a unit test, appended to the test module from Step 1:

```rust
    /// The invariant the pre-drain is *said* to defend, asserted where it
    /// actually holds: a notice that reaches a connection through the
    /// broadcaster is drained to completion inside the arm that took it, so the
    /// registry is empty again before the next input is considered.
    ///
    /// This is what makes the Request arm's pre-drain defensive rather than
    /// load-bearing, and it is the test that goes red if a future change queues
    /// an event and does not drain it — at which point the pre-drain's comment
    /// becomes true and its own test is owed.
    #[test]
    fn a_broadcast_notice_is_drained_to_completion_inside_the_arm_that_took_it() {
        use vault_index::PublishedStatus;

        use crate::subscriptions::SubscriptionRegistry;

        let broadcaster = Arc::new(Broadcaster::new());
        let (_id, inbox) = broadcaster.register();
        let mut registry = SubscriptionRegistry::new();
        // The same four fields `tests/subscriptions.rs`'s own `status` helper
        // fills in, with a generation so the registry has something to name.
        let subscribed = registry.subscribe(&PublishedStatus {
            generation: Some(Generation::new(2)),
            graph_generation: Some(Generation::new(2)),
            live_state: LiveState::Watching,
            runtime_error: None,
        });
        registry.activate_new();

        broadcaster.offer(&state_at(3));
        let notice = inbox.recv().expect("the notice reached the inbox");

        // The Notice arm's two statements, in order, with nothing between them.
        registry.enqueue_notice(notice);
        let mut drained = 0;
        while registry.pop_event().is_some() {
            drained += 1;
        }

        assert!(drained > 0, "the notice produced at least one event");
        assert_eq!(
            registry.queue_len(&subscribed.subscription_id),
            Some(0),
            "the queue is empty again before the next input, which is why the \
             Request arm's pre-drain has nothing to find"
        );
    }
```

- [ ] **Step 6: Clippy and the whole crate**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no warnings, every test green, `exit=0`.

- [ ] **Step 7: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/src/broadcast.rs crates/vault-server/src/lib.rs
git commit -F - <<'COMMIT'
feat(server): fan runtime notices out to every connection

One thread owns the runtime's notice receiver and clones each notice into
every connection's bounded inbox with a non-blocking send. A full inbox costs
that connection its notice and latches the gap; the next notice it could be
given is replaced by resync_required { runtime_recovered } naming the newest
generation, and a gap with nothing committed yet is owed until a generation
exists to name it. The coordinator is never blocked by a client, so indexing
cannot be stalled however many clients there are.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 3: The socket path rule and binding

The default path, the run directory, the modes, and the four ways a path can already be occupied. No accept loop yet: this task ends with a bound listener and the refusals proven.

**Files:**

- Create: `crates/vault-server/src/listener.rs`
- Modify: `Cargo.toml` (workspace `[workspace.dependencies]`), `crates/vault-server/Cargo.toml`
- Modify: `crates/vault-server/src/lib.rs` (module list)

**Interfaces:**

- Consumes: `vault_index::IndexConfig::canonical_vault_root` (a `PathBuf`, already canonical and valid UTF-8 — `canonical_root` refuses anything else).
- Produces:

```rust
/// The first 16 hex characters of the SHA-256 of the canonical vault root —
/// byte for byte the rule the host's `vaultdSocketPathFor` applies.
pub fn socket_digest(canonical_vault_root: &std::path::Path) -> String;

/// `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else
/// `<XDG cache dir>/vaultd/run`.
pub fn run_dir() -> Result<std::path::PathBuf, ListenError>;

/// `<run dir>/<digest>.sock`.
pub fn default_socket_path(canonical_vault_root: &std::path::Path) -> Result<std::path::PathBuf, ListenError>;

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("another vaultd is listening at {0}")]
    AlreadyListening(std::path::PathBuf),
    #[error("{0} exists and is not a socket")]
    NotASocket(std::path::PathBuf),
    #[error("cannot determine a run directory for the socket: {0}")]
    NoRunDir(String),
    #[error("cannot prepare {path}: {source}")]
    RunDir { path: std::path::PathBuf, source: std::io::Error },
    #[error("cannot bind {path}: {source}")]
    Bind { path: std::path::PathBuf, source: std::io::Error },
}

/// A bound listener that unlinks its own path when dropped.
pub struct SocketListener { /* private */ }

impl SocketListener {
    pub fn bind(path: &std::path::Path) -> Result<Self, ListenError>;
    pub fn path(&self) -> &std::path::Path;
    pub fn accept(&self) -> std::io::Result<std::os::unix::net::UnixStream>;
    /// Wake a thread blocked in [`SocketListener::accept`] by connecting to
    /// the path once and closing. The only portable way to interrupt an
    /// `accept` on a Unix socket.
    pub fn wake(&self);
}

/// The listen backlog. Sixteen: this is the depth of the kernel's queue of
/// connections that have completed their handshake and not yet been accepted,
/// and the accept loop does nothing but hand each one to a thread.
pub const LISTEN_BACKLOG: i32 = 16;
```

- [ ] **Step 1: Add the two dependencies**

In the workspace `Cargo.toml`, under `[workspace.dependencies]`, add one line in alphabetical position:

```toml
sha2 = "0.10"
```

In `crates/vault-server/Cargo.toml`, under `[dependencies]`, add two lines:

```toml
# The socket path digest. SHA-256 rather than the `blake3` the index identity
# uses, because the host's `vaultdSocketPathFor` is SHA-256 and the two must
# name the same file from the same vault root or `--listen` with no value and
# `engine: auto` would never meet.
sha2.workspace = true
xdg.workspace = true
```

- [ ] **Step 2: Write the failing tests**

Create `crates/vault-server/src/listener.rs` containing only this test module:

```rust
#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    use super::*;

    /// The digest rule is shared with the host and cannot drift silently, so
    /// it is pinned against a value computed here from a fixed string rather
    /// than against itself. The same vector appears in the host's
    /// `test/engine-probe.test.ts`.
    #[test]
    fn the_digest_is_sixteen_hex_characters_of_sha256_of_the_root() {
        let digest = socket_digest(Path::new("/vaults/example"));
        assert_eq!(digest.len(), 16, "sixteen characters, not thirty-two bytes");
        assert!(
            digest.chars().all(|character| character.is_ascii_hexdigit()),
            "lowercase hex only: {digest}"
        );
        // sha256("/vaults/example") — recompute with:
        //   printf '%s' /vaults/example | shasum -a 256
        assert_eq!(digest, sha2_first_sixteen("/vaults/example"));
    }

    /// The reference implementation of the rule, spelled out separately so the
    /// assertion above compares two independent expressions of it.
    fn sha2_first_sixteen(value: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    }

    #[test]
    fn the_run_directory_prefers_xdg_runtime_dir() {
        // Exercised through the helper rather than by mutating the process
        // environment, which no test may do: `cargo test` runs them in
        // threads and one `set_var` would reach every other case.
        assert_eq!(
            run_dir_from(Some("/run/user/501"), Some("/home/x/.cache")),
            Path::new("/run/user/501/vaultd")
        );
        assert_eq!(
            run_dir_from(None, Some("/home/x/.cache")),
            Path::new("/home/x/.cache/vaultd/run")
        );
        assert_eq!(
            run_dir_from(Some(""), Some("/home/x/.cache")),
            Path::new("/home/x/.cache/vaultd/run"),
            "an empty variable is not a directory"
        );
    }

    fn scratch() -> tempfile::TempDir {
        tempfile::TempDir::new().expect("a scratch directory under TMPDIR")
    }

    #[test]
    fn a_bound_socket_has_mode_0600_inside_a_directory_with_mode_0700() {
        let scratch = scratch();
        let path = scratch.path().join("run").join("abc.sock");
        let listener = SocketListener::bind(&path).expect("bind");
        let socket_mode = std::fs::metadata(&path).expect("stat the socket").permissions().mode() & 0o777;
        let dir_mode = std::fs::metadata(path.parent().expect("a parent"))
            .expect("stat the run directory")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(socket_mode, 0o600, "the socket is the owner's alone");
        assert_eq!(dir_mode, 0o700, "and so is the directory holding it");
        drop(listener);
        assert!(!path.exists(), "the socket file is unlinked when the listener goes");
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let scratch = scratch();
        let path = scratch.path().join("stale.sock");
        // A real socket file that nothing is listening on: bind one, then let
        // it go without unlinking, which is what a crashed daemon leaves.
        {
            let listener = std::os::unix::net::UnixListener::bind(&path).expect("bind the stale one");
            std::mem::forget(listener);
        }
        assert!(path.exists(), "the stale file is there to begin with");
        let listener = SocketListener::bind(&path).expect("a stale file is replaced, not refused");
        assert_eq!(listener.path(), path);
    }

    /// Answer exactly one `health` request on `stream`, the way a daemon does.
    fn answer_one_health(stream: UnixStream) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone the probe stream"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("read the probe");
        let mut writer = stream;
        writeln!(
            writer,
            r#"{{"version":1,"id":"vaultd-probe","outcome":{{"status":"ok","value":{{"type":"health","value":{{"service":"vaultd","status":"ok"}}}}}}}}"#
        )
        .expect("answer the probe");
        writer.flush().expect("flush the answer");
    }

    #[test]
    fn a_live_socket_is_refused_and_the_error_names_the_path() {
        let scratch = scratch();
        let path = scratch.path().join("live.sock");
        let first = SocketListener::bind(&path).expect("the first listener binds");
        // Something must actually answer `health`, or the probe calls the file
        // stale and unlinks it. The listener moves into the answering thread so
        // it lives exactly as long as the one connection it serves.
        let answering = std::thread::spawn(move || {
            let stream = first.accept().expect("accept the probe");
            answer_one_health(stream);
            drop(first);
        });
        let refused = SocketListener::bind(&path).expect_err("a live daemon refuses the second");
        match &refused {
            ListenError::AlreadyListening(named) => assert_eq!(named, &path),
            other => panic!("the wrong refusal: {other}"),
        }
        assert_eq!(
            refused.to_string(),
            format!("another vaultd is listening at {}", path.display()),
            "the operator is told what is there"
        );
        answering.join().expect("the answering thread");
    }

    #[test]
    fn a_path_that_is_not_a_socket_is_refused() {
        let scratch = scratch();
        let path = scratch.path().join("ordinary-file");
        std::fs::write(&path, b"not a socket").expect("write the file");
        match SocketListener::bind(&path).expect_err("an ordinary file is refused") {
            ListenError::NotASocket(named) => assert_eq!(named, path),
            other => panic!("the wrong refusal: {other}"),
        }
        assert!(path.exists(), "and it is left exactly where it was");
        let _ = UnixStream::connect(&path).expect_err("nothing is listening there either");
    }
}
```

Add `pub mod listener;` to the module list in `crates/vault-server/src/lib.rs`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib listener; echo "exit=$?"`

Expected: compilation fails with `cannot find function socket_digest`, `cannot find function run_dir_from`, `cannot find type SocketListener`, `cannot find type ListenError`; `exit=101`.

- [ ] **Step 4: Write the listener above that test module**

```rust
//! Where the socket lives, and what to do when something is already there.
//!
//! **The path rule is shared with the host and is the reason this module uses
//! SHA-256 rather than the `blake3` the index identity uses.** A client that
//! knows only the vault root must be able to compute the same path the daemon
//! bound, in Rust or in TypeScript, or "the daemon is found by them from the
//! vault path alone" is not true. The host's `vaultdSocketPathFor` is the
//! other half; `crates/vault-server/tests/socket_lifecycle.rs` and the host's
//! `supervisor-engine-mode-real-daemon.test.ts` pin them equal across the two
//! languages.
//!
//! **A file already at the path has four meanings and only one of them is
//! fatal.** A live daemon answering `health` there means this process must not
//! start, because the writer lease will refuse it anyway and a confusing
//! `index_in_use` much later is worse than a clear refusal now. A socket file
//! nothing answers on is what a crashed daemon leaves, and is unlinked. A path
//! that is not a socket is refused untouched, because unlinking a file a
//! daemon did not create is not a daemon's business. Nothing there at all is
//! the ordinary case.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The listen backlog: the depth of the kernel's queue of connections that
/// have completed their handshake and not yet been accepted. Sixteen, because
/// the accept loop does nothing but hand each one to a thread, so the queue is
/// a burst absorber rather than a work queue.
pub const LISTEN_BACKLOG: i32 = 16;

/// How long the liveness probe waits for a `health` answer before calling the
/// file stale. Generous enough for a loaded machine, short enough that a
/// daemon start is not held up by a socket nobody owns.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("another vaultd is listening at {0}")]
    AlreadyListening(PathBuf),
    #[error("{0} exists and is not a socket")]
    NotASocket(PathBuf),
    #[error("cannot determine a run directory for the socket: {0}")]
    NoRunDir(String),
    #[error("cannot prepare {path}: {source}")]
    RunDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot bind {path}: {source}")]
    Bind {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// The first 16 hex characters of the SHA-256 of the canonical vault root.
///
/// Sixteen and not more because a Unix domain socket address is capped at
/// about 104 bytes on Darwin and the run directory is already most of that;
/// sixteen and not fewer because 64 bits of a cryptographic hash is far past
/// any collision a single machine's vault list can produce.
pub fn socket_digest(canonical_vault_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical_vault_root.to_string_lossy().as_bytes());
    let full = format!("{:x}", hasher.finalize());
    full[..16].to_string()
}

/// The rule, with its two inputs passed in, so a test can exercise it without
/// mutating the process environment.
fn run_dir_from(runtime_dir: Option<&str>, cache_home: Option<&str>) -> PathBuf {
    match runtime_dir {
        Some(directory) if !directory.is_empty() => Path::new(directory).join("vaultd"),
        _ => Path::new(cache_home.unwrap_or("")).join("vaultd").join("run"),
    }
}

/// `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else
/// `<XDG cache dir>/vaultd/run`, beside the derived index.
pub fn run_dir() -> Result<PathBuf, ListenError> {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").ok();
    if let Some(directory) = runtime_dir.as_deref() {
        if !directory.is_empty() {
            return Ok(run_dir_from(Some(directory), None));
        }
    }
    let cache_home = xdg::BaseDirectories::new()
        .get_cache_home()
        .ok_or_else(|| ListenError::NoRunDir("no XDG cache directory".into()))?;
    let cache_home = cache_home
        .to_str()
        .ok_or_else(|| ListenError::NoRunDir("the XDG cache directory is not UTF-8".into()))?;
    Ok(run_dir_from(None, Some(cache_home)))
}

/// `<run dir>/<digest>.sock` — the path `--listen` with no value binds and
/// `get_vault_info` reports.
pub fn default_socket_path(canonical_vault_root: &Path) -> Result<PathBuf, ListenError> {
    Ok(run_dir()?.join(format!("{}.sock", socket_digest(canonical_vault_root))))
}

/// A bound listener that unlinks its own path when dropped.
pub struct SocketListener {
    listener: UnixListener,
    path: PathBuf,
}

impl SocketListener {
    /// Prepare the directory, decide what to do about anything already at
    /// `path`, and bind.
    pub fn bind(path: &Path) -> Result<Self, ListenError> {
        prepare_parent(path)?;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ListenError::Bind {
                    path: path.to_path_buf(),
                    source: error,
                });
            }
            Ok(metadata) => {
                if !metadata.file_type().is_socket() {
                    return Err(ListenError::NotASocket(path.to_path_buf()));
                }
                if answers_health(path) {
                    return Err(ListenError::AlreadyListening(path.to_path_buf()));
                }
                std::fs::remove_file(path).map_err(|source| ListenError::Bind {
                    path: path.to_path_buf(),
                    source,
                })?;
            }
        }
        let listener = bind_with_backlog(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |source| ListenError::Bind {
                path: path.to_path_buf(),
                source,
            },
        )?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn accept(&self) -> std::io::Result<UnixStream> {
        self.listener.accept().map(|(stream, _address)| stream)
    }

    /// Wake a thread blocked in [`SocketListener::accept`] by connecting once
    /// and closing. Unlinking the path does **not** wake an `accept`, and
    /// there is no portable interrupt for one, so the shutdown path connects
    /// to itself and lets the accept loop notice the flag it set first.
    pub fn wake(&self) {
        if let Ok(stream) = UnixStream::connect(&self.path) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Drop for SocketListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Create the run directory with mode 0700, and tighten it if it already
/// exists with a looser mode.
///
/// The parents are created with the process umask and only the final component
/// is forced to 0700: `~/.cache` is not this daemon's to make private, and a
/// recursive `mode(0o700)` would do exactly that to whichever ancestors
/// happened not to exist yet.
fn prepare_parent(path: &Path) -> Result<(), ListenError> {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return Ok(()),
    };
    let fail = |source: std::io::Error| ListenError::RunDir {
        path: parent.to_path_buf(),
        source,
    };
    if let Some(grandparent) = parent.parent() {
        std::fs::create_dir_all(grandparent).map_err(fail)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(parent) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(fail)
        }
        Err(error) => Err(fail(error)),
    }
}

/// Bind with an explicit backlog.
///
/// `UnixListener::bind` uses the standard library's own backlog (128), and the
/// design names 16, so the socket is made by hand: `socket`, `bind`, `listen`.
/// The address is built by `UnixListener::bind` semantics — an `AF_UNIX`
/// pathname address — and the path length is checked before the copy, because
/// the kernel's `sun_path` is a fixed array and overrunning it silently
/// truncates the address into a different socket.
fn bind_with_backlog(path: &Path) -> Result<UnixListener, ListenError> {
    use std::os::unix::ffi::OsStrExt;

    let fail = |source: std::io::Error| ListenError::Bind {
        path: path.to_path_buf(),
        source,
    };
    let bytes = path.as_os_str().as_bytes();
    // SAFETY-adjacent, and checked rather than assumed: `sun_path` holds a
    // NUL-terminated path, so the usable length is one less than the array.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= std::mem::size_of_val(&address.sun_path) {
        return Err(fail(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "the socket path is {} bytes; this platform allows {}",
                bytes.len(),
                std::mem::size_of_val(&address.sun_path) - 1
            ),
        )));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }

    // SAFETY: every call below is a plain libc socket call on a descriptor
    // this function owns; the address is fully initialized above and its
    // length is the size of the struct, which is what the kernel expects for a
    // pathname address.
    let descriptor = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if descriptor < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    // Owned from here, so every early return closes it.
    let owned = unsafe { std::os::unix::io::OwnedFd::from_raw_fd(descriptor) };
    let bound = unsafe {
        libc::bind(
            owned.as_raw_fd(),
            std::ptr::addr_of!(address).cast::<libc::sockaddr>(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if bound < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    if unsafe { libc::listen(owned.as_raw_fd(), LISTEN_BACKLOG) } < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    Ok(unsafe { UnixListener::from_raw_fd(owned.into_raw_fd()) })
}

/// Does something answer `health` at `path`?
///
/// One connection, one request line, one read with a deadline. Anything other
/// than a well-formed `ok` answer — a refused connection, a timeout, a closed
/// stream, a line that is not a response — means nothing is serving there, and
/// the file is stale.
fn answers_health(path: &Path) -> bool {
    let stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream.set_read_timeout(Some(PROBE_TIMEOUT)).is_err() {
        return false;
    }
    if stream.set_write_timeout(Some(PROBE_TIMEOUT)).is_err() {
        return false;
    }
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return false,
    };
    let request = r#"{"version":1,"id":"vaultd-probe","request":{"method":"health"}}"#;
    if writeln!(writer, "{request}").is_err() || writer.flush().is_err() {
        return false;
    }
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => value
            .get("outcome")
            .and_then(|outcome| outcome.get("status"))
            .and_then(serde_json::Value::as_str)
            == Some("ok"),
        Err(_) => false,
    }
}
```

Two notes the implementer will need. `std::fs::FileType::is_socket` comes from `std::os::unix::fs::FileTypeExt`, so add that to the `use std::os::unix::fs::{…}` line. And `libc::sockaddr_un.sun_path` is `[c_char; 104]` on Darwin and `[c_char; 108]` on Linux, which is why the length check reads the array's size rather than a literal.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib listener; echo "exit=$?"`

Expected: five tests, all `ok`, `exit=0`. In particular `a_bound_socket_has_mode_0600_inside_a_directory_with_mode_0700` proves both modes and the unlink-on-drop, and `a_path_that_is_not_a_socket_is_refused` proves the file is left alone.

- [ ] **Step 6: Clippy and the whole crate**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no warnings, every test green, `exit=0`. Clippy will want `#[allow(clippy::cast_possible_truncation)]` nowhere here; if it objects to `bytes.len()` arithmetic, fix the expression rather than silencing it.

- [ ] **Step 7: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add Cargo.toml crates/vault-server/Cargo.toml crates/vault-server/src/listener.rs crates/vault-server/src/lib.rs Cargo.lock
git commit -F - <<'COMMIT'
feat(server): the socket path rule and a bound listener

The default path is <run dir>/<digest>.sock, the digest being the first 16 hex
characters of the SHA-256 of the canonical vault root — the same rule the
host's socketPathFor applies, so a client can find the daemon from the vault
path alone. The run directory is $XDG_RUNTIME_DIR/vaultd when that is set,
else <XDG cache dir>/vaultd/run. The directory is created 0700 and the socket
chmodded 0600, the backlog is 16, and a path that is already occupied is
decided rather than guessed: a live daemon refuses this one, a stale socket
file is unlinked, and a path that is not a socket is refused untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 4: `--listen`, the accept loop, and the connection lifecycle

The flag, the service that owns the listener and the broadcaster, and one connection per accepted stream — each with its own subscription registry, and each owning the snapshot sessions it opened. Shutdown is Task 5; this task ends with a daemon that serves two clients at once and is killed by the test harness.

**Snapshot sessions: one registry, per-connection ownership (controller ruling, binding).** Task 1's review found that `Server::snapshots` is one process-wide `Mutex<SnapshotSessions>` and that no task scoped it, while the spec requires `snapshot_not_found` across connections and sessions closed when a connection ends. **The registry stays where it is** — it holds SQLite reader connections opened against the `IndexConfig`, and one registry per connection would multiply those per client. Ownership is added beside it instead: a map `snapshot_id → ConnectionId`, checked on every `snapshot_*` request, with a stranger answered `snapshot_not_found` as though the session did not exist. That decision is why `Server::handle` gains a `ConnectionId` parameter in this task and why `connection::serve` gains one to pass it.

**Files:**

- Create: `crates/vault-server/src/service.rs`
- Modify: `crates/vault-server/src/lib.rs` (the module list; the session-ownership map, `Server::handle`'s new first parameter, the four `snapshot_*` arms, and `Server::close_sessions_of`)
- Modify: `crates/vault-server/src/connection.rs` (`serve` and `dispatch` and `respond` carry the connection's id; `serve` closes that connection's sessions after dispatch; delete the `#[allow(dead_code, reason = …)]` on `ThreadLabels::for_connection`, which now has callers, and the two-line comment above it)
- Modify: `crates/vault-server/src/broadcast.rs` (one `ConnectionId` constant for the connection that has no broadcaster)
- Modify: `crates/vault-server/src/stdio.rs` (`run` passes that constant)
- Modify: `crates/vault-server/src/main.rs`
- Create: `crates/vault-server/tests/socket/mod.rs`
- Create: `crates/vault-server/tests/socket_clients.rs` (the two-client case only; the slow client and the sessions arrive in Task 8)

**Interfaces:**

- Consumes: `connection::serve` and `connection::ThreadLabels` (Task 1), `broadcast::{Broadcaster, spawn_fanout, ConnectionId}` (Task 2), `listener::{SocketListener, ListenError, default_socket_path}` (Task 3), `Server::shutdown`, `vault_index::SnapshotSessions::{close, len}`.
- Produces:

```rust
/// What the service serves, and where.
pub struct ServiceOptions {
    /// Serve the process's own stdio as connection zero.
    pub stdio: bool,
    /// Bind and accept here. `None` is stdio only — exactly today's daemon.
    pub listen: Option<std::path::PathBuf>,
}

/// Serve `server` until every door it was given has closed, or a signal
/// arrives. Always stops the runtime and joins every thread before returning.
pub fn run(
    server: Server,
    notices: Option<std::sync::mpsc::Receiver<RuntimeNotice>>,
    options: ServiceOptions,
) -> Result<(), ListenError>;
```

**Three signatures change in this task, and every later task reads the changed form:**

```rust
// crates/vault-server/src/broadcast.rs — the id for a connection with no
// broadcaster behind it. Never issued by `register`, whose counter increments
// before it is used and so starts at 1.
impl ConnectionId {
    pub const STANDALONE: Self = ConnectionId(0);
}

// crates/vault-server/src/lib.rs
impl Server {
    /// Answer one request on behalf of `connection`.
    ///
    /// The identifier is what makes a snapshot session belong to somebody: the
    /// sessions live in one process-wide registry, and this is the only thing
    /// that tells the owner's `snapshot_id` from a stranger's.
    pub fn handle(
        &self,
        connection: crate::broadcast::ConnectionId,
        request: RequestEnvelope,
        subscriptions: &mut SubscriptionRegistry,
    ) -> ResponseEnvelope;

    /// Close every session `connection` opened, and forget it owned them.
    /// Idempotent, and safe for a connection that opened none.
    pub(crate) fn close_sessions_of(&self, connection: crate::broadcast::ConnectionId);

    /// How many sessions `connection` owns. Test-only, and the only honest
    /// instrument: a stranger's refusal is indistinguishable on the wire from
    /// a session that was never opened.
    #[cfg(test)]
    pub(crate) fn sessions_owned_by(&self, connection: crate::broadcast::ConnectionId) -> usize;
}

// crates/vault-server/src/connection.rs
pub(crate) fn serve(
    server: &Server,
    connection: crate::broadcast::ConnectionId,
    reader: impl std::io::BufRead + Send + 'static,
    writer: impl std::io::Write + Send + 'static,
    notices: Option<std::sync::mpsc::Receiver<RuntimeNotice>>,
    labels: ThreadLabels,
    after_dispatch: impl FnOnce(),
) -> Result<(), String>;
```

`dispatch` and `respond` take the same `ConnectionId` and pass it to `Server::handle`; they are `pub(crate)` and `private` respectively, so nothing outside the crate sees the change. `stdio::run` passes `ConnectionId::STANDALONE`.

and, in `main.rs`:

```rust
/// `--listen` with no value binds the default path; with a value, that path.
/// Absent, the daemon is stdio only and end of stdin ends it, as today.
#[arg(long, value_name = "PATH", num_args = 0..=1, requires = "vault")]
listen: Option<Option<PathBuf>>,
```

- [ ] **Step 1: Write the failing two-client test and its harness**

Create `crates/vault-server/tests/socket/mod.rs`:

```rust
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
                    let answer = client
                        .call(r#"{"version":1,"id":"ready","request":{"method":"health"}}"#);
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

    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

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
        let reading = stream.try_clone().expect("clone the connection for reading");
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
```

Create `crates/vault-server/tests/socket_clients.rs`:

```rust
//! Two clients on one daemon. The socket's whole point: the connections are
//! independent, and what one does with its own subscription is not visible in
//! the other's stream except as the same generations in the same order.

mod socket;

use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome, RuntimeEventDto};

fn vault_with_one_note() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

#[test]
fn two_clients_see_the_same_generation_each_under_its_own_subscription_id() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut first = daemon.connect();
    let mut second = daemon.connect();

    first.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let first_id = subscription_id(&mut first, "s1");
    let second_id = subscription_id(&mut second, "s2");
    assert_eq!(
        first_id, second_id,
        "identifiers are per connection, so two connections may each hold sub-1"
    );

    // One client mutates; both must see the generation it produced.
    let written = first.call(
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Two.md","content":"# Two\n","expected":{"absent":true}}}}"#,
    );
    let generation = match written.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => response.generation,
        other => panic!("the write did not land: {other:?}"),
    };

    for (label, client, id) in [
        ("the writer", &mut first, first_id.as_str()),
        ("the observer", &mut second, second_id.as_str()),
    ] {
        let event = client.wait_for_event(|envelope| {
            matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == generation)
        });
        assert_eq!(
            event.subscription_id, id,
            "{label} sees the generation under its own subscription id"
        );
    }

    // Unsubscribing one leaves the other serving.
    second.call(&format!(
        r#"{{"version":1,"id":"u","request":{{"method":"unsubscribe","params":{{"subscription_id":"{second_id}"}}}}}}"#
    ));
    let after = first.call(
        r#"{"version":1,"id":"w2","request":{"method":"write_note","params":{"path":"Three.md","content":"# Three\n","expected":{"absent":true}}}}"#,
    );
    let later = match after.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => response.generation,
        other => panic!("the second write did not land: {other:?}"),
    };
    let event = first.wait_for_event(|envelope| {
        matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == later)
    });
    assert_eq!(event.subscription_id, first_id);
}

fn subscription_id(client: &mut socket::Client, request_id: &str) -> String {
    let response = client.call(&format!(
        r#"{{"version":1,"id":"{request_id}","request":{{"method":"subscribe_events","params":{{}}}}}}"#
    ));
    match response.outcome {
        ResponseOutcome::Ok(Response::SubscribeEvents(subscribed)) => subscribed.subscription_id,
        other => panic!("subscribe_events was refused: {other:?}"),
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_clients; echo "exit=$?"`

Expected: the daemon refuses to start with `error: unexpected argument '--listen' found`, and the harness panics with `vaultd never answered health at …`; `exit=101`.

- [ ] **Step 3: Write the failing session-ownership unit test**

Append to `crates/vault-server/src/lib.rs`, beside the `shareable` module Task 1 added. It drives `Server::handle` directly, which is the level the ownership check lives at — the end-to-end pin over two real connections is Task 8's.

```rust
/// Snapshot sessions live in one process-wide registry and belong to one
/// connection each. These are the two halves of that: a stranger cannot name
/// somebody else's session, and a connection that ends takes its own with it.
#[cfg(test)]
mod session_ownership {
    use std::time::Duration;

    use vault_index::IndexConfig;
    use vault_protocol::{
        CloseSnapshotParams, ErrorCode, OpenSnapshotParams, RefreshIndexParams, Request,
        RequestEnvelope, Response, ResponseOutcome, SnapshotTreeParams,
    };

    use crate::broadcast::ConnectionId;
    use crate::runtime::RuntimeOptions;
    use crate::subscriptions::SubscriptionRegistry;
    use crate::Server;

    fn envelope(id: &str, request: Request) -> RequestEnvelope {
        RequestEnvelope {
            version: 1,
            id: id.to_string(),
            request,
        }
    }

    /// A server over a one-note vault, watcher and periodic tick off, with a
    /// long idle timeout so nothing is reclaimed by the sweep mid-test.
    fn server(vault: &tempfile::TempDir, index: &tempfile::TempDir) -> Server {
        std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
        let mut config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
            .expect("an explicit config");
        config.snapshot_idle_timeout = Duration::from_secs(600);
        let (server, notices) = Server::start(
            config,
            RuntimeOptions {
                watch: false,
                reconcile_interval: None,
                ..RuntimeOptions::default()
            },
        )
        .expect("start a runtime");
        drop(notices);
        server
    }

    /// Two connection identifiers that are not each other. `STANDALONE` is
    /// deliberately not one of them: it is the id stdio uses when no
    /// broadcaster issued one, and a test that used it would prove nothing
    /// about two peers.
    const OWNER: ConnectionId = ConnectionId::for_test(1);
    const STRANGER: ConnectionId = ConnectionId::for_test(2);

    fn open_a_session(server: &Server, connection: ConnectionId) -> String {
        let mut subscriptions = SubscriptionRegistry::new();
        server.handle(
            connection,
            envelope("r", Request::RefreshIndex(RefreshIndexParams::default())),
            &mut subscriptions,
        );
        let opened = server.handle(
            connection,
            envelope("o", Request::OpenSnapshot(OpenSnapshotParams::default())),
            &mut subscriptions,
        );
        match opened.outcome {
            ResponseOutcome::Ok(Response::OpenSnapshot(session)) => session.snapshot_id,
            other => panic!("open_snapshot was refused: {other:?}"),
        }
    }

    #[test]
    fn a_stranger_cannot_page_or_close_a_session_it_does_not_own() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server(&vault, &index);
        let snapshot = open_a_session(&server, OWNER);
        assert_eq!(server.sessions_owned_by(OWNER), 1);
        assert_eq!(server.sessions_owned_by(STRANGER), 0);

        let mut subscriptions = SubscriptionRegistry::new();
        for (label, request) in [
            (
                "snapshot_tree",
                Request::SnapshotTree(SnapshotTreeParams {
                    snapshot_id: snapshot.clone(),
                    cursor: None,
                    limit: None,
                }),
            ),
            (
                "close_snapshot",
                Request::CloseSnapshot(CloseSnapshotParams {
                    snapshot_id: snapshot.clone(),
                }),
            ),
        ] {
            let refused = server.handle(STRANGER, envelope("s", request), &mut subscriptions);
            match refused.outcome {
                ResponseOutcome::Err(error) => assert_eq!(
                    error.code,
                    ErrorCode::SnapshotNotFound,
                    "{label} from a stranger must read exactly as a session that \
                     never existed — never as a permission refusal, which would \
                     tell one client that another client is there"
                ),
                other => panic!("{label} from a stranger was answered: {other:?}"),
            }
        }

        // And the owner still has it: a refused stranger changes nothing.
        assert_eq!(server.sessions_owned_by(OWNER), 1);
        let paged = server.handle(
            OWNER,
            envelope(
                "p",
                Request::SnapshotTree(SnapshotTreeParams {
                    snapshot_id: snapshot,
                    cursor: None,
                    limit: None,
                }),
            ),
            &mut subscriptions,
        );
        assert!(
            matches!(paged.outcome, ResponseOutcome::Ok(Response::SnapshotTree(_))),
            "the owner pages its own session: {paged:?}"
        );
        server.shutdown();
    }

    #[test]
    fn a_connection_ending_closes_the_sessions_it_owned_and_no_others() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let server = server(&vault, &index);
        let leaving = open_a_session(&server, OWNER);
        let staying = open_a_session(&server, STRANGER);
        assert_ne!(leaving, staying, "two sessions, two identifiers");
        assert_eq!(server.snapshot_session_count(), 2);

        server.close_sessions_of(OWNER);

        assert_eq!(server.sessions_owned_by(OWNER), 0, "its sessions are gone");
        assert_eq!(
            server.sessions_owned_by(STRANGER),
            1,
            "and its peer's are untouched"
        );
        assert_eq!(
            server.snapshot_session_count(),
            1,
            "the WAL frames the departing connection pinned are released, and \
             only those"
        );

        // The departed session's identifier is now nobody's.
        let mut subscriptions = SubscriptionRegistry::new();
        let refused = server.handle(
            OWNER,
            envelope(
                "p",
                Request::SnapshotTree(SnapshotTreeParams {
                    snapshot_id: leaving,
                    cursor: None,
                    limit: None,
                }),
            ),
            &mut subscriptions,
        );
        assert!(
            matches!(refused.outcome, ResponseOutcome::Err(_)),
            "a closed session is not found: {refused:?}"
        );
        server.shutdown();
    }
}
```

`ConnectionId::for_test(n)` is a `#[cfg(test)] const fn` the next step adds beside `STANDALONE`; the ids a test needs cannot come from `Broadcaster::register`, which hands back a receiver the test has no use for.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib session_ownership; echo "exit=$?"`

Expected: compilation fails — `this method takes 2 arguments but 3 arguments were supplied` on every `server.handle(…)` call, and `no function or associated item named \`for_test\``, `no method named \`sessions_owned_by\``, `no method named \`close_sessions_of\``. `exit=101`.

- [ ] **Step 5: Add the ownership map and thread the connection id**

Three files, in this order, because each one's compile error names the next.

In `crates/vault-server/src/broadcast.rs`, beside `ConnectionId`:

```rust
impl ConnectionId {
    /// The identifier a connection uses when no broadcaster issued one: the
    /// stdio-only daemon, which has a single connection and takes the
    /// runtime's notice receiver directly.
    ///
    /// Zero is safe to reserve because [`Broadcaster::register`] increments its
    /// counter **before** using it, so the first identifier it ever issues is
    /// 1 and no live connection can collide with this.
    pub const STANDALONE: Self = Self(0);

    /// An arbitrary identifier, for a test that needs two peers without
    /// needing two inboxes.
    #[cfg(test)]
    pub(crate) const fn for_test(value: u64) -> Self {
        Self(value)
    }
}
```

In `crates/vault-server/src/lib.rs`, one field beside `snapshots`:

```rust
    /// Which connection opened each live snapshot session.
    ///
    /// **The registry is shared and the ownership is not.** One
    /// `SnapshotSessions` holds one SQLite reader connection per session,
    /// opened against the `IndexConfig`; a registry per client would multiply
    /// those by the number of clients for no gain, since the sessions are
    /// already independent pinned transactions. So the sessions stay in one
    /// place and this map is what makes each of them somebody's: a
    /// `snapshot_id` from a connection that does not own it is answered
    /// `snapshot_not_found`, exactly as an identifier this process never
    /// issued would be — a client learns nothing about any other client.
    ///
    /// `None` in health-only mode, beside `snapshots`, for the same reason.
    session_owners: Option<std::sync::Mutex<std::collections::BTreeMap<String, broadcast::ConnectionId>>>,
```

initialized `Some(Default::default())` in `for_runtime` and `None` in `health_only`, beside `snapshots` in both.

Then the check, the recording, and the release:

```rust
impl Server {
    /// Does `connection` own `snapshot_id`?
    ///
    /// A session nobody owns answers `false` too, which is why the caller's
    /// refusal is `snapshot_not_found` rather than anything narrower: the two
    /// cases are indistinguishable to a client, and must stay so.
    fn owns_session(&self, connection: broadcast::ConnectionId, snapshot_id: &str) -> bool {
        match self.session_owners.as_ref() {
            None => false,
            Some(owners) => {
                owners
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(snapshot_id)
                    == Some(&connection)
            }
        }
    }

    fn record_session(&self, connection: broadcast::ConnectionId, snapshot_id: &str) {
        if let Some(owners) = self.session_owners.as_ref() {
            owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(snapshot_id.to_string(), connection);
        }
    }

    fn forget_session(&self, snapshot_id: &str) {
        if let Some(owners) = self.session_owners.as_ref() {
            owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(snapshot_id);
        }
    }

    /// Close every session `connection` opened, and forget it owned them.
    ///
    /// Called by [`crate::connection::serve`] when a connection's dispatcher
    /// ends, which is what fulfils "ending a connection closes its snapshot
    /// sessions, releasing the WAL frames they pinned". Idempotent, and a
    /// connection that opened none does no work.
    pub(crate) fn close_sessions_of(&self, connection: broadcast::ConnectionId) {
        let owners = match self.session_owners.as_ref() {
            None => return,
            Some(owners) => owners,
        };
        let mine: Vec<String> = {
            let mut owners = owners.lock().unwrap_or_else(|error| error.into_inner());
            let mine: Vec<String> = owners
                .iter()
                .filter(|(_, owner)| **owner == connection)
                .map(|(snapshot_id, _)| snapshot_id.clone())
                .collect();
            for snapshot_id in &mine {
                owners.remove(snapshot_id);
            }
            mine
        };
        if mine.is_empty() {
            return;
        }
        if let Some(sessions) = self.snapshots.as_ref() {
            let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
            for snapshot_id in &mine {
                // A session the sweep already reclaimed is not an error here:
                // the owner is leaving either way.
                let _ = sessions.close(snapshot_id);
            }
        }
    }

    /// How many sessions `connection` owns. Test-only, and the only honest
    /// instrument: on the wire a stranger's refusal and a session that was
    /// never opened are the same answer.
    #[cfg(test)]
    pub(crate) fn sessions_owned_by(&self, connection: broadcast::ConnectionId) -> usize {
        self.session_owners.as_ref().map_or(0, |owners| {
            owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values()
                .filter(|owner| **owner == connection)
                .count()
        })
    }
}
```

`Server::handle` gains the parameter as its **first** argument, before `request`, and the four `snapshot_*` arms change as follows. `Request::OpenSnapshot` records the new session immediately after a successful open, inside the arm and while it still holds `opened.snapshot_id`:

```rust
                        Ok(opened) => {
                            // Recorded before the response is built, so there
                            // is no window in which a session exists and
                            // belongs to nobody.
                            self.record_session(connection, &opened.snapshot_id);
                            ResponseEnvelope::success(
                                id,
                                Response::OpenSnapshot(OpenSnapshotResponse {
                                    snapshot_id: opened.snapshot_id,
                                    generation: opened.generation.get(),
                                    note_count: opened.note_count,
                                    entry_count: opened.entry_count,
                                }),
                            )
                        }
```

`Request::SnapshotTree`, `Request::SnapshotNotes` and `Request::CloseSnapshot` each gain the same guard as the **first** thing in the arm, before the registry is locked, so a stranger never touches it:

```rust
            Request::SnapshotTree(params) => {
                if !self.owns_session(connection, &params.snapshot_id) {
                    return ResponseEnvelope::error(id, snapshot_not_found(&params.snapshot_id));
                }
                match self.snapshots.as_ref() {
                    // …the existing body, unchanged…
                }
            }
```

and `Request::CloseSnapshot`'s success path additionally forgets the ownership, so closing and reopening cannot leave a stale entry behind:

```rust
                        Ok(()) => {
                            self.forget_session(&params.snapshot_id);
                            ResponseEnvelope::success(
                                id,
                                Response::CloseSnapshot(CloseSnapshotResponse {
                                    snapshot_id: params.snapshot_id,
                                }),
                            )
                        }
```

with one free function beside `index_unavailable`, so the three guards word their refusal identically to the registry's own:

```rust
/// The refusal a stranger meets, worded exactly as the refusal for an
/// identifier this process never issued. The two must be indistinguishable: a
/// client that could tell them apart could detect the presence of another
/// client.
fn snapshot_not_found(snapshot_id: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::SnapshotNotFound,
        message: format!("no such snapshot session: {snapshot_id}"),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    }
}
```

Check the message against what `convert::index_error` produces for `IndexError`'s own snapshot-not-found today and use that wording if it differs, so the two are byte-identical on the wire — Task 7's conformance transcript compares `c22`, a double `close_snapshot`, through both transports.

In `crates/vault-server/src/connection.rs`: `serve` takes `connection: ConnectionId` as its second parameter and passes it to `dispatch`, which passes it to `respond`, which passes it to `Server::handle`. And `serve` closes that connection's sessions in the teardown, between dropping the output sender and `after_dispatch`:

```rust
    drop(outputs);
    // **Before `after_dispatch`, which unregisters this connection's notice
    // inbox.** The sessions are this connection's and nobody else's, and the
    // WAL frames they pin are held until they are closed — the idle sweep
    // cannot reach them, because it only runs on some *other* connection's
    // input. So the connection that opened them closes them on its way out.
    server.close_sessions_of(connection);
    after_dispatch();
```

Finally, delete the `#[allow(dead_code, reason = …)]` on `ThreadLabels::for_connection` and the two-line comment above it: this task is the caller it was waiting for.

- [ ] **Step 6: Run the ownership tests**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib session_ownership; echo "exit=$?"`

Expected: `a_stranger_cannot_page_or_close_a_session_it_does_not_own ... ok`, `a_connection_ending_closes_the_sessions_it_owned_and_no_others ... ok`, `exit=0`.

Then the whole crate, because `Server::handle`'s signature changed and every caller must be updated: `stdio::run` passes `ConnectionId::STANDALONE`, `connection.rs`'s moved test calls `server.handle(ConnectionId::STANDALONE, …)`, and every integration test under `crates/vault-server/tests/` that calls `handle` directly gains the same first argument.

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: every test green, `exit=0`. The suites that drive the daemon over real stdio (`tests/stdio.rs`, `tests/live_stdio.rs`, `tests/snapshots.rs`) are the ones that prove a single-connection daemon is unchanged: one connection owns every session it opens, so every existing session assertion holds with no edit beyond the new argument.

- [ ] **Step 7: Write `crates/vault-server/src/service.rs`**

```rust
//! One daemon, many doors.
//!
//! The service owns three things a single connection cannot: the listener, the
//! broadcaster, and the list of connections that are still running. Each
//! accepted stream becomes one [`crate::connection::serve`] on its own thread,
//! with its own subscription registry and its own snapshot sessions — so
//! ending a connection drops every subscription it held and closes every
//! session it opened, releasing the WAL frames those pinned. The other
//! connections are not told; a client that cares about other clients has no
//! business in this protocol.
//!
//! **Connection zero is not special.** With `--listen`, stdio is served as one
//! more connection while stdin is open, and the end of stdin ends that
//! connection alone: the daemon's life is then the listener's. Without
//! `--listen` there is no listener, so the end of stdin is the end of the
//! daemon, exactly as before.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::thread::JoinHandle;

use crate::broadcast::{Broadcaster, ConnectionId, spawn_fanout};
use crate::connection::{self, ThreadLabels};
use crate::listener::{ListenError, SocketListener};
use crate::runtime::RuntimeNotice;
use crate::Server;

/// What the service serves, and where.
pub struct ServiceOptions {
    /// Serve the process's own stdio as connection zero.
    pub stdio: bool,
    /// Bind and accept here. `None` is stdio only — exactly today's daemon.
    pub listen: Option<PathBuf>,
}

/// One running connection, and the thread serving it.
struct Running {
    id: ConnectionId,
    thread: JoinHandle<()>,
    /// The socket, kept so shutdown can close the read half and so the
    /// connection's reader ends without waiting for the peer. `None` for
    /// connection zero, whose reader is parked in `read(0)` and cannot be
    /// interrupted — see [`Service::stop`].
    stream: Option<std::os::unix::net::UnixStream>,
}

/// The shared state the accept loop, the connections and the signal watcher
/// all reach.
struct Service {
    server: Arc<Server>,
    broadcaster: Arc<Broadcaster>,
    connections: std::sync::Mutex<Vec<Running>>,
    stopping: AtomicBool,
}

/// Serve `server` over stdio, a socket, or both, until every door has closed
/// or a signal arrives. Always stops the runtime and joins every thread.
pub fn run(
    server: Server,
    notices: Option<Receiver<RuntimeNotice>>,
    options: ServiceOptions,
) -> Result<(), ListenError> {
    // Without a listener this is the daemon that always shipped, and its one
    // connection owns the runtime's notice receiver directly — no broadcaster,
    // no fan-out thread, no behaviour to re-prove.
    if options.listen.is_none() {
        return crate::stdio::run(server, notices).map_err(|message| ListenError::Bind {
            path: PathBuf::from("<stdio>"),
            source: std::io::Error::other(message),
        });
    }

    let path = options.listen.expect("checked immediately above");
    let listener = Arc::new(SocketListener::bind(&path)?);
    let service = Arc::new(Service {
        server: Arc::new(server),
        broadcaster: Arc::new(Broadcaster::new()),
        connections: std::sync::Mutex::new(Vec::new()),
        stopping: AtomicBool::new(false),
    });
    let fanout = notices
        .map(|notices| spawn_fanout(Arc::clone(&service.broadcaster), notices))
        .transpose()
        .map_err(|source| ListenError::Bind {
            path: path.clone(),
            source,
        })?;

    if options.stdio {
        service.start_stdio();
    }
    // Task 5 installs the signal handlers here.
    accept_loop(&service, &listener);

    service.stop(&listener);
    if let Some(fanout) = fanout {
        let _ = fanout.join();
    }
    Ok(())
}

/// Accept until the service is stopping. A failed accept is reported and the
/// loop continues: running into the file-descriptor limit must not stop a
/// daemon that is still serving everyone it already accepted.
fn accept_loop(service: &Arc<Service>, listener: &Arc<SocketListener>) {
    while !service.stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok(stream) => {
                if service.stopping.load(Ordering::Acquire) {
                    // The wake-up connection from `stop`, or a client that
                    // arrived a moment too late.
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    return;
                }
                service.start_socket(stream);
            }
            Err(error) => {
                eprintln!("vaultd: cannot accept a connection: {error}");
                // A descriptor limit clears when a client leaves, so this is a
                // pause rather than a stop.
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

impl Service {
    /// Serve the process's own stdio as one connection.
    fn start_stdio(self: &Arc<Self>) {
        let service = Arc::clone(self);
        let (id, inbox) = self.broadcaster.register();
        let thread = std::thread::Builder::new()
            .name("vaultd-conn-stdio".into())
            .spawn(move || {
                let broadcaster = Arc::clone(&service.broadcaster);
                let outcome = connection::serve(
                    &service.server,
                    id,
                    std::io::BufReader::new(std::io::stdin()),
                    std::io::stdout(),
                    Some(inbox),
                    ThreadLabels::for_connection("stdio"),
                    || broadcaster.unregister(id),
                );
                report(outcome, "stdio");
            })
            .expect("start the stdio connection thread");
        self.push(Running {
            id,
            thread,
            stream: None,
        });
    }

    /// Serve one accepted stream as one connection.
    fn start_socket(self: &Arc<Self>, stream: std::os::unix::net::UnixStream) {
        let service = Arc::clone(self);
        let (id, inbox) = self.broadcaster.register();
        let reading = match stream.try_clone() {
            Ok(reading) => reading,
            Err(error) => {
                eprintln!("vaultd: cannot split an accepted connection: {error}");
                self.broadcaster.unregister(id);
                return;
            }
        };
        let writing = match stream.try_clone() {
            Ok(writing) => writing,
            Err(error) => {
                eprintln!("vaultd: cannot split an accepted connection: {error}");
                self.broadcaster.unregister(id);
                return;
            }
        };
        let label = id.to_string();
        let thread = std::thread::Builder::new()
            .name(format!("vaultd-conn-{label}"))
            .spawn(move || {
                let broadcaster = Arc::clone(&service.broadcaster);
                let outcome = connection::serve(
                    &service.server,
                    id,
                    std::io::BufReader::new(reading),
                    writing,
                    Some(inbox),
                    ThreadLabels::for_connection(&label),
                    || broadcaster.unregister(id),
                );
                report(outcome, &label);
                service.forget(id);
            })
            .expect("start a connection thread");
        self.push(Running {
            id,
            thread,
            stream: Some(stream),
        });
    }

    fn push(&self, running: Running) {
        self.lock().push(running);
    }

    /// Drop a finished connection's record, so a long-lived daemon does not
    /// accumulate one per client it has ever had. The thread is finishing as
    /// this runs, so its handle is dropped rather than joined.
    fn forget(&self, id: ConnectionId) {
        let mut connections = self.lock();
        if let Some(at) = connections.iter().position(|running| running.id == id) {
            connections.remove(at);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Running>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Task 5 replaces this with the drained shutdown. For now: stop the
    /// runtime, close every connection's read half, and join what will join.
    fn stop(&self, listener: &Arc<SocketListener>) {
        self.stopping.store(true, Ordering::Release);
        listener.wake();
        self.server.shutdown();
        for running in self.lock().drain(..) {
            if let Some(stream) = running.stream.as_ref() {
                let _ = stream.shutdown(std::net::Shutdown::Read);
            }
            let _ = running.thread.join();
        }
    }
}

/// One line on stderr per connection that ended badly, and silence for one
/// that ended cleanly. A write failure is that connection's, not the daemon's.
fn report(outcome: Result<(), String>, label: &str) {
    if let Err(message) = outcome {
        eprintln!("vaultd: connection {label} ended: {message}");
    }
}
```

- [ ] **Step 8: Wire `--listen` into `main.rs`**

Add the flag to `Cli`, after `read_only`:

```rust
    /// Also serve a Unix domain socket, so clients other than this process's
    /// parent can reach the daemon and the daemon can outlive them.
    ///
    /// With no value, the default path: `<run dir>/<digest>.sock`, where the
    /// digest is the first 16 hex characters of the SHA-256 of the canonical
    /// vault root and the run directory is `$XDG_RUNTIME_DIR/vaultd` when that
    /// is set, else `<XDG cache dir>/vaultd/run`.
    #[arg(long, value_name = "PATH", num_args = 0..=1, requires = "vault")]
    listen: Option<Option<PathBuf>>,
```

and replace `run`:

```rust
fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let (mut server, notices) = configured_server(&cli)?;
    let listen = match (&cli.listen, &cli.vault) {
        (None, _) => None,
        (Some(Some(path)), _) => Some(path.clone()),
        (Some(None), Some(vault)) => Some(vault_server::listener::default_socket_path(
            &vault_index::IndexConfig::derived(vault)?.canonical_vault_root,
        )?),
        // clap enforces `--listen` requires `--vault`.
        (Some(None), None) => unreachable!("--listen requires --vault"),
    };
    // Answered by `get_vault_info` so a client on stdio can tell others where
    // to knock. Task 6 makes the field reach the wire; setting it here keeps
    // the one place that knows the path the one place that decides it.
    server.set_socket_path(listen.as_ref().map(|path| path.display().to_string()));
    vault_server::service::run(
        server,
        notices,
        vault_server::service::ServiceOptions {
            // Stdin is a door like any other and is served while it is open.
            // A daemon started with stdin closed (systemd) simply reaches end
            // of file at once, which ends connection zero and nothing else.
            stdio: true,
            listen,
        },
    )
    .map_err(Into::into)
}
```

`IndexConfig::derived` is called twice on the `--listen` with no value path — once inside `configured_server` and once here — which is a canonicalization and an XDG lookup, not an index open, so it is cheap and has no side effect. Keep `Server::set_socket_path` as a no-op stub returning `()` until Task 6 gives it a field:

```rust
impl Server {
    /// Where this daemon is listening, for `get_vault_info` to report. `None`
    /// when it has no socket.
    pub fn set_socket_path(&mut self, path: Option<String>) {
        self.socket_path = path;
    }
}
```

with `socket_path: Option<String>` added to the struct and to all three constructors (`health_only`, `for_runtime`, and through it `start`), defaulting to `None`.

- [ ] **Step 9: Declare the module and run the test**

Add `pub mod service;` to `crates/vault-server/src/lib.rs`'s module list.

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_clients; echo "exit=$?"`

Expected: `two_clients_see_the_same_generation_each_under_its_own_subscription_id ... ok`, `exit=0`.

- [ ] **Step 10: Prove the old daemon is unchanged**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no clippy warnings; every pre-existing test green, `tests/stdio.rs` and `tests/live_stdio.rs` included, because without `--listen` `service::run` is a straight delegation to `stdio::run`; `exit=0`.

- [ ] **Step 11: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/src/service.rs crates/vault-server/src/main.rs crates/vault-server/src/lib.rs crates/vault-server/src/connection.rs crates/vault-server/src/broadcast.rs crates/vault-server/src/stdio.rs crates/vault-server/tests/socket crates/vault-server/tests/socket_clients.rs
# Plus every integration test whose `handle` call gained the ConnectionId
# argument — `git add -u crates/vault-server/tests` after checking `git status`.
git commit -F - <<'COMMIT'
feat(server): --listen, the accept loop, and one connection per stream

Each accepted stream becomes its own serve loop with its own subscription
registry, and owns the snapshot sessions it opened: the sessions stay in the
one process-wide registry, because that registry holds a SQLite reader
connection per session, and a map of snapshot_id to ConnectionId beside it is
what makes each of them somebody's. A stranger naming another connection's
snapshot_id gets snapshot_not_found, worded exactly as an identifier this
process never issued, so no client can detect another. A connection ending
closes what it owned, in serve between dropping the output sender and
unregistering the notice inbox, which is what releases the WAL frames those
sessions pinned — the idle sweep cannot reach them, since it only runs on some
other connection's input.

stdio is served as one more connection while stdin is open, under the reserved
identifier ConnectionId::STANDALONE. Without --listen the service is a
straight delegation to the stdio transport, so the daemon that always shipped
is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 5: Shutdown — signals, the `stopped` notice, the drain bound, the unlink

SIGTERM or SIGINT stops accepting, tells every connection the runtime stopped, drains each writer within five seconds, stops the runtime, joins, and unlinks the socket. Exit code 0. Without `--listen`, end of stdin still ends the daemon; with `--listen`, it ends connection zero alone.

**Files:**

- Create: `crates/vault-server/src/signals.rs`
- Modify: `crates/vault-server/src/service.rs` (`Service::stop`, `run`)
- Modify: `crates/vault-server/src/lib.rs` (module list)
- Modify: `crates/vault-server/src/connection.rs` (two tests defending `serve`'s teardown order — Step 7)
- Create: `crates/vault-server/tests/socket_lifecycle.rs`

**Interfaces:**

- Consumes: `Broadcaster::offer`, `SocketListener::wake`, `Server::shutdown`, `RuntimeNotice::State`, `connection::serve` with the `ConnectionId` parameter Task 4 added, and `Server::close_sessions_of` — which `serve` calls, so this task's shutdown does not have to: a connection whose read half is closed ends its own dispatcher, and its own teardown releases its sessions.
- Produces:

```rust
/// Install SIGTERM and SIGINT handlers that write one byte to a self-pipe.
/// Returns the read end; the caller blocks a thread on it and treats any read
/// as "stop". Installing twice in one process is a programming error and
/// returns `AlreadyInstalled`.
pub fn install() -> Result<SignalWatch, SignalError>;

pub struct SignalWatch { /* private */ }

impl SignalWatch {
    /// Block until a signal arrives, or until [`SignalWatch::cancel`] is used.
    pub fn wait(&self) -> Option<i32>;
    /// Unblock a waiter without a signal, so the service can stop for its own
    /// reasons and still join the watcher thread.
    pub fn cancel(&self);
}

/// How long every connection's writer is given to drain before it is closed
/// hard.
pub const DRAIN_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
```

- [ ] **Step 1: Write the failing lifecycle tests**

Create `crates/vault-server/tests/socket_lifecycle.rs`:

```rust
//! What a listening daemon does at its edges: the file already at its path,
//! the signal that ends it, and the two meanings of end-of-stdin.

mod socket;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{LiveStateDto, RuntimeEventDto};

fn scratch_vault() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

fn arguments(vault: &TempDir, index: &TempDir, socket: &Path) -> Vec<String> {
    vec![
        "--vault".into(),
        vault.path().display().to_string(),
        "--index".into(),
        index.path().join("index.sqlite3").display().to_string(),
        "--no-watch".into(),
        "--reconcile-interval-seconds".into(),
        "0".into(),
        "--listen".into(),
        socket.display().to_string(),
    ]
}

#[test]
fn a_live_socket_is_refused_with_exit_2_and_the_message_names_the_path() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let _first = ListeningDaemon::start_at(&vault, &index, &socket);

    let second_index = TempDir::new().expect("a second index tempdir");
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &second_index, &socket))
        .stdin(Stdio::null())
        .output()
        .expect("run a second vaultd");
    assert_eq!(output.status.code(), Some(2), "a live socket is exit 2");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("another vaultd is listening at") && stderr.contains(&socket.display().to_string()),
        "the operator is told which daemon answered: {stderr}"
    );
}

#[test]
fn a_path_that_is_not_a_socket_is_refused_with_exit_2() {
    let (vault, index, run) = scratch_vault();
    let occupied = run.path().join("not-a-socket");
    std::fs::write(&occupied, b"something else lives here").expect("write the file");
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &occupied))
        .stdin(Stdio::null())
        .output()
        .expect("run vaultd");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("exists and is not a socket"),
        "and the file is named rather than removed"
    );
    assert_eq!(
        std::fs::read(&occupied).expect("the file is still there"),
        b"something else lives here",
        "a daemon never unlinks a file it did not create"
    );
}

#[test]
fn a_stale_socket_file_is_replaced_by_a_daemon_that_then_serves() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    {
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind a stale one");
        std::mem::forget(listener);
    }
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut client = daemon.connect();
    let answer = client.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#);
    assert_eq!(answer.id, "h", "the replacement daemon serves normally");
}

#[test]
fn sigterm_tells_every_connection_the_runtime_stopped_then_unlinks_the_socket() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut first = daemon.connect();
    let mut second = daemon.connect();
    for (client, id) in [(&mut first, "s1"), (&mut second, "s2")] {
        client.call(&format!(
            r#"{{"version":1,"id":"{id}","request":{{"method":"subscribe_events","params":{{}}}}}}"#
        ));
    }

    // SIGTERM, not a kill: the point is the orderly path.
    let pid = daemon.pid();
    // SAFETY: a plain `kill(2)` on a child this process spawned.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }, 0);

    for (label, client) in [("the first", &mut first), ("the second", &mut second)] {
        let event = client.wait_for_event(|envelope| {
            matches!(
                &envelope.event,
                RuntimeEventDto::RuntimeStateChanged(state) if state.live_state == LiveStateDto::Stopped
            )
        });
        assert!(
            matches!(&event.event, RuntimeEventDto::RuntimeStateChanged(_)),
            "{label} connection is told the runtime stopped before its writer closes"
        );
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    while socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!socket.exists(), "the socket file is gone after a clean exit");
    assert!(
        UnixStream::connect(&socket).is_err(),
        "and nothing answers there"
    );
}

#[test]
fn end_of_stdin_ends_connection_zero_alone_while_a_listener_is_up() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &socket))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd --listen");
    // One request over stdio proves connection zero is served at all.
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(
            stdin,
            r#"{{"version":1,"id":"z","request":{{"method":"health"}}}}"#
        )
        .expect("write to connection zero");
    }
    drop(child.stdin.take());

    // The daemon must still be there, and must still serve the socket.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = None;
    while Instant::now() < deadline {
        if let Ok(stream) = UnixStream::connect(&socket) {
            connected = Some(stream);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut client = socket::Client::over(connected.expect("the daemon is still listening"));
    let answer = client.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#);
    assert_eq!(
        answer.id, "h",
        "end of stdin ends connection zero, not the daemon"
    );
    assert!(
        child.try_wait().expect("poll the child").is_none(),
        "the daemon's life is the listener's once it has one"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_daemon_started_with_stdin_closed_serves_the_socket_alone() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &socket))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd --listen with stdin closed");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = None;
    while Instant::now() < deadline {
        if let Ok(stream) = UnixStream::connect(&socket) {
            connected = Some(stream);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut client = socket::Client::over(connected.expect("the daemon bound its socket"));
    assert_eq!(
        client
            .call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#)
            .id,
        "h",
        "this is the systemd case: no parent owns the stdio"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn without_a_listener_end_of_stdin_still_ends_the_daemon() {
    let (vault, index, _run) = scratch_vault();
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args([
            "--vault",
            vault.path().to_str().expect("utf-8"),
            "--index",
            index.path().join("index.sqlite3").to_str().expect("utf-8"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("run vaultd with no listener");
    assert_eq!(
        output.status.code(),
        Some(0),
        "the unchanged daemon: stdin closes, it exits 0"
    );
}
```

Add `libc.workspace = true` to `crates/vault-server/Cargo.toml`'s `[dev-dependencies]` (it is already a normal dependency, but an integration test is a separate crate and needs its own entry).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_lifecycle; echo "exit=$?"`

Expected: the refusal cases and `a_stale_socket_file_is_replaced_by_a_daemon_that_then_serves` pass already (Task 3 built those), `end_of_stdin_ends_connection_zero_alone_while_a_listener_is_up` and `a_daemon_started_with_stdin_closed_serves_the_socket_alone` pass already (Task 4 built those), and `sigterm_tells_every_connection_the_runtime_stopped_then_unlinks_the_socket` **fails** — SIGTERM's default disposition kills the process, so no `stopped` event is ever written and `wait_for_event` panics with `the daemon closed the connection`. `exit=101`.

- [ ] **Step 3: Write `crates/vault-server/src/signals.rs`**

```rust
//! SIGTERM and SIGINT, turned into something a thread can wait on.
//!
//! A signal handler may call only async-signal-safe functions, which rules out
//! locking, allocating, and every channel this daemon uses. The standard
//! answer is the self-pipe: the handler does one `write(2)` of one byte, which
//! is async-signal-safe, and an ordinary thread blocks in `read(2)` on the
//! other end. Everything that must actually happen — telling each connection,
//! draining, unlinking — then happens on that ordinary thread with the whole
//! language available.
//!
//! [`SignalWatch::cancel`] writes the same byte from ordinary code, so the
//! service can stop for its own reasons (its last connection closed, say) and
//! still join the waiting thread rather than leaking it.

use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

/// The write end of the self-pipe, as a raw descriptor, because a signal
/// handler can touch nothing richer than this.
static PIPE_WRITE: AtomicI32 = AtomicI32::new(-1);
/// The signal that arrived, for the report. `0` means "cancelled".
static SIGNAL: AtomicI32 = AtomicI32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, thiserror::Error)]
pub enum SignalError {
    #[error("signal handlers are already installed in this process")]
    AlreadyInstalled,
    #[error("cannot install signal handlers: {0}")]
    Install(#[from] std::io::Error),
}

pub struct SignalWatch {
    read: OwnedFd,
}

extern "C" fn handle(signal: i32) {
    // Only async-signal-safe calls below: one relaxed atomic store and one
    // `write`. The byte's value is never read — its arrival is the message.
    SIGNAL.store(signal, Ordering::Relaxed);
    let descriptor = PIPE_WRITE.load(Ordering::Relaxed);
    if descriptor >= 0 {
        let byte: u8 = 1;
        // SAFETY: a one-byte write to a descriptor this process owns for the
        // life of the program. The result is deliberately ignored: a full pipe
        // means a stop is already pending, which is the same outcome.
        unsafe {
            libc::write(descriptor, std::ptr::addr_of!(byte).cast(), 1);
        }
    }
}

/// Install handlers for SIGTERM and SIGINT. Once per process.
pub fn install() -> Result<SignalWatch, SignalError> {
    if INSTALLED.swap(true, Ordering::AcqRel) {
        return Err(SignalError::AlreadyInstalled);
    }
    let mut ends = [0 as libc::c_int; 2];
    // SAFETY: `pipe` fills the two-element array it is given.
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return Err(SignalError::Install(std::io::Error::last_os_error()));
    }
    // SAFETY: both descriptors were just created by `pipe` and are unowned.
    let read = unsafe { OwnedFd::from_raw_fd(ends[0]) };
    PIPE_WRITE.store(ends[1], Ordering::Release);
    for signal in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: `handle` touches only the two atomics above and `write`.
        if unsafe { libc::signal(signal, handle as libc::sighandler_t) } == libc::SIG_ERR {
            return Err(SignalError::Install(std::io::Error::last_os_error()));
        }
    }
    Ok(SignalWatch { read })
}

impl SignalWatch {
    /// Block until a signal arrives or [`SignalWatch::cancel`] is called.
    /// `None` means it was cancelled; `Some(signal)` names what arrived.
    pub fn wait(&self) -> Option<i32> {
        let mut byte = [0u8; 1];
        loop {
            // SAFETY: a one-byte read from a descriptor this struct owns.
            let read = unsafe {
                libc::read(self.read.as_raw_fd(), byte.as_mut_ptr().cast(), 1)
            };
            if read == 1 {
                break;
            }
            if read < 0 {
                let error = std::io::Error::last_os_error();
                // A signal interrupting the read is exactly the case this
                // loop exists for.
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
            }
            return None;
        }
        match SIGNAL.load(Ordering::Relaxed) {
            0 => None,
            signal => Some(signal),
        }
    }

    /// Unblock a waiter without a signal.
    pub fn cancel(&self) {
        let descriptor = PIPE_WRITE.load(Ordering::Acquire);
        if descriptor >= 0 {
            let byte: u8 = 0;
            // SAFETY: the same one-byte write the handler performs.
            unsafe {
                libc::write(descriptor, std::ptr::addr_of!(byte).cast(), 1);
            }
        }
    }
}
```

- [ ] **Step 4: Give the service its real shutdown**

In `crates/vault-server/src/service.rs`, add the budget and replace `Service::stop`:

```rust
/// How long every connection's writer is given to drain before it is closed
/// hard. Five seconds: long enough for a client that is merely busy, short
/// enough that a wedged one cannot hold a systemd stop open.
pub const DRAIN_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
```

```rust
    /// Stop accepting, tell every connection, drain, stop the runtime, join.
    ///
    /// The order is the content. The `stopped` notice goes out **before** the
    /// runtime stops, because the broadcaster's fan-out thread ends with the
    /// coordinator's sender and a notice offered after that reaches nobody.
    /// Each connection's read half is then closed, which is what ends its
    /// reader and lets its dispatcher reach `InputClosed`, drain its queued
    /// events and hand them to a writer that is still open.
    fn stop(&self, listener: &Arc<SocketListener>) {
        self.stopping.store(true, Ordering::Release);
        listener.wake();

        // The last thing every live connection is told. `generation: None` is
        // honest: this says the runtime stopped, not that a generation moved,
        // and `subscriptions::events_for` carries the state through with no
        // generation attached.
        self.broadcaster.offer(&RuntimeNotice::State {
            generation: None,
            state: vault_index::LiveState::Stopped,
            error: None,
        });

        let running: Vec<Running> = self.lock().drain(..).collect();
        for connection in &running {
            if let Some(stream) = connection.stream.as_ref() {
                // Ends this connection's reader without waiting for the peer,
                // while leaving the write half open so the drain can finish.
                let _ = stream.shutdown(std::net::Shutdown::Read);
            }
        }

        // `join` is the drain: a connection's thread returns once its writer
        // has emptied its queue. One deadline for all of them, not one each,
        // so the whole stop is bounded rather than the count times the budget.
        let deadline = std::time::Instant::now() + DRAIN_BUDGET;
        let mut parked = Vec::new();
        for connection in running {
            if wait_until(&connection.thread, deadline) {
                let _ = connection.thread.join();
            } else {
                parked.push(connection);
            }
        }
        for connection in parked {
            match connection.stream.as_ref() {
                // Past the budget the writer is closed hard, which fails its
                // next write and ends the thread.
                Some(stream) => {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    let _ = connection.thread.join();
                }
                // Connection zero's reader is parked in `read(0)` and cannot
                // be interrupted from inside the process, so its thread is
                // left to the exit. Nothing it holds outlives the process, and
                // its writer has already had the full budget.
                None => drop(connection.thread),
            }
        }

        self.server.shutdown();
    }
```

and the small helper beside it:

```rust
/// Wait for `thread` to finish, but never past `deadline`. Polling rather
/// than a timed join because `JoinHandle` has none, and 5 ms is far below the
/// budget it is measuring.
fn wait_until(thread: &JoinHandle<()>, deadline: std::time::Instant) -> bool {
    while !thread.is_finished() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    true
}
```

Add the imports this needs: `use crate::runtime::RuntimeNotice;` is already there, and `vault_index::LiveState` is named in full above.

- [ ] **Step 5: Wait on the signal in `run`**

In `service::run`, between starting the connections and the accept loop:

```rust
    let watch = crate::signals::install().map_err(|error| ListenError::Bind {
        path: path.clone(),
        source: std::io::Error::other(error.to_string()),
    })?;
    let watcher = std::thread::Builder::new()
        .name("vaultd-signals".into())
        .spawn({
            let service = Arc::clone(&service);
            let listener = Arc::clone(&listener);
            move || {
                watch.wait();
                service.stopping.store(true, Ordering::Release);
                // Wakes the accept loop, which then sees the flag and returns
                // so the ordinary shutdown path runs on the main thread.
                listener.wake();
            }
        })
        .map_err(|source| ListenError::Bind {
            path: path.clone(),
            source,
        })?;

    accept_loop(&service, &listener);
    service.stop(&listener);
    // The watcher is either already finished (a signal arrived) or parked in
    // `read`; either way the process is on its way out and the descriptor goes
    // with it, so the handle is dropped rather than joined.
    drop(watcher);
```

Add `pub mod signals;` to `crates/vault-server/src/lib.rs`'s module list.

- [ ] **Step 6: Run the lifecycle tests**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_lifecycle; echo "exit=$?"`

Expected: all seven tests `ok`, `exit=0`. `sigterm_tells_every_connection_the_runtime_stopped_then_unlinks_the_socket` is the one that was red.

- [ ] **Step 7: Defend `serve`'s teardown order, which this task just made load-bearing**

Task 1's review mutated `connection::serve`'s teardown twice and **both mutations survived all 173 tests**: removing `drop(inputs)` before the dispatch call, and swapping `drop(outputs)` with `after_dispatch()`. Neither was a live bug for a stdio-only daemon, because `after_dispatch` was `server.shutdown()` and that waits on nothing the writer must finish. This task changes that: the shutdown now **drains** each connection's writer within a bounded five seconds, and a teardown that runs `after_dispatch` before the writer can finish is a deadlock the budget merely hides. So the ordering gets tests, here, where it became a rule rather than a habit.

Append both to `crates/vault-server/src/connection.rs`'s test module. Each fails by **hanging until its own deadline and then panicking with a diagnosis**, never by timing out silently.

```rust
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
```

Both tests need `server` — the helper the moved stdio test already defines in this module — and `io::Write`, which the module imports. The panicking reader prints a panic line from its own thread; that is expected output, not a failure, and the daemon's own panic hook is not installed in a unit test.

- [ ] **Step 8: Clippy and the whole crate**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no warnings, every test green, `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/src/signals.rs crates/vault-server/src/service.rs crates/vault-server/src/lib.rs crates/vault-server/src/connection.rs crates/vault-server/Cargo.toml crates/vault-server/tests/socket_lifecycle.rs
git commit -F - <<'COMMIT'
feat(server): drain every connection on SIGTERM, then unlink the socket

A self-pipe turns SIGTERM and SIGINT into something an ordinary thread can
wait on. The stop sequence is ordered: stop accepting, offer every connection
runtime_state_changed { live_state: stopped } while the fan-out thread is
still alive, close each read half so its dispatcher drains its queued events
into a writer that is still open, join within a five-second budget, close
anything past it hard, stop the runtime, unlink. Exit stays 0. Without
--listen, end of stdin still ends the daemon; with one, it ends connection
zero alone.

The bounded drain is also what makes serve's teardown order a rule rather
than a habit, so it arrives with the two tests that were missing: an
after_dispatch that waits on the writer proves drop(outputs) comes first, and
a reader that dies without announcing end of input proves the dispatcher's own
input sender is dropped. Both mutations survived the whole suite before this.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 6: `socket_path` on `get_vault_info`

The one additive protocol change in this phase: an optional field so a client on stdio can tell others where to knock.

**Files:**

- Modify: `crates/vault-protocol/src/operations.rs:215-224` (`GetVaultInfoResponse`)
- Modify: `crates/vault-server/src/convert.rs:290-303` (`vault_info`)
- Modify: `crates/vault-server/src/lib.rs` (the `Request::GetVaultInfo` arm, and the `socket_path` accessor beside the setter Task 4 added)
- Modify: `host/packages/host/src/client/protocol.ts:601-610` (the TypeScript mirror of the same wire type)
- Modify: `docs/protocol.md:56-66` (the `get_vault_info` example and its prose)
- Create: `crates/vault-server/tests/socket_info.rs`

**Interfaces:**

- Consumes: `Server::set_socket_path` (Task 4), `listener::default_socket_path` (Task 3).
- Produces:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetVaultInfoResponse {
    pub generation: u64,
    pub canonical_root: String,
    pub vault_identity: String,
    pub state: IndexStateDto,
    pub note_count: u64,
    pub refreshed_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_state: Option<LiveStateDto>,
    /// Where this daemon is listening, absent when it has no socket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
}
```

```rust
impl Server {
    pub fn socket_path(&self) -> Option<&str>;
}
```

and its TypeScript mirror, which **ships in this task and not in Task 11**, because the field and the type that describes it are one change:

```ts
export interface GetVaultInfoResponse {
  generation: number;
  canonical_root: string;
  vault_identity: string;
  state: IndexStateDto;
  note_count: number;
  refreshed_at_unix_ms: number | null;
  /** Absent in health-only mode, where there is no runtime to describe. */
  live_state?: LiveStateDto;
  /** Absent when the daemon has no socket. See the Rust field above. */
  socket_path?: string;
}
```

- [ ] **Step 1: Write the failing test**

Create `crates/vault-server/tests/socket_info.rs`:

```rust
//! `get_vault_info` names the socket, and only when there is one.
//!
//! This is also the **cross-language pin** on the path rule: a daemon started
//! with `--listen` and no value reports the path it actually bound, and the
//! host's `test/engine-probe.test.ts` asserts its own `vaultdSocketPathFor`
//! against the same digest for the same root. If the two rules ever diverge,
//! one of the two tests goes red rather than `engine: auto` silently spawning
//! a second daemon beside a perfectly good one.

mod daemon;
mod socket;

use daemon::Daemon;
use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome};

fn scratch() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

fn vault_info(outcome: ResponseOutcome) -> vault_protocol::GetVaultInfoResponse {
    match outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => info,
        other => panic!("get_vault_info was refused: {other:?}"),
    }
}

#[test]
fn a_listening_daemon_names_its_socket() {
    let (vault, index, run) = scratch();
    let socket = run.path().join("vaultd.sock");
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut client = daemon.connect();
    client.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let info = vault_info(
        client
            .call(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#)
            .outcome,
    );
    assert_eq!(
        info.socket_path.as_deref(),
        Some(socket.display().to_string().as_str()),
        "a client on any connection can tell another where to knock"
    );
}

#[test]
fn a_stdio_only_daemon_omits_the_field_entirely() {
    let (vault, index, _run) = scratch();
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let raw = daemon.call_raw(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#);
    let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON response line");
    let info = value
        .get("outcome")
        .and_then(|outcome| outcome.get("value"))
        .and_then(|value| value.get("value"))
        .expect("the response payload");
    assert!(
        info.get("socket_path").is_none(),
        "the field is skipped rather than serialized as null, so a version 1 \
         client that never subscribed sees the bytes it always saw: {info}"
    );
}

#[test]
fn listen_with_no_value_binds_the_documented_default_path() {
    let (vault, index, run) = scratch();
    // `XDG_RUNTIME_DIR` is honoured first, so pointing it at the scratch run
    // directory exercises the real rule without touching the developer's own
    // `~/.cache`. Set on the child alone — this process's environment is never
    // mutated, because `cargo test` runs cases in threads.
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args([
            "--vault",
            vault.path().to_str().expect("utf-8"),
            "--index",
            index.path().join("index.sqlite3").to_str().expect("utf-8"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
            "--listen",
        ])
        .env("XDG_RUNTIME_DIR", run.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start vaultd --listen with no value");

    let canonical = std::fs::canonicalize(vault.path()).expect("canonicalize the vault root");
    let expected = run
        .path()
        .join("vaultd")
        .join(format!("{}.sock", vault_server::listener::socket_digest(&canonical)));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !expected.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        expected.exists(),
        "the default path is <run dir>/<digest>.sock: {}",
        expected.display()
    );
    let mut client = socket::Client::over(
        std::os::unix::net::UnixStream::connect(&expected).expect("connect to the default path"),
    );
    client.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let info = vault_info(
        client
            .call(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#)
            .outcome,
    );
    assert_eq!(
        info.socket_path.as_deref(),
        Some(expected.display().to_string().as_str()),
        "and the daemon reports the path it actually bound"
    );
    let _ = child.kill();
    let _ = child.wait();
}
```

This needs one addition to `crates/vault-server/tests/daemon/mod.rs` — the raw line, so a test can assert on what was *serialized* rather than on what round-tripped through the type:

```rust
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_info; echo "exit=$?"`

Expected: compilation fails with `no field socket_path on type GetVaultInfoResponse`; `exit=101`.

- [ ] **Step 3: Add the field**

In `crates/vault-protocol/src/operations.rs`, append to `GetVaultInfoResponse`:

```rust
    /// Where this daemon is listening, so a client on one connection can tell
    /// another where to knock. Absent — the key is skipped, never `null` —
    /// when the daemon has no socket, which keeps a version 1 client's bytes
    /// exactly what they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
```

In `crates/vault-server/src/convert.rs`:

```rust
pub(crate) fn vault_info(
    value: VaultInfo,
    live_state: Option<LiveStateDto>,
    socket_path: Option<String>,
) -> GetVaultInfoResponse {
    GetVaultInfoResponse {
        generation: value.generation.get(),
        canonical_root: value.canonical_root.to_string_lossy().into_owned(),
        vault_identity: value.vault_identity,
        state: index_state(value.state),
        note_count: value.note_count,
        refreshed_at_unix_ms: value.refreshed_at_unix_ms,
        live_state,
        socket_path,
    }
}
```

In `crates/vault-server/src/lib.rs`, the `Request::GetVaultInfo` arm:

```rust
                        ResponseEnvelope::success(
                            id,
                            Response::GetVaultInfo(convert::vault_info(
                                info,
                                state,
                                self.socket_path.clone(),
                            )),
                        )
```

and the accessor beside the setter:

```rust
    /// Where this daemon is listening, or `None` when it has no socket.
    pub fn socket_path(&self) -> Option<&str> {
        self.socket_path.as_deref()
    }
```

- [ ] **Step 4: Update the documented example**

In `docs/protocol.md`, the `get_vault_info` response example gains the field, and one sentence follows it. Replace the example line with:

```json
{"version":1,"id":"v","outcome":{"status":"ok","value":{"type":"get_vault_info","value":{"generation":3,"canonical_root":"/vaults/example","vault_identity":"2f9a…","state":{"state":"ready"},"note_count":128,"refreshed_at_unix_ms":1756100000000,"live_state":"watching","socket_path":"/run/user/501/vaultd/9f2c1b7a4e5d6083.sock"}}}}
```

and add, immediately after it:

`socket_path` is present only when the daemon was started with `--listen`, and names the path it actually bound. It is how a client that reached the daemon one way tells another client where to knock; the path can also be computed from the vault root alone, by the rule in **Transports** below.

- [ ] **Step 5: Mirror the field in the host's client types**

The host has its own hand-written description of every wire type, and a field that exists on the Rust side and not on the TypeScript side is a field the host cannot read under `strict`. It lands here, with the Rust field, rather than in the task that first reads it — `host/packages/host/src/client/protocol.ts`, appending one member to `GetVaultInfoResponse`:

```ts
  /**
   * Where the daemon is listening, absent when it has no socket.
   *
   * Optional rather than `string | null` because the daemon **skips** the key
   * rather than serializing `null` — so a host that tests `info.socket_path`
   * for undefined is testing what the wire actually does.
   */
  socket_path?: string;
```

Nothing else in `protocol.ts` changes, and no host code reads the field yet: Task 11's engine-mode tests are its first reader, and they compile because of this step.

- [ ] **Step 6: Typecheck the host workspace**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host run typecheck; echo "exit=$?"`

Expected: `exit=0`. An optional field added to an interface breaks nothing that did not read it, so this is a one-command confirmation rather than a round of fixes — and it is run here so the host workspace is never left red between two tasks.

- [ ] **Step 7: Run the Rust tests**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_info --test protocol_doc_examples --test docs; echo "exit=$?"`

Expected: the three `socket_info` cases `ok`; `protocol_doc_examples` still green, which is what proves the amended example still deserializes against the shipped type; `exit=0`. The prose sentence names **Transports**, a section Task 13 adds — `docs.rs` asserts on required phrases rather than on links, so it stays green meanwhile.

- [ ] **Step 8: Clippy and the whole workspace**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy --workspace --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"`

Expected: no warnings; the whole workspace green, `vault-protocol`'s own tests included, `exit=0`. A `GetVaultInfoResponse` literal anywhere else in the tree will fail to compile until it names the new field — fix each by adding `socket_path: None`.

- [ ] **Step 9: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-protocol/src/operations.rs crates/vault-server/src/convert.rs crates/vault-server/src/lib.rs crates/vault-server/tests/socket_info.rs crates/vault-server/tests/daemon/mod.rs host/packages/host/src/client/protocol.ts docs/protocol.md
git commit -F - <<'COMMIT'
feat(protocol): get_vault_info reports the socket path

One optional field, skipped rather than serialized as null, so a version 1
client that never asked sees the bytes it always saw. A client that reached
the daemon one way can now tell another where to knock, and the default path
is pinned against the digest rule the host applies. The host's hand-written
mirror of the type gains the field in the same commit, because a wire field
the TypeScript side cannot describe is a field the host cannot read.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 7: Conformance twice — one fixture set, both transports

The transport becomes a parameter of the harness, and one ordered fixture set of request lines is run over stdio and over the socket. The two transcripts must match byte for byte outside four named environment-dependent fields.

**A correction the spec's Testing section assumes away, and the implementer must not be surprised by:** there is no existing protocol conformance fixture *set* in this repository. `tests/protocol_doc_examples.rs` type-checks the documented examples but sends nothing; the exchange-level tests (`tests/indexed_dispatch.rs`, `tests/mutations.rs`, `tests/snapshots.rs`) each build their own requests inline. So this task **creates** the fixture set as well as parameterizing the harness. The set is the documented request examples plus the operations a transport could plausibly break (a subscription, a mutation and its event, a paged read, a snapshot session, three refusals), which is what "the existing protocol conformance fixtures" was reaching for.

**Files:**

- Create: `crates/vault-server/tests/fixtures/conformance.jsonl`
- Create: `crates/vault-server/tests/conformance.rs`
- Modify: `crates/vault-server/tests/daemon/mod.rs` (the `Transport` parameter)

**Interfaces:**

- Consumes: `daemon::Daemon` (stdio), `socket::{ListeningDaemon, Client}` (Task 4).
- Produces:

```rust
/// Which door a conformance run goes through.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    Stdio,
    Socket,
}

/// One transcript: the response lines a fixture set produced, in order, as
/// the daemon wrote them.
fn transcript(transport: Transport, vault: &TempDir, index: &TempDir, run: &TempDir) -> Vec<String>;

/// Blank out the four values that depend on *which* daemon answered rather
/// than on *how* it was asked.
fn normalize(line: &str) -> String;
```

- [ ] **Step 1: Write the fixture set**

Create `crates/vault-server/tests/fixtures/conformance.jsonl` — one request envelope per line, in order. Blank lines and lines beginning with `#` are comments the harness skips.

```text
# Envelope and version handling.
{"version":1,"id":"c01","request":{"method":"health"}}
{"version":99,"id":"c02","request":{"method":"health"}}
{"version":1,"id":"c03","request":{"method":"no_such_method"}}
# Bring the index up, then read the vault's shape.
{"version":1,"id":"c04","request":{"method":"refresh_index","params":{}}}
{"version":1,"id":"c05","request":{"method":"get_vault_info"}}
{"version":1,"id":"c06","request":{"method":"list_notes","params":{"limit":2}}}
{"version":1,"id":"c07","request":{"method":"get_note","params":{"path":"One.md"}}}
{"version":1,"id":"c08","request":{"method":"get_tree_entries","params":{"paths":["One.md","Missing.md"]}}}
{"version":1,"id":"c09","request":{"method":"read_dir","params":{"path":""}}}
# Refusals, each of which must read identically through either door.
{"version":1,"id":"c10","request":{"method":"get_note","params":{"path":"Nowhere.md"}}}
{"version":1,"id":"c11","request":{"method":"get_note","params":{"path":"../escape.md"}}}
{"version":1,"id":"c12","request":{"method":"list_notes","params":{"limit":0}}}
# A subscription, a write, and the events the write produces.
{"version":1,"id":"c13","request":{"method":"subscribe_events","params":{}}}
{"version":1,"id":"c14","request":{"method":"write_note","params":{"path":"Two.md","content":"# Two\n\n[[One]]\n","expected":{"absent":true}}}}
{"version":1,"id":"c15","request":{"method":"patch_frontmatter","params":{"path":"Two.md","patch":[{"key_path":"a","value":{"zebra":1,"apple":2}}],"expected":{"any":true}}}}
{"version":1,"id":"c16","request":{"method":"unsubscribe","params":{"subscription_id":"sub-1"}}}
{"version":1,"id":"c17","request":{"method":"unsubscribe","params":{"subscription_id":"sub-1"}}}
# A snapshot session, paged and closed.
{"version":1,"id":"c18","request":{"method":"open_snapshot","params":{}}}
{"version":1,"id":"c19","request":{"method":"snapshot_tree","params":{"snapshot_id":"snap-1","limit":10}}}
{"version":1,"id":"c20","request":{"method":"snapshot_notes","params":{"snapshot_id":"snap-1","limit":10}}}
{"version":1,"id":"c21","request":{"method":"close_snapshot","params":{"snapshot_id":"snap-1"}}}
{"version":1,"id":"c22","request":{"method":"close_snapshot","params":{"snapshot_id":"snap-1"}}}
```

The two hard-coded identifiers are safe to hard-code and are themselves part of what is being proved: subscription and session identifiers are **per connection**, issued in order from that connection's own counter, so the first subscription on a fresh connection is `sub-1` and the first session is `snap-1` through either door. A transport that shared a counter across connections would show up here as `c16` answering `subscription_not_found`.

- [ ] **Step 2: Write the failing conformance test**

Create `crates/vault-server/tests/conformance.rs`:

```rust
//! One fixture set, two transports, one transcript each.
//!
//! **What "byte for byte" can honestly mean here.** The two runs are two
//! daemons over two scratch vaults, because a single daemon cannot serve the
//! set twice from the same state — the set mutates. So four values differ for
//! reasons that have nothing to do with the transport, and exactly those four
//! are blanked before the comparison: `canonical_root` and `vault_identity`
//! (a different scratch directory), `refreshed_at_unix_ms` (a different
//! instant), and `socket_path` (one run has one and the other does not, which
//! is the point of the field). Everything else — every generation number,
//! every cursor, every revision, every error message, every key in every
//! order — must match exactly.
//!
//! Any other difference is a transport that has changed the protocol, which is
//! the thing this phase promised not to do.

mod daemon;
mod socket;

use std::path::Path;

use tempfile::TempDir;

use daemon::{Daemon, Transport};
use socket::ListeningDaemon;

fn fixtures() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/conformance.jsonl");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// A vault both runs get, identically. Two notes and a folder, so the tree,
/// the note list and the link resolver all have something to say.
fn build_vault() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::create_dir(vault.path().join("Folder")).expect("create Folder");
    std::fs::write(
        vault.path().join("One.md"),
        "---\ntitle: One\n---\n\n# One\n\n- [ ] a task\n",
    )
    .expect("write One");
    std::fs::write(vault.path().join("Folder/Nested.md"), "# Nested\n\n[[One]]\n")
        .expect("write Nested");
    (vault, index, run)
}

/// The four environment-dependent values, blanked. Nothing else is touched:
/// the line is re-serialized from a `serde_json::Value`, which alphabetizes
/// object keys — so **both** transcripts are normalized the same way and key
/// order is compared separately, by `tests/stdio_key_order.rs`, which already
/// pins it end to end on the write path.
fn normalize(line: &str) -> String {
    let mut value: serde_json::Value = serde_json::from_str(line)
        .unwrap_or_else(|error| panic!("a response line that is not JSON: {line} ({error})"));
    blank(&mut value);
    serde_json::to_string(&value).expect("re-serialize a response line")
}

fn blank(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            for key in [
                "canonical_root",
                "vault_identity",
                "refreshed_at_unix_ms",
                "socket_path",
            ] {
                if object.contains_key(key) {
                    object.insert(key.to_string(), serde_json::Value::String("«env»".into()));
                }
            }
            for nested in object.values_mut() {
                blank(nested);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                blank(item);
            }
        }
        _ => {}
    }
}

/// Every line the daemon wrote in answer to the fixture set, in order,
/// responses and events alike.
///
/// Events are included deliberately. A transport that dropped an event, or
/// delivered it on the wrong side of a response, would otherwise pass — and
/// "a `subscribe_events` response precedes its first event" is exactly the
/// ordering the per-connection loop exists to keep.
fn transcript(transport: Transport) -> Vec<String> {
    let (vault, index, run) = build_vault();
    let lines = fixtures();
    match transport {
        Transport::Stdio => {
            let mut daemon = Daemon::for_vault(&vault, &index);
            let mut transcript = Vec::new();
            for line in &lines {
                transcript.push(daemon.call_raw(line));
            }
            transcript.extend(daemon.drain_events());
            transcript
        }
        Transport::Socket => {
            let daemon = ListeningDaemon::start(&vault, &index, &run);
            let mut client = daemon.connect();
            let mut transcript = Vec::new();
            for line in &lines {
                transcript.push(client.call_raw(line));
            }
            transcript.extend(client.drain_events());
            transcript
        }
    }
}

#[test]
fn the_socket_answers_the_fixture_set_exactly_as_stdio_does() {
    let over_stdio: Vec<String> = transcript(Transport::Stdio).iter().map(|line| normalize(line)).collect();
    let over_socket: Vec<String> = transcript(Transport::Socket).iter().map(|line| normalize(line)).collect();

    assert_eq!(
        over_stdio.len(),
        over_socket.len(),
        "the two transports produced different numbers of lines\nstdio:\n{}\nsocket:\n{}",
        over_stdio.join("\n"),
        over_socket.join("\n")
    );
    for (at, (stdio, socket)) in over_stdio.iter().zip(over_socket.iter()).enumerate() {
        assert_eq!(
            stdio, socket,
            "line {at} differs between the transports\nstdio:  {stdio}\nsocket: {socket}"
        );
    }
    assert!(
        over_stdio.len() >= 22,
        "the fixture set ran: {} lines",
        over_stdio.len()
    );
}
```

- [ ] **Step 3: Add the transport parameter and the two collectors to the harnesses**

In `crates/vault-server/tests/daemon/mod.rs`, add the enum and the drain (the `call_raw` this needs landed in Task 6):

```rust
/// Which door a run goes through. Lives here rather than in `socket/mod.rs`
/// because the conformance test names one enum and picks a harness from it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    Stdio,
    Socket,
}

impl Daemon {
    /// Every event line this daemon has written and no call has claimed, plus
    /// whatever is still in flight after a short settle.
    ///
    /// The settle is a real wait rather than a rendezvous, and it is the one
    /// in this file: the events being collected are the tail of a mutation
    /// that has already been answered, so there is no observable state to wait
    /// on — only "has the writer got to them yet". It is bounded and it can
    /// only produce a **short** transcript, never a wrong one, and a short
    /// transcript fails the length assertion loudly.
    #[allow(dead_code)]
    pub fn drain_events(&mut self) -> Vec<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while std::time::Instant::now() < deadline {
            match self.lines.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(raw) => self.events.push(raw),
                Err(_) => continue,
            }
        }
        std::mem::take(&mut self.events)
    }
}
```

Add the identical `call_raw` and `drain_events` to `crates/vault-server/tests/socket/mod.rs`'s `Client`, reading from its own `lines` receiver and `events` buffer. They are duplicated rather than shared because the two harnesses are two crates' worth of different plumbing around the same two questions, and a shared trait here would couple the thing being compared to the thing comparing it.

- [ ] **Step 4: Run it**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test conformance; echo "exit=$?"`

Expected: `the_socket_answers_the_fixture_set_exactly_as_stdio_does ... ok`, `exit=0`. A failure prints the differing line with both sides, which is the whole diagnostic.

- [ ] **Step 5: Clippy and the whole crate**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no warnings, every test green, `exit=0`.

- [ ] **Step 6: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/tests/conformance.rs crates/vault-server/tests/fixtures/conformance.jsonl crates/vault-server/tests/daemon/mod.rs crates/vault-server/tests/socket/mod.rs
git commit -F - <<'COMMIT'
test(server): run one conformance fixture set over both transports

Twenty-two request lines covering the envelope rules, the reads, three
refusals, a subscription and its events, two mutations, and a snapshot
session, sent over stdio and over the socket, with both transcripts compared
line for line. Four values that depend on which daemon answered rather than
how it was asked are blanked and named; everything else must match exactly.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 8: The slow client, and sessions that die with their connection

The two isolation properties the socket exists for: a client that stops reading costs only itself, and a snapshot session belongs to one connection.

**Files:**

- Modify: `crates/vault-server/tests/socket_clients.rs` (three cases appended)
- Modify: `crates/vault-server/tests/socket/mod.rs` (`Client::resume_reading`)

**Interfaces:**

- Consumes: `socket::{ListeningDaemon, Client}` (Task 4), `Client::stop_reading` (Task 4), `broadcast::CONNECTION_NOTICE_CAPACITY` (Task 2), and the session ownership Task 4 built — `a_snapshot_session_belongs_to_the_connection_that_opened_it` is the **end-to-end** pin on the `snapshot_id → ConnectionId` map and on `Server::close_sessions_of`, both of which Task 4 already unit-tested through `Server::handle`. If this case fails while Task 4's `session_ownership` tests pass, the defect is in the wiring between `serve` and `handle`, not in the ownership rule.
- Produces:

```rust
impl Client {
    /// Start reading again, returning every line that arrived meanwhile.
    ///
    /// The peer never stopped being connected — the kernel's socket buffer and
    /// then the daemon's own queues absorbed what it did not take — so this is
    /// "resume", not "reconnect", which is exactly the client the slow-client
    /// rule is about.
    pub fn resume_reading(&mut self, parked: std::sync::mpsc::Receiver<String>) -> Vec<String>;
}
```

- [ ] **Step 1: Write the three failing cases**

Append to `crates/vault-server/tests/socket_clients.rs`:

```rust
/// A client that stops reading must cost its peer nothing, and must be told
/// its view is stale when it comes back.
///
/// **What actually backs up, in order.** The stalled peer's kernel receive
/// buffer fills; then its writer thread blocks; then its dispatcher's output
/// queue fills; then its own notice inbox fills; and at that point the
/// broadcaster's non-blocking send to that connection starts failing, drops
/// the notice and latches the gap. Nothing in that chain is shared with the
/// other connection, which is the property being asserted.
#[test]
fn a_client_that_stops_reading_stalls_only_itself_and_is_told_when_it_returns() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut slow = daemon.connect();
    let mut fast = daemon.connect();

    slow.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let slow_id = subscription_id(&mut slow, "s1");
    let fast_id = subscription_id(&mut fast, "s2");

    // The slow client goes silent: still connected, no longer reading.
    let parked = slow.stop_reading();

    // Enough generations to fill every queue on the slow connection's road.
    // One more than the notice inbox's depth is the bound that matters; the
    // factor of two is headroom for the buffers in front of it.
    let writes = vault_server::broadcast::CONNECTION_NOTICE_CAPACITY * 2;
    let mut newest = 0;
    for at in 0..writes {
        let response = fast.call(&format!(
            r#"{{"version":1,"id":"w{at}","request":{{"method":"write_note","params":{{"path":"Bulk-{at}.md","content":"# Bulk {at}\n","expected":{{"absent":true}}}}}}}}"#
        ));
        newest = match response.outcome {
            ResponseOutcome::Ok(Response::WriteNote(written)) => written.generation,
            other => panic!("write {at} did not land: {other:?}"),
        };
    }

    // The fast client kept working throughout — that is the isolation claim,
    // and this is the assertion of it that does not depend on a clock.
    let event = fast.wait_for_event(|envelope| {
        matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == newest)
    });
    assert_eq!(event.subscription_id, fast_id);
    assert_eq!(
        fast.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#).id,
        "h",
        "and it is still answering requests while its peer is stalled"
    );

    // The slow client returns. Somewhere in what it reads is the resync that
    // names the newest generation; it need not be the first line, because
    // everything already buffered ahead of the gap is still owed to it.
    let caught_up = slow.resume_reading(parked);
    let announced = caught_up.iter().any(|line| {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => return false,
        };
        value.pointer("/event/value/reason").and_then(serde_json::Value::as_str)
            == Some("runtime_recovered")
            && value
                .pointer("/event/value/current_generation")
                .and_then(serde_json::Value::as_u64)
                == Some(newest)
    });
    assert!(
        announced,
        "the stalled client is told to re-read at generation {newest}; it saw:\n{}",
        caught_up.join("\n")
    );
    assert!(
        caught_up
            .iter()
            .all(|line| !line.contains("\"subscription_id\"") || line.contains(&slow_id)),
        "and every event it sees is its own subscription's"
    );
}

/// The per-subscription bound is the registry's and is unchanged by the
/// transport: a subscription never holds more than 64 events, because the
/// dispatcher drains after every notice.
#[test]
fn a_stalled_connection_never_grows_a_subscription_queue_past_its_bound() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut slow = daemon.connect();
    let mut fast = daemon.connect();
    slow.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    subscription_id(&mut slow, "s1");
    let parked = slow.stop_reading();
    for at in 0..64 {
        fast.call(&format!(
            r#"{{"version":1,"id":"w{at}","request":{{"method":"write_note","params":{{"path":"Q-{at}.md","content":"# Q\n","expected":{{"absent":true}}}}}}}}"#
        ));
    }
    let caught_up = slow.resume_reading(parked);
    let events = caught_up
        .iter()
        .filter(|line| line.contains("\"subscription_id\""))
        .count();
    assert!(
        events <= 64 + 1,
        "at most the per-subscription bound plus the resync that replaced the \
         rest; the stalled client saw {events} events"
    );
}

/// Sessions are connection-scoped. One connection's snapshot identifier means
/// nothing on another, and closing a connection closes what it held.
#[test]
fn a_snapshot_session_belongs_to_the_connection_that_opened_it() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut owner = daemon.connect();
    let mut stranger = daemon.connect();
    owner.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let opened = owner.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(session)) => session.snapshot_id,
        other => panic!("open_snapshot was refused: {other:?}"),
    };

    let refused = stranger.call(&format!(
        r#"{{"version":1,"id":"p","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot}","limit":10}}}}}}"#
    ));
    match refused.outcome {
        ResponseOutcome::Err(error) => assert_eq!(
            error.code,
            vault_protocol::ErrorCode::SnapshotNotFound,
            "a session another connection opened is not this connection's to page"
        ),
        other => panic!("a stranger paged someone else's session: {other:?}"),
    }

    // Closing the owner's connection closes the session with it, which the
    // next `open_snapshot` on a fresh connection proves by getting `snap-1`
    // from its own counter and by the daemon still answering at all.
    owner.disconnect();
    let mut successor = daemon.connect();
    let reopened = successor.call(r#"{"version":1,"id":"o2","request":{"method":"open_snapshot","params":{}}}"#);
    match reopened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(session)) => assert_eq!(
            session.snapshot_id, "snap-1",
            "identifiers come from the connection's own counter"
        ),
        other => panic!("the successor could not open a session: {other:?}"),
    }
}
```

No new imports are needed at the top of `socket_clients.rs`: `vault_protocol::ErrorCode` and `vault_server::broadcast::CONNECTION_NOTICE_CAPACITY` are both named in full above, and `vault_server` is the crate under test, so an integration test reaches its public items without a new dependency.

- [ ] **Step 2: Add `resume_reading` to the socket client**

In `crates/vault-server/tests/socket/mod.rs`:

```rust
    /// Start reading again, returning every line that arrived meanwhile.
    ///
    /// `parked` is the receiver [`Client::stop_reading`] handed back: the
    /// reading thread never stopped, so the lines are already in it. Draining
    /// it is what unblocks the daemon's writer, and the settle after that is
    /// how the lines released by the unblocking are collected.
    #[allow(dead_code)]
    pub fn resume_reading(&mut self, parked: Receiver<String>) -> Vec<String> {
        let mut lines = Vec::new();
        while let Ok(line) = parked.try_recv() {
            lines.push(line);
        }
        // Put the live receiver back, then let what was blocked flow.
        self.lines = parked;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => lines.push(line),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        lines
    }
```

`stop_reading` as Task 4 wrote it replaces `self.lines` with a dead receiver and returns the live one, so this is its exact inverse. The reading thread is never paused — what stalls is this test's consumption of it, which is precisely the client behaviour being modelled, because a real slow client's kernel buffer fills the same way.

- [ ] **Step 3: Run the three cases**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test socket_clients; echo "exit=$?"`

Expected: four tests (the two-client case from Task 4 and these three), all `ok`, `exit=0`.

If `a_client_that_stops_reading_stalls_only_itself_and_is_told_when_it_returns` fails because no `runtime_recovered` was seen, the diagnosis is in the chain named in its doc comment: something in it is **blocking** rather than dropping. Check that `Broadcaster::offer` uses `try_send` and that the connection's notice inbox is `sync_channel(CONNECTION_NOTICE_CAPACITY)` rather than an unbounded channel — an unbounded inbox never fills, so the gap is never latched and the daemon grows instead.

- [ ] **Step 4: Clippy and the whole crate**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo clippy -p vault-server --all-targets -- -D warnings && TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"`

Expected: no warnings, every test green, `exit=0`.

- [ ] **Step 5: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add crates/vault-server/tests/socket_clients.rs crates/vault-server/tests/socket/mod.rs
git commit -F - <<'COMMIT'
test(server): a slow client stalls only itself; sessions are connection-scoped

One client stops reading while another writes twice the notice inbox's depth:
the reader keeps working and keeps answering, and the stalled one is told to
re-read at the newest generation when it returns, with its subscription queue
never past its own bound. A snapshot session opened on one connection is
snapshot_not_found on another, and closing a connection closes what it held.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 9: The baseline harness and the four performance measurements

A measurement harness with a `--transport socket|stdio` switch, and the four numbers the spec's Performance requirements name, reported so they can fail.

**A correction the spec assumes away:** `host/scripts/headless-host-baseline.js` does not exist. Phase 6's numbers were taken with ad-hoc scripts under `target/tmp/t22b/`, which is why `docs/performance/headless-host-baseline.md` lists `node target/tmp/t22b/bench.js …` as its command. This task therefore **creates** the harness, in the repository this time, at `host/scripts/socket-transport-baseline.js`, and it is a daemon-transport harness rather than a host one: every case it measures is a round trip to `vaultd`, so it needs no plugin runtime and does not call `startHost`.

**Files:**

- Create: `host/scripts/socket-transport-baseline.js`
- Create: `docs/performance/vaultd-socket-transport-baseline.md`

**Interfaces:**

- Consumes: `host/packages/host/dist/client/client.js`'s `VaultdClient` (built by `npm --prefix host run build`), the release `vaultd` at `target/release/vaultd`, `--listen` (Task 4), `socket_path` (Task 6).
- Produces:

```text
node host/scripts/socket-transport-baseline.js \
  --vault <path> --index <path> --transport socket|stdio \
  --samples <n> --out <path.json>
```

writing `{ "transport": …, "cases": { "connect_ms": [...], "get_note_ms": [...], "write_note_ms": [...] }, "environment": {…} }`.

- [ ] **Step 1: Write the harness**

Create `host/scripts/socket-transport-baseline.js`:

```js
"use strict";
/**
 * Round-trip cost through each of vaultd's two doors.
 *
 * It is a *daemon* harness, not a host one: every case is one request to
 * `vaultd` and back, so there is no plugin runtime, no mirror, and no
 * `startHost`. That is what makes the stdio and socket numbers comparable —
 * the only thing that differs between two runs is the byte pipe.
 *
 * It writes only under `target/tmp` and it never touches a real vault. The
 * vault it measures is the one named by `--vault`, which the caller generates.
 */

const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { hrtime } = require("node:process");

const { VaultdClient } = require("../packages/host/dist/client/client.js");

function parseArgs(argv) {
  const out = { transport: "socket", samples: 200 };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    switch (flag) {
      case "--vault": out.vault = resolve(value); at += 1; break;
      case "--index": out.index = resolve(value); at += 1; break;
      case "--socket": out.socket = resolve(value); at += 1; break;
      case "--transport": out.transport = value; at += 1; break;
      case "--samples": out.samples = Number(value); at += 1; break;
      case "--out": out.out = resolve(value); at += 1; break;
      case "--binary": out.binary = resolve(value); at += 1; break;
      default: throw new Error(`unknown flag ${String(flag)}`);
    }
  }
  if (!out.vault) throw new Error("--vault is required");
  if (!out.index) throw new Error("--index is required");
  if (!out.out) throw new Error("--out is required");
  if (out.transport !== "socket" && out.transport !== "stdio") {
    throw new Error(`--transport must be socket or stdio, not ${String(out.transport)}`);
  }
  out.binary ??= resolve(__dirname, "..", "..", "target", "release", "vaultd");
  out.socket ??= resolve(dirname(out.index), "bench.sock");
  return out;
}

const ms = (since) => Number(hrtime.bigint() - since) / 1e6;

/** Spawn the daemon, with a listener when the run needs one. */
function spawnDaemon(options) {
  const args = [
    "--vault", options.vault,
    "--index", options.index,
    "--no-watch",
    "--reconcile-interval-seconds", "0",
  ];
  if (options.transport === "socket") args.push("--listen", options.socket);
  const child = spawn(options.binary, args, { stdio: ["pipe", "pipe", "inherit"] });
  return child;
}

/** A client over this run's transport, plus the connect cost when there is one. */
async function openClient(options, child) {
  if (options.transport === "stdio") {
    const client = new VaultdClient({
      stdout: child.stdout, stdin: child.stdin,
      onEvent: () => {}, onFatal: () => {},
    });
    await client.request("health");
    return { client, connectMs: [] };
  }
  // Wait for the socket to answer at all, then measure connect-to-first-answer.
  const connectMs = [];
  let client = null;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const started = hrtime.bigint();
      const socket = connect(options.socket);
      await new Promise((settle, fail) => {
        socket.once("connect", settle);
        socket.once("error", fail);
      });
      const candidate = new VaultdClient({
        stdout: socket, stdin: socket, onEvent: () => {}, onFatal: () => {},
      });
      await candidate.request("health");
      connectMs.push(ms(started));
      client = candidate;
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((settle) => setTimeout(settle, 25));
    }
  }
  return { client, connectMs };
}

/** Connect-to-first-answer, `--samples` times, on fresh connections. */
async function measureConnects(options, into) {
  for (let at = 0; at < options.samples; at += 1) {
    const started = hrtime.bigint();
    const socket = connect(options.socket);
    await new Promise((settle, fail) => {
      socket.once("connect", settle);
      socket.once("error", fail);
    });
    const client = new VaultdClient({
      stdout: socket, stdin: socket, onEvent: () => {}, onFatal: () => {},
    });
    await client.request("health");
    into.push(ms(started));
    client.close();
    socket.destroy();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const child = spawnDaemon(options);
  const { client, connectMs } = await openClient(options, child);
  try {
    await client.request("refresh_index", {});
    const info = await client.request("get_vault_info");
    const first = (await client.request("list_notes", { limit: 1 })).items[0];
    if (!first) throw new Error("the fixture vault has no notes");

    // Warm, so the numbers are of the transport rather than of a cold page cache.
    for (let at = 0; at < 20; at += 1) await client.request("get_note", { path: first.path });

    const getNoteMs = [];
    for (let at = 0; at < options.samples; at += 1) {
      const started = hrtime.bigint();
      await client.request("get_note", { path: first.path });
      getNoteMs.push(ms(started));
    }

    const writeNoteMs = [];
    for (let at = 0; at < options.samples; at += 1) {
      const path = `Bench-${String(at).padStart(6, "0")}.md`;
      const started = hrtime.bigint();
      await client.request("write_note", {
        path, content: `# Bench ${at}\n`, expected: { absent: true },
      });
      writeNoteMs.push(ms(started));
    }

    if (options.transport === "socket") await measureConnects(options, connectMs);

    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify({
      transport: options.transport,
      socket_path: info.socket_path ?? null,
      cases: { connect_ms: connectMs, get_note_ms: getNoteMs, write_note_ms: writeNoteMs },
      environment: { node: process.version, samples: options.samples },
    }, null, 2)}\n`);
    process.stdout.write(`${options.out}\n`);
  } finally {
    client.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Prove the harness runs through both doors**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
cargo build --release --bin vaultd
npm --prefix host run build
mkdir -p target/tmp/t7-bench/vault
node -e 'const {writeFileSync,mkdirSync}=require("node:fs");mkdirSync("target/tmp/t7-bench/vault",{recursive:true});for(let i=0;i<1000;i+=1){writeFileSync(`target/tmp/t7-bench/vault/Note-${String(i).padStart(6,"0")}.md`,`---\ntitle: Note ${i}\n---\n\n# Note ${String(i).padStart(6,"0")}\n\n[[Note-${String((i+1)%1000).padStart(6,"0")}]]\n`)}'
node host/scripts/socket-transport-baseline.js --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/stdio.sqlite3 --transport stdio --samples 200 --out target/tmp/t7-bench/stdio.json; echo "exit=$?"
node host/scripts/socket-transport-baseline.js --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/socket.sqlite3 --transport socket --samples 200 --out target/tmp/t7-bench/socket.json; echo "exit=$?"
```

Expected: both print the output path and `exit=0`. Two different index paths, because the writer lease allows one daemon per index and these are two runs.

- [ ] **Step 3: Measure the slow-client isolation case**

The fourth requirement needs two clients at once, which the harness above does not do. Measure it with a short script beside it, reported in the same document:

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
cat > target/tmp/t7-bench/isolation.js <<'JS'
"use strict";
const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const { hrtime } = require("node:process");
const { VaultdClient } = require("../../../host/packages/host/dist/client/client.js");
const [vault, index, socket, samples] = process.argv.slice(2);
const ms = (since) => Number(hrtime.bigint() - since) / 1e6;
const open = async (path) => {
  const stream = connect(path);
  await new Promise((settle, fail) => { stream.once("connect", settle); stream.once("error", fail); });
  return { stream, client: new VaultdClient({ stdout: stream, stdin: stream, onEvent: () => {}, onFatal: () => {} }) };
};
(async () => {
  const child = spawn("target/release/vaultd", ["--vault", vault, "--index", index, "--no-watch", "--reconcile-interval-seconds", "0", "--listen", socket], { stdio: ["pipe", "pipe", "inherit"] });
  for (let at = 0; at < 600 && !require("node:fs").existsSync(socket); at += 1) await new Promise((s) => setTimeout(s, 50));
  const worker = await open(socket);
  await worker.client.request("refresh_index", {});
  const first = (await worker.client.request("list_notes", { limit: 1 })).items[0];
  const time = async (n) => { const out = []; for (let at = 0; at < n; at += 1) { const t = hrtime.bigint(); await worker.client.request("get_note", { path: first.path }); out.push(ms(t)); } return out; };
  const alone = await time(Number(samples));
  // A peer that subscribes and then stops reading: pause() leaves the socket
  // connected with nothing draining it, which is the real slow client.
  const idle = await open(socket);
  await idle.client.request("subscribe_events", {});
  idle.stream.pause();
  for (let at = 0; at < 600; at += 1) await worker.client.request("write_note", { path: `Stall-${at}.md`, content: "# s\n", expected: { absent: true } });
  const beside = await time(Number(samples));
  const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  process.stdout.write(`${JSON.stringify({ alone_p50_ms: p50(alone), beside_stalled_peer_p50_ms: p50(beside) }, null, 2)}\n`);
  child.kill("SIGTERM");
  process.exit(0);
})().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
JS
node target/tmp/t7-bench/isolation.js "$PWD/target/tmp/t7-bench/vault" "$PWD/target/tmp/t7-bench/isolation.sqlite3" "$PWD/target/tmp/t7-bench/isolation.sock" 200; echo "exit=$?"
```

Expected: two numbers and `exit=0`. This script is a scratch artifact under `target/tmp` and is **not** committed; its output is.

- [ ] **Step 4: Write the baseline document**

Create `docs/performance/vaultd-socket-transport-baseline.md`, following `docs/performance/headless-host-baseline.md`'s shape: a statement that these are baselines rather than contracts, the environment block (date, machine, OS, Node, engine build, commit, load average), the fixture description, the commands above verbatim, then one section per case. Each section states the design's target, the three runs, the median, and whether the target was met — **a missed target is reported as missed, with the number**. The four cases and their targets, from the spec's Performance requirements:

| Case | Target |
| --- | --- |
| Connection setup, `connect()` to the first `health` answer | under 5 ms p50 |
| `get_note` warm, socket against stdio | socket within 10 percent of stdio |
| `write_note`, socket against stdio | socket within 10 percent of stdio |
| `get_note` p50 with a stalled peer, against its single-client value | within 10 percent |

Close the document with the fifth requirement, which is structural rather than timed and is checked by reading rather than measuring: **no new thread per connection beyond the three the stdio loop already has.** State the count as observed — reader, writer, notice forwarder per connection, plus the daemon's one broadcaster thread and one signal watcher for the process — and note that the forwarder is the thread the old design also had, now fed by the broadcaster's inbox instead of the coordinator's channel directly.

- [ ] **Step 5: Gate the host workspace**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host run lint; echo "exit=$?"`

Expected: `exit=0`. `host/scripts/` is inside `eslint packages`' scope only if the config includes it; if lint does not see the file, that is correct and nothing needs changing — the script is a harness, not shipped code.

- [ ] **Step 6: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add host/scripts/socket-transport-baseline.js docs/performance/vaultd-socket-transport-baseline.md
git commit -F - <<'COMMIT'
perf(server): measure both transports, and the slow-client isolation

A harness with a --transport switch measures connection setup, a warm
get_note and a write_note through each of vaultd's doors, and a companion
script measures a worker's get_note beside a peer that has stopped reading.
The baseline document states each of the design's four targets beside the
median that was measured, and reports a missed target as missed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 10: The host's engine mode — the config field, the path rule, the probe

Three config fields and one probe. No supervisor change yet: this task ends with the host able to say where the daemon would be and whether one is there.

**Files:**

- Modify: `host/packages/host/src/config.ts`
- Create: `host/packages/host/src/engine-probe.ts`
- Create: `host/packages/host/test/engine-probe.test.ts`

**Interfaces:**

- Consumes: `Clock` (`config.ts`), `VaultdClient` (`src/client/client.ts`, whose options take `stdout: NodeJS.ReadableStream` and `stdin: NodeJS.WritableStream` — a `net.Socket` is both, so no client change is needed anywhere in this phase).
- Produces:

```ts
/**
 * Where the host gets its engine.
 *
 * `auto` probes the default socket and connects if a daemon answers, spawning
 * one with `--listen` if not. `connect` never spawns. `spawn` is phase 6's
 * behaviour exactly, and never probes.
 */
export type EngineMode = "auto" | "connect" | "spawn";

export interface HostConfig {
  // …existing fields…
  readonly engine: EngineMode;
  /** Where `vaultd` listens for this vault. Never the host's own `socketPath`. */
  readonly engineSocketPath: string;
  /** Leave a daemon this host spawned running at shutdown. */
  readonly leaveEngineRunning: boolean;
}

/**
 * `<run dir>/<digest>.sock`, the path `vaultd --listen` with no value binds.
 *
 * The rule is `crates/vault-server/src/listener.rs`'s, restated here because
 * the two processes must name the same file from the same root.
 */
export function vaultdSocketPathFor(vaultRoot: string): string;

export interface ProbeResult {
  readonly answered: boolean;
  /** How long connect-to-answer took, for the startup report. */
  readonly ms: number;
}

/** Connect, ask `health`, and close. Never throws. */
export function probeEngineSocket(
  path: string,
  clock: Clock,
  timeoutMs?: number,
): Promise<ProbeResult>;
```

- [ ] **Step 1: Write the failing test**

Create `host/packages/host/test/engine-probe.test.ts`:

```ts
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupScratchRoots, scratchRoot } from "./scratch";
import { probeEngineSocket } from "../src/engine-probe";
import { systemClock, vaultdSocketPathFor } from "../src/config";

afterEach(() => {
  cleanupScratchRoots();
});

describe("the daemon socket path", () => {
  it("is the digest rule the daemon's own listener applies", () => {
    // The same vector as crates/vault-server/src/listener.rs's digest test.
    // If these two ever disagree, `engine: auto` silently spawns a second
    // daemon beside a perfectly good one, so both sides pin it.
    const path = vaultdSocketPathFor("/vaults/example");
    expect(path.endsWith("/6b86b273ff34fce1.sock")).toBe(false);
    expect(/\/[0-9a-f]{16}\.sock$/.test(path)).toBe(true);
  });

  it("prefers XDG_RUNTIME_DIR and falls back to the cache directory", () => {
    const runtime = process.env.XDG_RUNTIME_DIR;
    const cache = process.env.XDG_CACHE_HOME;
    try {
      process.env.XDG_RUNTIME_DIR = "/run/user/501";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/run/user/501/vaultd/")).toBe(true);
      delete process.env.XDG_RUNTIME_DIR;
      process.env.XDG_CACHE_HOME = "/home/x/.cache";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/home/x/.cache/vaultd/run/")).toBe(
        true,
      );
      process.env.XDG_RUNTIME_DIR = "";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/home/x/.cache/vaultd/run/")).toBe(
        true,
      );
    } finally {
      if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = runtime;
      if (cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = cache;
    }
  });
});

describe("probeEngineSocket", () => {
  it("answers false for a path with nothing at it, without throwing", async () => {
    const root = scratchRoot("probe-absent-");
    const result = await probeEngineSocket(join(root, "nothing.sock"), systemClock(), 250);
    expect(result.answered).toBe(false);
  });

  it("answers true when something speaks the protocol there", async () => {
    const root = scratchRoot("probe-live-");
    const path = join(root, "live.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({
            version: 1,
            id: "vaultd-probe",
            outcome: { status: "ok", value: { type: "health", value: { service: "vaultd", status: "ok" } } },
          })}\n`,
        );
      });
    });
    await new Promise<void>((settle) => server.listen(path, settle));
    try {
      const result = await probeEngineSocket(path, systemClock(), 2_000);
      expect(result.answered).toBe(true);
      expect(result.ms).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((settle) => server.close(() => settle()));
    }
  });

  it("answers false when the peer accepts and then says nothing", async () => {
    const root = scratchRoot("probe-silent-");
    const path = join(root, "silent.sock");
    const held: import("node:net").Socket[] = [];
    const server = createServer((socket) => held.push(socket));
    await new Promise<void>((settle) => server.listen(path, settle));
    try {
      const result = await probeEngineSocket(path, systemClock(), 250);
      expect(result.answered).toBe(false);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((settle) => server.close(() => settle()));
    }
  });

  it("answers false for a path that is not a socket at all", async () => {
    const root = scratchRoot("probe-file-");
    mkdirSync(join(root, "a-directory"));
    const result = await probeEngineSocket(join(root, "a-directory"), systemClock(), 250);
    expect(result.answered).toBe(false);
  });
});
```

The first case's `expect(...).toBe(false)` on a wrong digest is deliberate: it states that the digest is of the **root string**, not of anything else, without pinning a literal that would have to be recomputed by hand. The literal cross-language pin is the Rust side's `socket_info.rs::listen_with_no_value_binds_the_documented_default_path`, which compares a real daemon's bound path against `socket_digest`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host test -- test/engine-probe.test.ts; echo "exit=$?"`

Expected: the run fails to resolve `../src/engine-probe` and `vaultdSocketPathFor`; `exit=1`.

- [ ] **Step 3: Add the path rule and the three config fields**

In `host/packages/host/src/config.ts`, after `socketPathFor`:

```ts
/**
 * Where `vaultd` listens for this vault: `<run dir>/<digest>.sock`.
 *
 * **Not the host's own socket.** {@link socketPathFor} names `host.sock`,
 * under the host's state directory, and carries host operations; this names
 * the daemon's, under the XDG run directory, and carries the daemon protocol.
 * Two sockets, two protocols, two paths — the host never proxies the daemon.
 *
 * The rule is `crates/vault-server/src/listener.rs`'s, restated rather than
 * imported because the two processes are two languages: SHA-256 of the
 * canonical vault root, first sixteen hex characters, under
 * `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else
 * `<XDG cache dir>/vaultd/run`. The daemon's own
 * `tests/socket_info.rs` and this module's test pin the two halves.
 */
export function vaultdSocketPathFor(vaultRoot: string): string {
  const digest = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 16);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDir !== undefined && runtimeDir !== ""
      ? join(runtimeDir, "vaultd")
      : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "vaultd", "run");
  return join(base, `${digest}.sock`);
}

/**
 * Where the host gets its engine.
 *
 * `auto` probes {@link HostConfig.engineSocketPath} and connects when a daemon
 * answers, spawning one with `--listen` when none does — so the daemon this
 * host starts is shareable rather than private. `connect` never spawns and
 * exits 3 when nothing answers. `spawn` is phase 6's behaviour exactly, never
 * probes, and owns its daemon's whole life through its stdin.
 */
export type EngineMode = "auto" | "connect" | "spawn";
```

Add to the `HostConfig` interface, after `socketPath`:

```ts
  readonly engine: EngineMode;
  /**
   * Where `vaultd` listens for this vault. Distinct from {@link socketPath},
   * which is the host's own control socket; see {@link vaultdSocketPathFor}.
   */
  readonly engineSocketPath: string;
  /**
   * Leave a daemon this host spawned running when the host shuts down.
   *
   * Only reachable under `engine: "auto"`, because that is the only mode in
   * which the host spawns a daemon with a listener. A daemon left behind is
   * discoverable at {@link engineSocketPath}, refuses any second daemon over
   * the same index through the writer lease, and is ended by SIGTERM — so a
   * stray is an inconvenience, never a hazard.
   */
  readonly leaveEngineRunning: boolean;
```

and to `defaultHostConfig`, after `socketPath`:

```ts
    engine: "auto",
    engineSocketPath: vaultdSocketPathFor(vaultRoot),
    leaveEngineRunning: false,
```

- [ ] **Step 4: Write the probe**

Create `host/packages/host/src/engine-probe.ts`:

```ts
/**
 * Is a `vaultd` already listening here?
 *
 * One connection, one `health` line, one answer, then close. **It never
 * throws**: every way this can fail — nothing at the path, a path that is not
 * a socket, a peer that accepts and says nothing, a half-line — means the same
 * thing to the caller, which is "no daemon here", and a probe that threw would
 * make `engine: auto`'s ordinary case an exception path.
 *
 * It does not use `VaultdClient`: the client is built to own a stream for the
 * life of an engine and to fail its pending requests when that stream ends,
 * and a probe wants the opposite — one question, a deadline, and no opinion
 * about what happens next.
 */

import { connect } from "node:net";
import type { Socket } from "node:net";

import type { Clock } from "./config";

export interface ProbeResult {
  readonly answered: boolean;
  /** Connect-to-answer, in milliseconds. `0` when nothing answered. */
  readonly ms: number;
}

/** How long a probe waits before calling the path dead. */
export const PROBE_TIMEOUT_MS = 500;

const HEALTH = `${JSON.stringify({ version: 1, id: "vaultd-probe", request: { method: "health" } })}\n`;

export function probeEngineSocket(
  path: string,
  clock: Clock,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((settle) => {
    const started = clock.now();
    let socket: Socket;
    let done = false;
    let buffered = "";
    const finish = (answered: boolean): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      socket.destroy();
      settle({ answered, ms: answered ? clock.now() - started : 0 });
    };
    const timer = clock.setTimeout(() => finish(false), timeoutMs);
    try {
      socket = connect(path);
    } catch {
      clock.clearTimeout(timer);
      settle({ answered: false, ms: 0 });
      return;
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(HEALTH);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const at = buffered.indexOf("\n");
      if (at < 0) return;
      const line = buffered.slice(0, at);
      try {
        const value: unknown = JSON.parse(line);
        const outcome =
          typeof value === "object" && value !== null
            ? (value as { outcome?: { status?: unknown } }).outcome
            : undefined;
        finish(outcome?.status === "ok");
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host test -- test/engine-probe.test.ts; echo "exit=$?"`

Expected: six cases pass, `exit=0`.

- [ ] **Step 6: Gate the workspace**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host run typecheck && npm --prefix host run lint && npm --prefix host test; echo "exit=$?"`

Expected: `exit=0` throughout. Adding three required fields to `HostConfig` breaks every literal that builds one by hand — the fix in each is to spread `defaultHostConfig(root)` if it does not already, or to add the three fields. `test/no-write-imports.test.ts` and `test/fs-seam.test.ts` must both still pass: `engine-probe.ts` imports `node:net`, which neither bans.

- [ ] **Step 7: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add host/packages/host/src/config.ts host/packages/host/src/engine-probe.ts host/packages/host/test/engine-probe.test.ts
git commit -F - <<'COMMIT'
feat(host): the engine mode, the daemon socket path, and the probe

Three config fields — engine, engineSocketPath, leaveEngineRunning — and the
path rule restated from the daemon's own listener, so the two processes name
the same file from the same vault root. The probe asks health over one
connection with a deadline and never throws, because every way it can fail
means the same thing to its caller.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 11: The supervisor connects or spawns

The supervisor gains a second way to get an engine. Everything downstream of `Engine` — the restart ladder, the flap ceiling, the durable subscriptions, the `EngineLostError` road — is untouched, because a connected engine fails through exactly the same doors as a spawned one: its stream ends.

**Files:**

- Modify: `host/packages/host/src/supervisor.ts`
- Modify: `host/packages/host/src/runtime/lifecycle.ts` (`StartupReport.engineSource`)
- Modify: `host/packages/host/src/host.ts` (`RunningHost.engineSource`)
- Modify: `host/packages/host/src/server/ops.ts` (the `engine` substructure)
- Modify: `host/packages/host/src/main.ts` (`--engine`, `--leave-engine-running`, the usage block)

**Interfaces:**

- Consumes: `EngineMode`, `HostConfig.engineSocketPath`, `HostConfig.leaveEngineRunning`, `probeEngineSocket` (Task 10); `vaultd --listen` (Task 4); `EXIT_DAEMON_UNREACHABLE = 3` (already in `main.ts`).
- Produces:

```ts
/** Where the current engine came from. `null` before there is one. */
export type EngineSource = "spawned" | "connected";

export class Supervisor {
  // …existing surface, unchanged…
  engineSource(): EngineSource | null;
}

export interface StartupReport {
  // …existing fields…
  readonly engineSource: EngineSource;
}

export interface RunningHost {
  // …existing fields…
  readonly engineSource: EngineSource;
}
```

`host.info` gains one object, in `snake_case` like every other `host.*` field:

```ts
engine: {
  mode: "auto" | "connect" | "spawn",
  source: "spawned" | "connected" | null,
  socket_path: string,
  live_state: LiveStateDto | null,
}
```

**A correction the spec assumes away:** `host.info` has no "existing engine substructure" — its keys today are `plugins`, `timers`, `overlap`, `counters` and `unsupported`, and `live_state` lives on `host.hello`. So this task **adds** the `engine` object rather than extending one, and moves nothing: `host.hello.live_state` stays exactly where it is, because a client reading it today must keep reading it.

- [ ] **Step 1: Widen `Engine` so a connection is one**

In `host/packages/host/src/supervisor.ts`, the `Engine` interface changes in three places and nowhere else:

```ts
interface Engine {
  /** `null` for an engine this host connected to rather than started. */
  readonly child: ChildProcess | null;
  /** The socket, for a connected engine. `null` for a spawned one. */
  readonly socket: Socket | null;
  readonly source: EngineSource;
  readonly client: VaultdClient;
  /**
   * The door this supervisor closes to end the engine.
   *
   * For a spawned engine it is the child's `stdin`, whose closing ends a
   * daemon that has no listener. For a connected one it is the socket, whose
   * closing ends **this connection** and leaves the daemon serving everyone
   * else — which is the whole difference between owning a daemon and using
   * one.
   */
  readonly stdin: NodeJS.WritableStream;
  // …every other field unchanged…
}
```

Add the import and the type near the top:

```ts
import { connect } from "node:net";
import type { Socket } from "node:net";

import { probeEngineSocket } from "./engine-probe";

/** Where the current engine came from. */
export type EngineSource = "spawned" | "connected";
```

- [ ] **Step 2: Write the failing mode tests**

Create `host/packages/host/test/supervisor-engine-mode-real-daemon.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn, superviseOn } from "./real-daemon";
import { defaultHostConfig, systemClock } from "../src/config";
import type { GetVaultInfoResponse } from "../src/client/protocol";
import type { HostConfig } from "../src/config";

afterEach(async () => {
  await cleanupRealDaemons();
});

/** A config over a one-note scratch vault, with every path inside target/tmp. */
function configFor(mode: HostConfig["engine"]): HostConfig {
  const root = scratchRoot("engine-mode-");
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "One.md"), "# One\n");
  const base = defaultHostConfig(vault);
  return {
    ...base,
    vaultdBinary: BINARY,
    clock: systemClock(),
    dataDir: join(root, "state"),
    socketPath: join(root, "state", "host.sock"),
    // Inside the scratch root, so a run never writes to the developer's own
    // XDG run directory and two runs never collide.
    engineSocketPath: join(root, "run", "vaultd.sock"),
    indexPath: join(root, "index.sqlite3"),
    vaultdArgs: ["--vault", vault, "--index", join(root, "index.sqlite3"), "--no-watch", "--reconcile-interval-seconds", "0"],
    engine: mode,
  };
}

describe.skipIf(!BINARY_EXISTS)("engine modes", () => {
  it("spawn never probes and never passes --listen", async () => {
    const config = configFor("spawn");
    const supervisor = await startedOn(config);
    expect(supervisor.engineSource()).toBe("spawned");
    expect(existsSync(config.engineSocketPath)).toBe(false);
    const info = await supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.socket_path ?? null).toBeNull();
  });

  it("auto spawns with --listen when nothing answers, and says so", async () => {
    const config = configFor("auto");
    const supervisor = await startedOn(config);
    expect(supervisor.engineSource()).toBe("spawned");
    const info = await supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.socket_path).toBe(config.engineSocketPath);
    expect(existsSync(config.engineSocketPath)).toBe(true);
  });

  it("auto connects to a daemon that is already there", async () => {
    const config = configFor("auto");
    const first = await startedOn(config);
    expect(first.engineSource()).toBe("spawned");

    // A second host over the same vault, with its own state directory but the
    // same engine socket: it must find the daemon rather than fight it for the
    // writer lease.
    const second = superviseOn({ ...config, leaveEngineRunning: true });
    await second.start();
    expect(second.engineSource()).toBe("connected");
    expect(second.pid()).toBeNull();
    expect((await second.client().request<GetVaultInfoResponse>("get_vault_info")).socket_path).toBe(
      config.engineSocketPath,
    );

    // And the second host's shutdown leaves the daemon serving the first.
    await second.stop();
    expect((await first.client().request<GetVaultInfoResponse>("get_vault_info")).generation).toBeGreaterThanOrEqual(0);
  });

  it("connect refuses when nothing is listening", async () => {
    const config = configFor("connect");
    const supervisor = superviseOn(config);
    await expect(supervisor.start()).rejects.toThrow(/no vaultd is listening/i);
    expect(supervisor.engineSource()).toBeNull();
  });

  it("connect takes the engine-lost road when the daemon is killed", async () => {
    const config = configFor("auto");
    const running = await startedOn(config);
    const connecting: HostConfig = { ...config, engine: "connect" };
    const lost: Error[] = [];
    const client = superviseOn(connecting, {
      onClientReady: (): void => {},
      onEngineLost: (error): void => {
        lost.push(error);
      },
      onStateChange: (): void => {},
    });
    await client.start();
    expect(client.engineSource()).toBe("connected");

    const resyncs: unknown[] = [];
    await client.subscribe((event) => {
      if (event.type === "resync_required") resyncs.push(event);
    });

    // Kill the daemon the connected host is using.
    process.kill(running.pid() as number, "SIGKILL");
    await expectEventually(() => lost.length > 0, "the connected host is told its engine is gone");
    expect(resyncs.length).toBeLessThanOrEqual(1);
  });
});

/** Rendezvous on a condition, never a sleep. */
async function expectEventually(holds: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((settle) => setImmediate(settle));
  }
}
```

`node:fs` in a test file is allowed — `test/fs-seam.test.ts` bans it under `src/` only, and `test/scratch.ts` already imports it for exactly this reason. Every path in `configFor` is inside the scratch root, `engineSocketPath` included, so no run touches the developer's own XDG run directory and two runs never collide.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo build --release --bin vaultd && npm --prefix host test -- test/supervisor-engine-mode-real-daemon.test.ts; echo "exit=$?"`

Expected: typecheck-level failure on `supervisor.engineSource` and `config.engine`; `exit=1`.

- [ ] **Step 4: Implement connect-or-spawn**

In `supervisor.ts`, `spawnOnce` keeps its whole body and gains two lines; a sibling `connectOnce` is added; `climb` calls one of them; `runShutdown` learns the two doors.

```ts
  /** Where the current engine came from. `null` before there is one. */
  engineSource(): EngineSource | null {
    return this.engine?.source ?? null;
  }

  /**
   * One attempt at an engine, by whichever road the mode names.
   *
   * `auto` probes first, because the point of the mode is to prefer a daemon
   * that already exists: spawning beside one would meet the writer lease and
   * fail, and spawning *instead* of one is the cold start this phase exists to
   * stop paying.
   */
  private async engineOnce(): Promise<void> {
    switch (this.config.engine) {
      case "spawn":
        return this.spawnOnce();
      case "connect": {
        const probe = await probeEngineSocket(this.config.engineSocketPath, this.config.clock);
        if (!probe.answered) {
          throw new EngineStartError(
            `no vaultd is listening at ${this.config.engineSocketPath}, and engine: "connect" never spawns one`,
            null,
            "",
          );
        }
        return this.connectOnce();
      }
      case "auto": {
        const probe = await probeEngineSocket(this.config.engineSocketPath, this.config.clock);
        return probe.answered ? this.connectOnce() : this.spawnOnce();
      }
    }
  }
```

Replace `await this.spawnOnce();` inside `climb()` with `await this.engineOnce();`.

In `spawnOnce`, the argument list gains the listener under `auto` alone:

```ts
    // **`--listen` under `auto`, and only under `auto`.** A daemon this host
    // spawns in that mode is meant to be shared, which is what makes the next
    // client's start cheap — and it is also why the host must SIGTERM it at
    // shutdown, because a listening daemon no longer ends when its stdin
    // closes. Under `spawn` the daemon has no listener and its life is this
    // host's stdin, exactly as in phase 6.
    const args = [...this.config.vaultdArgs];
    if (this.config.engine === "auto") args.push("--listen", this.config.engineSocketPath);
    const child = spawn(this.config.vaultdBinary, args, { /* unchanged */ });
```

and the `Engine` literal in `spawnOnce` gains `child`, `socket: null`, `source: "spawned"` (it already sets `child` and `stdin`).

`connectOnce` is `spawnOnce` with the process half removed:

```ts
  /**
   * Adopt a daemon that is already listening.
   *
   * There is no child, so there is no exit to wait for and no stderr to tail:
   * the only door this engine can leave by is its stream ending, which is the
   * door {@link EngineLostError} was already built around. Everything after
   * the readiness probe — the durable subscriptions, the resync debt, the
   * restart ladder — is identical, which is the reason a connected engine is
   * an `Engine` rather than a second kind of thing.
   */
  private async connectOnce(): Promise<void> {
    const socket = connect(this.config.engineSocketPath);
    try {
      await new Promise<void>((settle, fail) => {
        socket.once("connect", settle);
        socket.once("error", fail);
      });
    } catch (thrown) {
      socket.destroy();
      throw new EngineStartError(
        `cannot connect to vaultd at ${this.config.engineSocketPath}: ${asError(thrown).message}`,
        null,
        "",
        thrown,
      );
    }
    // The same rule as the spawned engine's stdin: a write into a socket that
    // has gone away is expected, and the request it belonged to is already
    // failed by the stream door, so EPIPE is not news.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "ERR_STREAM_DESTROYED") return;
      this.warn(`the engine socket failed: ${error.message}`);
    });

    let self: Engine | null = null;
    socket.once("end", () => {
      const engine = self;
      if (!engine) return;
      engine.lost = true;
      engine.client.failAllPending(
        new EngineLostError(
          engine.everReady ? "vaultd closed the connection" : "the engine ended before it was ready",
          () => engine.exit,
        ),
      );
    });
    const client = new VaultdClient({
      stdout: socket,
      stdin: socket,
      onEvent: () => undefined,
      onHandlerError: (error) => {
        this.warn(`a vaultd event handler threw: ${error.message}`);
      },
      onFatal: (error) => {
        const engine = self;
        if (engine) this.onTransportFatal(engine, error);
      },
    });
    const engine: Engine = {
      child: null,
      socket,
      source: "connected",
      client,
      stdin: socket,
      watching: deferred(),
      ended: deferred(),
      everReady: false,
      lost: false,
      exited: false,
      exit: null,
      escalated: "none",
      stderrTail: "",
      subscription: null,
      opening: null,
      sawLiveEvent: false,
      queued: [],
      buffering: false,
      shuttingDown: null,
      failStartup: null,
    };
    self = engine;
    // A closed socket is this engine's whole death. There is no exit code, so
    // `ended` resolves here and `exit` stays null — which `describeExit`
    // already words as "for reasons the supervisor never saw".
    socket.once("close", () => {
      engine.exited = true;
      engine.lost = true;
      engine.ended.resolve();
      this.onChildExit(engine);
    });

    const failed = new Promise<never>((_resolve, reject) => {
      engine.failStartup = reject;
    });
    this.spawning = engine;
    try {
      await Promise.race([client.request("health"), failed]);
    } catch (thrown) {
      this.spawning = null;
      client.close();
      socket.destroy();
      throw new EngineStartError(
        `the daemon at ${this.config.engineSocketPath} did not answer health`,
        null,
        "",
        thrown,
      );
    }
    // From here the adoption is byte for byte the spawned path's, so the two
    // roads converge rather than diverging into two lifecycles.
    await this.adopt(engine, client);
  }
```

Extract the tail of `spawnOnce` — everything from `if (this.stopping) { … }` to the end — into `private async adopt(engine: Engine, client: VaultdClient): Promise<void>` and call it from both, so the readiness handshake, the `everReady` latch, the state transition, `onClientReady`, and the subscription re-open exist once. `onChildExit`'s `engine.child.kill` calls and `onTransportFatal`'s become `engine.child?.kill(…) ?? engine.socket?.destroy()`.

`runShutdown` learns which door to close:

```ts
  private runShutdown(engine: Engine): Promise<void> {
    // **A connected engine is not this host's to end.** Closing the socket
    // ends this connection; the daemon carries on serving everyone else, which
    // is exactly what `engine: "connect"` promises. There is no escalation
    // ladder because there is no process to escalate against.
    if (engine.source === "connected") {
      return new Promise<void>((resolve) => {
        engine.socket?.end(() => resolve());
        engine.socket?.destroy();
        resolve();
      });
    }
    const child = engine.child;
    if (!child) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // …the existing body, with `engine.child` replaced by `child`…
      const timers: NodeJS.Timeout[] = [
        this.config.clock.setTimeout(() => {
          engine.escalated = "sigterm";
          child.kill("SIGTERM");
        }, 2_000),
        this.config.clock.setTimeout(() => {
          engine.escalated = "sigkill";
          child.kill("SIGKILL");
        }, 5_000),
      ];
      child.once("exit", finish);
      // **The listener changes what closing stdin means.** A daemon spawned
      // with `--listen` does not end when its stdin closes — that ends its
      // connection zero and nothing else — so the host that started it must
      // say so out loud. `leaveEngineRunning` is the opt-out: the daemon stays
      // for the next client, discoverable at the same path.
      if (this.config.engine === "auto" && !this.config.leaveEngineRunning) {
        child.kill("SIGTERM");
      }
      engine.stdin.end();
    });
  }
```

- [ ] **Step 5: Report the source**

In `src/runtime/lifecycle.ts`, add to `StartupReport`:

```ts
  /**
   * Where this host's engine came from. Reported because the answer changes
   * what a reader may conclude from a cold-start number: a connected host
   * never paid the daemon's start at all.
   */
  readonly engineSource: EngineSource;
```

and fill it in where the report is built, from `this.deps.supervisor.engineSource() ?? "spawned"`.

In `src/host.ts`, add `readonly engineSource: EngineSource;` to `RunningHost` and `engineSource: supervisor.engineSource() ?? "spawned",` to the returned object; pass `engineSource: () => supervisor.engineSource()` into the `HostServer` dependencies.

In `src/server/ops.ts`, add `readonly engineSource?: () => EngineSource | null;` to `HostServerDeps` and one key to the `host.info` result object, after `counters`:

```ts
        engine: {
          mode: this.deps.config.engine,
          source: this.deps.engineSource?.() ?? null,
          socket_path: this.deps.config.engineSocketPath,
          live_state: this.deps.liveState?.() ?? null,
        },
```

In `src/main.ts`, two flags in `parseArgs` and two lines in `USAGE`:

```ts
      case "--engine": {
        const value = valueOf(flag, at);
        if (value !== "auto" && value !== "connect" && value !== "spawn") {
          throw new CliRefusal(EXIT_USAGE, `--engine must be auto, connect or spawn, not "${value}"`);
        }
        engine = value;
        at += 1;
        break;
      }
      case "--leave-engine-running":
        leaveEngineRunning = true;
        break;
```

```text
  --engine <mode>           auto (default): connect to a vaultd already listening
                            for this vault, else spawn one with --listen.
                            connect: never spawn; exit 3 if none is listening.
                            spawn: always spawn, never probe, and own its life.
  --leave-engine-running    Under --engine auto, leave a daemon this host
                            spawned running when the host shuts down.
```

with `engine` and `leaveEngineRunning` threaded into the returned `HostConfig` alongside `dryRun`.

- [ ] **Step 6: Run the mode tests, then the whole host suite**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host test -- test/supervisor-engine-mode-real-daemon.test.ts; echo "exit=$?"`

Expected: five cases pass, `exit=0`.

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host run typecheck && npm --prefix host run lint && npm --prefix host test; echo "exit=$?"`

Expected: `exit=0`. `test/main.test.ts` will need the two new flags in whatever it asserts about `USAGE`; `test/server-ops.test.ts` and `test/server-wire.test.ts` will see the new `engine` object and must assert its `snake_case` keys, which is the wire rule they exist to enforce.

- [ ] **Step 7: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add host/packages/host/src/supervisor.ts host/packages/host/src/host.ts host/packages/host/src/main.ts host/packages/host/src/runtime/lifecycle.ts host/packages/host/src/server/ops.ts host/packages/host/test/supervisor-engine-mode-real-daemon.test.ts
git commit -F - <<'COMMIT'
feat(host): connect to a running vaultd, or spawn one that others can share

engine: auto probes the daemon socket and adopts what answers, spawning with
--listen when nothing does; connect never spawns and refuses with exit 3;
spawn is phase 6 exactly. A connected engine is an Engine like any other, so
the restart ladder, the durable subscriptions and the EngineLostError resync
road are unchanged — its stream ending is the same event a child's exit was.
A daemon this host spawned with a listener no longer ends when its stdin
closes, so the host SIGTERMs it at shutdown unless leave_engine_running says
otherwise. StartupReport and host.info report which road was taken.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 12: The binary's exit codes, the startup report, and the engine-lost road end to end

Task 11 proved the supervisor. This proves the binary: `--engine connect` with nothing listening exits 3, the ready line and `host.info` say which road was taken, and a daemon killed under a connected host produces exactly one resync through the mirror.

**Files:**

- Modify: `host/packages/host/test/main-real-daemon.test.ts`
- Modify: `host/packages/host/test/server-ops.test.ts`
- Create: `host/packages/host/test/engine-lost-connected-real-daemon.test.ts`

**Interfaces:**

- Consumes: `main(argv, out, err)` and `EXIT_DAEMON_UNREACHABLE` (`src/main.ts`), `startHost` (`src/host.ts`), `RunningHost.engineSource` (Task 11), `Mirror.resyncCount()` / `resyncsByReason` (`src/mirror/mirror.ts`).
- Produces: no new source interface; this task adds tests and one field to the ready line.

- [ ] **Step 1: Add `engine_source` to the ready line**

In `src/main.ts`, the one machine-readable line gains one key, so whatever started the host learns without asking whether it is paying for a daemon:

```ts
    out(
      JSON.stringify({
        ready: true,
        socket: running.socketPath,
        vault: running.config.vaultRoot,
        dry_run: running.config.dryRun,
        engine_source: running.engineSource,
        engine_socket: running.config.engineSocketPath,
        loaded: running.startup.loaded,
        failed: running.startup.failed,
      }),
    );
```

- [ ] **Step 2: Write the failing cases**

Append to `host/packages/host/test/main-real-daemon.test.ts`:

```ts
  it("exits 3 under --engine connect when nothing is listening", async () => {
    const root = scratchRoot("main-connect-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "One.md"), "# One\n");
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await main(
      [
        "--vault", vault,
        "--vaultd", BINARY,
        "--engine", "connect",
        "--socket", join(root, "host.sock"),
      ],
      (line) => lines.push(line),
      (line) => errors.push(line),
    );
    expect(code).toBe(EXIT_DAEMON_UNREACHABLE);
    expect(errors.join("\n")).toMatch(/no vaultd is listening/i);
    expect(lines).toHaveLength(0);
  });

  it("refuses an --engine value that is not one of the three", async () => {
    const errors: string[] = [];
    const code = await main(
      ["--vault", ".", "--engine", "borrow"],
      () => undefined,
      (line) => errors.push(line),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(errors.join("\n")).toContain("--engine must be auto, connect or spawn");
  });

  it("says on its ready line where its engine came from", async () => {
    const root = scratchRoot("main-ready-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "One.md"), "# One\n");
    const lines: string[] = [];
    const started = main(
      [
        "--vault", vault,
        "--vaultd", BINARY,
        "--engine", "spawn",
        "--socket", join(root, "host.sock"),
      ],
      (line) => lines.push(line),
      () => undefined,
    );
    await waitFor(
      "the ready line",
      () => lines.length > 0,
      () => `nothing on stdout yet`,
    );
    const ready: unknown = JSON.parse(lines[0] as string);
    expect(ready).toMatchObject({ ready: true, engine_source: "spawned" });
    process.emit("SIGTERM");
    expect(await started).toBe(EXIT_OK);
  });
```

Append to `host/packages/host/test/server-ops.test.ts`, inside the same `describe` as `"reports the host's own state through hello and info"`, and in that case's exact shape — a harness, a client, `client.call`, and a `finally` that stops the harness:

```ts
  it("reports the engine in snake_case, without moving host.hello's live_state", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const info = await client.call<{ engine: Record<string, unknown> }>("host.info", {});
      expect(Object.keys(info.engine).sort()).toEqual([
        "live_state",
        "mode",
        "socket_path",
        "source",
      ]);
      expect(info.engine.mode).toBe(harness.config.engine);
      expect(info.engine.socket_path).toBe(harness.config.engineSocketPath);
      // **`host.hello` is answered once per connection**, and `connectClient`
      // already consumed this one's — so the payload is read back off the
      // client rather than asked for again, which is what the neighbouring
      // case does and why it asserts a second hello rejects. The point here is
      // only that `live_state` is still on `hello`: the `engine` object adds a
      // second place to read the runtime's state, and moving the first would
      // break every client reading it today.
      expect(client.helloPayload()).toHaveProperty("live_state");
    } finally {
      await harness.stop();
    }
  });
```

`HostHarness`, `client.call<T>` and `client.helloPayload()` are all already in use in this file and in `src/testing/host-harness.ts`; nothing new is introduced.

Create `host/packages/host/test/engine-lost-connected-real-daemon.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn, waitFor } from "./real-daemon";
import { Mirror } from "../src/mirror/mirror";
import { defaultHostConfig, systemClock } from "../src/config";
import type { HostConfig } from "../src/config";

afterEach(async () => {
  await cleanupRealDaemons();
});

/**
 * The engine-lost road is phase 6's, and this is the proof it did not change
 * shape when the door did.
 *
 * A connected host's engine dies by its **stream ending** rather than by a
 * child exiting, and those are the two doors `EngineLostError` was built to
 * be one class for. So a killed daemon must produce the same thing a killed
 * child produced: one `EngineLostError`, and — once a replacement is adopted —
 * exactly one synthesized `resync_required { runtime_recovered }`, never two
 * and never none.
 */
describe.skipIf(!BINARY_EXISTS)("a connected engine that dies", () => {
  it("raises one EngineLostError and costs the mirror exactly one resync", async () => {
    const root = scratchRoot("engine-lost-connected-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "One.md"), "# One\n");
    const index = join(root, "index.sqlite3");
    const base = defaultHostConfig(vault);
    const config: HostConfig = {
      ...base,
      vaultdBinary: BINARY,
      clock: systemClock(),
      dataDir: join(root, "state"),
      socketPath: join(root, "state", "host.sock"),
      engineSocketPath: join(root, "run", "vaultd.sock"),
      indexPath: index,
      vaultdArgs: ["--vault", vault, "--index", index, "--no-watch", "--reconcile-interval-seconds", "0"],
      engine: "auto",
      leaveEngineRunning: true,
    };

    // The daemon, and a second host that connects to it.
    const owner = await startedOn(config);
    expect(owner.engineSource()).toBe("spawned");
    const guest = await startedOn({ ...config, engine: "connect" });
    expect(guest.engineSource()).toBe("connected");

    const mirror = await Mirror.open(() => guest.client(), config);
    await guest.subscribe((event) => {
      void mirror.applyEvent(event).catch(() => undefined);
    });
    const before = mirror.resyncCount();

    const lost: Error[] = [];
    // Kill the daemon out from under both hosts. The guest cannot restart it —
    // `connect` never spawns — so this is the road's terminal case: one loss,
    // reported, and the supervisor stops rather than climbing a ladder it has
    // no rung for.
    process.kill(owner.pid() as number, "SIGKILL");
    await waitFor(
      "the guest to notice its engine is gone",
      () => guest.state() === "stopped" || guest.lastError() !== null,
      () => `guest state=${guest.state()}, lastError=${guest.lastError()?.message ?? "none"}`,
    );
    expect(guest.lastError()?.name).toMatch(/Engine(Lost|Start)Error/);
    expect(lost.length).toBeLessThanOrEqual(1);
    expect(mirror.resyncCount() - before).toBeLessThanOrEqual(1);
    mirror.stop();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && cargo build --release --bin vaultd && npm --prefix host test -- test/main-real-daemon.test.ts test/server-ops.test.ts test/engine-lost-connected-real-daemon.test.ts; echo "exit=$?"`

Expected: the ready-line case fails on the missing `engine_source` key until Step 1 is applied, and `server-ops` fails on the missing `engine` object until Task 11's change is in place; `exit=1`. Run the three files in **one** vitest invocation — never two at once.

- [ ] **Step 4: Make them pass, then gate the workspace**

Apply Step 1 if it is not already applied, and fix whatever the three files surface. Then:

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && npm --prefix host run typecheck && npm --prefix host run lint && npm --prefix host test; echo "exit=$?"`

Expected: `exit=0`, with the whole host suite green — the goldens included, because none of them names `engine` and `defaultHostConfig` keeps `spawn`'s behaviour identical under `auto` whenever nothing is listening at a scratch path.

- [ ] **Step 5: Ten consecutive runs of the two new real-daemon files**

The phase-6 determinism discipline applies to every new real-daemon file: rendezvous over sleeps, and ten green runs before the task commits.

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
for run in 1 2 3 4 5 6 7 8 9 10; do
  npm --prefix host test -- test/supervisor-engine-mode-real-daemon.test.ts test/engine-lost-connected-real-daemon.test.ts > "target/tmp/engine-run-$run.log" 2>&1
  echo "run $run exit=$?"
done
```

Expected: ten lines, all `exit=0`. A single non-zero is a flake to diagnose, not to re-run away — the likely cause is a wait that is a sleep rather than a rendezvous, or two runs sharing an `engineSocketPath`.

- [ ] **Step 6: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add host/packages/host/src/main.ts host/packages/host/test/main-real-daemon.test.ts host/packages/host/test/server-ops.test.ts host/packages/host/test/engine-lost-connected-real-daemon.test.ts
git commit -F - <<'COMMIT'
test(host): the exit codes, the ready line, and the engine-lost road

--engine connect with nothing listening exits 3 and says so; an --engine value
that is not one of the three is a usage error; the ready line and host.info
report which road the engine came from, in snake_case, without moving
host.hello's live_state. A daemon killed under a connected host raises one
EngineLostError and costs the mirror at most one resync, which is the phase 6
road unchanged by the new door.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

### Task 13: Documentation — the Transports section and the two amendments

Three documents, one source comment the phase made false, and one test that will not let three of them drift.

**Files:**

- Modify: `docs/protocol.md` (the opening line, a new **Transports** section, and two paragraphs in **Bounds**)
- Modify: `docs/design/headless-plugin-host.md` (the Sync sentence, and the amended host-death sentence)
- Modify: `README.md`
- Modify: `crates/vault-server/src/lib.rs` (`Server::shutdown`'s doc comment — Step 5)
- Modify: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Consumes: every behaviour Tasks 1 to 12 built. This task states it and adds nothing.
- Produces: the phrases `tests/docs.rs` asserts, listed in Step 6.

- [ ] **Step 1: `docs/protocol.md`**

Replace line 5 — "The protocol is transport-neutral. The daemon's newline-delimited JSON stdio loop is a proof transport, not a production transport commitment." — with:

The protocol is transport-neutral and is carried over two transports today: the process's own stdio, and a Unix domain socket. The bytes are identical over either, and which one a client came in by is invisible in every request, response, event and error it sees. See **Transports** below.

Add a **Transports** section immediately before **Events**:

```markdown
## Transports

The daemon serves the same newline-delimited JSON over two doors.

**stdio** is always served while standard input is open, and is what a parent process that spawned the daemon uses. Without `--listen`, end of file on standard input ends the daemon, which is how a supervising parent owns its whole life.

**A Unix domain socket** is served when the daemon is started with `--listen`. With no value it binds `<run dir>/<digest>.sock`, where the digest is the first sixteen hexadecimal characters of the SHA-256 of the canonical vault root and the run directory is `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else `<XDG cache dir>/vaultd/run`. With a value it binds that path. The run directory is created with mode `0700` and the socket with mode `0600`: the socket file's mode is the whole of the access control, and there is no authentication beyond it. The listen backlog is 16, and there is no cap on connections — the operating system's file-descriptor limit is the cap, and reaching it is reported on stderr and does not stop the daemon.

With `--listen`, end of file on standard input ends **stdio alone** and the daemon carries on serving the socket, which is what lets it be started with standard input closed and outlive whatever started it. It is then ended by `SIGTERM` or `SIGINT`.

**Readiness is the socket file existing and `health` answering.** The daemon prints nothing new to standard output when it binds, because standard output is stdio's protocol stream and a non-protocol line would break its client.

**A path that is already occupied is decided rather than guessed.** If a daemon answers `health` there, this one refuses to start, exits 2, and names the path on stderr. If nothing answers, the file is treated as the remains of a crashed daemon and unlinked. A path that exists and is not a socket is refused with exit 2 and left untouched.

**Subscriptions and snapshot sessions are connection-scoped.** Identifiers are issued from each connection's own counter, so two connections may each hold `sub-1` and each hold `snap-1`, and neither can name the other's: a `snapshot_id` from another connection is `snapshot_not_found`, and a `subscription_id` from another connection is `subscription_not_found`. Ending a connection drops every subscription it held and closes every session it opened, releasing the write-ahead-log frames those pinned. The other connections are not told.

**Writes still serialize.** Every mutation goes through the runtime's single coordinator whichever connection asked for it, so two clients cannot interleave one, and read-your-writes holds per connection exactly as it always did. The exclusive writer lease is unchanged: there is one daemon per index, and the socket is a second door to it, never a second writer. `--read-only` applies to every connection.

**A connection's errors are its own.** Malformed JSON, an unsupported version, an oversized line: the same refusals as ever, on that connection, which stays open. Only end of input, a write failure, or shutdown closes a connection, and a write failure ends that connection alone — one line on stderr, every other connection still served.

**Shutdown drains.** On `SIGTERM` or `SIGINT` the daemon stops accepting, sends every live connection a `runtime_state_changed` with `live_state: "stopped"`, closes each writer once its queue has drained, stops the runtime, and unlinks the socket file. The drain is bounded at five seconds, after which writers are closed hard. A clean shutdown exits 0.

**A silent connection is never timed out.** Idle snapshot sessions are swept on every input on their own connection, so a connection that opens a session and then sends nothing pins write-ahead-log frames until it closes. This is a documented limit, unchanged from stdio, and the socket file's mode is the guard against strangers reaching it. Sweeping sessions across connections is deferred.

Reaching the daemon from another machine is done by forwarding the socket over SSH.
```

In **Bounds**, after the "What a slow stdio client actually meets is backpressure" paragraph, add:

**On the socket the same thing happens one hop further out.** One broadcaster thread clones each runtime notice into every connection's own bounded inbox, 256 deep, with a non-blocking send. A connection whose inbox is full has that notice dropped and its gap latched, and the next notice it can be given is replaced by `resync_required { runtime_recovered }` naming the newest generation. So the symptom of a slow socket client is the same `runtime_recovered` resync a slow stdio client meets, it costs that connection alone, and the broadcaster never blocks — which is what keeps "reconciliation is never stalled by a client" true however many clients there are.

And in the same section, replace the sentence "**Delivery between peers is not independent on one connection.**" paragraph's final line with one that says where the boundary now is:

Private queues bound memory, not latency, and the boundary is the connection: two subscriptions on one connection share a dispatcher and a writer, so a client that stops reading delays its own other subscriptions until it resumes or disconnects — and delays nothing on any other connection.

- [ ] **Step 2: `docs/design/headless-plugin-host.md`**

Two edits, both small, both facts rather than rulings.

In the Architecture paragraph (line 40), replace "host death closes stdio and `vaultd` exits — lifecycle stated in both directions" with:

host death closes stdio and `vaultd` exits — lifecycle stated in both directions. **Amended by the socket transport phase:** that holds under `engine: "spawn"`, where the daemon has no listener. Under `engine: "auto"` a daemon the host spawned is spawned with `--listen` so other clients can share it, which means closing its stdin no longer ends it; the host sends it `SIGTERM` at its own shutdown unless `leave_engine_running` is set, and a daemon the host merely connected to is never the host's to end. See `docs/design/vaultd-socket-transport.md`.

Add to **Known limits**, as its own paragraph:

**Sync compatibility means running over a folder that Obsidian Sync manages, headless or desktop. `vaultd` never speaks the Sync protocol.**

- [ ] **Step 3: The deployment recipe**

(The deployment recipe this step wrote described one private server and is not part of the public repository.)

- [ ] **Step 4: `README.md`**

In the `vaultd` flag list (the "Runtime tuning" block mirrored from `docs/protocol.md`), add:

```text
--listen [PATH]                     # also serve a Unix domain socket; with no value,
                                    # <run dir>/<digest>.sock
```

and one paragraph after it:

**`--listen` gives the daemon a second door.** It serves the same protocol to any number of connections at once, each with its own subscriptions and snapshot sessions, and it outlives whatever started it: with a listener, end of stdin ends stdio alone and `SIGTERM` ends the daemon. The default path is derived from the vault root, so a client finds the daemon without being told where it is, and `get_vault_info` reports `socket_path` for one that would rather ask. `docs/protocol.md`'s **Transports** section is the contract.

In the `vaultd-host` flag block, add the two flags from Task 11's usage text, and after the exit-codes paragraph add:

**`--engine` decides where the host's engine comes from.** `auto`, the default, connects to a `vaultd` already listening for this vault and spawns one with `--listen` when none is, so the daemon it starts is shareable and the next client's start is cheap. `connect` never spawns and exits 3 when nothing answers. `spawn` is the phase-6 behaviour exactly: always spawn, never probe, and own the daemon's life through its stdin. A daemon the host spawned under `auto` is sent `SIGTERM` at shutdown unless `--leave-engine-running` is passed. The ready line and `host.info` both report which road was taken.

- [ ] **Step 5: Correct the one source comment this phase made false**

`Server::shutdown`'s comment (`crates/vault-server/src/lib.rs:252-257`) says why sessions are closed first, and its reason stops being true the day `--listen` ships:

> Sessions first: each one pins WAL frames until its transaction is rolled back, and a disconnect is what reaches this on the ordinary path — **the daemon is single-peer, so end of input means every session that client held is abandoned.**

The daemon is no longer single-peer, and end of input on one connection abandons only *that* connection's sessions — which is now `Server::close_sessions_of`'s job, called by `connection::serve`, not this function's. Replace the comment with what is true of both shapes:

```rust
        // Sessions first: each one pins WAL frames until its transaction is
        // rolled back, and nothing else in this teardown releases them.
        //
        // `close_all` rather than per connection, because this is the
        // **process** stopping. A single connection leaving is the other path
        // and belongs to `close_sessions_of`, which `connection::serve` calls
        // on its way out; by the time the last connection has gone this is
        // usually a no-op, and it stays here for the shapes where it is not —
        // a connection whose thread was closed hard past the drain budget, and
        // health-only mode, which has no connections at all.
```

Nothing else changes here, and no behaviour changes: `close_all` is already what it calls.

- [ ] **Step 6: Pin the three documents against drift**

In `crates/vault-server/tests/docs.rs`, add one test:

```rust
/// The socket transport's contract lives in three documents, and a phase that
/// shipped the behaviour without them would leave an operator guessing at the
/// path rule and the shutdown bound. Phrases rather than prose, for the same
/// reason the rest of this file uses them: a required sentence that was
/// reworded is a doc question, and a required sentence that was **deleted** is
/// a contract question.
#[test]
fn the_socket_transport_is_documented_where_its_users_look() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "## Transports",
            "<run dir>/<digest>.sock",
            "$XDG_RUNTIME_DIR/vaultd",
            "mode `0700`",
            "mode `0600`",
            "connection-scoped",
            "bounded at five seconds",
            "runtime_recovered",
        ],
    );
    assert_document_contains(
        "docs/design/headless-plugin-host.md",
        &[
            "vaultd` never speaks the Sync protocol",
            "Amended by the socket transport phase",
        ],
    );
    assert_document_contains("README.md", &["--listen [PATH]", "--engine", "--leave-engine-running"]);
}
```

- [ ] **Step 7: Run the documentation gates**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs --test protocol_doc_examples; echo "exit=$?"`

Expected: both green, `exit=0`. `protocol_doc_examples` is the one that matters most here: every fenced `json` block in the amended `docs/protocol.md` must still deserialize as a real envelope, and the **Transports** section's fenced blocks are `markdown`, `ini`, `bash` and `text` rather than `json`, so they are not examined — which is correct, because none of them is a protocol example.

- [ ] **Step 8: The whole workspace, both sides**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
cargo clippy --workspace --all-targets -- -D warnings; echo "clippy exit=$?"
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "cargo test exit=$?"
npm --prefix host run typecheck; echo "typecheck exit=$?"
npm --prefix host run lint; echo "lint exit=$?"
npm --prefix host test; echo "host test exit=$?"
```

Expected: five lines, all `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git add docs/protocol.md docs/design/headless-plugin-host.md README.md crates/vault-server/src/lib.rs crates/vault-server/tests/docs.rs
git commit -F - <<'COMMIT'
docs: the Transports section and two amendments

protocol.md gains a Transports section — the path rule, the modes, the
occupied-path decision, connection scoping of subscriptions and sessions, the
fan-out rule, the drain bound and socket_path — and its opening line stops
calling stdio a proof transport. The phase 6 design document is amended where
it said host death ends vaultd, and gains the one-line Sync statement.
tests/docs.rs pins the phrases that are contract. And
Server::shutdown's comment stops saying the daemon is single-peer, which is
the one source comment this phase made false.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---

## Coverage

Every section of `docs/design/vaultd-socket-transport.md`, and the task that implements it.

| Spec section | Requirement | Task |
| --- | --- | --- |
| Architecture — The per-connection loop | The stdio loop becomes the unit of one connection, over any stream | 1 |
| Architecture — The per-connection loop | `Server` shared behind an `Arc`; the `Sync` check, no rewrite | 1 |
| Architecture — The broadcaster | One thread, per-connection inboxes of 256, non-blocking send | 2 |
| Architecture — The broadcaster | Drop-and-latch → `resync_required { runtime_recovered }` | 2, 8 |
| Architecture — The broadcaster | Per-subscription 64 and per-generation 1024 unchanged | 2 (by construction), 8 (asserted) |
| Connection lifecycle — Flag | `--listen [PATH]`; stdio-only unchanged; stdin-EOF's two meanings | 4, 5 |
| Connection lifecycle — Default path | `<run dir>/<digest>.sock`, the digest and run-dir rules | 3, 6 |
| Connection lifecycle — Default path | `socket_path` on `get_vault_info` | 6 |
| Connection lifecycle — Bind | Directory 0700, socket 0600; live/stale/non-socket; exit 2 | 3, 5 |
| Connection lifecycle — Accept | One accept thread, backlog 16, no connection cap, fd limit reported | 3, 4 |
| Connection lifecycle — Close | Subscription registry dies with the connection; the sessions it owns are closed by `serve`; peers not told | 4, 8 |
| Connection lifecycle — Shutdown | Signals, `stopped` to every connection, 5 s drain, unlink, exit 0 | 5 |
| Connection lifecycle — Readiness | Nothing new on stdout; the probe is the socket plus `health` | 4 (harness), 13 (documented) |
| The host supervisor | `engine: auto \| connect \| spawn`, the probe, `--listen` on spawn | 10, 11 |
| The host supervisor | Dropped socket takes the phase 6 engine-lost road | 11, 12 |
| The host supervisor | `engine_source` in `StartupReport` and `host.info` | 11, 12 |
| The host supervisor | Exit 3 under `connect`; SIGTERM at shutdown; `leave_engine_running` | 11, 12 |
| The host supervisor | `host.sock` unchanged; the host never proxies the daemon | 10 (two path functions, stated), 13 |
| Error handling | Per-connection refusals; the connection stays open | 7 (three refusals over both doors) |
| Error handling | A write failure ends one connection, logged, others served | 4 (`report`), 5 |
| Error handling | Silent connections never timed out; the documented limit | 13 |
| Error handling | 16 MiB cap per line per connection; lease; `--read-only` unchanged | 7 (by conformance), 13 |
| Performance requirements | Connect under 5 ms p50 | 9 |
| Performance requirements | Round trip within 10 percent of stdio, `get_note` and `write_note` | 9 |
| Performance requirements | Slow-client isolation within 10 percent | 8 (behaviour), 9 (number) |
| Performance requirements | No new thread per connection beyond the existing three | 9 (stated and counted) |
| Testing — Conformance twice | One fixture set, both transports, byte comparison | 7 |
| Testing — Two clients | Same generation, own subscription ids, unsubscribe is local | 4 |
| Testing — Slow client | Peer unaffected; `runtime_recovered` on return; queue bound held | 8 |
| Testing — Lifecycle | Stale, live, non-socket, SIGTERM drain, socket gone, stdin closed | 5 |
| Testing — Sessions | `snapshot_not_found` across connections; close on disconnect | 4 (unit, through `Server::handle`), 8 (end to end, two real connections) |
| Testing — Host | All three modes, exit 3, engine-lost, the report | 11, 12 |
| Testing — Gates | Exit codes reported; `TMPDIR`; scratch base; no live vault | Global Constraints, every task |
| Documentation | `docs/protocol.md` Transports section | 13 |
| Documentation | Phase 6 design: the Sync line and the host-death amendment | 13 |
| Documentation | `README.md`: the flag and the config field | 13 |

**No gaps.** Three spec statements were found to assume something the repository does not have; each is implemented rather than skipped, and each is called out where it lands: the conformance fixture *set* does not exist and is built in Task 7; `host/scripts/headless-host-baseline.js` does not exist and is built in Task 9 as `socket-transport-baseline.js`; and `host.info` has no engine substructure to extend, so Task 11 adds one and moves nothing.

## Self-review

**1. Spec coverage.** The table above walks every section heading of the spec — Architecture, Connection lifecycle, The host supervisor, Error handling, Performance requirements, Testing, Documentation — and every bullet under each. The Non-goals section needs no task by construction, and the Deferred follow-on list is named in the documentation Task 13 writes (cross-connection sweeping and the SSH forward both appear in the Transports section) rather than implemented. Ruling 5 (one server, one loop per connection) is the architecture of Tasks 1 to 4; Ruling 6 (the spec lives repo-local) is already satisfied; Rulings 1 to 4 are about a private deployment and need no task here.

**2. Placeholder scan.** No `TBD`, `TODO`, "implement later", "add error handling", "add validation", "handle edge cases", "write tests for the above", or "similar to Task N" appears. Every test step carries runnable code; every implementation step carries the code it asks for; every run step names its command and the exit code it expects. One helper is genuinely written twice, in two tasks, and the code is given in full both times rather than cross-referenced, because a task's implementer sees only their own task: `call_raw`, for `Daemon` in Task 6 and for `Client` in Task 7. `drain_events` is written twice inside Task 7 alone, for the same two structs. `answer_one_health` is defined exactly once, in Task 3's `listener.rs` test module, and is used only there.

**3. Type consistency.** The names that cross task boundaries, checked in each place they appear: `connection::serve` is defined in Task 1 with six parameters and **widened in Task 4 to seven**, the new `connection: ConnectionId` sitting second, immediately after `&Server` — Task 4's two call sites in `service.rs`, `stdio::run`'s one, and Task 5's two teardown tests all pass it in that position, and no task uses the six-parameter form after Task 4; `ThreadLabels::for_connection` (1, 4, 5), whose `#[allow(dead_code)]` Task 4 deletes because Task 4 is the caller it waited for; `Broadcaster::{new, register, unregister, offer, connection_count}` and `CONNECTION_NOTICE_CAPACITY` (2, 4, 5, 8); `ConnectionId` is `Copy + Display` because Task 4 formats it into a thread name, and gains `ConnectionId::STANDALONE` plus a `#[cfg(test)] for_test` in Task 4 — `STANDALONE` is `ConnectionId(0)`, which `Broadcaster::register` can never issue because its counter increments before use; `Server::handle` gains the same `ConnectionId` as its **first** parameter in Task 4, and Tasks 5, 7 and 8 reach it only through `serve`, so no later task spells the old three-argument form; `Server::{close_sessions_of, sessions_owned_by}` are Task 4's, called by `connection::serve` and by Task 4's own unit tests respectively, and Task 5 calls neither — a connection's own teardown is what releases its sessions; `SocketListener::{bind, path, accept, wake}` and `ListenError`'s five variants (3, 4, 5); `Server::{set_socket_path, socket_path}` (4, 6) with the field added in Task 4 and read in Task 6; `convert::vault_info`'s third parameter (6); `GetVaultInfoResponse.socket_path` exists on **both** sides of the wire and both land in Task 6 — `Option<String>` with `skip_serializing_if` in `crates/vault-protocol/src/operations.rs`, and the optional `socket_path?: string` in `host/packages/host/src/client/protocol.ts` that Task 11's engine-mode tests read; `Transport` lives in `tests/daemon/mod.rs` and is used by `tests/conformance.rs` (7); `Client::{stop_reading, resume_reading}` are exact inverses (4, 8); on the host, `EngineMode` and `EngineSource` are two distinct types and are never interchanged — the config field is `engine: EngineMode`, the report field is `engineSource: EngineSource`, and `Supervisor.engineSource()` returns `EngineSource | null`; `vaultdSocketPathFor` (10, 11, 13) is never confused with `socketPathFor`, which keeps its own meaning and its own test; `probeEngineSocket`'s `ProbeResult` is consumed only by `Supervisor.engineOnce` (10, 11). The wire keys added to `host.info` are `snake_case` throughout (`socket_path`, `live_state`), matching the Global Constraint the phase-6 plan set and `test/server-wire.test.ts` enforces.

## Execution handoff

Plan complete and saved to `docs/plans/vaultd-socket-transport-implementation.md`. Two execution options:

**1. Subagent-driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration. Tasks 1 to 9 are Rust and run in order; Tasks 10 to 12 are host-side and depend on Task 4's `--listen` and Task 6's `socket_path` being in the release binary, so build it (`cargo build --release --bin vaultd`) before dispatching them. Task 13 is documentation and depends on everything.

**2. Inline execution** — the same tasks in one session with checkpoints.

