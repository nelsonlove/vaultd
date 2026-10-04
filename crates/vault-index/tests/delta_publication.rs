mod common;

use vault_index::{
    DeltaPublication, DeltaPublishOutcome, Generation, NoteReplacement, ResolutionReplacement,
};

/// A delta publication that replaces only `Changed.md` must leave every
/// storage identity for `Stable.md`'s unrelated reference to `Other.md`
/// exactly as it was, and must report structural counts scoped to the one
/// note it actually touched.
#[test]
fn delta_publication_leaves_unaffected_reference_identity_untouched() {
    let mut fixture = common::delta_publication_fixture();
    fixture.service.refresh(false).expect("cold build");

    let before = fixture.reference_storage_identity("Stable.md", 0);
    let outcome = fixture.publish_changed_note("Changed.md", "# Changed\n[[Target]]\n");
    let counts = match outcome {
        DeltaPublishOutcome::Committed { counts, .. } => counts,
        DeltaPublishOutcome::GenerationChanged => panic!("unexpected generation conflict"),
    };

    assert_eq!(counts.notes_replaced, 1);
    assert_eq!(counts.references_replaced, 1);
    assert_eq!(fixture.reference_storage_identity("Stable.md", 0), before);
    assert_eq!(counts.unaffected_references_touched, 0);

    // The counts alone don't prove anything was actually written correctly:
    // a `publish_delta` that wrote nothing but returned these same counts
    // would still pass everything above. Read the new body and its resolved
    // reference back through the public query path.
    let changed_path = vault_core::VaultPath::new("Changed.md").expect("changed path");
    let indexed = fixture
        .service
        .get_note(&changed_path)
        .expect("changed note is readable");
    assert_eq!(indexed.note.source.text(), "# Changed\n[[Target]]\n");
    assert_eq!(indexed.outgoing.len(), 1);
    assert!(
        matches!(
            indexed.outgoing[0].resolution,
            vault_core::Resolution::Resolved { .. }
        ),
        "the new [[Target]] reference must have resolved, not just been counted: {:?}",
        indexed.outgoing[0].resolution
    );

    // Delta-vs-full equivalence: rebuild the whole graph from the persisted
    // notes and scan diagnostics and prove every stored resolution and
    // diagnostic still matches the rebuild, exactly the check a full
    // publication is already held to.
    fixture
        .service
        .snapshot_for_test()
        .expect("stored delta state matches a fresh full rebuild");
}

/// A `NoteReplacement` whose note has an outgoing reference, supplied
/// without a matching `ResolutionReplacement` for that reference, must never
/// commit: `replace_note` gives the recreated reference a brand-new
/// `note_references.id`, so without a matching resolution row both read
/// paths (`INNER JOIN resolutions`) would silently drop it. The whole
/// transaction — including the note replacement itself — must roll back.
#[test]
fn a_replaced_note_missing_resolution_coverage_fails_and_rolls_back() {
    let mut fixture = common::delta_publication_fixture();
    fixture.service.refresh(false).expect("cold build");

    let before_generation = fixture
        .service
        .current_generation()
        .expect("current generation")
        .expect("prior generation");
    let before_stable = fixture.reference_storage_identity("Stable.md", 0);

    let changed_path = vault_core::VaultPath::new("Changed.md").expect("changed path");
    let source = vault_core::SourceDocument::new(changed_path.clone(), "# Changed\n[[Target]]\n");
    let note = vault_core::parse_note(source);
    let fingerprint = vault_index::FileFingerprint {
        size: note.source.text().len() as u64,
        modified_seconds: 1,
        modified_nanos: 0,
    };
    let notes = vec![NoteReplacement { note, fingerprint }];
    // Deliberately no `ResolutionReplacement` for Changed.md's one reference.

    let mut store = fixture.open_delta_store();
    let error = store
        .publish_delta(DeltaPublication {
            expected: before_generation,
            notes: &notes,
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &[],
            scan_diagnostics: None,
            tree: &vault_index::TreeDelta::default(),
            bases: &vault_index::BaseDelta::default(),
        })
        .expect_err("missing resolution coverage must fail");
    match &error {
        vault_index::IndexError::IncompleteResolutionCoverage(path) => {
            assert_eq!(path, "Changed.md");
        }
        other => panic!("expected IncompleteResolutionCoverage, got {other:?}"),
    }
    drop(store);

    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(before_generation)
    );
    assert_eq!(
        fixture.reference_storage_identity("Stable.md", 0),
        before_stable
    );
    let restored_changed = fixture
        .service
        .get_note(&changed_path)
        .expect("changed note still present");
    assert_eq!(restored_changed.note.source.text(), "# Changed\n");
    assert!(restored_changed.outgoing.is_empty());
}

/// A `ResolutionReplacement` naming an ordinal that does not exist fails
/// after the note's own rows have already been replaced within the same
/// transaction; the whole transaction — including that note replacement —
/// must roll back, leaving the prior generation and every row (including the
/// changed note's own previous content) exactly as they were.
#[test]
fn a_failure_during_resolution_replacement_rolls_back_the_note_replacement_too() {
    let mut fixture = common::delta_publication_fixture();
    fixture.service.refresh(false).expect("cold build");

    let before_generation = fixture
        .service
        .current_generation()
        .expect("current generation")
        .expect("prior generation");
    let before_stable = fixture.reference_storage_identity("Stable.md", 0);

    let changed_path = vault_core::VaultPath::new("Changed.md").expect("changed path");
    let source = vault_core::SourceDocument::new(
        changed_path.clone(),
        "# Changed\n[[Target]]\n".to_string(),
    );
    let note = vault_core::parse_note(source);
    let fingerprint = vault_index::FileFingerprint {
        size: note.source.text().len() as u64,
        modified_seconds: 1,
        modified_nanos: 0,
    };
    let notes = vec![NoteReplacement { note, fingerprint }];
    // Ordinal 5 does not exist on the freshly replaced `Changed.md` (it has
    // exactly one reference, ordinal 0): the reference-id lookup fails.
    let resolutions = vec![ResolutionReplacement {
        source_path: changed_path.clone(),
        ordinal: 5,
        resolution: vault_core::Resolution::Unresolved,
        dependencies: Vec::new(),
        diagnostic: None,
    }];

    let mut store = fixture.open_delta_store();
    let error = store
        .publish_delta(DeltaPublication {
            expected: before_generation,
            notes: &notes,
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &resolutions,
            scan_diagnostics: None,
            tree: &vault_index::TreeDelta::default(),
            bases: &vault_index::BaseDelta::default(),
        })
        .expect_err("missing ordinal must fail");
    assert!(matches!(error, vault_index::IndexError::Storage(_)));
    drop(store);

    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(before_generation)
    );
    assert_eq!(
        fixture.reference_storage_identity("Stable.md", 0),
        before_stable
    );
    let restored_changed = fixture
        .service
        .get_note(&changed_path)
        .expect("changed note still present");
    assert_eq!(restored_changed.note.source.text(), "# Changed\n");
    assert!(restored_changed.outgoing.is_empty());
}

/// A second `ResolutionReplacement` that fails must roll back even a
/// resolution row already written earlier in the same transaction.
#[test]
fn a_later_failure_rolls_back_an_earlier_successful_resolution_replacement() {
    let mut fixture = common::delta_publication_fixture();
    fixture.service.refresh(false).expect("cold build");

    let before_generation = fixture
        .service
        .current_generation()
        .expect("current generation")
        .expect("prior generation");
    let before_stable = fixture.reference_storage_identity("Stable.md", 0);

    let stable_path = vault_core::VaultPath::new("Stable.md").expect("stable path");
    let changed_path = vault_core::VaultPath::new("Changed.md").expect("changed path");

    let resolutions = vec![
        // Valid: rewrites Stable's own existing reference to a different
        // resolution value (proving a real write happens here).
        ResolutionReplacement {
            source_path: stable_path.clone(),
            ordinal: 0,
            resolution: vault_core::Resolution::Unresolved,
            dependencies: Vec::new(),
            diagnostic: None,
        },
        // Invalid: no such ordinal on Changed.md, forces a mid-transaction
        // failure after the Stable rewrite above already executed.
        ResolutionReplacement {
            source_path: changed_path,
            ordinal: 9,
            resolution: vault_core::Resolution::Unresolved,
            dependencies: Vec::new(),
            diagnostic: None,
        },
    ];

    let mut store = fixture.open_delta_store();
    let error = store
        .publish_delta(DeltaPublication {
            expected: before_generation,
            notes: &[],
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &resolutions,
            scan_diagnostics: None,
            tree: &vault_index::TreeDelta::default(),
            bases: &vault_index::BaseDelta::default(),
        })
        .expect_err("missing ordinal must fail");
    assert!(matches!(error, vault_index::IndexError::Storage(_)));
    drop(store);

    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(before_generation)
    );
    assert_eq!(
        fixture.reference_storage_identity("Stable.md", 0),
        before_stable
    );
}

/// Advancing the generation from a second connection before publication must
/// be detected as a compare-and-swap conflict, with zero committed row
/// changes — not merely "no error".
#[test]
fn a_concurrent_generation_advance_yields_generation_changed_with_no_committed_rows() {
    let mut fixture = common::delta_publication_fixture();
    fixture.service.refresh(false).expect("cold build");

    let before_generation = fixture
        .service
        .current_generation()
        .expect("current generation")
        .expect("prior generation");
    let before_stable = fixture.reference_storage_identity("Stable.md", 0);

    // A second raw connection advances the generation out from under the
    // publication we are about to attempt.
    let raw = rusqlite::Connection::open(&fixture.config.index_path).expect("raw open");
    raw.execute(
        "UPDATE index_metadata SET generation = generation + 1 WHERE singleton = 1",
        [],
    )
    .expect("advance generation");
    drop(raw);

    let changed_path = vault_core::VaultPath::new("Changed.md").expect("changed path");
    let source = vault_core::SourceDocument::new(changed_path.clone(), "# Changed\n[[Target]]\n");
    let note = vault_core::parse_note(source);
    let fingerprint = vault_index::FileFingerprint {
        size: note.source.text().len() as u64,
        modified_seconds: 1,
        modified_nanos: 0,
    };
    let notes = vec![NoteReplacement { note, fingerprint }];

    let mut store = fixture.open_delta_store();
    let outcome = store
        .publish_delta(DeltaPublication {
            expected: before_generation,
            notes: &notes,
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &[],
            scan_diagnostics: None,
            tree: &vault_index::TreeDelta::default(),
            bases: &vault_index::BaseDelta::default(),
        })
        .expect("publish_delta call itself must not error");
    assert!(matches!(outcome, DeltaPublishOutcome::GenerationChanged));
    drop(store);

    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(Generation::new(before_generation.get() + 1)),
        "only the raw connection's own bump may be visible"
    );
    assert_eq!(
        fixture.reference_storage_identity("Stable.md", 0),
        before_stable
    );
    // The raw connection's bump is a foreign publication: adopt it before
    // reading, or this service's readers refuse to answer for a generation
    // they never installed live state for.
    fixture
        .service
        .resync_published()
        .expect("adopt the foreign generation");
    let changed_note = fixture
        .service
        .get_note(&changed_path)
        .expect("changed note still present");
    assert_eq!(
        changed_note.note.source.text(),
        "# Changed\n",
        "the rejected publication must not have written the new body"
    );
}
