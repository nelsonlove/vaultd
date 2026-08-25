use std::io::Write;
use std::process::{Command, Stdio};

use vault_protocol::{Request, RequestEnvelope, Response, ResponseEnvelope, ResponseOutcome};

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
