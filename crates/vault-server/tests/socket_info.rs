//! `get_vault_info` names the socket, and only when there is one.
//!
//! This is also the **cross-language pin** on the path rule: a daemon started
//! with `--listen` and no value reports the path it actually bound, and the
//! host's `test/engine-probe.test.ts` asserts its own `vaultdSocketPathFor`
//! against the same digest for the same root. If the two rules ever diverge,
//! one of the two tests goes red rather than `engine: auto` silently spawning
//! a second daemon beside a perfectly good one.

mod daemon;
mod socket;

use daemon::Daemon;
use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome};

fn scratch() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

fn vault_info(outcome: ResponseOutcome) -> vault_protocol::GetVaultInfoResponse {
    match outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => info,
        other => panic!("get_vault_info was refused: {other:?}"),
    }
}

#[test]
fn a_listening_daemon_names_its_socket() {
    let (vault, index, run) = scratch();
    let socket = run.path().join("vaultd.sock");
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut client = daemon.connect();
    client.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let info = vault_info(
        client
            .call(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#)
            .outcome,
    );
    assert_eq!(
        info.socket_path.as_deref(),
        Some(socket.display().to_string().as_str()),
        "a client on any connection can tell another where to knock"
    );
}

#[test]
fn a_stdio_only_daemon_omits_the_field_entirely() {
    let (vault, index, _run) = scratch();
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let raw = daemon.call_raw(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#);
    let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON response line");
    let info = value
        .get("outcome")
        .and_then(|outcome| outcome.get("value"))
        .and_then(|value| value.get("value"))
        .expect("the response payload");
    assert!(
        info.get("socket_path").is_none(),
        "the field is skipped rather than serialized as null, so a version 1 \
         client that never subscribed sees the bytes it always saw: {info}"
    );
}

#[test]
fn listen_with_no_value_binds_the_documented_default_path() {
    let (vault, index, _run) = scratch();
    // `XDG_RUNTIME_DIR` is honoured first, so this exercises the real rule
    // without touching the developer's own `~/.cache`. Pointed at the bare
    // process temp directory rather than a fresh `TempDir` under it — the
    // default path spends 29 bytes after this directory (`/vaultd/` + 16 hex
    // + `.sock`) against a 103-byte `sockaddr_un` limit, and a `.tmpXXXXXX`
    // component would push a checkout at this depth over it (see
    // `socket_default_path.rs`, which hits the same ceiling). Set on the
    // child alone — this process's environment is never mutated, because
    // `cargo test` runs cases in threads.
    let runtime_dir = std::env::temp_dir();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args([
            "--vault",
            vault.path().to_str().expect("utf-8"),
            "--index",
            index.path().join("index.sqlite3").to_str().expect("utf-8"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
            "--listen",
        ])
        .env("XDG_RUNTIME_DIR", &runtime_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start vaultd --listen with no value");

    let canonical = std::fs::canonicalize(vault.path()).expect("canonicalize the vault root");
    let expected = runtime_dir.join("vaultd").join(format!(
        "{}.sock",
        vault_server::listener::socket_digest(&canonical)
    ));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !expected.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        expected.exists(),
        "the default path is <run dir>/<digest>.sock: {}",
        expected.display()
    );
    let mut client = socket::Client::over(
        std::os::unix::net::UnixStream::connect(&expected).expect("connect to the default path"),
    );
    client.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let info = vault_info(
        client
            .call(r#"{"version":1,"id":"v","request":{"method":"get_vault_info"}}"#)
            .outcome,
    );
    assert_eq!(
        info.socket_path.as_deref(),
        Some(expected.display().to_string().as_str()),
        "and the daemon reports the path it actually bound"
    );
    let _ = child.kill();
    let _ = child.wait();
}
