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
