//! The bounded subscription registry: what one subscriber is promised, and
//! what it is denied.
//!
//! Every queue here is per subscriber and bounded. These tests are the
//! contract for the two dispatcher-produced resync reasons (`subscriber_lag`
//! and `oversized_change_set`), which no runtime notice can ever carry.

use vault_core::VaultPath;
use vault_index::{
    ChangeCause, Generation, LiveRefreshReport, LiveState, PathChanges, PublishedStatus,
    ReconcileMetrics,
};
use vault_protocol::{
    ChangeSetDto, ErrorCode, EventEnvelope, GenerationCauseDto, LiveStateDto, PROTOCOL_VERSION,
    ResyncReasonDto, RuntimeEventDto,
};
use vault_server::runtime::{ResyncReason, RuntimeNotice};
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
    RuntimeNotice::Generation(Box::new(LiveRefreshReport {
        previous_generation: generation.checked_sub(1).map(Generation::new),
        generation: Generation::new(generation),
        cause: ChangeCause::Watcher,
        changes: PathChanges {
            created: Vec::new(),
            modified,
            deleted: Vec::new(),
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
