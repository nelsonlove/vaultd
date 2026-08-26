use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use vault_core::{
    Diagnostic, LinkTarget, ParsedNote, Resolution, ResolvedReference, Revision, VaultPath,
};

pub(crate) mod diagnostics;

use crate::codec;
use crate::cursor::{CursorPosition, decode_cursor, encode_cursor};
use crate::error::IndexError;
use crate::model::{Generation, IndexState};
use crate::reconcile::IndexService;

pub const DEFAULT_PAGE_LIMIT: u32 = 100;
pub const MAX_PAGE_LIMIT: u32 = 1_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Page<T> {
    pub generation: Generation,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteSummary {
    pub path: VaultPath,
    pub revision: Revision,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndexedNote {
    pub generation: Generation,
    pub note: ParsedNote,
    pub diagnostics: Vec<Diagnostic>,
    pub outgoing: Vec<ResolvedReference>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceStatus {
    Resolved,
    Unresolved,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub canonical_root: PathBuf,
    pub vault_identity: String,
    pub state: IndexState,
    pub generation: Generation,
    pub note_count: u64,
    pub refreshed_at_unix_ms: Option<u64>,
}

fn effective_limit(limit: Option<u32>) -> Result<u32, IndexError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
    if limit == 0 || limit > MAX_PAGE_LIMIT {
        return Err(IndexError::InvalidCursor(format!(
            "limit must be between 1 and {MAX_PAGE_LIMIT}"
        )));
    }
    Ok(limit)
}

impl IndexService {
    fn required_generation(&self) -> Result<Generation, IndexError> {
        self.current_generation()?
            .ok_or(IndexError::IndexUnavailable)
    }

    pub fn vault_info(&self) -> Result<VaultInfo, IndexError> {
        let generation = self.required_generation()?;
        let state = self.state()?;
        let note_count: i64 =
            self.store
                .connection
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
        let refreshed_at: Option<i64> = self.store.connection.query_row(
            "SELECT refreshed_at_unix_ms FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(VaultInfo {
            canonical_root: self.config.canonical_vault_root.clone(),
            vault_identity: self.config.vault_identity.clone(),
            state,
            generation,
            note_count: u64::try_from(note_count)
                .map_err(|_| IndexError::IncompatibleIndex("negative note count".into()))?,
            refreshed_at_unix_ms: refreshed_at
                .map(|value| {
                    u64::try_from(value)
                        .map_err(|_| IndexError::IncompatibleIndex("negative refresh time".into()))
                })
                .transpose()?,
        })
    }

    pub fn list_notes(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<NoteSummary>, IndexError> {
        let limit = effective_limit(limit)?;
        let transaction = self.store.connection.unchecked_transaction()?;
        let generation = self.required_generation()?;

        let after = match cursor {
            None => None,
            Some(cursor) => match decode_cursor(cursor, generation, "list_notes")? {
                CursorPosition::Note { path } => Some(path),
                _ => {
                    return Err(IndexError::InvalidCursor(
                        "cursor position does not fit a note listing".into(),
                    ));
                }
            },
        };

        let mut statement = transaction.prepare(
            "SELECT path, content_revision FROM notes WHERE path > ?1 ORDER BY path LIMIT ?2",
        )?;
        let rows = statement
            .query_map(
                params![after.unwrap_or_default(), i64::from(limit) + 1],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;

        let mut items = Vec::with_capacity(rows.len().min(limit as usize));
        for (path, revision) in rows.iter().take(limit as usize) {
            let title: Option<String> = transaction
                .query_row(
                    "SELECT value_json FROM properties \
                     WHERE note_path = ?1 AND LOWER(key_text) = 'title' \
                     ORDER BY ordinal LIMIT 1",
                    params![path],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .and_then(
                    |value_json| match codec::decode_property_value(&value_json) {
                        Ok(vault_core::PropertyValue::String(text)) => Some(text),
                        _ => None,
                    },
                );
            let title = match title {
                Some(title) => Some(title),
                None => transaction
                    .query_row(
                        "SELECT text FROM headings WHERE note_path = ?1 \
                         ORDER BY ordinal LIMIT 1",
                        params![path],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?,
            };
            items.push(NoteSummary {
                path: codec::decode_path(path)?,
                revision: Revision::new(revision.clone())
                    .map_err(|_| IndexError::IncompatibleIndex("empty stored revision".into()))?,
                title,
            });
        }

        let next_cursor = if rows.len() > limit as usize {
            let last = &items[items.len() - 1];
            Some(encode_cursor(
                generation,
                "list_notes",
                CursorPosition::Note {
                    path: last.path.as_str().to_string(),
                },
            )?)
        } else {
            None
        };
        Ok(Page {
            generation,
            items,
            next_cursor,
        })
    }

    pub fn get_note(&self, path: &VaultPath) -> Result<IndexedNote, IndexError> {
        let transaction = self.store.connection.unchecked_transaction()?;
        let generation = self.required_generation()?;
        let note = self
            .store
            .load_note(path)?
            .ok_or_else(|| IndexError::NoteNotFound(path.as_str().to_string()))?;
        let outgoing = self.store.load_outgoing(path)?;
        let diagnostics = diagnostics::note_diagnostics(&transaction, path.as_str())?;

        Ok(IndexedNote {
            generation,
            note,
            diagnostics,
            outgoing,
        })
    }

    pub fn resolve_link(
        &mut self,
        source: &VaultPath,
        destination: &str,
    ) -> Result<(Generation, Resolution), IndexError> {
        let generation = self.required_generation()?;
        self.reload_resolver(generation)?;
        let (cached_generation, resolver) = self
            .resolver
            .as_ref()
            .expect("reload_resolver always caches a resolver");
        debug_assert_eq!(*cached_generation, generation);
        let target = LinkTarget::parse(destination);
        Ok((generation, resolver.resolve_target(source, &target)))
    }

    pub fn get_backlinks(
        &self,
        path: &VaultPath,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<ResolvedReference>, IndexError> {
        let query = format!("backlinks:{}", path.as_str());
        self.reference_page(
            cursor,
            limit,
            &query,
            "s.target_path = ?1 AND s.kind IN ('resolved', 'missing_subpath')",
            vec![Box::new(path.as_str().to_string())],
        )
    }

    pub fn list_references(
        &self,
        source: Option<&VaultPath>,
        status: Option<ReferenceStatus>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<ResolvedReference>, IndexError> {
        let status_key = match status {
            None => "any",
            Some(ReferenceStatus::Resolved) => "resolved",
            Some(ReferenceStatus::Unresolved) => "unresolved",
            Some(ReferenceStatus::Ambiguous) => "ambiguous",
        };
        let query = format!(
            "references:source={}:status={status_key}",
            source.map(VaultPath::as_str).unwrap_or_default()
        );

        let mut clauses: Vec<String> = Vec::new();
        let mut arguments: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        match status {
            None => clauses.push("s.kind != 'non_vault'".into()),
            Some(ReferenceStatus::Resolved) => {
                clauses.push("s.kind IN ('resolved', 'missing_subpath')".into());
            }
            Some(ReferenceStatus::Unresolved) => clauses.push("s.kind = 'unresolved'".into()),
            Some(ReferenceStatus::Ambiguous) => clauses.push("s.kind = 'ambiguous'".into()),
        }
        if let Some(source) = source {
            arguments.push(Box::new(source.as_str().to_string()));
            clauses.push(format!("r.note_path = ?{}", arguments.len()));
        }
        self.reference_page(cursor, limit, &query, &clauses.join(" AND "), arguments)
    }

    fn reference_page(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
        query: &str,
        where_clause: &str,
        mut arguments: Vec<Box<dyn rusqlite::ToSql>>,
    ) -> Result<Page<ResolvedReference>, IndexError> {
        let limit = effective_limit(limit)?;
        let transaction = self.store.connection.unchecked_transaction()?;
        let generation = self.required_generation()?;

        let mut where_clause = where_clause.to_string();
        if let Some(cursor) = cursor {
            let CursorPosition::Reference {
                source,
                start,
                end,
                id,
            } = decode_cursor(cursor, generation, query)?
            else {
                return Err(IndexError::InvalidCursor(
                    "cursor position does not fit a reference listing".into(),
                ));
            };
            arguments.push(Box::new(source));
            let source_index = arguments.len();
            arguments.push(Box::new(u64_to_i64_cursor(start)?));
            let start_index = arguments.len();
            arguments.push(Box::new(u64_to_i64_cursor(end)?));
            let end_index = arguments.len();
            arguments.push(Box::new(id));
            let id_index = arguments.len();
            where_clause.push_str(&format!(
                " AND (r.note_path, r.span_start, r.span_end, r.id) > \
                 (?{source_index}, ?{start_index}, ?{end_index}, ?{id_index})"
            ));
        }

        let sql = format!(
            "SELECT r.id, r.kind, r.origin, r.raw_target, r.file_target, r.subpath_kind, \
                    r.subpath_value, r.display, r.span_start, r.span_end, \
                    r.target_span_start, r.target_span_end, \
                    s.kind, s.target_path, s.subpath_kind, s.subpath_value, r.note_path \
             FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
             WHERE {where_clause} \
             ORDER BY r.note_path, r.span_start, r.span_end, r.id LIMIT {}",
            i64::from(limit) + 1
        );
        let mut statement = transaction.prepare(&sql)?;
        let parameters: Vec<&dyn rusqlite::ToSql> =
            arguments.iter().map(|argument| argument.as_ref()).collect();
        let rows = statement
            .query_map(parameters.as_slice(), |row| {
                Ok((
                    crate::store::reference_row_prefix(row)?,
                    row.get::<_, String>(16)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut items = Vec::with_capacity(rows.len().min(limit as usize));
        for (row, note_path) in rows.iter().take(limit as usize) {
            let source = codec::decode_path(note_path)?;
            items.push(
                self.store
                    .resolved_reference_from_row(source, row.clone())?,
            );
        }
        let next_cursor = if rows.len() > limit as usize {
            let (last_row, last_path) = &rows[items.len() - 1];
            Some(encode_cursor(
                generation,
                query,
                CursorPosition::Reference {
                    source: last_path.clone(),
                    start: i64_to_u64_cursor(last_row.span_start)?,
                    end: i64_to_u64_cursor(last_row.span_end)?,
                    id: last_row.id,
                },
            )?)
        } else {
            None
        };
        Ok(Page {
            generation,
            items,
            next_cursor,
        })
    }

    pub fn get_diagnostics(
        &self,
        path: Option<&VaultPath>,
        severity: Option<vault_core::Severity>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<Diagnostic>, IndexError> {
        let limit = effective_limit(limit)?;
        let transaction = self.store.connection.unchecked_transaction()?;
        let generation = self.required_generation()?;
        let query = format!(
            "diagnostics:path={}:severity={}",
            path.map(VaultPath::as_str).unwrap_or_default(),
            severity.map(codec::encode_severity).unwrap_or_default()
        );

        let after = match cursor {
            None => None,
            Some(cursor) => Some(decode_cursor(cursor, generation, &query)?),
        };

        let page = diagnostics::diagnostic_page(
            &transaction,
            diagnostics::DiagnosticFilter {
                path: path.map(VaultPath::as_str),
                severity,
            },
            after,
            limit,
        )?;

        let next_cursor = page
            .next
            .map(|position| encode_cursor(generation, &query, position))
            .transpose()?;
        Ok(Page {
            generation,
            items: page.items,
            next_cursor,
        })
    }
}

fn u64_to_i64_cursor(value: u64) -> Result<i64, IndexError> {
    i64::try_from(value).map_err(|_| IndexError::InvalidCursor("cursor offset overflow".into()))
}

fn i64_to_u64_cursor(value: i64) -> Result<u64, IndexError> {
    u64::try_from(value).map_err(|_| IndexError::InvalidCursor("negative cursor offset".into()))
}
