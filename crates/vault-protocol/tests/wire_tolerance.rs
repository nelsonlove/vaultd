//! Wire tolerance: yesterday's fixtures still parse, and a variant from a
//! later `vaultd` degrades to `Unknown` instead of failing the line — and
//! with it, the whole subscription that line belonged to.

use vault_protocol::{
    ErrorCode, EventEnvelope, GenerationCauseDto, LiveStateDto, ResponseEnvelope, ResponseOutcome,
    ResyncReasonDto, RuntimeEventDto,
};

/// Captured from the shipped live-runtime transport: one line per event
/// shape, exactly as `vaultd` writes them today.
const GENERATION_COMMITTED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"generation_committed","value":{"previous_generation":1,"generation":2,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["One.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":0}}}"#;
const RUNTIME_STATE_CHANGED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"runtime_state_changed","value":{"generation":2,"live_state":"watching"}}}"#;
const RESYNC_REQUIRED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":2,"reason":"runtime_recovered"}}}"#;

#[test]
fn todays_event_fixtures_still_parse_unchanged() {
    let committed: EventEnvelope =
        serde_json::from_str(GENERATION_COMMITTED).expect("today's generation_committed line");
    match committed.event {
        RuntimeEventDto::GenerationCommitted(event) => {
            assert_eq!(event.generation, 2);
            assert_eq!(event.cause, GenerationCauseDto::Watcher);
        }
        other => panic!("expected generation_committed, got {other:?}"),
    }

    let state: EventEnvelope =
        serde_json::from_str(RUNTIME_STATE_CHANGED).expect("today's runtime_state_changed line");
    match state.event {
        RuntimeEventDto::RuntimeStateChanged(event) => {
            assert_eq!(event.live_state, LiveStateDto::Watching);
        }
        other => panic!("expected runtime_state_changed, got {other:?}"),
    }

    let resync: EventEnvelope =
        serde_json::from_str(RESYNC_REQUIRED).expect("today's resync_required line");
    match resync.event {
        RuntimeEventDto::ResyncRequired(event) => {
            assert_eq!(event.reason, ResyncReasonDto::RuntimeRecovered);
        }
        other => panic!("expected resync_required, got {other:?}"),
    }
}

#[test]
fn an_unknown_generation_cause_degrades_to_unknown() {
    let line = GENERATION_COMMITTED.replace(r#""cause":"watcher""#, r#""cause":"from_the_future""#);
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown cause must still parse");
    match envelope.event {
        RuntimeEventDto::GenerationCommitted(event) => {
            assert_eq!(event.cause, GenerationCauseDto::Unknown);
            assert_eq!(event.generation, 2, "the rest of the event must survive");
        }
        other => panic!("expected generation_committed, got {other:?}"),
    }
}

#[test]
fn an_unknown_resync_reason_degrades_to_unknown() {
    let line = RESYNC_REQUIRED.replace(
        r#""reason":"runtime_recovered""#,
        r#""reason":"from_the_future""#,
    );
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown reason must still parse");
    match envelope.event {
        RuntimeEventDto::ResyncRequired(event) => {
            assert_eq!(event.reason, ResyncReasonDto::Unknown);
            assert_eq!(event.current_generation, Some(2));
        }
        other => panic!("expected resync_required, got {other:?}"),
    }
}

#[test]
fn an_unknown_live_state_degrades_to_unknown() {
    let line = RUNTIME_STATE_CHANGED.replace(
        r#""live_state":"watching""#,
        r#""live_state":"from_the_future""#,
    );
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown live state must still parse");
    match envelope.event {
        RuntimeEventDto::RuntimeStateChanged(event) => {
            assert_eq!(event.live_state, LiveStateDto::Unknown);
            assert_eq!(event.generation, Some(2));
        }
        other => panic!("expected runtime_state_changed, got {other:?}"),
    }
}

#[test]
fn an_unknown_event_type_degrades_to_unknown() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future","value":{"anything":[1,2,3]}}}"#;
    let envelope: EventEnvelope =
        serde_json::from_str(line).expect("an unknown event type must still parse");
    assert_eq!(envelope.event, RuntimeEventDto::Unknown);
    assert_eq!(
        envelope.subscription_id, "sub-1",
        "the envelope around an unknown event must still be usable"
    );
}

#[test]
fn an_unknown_event_type_with_no_value_degrades_to_unknown() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future"}}"#;
    let envelope: EventEnvelope =
        serde_json::from_str(line).expect("an unknown unit-shaped event must still parse");
    assert_eq!(envelope.event, RuntimeEventDto::Unknown);
}

#[test]
fn a_known_event_type_missing_its_value_is_still_an_error() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required"}}"#;
    let result = serde_json::from_str::<EventEnvelope>(line);
    assert!(
        result.is_err(),
        "tolerance is for unknown variants only; a malformed known variant must still fail"
    );
}

#[test]
fn an_unknown_error_code_degrades_to_unknown() {
    let line = r#"{"version":1,"id":"a","outcome":{"status":"err","value":{"code":"from_the_future","message":"stale"}}}"#;
    let envelope: ResponseEnvelope =
        serde_json::from_str(line).expect("an unknown error code must still parse");
    match envelope.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::Unknown);
            assert_eq!(error.message, "stale");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}

#[test]
fn unknown_serializes_to_a_reserved_spelling_this_server_never_emits() {
    assert_eq!(
        serde_json::to_string(&GenerationCauseDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&ResyncReasonDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&LiveStateDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::Unknown).expect("serialize"),
        r#""unknown""#
    );
}
