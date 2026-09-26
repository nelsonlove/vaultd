//! One notice stream, many connections.
//!
//! The runtime has exactly one notice channel and `--listen` gives it many readers, so one thread owns the receiving end and clones each notice into every connection's own bounded inbox. Three properties, each the reason for the one before it:
//!
//! * **The broadcaster never blocks.** Not on a full inbox — it drops — and not on the coordinator, which it only receives from. So no client, however slow or however dead, can stall indexing. That is the invariant the stdio design states, preserved across any number of clients.
//! * **A drop is latched, never silent.** The connection whose inbox was full has its gap recorded with the newest generation seen, and the next notice that connection could be given is **replaced** by `RuntimeNotice::ResyncRequired { reason: RuntimeRecovered }` naming that generation. This is the coordinator's own drop-and-latch, one hop out: see "What a slow stdio client actually meets is backpressure" in `docs/protocol.md`.
//! * **A gap that cannot be named waits.** While nothing has ever been committed there is no generation to re-read at, so the marker is owed and is emitted by the first notice that does name one — the same withholding [`crate::subscriptions`] applies, for the same reason.
//!
//! What this module deliberately does **not** do: convert anything to the wire. A `RuntimeNotice` goes in and a `RuntimeNotice` comes out, and the per-connection [`crate::subscriptions::SubscriptionRegistry`] is still the only place a notice becomes an event. The 64-event per-subscription bound and the 1024-path per-generation bound are therefore untouched.
//!
//! **It does not make the dispatcher's pre-drain reachable either.** A notice this broadcaster delivers arrives as a `ServerInput::Notice` like any other, through the same forwarder, and is drained inside the same arm — including the synthetic `resync_required` that replaces a dropped one. So the Request arm's pre-drain stays defensive: what actually keeps "already-queued events reach the client before the response that ends the subscription" true is drain-to-completion inside the Notice arm. The pre-drain becomes load-bearing the day something enqueues outside that arm, or the day `drain` can return with a queue still non-empty — and that day it is owed a test of its own.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use vault_index::Generation;

use crate::runtime::{ResyncReason, RuntimeNotice};

/// How many notices may wait for one connection's dispatcher.
///
/// The same depth as the coordinator's own notice channel and as the dispatcher's input queue, and for the same reason: deep enough that an ordinary burst never costs anyone a resync, shallow enough that a connection which has stopped reading is felt rather than buffered.
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
    /// Whether a drop is outstanding at all. Separate from `gap` because a drop before the first commit has no generation and must still be owed.
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
    /// Read without taking the lock by the accept loop's diagnostics, and kept in step inside it.
    count: AtomicU64,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
}

/// The generation a notice names, if it names one. `ConfigChanged` names none by design: the configuration zone is not indexed, so no generation contains it.
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
        (Some(left), Some(right)) => Some(if left.get() >= right.get() {
            left
        } else {
            right
        }),
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

    /// A fresh inbox for one connection. The receiver is handed straight to [`crate::connection::serve`].
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
    /// A connection whose inbox is closed — its dispatcher has ended but its `after_dispatch` has not run yet — is left registered rather than removed here: removal belongs to the connection itself, and doing it from the fan-out would race that.
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

    /// How many notices this connection has had dropped since it was last told, as a generation. Test-only: nothing on the wire distinguishes a latched gap from no gap until the resync is delivered.
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

/// Feed `broadcaster` from the runtime's notice channel until the coordinator drops its sender. Returns the thread, which the service joins at shutdown.
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

    /// Two connections, one of which has stopped draining. The one that reads must be unaffected — that is the whole point of per-connection queues — and the one that did not must learn it has a gap rather than silently missing generations.
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
        assert_eq!(broadcaster.gap_of(slow), Some(None), "no gap while it fits");

        // The next one cannot fit in the slow inbox. It is dropped there and
        // latched; the fast inbox takes it as usual.
        let overflow = CONNECTION_NOTICE_CAPACITY as u64 + 1;
        broadcaster.offer(&state_at(overflow));
        fast_seen.push(fast_inbox.recv().expect("the fast inbox has a notice"));
        assert_eq!(
            broadcaster.gap_of(slow),
            Some(Some(overflow)),
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
            Some(None),
            "the peer's overflow latched nothing here"
        );

        // The slow connection drains one slot, and the next notice it can be
        // given is replaced by the resync that announces the gap.
        let drained = slow_inbox.recv().expect("the slow inbox has a notice");
        assert!(
            matches!(drained, RuntimeNotice::State { .. }),
            "queued detail first"
        );
        broadcaster.offer(&state_at(overflow + 1));
        let mut seen = Vec::new();
        while let Ok(notice) = slow_inbox.try_recv() {
            seen.push(notice);
        }
        let last = seen.last().expect("the slow inbox received something");
        match last {
            RuntimeNotice::ResyncRequired { generation, reason } => {
                assert_eq!(
                    *reason,
                    ResyncReason::RuntimeRecovered,
                    "the drop-and-latch reason"
                );
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

    /// A drop with nothing committed yet cannot name a generation, so the resync is owed rather than emitted — the same withholding the subscription registry does, and for the same reason: an event naming no generation to re-read at tells a client nothing.
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

    /// The invariant the pre-drain is *said* to defend, asserted where it actually holds: a notice that reaches a connection through the broadcaster is drained to completion inside the arm that took it, so the registry is empty again before the next input is considered.
    ///
    /// This is what makes the Request arm's pre-drain defensive rather than load-bearing, and it is the test that goes red if a future change queues an event and does not drain it — at which point the pre-drain's comment becomes true and its own test is owed.
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
}
