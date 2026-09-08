//! Machine-checks every fenced `json` example in `docs/protocol.md` against
//! the real protocol types: each block must parse as JSON and deserialize
//! cleanly as a `RequestEnvelope`, `ResponseEnvelope`, or `EventEnvelope`.
//!
//! This exists because the documentation drifted from the shipped types
//! once already (the `get_vault_info` example was missing `live_state`
//! until Task 12's checkpoint caught it by hand). A doc example that no
//! longer deserializes against the real DTOs is exactly the class of drift
//! a human proofreader misses and a type-checked example cannot.

use std::fs;
use std::path::{Path, PathBuf};

use vault_protocol::{EventEnvelope, RequestEnvelope, ResponseEnvelope};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every fenced ```json ... ``` block in `docs/protocol.md`, in document
/// order, as raw text (not yet parsed).
fn fenced_json_blocks() -> Vec<String> {
    let path = repository_root().join("docs/protocol.md");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));

    let mut blocks = Vec::new();
    let mut capturing = false;
    let mut current = String::new();
    for line in text.lines() {
        if !capturing {
            if line.trim() == "```json" {
                capturing = true;
                current.clear();
            }
            continue;
        }
        if line.trim() == "```" {
            capturing = false;
            blocks.push(std::mem::take(&mut current));
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    assert!(
        !capturing,
        "docs/protocol.md has an unterminated ```json fence"
    );
    blocks
}

/// Which protocol envelope shape one example's top-level keys name. Every
/// example in the document is exactly one of these three — there is no
/// fourth envelope shape in protocol version 1 — so an example matching
/// none of them is a doc bug, not something to skip.
enum EnvelopeShape {
    Request,
    Response,
    Event,
}

fn classify(value: &serde_json::Value) -> EnvelopeShape {
    let object = value.as_object().expect("a top-level JSON object");
    if object.contains_key("request") {
        EnvelopeShape::Request
    } else if object.contains_key("outcome") {
        EnvelopeShape::Response
    } else if object.contains_key("event") && object.contains_key("subscription_id") {
        EnvelopeShape::Event
    } else {
        panic!("example matches no known protocol envelope shape: {value}");
    }
}

#[test]
fn every_fenced_json_example_deserializes_against_the_real_protocol_types() {
    let blocks = fenced_json_blocks();
    assert!(
        blocks.len() >= 20,
        "expected docs/protocol.md to have most of its operations and events \
         illustrated with request, response, and event examples; found only {}",
        blocks.len()
    );

    let mut requests = 0;
    let mut responses = 0;
    let mut events = 0;

    for block in &blocks {
        let value: serde_json::Value = serde_json::from_str(block)
            .unwrap_or_else(|error| panic!("not valid JSON: {error}\n{block}"));
        match classify(&value) {
            EnvelopeShape::Request => {
                serde_json::from_value::<RequestEnvelope>(value).unwrap_or_else(|error| {
                    panic!("does not deserialize as RequestEnvelope: {error}\n{block}")
                });
                requests += 1;
            }
            EnvelopeShape::Response => {
                serde_json::from_value::<ResponseEnvelope>(value).unwrap_or_else(|error| {
                    panic!("does not deserialize as ResponseEnvelope: {error}\n{block}")
                });
                responses += 1;
            }
            EnvelopeShape::Event => {
                serde_json::from_value::<EventEnvelope>(value).unwrap_or_else(|error| {
                    panic!("does not deserialize as EventEnvelope: {error}\n{block}")
                });
                events += 1;
            }
        }
    }

    // One request/response pair per documented operation — the eleven read
    // and subscription operations, the ten mutation and raw-file operations,
    // and the four snapshot-session operations — plus the four event examples
    // and the three extra error-outcome examples under "Errors"
    // (`generation_mismatch`, `vault_changed_during_refresh`, and the
    // `storage_failure` shape that carries `current_revision` to say a write
    // reached disk). A count regression here means an operation lost its
    // documented example, not just that a JSON block became unparseable.
    assert_eq!(
        requests, 25,
        "expected 25 request examples, see docs/protocol.md"
    );
    assert_eq!(
        responses, 28,
        "expected 28 response examples (25 success + 3 error), see docs/protocol.md"
    );
    assert_eq!(events, 4, "expected 4 event examples, see docs/protocol.md");
}
