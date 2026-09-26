//! The bounded subscription registry: what one subscriber is promised, and
//! what it is denied.
//!
//! Every queue here is per subscriber and bounded. These tests are the
//! contract for the two dispatcher-produced resync reasons (`subscriber_lag`
//! and `oversized_change_set`), which no runtime notice can ever carry.

mod common;

use std::fs;
use std::sync::mpsc::{Receiver, sync_channel};
use std::time::{Duration, Instant};

use vault_core::VaultPath;
use vault_index::{
    ChangeCause, Generation, IndexConfig, IndexService, LiveRefreshReport, LiveState,
    NoteChangeCounts, PathChanges, PublishedStatus, ReconcileMetrics,
};
use vault_protocol::{
    ChangeSetDto, ErrorCode, EventEnvelope, GenerationCauseDto, LiveStateDto, PROTOCOL_VERSION,
    Request, RequestEnvelope, Response, ResponseOutcome, ResyncReasonDto, RuntimeEventDto,
    SubscribeEventsParams, SubscribeEventsResponse,
};
use vault_server::Server;
use vault_server::broadcast::ConnectionId;
use vault_server::runtime::{
    ResyncReason, Runtime, RuntimeNotice, RuntimeOptions, RuntimeTestHooks,
};
use vault_server::subscriptions::{DETAILED_PATH_LIMIT, SUBSCRIBER_CAPACITY, SubscriptionRegistry};

fn status(generation: Option<u64>, live_state: LiveState) -> PublishedStatus {
    PublishedStatus {
        generation: generation.map(Generation::new),
        graph_generation: generation.map(Generation::new),
        live_state,
        runtime_error: None,
    }
}

fn paths(prefix: &str, count: usize) -> Vec<VaultPath> {
    (0..count)
        .map(|index| VaultPath::new(format!("{prefix}{index}.md")).expect("vault path"))
        .collect()
}

fn generation_notice(generation: u64, modified: Vec<VaultPath>) -> RuntimeNotice {
    let note_count = modified.len() as u64;
    RuntimeNotice::Generation(Box::new(LiveRefreshReport {
        previous_generation: generation.checked_sub(1).map(Generation::new),
        generation: Generation::new(generation),
        cause: ChangeCause::Watcher,
        changes: PathChanges {
            created: Vec::new(),
            modified,
            deleted: Vec::new(),
        },
        // Every path this helper synthesises is a note, so the note count and
        // the change set's size agree — which is exactly the case that hid
        // the two being different things.
        note_changes: NoteChangeCounts {
            created: 0,
            modified: note_count,
            deleted: 0,
        },
        affected_reference_count: 7,
        complete_resolution: false,
        metrics: ReconcileMetrics::default(),
    }))
}

/// Drain every queued event, in delivery order.
fn drain(registry: &mut SubscriptionRegistry) -> Vec<EventEnvelope> {
    let mut seen = Vec::new();
    while let Some(event) = registry.pop_event() {
        seen.push(event);
    }
    seen
}

/// A subscription that has been reserved but whose response has not yet
/// reached the output stream receives nothing: the wire order
/// "response, then events" is structural, not incidental.
#[test]
fn a_reserved_subscription_receives_nothing_until_it_is_activated() {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&status(Some(1), LiveState::Watching));
    assert_eq!(response.subscription_id, "sub-1");
    assert_eq!(response.generation, Some(1));
    assert_eq!(response.live_state, LiveStateDto::Watching);

    registry.enqueue_notice(generation_notice(2, paths("Early", 1)));
    assert!(
        drain(&mut registry).is_empty(),
        "a reserved-but-inactive subscription must never be delivered an event"
    );

    registry.activate_new();
    registry.enqueue_notice(generation_notice(3, paths("Later", 1)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].version, PROTOCOL_VERSION);
    assert_eq!(events[0].subscription_id, "sub-1");
    match &events[0].event {
        RuntimeEventDto::GenerationCommitted(committed) => {
            assert_eq!(committed.generation, 3);
            assert_eq!(committed.previous_generation, Some(2));
            assert_eq!(committed.cause, GenerationCauseDto::Watcher);
            assert_eq!(committed.affected_note_count, 1);
            assert_eq!(committed.affected_reference_count, 7);
            match &committed.changes {
                ChangeSetDto::Detailed {
                    created,
                    modified,
                    deleted,
                } => {
                    assert!(created.is_empty());
                    assert_eq!(modified, &["Later0.md".to_string()]);
                    assert!(deleted.is_empty());
                }
                other => panic!("expected a detailed change set, got {other:?}"),
            }
        }
        other => panic!("expected a generation_committed event, got {other:?}"),
    }
}

/// A `subscribe_events` response promises the generation the subscription
/// starts from, and the client is entitled to treat that as its baseline.
///
/// Notices for generations at or below it may still be in flight: the
/// publication barrier moves *before* the coordinator emits, and a notice
/// then sits behind two bounded queues, so the barrier a subscribe reads can
/// be several generations ahead of the notices not yet dispatched. Delivering
/// those would run the `previous_generation` chain backwards from the
/// client's own start point, and a client checking continuity would force a
/// spurious resync.
#[test]
fn a_subscription_never_receives_a_generation_at_or_below_its_start_point() {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&status(Some(5), LiveState::Watching));
    registry.activate_new();
    assert_eq!(response.generation, Some(5));

    for generation in 3..=5 {
        registry.enqueue_notice(generation_notice(generation, paths("Stale", 1)));
    }
    assert!(
        drain(&mut registry).is_empty(),
        "generations at or below the promised start point are already in the client's hands"
    );

    // Only per-path deltas are filtered. A resync or a state change naming an
    // old generation is still news the client has not had.
    registry.enqueue_notice(RuntimeNotice::ResyncRequired {
        generation: Some(Generation::new(5)),
        reason: ResyncReason::WatcherOverflow,
    });
    registry.enqueue_notice(RuntimeNotice::State {
        generation: Some(Generation::new(5)),
        state: LiveState::PollingFallback,
        error: None,
    });
    assert_eq!(drain(&mut registry).len(), 2);

    registry.enqueue_notice(generation_notice(6, paths("Fresh", 1)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    match &events[0].event {
        RuntimeEventDto::GenerationCommitted(committed) => {
            assert_eq!(committed.generation, 6);
            assert_eq!(
                committed.previous_generation,
                Some(5),
                "the chain must continue from the promised start point"
            );
        }
        other => panic!("expected generation 6, got {other:?}"),
    }

    // The filter is spent once a generation passes it: later generations are
    // monotonic, so nothing more needs checking.
    registry.enqueue_notice(generation_notice(7, paths("Later", 1)));
    assert_eq!(drain(&mut registry).len(), 1);
}

/// A subscription opened before anything was ever committed has no baseline
/// to be behind, so it filters nothing — including the cold build's own
/// generation 1.
#[test]
fn a_subscription_opened_before_any_generation_filters_nothing() {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&status(None, LiveState::CatchingUp));
    registry.activate_new();
    assert_eq!(response.generation, None);

    registry.enqueue_notice(generation_notice(1, paths("Cold", 1)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].event,
        RuntimeEventDto::GenerationCommitted(ref committed) if committed.generation == 1
    ));
}

/// A subscriber that never drains is coalesced, never grown. The marker that
/// replaces the lost detail names the newest generation, not the one that
/// happened to overflow the queue.
#[test]
fn a_lagging_subscriber_is_bounded_and_its_marker_names_the_latest_generation() {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();
    let id = response.subscription_id;

    for generation in 2..=1_001 {
        registry.enqueue_notice(generation_notice(generation, paths("Note", 1)));
        assert!(
            registry.queue_len(&id).expect("subscription exists") <= SUBSCRIBER_CAPACITY,
            "a subscriber queue must never exceed {SUBSCRIBER_CAPACITY} events"
        );
    }

    let events = drain(&mut registry);
    let last = events.last().expect("at least the lag marker");
    match &last.event {
        RuntimeEventDto::ResyncRequired(resync) => {
            assert_eq!(resync.reason, ResyncReasonDto::SubscriberLag);
            assert_eq!(
                resync.current_generation,
                Some(1_001),
                "the marker must name the newest committed generation"
            );
        }
        other => panic!("expected a subscriber_lag marker last, got {other:?}"),
    }
    assert!(
        events.len() <= SUBSCRIBER_CAPACITY,
        "the drained backlog is bounded too"
    );

    // Once the marker drains, ordinary incremental detail resumes.
    registry.enqueue_notice(generation_notice(1_002, paths("After", 1)));
    let resumed = drain(&mut registry);
    assert_eq!(resumed.len(), 1);
    assert!(matches!(
        resumed[0].event,
        RuntimeEventDto::GenerationCommitted(_)
    ));
}

/// A change set larger than the transport's detail limit is reported as
/// counts, followed by the marker that says so.
#[test]
fn an_oversized_change_set_becomes_counts_only_plus_a_resync() {
    let mut registry = SubscriptionRegistry::new();
    registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();

    registry.enqueue_notice(generation_notice(2, paths("Bulk", DETAILED_PATH_LIMIT + 1)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 2);
    match &events[0].event {
        RuntimeEventDto::GenerationCommitted(committed) => match committed.changes {
            ChangeSetDto::CountsOnly {
                created,
                modified,
                deleted,
            } => {
                assert_eq!(created, 0);
                assert_eq!(modified, DETAILED_PATH_LIMIT as u64 + 1);
                assert_eq!(deleted, 0);
            }
            ref other => panic!("expected a counts-only change set, got {other:?}"),
        },
        other => panic!("expected a generation_committed event, got {other:?}"),
    }
    match &events[1].event {
        RuntimeEventDto::ResyncRequired(resync) => {
            assert_eq!(resync.reason, ResyncReasonDto::OversizedChangeSet);
            assert_eq!(resync.current_generation, Some(2));
        }
        other => panic!("expected an oversized_change_set marker, got {other:?}"),
    }

    // Exactly at the limit the detail is still carried.
    registry.enqueue_notice(generation_notice(3, paths("Edge", DETAILED_PATH_LIMIT)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].event,
        RuntimeEventDto::GenerationCommitted(ref committed)
            if matches!(committed.changes, ChangeSetDto::Detailed { .. })
    ));
}

/// `resync_required` names the generation a client must re-read at. While no
/// generation has ever been committed there is nothing to name, so the event
/// is withheld — and the first resync that does carry one supersedes every
/// withheld predecessor.
#[test]
fn resyncs_are_withheld_until_a_generation_exists() {
    let mut registry = SubscriptionRegistry::new();
    registry.subscribe(&status(None, LiveState::CatchingUp));
    registry.activate_new();

    registry.enqueue_notice(RuntimeNotice::ResyncRequired {
        generation: None,
        reason: ResyncReason::WatcherOverflow,
    });
    assert!(
        drain(&mut registry).is_empty(),
        "no committed generation exists, so there is nothing to re-read at"
    );

    registry.enqueue_notice(RuntimeNotice::ResyncRequired {
        generation: Some(Generation::new(1)),
        reason: ResyncReason::RuntimeRecovered,
    });
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    match &events[0].event {
        RuntimeEventDto::ResyncRequired(resync) => {
            assert_eq!(resync.current_generation, Some(1));
            assert_eq!(resync.reason, ResyncReasonDto::RuntimeRecovered);
        }
        other => panic!("expected the cold-build resync, got {other:?}"),
    }
}

/// Each runtime resync reason keeps its own spelling. Collapsing the watcher
/// reasons onto `runtime_recovered` would tell a client the runtime merely
/// caught up when in fact the vault root moved.
#[test]
fn every_runtime_resync_reason_keeps_its_own_spelling() {
    let mut registry = SubscriptionRegistry::new();
    registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();

    for (reason, expected) in [
        (
            ResyncReason::WatcherOverflow,
            ResyncReasonDto::WatcherOverflow,
        ),
        (
            ResyncReason::RootInvalidated,
            ResyncReasonDto::RootInvalidated,
        ),
        (
            ResyncReason::RuntimeRecovered,
            ResyncReasonDto::RuntimeRecovered,
        ),
    ] {
        registry.enqueue_notice(RuntimeNotice::ResyncRequired {
            generation: Some(Generation::new(4)),
            reason,
        });
        let events = drain(&mut registry);
        assert_eq!(events.len(), 1);
        match &events[0].event {
            RuntimeEventDto::ResyncRequired(resync) => assert_eq!(resync.reason, expected),
            other => panic!("expected a resync event, got {other:?}"),
        }
    }
}

/// The runtime's `State` notice carries a display-only message. `error_code`
/// stays reserved until the runtime carries a typed code.
#[test]
fn runtime_state_notices_carry_a_message_and_never_an_error_code() {
    let mut registry = SubscriptionRegistry::new();
    registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();

    registry.enqueue_notice(RuntimeNotice::State {
        generation: Some(Generation::new(1)),
        state: LiveState::PollingFallback,
        error: Some("watcher installation was refused".into()),
    });
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    match &events[0].event {
        RuntimeEventDto::RuntimeStateChanged(changed) => {
            assert_eq!(changed.generation, Some(1));
            assert_eq!(changed.live_state, LiveStateDto::PollingFallback);
            assert_eq!(changed.error_code, None);
            assert_eq!(
                changed.message.as_deref(),
                Some("watcher installation was refused")
            );
        }
        other => panic!("expected a runtime_state_changed event, got {other:?}"),
    }
}

/// Unsubscribing stops delivery for that subscription and only that one.
#[test]
fn unsubscribing_stops_delivery_and_leaves_peers_alone() {
    let mut registry = SubscriptionRegistry::new();
    let first = registry.subscribe(&status(Some(1), LiveState::Watching));
    let second = registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();
    assert_ne!(first.subscription_id, second.subscription_id);

    let response = registry
        .unsubscribe(&first.subscription_id)
        .expect("the subscription exists");
    assert_eq!(response.subscription_id, first.subscription_id);

    registry.enqueue_notice(generation_notice(2, paths("Note", 1)));
    let events = drain(&mut registry);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].subscription_id, second.subscription_id);
}

/// An identifier this process never issued, or already released, is refused
/// with the dedicated code rather than silently accepted.
#[test]
fn unsubscribing_an_unknown_identifier_is_subscription_not_found() {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();
    registry
        .unsubscribe(&response.subscription_id)
        .expect("the first release succeeds");

    let error = registry
        .unsubscribe(&response.subscription_id)
        .expect_err("a released subscription is gone");
    assert_eq!(error.code, ErrorCode::SubscriptionNotFound);

    let error = registry
        .unsubscribe("sub-does-not-exist")
        .expect_err("an unissued identifier is refused");
    assert_eq!(error.code, ErrorCode::SubscriptionNotFound);
}

/// Identifiers are allocated in issue order and are never reused, so a
/// client cannot be handed an identifier a previous subscription still has
/// events queued under.
#[test]
fn subscription_identifiers_are_allocated_in_order_and_never_reused() {
    let mut registry = SubscriptionRegistry::new();
    let first = registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();
    registry
        .unsubscribe(&first.subscription_id)
        .expect("release");
    let second = registry.subscribe(&status(Some(1), LiveState::Watching));
    assert_eq!(first.subscription_id, "sub-1");
    assert_eq!(second.subscription_id, "sub-2");
}

/// State is a level, not an edge: a client's view of it stays wrong until
/// the next transition. So the collapse that discards queued deltas must
/// keep the newest state event — *including* the one whose arrival caused
/// the collapse, which is by definition the newest of all.
///
/// The case that matters is a queue full of nothing but deltas: there is no
/// state event already queued to fall back on, so discarding the incoming
/// one loses the transition outright. A lost `stopped` is never re-announced,
/// and the client waits forever on a runtime that has already gone.
#[test]
fn a_state_change_arriving_at_capacity_survives_the_collapse() {
    let mut registry = SubscriptionRegistry::new();
    registry.subscribe(&status(Some(1), LiveState::Watching));
    registry.activate_new();

    for generation in 2..=(SUBSCRIBER_CAPACITY as u64 + 1) {
        registry.enqueue_notice(generation_notice(generation, paths("Note", 1)));
    }
    assert_eq!(
        registry.queue_len("sub-1"),
        Some(SUBSCRIBER_CAPACITY),
        "the queue is exactly full, and holds no state event to fall back on"
    );

    registry.enqueue_notice(RuntimeNotice::State {
        generation: Some(Generation::new(SUBSCRIBER_CAPACITY as u64 + 1)),
        state: LiveState::Stopped,
        error: None,
    });
    assert!(
        registry.queue_len("sub-1").expect("subscription exists") <= SUBSCRIBER_CAPACITY,
        "the bound still holds"
    );

    let events = drain(&mut registry);
    let (state, marker) = match events.as_slice() {
        [.., state, marker] => (&state.event, &marker.event),
        other => panic!("expected a state event then a lag marker, got {other:?}"),
    };
    match state {
        RuntimeEventDto::RuntimeStateChanged(changed) => {
            assert_eq!(
                changed.live_state,
                LiveStateDto::Stopped,
                "the transition that arrived at capacity must survive"
            );
        }
        other => panic!("expected the state change to survive, got {other:?}"),
    }
    match marker {
        RuntimeEventDto::ResyncRequired(resync) => {
            assert_eq!(resync.reason, ResyncReasonDto::SubscriberLag);
            assert_eq!(
                resync.current_generation,
                Some(SUBSCRIBER_CAPACITY as u64 + 1)
            );
        }
        other => panic!("expected a subscriber_lag marker last, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// The registry driven against a live runtime
// ---------------------------------------------------------------------------
//
// `connection::dispatch` is crate-visible and `stdio::run` owns real stdin and
// stdout, so these drive the same loop in process from the same public pieces
// the dispatcher uses: pre-drain, `Server::handle`, `activate_new`, then
// `enqueue_notice` + drain for every notice. That is the sanctioned route to
// `subscriber_lag`, which the shipped transports cannot reach because that
// dispatcher drains after every single notice.

/// A vault plus its cache directory, kept alive for the whole test.
struct LiveFixture {
    vault: tempfile::TempDir,
    _index: tempfile::TempDir,
    config: IndexConfig,
}

fn live_fixture() -> LiveFixture {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n\n[[Other]]\n").expect("write note");
    fs::write(vault.path().join("Other.md"), "# Other\n").expect("write other");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("index config");
    // Build generation 1 and hand the writer lease back, so a runtime opens
    // the same cache warm and its startup catch-up publishes nothing.
    let mut service = IndexService::open(config.clone()).expect("open service");
    service.refresh(false).expect("cold build");
    drop(service);
    LiveFixture {
        vault,
        _index: index,
        config,
    }
}

impl LiveFixture {
    fn path(&self, name: &str) -> std::path::PathBuf {
        self.vault.path().join(name)
    }
}

fn quiet_options() -> RuntimeOptions {
    RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    }
}

/// Block until the startup catch-up has finished and the runtime has settled.
fn wait_for_settled(handle: &vault_server::runtime::RuntimeHandle) {
    wait_for("the runtime to settle", || {
        let status = handle.reader().published_status().expect("status");
        (status.live_state == LiveState::PollingFallback).then_some(())
    });
}

fn wait_for<T>(label: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn paths_hint(names: &[&str]) -> vault_watch::ChangeHint {
    vault_watch::ChangeHint::Paths(
        names
            .iter()
            .map(|name| VaultPath::new(*name).expect("vault path"))
            .collect(),
    )
}

/// One `subscribe_events` request through the same sequence the dispatcher
/// uses: pre-drain, handle, hand the response to the writer, activate.
fn subscribe_through_dispatcher(
    server: &Server,
    registry: &mut SubscriptionRegistry,
) -> SubscribeEventsResponse {
    let pre_drain = drain(registry);
    assert!(
        pre_drain.is_empty(),
        "these tests subscribe before any event is queued"
    );
    let envelope = server.handle(
        ConnectionId::STANDALONE,
        RequestEnvelope::new(
            "req-subscribe",
            Request::SubscribeEvents(SubscribeEventsParams {}),
        ),
        registry,
    );
    registry.activate_new();
    match envelope.outcome {
        ResponseOutcome::Ok(Response::SubscribeEvents(response)) => response,
        other => panic!("expected a subscribe_events response, got {other:?}"),
    }
}

/// Move every notice waiting on the runtime's sink through the registry, and
/// return the events the dispatcher would have written.
fn pump(
    registry: &mut SubscriptionRegistry,
    notices: &Receiver<RuntimeNotice>,
) -> Vec<EventEnvelope> {
    let mut written = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        registry.enqueue_notice(notice);
        written.extend(drain(registry));
    }
    written
}

/// A subscription registered at the commit boundary — after the barrier moved
/// to `G + 1`, before the coordinator emitted anything about it — is promised
/// `G + 1` and must never then be *delivered* `G + 1`. The client already has
/// that generation; delivering it would run its `previous_generation` chain
/// backwards from its own start point.
///
/// This is the race the `started_at` filter exists for, forced rather than
/// hoped for: the coordinator is parked inside `mutation_exit`, which is
/// exactly the window between the publication and its notice.
#[test]
fn a_subscription_registered_at_the_commit_boundary_is_never_delivered_its_own_start_generation() {
    let fixture = live_fixture();
    // Sequence 0 is the startup catch-up; sequence 1 is the targeted
    // reconciliation the hint below causes.
    let (hooks, parked) = common::park_at_mutation(
        "coordinator at the commit boundary of the hinted reconciliation",
        1,
        true,
    );

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    let server = Server::for_runtime(handle.clone());
    let mut registry = SubscriptionRegistry::new();

    // Catch-up must finish first, or it — not the hint below — would be the
    // mutation that publishes, and the parked window would be the wrong one.
    wait_for_settled(&handle);
    while notices.try_recv().is_ok() {}

    fs::write(fixture.path("Third.md"), "# Third\n\n[[Note]]\n").expect("write third");
    assert!(handle.hint(paths_hint(&["Third.md"])));

    // The coordinator is parked with generation 2 published and its notice
    // not yet emitted.
    parked.arrived();
    let response = subscribe_through_dispatcher(&server, &mut registry);
    assert_eq!(
        response.generation,
        Some(2),
        "the barrier has already moved, so the subscription starts at the new generation"
    );
    parked.release();

    // The notice for generation 2 now arrives. It must be filtered out.
    let notice = notices
        .recv_timeout(Duration::from_secs(10))
        .expect("the coordinator emits generation 2 after the parked window");
    assert!(
        matches!(&notice, RuntimeNotice::Generation(report) if report.generation.get() == 2),
        "expected the generation-2 notice, got {notice:?}"
    );
    registry.enqueue_notice(notice);
    let delivered = drain(&mut registry);
    assert!(
        delivered.is_empty(),
        "a generation at or below the promised start point must never be delivered: {delivered:?}"
    );

    // The next generation is delivered, and its chain continues from the
    // start point the client was promised.
    fs::write(fixture.path("Fourth.md"), "# Fourth\n").expect("write fourth");
    assert!(handle.hint(paths_hint(&["Fourth.md"])));
    let committed = wait_for("generation 3", || {
        pump(&mut registry, &notices)
            .into_iter()
            .find_map(|envelope| match envelope.event {
                RuntimeEventDto::GenerationCommitted(committed) => Some(committed),
                _ => None,
            })
    });
    assert_eq!(committed.generation, 3);
    assert_eq!(
        committed.previous_generation,
        Some(2),
        "the chain must continue from the promised start point, with no gap and no repeat"
    );

    handle.shutdown();
}

/// The other arm of the same race: a subscription registered *before* the
/// commit is promised `G`, and must then receive `G + 1` exactly once.
#[test]
fn a_subscription_registered_before_the_commit_receives_the_next_generation_once() {
    let fixture = live_fixture();
    // Park before the call, so the barrier still shows the old generation.
    let (hooks, parked) =
        common::park_at_mutation("coordinator entering the hinted reconciliation", 1, false);

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    let server = Server::for_runtime(handle.clone());
    let mut registry = SubscriptionRegistry::new();

    wait_for_settled(&handle);
    while notices.try_recv().is_ok() {}

    fs::write(fixture.path("Third.md"), "# Third\n\n[[Note]]\n").expect("write third");
    assert!(handle.hint(paths_hint(&["Third.md"])));

    parked.arrived();
    let response = subscribe_through_dispatcher(&server, &mut registry);
    assert_eq!(
        response.generation,
        Some(1),
        "the publication has not happened yet, so the start point is the old generation"
    );
    parked.release();

    let notice = notices
        .recv_timeout(Duration::from_secs(10))
        .expect("the coordinator emits generation 2 after the parked window");
    registry.enqueue_notice(notice);
    let committed: Vec<u64> = drain(&mut registry)
        .into_iter()
        .filter_map(|envelope| match envelope.event {
            RuntimeEventDto::GenerationCommitted(committed) => Some(committed.generation),
            _ => None,
        })
        .collect();
    assert_eq!(committed, vec![2], "delivered exactly once");
    assert!(
        pump(&mut registry, &notices).is_empty(),
        "nothing follows a single targeted publication"
    );

    handle.shutdown();
}

/// A subscriber that never drains, against a runtime that keeps publishing.
/// The queue must stay bounded and collapse onto one marker naming the newest
/// generation — never grow, never drop a generation silently, never stall the
/// coordinator.
///
/// The registry's own bound is a *component* bound: the shipped stdio
/// dispatcher drains after every notice and cannot reach it. This drives the
/// registry the way an embedder that batches notices would, which is the
/// sanctioned way that branch is proven.
#[test]
fn a_subscriber_that_never_drains_is_bounded_against_a_live_runtime() {
    let fixture = live_fixture();
    let (sink, notices) = sync_channel(256);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        quiet_options(),
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    let server = Server::for_runtime(handle.clone());
    let mut registry = SubscriptionRegistry::new();

    wait_for_settled(&handle);
    let response = subscribe_through_dispatcher(&server, &mut registry);
    let id = response.subscription_id;

    // Far more generations than the queue can hold, enqueued without a
    // single drain in between.
    let rounds = SUBSCRIBER_CAPACITY + 20;
    for round in 0..rounds {
        let name = format!("Bulk-{round}.md");
        fs::write(fixture.path(&name), format!("# Bulk {round}\n\n[[Note]]\n"))
            .expect("write bulk note");
        assert!(handle.hint(paths_hint(&[name.as_str()])));
        wait_for(&format!("generation {}", round + 2), || {
            let status = handle.reader().published_status().expect("status");
            status
                .generation
                .filter(|generation| generation.get() as usize >= round + 2)
                .map(|_| ())
        });
        while let Ok(notice) = notices.try_recv() {
            registry.enqueue_notice(notice);
        }
        assert!(
            registry.queue_len(&id).expect("subscription exists") <= SUBSCRIBER_CAPACITY,
            "a subscriber queue must never exceed {SUBSCRIBER_CAPACITY} events"
        );
    }

    let final_generation = handle
        .reader()
        .published_status()
        .expect("status")
        .generation
        .expect("published")
        .get();
    assert_eq!(
        final_generation,
        rounds as u64 + 1,
        "the coordinator published every generation while the subscriber never drained"
    );

    while let Ok(notice) = notices.try_recv() {
        registry.enqueue_notice(notice);
    }
    let events = drain(&mut registry);
    assert!(events.len() <= SUBSCRIBER_CAPACITY);
    match &events.last().expect("at least the lag marker").event {
        RuntimeEventDto::ResyncRequired(resync) => {
            assert_eq!(resync.reason, ResyncReasonDto::SubscriberLag);
            assert_eq!(
                resync.current_generation,
                Some(final_generation),
                "the marker must name the newest committed generation, not the one that overflowed"
            );
        }
        other => panic!("expected a subscriber_lag marker last, got {other:?}"),
    }

    handle.shutdown();
}

/// A generation that moved only the file tree names its paths and reports
/// **no affected notes**, over a real vault and a real runtime.
///
/// `affected_note_count` and the change set are two different questions with
/// two different answers, and only a non-note change can tell them apart: for
/// a note edit both are one, which is why deriving the count from the change
/// set's size went unnoticed for as long as nothing but notes could appear in
/// it. Here an attachment lands in a folder that did not exist, so the
/// generation carries two paths and zero notes.
#[test]
fn a_tree_only_generation_reports_its_paths_and_no_affected_notes() {
    let fixture = live_fixture();
    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        quiet_options(),
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    let server = Server::for_runtime(handle.clone());
    let mut registry = SubscriptionRegistry::new();

    wait_for_settled(&handle);
    subscribe_through_dispatcher(&server, &mut registry);

    fs::create_dir_all(fixture.path("Art")).expect("create attachment folder");
    fs::write(fixture.path("Art/Image.png"), [0x89, b'P', b'N', b'G']).expect("write attachment");
    assert!(handle.hint(paths_hint(&["Art/Image.png"])));

    let committed = wait_for("the tree-only generation", || {
        pump(&mut registry, &notices)
            .into_iter()
            .find_map(|envelope| match envelope.event {
                RuntimeEventDto::GenerationCommitted(committed) => Some(committed),
                _ => None,
            })
    });

    assert_eq!(
        committed.affected_note_count, 0,
        "no note moved: an attachment and the folder it arrived in are not notes"
    );
    match &committed.changes {
        ChangeSetDto::Detailed {
            created,
            modified,
            deleted,
        } => {
            assert_eq!(
                created,
                &["Art".to_string(), "Art/Image.png".to_string()],
                "the paths that moved are still spelled out — the folder the \
                 hint never named included"
            );
            assert!(modified.is_empty());
            assert!(deleted.is_empty());
        }
        other => panic!("expected a detailed change set, got {other:?}"),
    }

    handle.shutdown();
}

/// A change set too large to carry as paths becomes counts plus a marker,
/// over a real runtime rather than a synthesised notice — so the bound is
/// proven against the change sets the engine actually produces.
#[test]
fn a_real_oversized_generation_is_reported_as_counts_plus_a_marker() {
    let fixture = live_fixture();
    let (sink, notices) = sync_channel(256);
    let mut options = quiet_options();
    // The coordinator's own pending set is capped by the watcher's ceiling,
    // so it has to be lifted above the transport's detail limit for one
    // generation to carry more paths than the transport will spell out.
    options.watch_config.max_dirty_paths = DETAILED_PATH_LIMIT * 4;
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        options,
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    let server = Server::for_runtime(handle.clone());
    let mut registry = SubscriptionRegistry::new();

    wait_for_settled(&handle);
    subscribe_through_dispatcher(&server, &mut registry);

    let bulk = DETAILED_PATH_LIMIT + 1;
    let mut names = Vec::with_capacity(bulk);
    for index in 0..bulk {
        let name = format!("Wide-{index}.md");
        fs::write(fixture.path(&name), format!("# Wide {index}\n")).expect("write wide note");
        names.push(name);
    }
    let hint = vault_watch::ChangeHint::Paths(
        names
            .iter()
            .map(|name| VaultPath::new(name.as_str()).expect("vault path"))
            .collect(),
    );
    assert!(handle.hint(hint));

    let events = wait_for("the oversized generation", || {
        let written = pump(&mut registry, &notices);
        written
            .iter()
            .any(|envelope| matches!(envelope.event, RuntimeEventDto::GenerationCommitted(_)))
            .then_some(written)
    });
    let committed = events
        .iter()
        .find_map(|envelope| match &envelope.event {
            RuntimeEventDto::GenerationCommitted(committed) => Some(committed),
            _ => None,
        })
        .expect("a generation_committed event");
    match committed.changes {
        ChangeSetDto::CountsOnly {
            created,
            modified,
            deleted,
        } => {
            assert_eq!(created, bulk as u64);
            assert_eq!(modified, 0);
            assert_eq!(deleted, 0);
        }
        ref other => panic!("expected a counts-only change set, got {other:?}"),
    }
    assert_eq!(committed.affected_note_count, bulk as u64);
    assert!(
        events.iter().any(|envelope| matches!(
            envelope.event,
            RuntimeEventDto::ResyncRequired(ref resync)
                if resync.reason == ResyncReasonDto::OversizedChangeSet
        )),
        "an oversized change set must be followed by its marker: {events:?}"
    );

    handle.shutdown();
}
