mod common;

use vault_core::{Resolution, Severity, Subpath, VaultPath};
use vault_index::{IndexError, ReferenceStatus};

#[test]
fn pagination_is_stable_and_rejects_a_cursor_after_generation_changes() {
    let mut fixture = common::service_with_many_notes(5);
    fixture.service.refresh(false).expect("initial refresh");
    let first = fixture
        .service
        .list_notes(None, Some(2))
        .expect("first page");
    assert_eq!(first.items.len(), 2);
    let cursor = first.next_cursor.expect("next cursor");

    fixture.add_note("ZZZ.md", "# changed");
    fixture.service.refresh(false).expect("next generation");
    let error = fixture
        .service
        .list_notes(Some(&cursor), Some(2))
        .expect_err("mixed generation must fail");

    assert!(matches!(error, IndexError::GenerationMismatch { .. }));
}

#[test]
fn full_pagination_walks_every_note_in_path_order() {
    let mut fixture = common::service_with_many_notes(5);
    fixture.service.refresh(false).expect("initial refresh");

    let mut collected = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = fixture
            .service
            .list_notes(cursor.as_deref(), Some(2))
            .expect("page");
        collected.extend(page.items.iter().map(|item| item.path.as_str().to_string()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(
        collected,
        [
            "Note-0.md",
            "Note-1.md",
            "Note-2.md",
            "Note-3.md",
            "Note-4.md"
        ]
    );
}

#[test]
fn get_note_returns_exact_source_semantics_diagnostics_and_resolutions() {
    let mut fixture = common::open_fixture_service();
    fixture.service.refresh(false).expect("refresh");
    let path = VaultPath::new("Wikilinks.md").unwrap();
    let indexed = fixture.service.get_note(&path).expect("indexed note");
    let oracle = fixture.scan.graph.note(&path).expect("oracle note");

    // `sections`/`list_items` aren't persisted or hydrated until Task 4 of
    // structural-parse-extension (schema v3); strip them from both sides so
    // this stays an oracle check on what the index store round-trips today.
    assert_eq!(
        common::strip_pending_structural_fields(indexed.note.clone()),
        common::strip_pending_structural_fields(oracle.clone())
    );
    assert_eq!(indexed.outgoing, fixture.scan.graph.outgoing(&path));
    assert_eq!(
        indexed.diagnostics,
        fixture
            .scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.path.as_ref() == Some(&path))
            .cloned()
            .collect::<Vec<_>>()
    );
}

#[test]
fn summaries_sort_by_path_and_prefer_the_title_property() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    let page = fixture.service.list_notes(None, None).expect("summaries");
    let paths: Vec<_> = page
        .items
        .iter()
        .map(|item| item.path.as_str().to_string())
        .collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);

    let target = page
        .items
        .iter()
        .find(|item| item.path.as_str() == "Target.md")
        .expect("target summary");
    assert_eq!(target.title.as_deref(), Some("The Target"));

    let source = page
        .items
        .iter()
        .find(|item| item.path.as_str() == "Source.md")
        .expect("source summary");
    assert_eq!(source.title.as_deref(), Some("Source"));
}

#[test]
fn limits_of_zero_and_above_the_maximum_are_invalid() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    assert!(matches!(
        fixture.service.list_notes(None, Some(0)),
        Err(IndexError::InvalidCursor(_))
    ));
    assert!(matches!(
        fixture.service.list_notes(None, Some(1_001)),
        Err(IndexError::InvalidCursor(_))
    ));
}

#[test]
fn backlinks_include_missing_subpath_references_to_the_resolved_file() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    let target = VaultPath::new("Target.md").unwrap();
    let page = fixture
        .service
        .get_backlinks(&target, None, None)
        .expect("backlinks");

    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().any(|reference| matches!(
        &reference.resolution,
        Resolution::MissingSubpath { subpath: Subpath::Heading(heading), .. } if heading == "Absent"
    )));
}

#[test]
fn resolved_filter_includes_missing_subpath_and_excludes_non_vault() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    let resolved = fixture
        .service
        .list_references(None, Some(ReferenceStatus::Resolved), None, None)
        .expect("resolved references");
    assert_eq!(resolved.items.len(), 2);

    let unresolved = fixture
        .service
        .list_references(None, Some(ReferenceStatus::Unresolved), None, None)
        .expect("unresolved references");
    assert_eq!(unresolved.items.len(), 1);
    assert_eq!(unresolved.items[0].reference.raw_target, "Missing");

    let ambiguous = fixture
        .service
        .list_references(None, Some(ReferenceStatus::Ambiguous), None, None)
        .expect("ambiguous references");
    assert_eq!(ambiguous.items.len(), 1);

    let all = fixture
        .service
        .list_references(None, None, None, None)
        .expect("all vault references");
    assert!(
        all.items
            .iter()
            .all(|reference| reference.resolution != Resolution::NonVault)
    );
    assert_eq!(all.items.len(), 4);
}

#[test]
fn diagnostics_filters_preserve_stable_order() {
    let mut fixture = common::open_fixture_service();
    fixture.service.refresh(false).expect("refresh");

    let all = fixture
        .service
        .get_diagnostics(None, None, None, None)
        .expect("all diagnostics");
    assert_eq!(all.items, fixture.scan.diagnostics);

    let warnings = fixture
        .service
        .get_diagnostics(None, Some(Severity::Warning), None, None)
        .expect("warning diagnostics");
    assert_eq!(
        warnings.items,
        fixture
            .scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
            .cloned()
            .collect::<Vec<_>>()
    );

    let path = VaultPath::new("Wikilinks.md").unwrap();
    let for_path = fixture
        .service
        .get_diagnostics(Some(&path), None, None, None)
        .expect("path diagnostics");
    assert_eq!(
        for_path.items,
        fixture
            .scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.path.as_ref() == Some(&path))
            .cloned()
            .collect::<Vec<_>>()
    );
}

#[test]
fn resolve_link_matches_the_core_fixture_resolution() {
    let mut fixture = common::open_fixture_service();
    fixture.service.refresh(false).expect("refresh");

    let source = VaultPath::new("Wikilinks.md").unwrap();
    let (_, resolution) = fixture
        .service
        .resolve_link(&source, "Properties and aliases")
        .expect("resolve link");
    assert!(matches!(
        resolution,
        Resolution::Resolved { ref target, .. } if target.as_str() == "Properties and aliases.md"
    ));

    let (_, ambiguous) = fixture
        .service
        .resolve_link(&source, "Foo")
        .expect("resolve ambiguous");
    assert!(matches!(ambiguous, Resolution::Ambiguous { .. }));
}

#[test]
fn warm_queries_read_no_note_bodies() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("refresh");
    fixture.reset_counts();

    let page = fixture.service.list_notes(None, None).expect("list");
    let path = VaultPath::new("One.md").unwrap();
    fixture.service.get_note(&path).expect("get note");
    fixture
        .service
        .get_backlinks(&path, None, None)
        .expect("backlinks");
    fixture
        .service
        .list_references(None, None, None, None)
        .expect("references");
    fixture
        .service
        .get_diagnostics(None, None, None, None)
        .expect("diagnostics");
    fixture.service.vault_info().expect("vault info");
    fixture
        .service
        .resolve_link(&path, "Two")
        .expect("resolve link");

    assert_eq!(page.items.len(), 2);
    assert_eq!(fixture.body_reads(), 0);
}

#[test]
fn missing_exact_path_is_note_not_found() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    let missing = VaultPath::new("Nope.md").unwrap();
    assert!(matches!(
        fixture.service.get_note(&missing),
        Err(IndexError::NoteNotFound(_))
    ));
}

#[test]
fn queries_without_a_generation_are_unavailable() {
    let fixture = common::queries_fixture();

    assert!(matches!(
        fixture.service.list_notes(None, None),
        Err(IndexError::IndexUnavailable)
    ));
    assert!(matches!(
        fixture.service.vault_info(),
        Err(IndexError::IndexUnavailable)
    ));
}

#[test]
fn vault_info_reports_identity_state_and_counts() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    let info = fixture.service.vault_info().expect("vault info");
    assert_eq!(info.state, vault_index::IndexState::Ready);
    assert_eq!(info.note_count, 4);
    assert!(info.refreshed_at_unix_ms.is_some());
    assert_eq!(info.vault_identity.len(), 64);
}

#[test]
fn principal_queries_use_indexed_plans() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");
    let connection = vault_index::open_index_for_test(&fixture.config).expect("plan connection");

    let plan = |sql: &str| -> String {
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("prepare plan");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(3))
            .expect("plan rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("plan details");
        rows.join("\n")
    };

    let notes_plan = plan("SELECT path FROM notes WHERE path > 'A' ORDER BY path LIMIT 10");
    assert!(
        notes_plan.contains("sqlite_autoindex_notes_1"),
        "notes page plan: {notes_plan}"
    );

    let backlinks_plan = plan(
        "SELECT r.note_path FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
         WHERE s.target_path = 'Target.md' AND s.kind IN ('resolved', 'missing_subpath') \
         ORDER BY r.note_path, r.span_start, r.span_end, r.id LIMIT 10",
    );
    assert!(
        backlinks_plan.contains("resolutions_target"),
        "backlinks plan: {backlinks_plan}"
    );

    let status_plan = plan(
        "SELECT r.note_path FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
         WHERE s.kind = 'unresolved' \
         ORDER BY r.note_path, r.span_start, r.span_end, r.id LIMIT 10",
    );
    assert!(
        status_plan.contains("resolutions_kind") || status_plan.contains("resolutions_target"),
        "status plan: {status_plan}"
    );

    // The same union CTE `get_diagnostics`/`get_note` run in production
    // (duplicated here since integration tests cannot reach a `pub(crate)`
    // constant across the crate boundary).
    const DIAGNOSTIC_UNION_CTE: &str = "\
WITH all_diagnostics AS ( \
    SELECT COALESCE(path, note_path) AS path, span_start, span_end, code, severity, message, \
           'note' AS owner_kind, ordinal AS owner_id \
      FROM note_diagnostics \
    UNION ALL \
    SELECT path, span_start, span_end, code, severity, message, \
           'resolution' AS owner_kind, reference_id AS owner_id \
      FROM resolution_diagnostics \
    UNION ALL \
    SELECT path, span_start, span_end, code, severity, message, \
           'scan' AS owner_kind, ordinal AS owner_id \
      FROM scan_diagnostics \
)";
    let diagnostics_plan = plan(&format!(
        "{DIAGNOSTIC_UNION_CTE} SELECT code FROM all_diagnostics WHERE path = 'Source.md' \
         ORDER BY path, span_start, span_end, code, message, owner_kind, owner_id LIMIT 10"
    ));
    assert!(
        diagnostics_plan.contains("resolution_diagnostics_order"),
        "diagnostics plan: {diagnostics_plan}"
    );

    // Every branch must be an indexed SEARCH on its severity index, not a
    // full SCAN — this is the property the fix restores (v1 had
    // `diagnostics_severity_order`; schema v2 initially shipped with no
    // per-branch severity index at all, forcing a SCAN of all three
    // tables). The final cross-branch merge still needs a temp b-tree to
    // produce one globally ordered stream from three independently-sorted
    // arms (SQLite does not merge-sort pre-sorted UNION ALL arms) — that is
    // an inherent cost of the union-of-three-tables design already accepted
    // for the path-filtered case below (`LAST 6 TERMS OF ORDER BY`), not
    // something a severity index can or should remove, so it is not
    // asserted away here.
    let severity_plan = plan(&format!(
        "{DIAGNOSTIC_UNION_CTE} SELECT code FROM all_diagnostics WHERE severity = 'warning' \
         ORDER BY path, span_start, span_end, code, message, owner_kind, owner_id LIMIT 10"
    ));
    assert!(
        severity_plan.contains("note_diagnostics_severity"),
        "severity plan (note branch): {severity_plan}"
    );
    assert!(
        severity_plan.contains("resolution_diagnostics_severity"),
        "severity plan (resolution branch): {severity_plan}"
    );
    assert!(
        severity_plan.contains("scan_diagnostics_severity"),
        "severity plan (scan branch): {severity_plan}"
    );
    assert!(
        !severity_plan.contains("SCAN note_diagnostics")
            && !severity_plan.contains("SCAN resolution_diagnostics")
            && !severity_plan.contains("SCAN scan_diagnostics"),
        "severity plan must not scan any diagnostic table: {severity_plan}"
    );

    let dependency_lookup_plan = plan(
        "SELECT reference_id FROM resolution_dependencies \
         WHERE dependency_kind = 'exact_path' AND comparison_key = 'Target.md' \
         ORDER BY reference_id",
    );
    assert!(
        dependency_lookup_plan.contains("resolution_dependencies_lookup"),
        "dependency lookup plan: {dependency_lookup_plan}"
    );

    let dependency_cleanup_plan =
        plan("DELETE FROM resolution_dependencies WHERE reference_id = 1");
    assert!(
        dependency_cleanup_plan.contains("resolution_dependencies_reference")
            || dependency_cleanup_plan.contains("PRIMARY KEY"),
        "per-reference dependency cleanup plan: {dependency_cleanup_plan}"
    );

    let diagnostic_cleanup_plan = plan("DELETE FROM resolution_diagnostics WHERE reference_id = 1");
    assert!(
        diagnostic_cleanup_plan.contains("PRIMARY KEY"),
        "per-reference diagnostic cleanup plan: {diagnostic_cleanup_plan}"
    );

    for table_plan in [
        &backlinks_plan,
        &status_plan,
        &diagnostics_plan,
        &severity_plan,
        &dependency_lookup_plan,
        &dependency_cleanup_plan,
        &diagnostic_cleanup_plan,
    ] {
        assert!(
            !table_plan.contains("SCAN resolutions\n") && !table_plan.ends_with("SCAN resolutions"),
            "unindexed relationship scan: {table_plan}"
        );
        assert!(
            !table_plan.contains("SCAN notes\n") && !table_plan.ends_with("SCAN notes"),
            "unindexed notes scan: {table_plan}"
        );
        assert!(
            !table_plan.contains("SCAN note_references\n")
                && !table_plan.ends_with("SCAN note_references"),
            "unindexed note_references scan: {table_plan}"
        );
    }
}
