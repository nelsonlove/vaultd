use vault_core::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};

#[test]
fn vault_path_accepts_normalized_relative_paths() {
    let path = VaultPath::new("Projects/vaultd.md").expect("valid vault path");
    assert_eq!(path.as_str(), "Projects/vaultd.md");
}

#[test]
fn vault_path_rejects_paths_that_escape_the_vault() {
    assert_eq!(
        VaultPath::new("../outside.md"),
        Err(DomainError::InvalidVaultPath("../outside.md".into()))
    );
    assert_eq!(
        VaultPath::new("/absolute.md"),
        Err(DomainError::InvalidVaultPath("/absolute.md".into()))
    );
}

#[test]
fn identities_and_revisions_remain_opaque() {
    let id = NoteId::new("runtime:42").expect("non-empty note id");
    let revision = Revision::new("sha256:abc123").expect("non-empty revision");
    let note = NoteRef::new(
        Some(id.clone()),
        VaultPath::new("Notes/Example.md").expect("valid path"),
        Some("019fd012-e2ad-732d-aa86-df9768d8d961".into()),
    );

    assert_eq!(id.as_str(), "runtime:42");
    assert_eq!(revision.as_str(), "sha256:abc123");
    assert_eq!(note.runtime_id(), Some(&id));
    assert_eq!(
        note.semantic_id(),
        Some("019fd012-e2ad-732d-aa86-df9768d8d961")
    );
}

#[test]
fn source_span_rejects_an_inverted_range() {
    assert_eq!(
        SourceSpan::new(9, 4),
        Err(DomainError::InvalidSourceSpan { start: 9, end: 4 })
    );
    let span = SourceSpan::new(4, 9).expect("ordered span");
    assert_eq!((span.start(), span.end()), (4, 9));
}
