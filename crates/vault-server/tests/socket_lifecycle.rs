//! What a listening daemon does at its edges: the file already at its path,
//! the signal that ends it, and the two meanings of end-of-stdin.

mod socket;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{LiveStateDto, RuntimeEventDto};

fn scratch_vault() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

fn arguments(vault: &TempDir, index: &TempDir, socket: &Path) -> Vec<String> {
    vec![
        "--vault".into(),
        vault.path().display().to_string(),
        "--index".into(),
        index.path().join("index.sqlite3").display().to_string(),
        "--no-watch".into(),
        "--reconcile-interval-seconds".into(),
        "0".into(),
        "--listen".into(),
        socket.display().to_string(),
    ]
}

#[test]
fn a_live_socket_is_refused_with_exit_2_and_the_message_names_the_path() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let _first = ListeningDaemon::start_at(&vault, &index, &socket);

    let second_index = TempDir::new().expect("a second index tempdir");
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &second_index, &socket))
        .stdin(Stdio::null())
        .output()
        .expect("run a second vaultd");
    assert_eq!(output.status.code(), Some(2), "a live socket is exit 2");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("another vaultd is listening at")
            && stderr.contains(&socket.display().to_string()),
        "the operator is told which daemon answered: {stderr}"
    );
}

#[test]
fn a_path_that_is_not_a_socket_is_refused_with_exit_2() {
    let (vault, index, run) = scratch_vault();
    let occupied = run.path().join("not-a-socket");
    std::fs::write(&occupied, b"something else lives here").expect("write the file");
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &occupied))
        .stdin(Stdio::null())
        .output()
        .expect("run vaultd");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("exists and is not a socket"),
        "and the file is named rather than removed"
    );
    assert_eq!(
        std::fs::read(&occupied).expect("the file is still there"),
        b"something else lives here",
        "a daemon never unlinks a file it did not create"
    );
}

#[test]
fn a_stale_socket_file_is_replaced_by_a_daemon_that_then_serves() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    {
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind a stale one");
        std::mem::forget(listener);
    }
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut client = daemon.connect();
    let answer = client.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#);
    assert_eq!(answer.id, "h", "the replacement daemon serves normally");
}

#[test]
fn sigterm_tells_every_connection_the_runtime_stopped_then_unlinks_the_socket() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let mut first = daemon.connect();
    let mut second = daemon.connect();
    for (client, id) in [(&mut first, "s1"), (&mut second, "s2")] {
        client.call(&format!(
            r#"{{"version":1,"id":"{id}","request":{{"method":"subscribe_events","params":{{}}}}}}"#
        ));
    }

    // SIGTERM, not a kill: the point is the orderly path.
    let pid = daemon.pid();
    // SAFETY: a plain `kill(2)` on a child this process spawned.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }, 0);

    for (label, client) in [("the first", &mut first), ("the second", &mut second)] {
        let event = client.wait_for_event(|envelope| {
            matches!(
                &envelope.event,
                RuntimeEventDto::RuntimeStateChanged(state) if state.live_state == LiveStateDto::Stopped
            )
        });
        assert!(
            matches!(&event.event, RuntimeEventDto::RuntimeStateChanged(_)),
            "{label} connection is told the runtime stopped before its writer closes"
        );
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    while socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !socket.exists(),
        "the socket file is gone after a clean exit"
    );
    assert!(
        UnixStream::connect(&socket).is_err(),
        "and nothing answers there"
    );
}

/// The shutdown must not depend on [`vault_server::listener::SocketListener::wake`].
///
/// `wake` connects to the socket only while the file at the path is still the
/// one this process bound — compared by `(device, inode)` — so a socket
/// replaced under a running daemon leaves nothing to nudge its accept loop
/// with. A daemon whose only exit was that nudge would sit in `accept` for
/// ever and have to be killed. The second exit is what this pins: the accept
/// wait is bounded, so the stopping flag is read again whether or not anything
/// connects.
#[test]
fn a_daemon_whose_socket_was_replaced_under_it_still_stops_on_a_signal() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let mut daemon = ListeningDaemon::start_at(&vault, &index, &socket);
    let pid = daemon.pid();

    // A stranger takes the name. The daemon's own listener is untouched — it
    // holds a bound descriptor, not a path — but nothing it does to the path
    // can reach it any more.
    std::fs::remove_file(&socket).expect("remove the daemon's own socket file");
    let stranger = std::os::unix::net::UnixListener::bind(&socket).expect("bind a stranger there");

    // SAFETY: a plain `kill(2)` on a child this process spawned.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }, 0);
    let status = daemon
        .wait_for_exit(Duration::from_secs(20))
        .expect("the daemon stopped on SIGTERM with its socket replaced under it");
    assert_eq!(
        status.code(),
        Some(0),
        "and stopped the orderly way, not by a signal's default disposition"
    );

    assert!(
        socket.exists(),
        "the stranger's socket survives: a daemon unlinks its own and nobody else's"
    );
    drop(stranger);
}

#[test]
fn end_of_stdin_ends_connection_zero_alone_while_a_listener_is_up() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &socket))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd --listen");
    // One request over stdio proves connection zero is served at all.
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(
            stdin,
            r#"{{"version":1,"id":"z","request":{{"method":"health"}}}}"#
        )
        .expect("write to connection zero");
    }
    drop(child.stdin.take());

    // The daemon must still be there, and must still serve the socket.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = None;
    while Instant::now() < deadline {
        if let Ok(stream) = UnixStream::connect(&socket) {
            connected = Some(stream);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut client = socket::Client::over(connected.expect("the daemon is still listening"));
    let answer = client.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#);
    assert_eq!(
        answer.id, "h",
        "end of stdin ends connection zero, not the daemon"
    );
    assert!(
        child.try_wait().expect("poll the child").is_none(),
        "the daemon's life is the listener's once it has one"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_daemon_started_with_stdin_closed_serves_the_socket_alone() {
    let (vault, index, run) = scratch_vault();
    let socket = run.path().join("vaultd.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments(&vault, &index, &socket))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd --listen with stdin closed");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = None;
    while Instant::now() < deadline {
        if let Ok(stream) = UnixStream::connect(&socket) {
            connected = Some(stream);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut client = socket::Client::over(connected.expect("the daemon bound its socket"));
    assert_eq!(
        client
            .call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#)
            .id,
        "h",
        "this is the systemd case: no parent owns the stdio"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn without_a_listener_end_of_stdin_still_ends_the_daemon() {
    let (vault, index, _run) = scratch_vault();
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args([
            "--vault",
            vault.path().to_str().expect("utf-8"),
            "--index",
            index.path().join("index.sqlite3").to_str().expect("utf-8"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("run vaultd with no listener");
    assert_eq!(
        output.status.code(),
        Some(0),
        "the unchanged daemon: stdin closes, it exits 0"
    );
}
