use vault_protocol::{
    ChangeSetDto, EventEnvelope, GenerationCauseDto, GenerationCommittedEventDto, LiveStateDto,
    Request, RequestEnvelope, ResyncReasonDto, ResyncRequiredEventDto, RuntimeEventDto,
    RuntimeStateChangedEventDto, SubscribeEventsParams, SubscribeEventsResponse, UnsubscribeParams,
    UnsubscribeResponse,
};

#[test]
fn subscribe_events_request_round_trips_as_exact_json() {
    let envelope = RequestEnvelope::new("s1", Request::SubscribeEvents(SubscribeEventsParams {}));
    let json = serde_json::to_string(&envelope).expect("serialize request");
    assert_eq!(
        json,
        r#"{"version":1,"id":"s1","request":{"method":"subscribe_events","params":{}}}"#
    );

    let decoded: RequestEnvelope = serde_json::from_str(&json).expect("deserialize request");
    assert_eq!(decoded, envelope);
}

#[test]
fn unsubscribe_request_round_trips() {
    let envelope = RequestEnvelope::new(
        "u1",
        Request::Unsubscribe(UnsubscribeParams {
            subscription_id: "sub-1".into(),
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize request");
    let decoded: RequestEnvelope = serde_json::from_str(&json).expect("deserialize request");
    assert_eq!(decoded, envelope);
    assert!(json.contains("\"method\":\"unsubscribe\""));
    assert!(json.contains("\"subscription_id\":\"sub-1\""));
}

#[test]
fn subscribe_events_response_round_trips_with_generation_and_live_state() {
    let response = SubscribeEventsResponse {
        subscription_id: "sub-1".into(),
        generation: Some(7),
        live_state: LiveStateDto::Watching,
    };
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: SubscribeEventsResponse =
        serde_json::from_str(&json).expect("deserialize response");
    assert_eq!(decoded, response);
}

#[test]
fn subscribe_events_response_round_trips_with_null_generation_before_first_build() {
    let response = SubscribeEventsResponse {
        subscription_id: "sub-1".into(),
        generation: None,
        live_state: LiveStateDto::Starting,
    };
    let json = serde_json::to_string(&response).expect("serialize response");
    assert!(json.contains("\"generation\":null"));
    let decoded: SubscribeEventsResponse =
        serde_json::from_str(&json).expect("deserialize response");
    assert_eq!(decoded, response);
}

#[test]
fn unsubscribe_response_round_trips() {
    let response = UnsubscribeResponse {
        subscription_id: "sub-1".into(),
    };
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: UnsubscribeResponse = serde_json::from_str(&json).expect("deserialize response");
    assert_eq!(decoded, response);
}

#[test]
fn generation_committed_event_round_trips_as_exact_json() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::GenerationCommitted(GenerationCommittedEventDto {
            previous_generation: Some(7),
            generation: 8,
            cause: GenerationCauseDto::Watcher,
            changes: ChangeSetDto::Detailed {
                created: vec![],
                modified: vec!["Note.md".into()],
                deleted: vec![],
            },
            affected_note_count: 1,
            affected_reference_count: 3,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert_eq!(
        json,
        r#"{"version":1,"subscription_id":"sub-1","event":{"type":"generation_committed","value":{"previous_generation":7,"generation":8,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["Note.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":3}}}"#
    );

    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn generation_committed_event_round_trips_with_counts_only_change_set() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::GenerationCommitted(GenerationCommittedEventDto {
            previous_generation: Some(7),
            generation: 8,
            cause: GenerationCauseDto::Watcher,
            changes: ChangeSetDto::CountsOnly {
                created: 10,
                modified: 2_000,
                deleted: 4,
            },
            affected_note_count: 2_014,
            affected_reference_count: 9_001,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
    assert!(json.contains("\"kind\":\"counts_only\""));
}

#[test]
fn generation_committed_event_round_trips_with_null_previous_generation() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::GenerationCommitted(GenerationCommittedEventDto {
            previous_generation: None,
            generation: 1,
            cause: GenerationCauseDto::Startup,
            changes: ChangeSetDto::Detailed {
                created: vec!["Note.md".into()],
                modified: vec![],
                deleted: vec![],
            },
            affected_note_count: 1,
            affected_reference_count: 0,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert!(json.contains("\"previous_generation\":null"));
    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn resync_required_event_round_trips_as_exact_json() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
            current_generation: Some(8),
            reason: ResyncReasonDto::SubscriberLag,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert_eq!(
        json,
        r#"{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":8,"reason":"subscriber_lag"}}}"#
    );

    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn resync_required_event_round_trips_with_null_current_generation() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
            current_generation: None,
            reason: ResyncReasonDto::RootInvalidated,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert!(json.contains("\"current_generation\":null"));
    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn all_five_resync_reasons_round_trip_with_stable_wire_spellings() {
    let cases = [
        (ResyncReasonDto::SubscriberLag, "\"subscriber_lag\""),
        (
            ResyncReasonDto::OversizedChangeSet,
            "\"oversized_change_set\"",
        ),
        (ResyncReasonDto::RuntimeRecovered, "\"runtime_recovered\""),
        (ResyncReasonDto::WatcherOverflow, "\"watcher_overflow\""),
        (ResyncReasonDto::RootInvalidated, "\"root_invalidated\""),
    ];
    for (reason, expected) in cases {
        let json = serde_json::to_string(&reason).expect("serialize reason");
        assert_eq!(json, expected);
        let decoded: ResyncReasonDto = serde_json::from_str(&json).expect("deserialize reason");
        assert_eq!(decoded, reason);
    }
}

/// Every `GenerationCauseDto` variant round-trips through serde. This does
/// NOT assert the runtime can produce all of them on the wire today: the
/// live runtime produces `watcher` and `mutation`, and the rest become
/// reachable when `vault-index` attributes a cycle to them.
#[test]
fn all_generation_causes_round_trip_with_stable_wire_spellings() {
    let cases = [
        (GenerationCauseDto::Watcher, "\"watcher\""),
        (GenerationCauseDto::Startup, "\"startup\""),
        (GenerationCauseDto::Periodic, "\"periodic\""),
        (GenerationCauseDto::Manual, "\"manual\""),
        (GenerationCauseDto::Verified, "\"verified\""),
        (GenerationCauseDto::Mutation, "\"mutation\""),
    ];
    for (cause, expected) in cases {
        let json = serde_json::to_string(&cause).expect("serialize cause");
        assert_eq!(json, expected);
        let decoded: GenerationCauseDto = serde_json::from_str(&json).expect("deserialize cause");
        assert_eq!(decoded, cause);
    }
}

#[test]
fn all_live_states_round_trip_with_stable_wire_spellings() {
    let cases = [
        (LiveStateDto::Starting, "\"starting\""),
        (LiveStateDto::CatchingUp, "\"catching_up\""),
        (LiveStateDto::Watching, "\"watching\""),
        (LiveStateDto::PollingFallback, "\"polling_fallback\""),
        (LiveStateDto::Stopped, "\"stopped\""),
    ];
    for (state, expected) in cases {
        let json = serde_json::to_string(&state).expect("serialize state");
        assert_eq!(json, expected);
        let decoded: LiveStateDto = serde_json::from_str(&json).expect("deserialize state");
        assert_eq!(decoded, state);
    }
}

#[test]
fn runtime_state_changed_event_round_trips_with_null_generation_before_first_build() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::RuntimeStateChanged(RuntimeStateChangedEventDto {
            generation: None,
            live_state: LiveStateDto::Starting,
            error_code: None,
            message: None,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert!(json.contains("\"generation\":null"));
    assert!(json.contains("\"live_state\":\"starting\""));
    // Reserved/unpopulated fields are omitted from the wire, not emitted as
    // explicit nulls, matching the additive-optional convention used
    // elsewhere in this protocol (e.g. `GetVaultInfoResponse::live_state`).
    assert!(!json.contains("error_code"));
    assert!(!json.contains("\"message\""));

    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn runtime_state_changed_event_round_trips_with_message() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::RuntimeStateChanged(RuntimeStateChangedEventDto {
            generation: Some(4),
            live_state: LiveStateDto::PollingFallback,
            error_code: None,
            message: Some("watcher backend unavailable".into()),
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    let decoded: EventEnvelope = serde_json::from_str(&json).expect("deserialize event");
    assert_eq!(decoded, envelope);
}

#[test]
fn event_envelope_has_no_id_or_outcome_fields() {
    let envelope = EventEnvelope::new(
        "sub-1",
        RuntimeEventDto::ResyncRequired(ResyncRequiredEventDto {
            current_generation: Some(1),
            reason: ResyncReasonDto::RuntimeRecovered,
        }),
    );
    let json = serde_json::to_string(&envelope).expect("serialize event");
    assert!(!json.contains("\"id\""));
    assert!(!json.contains("\"outcome\""));
    assert!(json.starts_with(r#"{"version":1,"subscription_id":"sub-1","event":"#));
}
