use std::fs;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn assert_document_contains(relative: &str, required: &[&str]) {
    let path = repository_root().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
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
