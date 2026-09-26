//! One notice stream, many connections.
//!
//! The runtime has exactly one notice channel and `--listen` gives it many
//! readers, so one thread owns the receiving end and clones each notice into
//! every connection's own bounded inbox. Three properties, each the reason
//! for the one before it:
//!
//! * **The broadcaster never blocks.** Not on a full inbox — it drops — and
//!   not on the coordinator, which it only receives from. So no client,
//!   however slow or however dead, can stall indexing. That is the invariant
//!   the stdio design states, preserved across any number of clients.
//! * **A drop is latched, and the marker precedes the notice.** The
//!   connection whose inbox was full has its gap recorded with the newest
//!   generation seen. The next time that connection can be delivered to, it
//!   is sent `RuntimeNotice::ResyncRequired { reason: RuntimeRecovered }`
//!   naming that generation **and then the notice in hand** — the marker
//!   never replaces a notice. That matters because a resync only says
//!   "re-read at generation N": it cannot stand in for a `ConfigChanged`,
//!   whose zone no generation contains, nor for the final
//!   `live_state: stopped`, which nothing re-announces. This is the
//!   coordinator's own drop-and-latch, one hop out: see
//!   [`crate::runtime`]'s `emit`, whose `Ok`, `Full` and `Disconnected` arms
//!   this mirrors exactly, and "What a slow stdio client actually meets is
//!   backpressure" in `docs/protocol.md`.
//! * **A gap that cannot be named waits.** While nothing has ever been
//!   committed there is no generation to re-read at. The marker still goes
//!   out, naming nothing, and an observer discards it — so it cannot have
//!   paid the debt, and the latch survives until a marker names a
//!   generation. The same withholding [`crate::subscriptions`] applies, for
//!   the same reason.
//!
//! What this module deliberately does **not** do: convert anything to the
//! wire. A `RuntimeNotice` goes in and a `RuntimeNotice` comes out, and the
//! per-connection [`crate::subscriptions::SubscriptionRegistry`] is still the
//! only place a notice becomes an event. The 64-event per-subscription bound
//! and the 1024-path per-generation bound are therefore untouched.
//!
//! **It does not make the dispatcher's pre-drain reachable either.** A
//! notice this broadcaster delivers arrives as a `ServerInput::Notice` like
//! any other, through the same forwarder, and is drained inside the same
//! arm — including the synthetic marker that precedes a dropped one. So the
//! Request arm's pre-drain stays defensive: what actually keeps
//! "already-queued events reach the client before the response that ends the
//! subscription" true is drain-to-completion inside the Notice arm. The
//! pre-drain becomes load-bearing the day something enqueues outside that
//! arm, or the day `drain` can return with a queue still non-empty — and
//! that day it is owed a test of its own.

use std::collections::BTreeMap;
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

impl std::fmt::Display for ConnectionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "conn-{}", self.0)
    }
}

/// What one connection is owed after a drop.
///
/// One type rather than a flag beside an `Option`, so "owed but not yet
/// nameable" cannot be confused with "nothing owed" — by this module or by a
/// test reading [`Broadcaster::gap_of`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Gap {
    /// Nothing was dropped. The connection has seen every notice.
    None,
    /// A notice was dropped before anything was ever committed, so there is
    /// no generation to re-read at yet. The debt stands until one exists.
    Owed,
    /// A notice was dropped, and this is the newest generation seen since.
    Named(Generation),
}

/// The debt a drop leaves, given the newest generation it can name.
fn owing(generation: Option<Generation>) -> Gap {
    match generation {
        Some(generation) => Gap::Named(generation),
        None => Gap::Owed,
    }
}

impl Gap {
    fn is_owed(self) -> bool {
        !matches!(self, Gap::None)
    }

    fn generation(self) -> Option<Generation> {
        match self {
            Gap::Named(generation) => Some(generation),
            Gap::None | Gap::Owed => None,
        }
    }
}

/// One connection's inbox, and the gap it has not been told about.
struct Registered {
    sink: SyncSender<RuntimeNotice>,
    gap: Gap,
}

#[derive(Default)]
struct Registry {
    next: u64,
    connections: BTreeMap<u64, Registered>,
    /// Has the fan-out loop ended and closed every inbox?
    ///
    /// Without this, a connection accepted in the window between the runtime's
    /// notice channel ending and the daemon stopping would be registered into
    /// a registry nothing will ever clear again — and its forwarder thread
    /// blocks in `recv` on an inbox whose sender no longer has an owner that
    /// will drop it, so that connection could never be joined. Latched rather
    /// than inferred from an empty map, because a registry with no connections
    /// in it is also the state of a daemon that has simply had no clients yet.
    closed: bool,
}

/// The fan-out. One per daemon, shared by `Arc`.
pub struct Broadcaster {
    registry: Mutex<Registry>,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
}

/// The generation a notice names, if it names one. `ConfigChanged` names none
/// by design: the configuration zone is not indexed, so no generation
/// contains it.
fn notice_generation(notice: &RuntimeNotice) -> Option<Generation> {
    match notice {
        RuntimeNotice::Generation(report) => Some(report.generation),
        RuntimeNotice::State { generation, .. } => *generation,
        RuntimeNotice::ResyncRequired { generation, .. } => *generation,
        RuntimeNotice::ConfigChanged { .. } => None,
    }
}

/// The later of two generations. `Option`'s own ordering does the work:
/// `None` is below every `Some`, so an absent generation never wins.
fn newest(left: Option<Generation>, right: Option<Generation>) -> Option<Generation> {
    left.max(right)
}

impl Registered {
    /// Deliver one notice, mirroring the coordinator's `emit` arm for arm:
    /// the marker first when a gap is owed, then the notice in hand.
    fn deliver(&mut self, notice: &RuntimeNotice, incoming: Option<Generation>) {
        if self.gap.is_owed() {
            let generation = newest(self.gap.generation(), incoming);
            match self.sink.try_send(RuntimeNotice::ResyncRequired {
                generation,
                reason: ResyncReason::RuntimeRecovered,
            }) {
                // The debt is only paid if the announcement can be acted on,
                // and an observer can only act on one that names a
                // generation. Clearing the latch on a marker naming nothing
                // would spend the only record that a gap ever happened on a
                // notice nobody can use, and nothing else re-arms it.
                Ok(()) => {
                    self.gap = if generation.is_none() {
                        Gap::Owed
                    } else {
                        Gap::None
                    };
                }
                // No room even for the marker. The notice in hand is lost
                // with it, and the debt grows to name it.
                Err(TrySendError::Full(_)) => {
                    self.gap = owing(generation);
                    return;
                }
                // The dispatcher has ended. Nothing to announce to it.
                Err(TrySendError::Disconnected(_)) => {
                    self.gap = Gap::None;
                    return;
                }
            }
        }
        match self.sink.try_send(notice.clone()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.gap = owing(newest(self.gap.generation(), incoming));
            }
            // The dispatcher has ended. Nothing to latch for a connection
            // that is already closing.
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

impl Broadcaster {
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
        }
    }

    /// A fresh inbox for one connection. The receiver is handed straight to
    /// the connection's own serve loop (`crate::connection::serve`, which is
    /// crate-private and so is not linked here).
    ///
    /// **After the fan-out has ended the inbox comes back already closed.**
    /// A connection accepted in that window is still served — it can answer
    /// every request — but there are no more notices to give it, and handing
    /// it a live inbox nothing would ever close would leave its notice
    /// forwarder blocked in `recv` for the life of the process, so the
    /// connection could never be joined. Closing it up front makes that
    /// connection's forwarder see end of notices immediately, exactly as
    /// every other connection's does when the runtime stops.
    pub fn register(&self) -> (ConnectionId, Receiver<RuntimeNotice>) {
        let (sink, inbox) = sync_channel(CONNECTION_NOTICE_CAPACITY);
        let mut registry = self.lock();
        registry.next += 1;
        let id = registry.next;
        if registry.closed {
            // `sink` is dropped here, with nothing inserted: the receiver is
            // already disconnected when the caller gets it.
            return (ConnectionId(id), inbox);
        }
        registry.connections.insert(
            id,
            Registered {
                sink,
                gap: Gap::None,
            },
        );
        (ConnectionId(id), inbox)
    }

    /// Drop one connection's inbox. Idempotent.
    pub fn unregister(&self, id: ConnectionId) {
        self.lock().connections.remove(&id.0);
    }

    pub fn connection_count(&self) -> usize {
        self.lock().connections.len()
    }

    /// Offer one notice to every registered connection, without ever
    /// blocking.
    ///
    /// A connection whose inbox is closed — its dispatcher has ended but its
    /// `after_dispatch` has not run yet — is left registered rather than
    /// removed here: removal belongs to the connection itself, and doing it
    /// from the fan-out would race that.
    pub fn offer(&self, notice: &RuntimeNotice) {
        let mut registry = self.lock();
        let incoming = notice_generation(notice);
        for registered in registry.connections.values_mut() {
            registered.deliver(notice, incoming);
        }
    }

    /// Close every inbox by dropping every sender.
    ///
    /// This is how end of notices reaches each connection: a dispatcher's
    /// `forward_notices` returns only when its receiver's senders are gone,
    /// so without this the broadcaster would absorb the signal that the
    /// runtime's channel has closed and every forwarder would block forever.
    ///
    /// Latched, so a connection registering after this point is handed an
    /// inbox that is already closed rather than one nothing will ever close.
    ///
    /// Called by the fan-out when the runtime's notices end, and by
    /// `Service::stop` straight after it has offered the `stopped` notice: a
    /// buffered notice is still delivered after its sender goes, so closing
    /// there is what turns "a notice is somewhere on its way" into "this
    /// notice, and then the end".
    pub(crate) fn close(&self) {
        let mut registry = self.lock();
        registry.closed = true;
        registry.connections.clear();
    }

    /// What this connection is owed, or `None` if no such connection is
    /// registered. Test-only: nothing on the wire distinguishes a latched gap
    /// from no gap until the marker is delivered.
    #[cfg(test)]
    pub fn gap_of(&self, id: ConnectionId) -> Option<Gap> {
        let registry = self.lock();
        registry
            .connections
            .get(&id.0)
            .map(|registered| registered.gap)
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Feed `broadcaster` from the runtime's notice channel until the coordinator
/// drops its sender, then close every inbox. Returns the thread, which the
/// service joins at shutdown.
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
            broadcaster.close();
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc::{Receiver, sync_channel};
    use std::time::Duration;

    use vault_core::VaultPath;
    use vault_index::{
        ChangeCause, Generation, LiveRefreshReport, LiveState, NoteChangeCounts, PathChanges,
        ReconcileMetrics,
    };
    use vault_protocol::RuntimeEventDto;

    use super::*;
    use crate::runtime::{ResyncReason, RuntimeNotice};

    /// How long a test waits for another thread before calling it wedged.
    /// Generous: it is a failure bound, not a timing assertion.
    const PATIENCE: Duration = Duration::from_secs(10);

    fn state_at(generation: u64) -> RuntimeNotice {
        RuntimeNotice::State {
            generation: Some(Generation::new(generation)),
            state: LiveState::Watching,
            error: None,
        }
    }

    /// A notice that names no generation, because nothing has been committed.
    fn ungenerated() -> RuntimeNotice {
        RuntimeNotice::State {
            generation: None,
            state: LiveState::CatchingUp,
            error: None,
        }
    }

    fn config_changed(path: &str) -> RuntimeNotice {
        RuntimeNotice::ConfigChanged {
            path: VaultPath::new(path).expect("vault path"),
        }
    }

    /// The notice a published generation actually emits — the common case in
    /// the field, and the one whose generation the latch must be able to
    /// name. Shaped like `tests/subscriptions.rs`'s own helper.
    fn generation_notice(generation: u64) -> RuntimeNotice {
        RuntimeNotice::Generation(Box::new(LiveRefreshReport {
            previous_generation: generation.checked_sub(1).map(Generation::new),
            generation: Generation::new(generation),
            cause: ChangeCause::Watcher,
            changes: PathChanges {
                created: Vec::new(),
                modified: Vec::new(),
                deleted: Vec::new(),
            },
            note_changes: NoteChangeCounts {
                created: 0,
                modified: 0,
                deleted: 0,
            },
            affected_reference_count: 0,
            complete_resolution: false,
            metrics: ReconcileMetrics::default(),
        }))
    }

    /// Everything waiting in an inbox, in delivery order.
    fn drain_inbox(inbox: &Receiver<RuntimeNotice>) -> Vec<RuntimeNotice> {
        let mut seen = Vec::new();
        while let Ok(notice) = inbox.try_recv() {
            seen.push(notice);
        }
        seen
    }

    /// Fill one connection's inbox and then overflow it by one, so a gap is
    /// latched naming `CONNECTION_NOTICE_CAPACITY + 1`.
    fn overflow_with_states(broadcaster: &Broadcaster) -> u64 {
        let overflow = CONNECTION_NOTICE_CAPACITY as u64 + 1;
        for generation in 1..=overflow {
            broadcaster.offer(&state_at(generation));
        }
        overflow
    }

    fn assert_marker_naming(notice: &RuntimeNotice, generation: u64) {
        match notice {
            RuntimeNotice::ResyncRequired {
                generation: named,
                reason,
            } => {
                assert_eq!(
                    *reason,
                    ResyncReason::RuntimeRecovered,
                    "the drop-and-latch reason"
                );
                assert_eq!(
                    named.map(Generation::get),
                    Some(generation),
                    "the marker names the newest generation, not the one that \
                     was dropped"
                );
            }
            other => panic!("the gap was never announced: {other:?}"),
        }
    }

    /// Two connections, one of which has stopped draining. The one that reads
    /// must be unaffected — that is the whole point of per-connection
    /// queues — and the one that did not must learn it has a gap rather than
    /// silently missing generations.
    #[test]
    fn a_full_inbox_costs_its_own_connection_a_resync_and_costs_its_peer_nothing() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();
        let (fast, fast_inbox) = broadcaster.register();

        // Fill the slow connection's inbox to its brim, reading nothing. The
        // fast connection reads each notice as it is offered, which is the
        // only thing that makes it fast: its inbox is bounded at the same
        // depth, so a fast connection that stopped reading would simply be a
        // second slow one.
        let mut fast_seen = Vec::new();
        for generation in 1..=CONNECTION_NOTICE_CAPACITY as u64 {
            broadcaster.offer(&state_at(generation));
            fast_seen.push(fast_inbox.recv().expect("the fast inbox has a notice"));
        }
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::None),
            "no gap while it fits"
        );

        // The next one cannot fit in the slow inbox. It is dropped there and
        // latched; the fast inbox takes it as usual.
        let overflow = CONNECTION_NOTICE_CAPACITY as u64 + 1;
        broadcaster.offer(&state_at(overflow));
        fast_seen.push(fast_inbox.recv().expect("the fast inbox has a notice"));
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Named(Generation::new(overflow))),
            "the gap names the newest generation it has seen"
        );

        // The fast connection is untouched: every notice, in order, no resync.
        assert_eq!(fast_seen.len(), overflow as usize);
        for (index, notice) in fast_seen.iter().enumerate() {
            match notice {
                RuntimeNotice::State {
                    generation: seen, ..
                } => assert_eq!(
                    seen.map(Generation::get),
                    Some(index as u64 + 1),
                    "a peer's full queue must not disturb this connection's stream"
                ),
                other => panic!("the fast connection saw something else: {other:?}"),
            }
        }
        assert_eq!(
            broadcaster.gap_of(fast),
            Some(Gap::None),
            "the peer's overflow latched nothing here"
        );

        // The slow connection drains two slots — one for the marker, one for
        // the notice it precedes — and the next offer delivers both.
        let drained = slow_inbox.recv().expect("the slow inbox has a notice");
        assert!(
            matches!(drained, RuntimeNotice::State { .. }),
            "queued detail first"
        );
        slow_inbox
            .recv()
            .expect("the slow inbox has a second notice");
        broadcaster.offer(&state_at(overflow + 1));
        let seen = drain_inbox(&slow_inbox);
        let tail = &seen[seen.len() - 2..];
        assert_marker_naming(&tail[0], overflow + 1);
        match &tail[1] {
            RuntimeNotice::State { generation, .. } => assert_eq!(
                generation.map(Generation::get),
                Some(overflow + 1),
                "the marker precedes the notice in hand, it never replaces it"
            ),
            other => panic!("the notice in hand was swallowed: {other:?}"),
        }
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::None),
            "the gap is cleared once it has been announced"
        );

        broadcaster.unregister(slow);
        broadcaster.unregister(fast);
        assert_eq!(broadcaster.connection_count(), 0);
    }

    /// A drop with nothing committed yet cannot name a generation, so the
    /// debt stands rather than being paid — the same withholding the
    /// subscription registry does, and for the same reason: an event naming
    /// no generation to re-read at tells a client nothing.
    #[test]
    fn a_gap_with_no_generation_yet_waits_for_one_that_has() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();
        for _ in 0..=CONNECTION_NOTICE_CAPACITY {
            broadcaster.offer(&ungenerated());
        }
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Owed),
            "owed, but unnameable"
        );

        // Drain everything, then offer one that does name a generation.
        drain_inbox(&slow_inbox);
        broadcaster.offer(&state_at(7));
        let seen = drain_inbox(&slow_inbox);
        assert_marker_naming(&seen[0], 7);
        assert!(
            matches!(&seen[1], RuntimeNotice::State { .. }),
            "the notice in hand follows the marker"
        );
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::None),
            "naming it is what pays the debt"
        );
    }

    /// The step the two tests above skip: an unnameable notice arriving
    /// *between* the drop and the first one that can name a generation.
    ///
    /// The marker still goes out — the coordinator sends one too — but it
    /// names nothing, an observer discards it, and so it cannot have paid
    /// anything. Clearing the latch on any successful send loses the gap
    /// permanently, because nothing re-arms it.
    #[test]
    fn an_unnameable_notice_does_not_pay_a_debt_it_cannot_name() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();
        for _ in 0..=CONNECTION_NOTICE_CAPACITY {
            broadcaster.offer(&ungenerated());
        }
        assert_eq!(broadcaster.gap_of(slow), Some(Gap::Owed));
        drain_inbox(&slow_inbox);

        broadcaster.offer(&ungenerated());
        let between = drain_inbox(&slow_inbox);
        assert!(
            matches!(
                between[0],
                RuntimeNotice::ResyncRequired {
                    generation: None,
                    ..
                }
            ),
            "a marker that names nothing is still sent, as the coordinator sends it"
        );
        assert!(
            matches!(between[1], RuntimeNotice::State { .. }),
            "and the notice in hand still follows it"
        );
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Owed),
            "a marker an observer must discard cannot have paid the debt"
        );

        drain_inbox(&slow_inbox);
        broadcaster.offer(&state_at(7));
        let seen = drain_inbox(&slow_inbox);
        assert_marker_naming(&seen[0], 7);
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::None),
            "the debt outlived the notice that could not name it"
        );
    }

    /// The marker precedes, it never replaces. Two notices prove it, because
    /// they are the two a resync cannot stand in for: a configuration change
    /// names a zone no generation contains, and the final `stopped` state is
    /// the daemon's last word and is never re-announced.
    #[test]
    fn the_marker_precedes_a_config_change_and_a_stopped_state() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, slow_inbox) = broadcaster.register();

        let overflow = overflow_with_states(&broadcaster);
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Named(Generation::new(overflow)))
        );
        drain_inbox(&slow_inbox);

        broadcaster.offer(&config_changed("config/vaultd.toml"));
        let seen = drain_inbox(&slow_inbox);
        assert_marker_naming(&seen[0], overflow);
        match &seen[1] {
            RuntimeNotice::ConfigChanged { path } => assert_eq!(
                path.as_str(),
                "config/vaultd.toml",
                "no later notice re-announces a configuration change"
            ),
            other => panic!("the configuration change was swallowed: {other:?}"),
        }

        // Latch a second gap, then send the one notice a client cannot
        // afford to lose.
        let overflow = overflow_with_states(&broadcaster);
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Named(Generation::new(overflow)))
        );
        drain_inbox(&slow_inbox);

        broadcaster.offer(&RuntimeNotice::State {
            generation: None,
            state: LiveState::Stopped,
            error: None,
        });
        let seen = drain_inbox(&slow_inbox);
        assert_marker_naming(&seen[0], overflow);
        match &seen[1] {
            RuntimeNotice::State { state, .. } => assert_eq!(
                *state,
                LiveState::Stopped,
                "the daemon's last word survives the gap"
            ),
            other => panic!("the stopped state was swallowed: {other:?}"),
        }
    }

    /// `RuntimeNotice::Generation` is what a published generation emits, so
    /// it is the notice whose generation the latch will name in the field.
    /// The `State` notices the other tests use would not catch a
    /// `notice_generation` that forgot this arm.
    #[test]
    fn the_latch_names_the_generation_of_a_generation_notice() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (slow, _slow_inbox) = broadcaster.register();
        for generation in 1..=CONNECTION_NOTICE_CAPACITY as u64 {
            broadcaster.offer(&generation_notice(generation));
        }
        assert_eq!(broadcaster.gap_of(slow), Some(Gap::None));

        let overflow = CONNECTION_NOTICE_CAPACITY as u64 + 1;
        broadcaster.offer(&generation_notice(overflow));
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Gap::Named(Generation::new(overflow))),
            "a dropped generation notice must still be nameable"
        );
    }

    /// The thread itself, end to end: a notice put into the runtime's channel
    /// comes out of a registered inbox unchanged.
    #[test]
    fn the_fan_out_thread_carries_a_notice_from_the_runtime_channel_to_an_inbox() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (_id, inbox) = broadcaster.register();
        let (notices, receiver) = sync_channel(4);
        let fanout =
            spawn_fanout(Arc::clone(&broadcaster), receiver).expect("the fan-out thread starts");

        notices
            .send(generation_notice(9))
            .expect("the runtime channel takes it");
        match inbox
            .recv_timeout(PATIENCE)
            .expect("the notice reached the inbox")
        {
            RuntimeNotice::Generation(report) => {
                assert_eq!(report.generation, Generation::new(9));
            }
            other => panic!("something else arrived: {other:?}"),
        }

        drop(notices);
        fanout
            .join()
            .expect("the fan-out thread ends with its channel");
    }

    /// End of notices must reach every dispatcher. `forward_notices` returns
    /// only when its receiver's senders are gone, so the broadcaster has to
    /// drop them when the runtime's channel closes — otherwise it absorbs the
    /// signal and every forwarder blocks forever, including after a
    /// coordinator panic.
    #[test]
    fn the_fan_out_closes_every_inbox_when_the_runtime_channel_ends() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (_id, inbox) = broadcaster.register();
        let (notices, receiver) = sync_channel(1);
        let fanout =
            spawn_fanout(Arc::clone(&broadcaster), receiver).expect("the fan-out thread starts");

        drop(notices);
        fanout
            .join()
            .expect("the fan-out thread ends with its channel");

        assert!(
            inbox.recv().is_err(),
            "the inbox is closed, so a dispatcher's forwarder sees end of notices"
        );
        assert_eq!(
            broadcaster.connection_count(),
            0,
            "and nothing is left registered"
        );
    }

    /// The accept loop outlives the fan-out: the runtime's notice channel can
    /// end while the listener is still answering, so a client may connect
    /// after the last notice has been handed out. That connection must be
    /// given an inbox that is **already** closed. A live one would leave its
    /// notice forwarder parked in `recv` forever, because nothing clears the
    /// registry a second time, and the service could then never join that
    /// connection's threads.
    #[test]
    fn a_connection_registering_after_the_fan_out_ended_is_given_a_closed_inbox() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (notices, receiver) = sync_channel(1);
        let fanout =
            spawn_fanout(Arc::clone(&broadcaster), receiver).expect("the fan-out thread starts");
        drop(notices);
        fanout
            .join()
            .expect("the fan-out thread ends with its channel");

        let (late, inbox) = broadcaster.register();

        assert!(
            matches!(
                inbox.recv_timeout(PATIENCE),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            ),
            "a connection registered after the fan-out ended must see end of \
             notices at once, not wait for a close that will never come"
        );
        assert_eq!(
            broadcaster.connection_count(),
            0,
            "and it was never put in the registry, so no later offer can \
             reach a sender nobody owns"
        );
        assert_eq!(
            broadcaster.gap_of(late),
            None,
            "an unregistered connection owes nothing and is owed nothing"
        );
    }

    /// The marker's own `Full` arm. A connection that is already owed a
    /// resync, and whose inbox is *still* full, cannot even be told about the
    /// debt — so the debt must survive the attempt and grow to name the
    /// newest generation. Losing it here would silently downgrade a client
    /// from "you missed something" to "you are current".
    #[test]
    fn a_debt_survives_an_offer_that_cannot_even_fit_the_marker() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (id, inbox) = broadcaster.register();
        let overflow = overflow_with_states(&broadcaster);
        assert_eq!(
            broadcaster.gap_of(id),
            Some(Gap::Named(Generation::new(overflow))),
            "the overflow latched a gap"
        );

        // Nothing has been read, so the inbox is still brim full and the
        // marker has nowhere to go either.
        let later = overflow + 1;
        broadcaster.offer(&state_at(later));

        assert_eq!(
            broadcaster.gap_of(id),
            Some(Gap::Named(Generation::new(later))),
            "the debt survives, and names the newest generation it has seen"
        );
        let waiting = drain_inbox(&inbox);
        assert_eq!(
            waiting.len(),
            CONNECTION_NOTICE_CAPACITY,
            "nothing was delivered: not the notice, and not the marker either"
        );
        assert!(
            !waiting
                .iter()
                .any(|notice| matches!(notice, RuntimeNotice::ResyncRequired { .. })),
            "a marker that could not be sent was not sent"
        );
    }

    /// The marker's `Disconnected` arm. A dispatcher that has ended cannot be
    /// told anything, so the debt is dropped rather than carried — and the
    /// offer must return normally rather than panicking on a dead sender.
    #[test]
    fn a_debt_owed_to_a_dispatcher_that_ended_is_forgotten_rather_than_carried() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (id, inbox) = broadcaster.register();
        let overflow = overflow_with_states(&broadcaster);
        assert_eq!(
            broadcaster.gap_of(id),
            Some(Gap::Named(Generation::new(overflow))),
            "the overflow latched a gap"
        );

        // The connection ends. Its `after_dispatch` has not unregistered it
        // yet, which is exactly the window this arm exists for.
        drop(inbox);
        broadcaster.offer(&state_at(overflow + 1));

        assert_eq!(
            broadcaster.gap_of(id),
            Some(Gap::None),
            "there is nobody left to announce a gap to"
        );
    }

    /// "Never blocks" is this module's first claim, and a blocking send would
    /// otherwise show up as an unbounded hang rather than a failure. Bound it
    /// so the mutation is red instead of eternal.
    #[test]
    fn offer_returns_rather_than_blocking_on_a_full_inbox() {
        let broadcaster = Arc::new(Broadcaster::new());
        let (_id, inbox) = broadcaster.register();
        for generation in 1..=CONNECTION_NOTICE_CAPACITY as u64 {
            broadcaster.offer(&state_at(generation));
        }

        let (done, finished) = sync_channel(1);
        let offering = Arc::clone(&broadcaster);
        let offerer = std::thread::spawn(move || {
            offering.offer(&state_at(CONNECTION_NOTICE_CAPACITY as u64 + 1));
            done.send(()).ok();
        });
        finished
            .recv_timeout(PATIENCE)
            .expect("offer returned rather than blocking on a full inbox");
        offerer.join().expect("the offering thread ends");
        drop(inbox);
    }

    /// A notice that reaches a connection through the broadcaster becomes
    /// events in that connection's registry, and draining empties the queue
    /// however many are waiting.
    ///
    /// **What this does not pin:** the Request arm's pre-drain. It cannot —
    /// it does not call `connection::dispatch`, and the branch that would
    /// make the pre-drain load-bearing is `drain`'s early return when the
    /// writer is gone, which lives there. `tests/live_stdio.rs` is what goes
    /// red if `drain` stops draining to completion. What is pinned here is
    /// the link the module header claims: broadcaster to registry, more than
    /// one event, in order, nothing left behind.
    #[test]
    fn a_broadcast_notice_becomes_events_a_single_drain_empties() {
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

        // Configuration changes, because each becomes exactly one event and
        // none of them collapses into another — so the count and the order
        // below mean what they say.
        let paths = ["config/a.toml", "config/b.toml", "config/c.toml"];
        for path in paths {
            broadcaster.offer(&config_changed(path));
        }

        // Enqueue all three before draining any, so the queue genuinely holds
        // more than one event and "to completion" has something to mean.
        for _ in paths {
            let notice = inbox.recv_timeout(PATIENCE).expect("the notice arrived");
            registry.enqueue_notice(notice);
        }
        assert_eq!(
            registry.queue_len(&subscribed.subscription_id),
            Some(paths.len()),
            "the queue really held every one of them"
        );

        let mut drained = Vec::new();
        while let Some(envelope) = registry.pop_event() {
            match envelope.event {
                RuntimeEventDto::ConfigChanged(changed) => drained.push(changed.path),
                other => panic!("an unexpected event was queued: {other:?}"),
            }
        }

        assert_eq!(
            drained, paths,
            "every queued event was delivered, in order, not just the first"
        );
        assert_eq!(
            registry.queue_len(&subscribed.subscription_id),
            Some(0),
            "and the queue is empty before the next input is considered"
        );
    }
}
