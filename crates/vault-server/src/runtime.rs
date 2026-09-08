//! The live runtime: one coordinator thread owns every mutation.
//!
//! [`IndexService`] is `Send` but not `Sync` — it holds the writer's SQLite
//! connection, the exclusive writer lease, and the write half of the
//! publication barrier. So exactly one thread may ever hold it, and this
//! module is that thread. Everything else in the process talks to the cache
//! through [`IndexReader`] (`Send + Sync`), which answers from whatever the
//! coordinator has last published.
//!
//! Three threads at most, all named and all joined on shutdown:
//!
//! * the **coordinator**, which owns the `IndexService` and is the only
//!   caller of `refresh`, `refresh_paths`, `resync_published`, and the
//!   observational state setters;
//! * the **watch forwarder**, which owns the [`WatchStream`] and turns its
//!   hints into [`RuntimeCommand::Hint`]s. It never touches index state;
//! * the **reconcile timer**, which queues a periodic refresh. It never
//!   touches index state either, and is not spawned at all when no interval
//!   is configured.
//!
//! Every queue between them is bounded. The command mailbox is one
//! `sync_channel` of [`RuntimeOptions::command_capacity`]; when it saturates,
//! the producer sets an atomic overflow latch instead of blocking, and the
//! coordinator turns the next thing it does into a full reconciliation. The
//! notice sink is likewise bounded and owned by the caller: a notice that
//! cannot be delivered is dropped and the gap is announced later as a
//! [`RuntimeNotice::ResyncRequired`], never silently swallowed and never
//! allowed to stall indexing.
//!
//! Nothing here names `LiveGraph` or hydrates one. Live-state installation
//! is `vault-index`'s business; the coordinator only asks for it — by
//! calling `refresh`/`refresh_paths`, or `resync_published` when a foreign
//! writer moved the cache underneath this process.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use vault_core::VaultPath;
use vault_index::{
    ChangeCause, FileSystemIndexSource, Generation, IndexConfig, IndexError, IndexReader,
    IndexService, LinkRewriteFailure, LiveRefreshReport, LiveState, Mutation, MutationOutcome,
    ReconcileSource, RefreshReport,
};
use vault_watch::{ChangeHint, WatchStream};

use crate::ServerStartupError;

/// How long the coordinator blocks when it has nothing pending. Only bounds
/// how quickly a `running` flip is noticed; every real wake-up is an
/// arriving command.
const IDLE_POLL: Duration = Duration::from_millis(100);

/// How long the forwarder blocks on the watch stream per iteration. Bounds
/// how long `shutdown` waits for that thread, and is what turns a
/// `WatchStream` (which cannot be interrupted) into a joinable thread.
const WATCH_POLL: Duration = Duration::from_millis(50);

/// Backoff between attempts after `IndexError::Busy`. Lock contention, not
/// damage: another connection holds the write lock and will release it.
const BUSY_BACKOFF: Duration = Duration::from_millis(20);

/// How many times one mutation is attempted before the coordinator gives up
/// on it and falls back (re-hinting the batch, or recording the failure).
const MAX_MUTATION_ATTEMPTS: usize = 3;

/// How many times a dirty batch may be re-hinted for
/// `VaultChangedDuringRefresh` before the coordinator stops trying to be
/// incremental about it and reconciles the whole vault. Bounds what would
/// otherwise be an unbounded retry loop against a file being rewritten
/// continuously.
const MAX_CONSECUTIVE_REHINTS: usize = 5;

/// The ceiling on the backoff between retries of a failed escalation. Long
/// enough that a persistently broken vault costs nothing to keep trying,
/// short enough that recovery is noticed promptly.
const MAX_ESCALATION_BACKOFF: Duration = Duration::from_secs(30);

/// A test-only rendezvous callback. Production never installs one.
#[doc(hidden)]
pub type RuntimeHook = Arc<dyn Fn() + Send + Sync>;

/// How the runtime keeps the cache up to date.
#[derive(Clone, Debug)]
pub struct RuntimeOptions {
    pub watch: bool,
    pub watch_config: vault_watch::WatchConfig,
    pub reconcile_interval: Option<std::time::Duration>,
    pub command_capacity: usize,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            watch: true,
            watch_config: vault_watch::WatchConfig::default(),
            reconcile_interval: Some(std::time::Duration::from_secs(60)),
            command_capacity: 256,
        }
    }
}

/// One unit of work for the coordinator. Everything that mutates the cache
/// arrives as one of these, through one bounded mailbox, so mailbox order is
/// mutation order.
pub enum RuntimeCommand {
    Hint(vault_watch::ChangeHint),
    Refresh {
        verify: bool,
        reply: std::sync::mpsc::SyncSender<Result<RefreshReport, IndexError>>,
    },
    /// One write into the vault. Boxed because a `Mutation` carries a whole
    /// note's content, and this enum sits in a bounded queue sized by its
    /// largest variant.
    Mutate {
        mutation: Box<Mutation>,
        reply: std::sync::mpsc::SyncSender<Result<MutationReport, MutationFailure>>,
    },
    Stop,
}

impl std::fmt::Debug for RuntimeCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Hint(hint) => formatter.debug_tuple("Hint").field(hint).finish(),
            Self::Refresh { verify, .. } => formatter
                .debug_struct("Refresh")
                .field("verify", verify)
                .finish_non_exhaustive(),
            Self::Mutate { mutation, .. } => formatter
                .debug_struct("Mutate")
                .field("mutation", mutation)
                .finish_non_exhaustive(),
            Self::Stop => formatter.write_str("Stop"),
        }
    }
}

/// What the runtime tells an observer. Deliberately not protocol DTOs: the
/// subscription layer converts these, and nothing here knows the wire
/// format.
#[derive(Clone, Debug)]
pub enum RuntimeNotice {
    /// One targeted reconciliation cycle published a new generation, with
    /// the exact per-path change set it published.
    ///
    /// Boxed: a `LiveRefreshReport` carries its full metrics and dwarfs
    /// every other variant, and this enum sits in a bounded queue whose
    /// buffer is sized by the largest variant.
    Generation(Box<LiveRefreshReport>),
    /// The runtime's observational status changed.
    State {
        generation: Option<Generation>,
        state: LiveState,
        error: Option<String>,
    },
    /// The generation moved in a way no per-path change set describes. An
    /// incremental observer must re-read rather than apply a delta.
    ResyncRequired {
        generation: Option<Generation>,
        reason: ResyncReason,
    },
}

/// How specific a resync reason is, for merging two outstanding escalations.
/// A named cause outranks the generic one, and a vault whose root moved
/// outranks lost events.
fn resync_severity(reason: ResyncReason) -> u8 {
    match reason {
        ResyncReason::RuntimeRecovered => 0,
        ResyncReason::WatcherOverflow => 1,
        ResyncReason::RootInvalidated => 2,
    }
}

/// Why per-path detail is unavailable for a generation move.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResyncReason {
    /// The watcher lost events (kernel overflow, storming, or a structural
    /// change it could not name).
    WatcherOverflow,
    /// The vault root itself was removed or renamed.
    RootInvalidated,
    /// The runtime advanced the generation through a path that produces no
    /// per-path change set: the startup catch-up, a periodic tick, a manual
    /// refresh, a watcher-failure recovery, or a dropped notice.
    RuntimeRecovered,
}

/// Test-only injection points. Production code constructs
/// [`RuntimeTestHooks::default`] and pays one `Option` check per mutation.
#[doc(hidden)]
#[derive(Clone, Default)]
pub struct RuntimeTestHooks {
    /// Runs once, inside the startup catch-up's mutation window, before the
    /// refresh itself. Lets a test hold catch-up open and prove what reads
    /// answer meanwhile.
    pub before_catch_up: Option<RuntimeHook>,
    /// Runs immediately before every call into the `IndexService`.
    pub mutation_enter: Option<RuntimeHook>,
    /// Runs immediately after every call into the `IndexService`.
    pub mutation_exit: Option<RuntimeHook>,
    /// Fail watcher installation as though the backend refused, without
    /// having to break a real directory.
    pub fail_watch_install: bool,
    /// Make the coordinator's own generation query report "nothing
    /// committed", as a transient `Busy` or storage failure on that query
    /// does. There is no other way to reach the paths that must cope with an
    /// unknown generation — the query does not run through `mutation`, so
    /// `mutation_fault` cannot touch it, and a real transient failure cannot
    /// be provoked on demand.
    pub blind_generation_query: bool,
    /// Consulted before every call into the `IndexService`, with that call's
    /// zero-based sequence number. Returning `Some(error)` makes the call
    /// fail without running, which is the only way to exercise the error
    /// routing for faults a test cannot provoke on a real filesystem —
    /// SQLite lock contention, a foreign writer moving the cache, a vault
    /// that changes mid-refresh.
    pub mutation_fault: Option<Arc<dyn Fn(usize) -> Option<IndexError> + Send + Sync>>,
}

/// The runtime's entry point. Not a value: `start` hands back a
/// [`RuntimeHandle`], and the runtime itself lives in its threads.
pub struct Runtime;

impl Runtime {
    /// Open the leased writer and its reader, publish `CatchingUp`, install
    /// the watcher, and move the writer onto the coordinator thread.
    ///
    /// Returns as soon as those are established — before catch-up has run —
    /// so the caller can serve reads from the last committed generation
    /// immediately.
    pub fn start(
        config: IndexConfig,
        options: RuntimeOptions,
        notices: SyncSender<RuntimeNotice>,
    ) -> Result<RuntimeHandle, ServerStartupError> {
        Self::start_with_hooks(config, options, notices, RuntimeTestHooks::default())
    }

    #[doc(hidden)]
    pub fn start_with_hooks(
        config: IndexConfig,
        options: RuntimeOptions,
        notices: SyncSender<RuntimeNotice>,
        hooks: RuntimeTestHooks,
    ) -> Result<RuntimeHandle, ServerStartupError> {
        let mut index = IndexService::open(config.clone())?;
        // Before anything else: readers answer from the last committed
        // generation, and say so. A caller that reads the instant `start`
        // returns must never see `Starting`.
        index.set_live_state(LiveState::CatchingUp)?;
        let reader = Arc::new(index.reader()?);
        let source = FileSystemIndexSource::new(&config.canonical_vault_root)?;

        let capacity = options.command_capacity.max(1);
        let (commands, mailbox) = sync_channel(capacity);
        let overflow = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        let mut threads: Vec<JoinHandle<()>> = Vec::new();

        // The watcher is installed *before* catch-up so that a change made
        // while catch-up runs is already queued when it finishes. Ordering
        // by construction: the forwarder is spawned here, the coordinator
        // below.
        let wake = Arc::new((Mutex::new(false), Condvar::new()));
        let watch_alive = Arc::new(AtomicBool::new(false));
        let mut watch_error = None;
        if options.watch {
            match start_watch(
                &config,
                &options,
                hooks.fail_watch_install,
                &commands,
                &overflow,
                &running,
                &watch_alive,
            ) {
                Ok(handle) => threads.push(handle),
                Err(message) => watch_error = Some(message),
            }
        }
        let watch_installed = watch_alive.load(Ordering::Acquire);

        let tick_pending = Arc::new(AtomicBool::new(false));
        if let Some(interval) = options.reconcile_interval.filter(|it| !it.is_zero()) {
            match spawn_timer(
                interval,
                Arc::clone(&wake),
                Arc::clone(&running),
                Arc::clone(&tick_pending),
                commands.clone(),
                Arc::clone(&overflow),
            ) {
                Ok(handle) => threads.push(handle),
                // A thread already spawned must never outlive this failed
                // start: stop it and wait for it before reporting.
                Err(error) => {
                    abandon(&running, &wake, threads);
                    return Err(error.into());
                }
            }
        }

        let coordinator = Coordinator {
            index,
            source,
            commands: mailbox,
            notices,
            overflow: Arc::clone(&overflow),
            running: Arc::clone(&running),
            tick_pending: Arc::clone(&tick_pending),
            gate: hooks.before_catch_up.clone(),
            hooks,
            mutations: 0,
            debounce: options.watch_config.debounce,
            max_dirty_paths: options.watch_config.max_dirty_paths.max(1),
            pending: BTreeSet::new(),
            pending_deletions: BTreeMap::new(),
            next_deletion: None,
            retry_at: None,
            rehints: 0,
            escalation: None,
            escalation_failures: 0,
            watching: watch_installed,
            watch_alive: Arc::clone(&watch_alive),
            watch_error,
            reconcile_error: None,
            // The coordinator's own view starts where the service did, so
            // its first `CatchingUp` is a real transition and is announced.
            // `start` has already installed `CatchingUp` on the barrier, so
            // a caller reading the instant `start` returns never sees
            // `Starting` either.
            state: LiveState::Starting,
            published_error: None,
            notices_dropped: false,
        };
        let coordinator_alive = Arc::new(AtomicBool::new(true));
        match std::thread::Builder::new()
            .name("vaultd-coordinator".into())
            .spawn({
                let alive = CoordinatorAlive(Arc::clone(&coordinator_alive));
                move || {
                    // Moved in and dropped here so it fires on *every* exit
                    // from `run`, an unwind included.
                    let _alive = alive;
                    coordinator.run()
                }
            }) {
            Ok(handle) => threads.push(handle),
            Err(error) => {
                abandon(&running, &wake, threads);
                return Err(error.into());
            }
        }

        Ok(RuntimeHandle {
            inner: Arc::new(RuntimeInner {
                commands,
                overflow,
                running,
                wake,
                reader,
                threads: Mutex::new(threads),
                stopped: AtomicBool::new(false),
                watch_alive,
                coordinator_alive,
            }),
        })
    }
}

/// Stop and join threads spawned by a `start` that then failed. Without
/// this, a failed start would leave a forwarder or timer running with no
/// handle to stop it — an orphan for the life of the process.
fn abandon(running: &AtomicBool, wake: &(Mutex<bool>, Condvar), threads: Vec<JoinHandle<()>>) {
    running.store(false, Ordering::Release);
    let (lock, condvar) = wake;
    {
        let mut stop = lock.lock().unwrap_or_else(|error| error.into_inner());
        *stop = true;
        condvar.notify_all();
    }
    for thread in threads {
        let _ = thread.join();
    }
}

/// Install the watcher and spawn the thread that forwards its hints. Failure
/// is reported as a message, never as a startup error: a runtime that cannot
/// watch still reconciles periodically and on demand.
fn start_watch(
    config: &IndexConfig,
    options: &RuntimeOptions,
    force_failure: bool,
    commands: &SyncSender<RuntimeCommand>,
    overflow: &Arc<AtomicBool>,
    running: &Arc<AtomicBool>,
    alive: &Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    if force_failure {
        return Err("watcher installation was refused".into());
    }
    let stream = WatchStream::start(&config.canonical_vault_root, options.watch_config.clone())
        .map_err(|error| error.to_string())?;
    let commands = commands.clone();
    let overflow = Arc::clone(overflow);
    let running = Arc::clone(running);
    let thread_alive = Arc::clone(alive);
    // Set before the spawn, so `start` observes a live watch the moment the
    // spawn succeeds and never races the thread's first instruction.
    alive.store(true, Ordering::Release);
    std::thread::Builder::new()
        .name("vaultd-watch-forwarder".into())
        .spawn(move || forward_hints(stream, commands, overflow, running, thread_alive))
        .inspect_err(|_| alive.store(false, Ordering::Release))
        .map_err(|error| error.to_string())
}

/// Turn watch hints into commands. Owns the `WatchStream` and nothing else;
/// it performs no file reads, no parsing, and no index access.
/// `alive` is cleared on *every* exit — the loop's own, a closed mailbox, and
/// a dead backend alike. Once this thread is gone nothing is watching, and
/// the coordinator must not be able to conclude otherwise from a hint that
/// reached it some other way.
fn forward_hints(
    mut stream: WatchStream,
    commands: SyncSender<RuntimeCommand>,
    overflow: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
) {
    while running.load(Ordering::Acquire) {
        match stream.recv_timeout(WATCH_POLL) {
            Ok(Some(hint)) => {
                if dispatch(&commands, &overflow, RuntimeCommand::Hint(hint))
                    == Dispatch::MailboxClosed
                {
                    // The coordinator is gone; there is nothing left to
                    // forward hints to.
                    alive.store(false, Ordering::Release);
                    return;
                }
            }
            Ok(None) => {}
            Err(error) => {
                // The backend died. This obligates a full reconciliation —
                // never a silent log line — so hand it over as a hint and
                // stop: the stream cannot produce anything further. The flag
                // is cleared *before* the hint, so the coordinator can never
                // process it while this thread still looks alive.
                alive.store(false, Ordering::Release);
                dispatch(
                    &commands,
                    &overflow,
                    RuntimeCommand::Hint(ChangeHint::WatcherFailed(error.to_string())),
                );
                return;
            }
        }
    }
    alive.store(false, Ordering::Release);
}

fn spawn_timer(
    interval: Duration,
    wake: Arc<(Mutex<bool>, Condvar)>,
    running: Arc<AtomicBool>,
    tick_pending: Arc<AtomicBool>,
    commands: SyncSender<RuntimeCommand>,
    overflow: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, std::io::Error> {
    std::thread::Builder::new()
        .name("vaultd-reconcile-timer".into())
        .spawn(move || {
            let (lock, condvar) = &*wake;
            loop {
                let stop = lock.lock().unwrap_or_else(|error| error.into_inner());
                // Check under the lock *before* waiting. `stop` may already
                // have been set — and its `notify_all` already spent —
                // between spawning this thread and reaching here; waiting
                // first would then miss the wake-up entirely and hold
                // shutdown for a whole reconcile interval.
                if *stop || !running.load(Ordering::Acquire) {
                    return;
                }
                let (stop, _) = condvar
                    .wait_timeout(stop, interval)
                    .unwrap_or_else(|error| error.into_inner());
                let asked_to_stop = *stop;
                drop(stop);
                if asked_to_stop || !running.load(Ordering::Acquire) {
                    return;
                }
                // Coalesce: one outstanding refresh at a time. The
                // coordinator clears the flag when it takes a refresh
                // command, so a manual refresh satisfies a due tick too.
                if tick_pending.swap(true, Ordering::AcqRel) {
                    continue;
                }
                // A tick wants the work done, not the report: dropping the
                // receiver makes the coordinator's reply a no-op.
                let (reply, _) = sync_channel(1);
                match dispatch(
                    &commands,
                    &overflow,
                    RuntimeCommand::Refresh {
                        verify: false,
                        reply,
                    },
                ) {
                    Dispatch::Accepted => {}
                    // Dropped on a full mailbox, so nothing will ever clear
                    // the coalescing flag. Release it here, or this timer
                    // would never tick again. The change is not lost: the
                    // latch obliges a complete reconciliation anyway.
                    Dispatch::Overflowed => tick_pending.store(false, Ordering::Release),
                    Dispatch::MailboxClosed => return,
                }
            }
        })
}

/// What became of one offered command.
///
/// Public because the distinction is client-visible: a command the mailbox
/// refused because it was saturated is a *transient overload* the caller may
/// retry, while a closed mailbox is a runtime that has stopped for good. The
/// protocol layer maps them to `runtime_overloaded` and `runtime_not_ready`
/// respectively, and cannot do that if both arrive as one error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dispatch {
    Accepted,
    /// The mailbox was full. The command was dropped and the overflow latch
    /// set — the change it described is escalated to a complete
    /// reconciliation, not lost.
    Overflowed,
    /// The coordinator has stopped. Nothing more will ever be accepted.
    MailboxClosed,
}

/// Offer one command to the mailbox without ever blocking a producer.
///
/// A producer that blocked here would be a watcher callback or a timer
/// waiting on indexing, which is exactly what the bounded-queue rule exists
/// to prevent. Saturation is therefore handled by latching, never by
/// waiting.
fn dispatch(
    commands: &SyncSender<RuntimeCommand>,
    overflow: &AtomicBool,
    command: RuntimeCommand,
) -> Dispatch {
    match commands.try_send(command) {
        Ok(()) => Dispatch::Accepted,
        Err(TrySendError::Full(_)) => {
            overflow.store(true, Ordering::Release);
            Dispatch::Overflowed
        }
        Err(TrySendError::Disconnected(_)) => Dispatch::MailboxClosed,
    }
}

/// Why a requested refresh produced no report.
///
/// The three cases are deliberately distinct because a client can act on the
/// difference: an overloaded runtime is worth retrying in a moment, a
/// stopped one never is, and an index failure is neither.
#[derive(Debug)]
pub enum RefreshFailure {
    /// The command mailbox was saturated. The refresh was dropped and the
    /// overflow latch set, so the runtime will reconcile completely anyway —
    /// but no report exists for *this* request.
    Overloaded,
    /// The runtime has stopped, or stopped before answering.
    NotReady,
    /// The refresh ran and failed.
    Failed(IndexError),
}

impl std::fmt::Display for RefreshFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Overloaded => formatter.write_str("the runtime is overloaded"),
            Self::NotReady => formatter.write_str("the runtime is not running"),
            Self::Failed(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for RefreshFailure {}

/// What one applied mutation produced.
///
/// `generation` is the generation a client may now read its own write at —
/// `None` only when nothing has ever been committed. `revision` is the
/// content revision the mutation wrote, and is `None` for everything with no
/// bytes to hash: a folder operation, or a delete. `semantic` is the engine's
/// own statement about whether the Markdown half of the index moved, never a
/// fact derived from `generation` — a folder creation moves the generation
/// through the file tree while nothing semantic happened at all.
#[derive(Clone, Debug)]
pub struct MutationReport {
    pub generation: Option<Generation>,
    pub revision: Option<String>,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailure>,
    pub semantic: bool,
}

/// Why a requested mutation produced no report. Extends [`RefreshFailure`]'s
/// three-way split with the one distinction that only exists for a write:
/// whether the bytes reached disk before things went wrong.
///
/// [`Self::Overloaded`] and [`Self::NotReady`] are produced by
/// [`RuntimeHandle::mutate`] — the mutation never reached the coordinator at
/// all. [`Self::Failed`] and [`Self::Unpublished`] are produced by the
/// coordinator, and are what its reply channel carries.
#[derive(Debug)]
pub enum MutationFailure {
    Overloaded,
    NotReady,
    /// Nothing was written. The engine refused before touching the vault (or
    /// its own write failed and rolled itself back), so the vault is
    /// byte-identical to what it was and a retry is safe.
    Failed(IndexError),
    /// The write landed and the generation that would have published it did
    /// not. The vault and the index have diverged, the coordinator has
    /// re-queued the paths so they still reach a generation, and the caller's
    /// read-your-writes fence did not close.
    ///
    /// `revision` is what the mutation put on disk, when it wrote bytes at
    /// all — the caller's proof that its write is *not* undone and that a
    /// blind retry may now meet `target_exists` or a revision conflict. The
    /// operations with no content revision of their own (the folder
    /// operations, the deletes) carry `None` here, exactly as they do on
    /// success.
    Unpublished {
        error: IndexError,
        revision: Option<String>,
    },
}

impl std::fmt::Display for MutationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Overloaded => formatter.write_str("the runtime is overloaded"),
            Self::NotReady => formatter.write_str("the runtime is not running"),
            Self::Failed(error) => write!(formatter, "{error}"),
            Self::Unpublished { error, .. } => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for MutationFailure {}

/// Clears its flag when the coordinator thread leaves `run` by any route.
///
/// A `Drop` guard rather than a store at the end of `run`, because the route
/// that matters most is the one no explicit store can cover: this workspace
/// unwinds on panic, and a coordinator that panics never reaches
/// `publish_state(Stopped)`. Without this the publication barrier would keep
/// asserting whatever it last published — `Watching`, typically — for the
/// life of the process, and a client would subscribe successfully to a stream
/// that can never produce anything.
struct CoordinatorAlive(Arc<AtomicBool>);

impl Drop for CoordinatorAlive {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// The shared, clonable half of a running runtime.
struct RuntimeInner {
    commands: SyncSender<RuntimeCommand>,
    overflow: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    wake: Arc<(Mutex<bool>, Condvar)>,
    reader: Arc<IndexReader>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    stopped: AtomicBool,
    watch_alive: Arc<AtomicBool>,
    /// Whether the coordinator thread is still inside `run`. Cleared by
    /// [`CoordinatorAlive`] on unwind as well as on a clean exit.
    coordinator_alive: Arc<AtomicBool>,
}

impl RuntimeInner {
    /// Stop every thread and wait for each one. Idempotent: the first caller
    /// does the work, later callers (including `Drop`) return immediately.
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        // Order matters: clear `running` first so the forwarder and timer
        // stop producing, then wake the timer out of its wait, then ask the
        // coordinator to finish what it is doing. `Stop` is offered rather
        // than forced — a full mailbox already means the coordinator is
        // awake and draining, and it also exits on `running`.
        self.running.store(false, Ordering::Release);
        {
            let (lock, condvar) = &*self.wake;
            let mut stop = lock.lock().unwrap_or_else(|error| error.into_inner());
            *stop = true;
            condvar.notify_all();
        }
        let _ = self.commands.try_send(RuntimeCommand::Stop);

        let threads = {
            let mut guard = self
                .threads
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *guard)
        };
        for thread in threads {
            // A panicking coordinator is already reported by the thread
            // itself; joining is what guarantees no thread outlives the
            // runtime, and that the writer lease is released before this
            // returns.
            let _ = thread.join();
        }
    }
}

impl Drop for RuntimeInner {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A clonable handle on a running runtime. The runtime stops when the last
/// handle is dropped, or when `shutdown` is called.
#[derive(Clone)]
pub struct RuntimeHandle {
    inner: Arc<RuntimeInner>,
}

impl std::fmt::Debug for RuntimeHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeHandle")
            .field("stopped", &self.inner.stopped.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl RuntimeHandle {
    /// The shared reader every protocol thread answers from. `IndexReader`
    /// is `Send + Sync`; the writer it belongs to is not, and never leaves
    /// the coordinator thread.
    pub fn reader(&self) -> Arc<IndexReader> {
        Arc::clone(&self.inner.reader)
    }

    /// Queue one command, without ever blocking. A full mailbox sets the
    /// overflow latch and reports [`Dispatch::Overflowed`]: the change the
    /// command described is escalated to a complete reconciliation rather
    /// than lost, but the command itself is gone and will never be answered.
    pub fn send_command(&self, command: RuntimeCommand) -> Dispatch {
        dispatch(&self.inner.commands, &self.inner.overflow, command)
    }

    /// Feed one hint in, exactly as the watcher would. `false` means the
    /// runtime has stopped; an overflowed hint still returns `true`, because
    /// the change it described is escalated rather than lost.
    pub fn hint(&self, hint: ChangeHint) -> bool {
        self.send_command(RuntimeCommand::Hint(hint)) != Dispatch::MailboxClosed
    }

    /// Ask for a refresh and wait for its report. Hints already in the
    /// mailbox are processed first; hints that arrive later wait.
    pub fn refresh(&self, verify: bool) -> Result<RefreshReport, RefreshFailure> {
        let (reply, replies) = sync_channel(1);
        match self.send_command(RuntimeCommand::Refresh { verify, reply }) {
            Dispatch::Accepted => {}
            Dispatch::Overflowed => return Err(RefreshFailure::Overloaded),
            Dispatch::MailboxClosed => return Err(RefreshFailure::NotReady),
        }
        // The coordinator answers every refresh it takes, so a dropped reply
        // channel means it stopped without answering this one.
        match replies.recv() {
            Ok(result) => result.map_err(RefreshFailure::Failed),
            Err(_) => Err(RefreshFailure::NotReady),
        }
    }

    /// Apply one mutation and wait for it to be published. Hints already
    /// pending are flushed first, unless they are waiting out a reconcile
    /// retry backoff; hints that arrive later wait.
    ///
    /// Blocks until the coordinator has reconciled what the write changed, so
    /// a caller that gets a report may immediately read its own write at the
    /// generation the report names.
    pub fn mutate(&self, mutation: Mutation) -> Result<MutationReport, MutationFailure> {
        let (reply, replies) = sync_channel(1);
        match self.send_command(RuntimeCommand::Mutate {
            mutation: Box::new(mutation),
            reply,
        }) {
            Dispatch::Accepted => {}
            Dispatch::Overflowed => return Err(MutationFailure::Overloaded),
            Dispatch::MailboxClosed => return Err(MutationFailure::NotReady),
        }
        // The coordinator answers every mutation it takes, so a dropped reply
        // channel means it stopped without answering this one.
        match replies.recv() {
            Ok(result) => result,
            Err(_) => Err(MutationFailure::NotReady),
        }
    }

    /// Stop the runtime and wait for every thread. Idempotent, and implied
    /// by dropping the last handle.
    ///
    /// Never call this from inside a runtime thread (a test hook, say): it
    /// joins, and a thread cannot join itself.
    pub fn shutdown(&self) {
        self.inner.stop();
    }

    /// Whether this runtime has stopped mutating, for any reason.
    ///
    /// True once `shutdown` has joined every thread, and *also* once the
    /// coordinator has left `run` on its own — including by panicking, which
    /// no observational state it publishes could report, because it never got
    /// to publish anything. That second clause is the authority when the two
    /// disagree: the publication barrier records what the coordinator last
    /// said, while this records whether it is still there to say anything.
    pub fn is_stopped(&self) -> bool {
        self.inner.stopped.load(Ordering::Acquire)
            || !self.inner.coordinator_alive.load(Ordering::Acquire)
    }

    /// Whether a filesystem watcher is installed *and* its forwarder thread
    /// is still running. Goes false if the backend dies, because at that
    /// point nothing is watching regardless of how startup went.
    pub fn watch_installed(&self) -> bool {
        self.inner.watch_alive.load(Ordering::Acquire)
    }

    #[doc(hidden)]
    pub fn thread_count_for_test(&self) -> usize {
        self.inner
            .threads
            .lock()
            .map(|threads| threads.len())
            .unwrap_or(0)
    }
}

/// The one mutation owner.
struct Coordinator {
    index: IndexService,
    /// A read-only view of the vault, used for exactly one thing: deciding
    /// whether a hinted path is currently present, so an absent one can be
    /// held for the deletion grace window instead of publishing a deletion
    /// the next write would undo.
    source: FileSystemIndexSource,
    commands: Receiver<RuntimeCommand>,
    notices: SyncSender<RuntimeNotice>,
    overflow: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    tick_pending: Arc<AtomicBool>,
    gate: Option<RuntimeHook>,
    hooks: RuntimeTestHooks,
    /// How many calls into the `IndexService` this coordinator has made.
    /// Only ever read by the fault hook, which needs a stable way to name
    /// "the third one".
    mutations: usize,
    debounce: Duration,
    /// The watcher's own ceiling on one dirty set. The coordinator's pending
    /// set must not grow past what a single hint could have carried.
    max_dirty_paths: usize,
    /// Paths waiting to go into the next targeted batch.
    pending: BTreeSet<VaultPath>,
    /// Paths last seen absent, with the instant they may be treated as
    /// deleted. An atomic save (write temp, rename over) makes a path vanish
    /// for microseconds; publishing that as a deletion would emit a
    /// generation pair no client should ever have seen.
    ///
    /// The one collection here whose bound is emergent rather than declared.
    /// It holds at most the unique absent paths hinted within one grace
    /// window: entries are keyed by path so a repeated hint coalesces rather
    /// than accumulating, and `mature_deletions` drains everything at or past
    /// its deadline on *every* loop iteration. So the ceiling is (distinct
    /// absent paths a producer can hint in `debounce`), and a producer that
    /// exceeds what the coordinator can drain saturates the command mailbox
    /// first — which latches overflow and escalates to a complete
    /// reconciliation that clears this map outright.
    pending_deletions: BTreeMap<VaultPath, Instant>,
    /// The earliest deadline in `pending_deletions`, tracked rather than
    /// rescanned: the map is keyed by path, so finding the minimum costs a
    /// full scan, and a runtime under sustained command traffic checks this
    /// on every iteration.
    next_deletion: Option<Instant>,
    /// When a re-hinted batch may be retried.
    retry_at: Option<Instant>,
    rehints: usize,
    /// A complete reconciliation that is owed but has not succeeded, with the
    /// instant it may next be attempted.
    ///
    /// `full_reconcile` clears the pending sets and the overflow latch is
    /// consumed before it runs, so once it starts, nothing else in the
    /// coordinator remembers that it was demanded. If it then fails, this is
    /// the only thing that does.
    escalation: Option<(ResyncReason, Instant)>,
    /// Consecutive failed escalations, for backoff. Reset by any complete
    /// reconciliation that succeeds.
    escalation_failures: u32,
    /// Whether a watcher is installed and healthy.
    watching: bool,
    /// Whether the forwarder thread is alive. Set when it is spawned and
    /// cleared by the forwarder itself before every return, so a dead
    /// forwarder can never be mistaken for a working watch.
    watch_alive: Arc<AtomicBool>,
    watch_error: Option<String>,
    reconcile_error: Option<String>,
    state: LiveState,
    published_error: Option<String>,
    notices_dropped: bool,
}

impl Coordinator {
    fn run(mut self) {
        self.publish_state(LiveState::CatchingUp, None);
        // Startup catch-up: normal metadata reconciliation, which routes
        // through the same dirty-set engine an ordinary refresh uses.
        self.full_reconcile(ResyncReason::RuntimeRecovered);
        self.drain_backlog();
        self.settle();

        while self.running.load(Ordering::Acquire) {
            if self.overflow.swap(false, Ordering::AcqRel) {
                self.full_reconcile(ResyncReason::WatcherOverflow);
                self.settle();
                continue;
            }
            let now = Instant::now();
            // A complete reconciliation that was demanded and then failed.
            // Nothing else remembers it, so retrying it outranks ordinary
            // work — an escalation exists precisely because the incremental
            // view can no longer be trusted.
            if let Some((reason, at)) = self.escalation {
                if at <= now {
                    self.escalation = None;
                    self.full_reconcile(reason);
                    self.settle();
                    continue;
                }
            }
            // Checked every iteration, not only on an idle timeout: under
            // sustained command traffic the loop may never time out, and a
            // held-back deletion must not starve behind it.
            self.mature_deletions(now);
            match self.commands.recv_timeout(self.next_timeout(now)) {
                Ok(RuntimeCommand::Stop) => break,
                Ok(command) => self.handle(command),
                Err(RecvTimeoutError::Timeout) => self.flush(),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        let error = self.effective_error();
        self.publish_state(LiveState::Stopped, error);
    }

    /// Process everything already queued, then flush what it produced. Runs
    /// once, between catch-up and the first `Watching`: a runtime must not
    /// claim to be watching while a startup backlog is still unprocessed.
    fn drain_backlog(&mut self) {
        loop {
            // A shutdown during catch-up must not be made to wait out a
            // whole startup backlog first.
            if !self.running.load(Ordering::Acquire) {
                return;
            }
            match self.commands.try_recv() {
                Ok(RuntimeCommand::Stop) => {
                    self.running.store(false, Ordering::Release);
                    return;
                }
                Ok(command) => self.handle(command),
                Err(_) => break,
            }
        }
        self.flush();
    }

    /// How long to block for the next command: no time at all when a batch
    /// is ready to go, otherwise until the nearest deletion deadline.
    fn next_timeout(&self, now: Instant) -> Duration {
        let mut timeout = IDLE_POLL;
        if !self.pending.is_empty() {
            let ready = self.retry_at.unwrap_or(now);
            timeout = timeout.min(ready.saturating_duration_since(now));
        }
        if let Some(deadline) = self.next_deletion {
            timeout = timeout.min(deadline.saturating_duration_since(now));
        }
        if let Some((_, at)) = self.escalation {
            timeout = timeout.min(at.saturating_duration_since(now));
        }
        timeout
    }

    fn handle(&mut self, command: RuntimeCommand) {
        match command {
            RuntimeCommand::Hint(hint) => self.handle_hint(hint),
            RuntimeCommand::Refresh { verify, reply } => {
                self.tick_pending.store(false, Ordering::Release);
                // Mailbox order is mutation order: hints that arrived
                // before this command are published first.
                self.flush();
                let result = self.foreground_refresh(verify);
                let _ = reply.try_send(result);
            }
            RuntimeCommand::Mutate { mutation, reply } => {
                let result = self.apply_mutation(*mutation);
                let _ = reply.try_send(result);
            }
            RuntimeCommand::Stop => self.running.store(false, Ordering::Release),
        }
    }

    fn handle_hint(&mut self, hint: ChangeHint) {
        match hint {
            ChangeHint::Paths(paths) => {
                let now = Instant::now();
                for path in paths {
                    match self.source.fingerprint(&path) {
                        // Present: reconcile it now, and cancel any grace
                        // window it was waiting out — this is the coalescing
                        // case, an atomic save landing on its final name.
                        Ok(Some(_)) => {
                            self.pending_deletions.remove(&path);
                            self.pending.insert(path);
                        }
                        Ok(None) => {
                            let deadline = now + self.debounce;
                            // The mirror of the present case above: a path
                            // that was queued for the next batch while it
                            // existed must leave that batch when it stops
                            // existing, or it would be published as a
                            // deletion with no grace window at all — the
                            // batch may already be waiting behind a
                            // `retry_at` backoff that fires before this
                            // deadline.
                            self.pending.remove(&path);
                            // A later hint coalesces onto the same entry
                            // rather than adding another.
                            self.pending_deletions.insert(path, deadline);
                            self.next_deletion = Some(
                                self.next_deletion
                                    .map_or(deadline, |earliest| earliest.min(deadline)),
                            );
                        }
                        // Metadata unreadable: no basis for holding it back.
                        // Over-selection is always safe.
                        Err(_) => {
                            self.pending_deletions.remove(&path);
                            self.pending.insert(path);
                        }
                    }
                }
                if self.pending.len() >= self.max_dirty_paths {
                    // The pending set has reached the ceiling one hint could
                    // have carried. Publish now rather than let it grow
                    // unbounded waiting for the mailbox to go quiet.
                    self.flush();
                }
                // A hint from a stream that exists is proof it works again.
                // Gated on a *live* forwarder, not merely a successful
                // install: a runtime that never had a watcher, or whose
                // watcher thread has since died, can still be fed hints
                // in-process, and those must never let it claim to be
                // watching.
                if self.watch_alive.load(Ordering::Acquire) && self.watch_error.is_some() {
                    self.watch_error = None;
                    self.watching = true;
                    self.settle();
                }
            }
            ChangeHint::Overflow => {
                self.full_reconcile(ResyncReason::WatcherOverflow);
                self.settle();
            }
            ChangeHint::RootInvalidated => {
                self.full_reconcile(ResyncReason::RootInvalidated);
                self.settle();
            }
            ChangeHint::WatcherFailed(message) => {
                // Never just logged: the stream stopped telling the truth,
                // so the incremental view has to be rebuilt, and the runtime
                // degrades to periodic and manual reconciliation.
                self.watching = false;
                self.watch_error = Some(message);
                self.full_reconcile(ResyncReason::RuntimeRecovered);
                self.settle();
            }
        }
    }

    /// Move every matured deletion into the next batch. `refresh_paths`
    /// re-fingerprints (and re-reads) each path it is given, so the state
    /// that decides "deleted" versus "modified" is read there, from one
    /// coherent observation, rather than guessed at here.
    fn mature_deletions(&mut self, now: Instant) {
        // `next_deletion` is only ever too early (a removed or extended
        // entry leaves it behind), never too late, so this early return can
        // cost a wasted wake-up but can never miss a deadline.
        match self.next_deletion {
            Some(deadline) if deadline <= now => {}
            Some(_) => return,
            None => return,
        }
        let mut earliest: Option<Instant> = None;
        let mut matured: Vec<VaultPath> = Vec::new();
        for (path, deadline) in &self.pending_deletions {
            if *deadline <= now {
                matured.push(path.clone());
            } else {
                earliest = Some(earliest.map_or(*deadline, |it: Instant| it.min(*deadline)));
            }
        }
        for path in matured {
            self.pending_deletions.remove(&path);
            self.pending.insert(path);
        }
        self.next_deletion = earliest;
    }

    /// Publish whatever is pending as one targeted batch.
    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        // A re-hinted batch waits out its backoff — unless the pending set
        // has grown to the ceiling one hint could have carried, in which
        // case waiting only lets it grow further.
        let full = self.pending.len() >= self.max_dirty_paths;
        if let Some(at) = self.retry_at {
            if !full && Instant::now() < at {
                return;
            }
        }
        self.retry_at = None;
        let batch = std::mem::take(&mut self.pending);
        self.reconcile_paths(batch);
    }

    /// Reconcile one dirty batch, and never lose it.
    ///
    /// Exactly two ways out: the batch published, or the batch comes back.
    /// Every failure — retryable or not, exhausted or not — leaves the loop
    /// through the single `rehint` below, because a dropped batch is a
    /// permanently missing change: with no `reconcile_interval` configured,
    /// nothing else would ever revisit those paths. `rehint` caps consecutive
    /// re-hints and escalates to a complete reconciliation, so this cannot
    /// spin.
    ///
    /// The one early return is `IndexUnavailable`, and only because the
    /// complete reconciliation it triggers covers these paths and every
    /// other one besides.
    fn reconcile_paths(&mut self, batch: BTreeSet<VaultPath>) {
        for attempt in 0..MAX_MUTATION_ATTEMPTS {
            let last = attempt + 1 == MAX_MUTATION_ATTEMPTS;
            let paths = batch.clone();
            match self.mutation(|index| index.refresh_paths(paths, ChangeCause::Watcher)) {
                Ok(report) => {
                    self.rehints = 0;
                    self.clear_reconcile_error();
                    if report.previous_generation != Some(report.generation) {
                        self.emit(RuntimeNotice::Generation(Box::new(report)));
                    }
                    return;
                }
                // Lock contention, not damage. Retry until the attempts run
                // out, then hand the batch back rather than consuming it.
                Err(IndexError::Busy(_)) => {
                    if last {
                        break;
                    }
                    std::thread::sleep(BUSY_BACKOFF);
                }
                // A writer this process does not own moved the cache. Adopt
                // what it committed, then retry.
                Err(IndexError::LiveStateStale(_)) => {
                    if last {
                        break;
                    }
                    if let Err(error) = self.mutation(IndexService::resync_published) {
                        self.fail(&error);
                        break;
                    }
                }
                // Reads happen before the publication attempt, and one moved
                // path aborts the whole batch — so the whole batch is what
                // has to come back, not the path that moved.
                Err(IndexError::VaultChangedDuringRefresh) => break,
                // No generation to be incremental against yet: the cold
                // build has to run first, and it covers these paths.
                Err(IndexError::IndexUnavailable) => {
                    self.full_reconcile(ResyncReason::RuntimeRecovered);
                    self.settle();
                    return;
                }
                Err(error) => {
                    self.fail(&error);
                    break;
                }
            }
        }
        self.rehint(batch);
    }

    /// Apply one mutation and publish what it changed **before** answering,
    /// so a client that completes a write can immediately read its result.
    ///
    /// The flush first keeps generation attribution honest and keeps a batch
    /// that was already waiting from delaying this write's fence. It is *not*
    /// what makes the ordering safe: `refresh_paths` re-reads every path it
    /// is given from disk rather than replaying a captured state, so a hint
    /// reconciled after this mutation can only re-observe what the mutation
    /// already published, and publishes nothing. That property —
    /// reconciliation is state-based, never a replayed diff — is what makes
    /// every interleaving of hints and mutations converge, and it is worth
    /// stating because the obvious worry (an old hint republishing an old
    /// view on top of this write) is unreachable for that reason and not
    /// because of the flush.
    fn apply_mutation(&mut self, mutation: Mutation) -> Result<MutationReport, MutationFailure> {
        self.flush();
        // Every failure up to and including this call leaves the vault
        // byte-identical — for every mutation **except** a link-repairing
        // rename, where the engine refuses before it writes and its own write
        // is temp-then-rename.
        //
        // A repairing rename rewrites the referrers before it moves the file,
        // so the guarantee splits at that point and an `Err` here means one of
        // two things:
        //
        // * refused **before** the rewrites — the ordinary case, and the one
        //   every squatter produces, because the destination is reserved
        //   first: nothing changed, and the reservation is given back;
        // * refused **after** them — a source that vanished or whose revision
        //   moved in that window: the referrers are rewritten and the
        //   reservation is deliberately *kept*, so those references name a
        //   placeholder this daemon owns rather than a same-basename note
        //   elsewhere in the vault. The client's retry adopts the placeholder
        //   and completes.
        //
        // In that second case `changed_paths` is lost with the `Err`, so the
        // rewritten referrers reach a generation through the watcher's own
        // hint or the next complete reconciliation rather than through this
        // call. Recorded as Task 12's residue 2, not an oversight.
        //
        // A repair that could not land while the rename itself *succeeded* is
        // reported inside the `Ok` outcome's `link_rewrite_failures`, never by
        // failing the mutation.
        let outcome = self
            .mutation(|index| index.apply_mutation(&mutation))
            .map_err(MutationFailure::Failed)?;
        if outcome.changed_paths.is_empty() {
            // A byte-identical patch, or a write into a zone the index does
            // not track: nothing the index holds moved, so report the
            // generation the client can already read at rather than
            // manufacturing one.
            return Ok(self.report(&outcome, self.committed_generation()));
        }
        let paths = outcome.changed_paths.clone();
        match self.reconcile_mutation(paths.clone()) {
            Ok(report) => {
                self.rehints = 0;
                self.clear_reconcile_error();
                if report.previous_generation != Some(report.generation) {
                    self.emit(RuntimeNotice::Generation(Box::new(report.clone())));
                }
                Ok(self.report(&outcome, Some(report.generation)))
            }
            // Nothing has ever been committed, so there is no generation to
            // be incremental against. The complete reconciliation covers this
            // write and everything else besides.
            Err(IndexError::IndexUnavailable) => {
                self.full_reconcile(ResyncReason::RuntimeRecovered);
                self.settle();
                Ok(self.report(&outcome, self.committed_generation()))
            }
            Err(error) => {
                // The bytes are on disk; only the index is behind. Hand the
                // paths back so they still reach a generation, and tell the
                // caller its read-your-writes fence did not close — naming
                // the revision it wrote, because that is the only thing that
                // distinguishes this from a failure that wrote nothing.
                self.fail(&error);
                self.rehint(paths);
                Err(MutationFailure::Unpublished {
                    error,
                    revision: outcome.revision,
                })
            }
        }
    }

    fn report(&self, outcome: &MutationOutcome, generation: Option<Generation>) -> MutationReport {
        MutationReport {
            generation,
            revision: outcome.revision.clone(),
            links_rewritten: outcome.links_rewritten,
            link_rewrite_failures: outcome.link_rewrite_failures.clone(),
            semantic: outcome.semantic,
        }
    }

    /// Reconcile exactly the paths a mutation changed, retrying the errors
    /// that are retryable by construction — the same three
    /// `refresh_with_retries` retries, against a targeted batch.
    fn reconcile_mutation(
        &mut self,
        paths: BTreeSet<VaultPath>,
    ) -> Result<LiveRefreshReport, IndexError> {
        // The retry loop below covers all but the last attempt, and the last
        // one is the tail expression: whatever it produces is the answer.
        // Written that way so there is no unreachable fallback to keep honest
        // — the shape enforces "three attempts, then report" rather than a
        // comment claiming it.
        const _: () = assert!(
            MAX_MUTATION_ATTEMPTS > 0,
            "reconcile_mutation makes MAX_MUTATION_ATTEMPTS - 1 retries plus one final attempt"
        );
        for _ in 0..MAX_MUTATION_ATTEMPTS - 1 {
            let batch = paths.clone();
            match self.mutation(|index| index.refresh_paths(batch, ChangeCause::Mutation)) {
                Ok(report) => return Ok(report),
                // Only the three that are retryable by construction get
                // another attempt; anything else is reported as it stands,
                // because nothing this loop does would change the answer.
                Err(IndexError::Busy(_)) => std::thread::sleep(BUSY_BACKOFF),
                Err(IndexError::LiveStateStale(_)) => {
                    self.mutation(IndexService::resync_published)?;
                }
                Err(IndexError::VaultChangedDuringRefresh) => {}
                Err(error) => return Err(error),
            }
        }
        self.mutation(|index| index.refresh_paths(paths, ChangeCause::Mutation))
    }

    /// Put a batch back for another attempt, or give up on being incremental
    /// about it. Bounded on purpose: a file rewritten in a loop would
    /// otherwise keep this batch retrying forever.
    fn rehint(&mut self, batch: BTreeSet<VaultPath>) {
        self.rehints += 1;
        if self.rehints > MAX_CONSECUTIVE_REHINTS {
            self.rehints = 0;
            self.full_reconcile(ResyncReason::RuntimeRecovered);
            self.settle();
            return;
        }
        self.pending.extend(batch);
        self.retry_at = Some(Instant::now() + self.debounce);
    }

    /// Complete metadata reconciliation, plus whatever resolution the
    /// dirty-set engine decides is conservative. Everything pending is
    /// discarded first: this covers it all.
    ///
    /// Because it discards them, a failure here cannot simply be recorded and
    /// forgotten the way an ordinary error can. The dirty sets are gone, the
    /// overflow latch that demanded this was consumed before the call, and
    /// with no `reconcile_interval` configured nothing else would ever come
    /// back. So a failure both **announces** the loss it could not repair and
    /// **re-arms** the escalation, exactly as `reconcile_paths` re-hints a
    /// batch it could not publish.
    fn full_reconcile(&mut self, reason: ResyncReason) {
        self.pending.clear();
        self.pending_deletions.clear();
        self.next_deletion = None;
        self.retry_at = None;
        let error = self.effective_error();
        self.publish_state(LiveState::CatchingUp, error);

        let before = self.committed_generation();
        match self.refresh_with_retries(false) {
            Ok(report) => {
                self.clear_reconcile_error();
                // Whatever was owed is now paid, whichever escalation asked.
                self.escalation = None;
                self.escalation_failures = 0;
                let advanced = Some(report.generation) != before;
                // A lost-detail reason is always announced, even when the
                // generation did not move: the observer's incremental view is
                // what became untrustworthy, not the rows.
                if advanced || reason != ResyncReason::RuntimeRecovered {
                    self.emit(RuntimeNotice::ResyncRequired {
                        generation: Some(report.generation),
                        reason,
                    });
                }
            }
            Err(error) => {
                self.fail(&error);
                // Announce first. An observer whose incremental view just
                // became untrustworthy needs to know that now — it is true
                // whether or not this runtime can repair it, and the repair
                // may be many backoffs away.
                if reason != ResyncReason::RuntimeRecovered {
                    let generation = self.committed_generation();
                    self.emit(RuntimeNotice::ResyncRequired { generation, reason });
                }
                self.escalation_failures = self.escalation_failures.saturating_add(1);
                let at = Instant::now() + self.escalation_backoff();
                self.arm_escalation(reason, at);
            }
        }
    }

    /// How long to wait before retrying a failed escalation: the debounce
    /// window, doubled per consecutive failure, capped. `refresh_with_retries`
    /// burns its three attempts in microseconds when the error is
    /// `VaultChangedDuringRefresh` — which is exactly what a write storm
    /// produces — so without this the retry would spin against the storm that
    /// caused it.
    fn escalation_backoff(&self) -> Duration {
        let doublings = self.escalation_failures.saturating_sub(1).min(8);
        self.debounce
            .saturating_mul(1u32 << doublings)
            .min(MAX_ESCALATION_BACKOFF)
    }

    /// Record that a complete reconciliation is owed. Keeps the most
    /// informative reason and the earliest deadline, so a second escalation
    /// arriving while one is outstanding can only make the response sooner
    /// and more specific, never later or vaguer.
    fn arm_escalation(&mut self, reason: ResyncReason, at: Instant) {
        self.escalation = Some(match self.escalation {
            Some((owed, owed_at)) => {
                let reason = if resync_severity(reason) > resync_severity(owed) {
                    reason
                } else {
                    owed
                };
                (reason, owed_at.min(at))
            }
            None => (reason, at),
        });
    }

    /// A refresh asked for by a client or by the periodic timer. Reports
    /// back to its caller; announces a resync only when it actually moved
    /// the generation, because no per-path change set describes what it did.
    fn foreground_refresh(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        let before = self.committed_generation();
        let result = self.refresh_with_retries(verify);
        match &result {
            Ok(report) => {
                self.clear_reconcile_error();
                if Some(report.generation) != before {
                    self.emit(RuntimeNotice::ResyncRequired {
                        generation: Some(report.generation),
                        reason: ResyncReason::RuntimeRecovered,
                    });
                }
            }
            Err(error) => self.fail(error),
        }
        result
    }

    /// One refresh, retried for the errors that are retryable by
    /// construction: lock contention, a stale live state this process can
    /// re-sync, and a vault that moved mid-refresh.
    fn refresh_with_retries(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        let mut last = None;
        for attempt in 0..MAX_MUTATION_ATTEMPTS {
            let final_attempt = attempt + 1 == MAX_MUTATION_ATTEMPTS;
            match self.mutation(|index| index.refresh(verify)) {
                Ok(report) => return Ok(report),
                Err(error) => {
                    let retryable = matches!(
                        error,
                        IndexError::Busy(_)
                            | IndexError::LiveStateStale(_)
                            | IndexError::VaultChangedDuringRefresh
                    );
                    if !retryable || final_attempt {
                        return Err(error);
                    }
                    match &error {
                        IndexError::Busy(_) => std::thread::sleep(BUSY_BACKOFF),
                        IndexError::LiveStateStale(_) => {
                            self.mutation(IndexService::resync_published)?;
                        }
                        _ => {}
                    }
                    last = Some(error);
                }
            }
        }
        Err(last.unwrap_or(IndexError::IndexUnavailable))
    }

    /// Every call into the `IndexService` goes through here, so "how many
    /// mutations are in flight" is answerable — and provably one.
    fn mutation<T>(
        &mut self,
        work: impl FnOnce(&mut IndexService) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        let enter = self.hooks.mutation_enter.clone();
        let exit = self.hooks.mutation_exit.clone();
        let fault = self.hooks.mutation_fault.clone();
        if let Some(hook) = &enter {
            hook();
        }
        if let Some(gate) = self.gate.take() {
            gate();
        }
        let sequence = self.mutations;
        self.mutations += 1;
        let injected = fault.and_then(|fault| fault(sequence));
        let outcome = match injected {
            Some(error) => Err(error),
            None => work(&mut self.index),
        };
        if let Some(hook) = &exit {
            hook();
        }
        outcome
    }

    /// The last generation this process's cache has committed, or `None` when
    /// nothing has been committed *or* the query itself failed. The two are
    /// deliberately not distinguished: every caller wants "a generation I can
    /// name", and both answers are "no".
    fn committed_generation(&self) -> Option<Generation> {
        if self.hooks.blind_generation_query {
            return None;
        }
        self.index.current_generation().ok().flatten()
    }

    fn effective_error(&self) -> Option<String> {
        self.watch_error
            .clone()
            .or_else(|| self.reconcile_error.clone())
    }

    /// The state the runtime settles into once a cycle is done: watching if
    /// a healthy watcher is installed, polling otherwise — which covers both
    /// a failed watcher and a runtime configured not to watch at all.
    fn settle(&mut self) {
        let state = if self.watching {
            LiveState::Watching
        } else {
            LiveState::PollingFallback
        };
        let error = self.effective_error();
        self.publish_state(state, error);
    }

    fn fail(&mut self, error: &IndexError) {
        let _ = self.index.record_refresh_failure(error);
        self.reconcile_error = Some(error.to_string());
        let state = self.state;
        let error = self.effective_error();
        self.publish_state(state, error);
    }

    fn clear_reconcile_error(&mut self) {
        if self.reconcile_error.is_none() {
            return;
        }
        self.reconcile_error = None;
        let state = self.state;
        let error = self.effective_error();
        self.publish_state(state, error);
    }

    /// Record observational status on the publication barrier and tell
    /// observers. A no-op when nothing actually changed, so a busy runtime
    /// does not flood the notice sink with identical states.
    fn publish_state(&mut self, state: LiveState, error: Option<String>) {
        if self.state == state && self.published_error == error {
            return;
        }
        // The bookkeeping below is only updated once the barrier actually
        // took the write. Recording it after a failed write would make the
        // coordinator believe a state it never published, and the early
        // return above would then suppress every future attempt to publish
        // it — the runtime would be permanently misreported. Leaving the
        // bookkeeping behind reality is the safe direction: the next cycle
        // simply tries again.
        if let Err(failure) = self.index.set_live_state(state) {
            // The barrier is poisoned or unreachable; there is nothing left
            // to report it through, and no reason to abandon the loop.
            self.reconcile_error = Some(failure.to_string());
            return;
        }
        if let Err(failure) = self.index.set_runtime_error(error.clone()) {
            self.reconcile_error = Some(failure.to_string());
            return;
        }
        self.state = state;
        self.published_error = error.clone();
        let generation = self.committed_generation();
        self.emit(RuntimeNotice::State {
            generation,
            state,
            error,
        });
    }

    /// Offer one notice. The sink is bounded and owned by the caller, so a
    /// slow observer must never stall indexing: a notice that will not fit
    /// is dropped, and the gap is announced as a resync before the next one
    /// that does fit.
    ///
    /// **This must only ever `try_send`, never `send`.** The property is
    /// load-bearing, not stylistic. Notices are emitted from inside the
    /// coordinator's own command handling — including while it is servicing
    /// a `RuntimeCommand::Refresh` whose caller is blocked in
    /// `replies.recv()`. Once Task 12's subscription dispatcher is the thing
    /// on the other end of this sink, a blocking `send` here would wait for
    /// that dispatcher while the dispatcher's own `refresh_index` caller
    /// waits for this coordinator: a two-party deadlock with no timeout on
    /// either side, reachable from an ordinary slow subscriber. Dropping a
    /// notice and announcing the gap is always the correct trade, because a
    /// gap is recoverable and a wedged writer is not.
    fn emit(&mut self, notice: RuntimeNotice) {
        if self.notices_dropped {
            let generation = self.committed_generation();
            match self.notices.try_send(RuntimeNotice::ResyncRequired {
                generation,
                reason: ResyncReason::RuntimeRecovered,
            }) {
                // The debt is only paid if the announcement can be acted on,
                // and an observer can only act on one that names the
                // generation to re-read at. `committed_generation` answers
                // from live SQLite, so a transient failure there yields
                // `None` — and an observer discards a `None` announcement,
                // because before the first commit there is nothing to re-read
                // at. Clearing the latch on such a send would spend the only
                // record that a gap ever happened on a notice nobody can use,
                // and nothing else re-arms it: every subscriber would lose
                // that gap permanently. So the latch is kept until the gap
                // can be announced usefully. Correct before the first commit
                // too — the cold build's own resync supersedes whatever
                // accumulated.
                Ok(()) => self.notices_dropped = generation.is_none(),
                Err(TrySendError::Full(_)) => return,
                Err(TrySendError::Disconnected(_)) => {
                    self.notices_dropped = false;
                    return;
                }
            }
        }
        match self.notices.try_send(notice) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => self.notices_dropped = true,
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}
