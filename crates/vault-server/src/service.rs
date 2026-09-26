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
        return crate::stdio::run(server, notices).map_err(|message| ListenError::Bind {
            path: PathBuf::from("<stdio>"),
            source: std::io::Error::other(message),
        });
    };

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
