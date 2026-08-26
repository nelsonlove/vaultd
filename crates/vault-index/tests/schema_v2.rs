mod common;

use std::collections::BTreeSet;

use common::{open_fixture_service, snapshot_from_index, snapshot_from_scan};
use vault_core::{DiagnosticCode, LinkTarget, VaultPath, reference_dependencies};
use vault_index::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};

#[test]
fn schema_two_owns_dependencies_and_resolution_diagnostics() {
    assert_eq!(SQL_SCHEMA_VERSION, 2);
    assert_eq!(SEMANTIC_FORMAT_VERSION, 2);

    let mut fixture = open_fixture_service();
    fixture.service.refresh(false).expect("cold build");
    let connection = fixture.service.connection_for_test();
    for table in ["resolution_dependencies", "resolution_diagnostics"] {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing {table}");
    }
    let aggregate: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='diagnostics'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(aggregate, 0);

    assert_eq!(
        snapshot_from_index(&fixture.service),
        snapshot_from_scan(&fixture.scan)
    );
}

/// Every stored `resolution_dependencies` row set must equal a fresh
/// `reference_dependencies` computation for that reference: hydration (task
/// 5) may read either, so the two must never diverge.
#[test]
fn stored_dependencies_match_a_fresh_computation_for_every_reference() {
    let mut fixture = open_fixture_service();
    fixture.service.refresh(false).expect("cold build");
    let connection = fixture.service.connection_for_test();

    for path in fixture.scan.graph.note_paths() {
        let outgoing = fixture.scan.graph.outgoing(path);
        for (ordinal, resolved) in outgoing.iter().enumerate() {
            let reference_id: i64 = connection
                .query_row(
                    "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = ?2",
                    rusqlite::params![path.as_str(), ordinal as i64],
                    |row| row.get(0),
                )
                .unwrap_or_else(|error| {
                    panic!("reference id for {}#{ordinal}: {error}", path.as_str())
                });

            let mut statement = connection
                .prepare(
                    "SELECT dependency_kind, comparison_key FROM resolution_dependencies \
                     WHERE reference_id = ?1",
                )
                .expect("prepare dependency lookup");
            let stored: BTreeSet<vault_core::DependencyKey> = statement
                .query_map(rusqlite::params![reference_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .expect("dependency rows")
                .map(|row| {
                    let (kind, comparison_key) = row.expect("dependency row");
                    vault_index::decode_dependency_key_for_test(&kind, &comparison_key)
                        .expect("decode dependency key")
                })
                .collect();

            let target = LinkTarget::from(&resolved.reference);
            let expected: BTreeSet<vault_core::DependencyKey> =
                reference_dependencies(path, &target, &resolved.resolution)
                    .into_iter()
                    .collect();

            assert_eq!(
                stored,
                expected,
                "dependency keys diverge for {}#{ordinal}",
                path.as_str()
            );
        }
    }
}

/// A page size of `1` walks every diagnostic owner kind (a note diagnostic
/// with no stored path, a global scan diagnostic, an unresolved reference, an
/// ambiguous reference, and a missing subpath) without duplicating or
/// skipping any row.
#[test]
fn diagnostic_pagination_covers_every_owner_kind_without_duplication_or_gaps() {
    let mut fixture = common::queries_fixture();
    fixture.service.refresh(false).expect("refresh");

    {
        // Inject rows this vault's real parse never produces: a global scan
        // diagnostic and a note diagnostic stored with no path (exercising
        // the union's `COALESCE(path, note_path)` fallback).
        let raw = rusqlite::Connection::open(&fixture.config.index_path).expect("raw open");
        raw.execute(
            "INSERT INTO scan_diagnostics \
             (ordinal, code, severity, message, path, span_start, span_end) \
             VALUES (1000, 'inaccessible_vault_root', 'error', 'synthetic scan diagnostic', \
                     NULL, NULL, NULL)",
            [],
        )
        .expect("insert scan diagnostic");
        raw.execute(
            "INSERT INTO note_diagnostics \
             (note_path, ordinal, code, severity, message, path, span_start, span_end) \
             VALUES ('Source.md', 1000, 'markdown_parse_error', 'error', \
                     'synthetic pathless note diagnostic', NULL, NULL, NULL)",
            [],
        )
        .expect("insert note diagnostic");
    }

    // Reopen against the same cache to read back rows inserted through a raw
    // connection above. Under the exclusive writer lease, that requires the
    // fixture's own service to let go of the cache first — but not the rest
    // of the fixture, whose `TempDir`s must outlive this reopen.
    let config = fixture.config.clone();
    drop(fixture.service);
    let service = vault_index::IndexService::open(config).expect("reopen against cache");

    let mut collected = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = service
            .get_diagnostics(None, None, cursor.as_deref(), Some(1))
            .expect("diagnostics page");
        assert!(page.items.len() <= 1, "page size 1 must not overfill");
        collected.extend(page.items);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let mut seen = BTreeSet::new();
    for diagnostic in &collected {
        let key = (
            diagnostic
                .path
                .as_ref()
                .map(VaultPath::as_str)
                .map(str::to_string),
            diagnostic.span,
            diagnostic.code,
            diagnostic.severity,
            diagnostic.message.clone(),
        );
        assert!(
            seen.insert(key),
            "duplicate diagnostic across cursor pages: {diagnostic:?}"
        );
    }

    assert!(
        collected
            .iter()
            .any(|d| d.message == "synthetic scan diagnostic"),
        "missing the synthetic scan diagnostic"
    );
    assert!(
        collected
            .iter()
            .any(|d| d.message == "synthetic pathless note diagnostic"),
        "missing the synthetic pathless note diagnostic"
    );
    assert!(
        collected
            .iter()
            .any(|d| d.code == DiagnosticCode::UnresolvedReference),
        "missing the unresolved-reference diagnostic"
    );
    assert!(
        collected
            .iter()
            .any(|d| d.code == DiagnosticCode::AmbiguousReference),
        "missing the ambiguous-reference diagnostic"
    );
    assert!(
        collected
            .iter()
            .any(|d| d.code == DiagnosticCode::MissingHeading),
        "missing the missing-subpath diagnostic"
    );

    let all = service
        .get_diagnostics(None, None, None, None)
        .expect("unpaginated diagnostics");
    assert_eq!(collected.len(), all.items.len());
    assert_eq!(collected, all.items);
}
