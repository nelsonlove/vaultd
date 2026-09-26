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
use std::time::Duration;

use crate::Server;
use crate::broadcast::{Broadcaster, ConnectionId, spawn_fanout};
use crate::connection::{self, ThreadLabels};
use crate::listener::{ListenError, SocketListener};
use crate::runtime::RuntimeNotice;

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

    /// Task 5 replaces this with the drained shutdown. For now: stop the
    /// runtime, close every connection's read half, and join what will join.
    fn stop(&self, listener: &Arc<SocketListener>) {
        self.stopping.store(true, Ordering::Release);
        listener.wake();
        self.server.shutdown();
        // Taken out of the mutex **before** anything is joined. A connection
        // thread calls `forget` on its way out, which takes this same lock, so
        // joining while holding it would deadlock against the very thread
        // being joined.
        let running: Vec<Running> = std::mem::take(&mut *self.lock());
        for running in running {
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

    /// The stdio-only daemon's failure reaches the operator unchanged. `main`
    /// prints `vaultd: {error}`, so this is the whole of what it says — no
    /// bind, and no `<stdio>` standing in for a path.
    #[test]
    fn a_stdio_only_failure_reads_exactly_as_it_always_did() {
        let failure = ListenError::Stdio("output failed: Broken pipe".into());
        assert_eq!(failure.to_string(), "output failed: Broken pipe");
    }
}
