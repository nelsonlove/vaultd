use vault_core::{SourceDocument, SourceError, SourceSpan, VaultPath};

fn path() -> VaultPath {
    VaultPath::new("Notes/Unicode.md").expect("valid path")
}

#[test]
fn preserves_utf8_and_crlf_bytes_exactly() {
    let text = "---\r\ntitle: café\r\n---\r\n# Héllo\r\n";
    let document = SourceDocument::new(path(), text);

    assert_eq!(document.text(), text);
    let start = text.find("café").expect("fixture contains value");
    let span = SourceSpan::new(start, start + "café".len()).expect("valid span");
    assert_eq!(document.slice(span), Some("café"));
}

#[test]
fn revision_is_stable_for_identical_bytes_and_changes_with_content() {
    let first = SourceDocument::new(path(), "same");
    let second = SourceDocument::new(path(), "same");
    let changed = SourceDocument::new(path(), "different");

    assert_eq!(first.revision(), second.revision());
    assert_ne!(first.revision(), changed.revision());
    assert!(first.revision().as_str().starts_with("blake3:"));
}

#[test]
fn rejects_invalid_utf8_without_lossy_conversion() {
    assert!(matches!(
        SourceDocument::from_utf8(path(), vec![0xff, 0xfe]),
        Err(SourceError::InvalidUtf8 { .. })
    ));
}

#[test]
fn slice_rejects_non_utf8_boundaries() {
    let document = SourceDocument::new(path(), "é");
    let middle = SourceSpan::new(1, 2).expect("ordered byte range");
    assert_eq!(document.slice(middle), None);
}
