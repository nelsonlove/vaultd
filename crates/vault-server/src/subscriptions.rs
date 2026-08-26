//! Bounded per-subscriber event queues.
//!
//! The registry is the whole boundary between runtime notices and the wire:
//! it is the only place a [`RuntimeNotice`] becomes a
//! [`vault_protocol::EventEnvelope`], and the only place a slow client can
//! cost anything. Nothing here blocks, allocates without a ceiling, or talks
//! to the runtime.
//!
//! Three bounds hold at once, and every one of them degrades into a marker
//! rather than a loss:
//!
//! * **Per-subscriber queue depth** — at most [`SUBSCRIBER_CAPACITY`]
//!   events. A subscriber that stops draining has its queued generation
//!   detail collapsed onto one `resync_required { subscriber_lag }` naming
//!   the newest generation; the newest runtime-state event survives, because
//!   state is a level rather than an edge.
//! * **Per-generation change-set detail** — at most [`DETAILED_PATH_LIMIT`]
//!   paths. A larger generation is reported as counts, followed by
//!   `resync_required { oversized_change_set }`.
//! * **Subscriber independence** — every queue is private, so one client
//!   that never reads its stdout can neither stall the runtime nor delay a
//!   peer subscription.
//!
//! One rule is about meaning rather than size: `resync_required` tells a
//! client the generation it must re-read at, so it is withheld entirely
//! while no generation has ever been committed. The first resync that does
//! carry a generation — which, after a cold build, is the runtime's own
//! `RuntimeRecovered` escalation at generation 1 — supersedes every withheld
//! predecessor.

use std::collections::{BTreeMap, VecDeque};

use vault_index::{ChangeCause, LiveRefreshReport, LiveState, PathChanges, PublishedStatus};
use vault_protocol::{
    ChangeSetDto, ErrorCode, EventEnvelope, GenerationCauseDto, GenerationCommittedEventDto,
    LiveStateDto, ProtocolError, ResyncReasonDto, ResyncRequiredEventDto, RuntimeEventDto,
    RuntimeStateChangedEventDto, SubscribeEventsResponse, UnsubscribeResponse,
};

use crate::runtime::{ResyncReason, RuntimeNotice};

/// The deepest one subscriber's queue may ever be. Past this, incremental
/// detail is collapsed onto a single resync marker.
pub const SUBSCRIBER_CAPACITY: usize = 64;

/// The largest change set carried as explicit paths. Past this, the
/// generation is reported as counts plus a resync marker.
pub const DETAILED_PATH_LIMIT: usize = 1_024;

pub(crate) fn live_state(value: LiveState) -> LiveStateDto {
    match value {
        LiveState::Starting => LiveStateDto::Starting,
        LiveState::CatchingUp => LiveStateDto::CatchingUp,
        LiveState::Watching => LiveStateDto::Watching,
        LiveState::PollingFallback => LiveStateDto::PollingFallback,
        LiveState::Stopped => LiveStateDto::Stopped,
    }
}

fn generation_cause(value: ChangeCause) -> GenerationCauseDto {
    match value {
        ChangeCause::Watcher => GenerationCauseDto::Watcher,
        ChangeCause::Startup => GenerationCauseDto::Startup,
        ChangeCause::Periodic => GenerationCauseDto::Periodic,
        ChangeCause::Manual => GenerationCauseDto::Manual,
        ChangeCause::Verified => GenerationCauseDto::Verified,
    }
}

/// Every runtime reason keeps its own spelling. `SubscriberLag` and
/// `OversizedChangeSet` are deliberately unreachable from here: no runtime
/// notice carries them, because both describe something this registry did.
fn resync_reason(value: ResyncReason) -> ResyncReasonDto {
    match value {
        ResyncReason::WatcherOverflow => ResyncReasonDto::WatcherOverflow,
        ResyncReason::RootInvalidated => ResyncReasonDto::RootInvalidated,
        ResyncReason::RuntimeRecovered => ResyncReasonDto::RuntimeRecovered,
    }
}

fn path_strings(paths: &[vault_core::VaultPath]) -> Vec<String> {
    paths.iter().map(|path| path.as_str().to_string()).collect()
}

fn change_set_total(changes: &PathChanges) -> usize {
    changes.created.len() + changes.modified.len() + changes.deleted.len()
}

/// One committed generation as a client sees it, plus the marker its size
/// obliges. `affected_note_count` is the semantic change set's own size, so
/// it agrees with the counts-only summary whichever form the detail takes.
fn generation_events(report: &LiveRefreshReport) -> Vec<RuntimeEventDto> {
    let total = change_set_total(&report.changes);
    let oversized = total > DETAILED_PATH_LIMIT;
    let changes = if oversized {
        ChangeSetDto::CountsOnly {
            created: report.changes.created.len() as u64,
            modified: report.changes.modified.len() as u64,
            deleted: report.changes.deleted.len() as u64,
        }
    } else {
        ChangeSetDto::Detailed {
            created: path_strings(&report.changes.created),
            modified: path_strings(&report.changes.modified),
            deleted: path_strings(&report.changes.deleted),
        }
    };
    let mut events = vec![RuntimeEventDto::GenerationCommitted(
        GenerationCommittedEventDto {
            previous_generation: report.previous_generation.map(vault_index::Generation::get),
            generation: report.generation.get(),
            cause: generation_cause(report.cause),
            changes,
            affected_note_count: total as u64,
            affected_reference_count: report.affected_reference_count,
        },
    )];
    if oversized {
        events.push(RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
            current_generation: Some(report.generation.get()),
            reason: ResyncReasonDto::OversizedChangeSet,
        }));
    }
    events
}

/// Turn one runtime notice into the events a subscriber should see. An empty
/// result is a deliberate withholding, never a dropped notice.
fn events_for(notice: &RuntimeNotice) -> Vec<RuntimeEventDto> {
    match notice {
        RuntimeNotice::Generation(report) => generation_events(report),
        RuntimeNotice::State {
            generation,
            state,
            error,
        } => vec![RuntimeEventDto::RuntimeStateChanged(
            RuntimeStateChangedEventDto {
                generation: generation.map(vault_index::Generation::get),
                live_state: live_state(*state),
                // Reserved until the runtime carries a typed code; the
                // runtime's own error is display-only today.
                error_code: None,
                message: error.clone(),
            },
        )],
        RuntimeNotice::ResyncRequired { generation, reason } => match generation {
            // Nothing has ever been committed, so there is no generation to
            // re-read at and nothing useful to say yet.
            None => Vec::new(),
            Some(generation) => vec![RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
                current_generation: Some(generation.get()),
                reason: resync_reason(*reason),
            })],
        },
    }
}

/// The generation an event names, if it names one.
fn event_generation(event: &RuntimeEventDto) -> Option<u64> {
    match event {
        RuntimeEventDto::GenerationCommitted(committed) => Some(committed.generation),
        RuntimeEventDto::ResyncRequired(resync) => resync.current_generation,
        RuntimeEventDto::RuntimeStateChanged(_) => None,
    }
}

fn is_state_event(event: &RuntimeEventDto) -> bool {
    matches!(event, RuntimeEventDto::RuntimeStateChanged(_))
}

fn is_lag_marker(event: &RuntimeEventDto) -> bool {
    matches!(
        event,
        RuntimeEventDto::ResyncRequired(resync) if resync.reason == ResyncReasonDto::SubscriberLag
    )
}

fn lag_marker(generation: u64) -> RuntimeEventDto {
    RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
        current_generation: Some(generation),
        reason: ResyncReasonDto::SubscriberLag,
    })
}

fn newest(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (value, None) | (None, value) => value,
    }
}

struct Subscription {
    id: String,
    queue: VecDeque<RuntimeEventDto>,
    /// The generation named by an outstanding `subscriber_lag` marker. While
    /// this is set, incremental detail is not queued at all: it only moves
    /// the marker forward, so a subscriber that never drains costs one
    /// in-place field update per generation instead of one queue entry.
    lagged_at: Option<u64>,
    /// A lag that could not be announced because no generation had ever been
    /// committed. The marker is owed and is emitted by the first generation
    /// that arrives.
    lag_owed: bool,
    /// Whether events may be queued yet. A subscription is reserved
    /// inactive, and is activated only once its `subscribe_events` response
    /// has reached the output stream — which is what makes
    /// "response before event" structural rather than a matter of timing.
    active: bool,
    /// The generation the `subscribe_events` response promised, while any
    /// generation at or below it might still be delivered.
    ///
    /// Activation alone is not enough to make the start point mean anything.
    /// The publication barrier moves *before* the coordinator emits, and the
    /// notice then crosses two bounded queues, so the barrier a subscribe
    /// reads can be several generations ahead of the notices still waiting to
    /// be dispatched. Delivering one of those would run the client's
    /// `previous_generation` chain backwards from the very point it was told
    /// to start at, and a client checking continuity would answer that with a
    /// spurious full re-read.
    ///
    /// Only per-path deltas are filtered. A `resync_required` or
    /// `runtime_state_changed` naming an old generation is still news.
    /// Cleared by the first delta that passes: generations arrive in
    /// coordinator emission order, so nothing after it can be stale.
    started_at: Option<u64>,
}

impl Subscription {
    fn new(id: String, started_at: Option<u64>) -> Self {
        Self {
            id,
            queue: VecDeque::new(),
            lagged_at: None,
            lag_owed: false,
            active: false,
            started_at,
        }
    }

    /// Whether this event describes a generation the client was already told
    /// it starts from — or an earlier one.
    fn is_behind_start(&self, event: &RuntimeEventDto) -> bool {
        match (self.started_at, event) {
            (Some(started_at), RuntimeEventDto::GenerationCommitted(committed)) => {
                committed.generation <= started_at
            }
            _ => false,
        }
    }

    /// Collapse the queue onto at most one state event plus one lag marker.
    ///
    /// Generation detail is discarded rather than truncated: the marker that
    /// replaces it names the newest generation any discarded event named
    /// (including the one that would not fit), so the client re-reads once at
    /// the right point instead of applying a prefix of a delta it cannot
    /// complete.
    fn coalesce(&mut self, incoming: Option<u64>) {
        let newest_state = self
            .queue
            .iter()
            .rev()
            .find(|event| is_state_event(event))
            .cloned();
        let mut generation = newest(self.lagged_at, incoming);
        for event in &self.queue {
            generation = newest(generation, event_generation(event));
        }
        self.queue.clear();
        if let Some(state) = newest_state {
            self.queue.push_back(state);
        }
        match generation {
            Some(generation) => {
                self.queue.push_back(lag_marker(generation));
                self.lagged_at = Some(generation);
                self.lag_owed = false;
            }
            // Nothing committed yet: there is no generation to name, so the
            // marker is owed until one exists.
            None => {
                self.lagged_at = None;
                self.lag_owed = true;
            }
        }
    }

    /// Move an outstanding marker forward, or emit the one that was owed.
    fn advance_marker(&mut self, generation: u64) {
        if self.lagged_at.is_some() {
            self.lagged_at = newest(self.lagged_at, Some(generation));
            let named = self.lagged_at.expect("a marker generation was just set");
            if let Some(RuntimeEventDto::ResyncRequired(resync)) = self
                .queue
                .iter_mut()
                .rev()
                .find(|event| is_lag_marker(event))
            {
                resync.current_generation = Some(named);
            }
            return;
        }
        // A lag was owed and could not be announced. It can be now.
        self.lagged_at = Some(generation);
        self.lag_owed = false;
        self.queue.push_back(lag_marker(generation));
    }

    fn push(&mut self, event: RuntimeEventDto) {
        // Checked before anything else, so a stale delta cannot even drag a
        // lag marker's generation around.
        if self.is_behind_start(&event) {
            return;
        }
        if matches!(event, RuntimeEventDto::GenerationCommitted(_)) {
            self.started_at = None;
        }
        if self.lagged_at.is_some() || self.lag_owed {
            if let Some(generation) = event_generation(&event) {
                self.advance_marker(generation);
            }
            // State is a level, not an edge: the client's view of it is
            // wrong until the next transition, so it is carried even while
            // detail is being collapsed.
            if is_state_event(&event) {
                self.queue.push_back(event);
            }
            if self.queue.len() > SUBSCRIBER_CAPACITY {
                self.coalesce(None);
            }
            return;
        }
        if self.queue.len() >= SUBSCRIBER_CAPACITY {
            self.coalesce(event_generation(&event));
            return;
        }
        self.queue.push_back(event);
    }

    fn pop(&mut self) -> Option<EventEnvelope> {
        let event = self.queue.pop_front()?;
        if is_lag_marker(&event) {
            // The client has been told; ordinary incremental detail resumes.
            self.lagged_at = None;
        }
        Some(EventEnvelope::new(self.id.clone(), event))
    }
}

/// Every live subscription this process has issued, and their queues.
///
/// Not `Sync` and never shared: exactly one dispatcher owns it, which is
/// what makes request order and notice order the same order.
#[derive(Default)]
pub struct SubscriptionRegistry {
    next_id: u64,
    subscriptions: BTreeMap<String, Subscription>,
}

impl SubscriptionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve a subscription and describe where it starts. The identifier is
    /// opaque and process-scoped — a name, not a security token — and is
    /// never reused within the process.
    ///
    /// The generation reported here is the subscription's start point in the
    /// strong sense: it is recorded, and no `generation_committed` at or
    /// below it will ever be delivered.
    pub fn subscribe(&mut self, status: &PublishedStatus) -> SubscribeEventsResponse {
        self.next_id += 1;
        let id = format!("sub-{}", self.next_id);
        let started_at = status.generation.map(vault_index::Generation::get);
        self.subscriptions
            .insert(id.clone(), Subscription::new(id.clone(), started_at));
        SubscribeEventsResponse {
            subscription_id: id,
            generation: started_at,
            live_state: live_state(status.live_state),
        }
    }

    /// Activate every subscription whose response has now reached the output
    /// stream. Called by the dispatcher immediately after it writes a
    /// `subscribe_events` response, so no event can precede it.
    pub fn activate_new(&mut self) {
        for subscription in self.subscriptions.values_mut() {
            subscription.active = true;
        }
    }

    /// Release a subscription. Whatever it had queued has already been
    /// written by the dispatcher's pre-drain, so this only stops future
    /// delivery.
    pub fn unsubscribe(&mut self, id: &str) -> Result<UnsubscribeResponse, ProtocolError> {
        match self.subscriptions.remove(id) {
            Some(_) => Ok(UnsubscribeResponse {
                subscription_id: id.to_string(),
            }),
            None => Err(ProtocolError {
                code: ErrorCode::SubscriptionNotFound,
                message: format!("no such subscription: {id}"),
                supported_version: None,
                current_generation: None,
            }),
        }
    }

    /// Offer one runtime notice to every active subscription. Never blocks
    /// and never grows a queue past [`SUBSCRIBER_CAPACITY`].
    pub fn enqueue_notice(&mut self, notice: RuntimeNotice) {
        if self.subscriptions.is_empty() {
            return;
        }
        let events = events_for(&notice);
        if events.is_empty() {
            return;
        }
        for subscription in self.subscriptions.values_mut() {
            if !subscription.active {
                continue;
            }
            for event in &events {
                subscription.push(event.clone());
            }
        }
    }

    /// The next event owed to any subscription, in per-subscription order.
    ///
    /// Subscriptions are visited in identifier order and the first non-empty
    /// one answers. That cannot starve a peer: every queue is bounded at
    /// [`SUBSCRIBER_CAPACITY`] and collapses rather than grows, so a busy
    /// subscription empties within that many pops.
    pub fn pop_event(&mut self) -> Option<EventEnvelope> {
        self.subscriptions
            .values_mut()
            .find_map(|subscription| subscription.pop())
    }

    /// How deep one subscription's queue is, or `None` if no such
    /// subscription exists.
    pub fn queue_len(&self, id: &str) -> Option<usize> {
        self.subscriptions
            .get(id)
            .map(|subscription| subscription.queue.len())
    }

    pub fn is_empty(&self) -> bool {
        self.subscriptions.is_empty()
    }

    pub fn len(&self) -> usize {
        self.subscriptions.len()
    }
}
