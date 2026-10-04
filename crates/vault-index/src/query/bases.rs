//! Bases over the index: the `RowSource` implementation and the two reads.
//!
//! Everything a view reads comes from one generation: the SQLite rows
//! through a private connection pinned to that generation, and the base and
//! resolution copied out of the live graph under the same publication guard
//! (`IndexReader::evaluation_read`). The evaluation itself runs with no lock
//! held. `vault-bases` never sees either.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};
use vault_bases::eval::EvalContext;
use vault_bases::view::{
    ColumnDecl, CompileError, ViewDependencies, ViewResult, compile_view, evaluate_view,
};
use vault_bases::{
    BaseParseError, Clock, FileFacts, FileKind, LinkFact, Prefilter, PropertyType, RowSource,
    ScalarLiteral, SourceError, ViewDecl,
};
use vault_core::{LinkTarget, PropertyValue, Resolution, Resolver, SourceSpan, VaultPath};

use crate::codec;
use crate::cursor::{CursorPosition, decode_cursor, encode_cursor};
use crate::error::IndexError;
use crate::model::Generation;
use crate::query::{Page, effective_limit};
use crate::reader::{EvaluationRead, IndexReader};

/// One view to evaluate: the base, the view (absent is the first declared),
/// the embedding note (absent is the base itself), and the vault's declared
/// property types.
pub struct BaseQuery<'a> {
    pub path: &'a VaultPath,
    pub view: Option<&'a str>,
    pub this_path: Option<&'a VaultPath>,
    pub types: &'a BTreeMap<String, PropertyType>,
}

/// A view's whole result at one generation. `dependencies` is what the view
/// reads, kept for the per-generation cache and the invalidation event.
#[derive(Clone, Debug)]
pub struct BaseAnswer {
    pub generation: Generation,
    pub view: ViewDecl,
    pub columns: Vec<ColumnDecl>,
    pub result: ViewResult,
    pub dependencies: ViewDependencies,
}

#[derive(Debug)]
pub enum BaseQueryError {
    Index(IndexError),
    /// No base at this path in the published generation.
    NotFound(VaultPath),
    /// The base is indexed but did not parse.
    Invalid(BaseParseError),
    Compile(CompileError),
    /// `this_path` names no note in the vault.
    ThisPath(String),
}

impl From<IndexError> for BaseQueryError {
    fn from(error: IndexError) -> Self {
        Self::Index(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum BaseStatus {
    Parsed,
    ParseFailed(BaseParseError),
}

/// One row of `list_bases`: the base, whether it parsed, and its view names
/// in declared order (none when it failed to parse).
#[derive(Clone, Debug, PartialEq)]
pub struct BaseSummary {
    pub path: VaultPath,
    pub status: BaseStatus,
    pub views: Vec<String>,
}

/// `.obsidian/types.json` as Obsidian writes it
/// (`{"types": {"<key>": "<type>"}}`). Unknown type names are `Unknown`;
/// anything that is not that shape is no declared types at all, never an
/// error.
pub fn parse_property_types(json: &str) -> BTreeMap<String, PropertyType> {
    let Ok(serde_json::Value::Object(root)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return BTreeMap::new();
    };
    let Some(serde_json::Value::Object(types)) = root.get("types") else {
        return BTreeMap::new();
    };
    types
        .iter()
        .filter_map(|(key, kind)| {
            let kind = match kind.as_str()? {
                "text" => PropertyType::Text,
                "number" => PropertyType::Number,
                "checkbox" => PropertyType::Checkbox,
                "date" => PropertyType::Date,
                "datetime" => PropertyType::DateTime,
                "multitext" => PropertyType::List,
                "tags" => PropertyType::Tags,
                "aliases" => PropertyType::Aliases,
                _ => PropertyType::Unknown,
            };
            Some((key.clone(), kind))
        })
        .collect()
}

fn source_error(error: impl std::fmt::Display) -> SourceError {
    SourceError(error.to_string())
}

/// The row source over one pinned read: a connection inside a read
/// transaction at the evaluated generation.
struct IndexRowSource<'c> {
    connection: &'c Connection,
    resolver: Arc<Resolver>,
    types: &'c BTreeMap<String, PropertyType>,
}

/// `substr(path, 1, n) = prefix` rather than `LIKE`, so `%` and `_` in a
/// folder name are literal.
const IN_FOLDER: &str = "substr(t.path, 1, length(?) + 1) = ? || '/'";

/// One SQL parameter of the candidate query.
enum Argument {
    Text(String),
    Real(f64),
}

impl rusqlite::ToSql for Argument {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        match self {
            Argument::Text(text) => text.to_sql(),
            Argument::Real(number) => number.to_sql(),
        }
    }
}

impl IndexRowSource<'_> {
    fn references(&self, path: &VaultPath, embeds: bool) -> Result<Vec<LinkFact>, SourceError> {
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT r.kind, r.raw_target, r.display, s.kind, s.target_path \
                 FROM note_references r JOIN resolutions s ON s.reference_id = r.id \
                 WHERE r.note_path = ?1 ORDER BY r.ordinal",
            )
            .map_err(source_error)?;
        let rows = statement
            .query_map(params![path.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        let mut facts = Vec::new();
        for (kind, raw_target, display, resolution, target) in rows {
            if kind.ends_with("embed") != embeds {
                continue;
            }
            let resolved = match resolution.as_str() {
                "resolved" | "missing_subpath" => target
                    .map(|target| codec::decode_path(&target))
                    .transpose()
                    .map_err(source_error)?,
                _ => None,
            };
            facts.push(LinkFact {
                raw_target,
                display,
                resolved,
            });
        }
        Ok(facts)
    }

    /// Whether the declared types may turn `key`'s text into something a
    /// string never equals (a date): such a row must reach the full filter.
    /// Matched case-insensitively, which only ever admits more rows.
    fn may_be_typed_date(&self, key: &str) -> bool {
        let fold = key.to_lowercase();
        self.types.iter().any(|(declared, kind)| {
            matches!(kind, PropertyType::Date | PropertyType::DateTime)
                && declared.to_lowercase() == fold
        })
    }

    /// The `PropertyEquals` narrowing, by the rule on
    /// [`Prefilter::PropertyEquals`]: a note is skipped only when it lacks
    /// the key, holds `null` under it, or holds a scalar of the literal's own
    /// kind that differs from it. A list, a mapping and a scalar of another
    /// kind are always admitted, and so is text the full filter may read as
    /// something other than text (a wikilink, or a date by declared type).
    /// The key is matched folded, a superset of the exact key the filter
    /// reads.
    ///
    /// Written as a `UNION ALL` of probes so each is served by an index: the
    /// equal-value probe by `property_scalars_by_string` or
    /// `property_scalars_by_number` (`key_fold` and the value), the
    /// other-kind and wikilink probes by the `key_fold` prefix.
    fn property_equals(
        &self,
        key: &str,
        value: &ScalarLiteral,
        arguments: &mut Vec<Argument>,
    ) -> String {
        let fold = key.to_lowercase();
        let (equal, other) = match value {
            ScalarLiteral::String(want) => {
                arguments.push(Argument::Text(fold.clone()));
                arguments.push(Argument::Text(want.clone()));
                let other = if self.may_be_typed_date(key) {
                    // A date-typed key: every text row reaches the filter.
                    "'number', 'boolean', 'list', 'object', 'string', 'date'"
                } else {
                    "'number', 'boolean', 'list', 'object'"
                };
                ("string_value = ?", other)
            }
            ScalarLiteral::Number(want) => {
                arguments.push(Argument::Text(fold.clone()));
                arguments.push(Argument::Real(*want));
                (
                    "number_value = ?",
                    "'string', 'date', 'boolean', 'list', 'object'",
                )
            }
            ScalarLiteral::Boolean(want) => {
                arguments.push(Argument::Text(fold.clone()));
                arguments.push(Argument::Real(if *want { 1.0 } else { 0.0 }));
                (
                    "number_value = ?",
                    "'string', 'date', 'number', 'list', 'object'",
                )
            }
        };
        arguments.push(Argument::Text(fold.clone()));
        let mut probes = format!(
            "SELECT note_path FROM property_scalars WHERE key_fold = ? AND {equal} \
             UNION ALL SELECT note_path FROM property_scalars WHERE key_fold = ? AND kind IN ({other})"
        );
        if matches!(value, ScalarLiteral::String(_)) {
            // A frontmatter wikilink is a link to the filter, never text.
            arguments.push(Argument::Text(fold));
            probes.push_str(
                " UNION ALL SELECT note_path FROM property_scalars WHERE key_fold = ? \
                 AND kind IN ('string', 'date') AND instr(string_value, '[[') > 0",
            );
        }
        format!(" AND t.path IN ({probes})")
    }

    /// The candidate query for `prefilters`, its arguments, and the
    /// extension filter applied after it.
    fn candidates_query<'p>(
        &self,
        prefilters: &'p [Prefilter],
    ) -> (String, Vec<Argument>, Option<&'p str>) {
        let mut sql =
            String::from("SELECT t.path FROM tree_entries t WHERE t.kind IN ('note', 'file')");
        let mut arguments: Vec<Argument> = Vec::new();
        let mut ext: Option<&str> = None;
        for prefilter in prefilters {
            match prefilter {
                Prefilter::InFolder(folder) => {
                    let folder = folder.trim_matches('/').to_string();
                    if folder.is_empty() {
                        continue;
                    }
                    sql.push_str(" AND ");
                    sql.push_str(IN_FOLDER);
                    arguments.push(Argument::Text(folder.clone()));
                    arguments.push(Argument::Text(folder));
                }
                Prefilter::HasTag(tags) => {
                    let mut clauses = Vec::new();
                    for tag in tags {
                        let tag = tag.trim_start_matches('#').to_lowercase();
                        clauses.push(
                            "comparison_key = ? OR substr(comparison_key, 1, length(?) + 1) = ? || '/'",
                        );
                        arguments.push(Argument::Text(tag.clone()));
                        arguments.push(Argument::Text(tag.clone()));
                        arguments.push(Argument::Text(tag));
                    }
                    if clauses.is_empty() {
                        clauses.push("0");
                    }
                    sql.push_str(" AND t.path IN (SELECT note_path FROM tags WHERE ");
                    sql.push_str(&clauses.join(" OR "));
                    sql.push(')');
                }
                Prefilter::Ext(wanted) => ext = Some(wanted.as_str()),
                Prefilter::PropertyEquals { key, value } => {
                    let clause = self.property_equals(key, value, &mut arguments);
                    sql.push_str(&clause);
                }
            }
        }
        sql.push_str(" ORDER BY t.path");
        (sql, arguments, ext)
    }
}

impl RowSource for IndexRowSource<'_> {
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError> {
        let (sql, arguments, ext) = self.candidates_query(prefilters);
        let mut statement = self.connection.prepare(&sql).map_err(source_error)?;
        let paths = statement
            .query_map(rusqlite::params_from_iter(arguments.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        let mut candidates = Vec::with_capacity(paths.len());
        for path in paths {
            let path = codec::decode_path(&path).map_err(source_error)?;
            if ext.is_none_or(|wanted| vault_bases::extension(&path) == wanted) {
                candidates.push(path);
            }
        }
        Ok(candidates)
    }

    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError> {
        let row = self
            .connection
            .query_row(
                "SELECT kind, size, ctime_unix_ms, mtime_unix_ms FROM tree_entries \
                 WHERE path = ?1 AND kind != 'folder'",
                params![path.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(source_error)?;
        Ok(row.map(|(kind, size, ctime_ms, mtime_ms)| FileFacts {
            path: path.clone(),
            kind: if kind == "note" {
                FileKind::Note
            } else {
                FileKind::File
            },
            size: u64::try_from(size.unwrap_or(0)).unwrap_or(0),
            ctime_ms,
            mtime_ms,
        }))
    }

    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError> {
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT key_text, value_json FROM properties WHERE note_path = ?1 ORDER BY ordinal",
            )
            .map_err(source_error)?;
        let rows = statement
            .query_map(params![path.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        rows.into_iter()
            .map(|(key, json)| {
                Ok((
                    key,
                    codec::decode_property_value(&json).map_err(source_error)?,
                ))
            })
            .collect()
    }

    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT value FROM tags WHERE note_path = ?1 ORDER BY ordinal")
            .map_err(source_error)?;
        let tags = statement
            .query_map(params![path.as_str()], |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        Ok(tags)
    }

    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        self.references(path, false)
    }

    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        self.references(path, true)
    }

    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError> {
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT DISTINCT r.note_path FROM resolutions s \
                 JOIN note_references r ON r.id = s.reference_id \
                 WHERE s.target_path = ?1 AND s.kind IN ('resolved', 'missing_subpath') \
                 ORDER BY r.note_path",
            )
            .map_err(source_error)?;
        let paths = statement
            .query_map(params![path.as_str()], |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        paths
            .iter()
            .map(|path| codec::decode_path(path).map_err(source_error))
            .collect()
    }

    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError> {
        Ok(
            match self
                .resolver
                .resolve_target(from, &LinkTarget::parse(target))
            {
                Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
                    Some(target)
                }
                _ => None,
            },
        )
    }

    fn property_type(&self, key: &str) -> Option<PropertyType> {
        self.types.get(key).copied()
    }
}

/// The first stored diagnostic of a base that failed to parse, as the parse
/// error it was built from.
fn parse_failure(diagnostics_json: &str) -> BaseParseError {
    let first = serde_json::from_str::<serde_json::Value>(diagnostics_json)
        .ok()
        .and_then(|value| value.as_array().and_then(|items| items.first().cloned()));
    let message = first
        .as_ref()
        .and_then(|item| item.get("message"))
        .and_then(|message| message.as_str())
        .unwrap_or("the base failed to parse")
        .to_string();
    let span = first.as_ref().and_then(|item| {
        let start = usize::try_from(item.get("span_start")?.as_u64()?).ok()?;
        let end = usize::try_from(item.get("span_end")?.as_u64()?).ok()?;
        SourceSpan::new(start, end).ok()
    });
    BaseParseError { message, span }
}

const LIST_BASES: &str = "list_bases";

/// How many times `evaluate_base` asks again when the writer installs a
/// generation between building the resolver and opening the read.
const EVALUATION_ATTEMPTS: usize = 3;

impl IndexReader {
    /// Every indexed base in path order, paged by the protocol's rule, with
    /// its parse status and its view names.
    pub fn list_bases(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<BaseSummary>, IndexError> {
        let limit = effective_limit(limit)?;
        self.read(|transaction, generation| {
            let after = match cursor {
                None => None,
                Some(cursor) => match decode_cursor(cursor, generation, LIST_BASES)? {
                    CursorPosition::Base { path } => Some(path),
                    _ => {
                        return Err(IndexError::InvalidCursor(
                            "cursor position does not fit a base listing".into(),
                        ));
                    }
                },
            };
            let mut statement = transaction.prepare(
                "SELECT path, parse_status, view_names_json, diagnostics_json FROM bases \
                 WHERE ?1 IS NULL OR path > ?1 ORDER BY path LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![after, i64::from(limit) + 1], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let more = rows.len() > limit as usize;
            let mut items = Vec::new();
            for (path, status, views, diagnostics) in rows.into_iter().take(limit as usize) {
                items.push(BaseSummary {
                    path: codec::decode_path(&path)?,
                    status: match status.as_str() {
                        "parsed" => BaseStatus::Parsed,
                        "parse_failed" => BaseStatus::ParseFailed(parse_failure(&diagnostics)),
                        other => {
                            return Err(IndexError::IncompatibleIndex(format!(
                                "unknown base parse status {other:?}"
                            )));
                        }
                    },
                    views: serde_json::from_str(&views)?,
                });
            }
            let next_cursor = match (more, items.last()) {
                (true, Some(last)) => Some(encode_cursor(
                    generation,
                    LIST_BASES,
                    CursorPosition::Base {
                        path: last.path.as_str().to_string(),
                    },
                )?),
                _ => None,
            };
            Ok(Page {
                generation,
                items,
                next_cursor,
            })
        })
    }

    /// What the index row source answers to `candidates(prefilters)` at the
    /// published generation. Test-only: it lets a test pin the prefilter
    /// narrowing itself, which the rows alone cannot show (a prefilter that
    /// skipped a row the filter excludes anyway changes no answer).
    #[doc(hidden)]
    pub fn base_candidates_for_test(
        &self,
        prefilters: &[Prefilter],
        types: &BTreeMap<String, PropertyType>,
    ) -> Result<Vec<VaultPath>, IndexError> {
        let (_, resolver) = self.resolver()?;
        self.read(|transaction, _| {
            let source = IndexRowSource {
                connection: transaction,
                resolver,
                types,
            };
            source
                .candidates(prefilters)
                .map_err(|error| IndexError::Storage(error.0))
        })
    }

    /// The `EXPLAIN QUERY PLAN` details of the candidate query for
    /// `prefilters`. Test-only: it pins which indexes serve the narrowing.
    #[doc(hidden)]
    pub fn base_candidates_plan_for_test(
        &self,
        prefilters: &[Prefilter],
        types: &BTreeMap<String, PropertyType>,
    ) -> Result<Vec<String>, IndexError> {
        let (_, resolver) = self.resolver()?;
        self.read(|transaction, _| {
            let source = IndexRowSource {
                connection: transaction,
                resolver,
                types,
            };
            let (sql, arguments, _) = source.candidates_query(prefilters);
            let mut statement = transaction.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let details = statement
                .query_map(rusqlite::params_from_iter(arguments.iter()), |row| {
                    row.get::<_, String>(3)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(details)
        })
    }

    /// Evaluate one view at the current generation.
    ///
    /// Only the setup runs under the publication guard (the eighth shape in
    /// `reader.rs`): the base's parsed file and the `this_path` check are
    /// copied out of the live graph, and a private connection is pinned to
    /// the generation. The evaluation then runs with no lock held, so a
    /// publication or another read never waits for it. Asks again when the
    /// writer installs between building the resolver and taking the guard,
    /// so the resolver, the base and the rows are always one generation.
    pub fn evaluate_base(
        &self,
        query: &BaseQuery<'_>,
        clock: &Clock,
    ) -> Result<BaseAnswer, BaseQueryError> {
        let mut last =
            IndexError::Storage("the generation would not hold still for an evaluation".into());
        for _ in 0..EVALUATION_ATTEMPTS {
            let (resolver_generation, resolver) = self.resolver()?;
            let started = self.evaluation_read(resolver_generation, |graph| {
                let record = graph
                    .base(query.path)
                    .map(|record| (record.file.clone(), record.error.clone()));
                let this_is_a_note = query.this_path.map(|this| graph.contains_note(this));
                (record, this_is_a_note)
            });
            match started {
                Ok((read, (record, this_is_a_note))) => {
                    return evaluate_in(&read, record, this_is_a_note, resolver, query, clock);
                }
                Err(error @ IndexError::LiveStateStale(_)) => last = error,
                Err(error) => return Err(error.into()),
            }
        }
        Err(last.into())
    }
}

/// A base as the live graph held it: its parsed file, or the parse error.
type BaseCopy = (Option<Arc<vault_bases::BaseFile>>, Option<BaseParseError>);

/// The evaluation proper, outside every lock, on the pinned connection.
fn evaluate_in(
    read: &EvaluationRead<'_>,
    record: Option<BaseCopy>,
    this_is_a_note: Option<bool>,
    resolver: Arc<Resolver>,
    query: &BaseQuery<'_>,
    clock: &Clock,
) -> Result<BaseAnswer, BaseQueryError> {
    let (file, error) = record.ok_or_else(|| BaseQueryError::NotFound(query.path.clone()))?;
    let Some(file) = file else {
        return Err(BaseQueryError::Invalid(error.unwrap_or(BaseParseError {
            message: "the base failed to parse".into(),
            span: None,
        })));
    };
    if let (Some(this), Some(false)) = (query.this_path, this_is_a_note) {
        return Err(BaseQueryError::ThisPath(format!(
            "this_path {:?} is not a note in the vault",
            this.as_str()
        )));
    }
    let generation = read.generation;
    let compiled = compile_view(&file, query.view).map_err(BaseQueryError::Compile)?;
    let source = IndexRowSource {
        connection: read.connection(),
        resolver,
        types: query.types,
    };
    // No embedding note means `this` is the base itself.
    let this = query.this_path.unwrap_or(query.path);
    let ctx = EvalContext::new(&source, clock, query.path, this);
    let result = evaluate_view(&compiled, &ctx)
        .map_err(|error| BaseQueryError::Index(IndexError::Storage(error.0)))?;
    Ok(BaseAnswer {
        generation,
        view: compiled.decl().clone(),
        columns: compiled.columns().to_vec(),
        dependencies: compiled.dependencies().clone(),
        result,
    })
}
