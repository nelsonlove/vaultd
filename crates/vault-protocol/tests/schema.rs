use vault_protocol::{
    ErrorCode, PROTOCOL_VERSION, Request, RequestEnvelope, Response, ResponseEnvelope,
    ResponseOutcome, validate_version,
};

#[test]
fn health_request_round_trips_as_versioned_json() {
    let request = RequestEnvelope::new("req-1", Request::Health);
    let json = serde_json::to_string(&request).expect("serialize request");
    assert!(json.contains("\"version\":1"));
    assert!(json.contains("\"method\":\"health\""));

    let decoded: RequestEnvelope = serde_json::from_str(&json).expect("deserialize request");
    assert_eq!(decoded, request);
}

#[test]
fn incompatible_version_has_a_stable_error_code() {
    let error = validate_version(PROTOCOL_VERSION + 1).expect_err("version must be rejected");
    assert_eq!(error.code, ErrorCode::IncompatibleVersion);
    assert_eq!(error.supported_version, Some(PROTOCOL_VERSION));
}

#[test]
fn health_response_round_trips_without_core_types() {
    let response = ResponseEnvelope::success("req-1", Response::health("vaultd"));
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: ResponseEnvelope = serde_json::from_str(&json).expect("deserialize response");

    assert_eq!(decoded, response);
    assert!(matches!(
        decoded.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
}

#[test]
fn task_11_error_codes_are_stable_snake_case_values() {
    let cases = [
        (ErrorCode::IndexInUse, "\"index_in_use\""),
        (ErrorCode::WatchUnavailable, "\"watch_unavailable\""),
        (
            ErrorCode::SubscriptionNotFound,
            "\"subscription_not_found\"",
        ),
        (ErrorCode::RuntimeNotReady, "\"runtime_not_ready\""),
        (ErrorCode::RuntimeOverloaded, "\"runtime_overloaded\""),
    ];
    for (code, expected) in cases {
        let json = serde_json::to_string(&code).expect("serialize error code");
        assert_eq!(json, expected);
        let decoded: ErrorCode = serde_json::from_str(&json).expect("deserialize error code");
        assert_eq!(decoded, code);
    }
}

#[test]
fn existing_error_code_spellings_are_unchanged() {
    // Guards against accidental reordering/renaming of pre-Task-11 codes
    // when the enum was extended.
    let cases = [
        (ErrorCode::IncompatibleVersion, "\"incompatible_version\""),
        (ErrorCode::InvalidRequest, "\"invalid_request\""),
        (ErrorCode::InvalidPath, "\"invalid_path\""),
        (ErrorCode::InvalidCursor, "\"invalid_cursor\""),
        (ErrorCode::NoteNotFound, "\"note_not_found\""),
        (ErrorCode::IndexUnavailable, "\"index_unavailable\""),
        (ErrorCode::GenerationMismatch, "\"generation_mismatch\""),
        (
            ErrorCode::VaultChangedDuringRefresh,
            "\"vault_changed_during_refresh\"",
        ),
        (ErrorCode::IncompatibleIndex, "\"incompatible_index\""),
        (ErrorCode::StorageFailure, "\"storage_failure\""),
        (ErrorCode::Internal, "\"internal\""),
    ];
    for (code, expected) in cases {
        assert_eq!(serde_json::to_string(&code).unwrap(), expected);
        // Round-trip through the hand-written tolerant deserializer too: a
        // typo there would otherwise degrade a real code to Unknown with
        // the suite green.
        let decoded: ErrorCode = serde_json::from_str(expected).unwrap();
        assert_eq!(decoded, code);
    }
}
