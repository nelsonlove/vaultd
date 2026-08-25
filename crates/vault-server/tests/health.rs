use vault_protocol::{
    ErrorCode, PROTOCOL_VERSION, Request, RequestEnvelope, Response, ResponseOutcome,
};
use vault_server::Server;

#[test]
fn server_dispatches_health_requests() {
    let mut server = Server::health_only();
    let response = server.handle(RequestEnvelope::new("health-1", Request::Health));

    assert_eq!(response.id, "health-1");
    match response.outcome {
        ResponseOutcome::Ok(Response::Health(health)) => {
            assert_eq!(health.service, "vaultd");
            assert_eq!(health.status, "ok");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[test]
fn server_rejects_incompatible_versions_before_dispatch() {
    let mut request = RequestEnvelope::new("health-2", Request::Health);
    request.version = PROTOCOL_VERSION + 1;

    let mut server = Server::health_only();
    let response = server.handle(request);
    match response.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::IncompatibleVersion);
            assert_eq!(error.supported_version, Some(PROTOCOL_VERSION));
        }
        other => panic!("unexpected response: {other:?}"),
    }
}
