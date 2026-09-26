//! One fixture set, two transports, one transcript each.
//!
//! **What "byte for byte" can honestly mean here.** The two runs are two
//! daemons over two scratch vaults, because a single daemon cannot serve the
//! set twice from the same state — the set mutates. So a handful of values
//! differ for reasons that have nothing to do with the transport, and exactly
//! those are normalized away before the comparison: `canonical_root` and
//! `vault_identity` (a different scratch directory), `refreshed_at_unix_ms`
//! (a different instant), `ctime_unix_ms` and `mtime_unix_ms` (the same two
//! files, created and written at two different instants), and `socket_path`
//! (one run has one and the other does not, which is the point of the field).
//! Everything else — every generation number, every cursor, every revision,
//! every error message, every key in every order — must match exactly.
//!
//! Any other difference is a transport that has changed the protocol, which is
//! the thing this phase promised not to do.

mod daemon;
mod socket;

use std::path::Path;

use tempfile::TempDir;

use daemon::{Daemon, Transport};
use socket::ListeningDaemon;

fn fixtures() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/conformance.jsonl");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// A vault both runs get, identically. Two notes and a folder, so the tree,
/// the note list and the link resolver all have something to say.
///
/// The three scratch directories are taken from [`socket::tmp_root`] rather
/// than from `TempDir::new`, which resolves `$TMPDIR`: a bare `cargo test`
/// leaves that unset and would put the socket run's socket under the real OS
/// temp directory. This root is fixed, in-repo, and short enough that the
/// socket path beneath it stays inside the platform's address limit.
fn build_vault() -> (TempDir, TempDir, TempDir) {
    let root = socket::tmp_root();
    let vault = TempDir::new_in(&root).expect("vault tempdir");
    let index = TempDir::new_in(&root).expect("index tempdir");
    let run = TempDir::new_in(&root).expect("run tempdir");
    std::fs::create_dir(vault.path().join("Folder")).expect("create Folder");
    std::fs::write(
        vault.path().join("One.md"),
        "---\ntitle: One\n---\n\n# One\n\n- [ ] a task\n",
    )
    .expect("write One");
    std::fs::write(
        vault.path().join("Folder/Nested.md"),
        "# Nested\n\n[[One]]\n",
    )
    .expect("write Nested");
    (vault, index, run)
}

/// The environment-dependent values, normalized. Nothing else is touched: the
/// line is re-serialized from a `serde_json::Value`, which alphabetizes object
/// keys — so **both** transcripts are normalized the same way and key order is
/// compared separately, by `tests/stdio_key_order.rs`, which already pins it
/// end to end on the write path.
fn normalize(line: &str) -> String {
    let mut value: serde_json::Value = serde_json::from_str(line)
        .unwrap_or_else(|error| panic!("a response line that is not JSON: {line} ({error})"));
    blank(&mut value);
    serde_json::to_string(&value).expect("re-serialize a response line")
}

/// The five fields whose *value* depends on which daemon answered are blanked
/// in place, so their presence is still compared. `socket_path` is the one
/// field whose *presence* is the transport's own answer — absent over stdio,
/// the socket's path over the socket — so it is removed from both sides
/// instead; that it is present in exactly one of them is pinned by
/// `tests/socket_info.rs`, which is the test that owns the question.
fn blank(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            for key in [
                "canonical_root",
                "vault_identity",
                "refreshed_at_unix_ms",
                "ctime_unix_ms",
                "mtime_unix_ms",
            ] {
                if object.contains_key(key) {
                    object.insert(key.to_string(), serde_json::Value::String("«env»".into()));
                }
            }
            object.remove("socket_path");
            for nested in object.values_mut() {
                blank(nested);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                blank(item);
            }
        }
        _ => {}
    }
}

/// Run `lines` through one door and return every line the daemon wrote in
/// answer, in order, responses and events alike.
///
/// Events are included deliberately. A transport that dropped an event, or
/// delivered it on the wrong side of a response, would otherwise pass — and
/// "a `subscribe_events` response precedes its first event" is exactly the
/// ordering the per-connection loop exists to keep.
fn transcript_of(transport: Transport, lines: &[String]) -> Vec<String> {
    let (vault, index, run) = build_vault();
    match transport {
        Transport::Stdio => {
            let mut daemon = Daemon::for_vault(&vault, &index);
            let mut transcript = Vec::new();
            for line in lines {
                transcript.push(daemon.call_raw(line));
            }
            transcript.extend(daemon.drain_events());
            transcript
        }
        Transport::Socket => {
            let daemon = ListeningDaemon::start(&vault, &index, &run);
            let mut client = daemon.connect();
            let mut transcript = Vec::new();
            for line in lines {
                transcript.push(client.call_raw(line));
            }
            transcript.extend(client.drain_events());
            transcript
        }
    }
}

/// The fixture set through one door.
fn transcript(transport: Transport) -> Vec<String> {
    transcript_of(transport, &fixtures())
}

/// Compare two normalized transcripts line for line, naming the first
/// difference and both sides of it.
fn assert_same(what: &str, over_stdio: &[String], over_socket: &[String]) {
    assert_eq!(
        over_stdio.len(),
        over_socket.len(),
        "{what}: the two transports produced different numbers of lines\nstdio:\n{}\nsocket:\n{}",
        over_stdio.join("\n"),
        over_socket.join("\n")
    );
    for (at, (stdio, socket)) in over_stdio.iter().zip(over_socket.iter()).enumerate() {
        assert_eq!(
            stdio, socket,
            "{what}: line {at} differs between the transports\nstdio:  {stdio}\nsocket: {socket}"
        );
    }
}

fn normalized(transport: Transport, lines: &[String]) -> Vec<String> {
    transcript_of(transport, lines)
        .iter()
        .map(|line| normalize(line))
        .collect()
}

#[test]
fn the_socket_answers_the_fixture_set_exactly_as_stdio_does() {
    let over_stdio: Vec<String> = transcript(Transport::Stdio)
        .iter()
        .map(|line| normalize(line))
        .collect();
    let over_socket: Vec<String> = transcript(Transport::Socket)
        .iter()
        .map(|line| normalize(line))
        .collect();

    assert_same("the fixture set", &over_stdio, &over_socket);
    assert!(
        over_stdio.len() >= 22,
        "the fixture set ran: {} lines",
        over_stdio.len()
    );
}

/// The three refusals the spec's "Error handling" bullet names — a request the
/// decoder rejects, an unknown protocol version, and a line over the payload
/// cap — followed by a `health` that proves the connection is still there.
///
/// Separate from the fixture set because the oversized line is 16 MiB and has
/// no business sitting in a checked-in fixture file. "Bad JSON" here means a
/// line whose envelope parses and whose *request* does not: a line that is not
/// JSON at all is fatal to the connection rather than answered on it, which is
/// what the next test pins.
#[test]
fn the_three_refusals_read_identically_through_either_door() {
    let oversized = "a".repeat(16 * 1024 * 1024 + 1);
    let lines = [
        r#"{"version":1,"id":"r01","request":{"method":"get_note","params":{"path":42}}}"#
            .to_string(),
        r#"{"version":99,"id":"r02","request":{"method":"health"}}"#.to_string(),
        format!(
            r#"{{"version":1,"id":"r03","request":{{"method":"write_note","params":{{"path":"Big.md","content":{},"expected":{{"absent":true}}}}}}}}"#,
            serde_json::Value::String(oversized)
        ),
        r#"{"version":1,"id":"r04","request":{"method":"health"}}"#.to_string(),
    ];

    let over_stdio = normalized(Transport::Stdio, &lines);
    let over_socket = normalized(Transport::Socket, &lines);

    assert_same("the three refusals", &over_stdio, &over_socket);
    assert_eq!(over_stdio.len(), 4, "one answer per line: {over_stdio:?}");
    for (at, code) in [
        (0, "invalid_request"),
        (1, "incompatible_version"),
        (2, "payload_too_large"),
    ] {
        assert!(
            over_stdio[at].contains(code),
            "line {at} should refuse with {code}: {}",
            over_stdio[at]
        );
    }
    assert!(
        over_stdio[3].contains(r#""status":"ok""#),
        "the connection stayed open: {}",
        over_stdio[3]
    );
}

/// A line that is not JSON at all ends the connection without an answer,
/// identically through either door.
///
/// The spec's "Error handling" bullet puts malformed JSON with the other two
/// and says the connection stays open; the implementation does not, and has
/// not since stdio was the only door — an envelope that cannot be parsed
/// cannot be attributed to a request id, so there is nothing to answer and the
/// reader reports it as fatal input. What this phase must not change is that
/// the socket does the same thing, which is what is asserted here.
#[test]
fn a_line_that_is_not_json_is_answered_by_neither_door() {
    let line = r#"{"version":1,"id":"r05","request":"#;

    let (vault, index, run) = build_vault();
    let mut over_stdio = {
        let mut daemon = Daemon::for_vault(&vault, &index);
        daemon.send(line);
        daemon.drain_events()
    };
    let mut over_socket = {
        let daemon = ListeningDaemon::start(&vault, &index, &run);
        let mut client = daemon.connect();
        client.send(line);
        client.drain_events()
    };
    over_stdio.retain(|line| !line.trim().is_empty());
    over_socket.retain(|line| !line.trim().is_empty());

    assert_eq!(
        over_stdio, over_socket,
        "the two doors disagree about an unparseable line"
    );
    assert!(
        over_stdio.is_empty(),
        "an unparseable line was answered: {over_stdio:?}"
    );
}
