//! Delta-only publication: apply an incremental caller's exact set of note,
//! fingerprint, and resolution changes in one compare-and-swap transaction,
//! touching only the rows that changed. Never rewrites `resolutions`,
//! `resolution_candidates`, `resolution_dependencies`, or
//! `resolution_diagnostics` table-wide — every write in this path is scoped
//! by an explicit `note_path` or `reference_id`, proven by
//! `publish_delta_never_issues_a_table_wide_resolution_delete` below.

use rusqlite::params;
use vault_core::{DependencyKey, Diagnostic, ParsedNote, Resolution, VaultPath};

use crate::codec;
use crate::error::IndexError;
use crate::model::{FileFingerprint, Generation};
use crate::schema;
use crate::store::IndexStore;

/// One note whose parsed content replaces its previous stored row (and, via
/// `ON DELETE CASCADE`, its previous source-local reference rows — the
/// replacement's own references are reinserted fresh by
/// `IndexStore::replace_note`).
pub struct NoteReplacement {
    pub note: ParsedNote,
    pub fingerprint: FileFingerprint,
}

/// One existing reference's resolution answer, replacing whatever is
/// currently stored for it. `source_path`/`ordinal` identify the reference
/// via the same `(note_path, ordinal)` pair `note_references` is keyed by;
/// the reference itself is not re-created here (see `NoteReplacement` for
/// that), only its resolution, candidates, dependency keys, and diagnostic.
pub struct ResolutionReplacement {
    pub source_path: VaultPath,
    pub ordinal: u32,
    pub resolution: Resolution,
    pub dependencies: Vec<DependencyKey>,
    pub diagnostic: Option<Diagnostic>,
}

/// Everything one delta publication replaces. Unlike the full-publication
/// `Publication`, `expected` is never `None`: a delta always applies on top
/// of an already-published generation (the cold, first-ever build still
/// goes through `IndexStore::publish`).
pub struct DeltaPublication<'a> {
    pub expected: Generation,
    pub notes: &'a [NoteReplacement],
    pub deleted: &'a [VaultPath],
    pub fingerprint_updates: &'a [(VaultPath, FileFingerprint)],
    pub resolutions: &'a [ResolutionReplacement],
    /// `None` means "no scan-diagnostic input this cycle, leave the table
    /// alone": no statement, read or write, touches `scan_diagnostics` at
    /// all. `Some` always costs one read (a comparison against what is
    /// already stored — there is no cheaper way to know whether anything
    /// changed), but only *writes* (delete-all, reinsert) when the compared
    /// set actually differs. Scan diagnostics have no per-item owner id to
    /// scope a write by — unlike every other table this path touches — so a
    /// changed set is necessarily a whole-table replace; an unchanged set
    /// commits with the read-only comparison as its only statement against
    /// the table.
    pub scan_diagnostics: Option<&'a [Diagnostic]>,
}

/// Structural work one delta publication did, in the same shape as
/// `GraphWriteCounts`/`WorkCounts` so it can be folded into the same
/// counters (see `WorkCounts::merge_delta`).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeltaWriteCounts {
    pub notes_replaced: u64,
    pub notes_deleted: u64,
    pub fingerprints_updated: u64,
    pub references_replaced: u64,
    pub resolutions_replaced: u64,
    pub dependencies_replaced: u64,
    pub diagnostics_replaced: u64,
    /// Always zero: every statement in this path is scoped by an explicit
    /// `note_path` or `reference_id` parameter drawn from the caller's own
    /// `notes`/`deleted`/`fingerprint_updates`/`resolutions` inputs, so no
    /// reference outside those sets can ever be touched. A structural
    /// guarantee (mirroring `LiveGraph::retained_source_bytes`), not a
    /// computed count — `publish_delta_never_issues_a_table_wide_resolution_delete`
    /// is the actual proof mechanism.
    pub unaffected_references_touched: u64,
}

#[derive(Debug)]
pub enum DeltaPublishOutcome {
    Committed {
        generation: Generation,
        counts: DeltaWriteCounts,
    },
    GenerationChanged,
}

impl IndexStore {
    /// One compare-and-swap delta publication: verify the expected
    /// generation, apply exactly the caller's note/fingerprint/resolution
    /// changes, advance the generation, and commit — all in one transaction.
    /// A generation mismatch or any error rolls back with zero row changes.
    pub fn publish_delta(
        &mut self,
        publication: DeltaPublication<'_>,
    ) -> Result<DeltaPublishOutcome, IndexError> {
        let DeltaPublication {
            expected,
            notes,
            deleted,
            fingerprint_updates,
            resolutions,
            scan_diagnostics,
        } = publication;

        let transaction = self.connection.transaction()?;

        let current: Option<i64> = transaction.query_row(
            "SELECT generation FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let current = current.map(Generation::from_db).transpose()?;
        if current != Some(expected) {
            // Dropping `transaction` without committing rolls it back; no
            // statement above this point wrote anything.
            return Ok(DeltaPublishOutcome::GenerationChanged);
        }

        let mut counts = DeltaWriteCounts::default();

        for path in deleted {
            transaction.execute("DELETE FROM notes WHERE path = ?1", params![path.as_str()])?;
            counts.notes_deleted += 1;
        }

        for replacement in notes {
            IndexStore::replace_note(&transaction, &replacement.note, replacement.fingerprint)?;
            counts.notes_replaced += 1;
            counts.references_replaced += replacement.note.references.len() as u64;
        }

        for (path, fingerprint) in fingerprint_updates {
            super::update_fingerprint(&transaction, path, *fingerprint)?;
            counts.fingerprints_updated += 1;
        }

        for replacement in resolutions {
            let reference_id: i64 = transaction.query_row(
                "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = ?2",
                params![
                    replacement.source_path.as_str(),
                    i64::from(replacement.ordinal)
                ],
                |row| row.get(0),
            )?;

            transaction.execute(
                "DELETE FROM resolutions WHERE reference_id = ?1",
                params![reference_id],
            )?;
            transaction.execute(
                "DELETE FROM resolution_candidates WHERE reference_id = ?1",
                params![reference_id],
            )?;
            transaction.execute(
                "DELETE FROM resolution_dependencies WHERE reference_id = ?1",
                params![reference_id],
            )?;
            transaction.execute(
                "DELETE FROM resolution_diagnostics WHERE reference_id = ?1",
                params![reference_id],
            )?;

            let stored = codec::encode_resolution(&replacement.resolution);
            transaction.execute(
                "INSERT INTO resolutions \
                 (reference_id, kind, target_path, subpath_kind, subpath_value) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    reference_id,
                    stored.kind,
                    stored.target_path,
                    stored.subpath_kind,
                    stored.subpath_value,
                ],
            )?;
            counts.resolutions_replaced += 1;

            for (candidate_ordinal, candidate) in stored.candidates.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO resolution_candidates \
                     (reference_id, ordinal, candidate_path) VALUES (?1, ?2, ?3)",
                    params![
                        reference_id,
                        super::usize_to_i64(candidate_ordinal, "candidate ordinal")?,
                        candidate,
                    ],
                )?;
            }

            for key in &replacement.dependencies {
                transaction.execute(
                    "INSERT INTO resolution_dependencies \
                     (reference_id, dependency_kind, comparison_key) VALUES (?1, ?2, ?3)",
                    params![
                        reference_id,
                        codec::encode_dependency_kind(key.kind),
                        key.comparison_key,
                    ],
                )?;
                counts.dependencies_replaced += 1;
            }

            if let Some(diagnostic) = &replacement.diagnostic {
                transaction.execute(
                    "INSERT INTO resolution_diagnostics \
                     (reference_id, code, severity, message, path, span_start, span_end) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        reference_id,
                        codec::encode_diagnostic_code(diagnostic.code),
                        codec::encode_severity(diagnostic.severity),
                        diagnostic.message,
                        diagnostic.path.as_ref().map(VaultPath::as_str),
                        diagnostic
                            .span
                            .map(|span| super::usize_to_i64(span.start(), "diagnostic span start"))
                            .transpose()?,
                        diagnostic
                            .span
                            .map(|span| super::usize_to_i64(span.end(), "diagnostic span end"))
                            .transpose()?,
                    ],
                )?;
                counts.diagnostics_replaced += 1;
            }
        }

        // Every reference `replace_note` (re)created above must end up with a
        // resolution row before this transaction commits: both read paths
        // (`store/hydrate.rs`, `query.rs`) `INNER JOIN resolutions`, so a
        // reference left without one would not fail loudly — it would just
        // silently vanish from every query. `replace_note` gives each
        // recreated reference a brand-new `note_references.id`, so a caller
        // must supply a matching `ResolutionReplacement` for every one of a
        // replaced note's own references; this check is the transaction's
        // own proof that they did, at a cost proportional to the changed
        // notes' own reference counts (indexed by `note_path`).
        for replacement in notes {
            let path = replacement.note.source.path();
            let missing: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM note_references r \
                 LEFT JOIN resolutions s ON s.reference_id = r.id \
                 WHERE r.note_path = ?1 AND s.reference_id IS NULL",
                params![path.as_str()],
                |row| row.get(0),
            )?;
            if missing > 0 {
                return Err(IndexError::IncompleteResolutionCoverage(
                    path.as_str().to_string(),
                ));
            }
        }

        if let Some(scan_diagnostics) = scan_diagnostics {
            let existing = super::load_diagnostic_rows(
                &transaction,
                "SELECT code, severity, message, path, span_start, span_end \
                 FROM scan_diagnostics ORDER BY ordinal",
            )?;
            if existing != scan_diagnostics {
                transaction.execute("DELETE FROM scan_diagnostics", [])?;
                for (ordinal, diagnostic) in scan_diagnostics.iter().enumerate() {
                    super::insert_diagnostic_row(
                        &transaction,
                        "INSERT INTO scan_diagnostics \
                         (ordinal, code, severity, message, path, span_start, span_end) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        ordinal,
                        diagnostic,
                    )?;
                }
            }
        }

        let next = Generation::new(expected.get() + 1);
        transaction.execute(
            "UPDATE index_metadata SET generation = ?1, refreshed_at_unix_ms = ?2, \
             last_refresh_error = NULL WHERE singleton = 1",
            params![
                super::u64_to_i64(next.get(), "generation")?,
                schema::now_unix_ms()?
            ],
        )?;

        transaction.commit()?;

        Ok(DeltaPublishOutcome::Committed {
            generation: next,
            counts,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use vault_core::{
        LinkTarget, ResolvedReference, Resolver, VaultPath, parse_note, reference_dependencies,
        resolution_diagnostic,
    };

    use super::{DeltaPublication, DeltaPublishOutcome, NoteReplacement, ResolutionReplacement};
    use crate::config::IndexConfig;
    use crate::model::FileFingerprint;
    use crate::reconcile::IndexService;

    thread_local! {
        static TRACE: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn record_sql(sql: &str) {
        TRACE.with(|log| log.borrow_mut().push(sql.to_string()));
    }

    /// A delta publication that replaces one note's body and its own single
    /// reference's resolution must never issue a bare table-wide delete
    /// against any resolution-owned table, and must leave an unrelated
    /// reference's stored identity untouched.
    #[test]
    fn publish_delta_never_issues_a_table_wide_resolution_delete() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index_dir = tempfile::TempDir::new().expect("index tempdir");
        std::fs::write(vault.path().join("Changed.md"), "# Changed\n").expect("write Changed");
        std::fs::write(vault.path().join("Target.md"), "# Target\n").expect("write Target");
        std::fs::write(vault.path().join("Stable.md"), "[[Other]]\n").expect("write Stable");
        std::fs::write(vault.path().join("Other.md"), "# Other\n").expect("write Other");

        let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
            .expect("delta trace config");
        let mut service = IndexService::open(config).expect("delta trace service");
        service.refresh(false).expect("cold build");

        let stable_path = VaultPath::new("Stable.md").expect("stable path");
        let before_reference_id: i64 = service
            .store
            .connection
            .query_row(
                "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = 0",
                rusqlite::params![stable_path.as_str()],
                |row| row.get(0),
            )
            .expect("stable reference id before delta");

        let changed_path = VaultPath::new("Changed.md").expect("changed path");
        let source = vault_core::SourceDocument::new(
            changed_path.clone(),
            "# Changed\n[[Target]]\n".to_string(),
        );
        let note = parse_note(source);
        let fingerprint = FileFingerprint {
            size: note.source.text().len() as u64,
            modified_seconds: 1,
            modified_nanos: 0,
        };
        let reference = note.references[0].clone();
        let target = LinkTarget::from(&reference);
        let resolver = Resolver::from_catalog(
            service
                .store
                .load_resolution_catalog()
                .expect("resolution catalog"),
        );
        let resolution = resolver.resolve_target(&changed_path, &target);
        let dependencies = reference_dependencies(&changed_path, &target, &resolution);
        let resolved = ResolvedReference {
            source: changed_path.clone(),
            source_span: reference.span,
            reference,
            resolution: resolution.clone(),
        };
        let diagnostic = resolution_diagnostic(&resolved);

        let notes = vec![NoteReplacement { note, fingerprint }];
        let resolutions = vec![ResolutionReplacement {
            source_path: changed_path,
            ordinal: 0,
            resolution,
            dependencies,
            diagnostic,
        }];
        let expected = service
            .store
            .current_generation()
            .expect("current generation")
            .expect("prior generation");

        service.store.connection.trace(Some(record_sql));
        let outcome = service
            .store
            .publish_delta(DeltaPublication {
                expected,
                notes: &notes,
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &resolutions,
                scan_diagnostics: None,
            })
            .expect("publish delta");
        service.store.connection.trace(None);

        assert!(matches!(outcome, DeltaPublishOutcome::Committed { .. }));

        TRACE.with(|log| {
            assert!(
                !log.borrow().is_empty(),
                "trace collector recorded nothing; the check below would be vacuous"
            );
            for sql in log.borrow().iter() {
                for table in [
                    "resolutions",
                    "resolution_candidates",
                    "resolution_dependencies",
                    "resolution_diagnostics",
                ] {
                    let prefix = format!("DELETE FROM {table}");
                    if sql.starts_with(&prefix) {
                        assert!(
                            sql.to_uppercase().contains("WHERE"),
                            "table-wide delete detected: {sql}"
                        );
                    }
                }
            }
        });

        let after_reference_id: i64 = service
            .store
            .connection
            .query_row(
                "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = 0",
                rusqlite::params![stable_path.as_str()],
                |row| row.get(0),
            )
            .expect("stable reference id after delta");
        assert_eq!(before_reference_id, after_reference_id);
    }

    /// The only branch that can violate row-targeting (`scan_diagnostics` has
    /// no per-item owner id, so a genuine change is necessarily a
    /// whole-table replace) previously had zero coverage: every call site in
    /// the rest of this task's tests passes `None`. This exercises the full
    /// read, the `Vec` vs `&[Diagnostic]` comparison, the delete, and the
    /// ordinal-reinsert loop on a real change, then proves republishing the
    /// identical set issues no write statement against the table at all.
    #[test]
    fn republishing_the_identical_scan_diagnostic_set_writes_nothing() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index_dir = tempfile::TempDir::new().expect("index tempdir");
        std::fs::write(vault.path().join("Note.md"), "# Note\n").expect("write Note");

        let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
            .expect("scan diagnostics config");
        let mut service = IndexService::open(config).expect("scan diagnostics service");
        service.refresh(false).expect("cold build");

        let diagnostic = vault_core::Diagnostic::new(
            vault_core::DiagnosticCode::InaccessibleVaultRoot,
            vault_core::Severity::Error,
            "synthetic scan diagnostic".to_string(),
        );
        let diagnostics = vec![diagnostic];

        let scan_diagnostics_count = |service: &IndexService| -> i64 {
            service
                .store
                .connection
                .query_row("SELECT COUNT(*) FROM scan_diagnostics", [], |row| {
                    row.get(0)
                })
                .expect("scan diagnostics count")
        };
        assert_eq!(scan_diagnostics_count(&service), 0);

        let first_expected = service
            .store
            .current_generation()
            .expect("current generation")
            .expect("prior generation");
        let first_outcome = service
            .store
            .publish_delta(DeltaPublication {
                expected: first_expected,
                notes: &[],
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &[],
                scan_diagnostics: Some(&diagnostics),
            })
            .expect("first scan-diagnostics publish");
        let second_expected = match first_outcome {
            DeltaPublishOutcome::Committed { generation, .. } => generation,
            DeltaPublishOutcome::GenerationChanged => panic!("unexpected generation conflict"),
        };
        assert_eq!(
            scan_diagnostics_count(&service),
            1,
            "the first publish must have actually stored the diagnostic"
        );

        service.store.connection.trace(Some(record_sql));
        let second_outcome = service
            .store
            .publish_delta(DeltaPublication {
                expected: second_expected,
                notes: &[],
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &[],
                scan_diagnostics: Some(&diagnostics),
            })
            .expect("second, identical scan-diagnostics publish");
        service.store.connection.trace(None);
        assert!(matches!(
            second_outcome,
            DeltaPublishOutcome::Committed { .. }
        ));

        TRACE.with(|log| {
            let log = log.borrow();
            assert!(
                !log.is_empty(),
                "trace collector recorded nothing; the check below would be vacuous"
            );
            assert!(
                log.iter().any(|sql| sql.contains("scan_diagnostics")),
                "the comparison read itself must still run: {log:?}"
            );
            let writes: Vec<&String> = log
                .iter()
                .filter(|sql| {
                    let upper = sql.to_uppercase();
                    upper.contains("SCAN_DIAGNOSTICS")
                        && (upper.starts_with("DELETE") || upper.starts_with("INSERT"))
                })
                .collect();
            assert!(
                writes.is_empty(),
                "republishing an identical set must not write scan_diagnostics: {writes:?}"
            );
        });

        assert_eq!(
            scan_diagnostics_count(&service),
            1,
            "the unchanged republish must not have duplicated or dropped the row"
        );
    }
}
