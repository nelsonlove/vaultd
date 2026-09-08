use std::fs;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// One documentation file's text, resolved the one way this file resolves
/// paths. Factored out of [`assert_document_contains`] so a test that needs
/// the text itself does not hand-roll a second `read_to_string` with its own
/// relative path.
fn read_document(relative: &str) -> String {
    let path = repository_root().join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

fn assert_document_contains(relative: &str, required: &[&str]) {
    let path = repository_root().join(relative);
    let text = read_document(relative);
    for phrase in required {
        assert!(
            text.contains(phrase),
            "{} must contain {phrase:?}",
            path.display()
        );
    }
}

#[test]
fn required_foundation_documents_declare_their_contracts() {
    assert_document_contains(
        "README.md",
        &[
            "semantic runtime for Obsidian-compatible vaults",
            "Filesystem persistence",
            "Non-goals",
        ],
    );
    assert_document_contains(
        "VAULTD-COMPATIBILITY.md",
        &[
            "Tier 0 — Storage compatibility",
            "Tier 1 — Semantic compatibility",
            "Undocumented Obsidian internals",
        ],
    );
    assert_document_contains(
        "docs/adr/0001-core-language.md",
        &["Status: Accepted", "Decision: Rust", "Go"],
    );
    assert_document_contains(
        "docs/protocol.md",
        &[
            "Protocol version: `1`",
            "health",
            "apply_mutation",
            "subscribe",
        ],
    );
}

#[test]
fn persistent_index_documents_declare_the_executable_contract() {
    assert_document_contains(
        "README.md",
        &[
            "persistent SQLite",
            "startup and manual reconciliation",
            "filesystem watcher",
        ],
    );
    assert_document_contains(
        "VAULTD-COMPATIBILITY.md",
        &[
            "get_vault_info",
            "get_note",
            "refresh_index",
            "filesystem remains authoritative",
        ],
    );
    assert_document_contains(
        "docs/protocol.md",
        &[
            "generation_mismatch",
            "vault_changed_during_refresh",
            "list_references",
            "verify",
        ],
    );
}

#[test]
fn live_event_documents_declare_the_subscription_contract() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "subscribe_events",
            "unsubscribe",
            "generation_committed",
            "runtime_state_changed",
            "resync_required",
            "subscriber_lag",
            "oversized_change_set",
            "watcher_overflow",
            "root_invalidated",
            "runtime_recovered",
            "subscription_not_found",
            "runtime_not_ready",
            "runtime_overloaded",
            "index_in_use",
            "live_state",
            "--no-watch",
            "--watch-debounce-ms",
            "--reconcile-interval-seconds",
        ],
    );
    assert_document_contains(
        "README.md",
        &[
            "post-commit events",
            "bounded per-subscriber",
            "resync_required",
        ],
    );
    assert_document_contains(
        "VAULTD-COMPATIBILITY.md",
        &["subscribe_events", "post-commit"],
    );
}

/// The bounds documentation drifted once already: it described
/// `subscriber_lag` as what a slow stdio client experiences, which the
/// shipped dispatcher makes unreachable. These phrases pin the corrected
/// claims so the honest version cannot quietly revert.
#[test]
fn bounds_documentation_describes_the_shipped_transport() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            // The real stdio lag story, and its real symptom.
            "backpressure",
            "`resync_required { runtime_recovered }`",
            // Peer delivery is not independent on one connection.
            "Private queues bound memory, not latency.",
            // The bounds are the registry's, not the transport's.
            "regardless of transport",
            // The tuning flags are enforced, not merely conventional.
            "requires `--vault`",
            // Nullable in the type, never null on the wire in version 1.
            "nullable in the type",
            // `get_vault_info` actually shows the field it promises.
            "\"live_state\":\"watching\"",
        ],
    );
    assert_document_contains(
        "README.md",
        &["reconciliation is never stalled by a client"],
    );
}

#[test]
fn the_protocol_documents_the_write_path() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "## Mutations",
            "write_note",
            "patch_frontmatter",
            "rename_note",
            "revision_conflict",
            "case_collision",
            "read-modify-write",
            "## Snapshot sessions",
            "open_snapshot",
            "snapshot_notes",
            "config_changed",
            "--read-only",
        ],
    );
}

#[test]
fn the_mutation_baseline_declares_its_targets() {
    assert_document_contains(
        "docs/performance/vault-mutation-baseline.md",
        &[
            "write_note_commit",
            "rename_fanout_1000",
            "snapshot_hydration",
            "Profiling before tuning",
            "Target comparison",
        ],
    );
}

/// Every new error code appears in `## Errors` exactly once. A code documented
/// twice is a code two people edited independently, and a code documented zero
/// times is one a client meets with no way to look it up.
///
/// Scoped to the `## Errors` section rather than the whole document on
/// purpose: "Link repair failure reasons" is a *different* closed set that
/// reuses three of these spellings for its own `reason` codes
/// (`revision_conflict`, `index_unavailable`, and the burst-scoped entries),
/// in the same `- ` + backticked-name bullet shape. Counting document-wide
/// would fail on a collision that is not drift, and would keep failing
/// whichever of the two lists someone edited.
#[test]
fn every_new_error_code_is_documented_exactly_once() {
    let document = read_document("docs/protocol.md");
    let errors = document
        .split_once("\n## Errors\n")
        .expect("docs/protocol.md must have an `## Errors` section")
        .1;
    // Up to the next top-level section, so a later section's bullets are
    // never counted as error definitions.
    let errors = match errors.split_once("\n## ") {
        Some((section, _)) => section,
        None => errors,
    };
    for code in [
        "revision_conflict",
        "not_found",
        "parent_not_found",
        "target_exists",
        "case_collision",
        "zone_violation",
        "payload_too_large",
        "read_only",
        "snapshot_not_found",
        "too_many_snapshots",
    ] {
        // Matching the `- \`{code}\`` line prefix rather than a bare
        // substring is what keeps `not_found`, `parent_not_found`, and
        // `snapshot_not_found` apart: a `contains` check would count all
        // three against `not_found` and pass for the wrong reason.
        let definitions = errors
            .lines()
            .filter(|line| line.starts_with(&format!("- `{code}`")))
            .count();
        assert_eq!(definitions, 1, "`{code}` is defined {definitions} times");
    }
}

#[test]
fn the_protocol_documents_its_unknown_variant_tolerance() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "Unknown variants are tolerated, not fatal",
            "MUST treat an unrecognized value",
            "`Unknown` catch-all",
        ],
    );
}
