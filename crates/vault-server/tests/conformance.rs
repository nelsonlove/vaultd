//! One fixture set, two transports, one transcript each.
//!
//! **What "byte for byte" can honestly mean here.** The two runs are two
//! daemons over two scratch vaults, because a single daemon cannot serve the
//! set twice from the same state — the set mutates. So six values differ for
//! reasons that have nothing to do with the transport, and exactly those are
//! normalized away before the comparison: `canonical_root` and
//! `vault_identity` (a different scratch directory), `refreshed_at_unix_ms`
//! (a different instant), `ctime_unix_ms` and `mtime_unix_ms` (the same files,
//! created and written at two different instants), and `socket_path` (one run
//! has one and the other does not, which is the point of the field).
//!
//! Everything else is compared as **bytes**, key order included. The
//! normalizer edits the raw line in place rather than re-serializing it
//! through `serde_json::Value`, whose map would alphabetize both sides and
//! quietly destroy the one property this comparison is named for. So every
//! generation number, every cursor, every revision, every error message, and
//! the order of every key must match exactly.
//!
//! Any other difference is a transport that has changed the protocol, which is
//! the thing this phase promised not to do.

mod daemon;
mod socket;

use std::path::Path;

use tempfile::TempDir;

use daemon::{Daemon, Transport};
use socket::ListeningDaemon;

/// The values blanked in place, so that their *presence* is still compared
/// even though their content cannot be.
const BLANKED: [&str; 5] = [
    "canonical_root",
    "vault_identity",
    "refreshed_at_unix_ms",
    "ctime_unix_ms",
    "mtime_unix_ms",
];

/// What a blanked value is replaced with.
const BLANK: &str = "\"«env»\"";

/// The one key removed rather than blanked: it is absent over stdio and
/// present over the socket, so blanking it in place could never equalize the
/// two sides. Which door has it is pinned by `tests/socket_info.rs`.
const REMOVED: &str = "socket_path";

/// Longest Unix socket address this platform accepts, in bytes.
const SOCKET_PATH_LIMIT: usize = 103;

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
/// the note list and the link resolver all have something to say — the
/// wikilink in `Folder/Nested.md` is what `resolve_link`, `get_backlinks` and
/// `list_references` are asked about.
///
/// The three scratch directories are taken from [`socket::tmp_root`] rather
/// than from `TempDir::new`, which resolves `$TMPDIR`: a bare `cargo test`
/// leaves that unset and would put the socket run's socket under the real OS
/// temp directory. This root is fixed, in-repo, and short — and the two
/// assertions below say so rather than assume it, because the budget is spent
/// on this worktree's own path and a longer one would otherwise fail with an
/// opaque bind error rather than a named one.
fn build_vault() -> (TempDir, TempDir, TempDir) {
    let root = socket::tmp_root();
    let vault = TempDir::new_in(&root).expect("vault tempdir");
    let index = TempDir::new_in(&root).expect("index tempdir");
    let run = TempDir::new_in(&root).expect("run tempdir");

    let socket_path = run.path().join("vaultd.sock");
    assert!(
        socket_path.starts_with(&root),
        "the socket must live under {}: {}",
        root.display(),
        socket_path.display()
    );
    assert!(
        socket_path.as_os_str().len() <= SOCKET_PATH_LIMIT,
        "the socket path is {} bytes, over the {SOCKET_PATH_LIMIT}-byte limit: {}",
        socket_path.as_os_str().len(),
        socket_path.display()
    );

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
    // The fixture base reads no `file.ctime`/`file.mtime` and no `now()`:
    // those differ between the two runs for reasons the normalizer does not
    // (and must not) blank.
    std::fs::write(
        vault.path().join("Views.base"),
        "formulas:\n  bad: 'title +'\nviews:\n  - type: table\n    name: Table\n    order: [file.name, title]\n  - type: cards\n    name: Cards\n  - type: table\n    name: Bad\n    order: [formula.bad]\n",
    )
    .expect("write Views.base");
    std::fs::write(vault.path().join("Broken.base"), "views: [\n").expect("write Broken.base");
    // The three non-finite numbers, so their `string` cells travel over both
    // doors (provisional until the Task 13 capture).
    std::fs::write(
        vault.path().join("Numbers.md"),
        "---\nbig: .inf\nsmall: -.inf\nodd: .nan\n---\n",
    )
    .expect("write Numbers.md");
    std::fs::write(
        vault.path().join("Numbers.base"),
        "views:\n  - type: table\n    name: Odd\n    filters: 'file.name == \"Numbers.md\"'\n    order: [big, small, odd]\n",
    )
    .expect("write Numbers.base");
    (vault, index, run)
}

/// Index just past the JSON string token starting at `from`, which must be its
/// opening quote. Escapes are honoured, so a quote inside the string does not
/// end it.
fn end_of_string(line: &str, from: usize) -> usize {
    let bytes = line.as_bytes();
    assert_eq!(bytes[from], b'"', "not the start of a string: {line}");
    let mut at = from + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => return at + 1,
            _ => at += 1,
        }
    }
    panic!("an unterminated string: {line}")
}

/// Index just past the scalar value starting at `from`.
///
/// Scalars only, and deliberately loud otherwise: every one of the six
/// normalized keys carries a string or a number today, and the day one of them
/// starts carrying an object is the day this normalizer has to be rewritten
/// rather than the day it silently mangles a line.
fn end_of_value(line: &str, from: usize) -> usize {
    let bytes = line.as_bytes();
    if bytes[from] == b'"' {
        return end_of_string(line, from);
    }
    assert!(
        bytes[from] != b'{' && bytes[from] != b'[',
        "a normalized key carries a composite value, which this normalizer cannot edit: {line}"
    );
    let mut at = from;
    while at < bytes.len() && !matches!(bytes[at], b',' | b'}' | b']') {
        at += 1;
    }
    at
}

/// Blank the five environment-dependent values and drop `socket_path`, by
/// editing the raw line rather than re-serializing it.
///
/// Nothing else is touched — not the key order, not the spacing, not a key
/// name that happens to appear inside a string value, because the scan only
/// treats a string as a key when a `:` follows it.
fn normalize(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    // Everything before `copied` is already in `out`; everything from `copied`
    // to `at` is pending and will be copied verbatim. Slices are only ever cut
    // at a quote, a colon or a comma, all of them ASCII, so a multi-byte
    // character in a note's body can never be split.
    let mut copied = 0usize;
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at] != b'"' {
            at += 1;
            continue;
        }
        let after_token = end_of_string(line, at);
        let mut colon = after_token;
        while colon < bytes.len() && bytes[colon].is_ascii_whitespace() {
            colon += 1;
        }
        if colon >= bytes.len() || bytes[colon] != b':' {
            // A string value, not a key. Step over it whole, so a key name
            // quoted inside someone's prose is never mistaken for a key.
            at = after_token;
            continue;
        }
        let key = &line[at + 1..after_token - 1];
        if !BLANKED.contains(&key) && key != REMOVED {
            // Keep scanning into the value: most of them are objects and
            // arrays whose own keys are the ones being looked for.
            at = colon + 1;
            continue;
        }
        let mut value = colon + 1;
        while value < bytes.len() && bytes[value].is_ascii_whitespace() {
            value += 1;
        }
        let after_value = end_of_value(line, value);
        if key == REMOVED {
            // The key goes, and with it exactly one adjacent comma — the one
            // before it where there is one, so `{"a":1,"socket_path":"…"}`
            // becomes `{"a":1}` rather than `{"a":1,}`.
            out.push_str(&line[copied..at]);
            let dropped_before = out.ends_with(',');
            if dropped_before {
                out.pop();
            }
            copied = after_value;
            if !dropped_before && copied < bytes.len() && bytes[copied] == b',' {
                copied += 1;
            }
            at = copied;
        } else {
            out.push_str(&line[copied..colon + 1]);
            out.push_str(BLANK);
            copied = after_value;
            at = after_value;
        }
    }
    out.push_str(&line[copied..]);
    out
}

/// The `next_cursor` a response carries, when it carries one that is not null.
fn next_cursor(line: &str) -> Option<String> {
    fn find(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::Object(object) => {
                if let Some(serde_json::Value::String(cursor)) = object.get("next_cursor") {
                    return Some(cursor.clone());
                }
                object.values().find_map(find)
            }
            serde_json::Value::Array(items) => items.iter().find_map(find),
            _ => None,
        }
    }
    find(&serde_json::from_str(line).expect("a JSON response line"))
}

/// The placeholder a fixture line uses to ask for the previous response's
/// cursor. A line carrying it when no cursor was offered fails the run, which
/// is how "the paging actually paged" is asserted rather than assumed.
const CURSOR_PLACEHOLDER: &str = "{{next_cursor}}";

/// One run's answers, and how many cursors it had to follow.
struct Run {
    lines: Vec<String>,
    cursors_followed: usize,
}

/// One open door, so that the driving loop below is written once and the only
/// thing the transport decides is which harness answers.
///
/// The two harnesses stay separate types with separate plumbing — a shared
/// trait would put the thing being compared and the thing comparing it into
/// one abstraction — and this enum is the smallest thing that lets one loop
/// talk to both.
enum Door {
    Stdio(Daemon),
    /// The listener is held only to keep the daemon alive and to kill it on
    /// drop; every request goes through the client.
    Socket {
        _listener: ListeningDaemon,
        client: socket::Client,
    },
}

impl Door {
    fn open(transport: Transport, vault: &TempDir, index: &TempDir, run: &TempDir) -> Self {
        match transport {
            Transport::Stdio => Self::Stdio(Daemon::for_vault(vault, index)),
            Transport::Socket => {
                let listener = ListeningDaemon::start(vault, index, run);
                let client = listener.connect();
                Self::Socket {
                    _listener: listener,
                    client,
                }
            }
        }
    }

    fn exchange(&mut self, line: &str) -> Vec<String> {
        match self {
            Self::Stdio(daemon) => daemon.exchange(line),
            Self::Socket { client, .. } => client.exchange(line),
        }
    }

    fn drain_events(&mut self) -> Vec<String> {
        match self {
            Self::Stdio(daemon) => daemon.drain_events(),
            Self::Socket { client, .. } => client.drain_events(),
        }
    }
}

/// Run `lines` through one door and return every line the daemon wrote in
/// answer, in arrival order — responses and events interleaved exactly as they
/// came off the wire.
///
/// Arrival position is the point. A transport that delivered an event before
/// its `subscribe_events` response, or held every event back to the end of the
/// connection, produces the same *set* of lines and a different transcript.
fn run_through(transport: Transport, lines: &[String]) -> Run {
    let (vault, index, run) = build_vault();
    let mut door = Door::open(transport, &vault, &index, &run);
    let mut transcript = Vec::new();
    let mut cursors_followed = 0;
    let mut cursor: Option<String> = None;

    for line in lines {
        let asked = if line.contains(CURSOR_PLACEHOLDER) {
            let found = cursor.as_deref().unwrap_or_else(|| {
                panic!("a fixture line asked to follow a cursor that was never offered: {line}")
            });
            cursors_followed += 1;
            // Escaped as JSON and then unquoted, because the placeholder sits
            // inside a JSON string in the fixture file.
            let escaped = serde_json::to_string(found).expect("escape a cursor");
            line.replace(CURSOR_PLACEHOLDER, &escaped[1..escaped.len() - 1])
        } else {
            line.clone()
        };
        let written = door.exchange(&asked);
        for answered in &written {
            if let Some(found) = next_cursor(answered) {
                cursor = Some(found);
            }
        }
        transcript.extend(written);
    }
    transcript.extend(door.drain_events());
    Run {
        lines: transcript,
        cursors_followed,
    }
}

fn is_response(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .expect("a JSON line")
        .as_object()
        .is_some_and(|object| object.contains_key("outcome"))
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

/// One door's run, normalized.
fn normalized(transport: Transport, lines: &[String]) -> (Vec<String>, usize) {
    let run = run_through(transport, lines);
    (
        run.lines.iter().map(|line| normalize(line)).collect(),
        run.cursors_followed,
    )
}

/// Every event in the transcript must sit where it arrived — before the last
/// response, not swept to the tail.
fn assert_events_are_where_they_arrived(transcript: &[String], door: &str) {
    let last_response = transcript
        .iter()
        .rposition(|line| is_response(line))
        .unwrap_or_else(|| panic!("{door}: a transcript with no responses at all"));
    let first_event = transcript
        .iter()
        .position(|line| !is_response(line))
        .unwrap_or_else(|| panic!("{door}: the fixture set produced no events at all"));
    assert!(
        first_event < last_response,
        "{door}: every event landed after every response, which means the transcript \
         records arrival order nowhere\n{}",
        transcript.join("\n")
    );
}

#[test]
fn the_socket_answers_the_fixture_set_exactly_as_stdio_does() {
    let fixtures = fixtures();
    let (over_stdio, stdio_cursors) = normalized(Transport::Stdio, &fixtures);
    let (over_socket, socket_cursors) = normalized(Transport::Socket, &fixtures);

    assert_same("the fixture set", &over_stdio, &over_socket);
    assert!(
        over_stdio.len() > fixtures.len(),
        "the fixture set ran and produced events: {} lines for {} requests",
        over_stdio.len(),
        fixtures.len()
    );

    // The paging is real on both doors: a cursor was offered and followed.
    assert_eq!(
        (stdio_cursors, socket_cursors),
        (3, 3),
        "both doors must have followed the three cursors the fixture set asks for"
    );
    assert!(
        over_stdio
            .iter()
            .any(|line| line.contains(r#""next_cursor":""#)),
        "no response carried a non-null cursor, so the paging proved nothing"
    );

    // c52 carries all three non-finite texts as `string` cells.
    assert!(
        over_stdio.iter().any(|line| line.contains(
            r#""cells":[{"kind":"string","value":"Infinity"},{"kind":"string","value":"-Infinity"},{"kind":"string","value":"NaN"}]"#
        )),
        "the non-finite row is in the transcript"
    );

    assert_events_are_where_they_arrived(&over_stdio, "stdio");
    assert_events_are_where_they_arrived(&over_socket, "socket");
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

    let (over_stdio, _) = normalized(Transport::Stdio, &lines);
    let (over_socket, _) = normalized(Transport::Socket, &lines);

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
/// The spec's "Error handling" bullet used to put malformed JSON with the
/// other two and say the connection stays open; it does not, and has not since
/// stdio was the only door — an envelope that cannot be parsed cannot be
/// attributed to a request id, so there is nothing to answer and the reader
/// reports it as fatal input. What this phase must not change is that the
/// socket does the same thing, which is what is asserted here.
///
/// Each door gets its own vault and its own index. They would in fact be safe
/// to share — the stdio daemon's `Drop` blocks until the child is reaped, and
/// it lives in a block that ends first — but the index carries an exclusive
/// writer lease, so an ordering slip would surface as a 20 s readiness panic in
/// the socket harness rather than as anything this test is about.
#[test]
fn a_line_that_is_not_json_is_answered_by_neither_door() {
    let line = r#"{"version":1,"id":"r05","request":"#;

    let mut over_stdio = {
        let (vault, index, _run) = build_vault();
        let mut daemon = Daemon::for_vault(&vault, &index);
        daemon.send(line);
        daemon.drain_events()
    };
    let mut over_socket = {
        let (vault, index, run) = build_vault();
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

/// The normalizer is the one place this test's honesty can be weakened — a
/// seventh key added to the blank list would make any transport difference in
/// that key vanish, and every other test in the crate would stay green. So the
/// normalizer is pinned against a line built to catch exactly that.
///
/// The line is deliberately **not** in alphabetical key order, and the expected
/// output keeps that order: a normalizer that re-serialized through
/// `serde_json::Value` would sort the keys and fail here, which is the property
/// the module doc claims and this test makes true.
#[test]
fn the_normalizer_touches_exactly_the_six_named_values_and_nothing_else() {
    let line = concat!(
        r#"{"version":1,"id":"n","outcome":{"status":"ok","value":{"type":"get_vault_info","#,
        r#""value":{"generation":3,"canonical_root":"/scratch/v","vault_identity":"blake3:ab","#,
        r#""note_count":2,"refreshed_at_unix_ms":1756100000000,"socket_path":"/run/v.sock","#,
        r#""rows":[{"path":"One.md","mtime_unix_ms":1,"ctime_unix_ms":2,"size":41}],"#,
        r#""note":"a body mentioning \"ctime_unix_ms\":9 inside a string"}}}}"#
    );
    let expected = concat!(
        r#"{"version":1,"id":"n","outcome":{"status":"ok","value":{"type":"get_vault_info","#,
        r#""value":{"generation":3,"canonical_root":"«env»","vault_identity":"«env»","#,
        r#""note_count":2,"refreshed_at_unix_ms":"«env»","#,
        r#""rows":[{"path":"One.md","mtime_unix_ms":"«env»","ctime_unix_ms":"«env»","size":41}],"#,
        r#""note":"a body mentioning \"ctime_unix_ms\":9 inside a string"}}}}"#
    );
    assert_eq!(
        normalize(line),
        expected,
        "the normalizer must blank the five, drop `socket_path` with its comma, keep every \
         other key at its value and in its place, and never touch a key name that appears \
         inside a string"
    );

    // Named separately so that widening the list fails on a statement about
    // the list itself, not only on a golden line.
    assert_eq!(BLANKED.len(), 5, "the blank list must stay five keys long");
    for key in ["generation", "note_count", "size", "path", "revision"] {
        assert!(
            !BLANKED.contains(&key) && key != REMOVED,
            "`{key}` is load-bearing and must never be normalized away"
        );
    }
}

/// `socket_path` is dropped wherever it sits in the object, and takes exactly
/// one comma with it.
#[test]
fn dropping_the_socket_path_leaves_valid_json_wherever_it_sat() {
    for (line, expected) in [
        (r#"{"a":1,"socket_path":"/s","b":2}"#, r#"{"a":1,"b":2}"#),
        (r#"{"socket_path":"/s","b":2}"#, r#"{"b":2}"#),
        (r#"{"a":1,"socket_path":"/s"}"#, r#"{"a":1}"#),
        (r#"{"socket_path":"/s"}"#, r#"{}"#),
    ] {
        let got = normalize(line);
        assert_eq!(got, expected, "normalizing {line}");
        serde_json::from_str::<serde_json::Value>(&got)
            .unwrap_or_else(|error| panic!("{got} is not JSON: {error}"));
    }
}
