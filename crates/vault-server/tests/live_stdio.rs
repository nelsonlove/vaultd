//! The stdio transport with events multiplexed onto it.
//!
//! Everything here runs the real `vaultd` binary against a real temporary
//! vault, because the properties under test are transport properties: what
//! order lines reach stdout in, and what a client is promised about lines it
//! did not ask for.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::{
    ErrorCode, EventEnvelope, LiveStateDto, Response, ResponseEnvelope, ResponseOutcome,
    RuntimeEventDto,
};

/// Generous on purpose: these bounds exist to turn a hang into a failing
/// test, not to assert anything about timing.
const LINE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
enum Line {
    Response(Box<ResponseEnvelope>),
    Event(Box<EventEnvelope>),
}

impl Line {
    fn classify(raw: &str) -> Self {
        let value: serde_json::Value =
            serde_json::from_str(raw).unwrap_or_else(|error| panic!("not JSON: {raw:?}: {error}"));
        let object = value.as_object().expect("every output line is an object");
        if object.contains_key("outcome") {
            Line::Response(Box::new(
                serde_json::from_str(raw).expect("decode response envelope"),
            ))
        } else {
            Line::Event(Box::new(
                serde_json::from_str(raw).expect("decode event envelope"),
            ))
        }
    }
}

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

impl Daemon {
    fn start(arguments: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
        }
    }

    fn send(&mut self, request: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is still open");
        writeln!(stdin, "{request}").expect("write request line");
        stdin.flush().expect("flush request line");
    }

    fn next_line(&mut self, label: &str) -> Line {
        match self.lines.recv_timeout(LINE_TIMEOUT) {
            Ok(line) => Line::classify(&line),
            Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for {label}"),
            Err(RecvTimeoutError::Disconnected) => {
                panic!("the daemon closed stdout while waiting for {label}")
            }
        }
    }

    /// Read until the response to `id` arrives, returning every event seen on
    /// the way in order.
    fn response(&mut self, id: &str) -> (ResponseEnvelope, Vec<EventEnvelope>) {
        let mut events = Vec::new();
        loop {
            match self.next_line(&format!("the response to {id:?}")) {
                Line::Response(response) => {
                    assert_eq!(response.id, id, "responses arrive in request order");
                    return (*response, events);
                }
                Line::Event(event) => events.push(*event),
            }
        }
    }

    fn close(&mut self) {
        drop(self.stdin.take());
    }

    fn finish(mut self) {
        self.close();
        let status = self.child.wait().expect("wait for vaultd");
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        assert!(status.success(), "the daemon exited with {status:?}");
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

struct Fixture {
    vault: TempDir,
    _index: TempDir,
    arguments: Vec<String>,
}

fn fixture() -> Fixture {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    std::fs::write(vault.path().join("Note.md"), "# Note\n").expect("write note");
    let arguments = vec![
        "--vault".to_string(),
        vault.path().to_str().expect("utf-8 vault path").to_string(),
        "--index".to_string(),
        index
            .path()
            .join("index.sqlite3")
            .to_str()
            .expect("utf-8 index path")
            .to_string(),
        // No periodic reconciliation: every generation in this test is one
        // the test itself caused.
        "--reconcile-interval-seconds".to_string(),
        "0".to_string(),
    ];
    Fixture {
        vault,
        _index: index,
        arguments,
    }
}

impl Fixture {
    fn arguments(&self) -> Vec<&str> {
        self.arguments.iter().map(String::as_str).collect()
    }
}

fn subscribe(id: &str) -> String {
    format!(
        r#"{{"version":1,"id":"{id}","request":{{"method":"subscribe_events","params":{{}}}}}}"#
    )
}

fn unsubscribe(id: &str, subscription: &str) -> String {
    format!(
        r#"{{"version":1,"id":"{id}","request":{{"method":"unsubscribe","params":{{"subscription_id":"{subscription}"}}}}}}"#
    )
}

fn get_note(id: &str, path: &str) -> String {
    format!(
        r#"{{"version":1,"id":"{id}","request":{{"method":"get_note","params":{{"path":"{path}"}}}}}}"#
    )
}

fn health(id: &str) -> String {
    format!(r#"{{"version":1,"id":"{id}","request":{{"method":"health"}}}}"#)
}

fn refresh(id: &str) -> String {
    format!(
        r#"{{"version":1,"id":"{id}","request":{{"method":"refresh_index","params":{{"verify":false}}}}}}"#
    )
}

fn vault_info(id: &str) -> String {
    format!(r#"{{"version":1,"id":"{id}","request":{{"method":"get_vault_info"}}}}"#)
}

fn subscription_response(response: &ResponseEnvelope) -> vault_protocol::SubscribeEventsResponse {
    match &response.outcome {
        ResponseOutcome::Ok(Response::SubscribeEvents(subscribed)) => subscribed.clone(),
        other => panic!("unexpected subscribe outcome: {other:?}"),
    }
}

/// The whole subscription lifecycle, end to end: the response comes first,
/// then post-commit events naming generations a read can actually see, then
/// silence once the client lets go.
#[test]
fn a_subscription_streams_post_commit_generations_and_stops_on_unsubscribe() {
    let fixture = fixture();
    let mut daemon = Daemon::start(&fixture.arguments());

    daemon.send(&subscribe("s"));
    let (response, before) = daemon.response("s");
    assert!(
        before.is_empty(),
        "no event may precede the subscribe response that created the subscription"
    );
    let subscribed = subscription_response(&response);
    let id = subscribed.subscription_id.clone();
    assert!(id.starts_with("sub-"), "opaque identifier, got {id:?}");

    // Wait until the cold build has published something, so the edit below
    // is a genuinely separate generation rather than part of the catch-up.
    let baseline = loop {
        match daemon.next_line("the first event naming a committed generation") {
            Line::Event(event) => {
                assert_eq!(event.subscription_id, id);
                match event.event {
                    RuntimeEventDto::GenerationCommitted(committed) => break committed.generation,
                    RuntimeEventDto::ResyncRequired(resync) => {
                        break resync
                            .current_generation
                            .expect("a resync always names a generation");
                        // A resync without a generation must never reach the
                        // wire: there would be nothing to re-read at.
                    }
                    RuntimeEventDto::RuntimeStateChanged(_) => continue,
                    // Ruling B2 (task 1): an event kind this build has never
                    // heard of names no generation; keep waiting for one
                    // that does.
                    RuntimeEventDto::Unknown => continue,
                }
            }
            Line::Response(other) => panic!("unexpected response: {other:?}"),
        }
    };

    let updated = "# Note\n\nchanged by the live stdio test\n";
    std::fs::write(fixture.vault.path().join("Note.md"), updated).expect("edit note");

    let committed = loop {
        match daemon.next_line("a post-commit event for the edit") {
            Line::Event(event) => {
                assert_eq!(event.subscription_id, id);
                match event.event {
                    RuntimeEventDto::GenerationCommitted(committed)
                        if committed.generation > baseline =>
                    {
                        break committed;
                    }
                    _ => continue,
                }
            }
            Line::Response(other) => panic!("unexpected response: {other:?}"),
        }
    };
    assert!(
        committed.generation > baseline,
        "the event must name a greater committed generation"
    );
    assert!(
        matches!(
            committed.changes,
            vault_protocol::ChangeSetDto::Detailed { ref modified, .. }
                if modified.contains(&"Note.md".to_string())
        ),
        "the change set must name the edited note: {:?}",
        committed.changes
    );

    // The event is post-commit: the generation it names is already readable.
    daemon.send(&get_note("n", "Note.md"));
    let (response, _) = daemon.response("n");
    match response.outcome {
        ResponseOutcome::Ok(Response::GetNote(note)) => {
            assert_eq!(note.note.source, updated);
            assert!(
                note.generation >= committed.generation,
                "a read after the event must see at least the generation it named"
            );
        }
        other => panic!("unexpected get_note outcome: {other:?}"),
    }

    daemon.send(&unsubscribe("u", &id));
    let (response, _) = daemon.response("u");
    match response.outcome {
        ResponseOutcome::Ok(Response::Unsubscribe(released)) => {
            assert_eq!(released.subscription_id, id);
        }
        other => panic!("unexpected unsubscribe outcome: {other:?}"),
    }

    // Anything queued for that subscription was flushed before the response
    // above, so a later event bearing its identifier is a defect. Force one
    // more committed generation, then fence with a request whose answer
    // proves the daemon processed everything the edit produced.
    std::fs::write(
        fixture.vault.path().join("Second.md"),
        "# Second\n\n[[Note]]\n",
    )
    .expect("write second note");
    daemon.send(&refresh("x"));
    let (_, stragglers) = daemon.response("x");
    assert!(
        stragglers.is_empty(),
        "a released subscription must receive nothing: {stragglers:?}"
    );
    std::thread::sleep(Duration::from_millis(300));
    daemon.send(&health("h"));
    let (_, stragglers) = daemon.response("h");
    assert!(
        stragglers.is_empty(),
        "a released subscription must receive nothing: {stragglers:?}"
    );

    daemon.finish();
}

/// Two clients, two queues. Every subscription is addressed by its own
/// identifier and neither sees the other's.
#[test]
fn every_subscription_is_addressed_by_its_own_identifier() {
    let fixture = fixture();
    let mut daemon = Daemon::start(&fixture.arguments());

    daemon.send(&subscribe("s1"));
    let (first, _) = daemon.response("s1");
    let first = subscription_response(&first).subscription_id;
    daemon.send(&subscribe("s2"));
    let (second, events) = daemon.response("s2");
    let second = subscription_response(&second).subscription_id;
    assert_ne!(first, second);
    for event in &events {
        assert_eq!(
            event.subscription_id, first,
            "only the first subscription existed while these were queued"
        );
    }

    std::fs::write(
        fixture.vault.path().join("Note.md"),
        "# Note\n\nsecond writer\n",
    )
    .expect("edit note");

    let mut seen_first = false;
    let mut seen_second = false;
    while !(seen_first && seen_second) {
        match daemon.next_line("an event for each subscription") {
            Line::Event(event) => {
                if event.subscription_id == first {
                    seen_first = true;
                } else if event.subscription_id == second {
                    seen_second = true;
                } else {
                    panic!("event for an unknown subscription: {event:?}");
                }
            }
            Line::Response(other) => panic!("unexpected response: {other:?}"),
        }
    }

    daemon.finish();
}

/// `get_vault_info` reports the runtime's observational state, which only a
/// live runtime can answer.
#[test]
fn get_vault_info_reports_the_runtimes_live_state() {
    let fixture = fixture();
    let mut daemon = Daemon::start(&fixture.arguments());

    // Subscribe first so the cold build is observable, then ask.
    daemon.send(&subscribe("s"));
    let _ = daemon.response("s");
    loop {
        match daemon.next_line("the cold build") {
            Line::Event(event) => match event.event {
                RuntimeEventDto::ResyncRequired(_) => break,
                RuntimeEventDto::GenerationCommitted(_) => break,
                RuntimeEventDto::RuntimeStateChanged(_) => continue,
                // Ruling B2 (task 1): an event kind this build has never
                // heard of is not the cold-build marker we're waiting for.
                RuntimeEventDto::Unknown => continue,
            },
            Line::Response(other) => panic!("unexpected response: {other:?}"),
        }
    }

    daemon.send(&vault_info("v"));
    let (response, _) = daemon.response("v");
    match response.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert!(
                matches!(
                    info.live_state,
                    Some(LiveStateDto::Watching)
                        | Some(LiveStateDto::CatchingUp)
                        | Some(LiveStateDto::PollingFallback)
                ),
                "a live runtime must report its state, got {:?}",
                info.live_state
            );
        }
        other => panic!("unexpected vault info outcome: {other:?}"),
    }

    daemon.finish();
}

/// Without a vault there is no runtime, so there is nothing to subscribe to
/// — and saying so is not the same as saying the index is missing.
#[test]
fn subscribing_without_a_vault_is_runtime_not_ready() {
    let mut daemon = Daemon::start(&[]);
    daemon.send(&subscribe("s"));
    let (response, _) = daemon.response("s");
    match response.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::RuntimeNotReady),
        other => panic!("unexpected subscribe outcome: {other:?}"),
    }

    daemon.send(&health("h"));
    let (response, _) = daemon.response("h");
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
    daemon.finish();
}

/// An identifier this process never issued is refused with the dedicated
/// code, and the daemon keeps serving.
#[test]
fn unsubscribing_an_unknown_identifier_is_refused_and_the_daemon_keeps_serving() {
    let fixture = fixture();
    let mut daemon = Daemon::start(&fixture.arguments());

    daemon.send(&unsubscribe("u", "sub-404"));
    let (response, _) = daemon.response("u");
    match response.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::SubscriptionNotFound),
        other => panic!("unexpected unsubscribe outcome: {other:?}"),
    }

    daemon.send(&health("h"));
    let (response, _) = daemon.response("h");
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
    daemon.finish();
}

/// `--no-watch` starts a runtime that never installs a watcher: manual
/// reconciliation still works and the runtime says it is polling.
#[test]
fn no_watch_starts_a_polling_runtime_that_still_reconciles_on_demand() {
    let fixture = fixture();
    let mut arguments = fixture.arguments();
    arguments.push("--no-watch");
    let mut daemon = Daemon::start(&arguments);

    daemon.send(&refresh("x"));
    let (response, _) = daemon.response("x");
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Ok(Response::RefreshIndex(_))
    ));

    daemon.send(&vault_info("v"));
    let (response, _) = daemon.response("v");
    match response.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert!(
                matches!(
                    info.live_state,
                    Some(LiveStateDto::PollingFallback) | Some(LiveStateDto::CatchingUp)
                ),
                "a runtime told not to watch must never claim to be watching, got {:?}",
                info.live_state
            );
        }
        other => panic!("unexpected vault info outcome: {other:?}"),
    }

    daemon.finish();
}

/// A subscriber that stops reading its own stdout must not wedge the daemon.
/// The writer fails, the runtime is shut down cleanly, and the process ends
/// — no thread is left holding the writer lease.
#[test]
fn a_client_that_stops_reading_never_wedges_the_daemon() {
    let fixture = fixture();
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(fixture.arguments())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd");
    let mut stdin = child.stdin.take().expect("child stdin");

    // Subscribe, then abandon stdout entirely.
    writeln!(stdin, "{}", subscribe("s")).expect("write subscribe");
    stdin.flush().expect("flush subscribe");
    drop(child.stdout.take());

    // Keep the vault moving, so the runtime keeps producing events nobody
    // will ever read.
    for index in 0..16 {
        std::fs::write(
            fixture.vault.path().join("Note.md"),
            format!("# Note\n\nround {index}\n"),
        )
        .expect("edit note");
        let _ = writeln!(stdin, "{}", health(&format!("h{index}")));
        let _ = stdin.flush();
    }
    drop(stdin);

    let (sender, waiter) = channel();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = sender.send(status.map(|status| status.code()));
    });
    let code = waiter
        .recv_timeout(Duration::from_secs(30))
        .expect("the daemon must exit rather than wedge")
        .expect("wait for vaultd");
    assert!(
        matches!(code, Some(0) | Some(2)),
        "unexpected exit code: {code:?}"
    );
}

/// Out-of-range tuning is refused at startup rather than silently clamped.
#[test]
fn out_of_range_debounce_is_refused_at_startup() {
    let fixture = fixture();
    let mut arguments = fixture.arguments();
    arguments.push("--watch-debounce-ms");
    arguments.push("1");
    let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run vaultd");
    assert!(!output.status.success(), "1 ms is below the accepted range");
    assert!(
        output.stdout.is_empty(),
        "a rejected invocation writes no protocol output"
    );
}

/// The runtime tuning flags describe a runtime, and health-only mode has
/// none. Accepting them there would silently do nothing, so they require
/// `--vault` exactly as `--index` does.
#[test]
fn runtime_tuning_flags_require_a_vault() {
    for flag in [
        vec!["--no-watch"],
        vec!["--watch-debounce-ms", "250"],
        vec!["--reconcile-interval-seconds", "0"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(&flag)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("run vaultd");
        assert!(
            !output.status.success(),
            "{flag:?} without --vault must be refused"
        );
        assert!(
            output.stdout.is_empty(),
            "a rejected invocation writes no protocol output"
        );
    }
}

/// Requiring a vault for the tuning flags must not make plain health-only
/// mode harder to reach: defaults are not the same as arguments.
#[test]
fn health_only_mode_needs_no_arguments_at_all() {
    let mut daemon = Daemon::start(&[]);
    daemon.send(&health("h"));
    let (response, _) = daemon.response("h");
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));
    daemon.finish();
}
