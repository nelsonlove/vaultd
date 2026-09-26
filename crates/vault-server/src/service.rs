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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::Server;
use crate::broadcast::{Broadcaster, ConnectionId, spawn_fanout};
use crate::connection::{self, ThreadLabels};
use crate::listener::{ListenError, SocketListener};
use crate::runtime::RuntimeNotice;

/// How long every connection's writer is given to drain before it is closed
/// hard. Five seconds: long enough for a client that is merely busy, short
/// enough that a wedged one cannot hold a systemd stop open.
pub const DRAIN_BUDGET: Duration = Duration::from_secs(5);

/// How the accept loop paces itself.
///
/// A constant in the daemon and a value in the tests, because the give-up
/// rule is measured in *failures in a row*, and a test that had to live
/// through the real backoff to reach the real threshold would take minutes.
#[derive(Clone, Copy)]
struct AcceptPacing {
    /// How long one `accept` waits before the loop looks at its stopping
    /// flag again. This is the shutdown's worst-case latency when
    /// [`SocketListener::wake`] cannot reach the loop.
    poll: Duration,
    /// The pause after the first failed accept.
    first_backoff: Duration,
    /// The longest that pause is allowed to grow to.
    max_backoff: Duration,
    /// How many failures in a row mean the listener is dead rather than
    /// busy.
    give_up_after: u32,
}

impl AcceptPacing {
    /// Thirty-two failures in a row, paced by a doubling backoff capped at
    /// five seconds, is about two and a half minutes of a listener that has
    /// accepted nothing at all. A descriptor limit clears in far less than
    /// that when any client leaves; a descriptor gone bad never clears.
    const DEFAULT: Self = Self {
        poll: Duration::from_millis(200),
        first_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_secs(5),
        give_up_after: 32,
    };
}

/// The slice a pause is taken in, so a five-second backoff cannot add five
/// seconds to a shutdown.
const PAUSE_SLICE: Duration = Duration::from_millis(50);

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
    seams: Seams,
}

/// Two races a test cannot provoke honestly in its own process, made
/// reachable on purpose. **Both are inert in a running daemon**: `Service::new`
/// builds them off and the only code that turns either on is `#[cfg(test)]`.
///
/// They exist because the behaviour they guard is the behaviour that must not
/// regress. A `pthread_create` refused with `EAGAIN` cannot be produced
/// without exhausting every thread in the test process, and the window
/// between a connection thread starting and its record being filed is a few
/// microseconds wide — too narrow to hit deliberately, wide enough to have
/// leaked a descriptor per client in the review's instrumented run.
#[derive(Default)]
struct Seams {
    /// Make [`Service::spawn`] refuse, as the OS would under thread pressure.
    spawn_fails: AtomicBool,
    /// Widen the window between spawning a connection's thread and filing its
    /// record, so a test can prove the record is filed before the thread can
    /// look for it.
    delay_before_push_ms: AtomicU64,
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
    let Some(path) = options.listen else {
        // `ListenError::Stdio` and not `Bind`: nothing was bound, there is no
        // path, and this route promises the operator exactly the message the
        // stdio-only daemon has always printed.
        return crate::stdio::run(server, notices).map_err(ListenError::Stdio);
    };

    let listener = Arc::new(SocketListener::bind(&path)?);
    let service = Arc::new(Service::new(server));
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

    // A signal cannot be waited for on this thread, which is about to block
    // in `accept`, and it cannot do any of the stopping itself: a handler may
    // call nothing that locks or allocates. So it writes one byte, and this
    // thread turns that byte into a flag the accept loop is already reading.
    let watch = crate::signals::install().map_err(|error| ListenError::Bind {
        path: path.clone(),
        source: std::io::Error::other(error.to_string()),
    })?;
    let watcher = std::thread::Builder::new()
        .name("vaultd-signals".into())
        .spawn({
            let service = Arc::clone(&service);
            // **Weak, and not a clone.** The listener unlinks its socket when
            // the last strong reference to it goes, and this thread can still
            // be parked in `read` when the daemon is otherwise done. A strong
            // reference here would leave the socket file on disk for a daemon
            // that had already exited.
            let listener = Arc::downgrade(&listener);
            move || {
                watch.wait();
                service.stopping.store(true, Ordering::Release);
                // Only a nudge: the accept loop's own bounded wait is what
                // guarantees it notices the flag. See `SocketListener::wake`.
                if let Some(listener) = listener.upgrade() {
                    listener.wake();
                }
            }
        })
        .map_err(|source| ListenError::Bind {
            path: path.clone(),
            source,
        })?;

    accept_loop(
        &service,
        |timeout| listener.accept_within(timeout),
        AcceptPacing::DEFAULT,
    );

    service.stop(&listener);
    // The watcher is either already finished (a signal arrived) or parked in
    // `read`; either way the process is on its way out and the descriptor
    // goes with it, so the handle is dropped rather than joined.
    drop(watcher);
    if let Some(fanout) = fanout {
        let _ = fanout.join();
    }
    Ok(())
}

/// Accept until the service is stopping.
///
/// Two exits, and the second is the one that matters at shutdown: the flag is
/// read again on every return from `accept`, and `accept` always returns
/// within `pacing.poll` whether or not anything connected.
/// [`SocketListener::wake`] only makes that prompt — it cannot be relied on,
/// because it refuses to connect to a socket file that is no longer the one
/// this process bound.
///
/// **A failed accept is a pause, not a stop — until it stops being one.**
/// Running into the file-descriptor limit must not cost a daemon the
/// connections it already has, and that limit clears the moment a client
/// leaves. So each failure doubles the pause, up to `pacing.max_backoff`,
/// which also stops a listener that fails instantly from filling the log at
/// the speed of the CPU. But a pause that never ends is not a pause: after
/// `pacing.give_up_after` failures in a row the descriptor is treated as
/// gone, the loop says so once and stops accepting, and the daemon serves the
/// connections it has until a signal ends it.
///
/// `accept` is a closure rather than the listener so a test can hand it the
/// failure a real bad descriptor would give, without a listener to break.
fn accept_loop(
    service: &Arc<Service>,
    accept: impl Fn(Duration) -> std::io::Result<Option<std::os::unix::net::UnixStream>>,
    pacing: AcceptPacing,
) {
    let mut consecutive: u32 = 0;
    let mut backoff = pacing.first_backoff;
    while !service.stopping.load(Ordering::Acquire) {
        match accept(pacing.poll) {
            // Nobody yet. Round the loop and look at the flag again.
            Ok(None) => {}
            Ok(Some(stream)) => {
                consecutive = 0;
                backoff = pacing.first_backoff;
                if service.stopping.load(Ordering::Acquire) {
                    // The wake-up connection from `stop`, or a client that
                    // arrived a moment too late.
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    return;
                }
                service.start_socket(stream);
            }
            Err(error) => {
                consecutive += 1;
                eprintln!("vaultd: cannot accept a connection: {error}");
                if consecutive >= pacing.give_up_after {
                    eprintln!(
                        "vaultd: the listener has failed {consecutive} times in a row and is \
                         treated as dead: no new connection will be accepted, and the ones \
                         already open are served until vaultd is stopped"
                    );
                    park_until_stopping(service);
                    return;
                }
                pause_while_running(service, backoff);
                backoff = (backoff * 2).min(pacing.max_backoff);
            }
        }
    }
}

/// Sleep for `total`, but never past the moment the service is told to stop:
/// a backoff grown to five seconds must not add five seconds to a shutdown.
fn pause_while_running(service: &Service, total: Duration) {
    let deadline = std::time::Instant::now() + total;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || service.stopping.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(PAUSE_SLICE.min(left));
    }
}

/// Wait for the stop that is now the only way out. Reached when the listener
/// has been given up on: the daemon has no door for new clients, and the ones
/// it already has are served by their own threads until a signal arrives.
fn park_until_stopping(service: &Service) {
    while !service.stopping.load(Ordering::Acquire) {
        std::thread::sleep(PAUSE_SLICE);
    }
}

impl Service {
    fn new(server: Server) -> Self {
        Self {
            server: Arc::new(server),
            broadcaster: Arc::new(Broadcaster::new()),
            connections: std::sync::Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
            seams: Seams::default(),
        }
    }

    /// Start one connection thread, or say why not.
    ///
    /// Fallible on purpose. `pthread_create` refuses with `EAGAIN` under
    /// exactly the resource pressure the rest of this file is written to
    /// survive — the accept loop logs an `EMFILE` and carries on, and
    /// `connection::serve` returns `Err` for each of its own three spawns —
    /// so a `.expect` here would let one client arriving at the wrong moment
    /// unwind the accept loop and take every already-served connection with
    /// it. The daemon must lose the connection, not itself.
    fn spawn(
        &self,
        name: String,
        body: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<JoinHandle<()>> {
        if self.seams.spawn_fails.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "a test seam standing in for pthread_create refusing with EAGAIN",
            ));
        }
        std::thread::Builder::new().name(name).spawn(body)
    }

    /// Serve the process's own stdio as one connection.
    fn start_stdio(self: &Arc<Self>) {
        let service = Arc::clone(self);
        let (id, inbox) = self.broadcaster.register();
        // Held across the spawn and the push, for the reason `start_socket`
        // gives.
        let mut connections = self.lock();
        let thread = match self.spawn("vaultd-conn-stdio".into(), move || {
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
        }) {
            Ok(thread) => thread,
            Err(error) => {
                // No stdio connection, and a daemon that still has a
                // listener. Only a daemon given neither door is useless, and
                // this is not that.
                eprintln!("vaultd: cannot serve stdio: {error}");
                self.broadcaster.unregister(id);
                return;
            }
        };
        // **Connection zero keeps its record after it ends, where a socket
        // connection removes its own.** The asymmetry is deliberate: `stop`
        // has no other handle on this thread and cannot interrupt it — stdin
        // has no read half to shut down — so the record is the only way to
        // join it. A socket connection can always be found again through its
        // stream, so it is free to file itself away.
        connections.push(Running {
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
        // **Taken before the spawn and held across the push.** The thread
        // ends with `forget(id)`, which wants this same lock; a connection
        // that finishes before its record is filed would otherwise find
        // nothing to remove, and the `push` after it would leave a record no
        // one ever removes — holding the accepted descriptor and a
        // `JoinHandle` for the life of the daemon. Holding the lock makes
        // `forget` wait for the record instead of missing it. No deadlock:
        // the spawner never waits on the thread.
        let mut connections = self.lock();
        let thread = match self.spawn(format!("vaultd-conn-{label}"), move || {
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
        }) {
            Ok(thread) => thread,
            Err(error) => {
                // One client lost, and the daemon keeps every other one.
                eprintln!("vaultd: cannot serve a connection: {error}");
                self.broadcaster.unregister(id);
                let _ = stream.shutdown(std::net::Shutdown::Both);
                return;
            }
        };
        self.pause_before_push();
        connections.push(Running {
            id,
            thread,
            stream: Some(stream),
        });
    }

    /// The widened window, for the test that proves the record is filed
    /// before the connection's own thread can look for it. Zero in a running
    /// daemon, so this is a load and a branch.
    fn pause_before_push(&self) {
        let pause = self.seams.delay_before_push_ms.load(Ordering::Acquire);
        if pause > 0 {
            std::thread::sleep(Duration::from_millis(pause));
        }
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
        // Closed straight after the offer, and this is what makes the notice
        // above land rather than race. Dropping every inbox sender leaves the
        // buffered notice still deliverable — an `mpsc` receiver hands over
        // what it holds before it reports the disconnection — so each
        // connection's forwarder delivers the `stopped` notice and then ends,
        // which is precisely the end of notices the dispatcher's settle is
        // waiting for. Without it the dispatcher would wait out its whole
        // settle on every connection, and every forwarder would still be
        // parked in `recv` on an inbox nobody was going to close.
        self.broadcaster.close();

        // Taken out of the mutex **before** anything is joined. A connection
        // thread calls `forget` on its way out, which takes this same lock, so
        // joining while holding it would deadlock against the very thread
        // being joined.
        let running: Vec<Running> = std::mem::take(&mut *self.lock());
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
        let deadline = Instant::now() + DRAIN_BUDGET;
        let mut parked = Vec::new();
        for connection in running {
            // A connection with no stream is connection zero, whose reader is
            // parked in `read(0)` on the process's own stdin — nothing inside
            // this process can interrupt it, so its thread cannot finish
            // while stdin is open. It is therefore joined only if it has
            // already finished, which is the case where stdin ended first.
            // Waiting the budget out on it would spend all five seconds on
            // the one connection that can never use them.
            let finished = if connection.stream.is_some() {
                wait_until(&connection.thread, deadline)
            } else {
                connection.thread.is_finished()
            };
            if finished {
                let _ = connection.thread.join();
            } else {
                parked.push(connection);
            }
        }
        // A second deadline, and not a bare join: closing the socket fails
        // the writer's next write and ends the thread, but a thread wedged
        // anywhere else would otherwise hold the exit open for ever.
        let hard = Instant::now() + DRAIN_BUDGET;
        for connection in parked {
            match connection.stream.as_ref() {
                // Past the budget the writer is closed hard, which fails its
                // next write and ends the thread.
                Some(stream) => {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    if wait_until(&connection.thread, hard) {
                        let _ = connection.thread.join();
                    }
                }
                // Connection zero. Nothing it holds outlives the process, and
                // its writer has already had the whole budget.
                None => drop(connection.thread),
            }
        }

        self.server.shutdown();
    }
}

/// Wait for `thread` to finish, but never past `deadline`. Polling rather
/// than a timed join because `JoinHandle` has none, and 5 ms is far below the
/// budget it is measuring.
fn wait_until(thread: &JoinHandle<()>, deadline: Instant) -> bool {
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    true
}

/// One line on stderr per connection that ended badly, and silence for one
/// that ended cleanly. A write failure is that connection's, not the daemon's.
fn report(outcome: Result<(), String>, label: &str) {
    if let Err(message) = outcome {
        eprintln!("vaultd: connection {label} ended: {message}");
    }
}

/// The two failure paths a running daemon must survive and no integration
/// test can provoke: a thread the OS refuses to start, and a connection that
/// ends before the service has finished filing it. Both are driven through
/// [`Seams`], against a health-only server and a `UnixStream::pair`, so
/// neither needs a vault, a listener, or a second process.
#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    use super::*;

    /// Generous: a bound that turns a hang into a failure, asserting nothing
    /// about timing.
    const PATIENCE: Duration = Duration::from_secs(20);

    fn service() -> Arc<Service> {
        Arc::new(Service::new(Server::health_only()))
    }

    /// Wait for every connection record to be gone, or say what was left.
    fn await_no_records(service: &Arc<Service>) {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if service.lock().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "a finished connection left {} record(s) behind; nothing removes \
             them afterwards, so the daemon holds its descriptor and its \
             JoinHandle for the life of the process",
            service.lock().len()
        );
    }

    /// `pthread_create` refuses with `EAGAIN` under the same pressure the
    /// accept loop is written to survive. The connection is lost; the daemon
    /// is not, and it leaves nothing behind — no record, no registered inbox,
    /// and no half-open stream the client would wait on forever.
    #[test]
    fn a_connection_whose_thread_cannot_start_costs_only_that_connection() {
        let service = service();
        service.seams.spawn_fails.store(true, Ordering::Release);
        let (mut client, accepted) = UnixStream::pair().expect("a socket pair");

        service.start_socket(accepted);

        assert!(
            service.lock().is_empty(),
            "a connection that never started must leave no record"
        );
        assert_eq!(
            service.broadcaster.connection_count(),
            0,
            "and no inbox the fan-out would keep offering to"
        );
        let mut byte = [0u8; 1];
        assert_eq!(
            client.read(&mut byte).expect("read the peer's end"),
            0,
            "the client must see the connection closed rather than hang on a \
             daemon that is never going to answer"
        );
    }

    /// The same for connection zero: stdio is one door of two, and losing it
    /// is not losing the daemon.
    #[test]
    fn a_stdio_connection_that_cannot_start_leaves_the_listener_serving() {
        let service = service();
        service.seams.spawn_fails.store(true, Ordering::Release);

        service.start_stdio();

        assert!(
            service.lock().is_empty(),
            "no record for a thread that is not there"
        );
        assert_eq!(
            service.broadcaster.connection_count(),
            0,
            "and no inbox either"
        );
    }

    /// A connection can end before the service has finished filing it — the
    /// window is microseconds wide and a peer that connects and closes at
    /// once walks straight into it. The record must still be removed: the
    /// thread's `forget` has to find it, which is why the connections lock is
    /// held from before the spawn until after the push.
    ///
    /// The seam widens the window to 300 ms so the ordering is the test's and
    /// not the scheduler's. Without the lock held, `forget` runs inside that
    /// window, finds nothing, and the `push` afterwards leaves a record and
    /// an open descriptor nothing will ever remove.
    #[test]
    fn a_connection_that_ends_before_its_record_is_filed_still_leaves_no_record() {
        let service = service();
        service
            .seams
            .delay_before_push_ms
            .store(300, Ordering::Release);
        let (client, accepted) = UnixStream::pair().expect("a socket pair");
        // The peer is gone before the connection's own thread reads a byte.
        drop(client);

        service.start_socket(accepted);

        await_no_records(&service);
        let deadline = Instant::now() + PATIENCE;
        while service.broadcaster.connection_count() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            service.broadcaster.connection_count(),
            0,
            "the connection unregistered its own inbox on the way out"
        );
    }

    /// The pacing a test uses: the same rule, in milliseconds instead of
    /// seconds, so the give-up threshold is reached in the time a test may
    /// take rather than the two and a half minutes the daemon's own pacing
    /// spends proving a listener is dead rather than busy.
    const BRISK: AcceptPacing = AcceptPacing {
        poll: Duration::from_millis(1),
        first_backoff: Duration::from_millis(1),
        max_backoff: Duration::from_millis(4),
        give_up_after: 5,
    };

    /// Run the accept loop on its own thread with `accept`, and hand back the
    /// handle and the number of times `accept` has been called.
    fn accept_loop_on_a_thread(
        service: &Arc<Service>,
        accept: impl Fn(Duration) -> std::io::Result<Option<UnixStream>> + Send + 'static,
    ) -> (JoinHandle<()>, Arc<AtomicU64>) {
        let attempts = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&attempts);
        let service = Arc::clone(service);
        let thread = std::thread::Builder::new()
            .name("accept-loop-under-test".into())
            .spawn(move || {
                accept_loop(
                    &service,
                    move |timeout| {
                        counted.fetch_add(1, Ordering::Release);
                        accept(timeout)
                    },
                    BRISK,
                );
            })
            .expect("start the accept loop");
        (thread, attempts)
    }

    fn await_at_least(attempts: &Arc<AtomicU64>, wanted: u64) {
        let deadline = Instant::now() + PATIENCE;
        while attempts.load(Ordering::Acquire) < wanted {
            assert!(
                Instant::now() < deadline,
                "the accept loop made only {} attempts in {PATIENCE:?}",
                attempts.load(Ordering::Acquire)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn await_stopped(service: &Arc<Service>, thread: JoinHandle<()>) {
        service.stopping.store(true, Ordering::Release);
        let deadline = Instant::now() + PATIENCE;
        while !thread.is_finished() {
            assert!(
                Instant::now() < deadline,
                "the accept loop did not return within {PATIENCE:?} of being told to stop"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        thread.join().expect("the accept loop panicked");
    }

    /// An accept error that never clears is a listener whose descriptor has
    /// gone bad, and retrying it forever is a log line every few
    /// milliseconds for the life of the process. Past the threshold the loop
    /// gives up on the door and **keeps the house**: it stops calling
    /// `accept` at all, and it does not return, because the connections
    /// already open are still being served and only a signal ends them.
    #[test]
    fn a_listener_that_never_recovers_is_given_up_on_rather_than_retried_forever() {
        let service = service();
        let (thread, attempts) = accept_loop_on_a_thread(&service, |_| {
            Err(std::io::Error::from_raw_os_error(libc::EBADF))
        });

        await_at_least(&attempts, u64::from(BRISK.give_up_after));
        // Nothing clears, so nothing it tries after this can succeed.
        std::thread::sleep(Duration::from_millis(100));
        let settled = attempts.load(Ordering::Acquire);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            attempts.load(Ordering::Acquire),
            settled,
            "past the give-up threshold the loop must stop calling accept, \
             not merely slow down"
        );
        assert!(
            !thread.is_finished(),
            "and it must not return: the daemon goes on serving the \
             connections it already has until a signal stops it"
        );

        await_stopped(&service, thread);
    }

    /// Failures in a row are **paced**, and the pace doubles.
    ///
    /// Without it, an accept that fails the moment it is called fills the log
    /// at the speed of the CPU for as long as the give-up rule allows — the
    /// line every 50 ms that Task 4's review measured, only faster. The bound
    /// is one-sided by construction: a doubling backoff cannot take *less*
    /// than the sum of its pauses, and a slow machine can only make it longer,
    /// so this can fail for one reason alone.
    #[test]
    fn failures_in_a_row_are_paced_by_a_doubling_backoff() {
        // 20 + 40 + 80 + 80 ms of pauses before the fifth attempt, against
        // the 80 ms a backoff that never grew would spend.
        const MEASURABLE: AcceptPacing = AcceptPacing {
            poll: Duration::from_millis(1),
            first_backoff: Duration::from_millis(20),
            max_backoff: Duration::from_millis(80),
            give_up_after: 5,
        };
        let service = service();
        let attempts = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&attempts);
        let started = Instant::now();
        let loop_service = Arc::clone(&service);
        let thread = std::thread::Builder::new()
            .name("accept-backoff-under-test".into())
            .spawn(move || {
                accept_loop(
                    &loop_service,
                    move |_| {
                        counted.fetch_add(1, Ordering::Release);
                        Err::<Option<UnixStream>, _>(std::io::Error::from_raw_os_error(libc::EBADF))
                    },
                    MEASURABLE,
                );
            })
            .expect("start the accept loop");

        await_at_least(&attempts, u64::from(MEASURABLE.give_up_after));
        let spent = started.elapsed();
        assert!(
            spent >= Duration::from_millis(150),
            "five failures in a row took only {spent:?}: the backoff is not \
             growing, so a listener that fails instantly is logged at the \
             speed of the CPU"
        );

        await_stopped(&service, thread);
    }

    /// The other half of the same rule. A descriptor limit clears the moment
    /// any client leaves, so a burst of failures must cost a pause and
    /// nothing else — the listener is still the daemon's door afterwards.
    #[test]
    fn an_accept_error_that_clears_costs_a_pause_and_not_the_listener() {
        let service = service();
        // One fewer failure than the threshold, then a listener that works
        // again — which here means "nobody is connecting", the ordinary
        // answer from a bounded accept.
        let left = std::sync::Mutex::new(BRISK.give_up_after - 1);
        let (thread, attempts) = accept_loop_on_a_thread(&service, move |_| {
            let mut left = left.lock().unwrap_or_else(|error| error.into_inner());
            if *left == 0 {
                return Ok(None);
            }
            *left -= 1;
            Err(std::io::Error::from_raw_os_error(libc::EMFILE))
        });

        await_at_least(&attempts, u64::from(BRISK.give_up_after) + 20);
        assert!(
            !thread.is_finished(),
            "a cleared error leaves the loop accepting"
        );
        let after = attempts.load(Ordering::Acquire);
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            attempts.load(Ordering::Acquire) > after,
            "and the consecutive count was reset by the recovery, so the \
             threshold is never reached by failures that are not in a row"
        );

        await_stopped(&service, thread);
    }

    /// The stdio-only daemon's failure reaches the operator unchanged. `main`
    /// prints `vaultd: {error}`, so this is the whole of what it says — no
    /// bind, and no `<stdio>` standing in for a path.
    #[test]
    fn a_stdio_only_failure_reads_exactly_as_it_always_did() {
        let failure = ListenError::Stdio("output failed: Broken pipe".into());
        assert_eq!(failure.to_string(), "output failed: Broken pipe");
    }
}
