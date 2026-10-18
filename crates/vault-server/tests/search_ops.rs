mod daemon;

use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

use daemon::Daemon;

/// The in-repo scratch root (`target/tmp`), from this crate's manifest
/// directory rather than `TMPDIR` — the socket harness's `tmp_root` rule.
fn scratch() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

/// A scratch vault holding exactly `files`.
fn vault_of(files: &[(&str, &str)]) -> (TempDir, TempDir) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    for (path, body) in files {
        let full = vault.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, body).unwrap();
    }
    (vault, index)
}

fn started(vault: &TempDir, index: &TempDir) -> Daemon {
    let mut daemon = Daemon::for_vault(vault, index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon
}

fn ok(daemon: &mut Daemon, line: &str) -> Response {
    match daemon.call(line).outcome {
        ResponseOutcome::Ok(response) => response,
        ResponseOutcome::Err(error) => panic!("{line}: {error:?}"),
    }
}

fn err(daemon: &mut Daemon, line: &str) -> vault_protocol::ProtocolError {
    match daemon.call(line).outcome {
        ResponseOutcome::Err(error) => error,
        ResponseOutcome::Ok(response) => panic!("{line}: expected an error, got {response:?}"),
    }
}

fn search(params: &str) -> String {
    format!(r#"{{"version":1,"id":"q","request":{{"method":"search","params":{params}}}}}"#)
}

fn answer(daemon: &mut Daemon, params: &str) -> vault_protocol::SearchResponse {
    match ok(daemon, &search(params)) {
        Response::Search(answer) => answer,
        other => panic!("{params}: a search answer, got {other:?}"),
    }
}

fn paths(answer: &vault_protocol::SearchResponse) -> Vec<&str> {
    answer.items.iter().map(|item| item.path.as_str()).collect()
}

fn meeting_vault() -> (TempDir, TempDir) {
    vault_of(&[
        (
            "Notes/Kickoff.md",
            "---\nkind: x\n---\nThe meeting ran long.\n#project\n",
        ),
        ("Notes/Retro.md", "meeting about work\n#project\n"),
        ("Notes/Standup.md", "meeting\n"),
        ("img/meeting.png", "png"),
    ])
}

#[test]
fn search_answers_files_spans_locs_and_line_text() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let found = answer(&mut daemon, r#"{"query":"meeting -work tag:#project"}"#);
    assert_eq!(paths(&found), ["Notes/Kickoff.md"]);
    assert_eq!(found.total_files, 1);
    let first = &found.items[0].content_matches[0];
    // Line 3 starts at byte 16, after the three frontmatter lines.
    assert_eq!((first.span.start, first.span.end), (20, 27));
    assert_eq!(
        (first.start.line, first.start.col, first.start.offset),
        (3, 4, 20)
    );
    assert_eq!(first.line_text.as_deref(), Some("The meeting ran long."));
    assert_eq!(first.line_text_start, Some(16));
    let bare = answer(
        &mut daemon,
        r#"{"query":"meeting -work tag:#project","context":"none"}"#,
    );
    assert_eq!(bare.items[0].content_matches[0].line_text, None);
}

#[test]
fn attachments_are_reached_by_file_and_path_only() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    assert_eq!(
        paths(&answer(&mut daemon, r#"{"query":"meeting"}"#)),
        ["Notes/Kickoff.md", "Notes/Retro.md", "Notes/Standup.md"]
    );
    let files = answer(&mut daemon, r#"{"query":"file:meeting"}"#);
    assert_eq!(paths(&files), ["img/meeting.png"]);
    assert_eq!(files.items[0].kind, vault_protocol::DocumentKindDto::File);
}

#[test]
fn paging_cuts_one_answer_and_the_cursor_binds_its_parameters() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let first = answer(&mut daemon, r#"{"query":"meeting","limit":2}"#);
    assert_eq!(paths(&first), ["Notes/Kickoff.md", "Notes/Retro.md"]);
    assert_eq!(first.total_files, 3);
    let cursor = first.next_cursor.clone().expect("a second page");
    let second = answer(
        &mut daemon,
        &format!(r#"{{"query":"meeting","limit":2,"cursor":"{cursor}"}}"#),
    );
    assert_eq!(paths(&second), ["Notes/Standup.md"]);
    assert_eq!(second.next_cursor, None);
    let other = err(
        &mut daemon,
        &search(&format!(
            r#"{{"query":"standup","limit":2,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(other.code, ErrorCode::InvalidCursor);
    let other_sort = err(
        &mut daemon,
        &search(&format!(
            r#"{{"query":"meeting","sort":"file_name_desc","limit":2,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(other_sort.code, ErrorCode::InvalidCursor);
}

#[test]
fn a_cursor_from_an_older_generation_is_generation_mismatch() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let first = answer(&mut daemon, r#"{"query":"meeting","limit":1}"#);
    let cursor = first.next_cursor.unwrap();
    ok(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"New.md","content":"meeting\n","expected":{"absent":true}}}}"#,
    );
    let stale = err(
        &mut daemon,
        &search(&format!(
            r#"{{"query":"meeting","limit":1,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(stale.code, ErrorCode::GenerationMismatch);
    assert!(stale.current_generation.unwrap() > first.generation);
}

#[test]
fn malformed_and_unsupported_queries_are_refused_with_a_position() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let malformed = err(&mut daemon, &search(r#"{"query":"a b)"}"#));
    assert_eq!(malformed.code, ErrorCode::QueryInvalid);
    assert_eq!(malformed.position, Some(3));
    let unsupported = err(&mut daemon, &search(r#"{"query":"x line:(a b)"}"#));
    assert_eq!(unsupported.code, ErrorCode::UnsupportedOperator);
    assert_eq!(unsupported.position, Some(2));
    assert!(unsupported.message.contains("line:"));
}

#[test]
fn limits_and_closed_values_are_checked() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    assert_eq!(
        err(&mut daemon, &search(r#"{"query":"a","limit":0}"#)).code,
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        err(&mut daemon, &search(r#"{"query":"a","limit":1001}"#)).code,
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        err(&mut daemon, &search(r#"{"query":"a","sort":"relevance"}"#)).code,
        ErrorCode::InvalidRequest
    );
    let empty = answer(&mut daemon, r#"{"query":"   "}"#);
    assert_eq!(
        (empty.total_files, empty.items.len()),
        (0, 0),
        "an empty query is an empty answer, not an error"
    );
}

#[test]
fn the_match_case_toggle_and_the_sorts_reach_the_engine() {
    let (vault, index) = vault_of(&[("b.md", "Meeting\n"), ("a.md", "meeting\n")]);
    let mut daemon = started(&vault, &index);
    assert_eq!(
        paths(&answer(
            &mut daemon,
            r#"{"query":"Meeting","match_case":true}"#
        )),
        ["b.md"]
    );
    assert_eq!(
        paths(&answer(
            &mut daemon,
            r#"{"query":"meeting","sort":"file_name_desc"}"#
        )),
        ["b.md", "a.md"]
    );
}

#[test]
fn health_only_mode_is_index_unavailable() {
    let mut daemon = Daemon::start(&[]);
    assert_eq!(
        err(&mut daemon, &search(r#"{"query":"a"}"#)).code,
        ErrorCode::IndexUnavailable
    );
}
