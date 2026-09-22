//! The two additive `patch_frontmatter` wire forms, end to end through a
//! spawned `vaultd`: an array `key_path` whose segments are literal keys, and
//! `set_null`.
//!
//! End to end rather than at the decode boundary, for the reason
//! `tests/stdio_key_order.rs` gives: the hazard is a stage between stdin and
//! the frontmatter serializer, and only the bytes the daemon left on disk
//! prove there is none. These two forms exist because the headless host's
//! `FileManager` shim could not express them — a key whose name holds a `.`
//! was unaddressable, and `fm.key = null` had to be spelled as a deletion —
//! so the assertions here are the bytes that shim will produce.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

const NOTE: &str = "---\ntitle: One\nmy.key: old\ncount: 3\n---\n# One\n";

struct Vault {
    daemon: Daemon,
    vault: TempDir,
    _index: TempDir,
}

fn vault() -> Vault {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), NOTE).expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    Vault {
        daemon,
        vault,
        _index: index,
    }
}

impl Vault {
    fn patch(&mut self, patch: &str) -> ResponseOutcome {
        let line = format!(
            r#"{{"version":1,"id":"p","request":{{"method":"patch_frontmatter","params":{{"path":"One.md","patch":[{patch}],"expected":{{"any":true}}}}}}}}"#
        );
        self.daemon.call(&line).outcome
    }

    fn source(&self) -> String {
        std::fs::read_to_string(self.vault.path().join("One.md")).expect("read One back")
    }
}

fn expect_ok(outcome: ResponseOutcome) {
    match outcome {
        ResponseOutcome::Ok(Response::PatchFrontmatter(_)) => {}
        other => panic!("expected a patched note, got {other:?}"),
    }
}

/// Task 1e (a): each element of an array `key_path` is one literal key, so
/// the key named `my.key` is addressable and every other byte survives.
#[test]
fn an_array_key_path_addresses_a_key_whose_name_holds_a_dot() {
    let mut vault = vault();
    expect_ok(vault.patch(r#"{"key_path":["my.key"],"value":"new"}"#));
    assert_eq!(
        vault.source(),
        "---\ntitle: One\nmy.key: new\ncount: 3\n---\n# One\n"
    );
}

/// The dot-string form keeps the meaning it always had — `key` inside `my` —
/// which is exactly why the array form had to exist: sent for a literal
/// `my.key`, it grows a second, nested property beside the one the client
/// meant to edit.
#[test]
fn the_dot_string_form_still_addresses_a_nested_key() {
    let mut vault = vault();
    expect_ok(vault.patch(r#"{"key_path":"my.key","value":"new"}"#));
    let source = vault.source();
    assert!(
        source.contains("my.key: old\n"),
        "the literal key is untouched: {source}"
    );
    assert!(
        source.contains("my:\n  key: new\n"),
        "the dot path addressed a nested key: {source}"
    );
}

/// An array that addresses nothing is a client bug, not a key named "" — and
/// so is an array carrying an empty segment, which is the refusal the
/// dot-string form has always had. Both decode cleanly and are refused one
/// layer later, which is why they are pinned here rather than at the DTO.
#[test]
fn an_empty_array_key_path_is_invalid_request() {
    for spelling in [
        r#"{"key_path":[],"value":"new"}"#,
        r#"{"key_path":["a",""],"value":"new"}"#,
    ] {
        let mut vault = vault();
        match vault.patch(spelling) {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::InvalidRequest,
                "{spelling} must be refused: {error:?}"
            ),
            other => panic!("expected invalid_request for {spelling}, got {other:?}"),
        }
        assert_eq!(vault.source(), NOTE, "a refusal writes nothing");
    }
}

/// Task 1e (b): `set_null` writes a YAML null for the key — created when it
/// was absent — where a JSON `value: null` would have deleted it.
#[test]
fn set_null_writes_a_yaml_null_and_creates_the_key() {
    let mut vault = vault();
    expect_ok(vault.patch(r#"{"key_path":"reviewed","set_null":true}"#));
    assert_eq!(
        vault.source(),
        "---\ntitle: One\nmy.key: old\ncount: 3\nreviewed: null\n---\n# One\n"
    );

    expect_ok(vault.patch(r#"{"key_path":"title","set_null":true}"#));
    let source = vault.source();
    assert!(source.contains("title: null\n"), "{source}");
    assert!(
        source.contains("my.key: old\ncount: 3\n"),
        "nothing else moved: {source}"
    );

    expect_ok(vault.patch(r#"{"key_path":"count","value":null}"#));
    let source = vault.source();
    assert!(
        !source.contains("count"),
        "an explicit JSON null still deletes: {source}"
    );
}

/// The two actions contradict each other on one key, so the pair is refused
/// and the note is left alone. Both spellings of `value`, the explicit `null`
/// included.
#[test]
fn set_null_together_with_a_value_is_invalid_request() {
    let mut vault = vault();
    for entry in [
        r#"{"key_path":"title","value":"set","set_null":true}"#,
        r#"{"key_path":"title","value":null,"set_null":true}"#,
    ] {
        match vault.patch(entry) {
            ResponseOutcome::Err(error) => {
                assert_eq!(
                    error.code,
                    ErrorCode::InvalidRequest,
                    "contradictory actions must refuse: {error:?}"
                );
                // The code alone would let a later refactor reduce the message
                // to "invalid request" without a test noticing. A client that
                // sent the pair has to be told which field it was.
                assert!(
                    error.message.contains("set_null"),
                    "the refusal must name the conflicting field: {}",
                    error.message
                );
            }
            other => panic!("expected invalid_request, got {other:?}"),
        }
        assert_eq!(vault.source(), NOTE, "a refusal writes nothing");
    }
}
