//! The deterministic diagnostic union: one ordering over note-local,
//! resolution, and scan diagnostics, replacing the removed aggregate
//! `diagnostics` table. `note_diagnostics.path` falls back to the owning
//! note's path via `COALESCE` — a stored diagnostic with no explicit path
//! belongs to the note it is attached to.

use rusqlite::{Connection, params};
use vault_core::{Diagnostic, Severity};

use super::{i64_to_u64_cursor, u64_to_i64_cursor};
use crate::codec;
use crate::cursor::CursorPosition;
use crate::error::IndexError;

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

const DIAGNOSTIC_COLUMNS: &str = "path, span_start, span_end, code, severity, message, \
     owner_kind, owner_id";

const DIAGNOSTIC_ORDER: &str = "ORDER BY path, span_start, span_end, code, message, \
     owner_kind, owner_id";

type DiagnosticRow = (
    Option<String>,
    Option<i64>,
    Option<i64>,
    String,
    String,
    String,
    String,
    i64,
);

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiagnosticRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn row_to_diagnostic(row: DiagnosticRow) -> Result<Diagnostic, IndexError> {
    let (path, start, end, code, severity, message, _owner_kind, _owner_id) = row;
    codec::diagnostic_from_row(&code, &severity, message, path.as_deref(), start, end)
}

/// Every diagnostic attributed to one note (used by `get_note`), in the same
/// order the paginated union would visit them.
pub(crate) fn note_diagnostics(
    connection: &Connection,
    path: &str,
) -> Result<Vec<Diagnostic>, IndexError> {
    let sql = format!(
        "{DIAGNOSTIC_UNION_CTE} SELECT {DIAGNOSTIC_COLUMNS} FROM all_diagnostics \
         WHERE path = ?1 {DIAGNOSTIC_ORDER}"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(params![path], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(row_to_diagnostic).collect()
}

/// Every stored diagnostic, unfiltered and unpaginated — used only by the
/// test-only graph-verification facade, never by a production query path.
pub(crate) fn all_diagnostics(connection: &Connection) -> Result<Vec<Diagnostic>, IndexError> {
    let sql = format!(
        "{DIAGNOSTIC_UNION_CTE} SELECT {DIAGNOSTIC_COLUMNS} FROM all_diagnostics {DIAGNOSTIC_ORDER}"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map([], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(row_to_diagnostic).collect()
}

pub(crate) struct DiagnosticFilter<'a> {
    pub(crate) path: Option<&'a str>,
    pub(crate) severity: Option<Severity>,
}

pub(crate) struct DiagnosticPage {
    pub(crate) items: Vec<Diagnostic>,
    pub(crate) next: Option<CursorPosition>,
}

/// One page of the diagnostic union, filtered by optional path/severity and
/// keyset-paginated on the same `(path, span_start, span_end, code, message,
/// owner_kind, owner_id)` order used everywhere else.
pub(crate) fn diagnostic_page(
    connection: &Connection,
    filter: DiagnosticFilter<'_>,
    after: Option<CursorPosition>,
    limit: u32,
) -> Result<DiagnosticPage, IndexError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut arguments: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(path) = filter.path {
        arguments.push(Box::new(path.to_string()));
        clauses.push(format!("path = ?{}", arguments.len()));
    }
    if let Some(severity) = filter.severity {
        arguments.push(Box::new(codec::encode_severity(severity).to_string()));
        clauses.push(format!("severity = ?{}", arguments.len()));
    }
    if let Some(position) = after {
        let CursorPosition::Diagnostic {
            path,
            start,
            end,
            code,
            message,
            owner_kind,
            owner_id,
        } = position
        else {
            return Err(IndexError::InvalidCursor(
                "cursor position does not fit a diagnostic listing".into(),
            ));
        };
        clauses.push(after_clause(
            &mut arguments,
            path,
            start,
            end,
            code,
            message,
            owner_kind,
            owner_id,
        )?);
    }

    let where_clause = if clauses.is_empty() {
        "1 = 1".to_string()
    } else {
        clauses.join(" AND ")
    };
    let sql = format!(
        "{DIAGNOSTIC_UNION_CTE} SELECT {DIAGNOSTIC_COLUMNS} FROM all_diagnostics \
         WHERE {where_clause} {DIAGNOSTIC_ORDER} LIMIT {}",
        i64::from(limit) + 1
    );
    let mut statement = connection.prepare(&sql)?;
    let parameters: Vec<&dyn rusqlite::ToSql> =
        arguments.iter().map(|argument| argument.as_ref()).collect();
    let rows = statement
        .query_map(parameters.as_slice(), map_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let mut items = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.iter().take(limit as usize) {
        items.push(row_to_diagnostic(row.clone())?);
    }
    let next = if rows.len() > limit as usize {
        let last = &rows[items.len() - 1];
        Some(CursorPosition::Diagnostic {
            path: last.0.clone(),
            start: last.1.map(i64_to_u64_cursor).transpose()?,
            end: last.2.map(i64_to_u64_cursor).transpose()?,
            code: last.3.clone(),
            message: last.5.clone(),
            owner_kind: last.6.clone(),
            owner_id: last.7,
        })
    } else {
        None
    };
    Ok(DiagnosticPage { items, next })
}

/// Keyset condition for the diagnostic union's sort key with nullable
/// leading columns. NULLs sort first, matching the Rust `Option` ordering.
#[allow(clippy::too_many_arguments)]
fn after_clause(
    arguments: &mut Vec<Box<dyn rusqlite::ToSql>>,
    path: Option<String>,
    start: Option<u64>,
    end: Option<u64>,
    code: String,
    message: String,
    owner_kind: String,
    owner_id: i64,
) -> Result<String, IndexError> {
    let mut branches: Vec<String> = Vec::new();
    let mut prefix: Vec<String> = Vec::new();

    let nullable_column = |column: &str,
                           value: Option<Box<dyn rusqlite::ToSql>>,
                           arguments: &mut Vec<Box<dyn rusqlite::ToSql>>,
                           branches: &mut Vec<String>,
                           prefix: &mut Vec<String>| {
        match value {
            None => {
                let mut branch = prefix.clone();
                branch.push(format!("{column} IS NOT NULL"));
                branches.push(branch.join(" AND "));
                prefix.push(format!("{column} IS NULL"));
            }
            Some(value) => {
                arguments.push(value);
                let index = arguments.len();
                let mut branch = prefix.clone();
                branch.push(format!("{column} > ?{index}"));
                branches.push(branch.join(" AND "));
                prefix.push(format!("{column} = ?{index}"));
            }
        }
    };

    nullable_column(
        "path",
        path.map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
        arguments,
        &mut branches,
        &mut prefix,
    );
    nullable_column(
        "span_start",
        start
            .map(u64_to_i64_cursor)
            .transpose()?
            .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
        arguments,
        &mut branches,
        &mut prefix,
    );
    nullable_column(
        "span_end",
        end.map(u64_to_i64_cursor)
            .transpose()?
            .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
        arguments,
        &mut branches,
        &mut prefix,
    );

    for (column, value) in [
        ("code", code),
        ("message", message),
        ("owner_kind", owner_kind),
    ] {
        arguments.push(Box::new(value));
        let index = arguments.len();
        let mut branch = prefix.clone();
        branch.push(format!("{column} > ?{index}"));
        branches.push(branch.join(" AND "));
        prefix.push(format!("{column} = ?{index}"));
    }
    arguments.push(Box::new(owner_id));
    let index = arguments.len();
    let mut branch = prefix.clone();
    branch.push(format!("owner_id > ?{index}"));
    branches.push(branch.join(" AND "));

    Ok(format!(
        "({})",
        branches
            .into_iter()
            .map(|branch| format!("({branch})"))
            .collect::<Vec<_>>()
            .join(" OR ")
    ))
}
