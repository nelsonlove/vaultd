use proptest::prelude::*;
use vault_core::{DiagnosticCode, SourceDocument, VaultPath, parse_note, parse_properties};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn arbitrary_utf8_never_panics(
        chars in proptest::collection::vec(any::<char>(), 0..=1024)
    ) {
        let text = chars.into_iter().collect::<String>();
        let source = SourceDocument::new(
            VaultPath::new("Fuzz.md").expect("valid path"),
            text,
        );
        let parsed = parse_note(source);
        prop_assert!(parsed.source.text().is_char_boundary(parsed.source.text().len()));
    }
}

// ---------------------------------------------------------------------------
// A specific upstream defect, pinned deterministically because the random
// sweep above will not find it: over 200 000 draws from the body strategy the
// `vault-index` frontmatter properties use, it came up zero times. It reached
// a reviewer exactly once, by seed luck.
// ---------------------------------------------------------------------------

/// markdown 1.0.0 **panics** — it does not return `Err` — on some legal
/// Markdown: `to_mdast.rs:193`, `"Cannot push to non-parent"`, on a run of
/// setext-ish underlines. A note body is arbitrary content that arrives from
/// the filesystem and `vaultd` parses it on its coordinator thread, so an
/// unwind here aborts the daemon over a file somebody merely saved.
const SETEXT_RUN_BODY: &str = "a\n-\n--\nA\n-\n";

/// Containment degrades the body, never the process — and never the note's
/// frontmatter, which is parsed before the body is touched.
#[test]
fn a_body_that_panics_the_upstream_markdown_parser_is_contained() {
    let text = format!("---\ntitle: x\n---\n{SETEXT_RUN_BODY}");
    let note = parse_note(SourceDocument::new(
        VaultPath::new("Poison.md").expect("valid path"),
        text,
    ));

    assert_eq!(note.properties.len(), 1, "the frontmatter still indexes");
    assert_eq!(note.properties[0].key.value, "title");
    assert!(
        note.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == DiagnosticCode::MarkdownParseError),
        "losing body semantics must be recorded, not silent: {:?}",
        note.diagnostics
    );
    assert!(
        note.references.is_empty() && note.headings.is_empty(),
        "no body-derived semantics survive a body that never parsed"
    );
}

#[test]
fn the_same_body_with_no_frontmatter_at_all_is_contained_too() {
    let note = parse_note(SourceDocument::new(
        VaultPath::new("Poison.md").expect("valid path"),
        SETEXT_RUN_BODY.to_string(),
    ));
    assert!(note.properties.is_empty());
    assert!(
        note.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == DiagnosticCode::MarkdownParseError),
        "{:?}",
        note.diagnostics
    );
}

/// The frontmatter-only entry point never reaches the Markdown parser at all.
/// That is why `patch_frontmatter` uses it: a caller with no use for body
/// semantics should not be exposed to the parser that produces them, quite
/// apart from the wasted work.
#[test]
fn parsing_only_frontmatter_never_reaches_the_body_parser() {
    let text = format!("---\ntitle: x\n---\n{SETEXT_RUN_BODY}");
    let properties = parse_properties(&SourceDocument::new(
        VaultPath::new("Poison.md").expect("valid path"),
        text,
    ));
    assert_eq!(properties.len(), 1);
    assert_eq!(properties[0].key.value, "title");
}
