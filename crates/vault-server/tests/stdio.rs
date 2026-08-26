use std::io::Write;
use std::process::{Command, Output, Stdio};

use vault_protocol::{
    ErrorCode, PROTOCOL_VERSION, Request, RequestEnvelope, Response, ResponseEnvelope,
    ResponseOutcome,
};

fn run_vaultd(arguments: &[&str], lines: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd");

    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        for line in lines {
            writeln!(stdin, "{line}").expect("write request line");
        }
    }
    drop(child.stdin.take());

    child.wait_with_output().expect("wait for vaultd")
}

fn parse_responses(output: &Output) -> Vec<ResponseEnvelope> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("deserialize response line"))
        .collect()
}

/// A client that never subscribes must see the version 1 stream it has
/// always seen: response envelopes only, with exactly the three top-level
/// keys, and no event envelope anywhere. This is the byte-compatibility
/// guarantee that makes the event work additive.
fn assert_unsubscribed_stream_is_byte_compatible(output: &Output) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let value: serde_json::Value =
            serde_json::from_str(line).expect("every output line is one JSON object");
        let object = value.as_object().expect("every output line is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["id", "outcome", "version"],
            "an unsubscribed stream carries only response envelopes: {line}"
        );
        assert!(
            !object.contains_key("subscription_id") && !object.contains_key("event"),
            "no event may reach a client that never subscribed: {line}"
        );
    }
}

#[test]
fn vaultd_serves_a_health_request_over_stdio() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd");

    let request = RequestEnvelope::new("process-1", Request::Health);
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(
            stdin,
            "{}",
            serde_json::to_string(&request).expect("serialize request")
        )
        .expect("write request");
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for vaultd");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let response: ResponseEnvelope =
        serde_json::from_slice(&output.stdout).expect("deserialize response");
    assert_eq!(response.id, "process-1");
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
}

#[test]
fn vaultd_answers_future_versions_with_incompatible_version_and_stays_alive() {
    let health = serde_json::to_string(&RequestEnvelope::new("after-1", Request::Health))
        .expect("serialize health request");
    let output = run_vaultd(
        &[],
        &[
            r#"{"version":2,"id":"future-1","request":{"method":"get_note"}}"#,
            &health,
        ],
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let responses = parse_responses(&output);
    assert_eq!(
        responses.len(),
        2,
        "daemon must keep serving after the refusal"
    );

    assert_eq!(responses[0].id, "future-1");
    match &responses[0].outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::IncompatibleVersion);
            assert_eq!(error.supported_version, Some(PROTOCOL_VERSION));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }

    assert_eq!(responses[1].id, "after-1");
    assert!(matches!(
        responses[1].outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
}

#[test]
fn vaultd_answers_unknown_methods_with_invalid_request_and_stays_alive() {
    let health = serde_json::to_string(&RequestEnvelope::new("after-2", Request::Health))
        .expect("serialize health request");
    let output = run_vaultd(
        &[],
        &[
            r#"{"version":1,"id":"unknown-1","request":{"method":"get_note"}}"#,
            &health,
        ],
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let responses = parse_responses(&output);
    assert_eq!(
        responses.len(),
        2,
        "daemon must keep serving after the refusal"
    );

    assert_eq!(responses[0].id, "unknown-1");
    match &responses[0].outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::InvalidRequest);
            assert_eq!(error.supported_version, None);
        }
        other => panic!("unexpected outcome: {other:?}"),
    }

    assert_eq!(responses[1].id, "after-2");
    assert!(matches!(
        responses[1].outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
}

#[test]
fn vaultd_rejects_malformed_input_with_a_clear_failure() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd");

    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(stdin, "{{\"not\":\"a request\"}}").expect("write malformed line");
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for vaultd");
    assert_eq!(output.status.code(), Some(2));

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.starts_with("vaultd: "),
        "stderr must name the daemon: {stderr}"
    );
    assert!(
        output.stdout.is_empty(),
        "no response may precede the failure"
    );
}

#[test]
fn vaultd_with_explicit_vault_serves_note_then_refresh_requests() {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    std::fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index.path().join("index.sqlite3");
    let requests = [
        // The startup catch-up runs on the coordinator thread, so the first
        // request that must observe generation 1 asks for it explicitly
        // rather than racing the cold build.
        r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{"verify":false}}}"#,
        r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Note.md"}}}"#,
    ];
    let output = run_vaultd(
        &[
            "--vault",
            vault.path().to_str().unwrap(),
            "--index",
            index_path.to_str().unwrap(),
        ],
        &requests,
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = parse_responses(&output);
    assert_eq!(responses.len(), 2);
    assert!(matches!(
        responses[0].outcome,
        ResponseOutcome::Ok(Response::RefreshIndex(_))
    ));
    assert!(matches!(
        responses[1].outcome,
        ResponseOutcome::Ok(Response::GetNote(_))
    ));
    assert_unsubscribed_stream_is_byte_compatible(&output);
}

/// The runtime commits generations whether or not anyone is listening. A
/// client that never subscribed must still see nothing but its own answers.
#[test]
fn an_unsubscribed_stream_never_carries_an_event() {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    std::fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index.path().join("index.sqlite3");
    let requests = [
        r#"{"version":1,"id":"r1","request":{"method":"refresh_index","params":{"verify":false}}}"#,
        r#"{"version":1,"id":"r2","request":{"method":"refresh_index","params":{"verify":true}}}"#,
        r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#,
    ];
    let output = run_vaultd(
        &[
            "--vault",
            vault.path().to_str().unwrap(),
            "--index",
            index_path.to_str().unwrap(),
        ],
        &requests,
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = parse_responses(&output);
    assert_eq!(responses.len(), 3);
    assert_unsubscribed_stream_is_byte_compatible(&output);
}
