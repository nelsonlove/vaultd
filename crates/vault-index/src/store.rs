use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use vault_core::{
    Alias, BlockId, Diagnostic, Heading, LinkTarget, ParsedNote, Reference, ResolvedReference,
    ScanReport, SemanticGraph, SourceDocument, Tag, VaultPath, build_graph, reference_dependencies,
    resolution_diagnostic,
};

mod delta;
mod hydrate;

pub use delta::{
    DeltaPublication, DeltaPublishOutcome, DeltaWriteCounts, NoteReplacement, ResolutionReplacement,
};

use crate::codec;
use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::live_graph::LiveGraph;
use crate::model::{FileFingerprint, Generation};
use crate::query::diagnostics as diagnostic_union;
use crate::schema;

pub(crate) enum PublishOutcome {
    Committed(Generation, PublishMetrics),
    GenerationChanged,
}

/// Structural work and timing produced while writing one publication's graph
/// rows, handed back so the caller can merge it into `ReconcileMetrics`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GraphWriteCounts {
    pub(crate) resolution_rows_written: u64,
    pub(crate) dependency_rows_written: u64,
    pub(crate) diagnostic_rows_written: u64,
}

/// Timing collected inside one `publish` transaction.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PublishMetrics {
    pub(crate) graph_write: GraphWriteCounts,
    pub(crate) sqlite_write: Duration,
    pub(crate) sqlite_commit: Duration,
}

/// Everything one compare-and-swap publication replaces.
pub(crate) struct Publication<'a> {
    pub expected: Option<Generation>,
    pub notes: &'a [(ParsedNote, FileFingerprint)],
    pub deleted: &'a [VaultPath],
    pub fingerprint_updates: &'a [(VaultPath, FileFingerprint)],
    pub graph: &'a SemanticGraph,
    pub scan_diagnostics: &'a [Diagnostic],
}

pub(crate) fn usize_to_i64(value: usize, field: &str) -> Result<i64, IndexError> {
    i64::try_from(value).map_err(|_| IndexError::Storage(format!("{field} exceeds i64 range")))
}

pub(crate) fn u64_to_i64(value: u64, field: &str) -> Result<i64, IndexError> {
    i64::try_from(value).map_err(|_| IndexError::Storage(format!("{field} exceeds i64 range")))
}

pub(crate) fn i64_to_usize(value: i64, field: &str) -> Result<usize, IndexError> {
    usize::try_from(value)
        .map_err(|_| IndexError::IncompatibleIndex(format!("{field} is negative")))
}

#[doc(hidden)]
pub struct IndexStore {
    pub(crate) connection: Connection,
}

impl IndexStore {
    pub(crate) fn open(config: &IndexConfig) -> Result<Self, IndexError> {
        Ok(Self {
            connection: schema::open_connection(config)?,
        })
    }

    #[doc(hidden)]
    pub fn open_for_test(config: &IndexConfig) -> Result<Self, IndexError> {
        Self::open(config)
    }

    pub(crate) fn replace_note(
        transaction: &Transaction<'_>,
        note: &ParsedNote,
        fingerprint: FileFingerprint,
    ) -> Result<(), IndexError> {
        let path = note.source.path().as_str();
        transaction.execute("DELETE FROM notes WHERE path = ?1", params![path])?;

        let (filename_key, stem_key) = codec::comparison_keys(note.source.path());
        transaction.execute(
            "INSERT INTO notes \
             (path, content_revision, source_bytes, filename_comparison_key, \
              stem_comparison_key, observed_size, observed_mtime_seconds, observed_mtime_nanos) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                path,
                note.source.revision().as_str(),
                note.source.text().as_bytes(),
                filename_key,
                stem_key,
                u64_to_i64(fingerprint.size, "observed size")?,
                fingerprint.modified_seconds,
                i64::from(fingerprint.modified_nanos),
            ],
        )?;

        for (ordinal, property) in note.properties.iter().enumerate() {
            transaction.execute(
                "INSERT INTO properties \
                 (note_path, ordinal, key_text, value_json, span_start, span_end, \
                  key_span_start, key_span_end, value_span_start, value_span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    path,
                    usize_to_i64(ordinal, "property ordinal")?,
                    property.key.value,
                    codec::encode_property_value(&property.value.value)?,
                    usize_to_i64(property.span.start(), "property span start")?,
                    usize_to_i64(property.span.end(), "property span end")?,
                    usize_to_i64(property.key.span.start(), "property key span start")?,
                    usize_to_i64(property.key.span.end(), "property key span end")?,
                    usize_to_i64(property.value.span.start(), "property value span start")?,
                    usize_to_i64(property.value.span.end(), "property value span end")?,
                ],
            )?;
        }

        for (ordinal, alias) in note.aliases.iter().enumerate() {
            transaction.execute(
                "INSERT INTO aliases (note_path, ordinal, value, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    path,
                    usize_to_i64(ordinal, "alias ordinal")?,
                    alias.value,
                    usize_to_i64(alias.span.start(), "alias span start")?,
                    usize_to_i64(alias.span.end(), "alias span end")?,
                ],
            )?;
        }

        for (ordinal, heading) in note.headings.iter().enumerate() {
            transaction.execute(
                "INSERT INTO headings \
                 (note_path, ordinal, level, text, comparison_key, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    path,
                    usize_to_i64(ordinal, "heading ordinal")?,
                    i64::from(heading.level),
                    heading.text,
                    heading.text.to_lowercase(),
                    usize_to_i64(heading.span.start(), "heading span start")?,
                    usize_to_i64(heading.span.end(), "heading span end")?,
                ],
            )?;
        }

        for (ordinal, block) in note.blocks.iter().enumerate() {
            transaction.execute(
                "INSERT INTO blocks (note_path, ordinal, identifier, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    path,
                    usize_to_i64(ordinal, "block ordinal")?,
                    block.value,
                    usize_to_i64(block.span.start(), "block span start")?,
                    usize_to_i64(block.span.end(), "block span end")?,
                ],
            )?;
        }

        for (ordinal, tag) in note.tags.iter().enumerate() {
            transaction.execute(
                "INSERT INTO tags \
                 (note_path, ordinal, value, comparison_key, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    path,
                    usize_to_i64(ordinal, "tag ordinal")?,
                    tag.value,
                    tag.comparison_key,
                    usize_to_i64(tag.span.start(), "tag span start")?,
                    usize_to_i64(tag.span.end(), "tag span end")?,
                ],
            )?;
        }

        for (ordinal, reference) in note.references.iter().enumerate() {
            let columns = codec::encode_reference_columns(reference);
            transaction.execute(
                "INSERT INTO note_references \
                 (note_path, ordinal, kind, origin, raw_target, file_target, \
                  subpath_kind, subpath_value, display, span_start, span_end, \
                  target_span_start, target_span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    path,
                    usize_to_i64(ordinal, "reference ordinal")?,
                    columns.kind,
                    columns.origin,
                    columns.raw_target,
                    columns.file_target,
                    columns.subpath_kind,
                    columns.subpath_value,
                    columns.display,
                    usize_to_i64(reference.span.start(), "reference span start")?,
                    usize_to_i64(reference.span.end(), "reference span end")?,
                    usize_to_i64(reference.target_span.start(), "target span start")?,
                    usize_to_i64(reference.target_span.end(), "target span end")?,
                ],
            )?;
        }

        for (ordinal, diagnostic) in note.diagnostics.iter().enumerate() {
            transaction.execute(
                "INSERT INTO note_diagnostics \
                 (note_path, ordinal, code, severity, message, path, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    path,
                    usize_to_i64(ordinal, "diagnostic ordinal")?,
                    codec::encode_diagnostic_code(diagnostic.code),
                    codec::encode_severity(diagnostic.severity),
                    diagnostic.message,
                    diagnostic.path.as_ref().map(VaultPath::as_str),
                    diagnostic
                        .span
                        .map(|span| usize_to_i64(span.start(), "diagnostic span start"))
                        .transpose()?,
                    diagnostic
                        .span
                        .map(|span| usize_to_i64(span.end(), "diagnostic span end"))
                        .transpose()?,
                ],
            )?;
        }
        Ok(())
    }

    pub(crate) fn load_note(&self, path: &VaultPath) -> Result<Option<ParsedNote>, IndexError> {
        load_note_with(&self.connection, path)
    }

    pub(crate) fn load_all_notes(&self) -> Result<Vec<ParsedNote>, IndexError> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM notes ORDER BY path")?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut notes = Vec::with_capacity(paths.len());
        for path in paths {
            let path = codec::decode_path(&path)?;
            let note = load_note_with(&self.connection, &path)?.ok_or_else(|| {
                IndexError::Storage(format!("note row disappeared for {}", path.as_str()))
            })?;
            notes.push(note);
        }
        Ok(notes)
    }

    pub(crate) fn replace_graph_rows(
        transaction: &Transaction<'_>,
        graph: &SemanticGraph,
        scan_diagnostics: &[Diagnostic],
    ) -> Result<GraphWriteCounts, IndexError> {
        transaction.execute("DELETE FROM resolutions", [])?;
        transaction.execute("DELETE FROM resolution_candidates", [])?;
        transaction.execute("DELETE FROM resolution_dependencies", [])?;
        transaction.execute("DELETE FROM resolution_diagnostics", [])?;
        transaction.execute("DELETE FROM scan_diagnostics", [])?;

        let mut resolution_rows_written = 0u64;
        let mut dependency_rows_written = 0u64;
        let mut diagnostic_rows_written = 0u64;
        for path in graph.note_paths() {
            for (ordinal, resolved) in graph.outgoing(path).iter().enumerate() {
                let reference_id: i64 = transaction.query_row(
                    "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = ?2",
                    params![path.as_str(), usize_to_i64(ordinal, "reference ordinal")?],
                    |row| row.get(0),
                )?;
                let stored = codec::encode_resolution(&resolved.resolution);
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
                resolution_rows_written += 1;
                for (candidate_ordinal, candidate) in stored.candidates.iter().enumerate() {
                    transaction.execute(
                        "INSERT INTO resolution_candidates \
                         (reference_id, ordinal, candidate_path) VALUES (?1, ?2, ?3)",
                        params![
                            reference_id,
                            usize_to_i64(candidate_ordinal, "candidate ordinal")?,
                            candidate,
                        ],
                    )?;
                }

                let target = LinkTarget::from(&resolved.reference);
                for key in reference_dependencies(path, &target, &resolved.resolution) {
                    transaction.execute(
                        "INSERT INTO resolution_dependencies \
                         (reference_id, dependency_kind, comparison_key) VALUES (?1, ?2, ?3)",
                        params![
                            reference_id,
                            codec::encode_dependency_kind(key.kind),
                            key.comparison_key,
                        ],
                    )?;
                    dependency_rows_written += 1;
                }

                if let Some(diagnostic) = resolution_diagnostic(resolved) {
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
                                .map(|span| usize_to_i64(span.start(), "diagnostic span start"))
                                .transpose()?,
                            diagnostic
                                .span
                                .map(|span| usize_to_i64(span.end(), "diagnostic span end"))
                                .transpose()?,
                        ],
                    )?;
                    diagnostic_rows_written += 1;
                }
            }
        }

        for (ordinal, diagnostic) in scan_diagnostics.iter().enumerate() {
            insert_diagnostic_row(
                transaction,
                "INSERT INTO scan_diagnostics \
                 (ordinal, code, severity, message, path, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                ordinal,
                diagnostic,
            )?;
            diagnostic_rows_written += 1;
        }
        Ok(GraphWriteCounts {
            resolution_rows_written,
            dependency_rows_written,
            diagnostic_rows_written,
        })
    }

    pub(crate) fn load_scan_diagnostics(&self) -> Result<Vec<Diagnostic>, IndexError> {
        load_diagnostic_rows(
            &self.connection,
            "SELECT code, severity, message, path, span_start, span_end \
             FROM scan_diagnostics ORDER BY ordinal",
        )
    }

    pub(crate) fn load_outgoing(
        &self,
        path: &VaultPath,
    ) -> Result<Vec<ResolvedReference>, IndexError> {
        load_outgoing_with(&self.connection, path)
    }

    pub(crate) fn current_generation(&self) -> Result<Option<Generation>, IndexError> {
        let value: Option<i64> = self.connection.query_row(
            "SELECT generation FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        value.map(Generation::from_db).transpose()
    }

    /// Test-only since the live graph became the resolution catalog's
    /// source: production resolution answers now come from the published
    /// `LiveGraph`, never from a SQL catalog rebuild.
    #[cfg(test)]
    pub(crate) fn stored_paths(&self) -> Result<Vec<VaultPath>, IndexError> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM notes ORDER BY path")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.iter().map(|path| codec::decode_path(path)).collect()
    }

    /// Load the lightweight resolution inputs (path, heading texts, block
    /// identifiers) without touching source bytes. Test-only: see
    /// `stored_paths`.
    #[cfg(test)]
    pub(crate) fn load_resolution_catalog(
        &self,
    ) -> Result<Vec<vault_core::ResolutionNote>, IndexError> {
        let mut catalog: Vec<vault_core::ResolutionNote> = Vec::new();
        for path in self.stored_paths()? {
            catalog.push(vault_core::ResolutionNote {
                path,
                headings: Vec::new(),
                blocks: Vec::new(),
            });
        }
        let by_path: std::collections::BTreeMap<String, usize> = catalog
            .iter()
            .enumerate()
            .map(|(index, note)| (note.path.as_str().to_string(), index))
            .collect();

        let mut statement = self
            .connection
            .prepare("SELECT note_path, text FROM headings ORDER BY note_path, ordinal")?;
        let heading_rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (path, text) in heading_rows {
            if let Some(&index) = by_path.get(&path) {
                catalog[index].headings.push(text);
            }
        }

        let mut statement = self
            .connection
            .prepare("SELECT note_path, identifier FROM blocks ORDER BY note_path, ordinal")?;
        let block_rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (path, identifier) in block_rows {
            if let Some(&index) = by_path.get(&path) {
                catalog[index].blocks.push(identifier);
            }
        }
        Ok(catalog)
    }

    /// One compare-and-swap publication transaction: verify the expected
    /// generation, replace note and graph rows, advance the generation, and
    /// stamp the refresh time.
    pub(crate) fn publish(
        &mut self,
        publication: Publication<'_>,
    ) -> Result<PublishOutcome, IndexError> {
        let Publication {
            expected,
            notes,
            deleted,
            fingerprint_updates,
            graph,
            scan_diagnostics,
        } = publication;
        let transaction = self.connection.transaction()?;
        let current: Option<i64> = transaction.query_row(
            "SELECT generation FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let current = current.map(Generation::from_db).transpose()?;
        if current != expected {
            return Ok(PublishOutcome::GenerationChanged);
        }

        for path in deleted {
            transaction.execute("DELETE FROM notes WHERE path = ?1", params![path.as_str()])?;
        }
        for (note, fingerprint) in notes {
            Self::replace_note(&transaction, note, *fingerprint)?;
        }
        for (path, fingerprint) in fingerprint_updates {
            update_fingerprint(&transaction, path, *fingerprint)?;
        }
        let write_start = Instant::now();
        let graph_write = Self::replace_graph_rows(&transaction, graph, scan_diagnostics)?;
        let sqlite_write = write_start.elapsed();

        let next = Generation::new(expected.map_or(0, Generation::get) + 1);
        transaction.execute(
            "UPDATE index_metadata SET generation = ?1, refreshed_at_unix_ms = ?2, \
             last_refresh_error = NULL WHERE singleton = 1",
            params![
                u64_to_i64(next.get(), "generation")?,
                schema::now_unix_ms()?
            ],
        )?;
        let commit_start = Instant::now();
        transaction.commit()?;
        let sqlite_commit = commit_start.elapsed();
        Ok(PublishOutcome::Committed(
            next,
            PublishMetrics {
                graph_write,
                sqlite_write,
                sqlite_commit,
            },
        ))
    }

    pub(crate) fn stored_fingerprints(
        &self,
    ) -> Result<std::collections::BTreeMap<VaultPath, FileFingerprint>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT path, observed_size, observed_mtime_seconds, observed_mtime_nanos FROM notes",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut fingerprints = std::collections::BTreeMap::new();
        for (path, size, seconds, nanos) in rows {
            fingerprints.insert(
                codec::decode_path(&path)?,
                FileFingerprint {
                    size: u64::try_from(size).map_err(|_| {
                        IndexError::IncompatibleIndex("negative observed size".into())
                    })?,
                    modified_seconds: seconds,
                    modified_nanos: u32::try_from(nanos).map_err(|_| {
                        IndexError::IncompatibleIndex("mtime nanos out of range".into())
                    })?,
                },
            );
        }
        Ok(fingerprints)
    }

    pub(crate) fn stored_revision(&self, path: &VaultPath) -> Result<Option<String>, IndexError> {
        Ok(self
            .connection
            .query_row(
                "SELECT content_revision FROM notes WHERE path = ?1",
                params![path.as_str()],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Operational update after an unchanged refresh: refresh fingerprints and
    /// the refresh timestamp without touching the semantic generation.
    pub(crate) fn touch(
        &mut self,
        fingerprint_updates: &[(VaultPath, FileFingerprint)],
    ) -> Result<(), IndexError> {
        let transaction = self.connection.transaction()?;
        for (path, fingerprint) in fingerprint_updates {
            update_fingerprint(&transaction, path, *fingerprint)?;
        }
        transaction.execute(
            "UPDATE index_metadata SET refreshed_at_unix_ms = ?1, last_refresh_error = NULL \
             WHERE singleton = 1",
            params![schema::now_unix_ms()?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn last_refresh_error(&self) -> Result<Option<String>, IndexError> {
        Ok(self.connection.query_row(
            "SELECT last_refresh_error FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn record_refresh_failure(&mut self, message: &str) -> Result<(), IndexError> {
        self.connection.execute(
            "UPDATE index_metadata SET last_refresh_error = ?1 WHERE singleton = 1",
            params![message],
        )?;
        Ok(())
    }

    #[doc(hidden)]
    pub fn write_note_for_test(
        &mut self,
        note: &ParsedNote,
        fingerprint: FileFingerprint,
    ) -> Result<(), IndexError> {
        let transaction = self.connection.transaction()?;
        Self::replace_note(&transaction, note, fingerprint)?;
        transaction.commit()?;
        Ok(())
    }

    #[doc(hidden)]
    pub fn load_note_for_test(&self, path: &VaultPath) -> Result<Option<ParsedNote>, IndexError> {
        self.load_note(path)
    }

    #[doc(hidden)]
    pub fn replace_graph_rows_for_test(
        &mut self,
        graph: &SemanticGraph,
        scan_diagnostics: &[Diagnostic],
    ) -> Result<(), IndexError> {
        let transaction = self.connection.transaction()?;
        let _ = Self::replace_graph_rows(&transaction, graph, scan_diagnostics)?;
        transaction.commit()?;
        Ok(())
    }

    /// Build a compact live resolution graph from one consistent snapshot:
    /// narrow SQL for paths, headings, block ids, reference target columns,
    /// stored resolution columns, and ambiguous candidates only (never
    /// `source_bytes`, `properties`, `aliases`, or `tags`), including the
    /// generation itself, all read inside a single deferred transaction so
    /// a concurrent publish cannot tear the read.
    pub(crate) fn hydrate_live_graph(&self) -> Result<LiveGraph, IndexError> {
        hydrate::hydrate_live_graph(&self.connection)
    }

    /// Verification facade: rebuild the graph from persisted notes and prove
    /// the stored resolution and diagnostic rows equal the rebuilt result.
    /// The comparison reads through the same diagnostic union `get_diagnostics`
    /// uses, never a bespoke aggregate query.
    #[doc(hidden)]
    pub fn load_graph_for_test(&self) -> Result<ScanReport, IndexError> {
        let notes = self.load_all_notes()?;
        let scan_diagnostics = self.load_scan_diagnostics()?;
        let report = build_graph(notes, scan_diagnostics);

        let stored_diagnostics = diagnostic_union::all_diagnostics(&self.connection)?;
        if stored_diagnostics != report.diagnostics {
            return Err(IndexError::IncompatibleIndex(
                "stored diagnostics do not match the rebuilt graph".into(),
            ));
        }
        for path in report.graph.note_paths() {
            let stored = self.load_outgoing(path)?;
            if stored != report.graph.outgoing(path) {
                return Err(IndexError::IncompatibleIndex(format!(
                    "stored resolutions for {} do not match the rebuilt graph",
                    path.as_str()
                )));
            }
        }
        Ok(report)
    }
}

#[derive(Clone)]
pub(crate) struct ReferenceRow {
    pub(crate) id: i64,
    pub(crate) kind: String,
    pub(crate) origin: String,
    pub(crate) raw_target: String,
    pub(crate) file_target: Option<String>,
    pub(crate) subpath_kind: Option<String>,
    pub(crate) subpath_value: Option<String>,
    pub(crate) display: Option<String>,
    pub(crate) span_start: i64,
    pub(crate) span_end: i64,
    pub(crate) target_span_start: i64,
    pub(crate) target_span_end: i64,
    pub(crate) resolution_kind: String,
    pub(crate) resolution_target: Option<String>,
    pub(crate) resolution_subpath_kind: Option<String>,
    pub(crate) resolution_subpath_value: Option<String>,
}

pub(crate) fn reference_row_prefix(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReferenceRow> {
    Ok(ReferenceRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        origin: row.get(2)?,
        raw_target: row.get(3)?,
        file_target: row.get(4)?,
        subpath_kind: row.get(5)?,
        subpath_value: row.get(6)?,
        display: row.get(7)?,
        span_start: row.get(8)?,
        span_end: row.get(9)?,
        target_span_start: row.get(10)?,
        target_span_end: row.get(11)?,
        resolution_kind: row.get(12)?,
        resolution_target: row.get(13)?,
        resolution_subpath_kind: row.get(14)?,
        resolution_subpath_value: row.get(15)?,
    })
}

fn decode_reference(row: &ReferenceRow) -> Result<Reference, IndexError> {
    Ok(Reference {
        kind: codec::decode_reference_kind(&row.kind)?,
        origin: codec::decode_reference_origin(&row.origin)?,
        raw_target: row.raw_target.clone(),
        file_target: row.file_target.clone(),
        subpath: codec::decode_subpath(row.subpath_kind.as_deref(), row.subpath_value.as_deref())?,
        display: row.display.clone(),
        span: codec::decode_span(
            i64_to_usize(row.span_start, "reference span start")?,
            i64_to_usize(row.span_end, "reference span end")?,
        )?,
        target_span: codec::decode_span(
            i64_to_usize(row.target_span_start, "target span start")?,
            i64_to_usize(row.target_span_end, "target span end")?,
        )?,
    })
}

fn insert_diagnostic_row(
    transaction: &Transaction<'_>,
    sql: &str,
    ordinal: usize,
    diagnostic: &Diagnostic,
) -> Result<(), IndexError> {
    transaction.execute(
        sql,
        params![
            usize_to_i64(ordinal, "diagnostic ordinal")?,
            codec::encode_diagnostic_code(diagnostic.code),
            codec::encode_severity(diagnostic.severity),
            diagnostic.message,
            diagnostic.path.as_ref().map(VaultPath::as_str),
            diagnostic
                .span
                .map(|span| usize_to_i64(span.start(), "diagnostic span start"))
                .transpose()?,
            diagnostic
                .span
                .map(|span| usize_to_i64(span.end(), "diagnostic span end"))
                .transpose()?,
        ],
    )?;
    Ok(())
}

fn load_diagnostic_rows(connection: &Connection, sql: &str) -> Result<Vec<Diagnostic>, IndexError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(code, severity, message, path, start, end)| {
            codec::diagnostic_from_row(&code, &severity, message, path.as_deref(), start, end)
        })
        .collect()
}

/// `path`'s outgoing references against an arbitrary connection — the
/// writer's own, or a reader's transaction (`&Transaction` derefs to
/// `&Connection`), so both sides run byte-identical SQL.
pub(crate) fn load_outgoing_with(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<ResolvedReference>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT r.id, r.kind, r.origin, r.raw_target, r.file_target, r.subpath_kind, \
                r.subpath_value, r.display, r.span_start, r.span_end, \
                r.target_span_start, r.target_span_end, \
                s.kind, s.target_path, s.subpath_kind, s.subpath_value \
         FROM note_references r JOIN resolutions s ON s.reference_id = r.id \
         WHERE r.note_path = ?1 ORDER BY r.ordinal",
    )?;
    let rows = statement
        .query_map(params![path.as_str()], reference_row_prefix)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|row| resolved_reference_from_row_with(connection, path.clone(), row))
        .collect()
}

pub(crate) fn resolved_reference_from_row_with(
    connection: &Connection,
    source: VaultPath,
    row: ReferenceRow,
) -> Result<ResolvedReference, IndexError> {
    let candidates = if row.resolution_kind == "ambiguous" {
        let mut statement = connection.prepare(
            "SELECT candidate_path FROM resolution_candidates \
             WHERE reference_id = ?1 ORDER BY ordinal",
        )?;
        statement
            .query_map(params![row.id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let reference = decode_reference(&row)?;
    let resolution = codec::decode_resolution(
        &row.resolution_kind,
        row.resolution_target.as_deref(),
        row.resolution_subpath_kind.as_deref(),
        row.resolution_subpath_value.as_deref(),
        candidates,
    )?;
    Ok(ResolvedReference {
        source,
        source_span: reference.span,
        reference,
        resolution,
    })
}

pub(crate) fn load_note_with(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Option<ParsedNote>, IndexError> {
    let row: Option<(Vec<u8>, String)> = connection
        .query_row(
            "SELECT source_bytes, content_revision FROM notes WHERE path = ?1",
            params![path.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((bytes, stored_revision)) = row else {
        return Ok(None);
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| IndexError::IncompatibleIndex("stored source is not UTF-8".into()))?;
    let source = SourceDocument::new(path.clone(), text);
    if source.revision().as_str() != stored_revision {
        return Err(IndexError::IncompatibleIndex(format!(
            "stored revision for {} does not match its source bytes",
            path.as_str()
        )));
    }

    let mut note = ParsedNote::empty(source);

    let mut statement = connection.prepare(
        "SELECT key_text, value_json, span_start, span_end, key_span_start, key_span_end, \
                value_span_start, value_span_end \
         FROM properties WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let property_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (key, value_json, span_start, span_end, key_start, key_end, value_start, value_end) in
        property_rows
    {
        note.properties.push(vault_core::Property {
            key: vault_core::Spanned::new(
                key,
                codec::decode_span(
                    i64_to_usize(key_start, "property key span start")?,
                    i64_to_usize(key_end, "property key span end")?,
                )?,
            ),
            value: vault_core::Spanned::new(
                codec::decode_property_value(&value_json)?,
                codec::decode_span(
                    i64_to_usize(value_start, "property value span start")?,
                    i64_to_usize(value_end, "property value span end")?,
                )?,
            ),
            span: codec::decode_span(
                i64_to_usize(span_start, "property span start")?,
                i64_to_usize(span_end, "property span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT value, span_start, span_end FROM aliases WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let alias_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, start, end) in alias_rows {
        note.aliases.push(Alias {
            value,
            span: codec::decode_span(
                i64_to_usize(start, "alias span start")?,
                i64_to_usize(end, "alias span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT level, text, span_start, span_end FROM headings \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let heading_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (level, text, start, end) in heading_rows {
        let level = u8::try_from(level)
            .map_err(|_| IndexError::IncompatibleIndex("heading level out of range".into()))?;
        note.headings.push(Heading {
            level,
            text,
            span: codec::decode_span(
                i64_to_usize(start, "heading span start")?,
                i64_to_usize(end, "heading span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT identifier, span_start, span_end FROM blocks \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let block_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, start, end) in block_rows {
        note.blocks.push(BlockId {
            value,
            span: codec::decode_span(
                i64_to_usize(start, "block span start")?,
                i64_to_usize(end, "block span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT value, comparison_key, span_start, span_end FROM tags \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let tag_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, comparison_key, start, end) in tag_rows {
        note.tags.push(Tag {
            value,
            comparison_key,
            span: codec::decode_span(
                i64_to_usize(start, "tag span start")?,
                i64_to_usize(end, "tag span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT kind, origin, raw_target, file_target, subpath_kind, subpath_value, display, \
                span_start, span_end, target_span_start, target_span_end \
         FROM note_references WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let reference_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok(ReferenceRow {
                id: 0,
                kind: row.get(0)?,
                origin: row.get(1)?,
                raw_target: row.get(2)?,
                file_target: row.get(3)?,
                subpath_kind: row.get(4)?,
                subpath_value: row.get(5)?,
                display: row.get(6)?,
                span_start: row.get(7)?,
                span_end: row.get(8)?,
                target_span_start: row.get(9)?,
                target_span_end: row.get(10)?,
                resolution_kind: String::new(),
                resolution_target: None,
                resolution_subpath_kind: None,
                resolution_subpath_value: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for row in &reference_rows {
        note.references.push(decode_reference(row)?);
    }

    let mut statement = connection.prepare(
        "SELECT code, severity, message, path, span_start, span_end \
         FROM note_diagnostics WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let diagnostic_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (code, severity, message, diagnostic_path, start, end) in diagnostic_rows {
        note.diagnostics.push(codec::diagnostic_from_row(
            &code,
            &severity,
            message,
            diagnostic_path.as_deref(),
            start,
            end,
        )?);
    }

    Ok(Some(note))
}

fn update_fingerprint(
    transaction: &Transaction<'_>,
    path: &VaultPath,
    fingerprint: FileFingerprint,
) -> Result<(), IndexError> {
    transaction.execute(
        "UPDATE notes SET observed_size = ?1, observed_mtime_seconds = ?2, \
         observed_mtime_nanos = ?3 WHERE path = ?4",
        params![
            u64_to_i64(fingerprint.size, "observed size")?,
            fingerprint.modified_seconds,
            i64::from(fingerprint.modified_nanos),
            path.as_str(),
        ],
    )?;
    Ok(())
}
