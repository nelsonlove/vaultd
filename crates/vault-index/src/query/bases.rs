//! Bases over the index: the `RowSource` implementation and the two reads.
//!
//! Everything a view reads comes from one generation: the SQLite rows
//! through a private connection pinned to that generation, and the base and
//! resolution copied out of the live graph under the same publication guard
//! (`IndexReader::evaluation_read`). The evaluation itself runs with no lock
//! held. `vault-bases` never sees either.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
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

/// Unresolved references by the lowercased file name they target:
/// `(note, raw target)` each.
type UnresolvedByName = HashMap<String, Vec<(String, String)>>;

/// The row source over one pinned read: a connection inside a read
/// transaction at the evaluated generation.
struct IndexRowSource<'c> {
    connection: &'c Connection,
    resolver: Arc<Resolver>,
    types: &'c BTreeMap<String, PropertyType>,
    /// [`IndexRowSource::attachment`]'s answers in this evaluation, by
    /// target text: one lookup per distinct target, not one per row.
    attachments: RefCell<HashMap<String, Option<VaultPath>>>,
    /// The references the resolver left unresolved, by the ASCII-lowercased
    /// last component of their file target: `(note, raw target)` each.
    /// Built on the first attachment backlinks read of this evaluation (one
    /// generation), so each attachment row is one lookup instead of a scan
    /// of every unresolved reference.
    unresolved_by_name: RefCell<Option<UnresolvedByName>>,
    /// Every file (non-note) path in the tree, by its ASCII-lowercased last
    /// component, sorted by path. Built on the first attachment lookup of
    /// this evaluation: one scan of `tree_entries`, after which each distinct
    /// target is one lookup instead of one scan.
    files_by_name: RefCell<Option<HashMap<String, Vec<String>>>>,
}

impl<'c> IndexRowSource<'c> {
    fn new(
        connection: &'c Connection,
        resolver: Arc<Resolver>,
        types: &'c BTreeMap<String, PropertyType>,
    ) -> Self {
        Self {
            connection,
            resolver,
            types,
            attachments: RefCell::new(HashMap::new()),
            unresolved_by_name: RefCell::new(None),
            files_by_name: RefCell::new(None),
        }
    }

    /// The file name an attachment lookup compares against: the last
    /// component of the target's file part, ASCII-lowercased (SQLite's
    /// `lower`, which [`Self::find_attachment`] matches with).
    fn attachment_key(target: &str) -> Option<String> {
        let parsed = LinkTarget::parse(target);
        let file = parsed.file_target.as_deref()?;
        Some(file.rsplit('/').next().unwrap_or(file).to_ascii_lowercase())
    }

    /// Fill [`Self::files_by_name`] once: one pass over the tree's files.
    fn load_files_by_name(&self) -> Result<(), SourceError> {
        if self.files_by_name.borrow().is_some() {
            return Ok(());
        }
        let mut statement = self
            .connection
            .prepare_cached("SELECT path FROM tree_entries WHERE kind = 'file' ORDER BY path")
            .map_err(source_error)?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for path in paths {
            let key = path
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_ascii_lowercase();
            by_name.entry(key).or_default().push(path);
        }
        *self.files_by_name.borrow_mut() = Some(by_name);
        Ok(())
    }

    /// Fill [`Self::unresolved_by_name`] once: one pass over the unresolved
    /// references.
    fn load_unresolved_by_name(&self) -> Result<(), SourceError> {
        if self.unresolved_by_name.borrow().is_some() {
            return Ok(());
        }
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT DISTINCT r.note_path, r.raw_target FROM resolutions s \
                 JOIN note_references r ON r.id = s.reference_id \
                 WHERE s.kind = 'unresolved'",
            )
            .map_err(source_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        let mut by_name: UnresolvedByName = HashMap::new();
        for (note, raw_target) in rows {
            if let Some(key) = Self::attachment_key(&raw_target) {
                by_name.entry(key).or_default().push((note, raw_target));
            }
        }
        *self.unresolved_by_name.borrow_mut() = Some(by_name);
        Ok(())
    }
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
                "unresolved" => self.attachment(&raw_target)?,
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

    /// The attachment `target` names, when the link resolver leaves it
    /// unresolved: the resolver's catalog holds notes and bases, and Obsidian
    /// resolves a link to any file (captured, Task 13: `file("Folder/image.png")`
    /// is the image, and a note embedding it `hasLink` it). An exact path
    /// first, else the one attachment with that name in any folder, letters
    /// compared without case; two such files name neither.
    fn attachment(&self, target: &str) -> Result<Option<VaultPath>, SourceError> {
        if let Some(known) = self.attachments.borrow().get(target) {
            return Ok(known.clone());
        }
        let found = self.find_attachment(target)?;
        self.attachments
            .borrow_mut()
            .insert(target.to_string(), found.clone());
        Ok(found)
    }

    fn find_attachment(&self, target: &str) -> Result<Option<VaultPath>, SourceError> {
        let parsed = LinkTarget::parse(target);
        let Some(file) = parsed.file_target.as_deref() else {
            return Ok(None);
        };
        // A name with no extension names a note, never an attachment
        // (captured: `file("Folder/README")` is empty).
        let name = file.rsplit('/').next().unwrap_or(file);
        let has_extension = name.chars().skip(1).any(|c| c == '.');
        if file.starts_with("./") || file.starts_with("../") || !has_extension {
            return Ok(None);
        }
        // The rule the SQL form had (`lower(path) = lower(file)`, or the path
        // ends in `/` plus the lowercased file; ordered by path, at most 8),
        // answered from the map: only a path whose last component is the
        // file's last component can match either way.
        self.load_files_by_name()?;
        let folded = file.to_ascii_lowercase();
        let suffix = format!("/{folded}");
        let key = folded.rsplit('/').next().unwrap_or(&folded).to_string();
        let found: Vec<String> = self
            .files_by_name
            .borrow()
            .as_ref()
            .and_then(|by_name| by_name.get(&key))
            .map(|paths| {
                paths
                    .iter()
                    .filter(|path| {
                        let lower = path.to_ascii_lowercase();
                        lower == folded || lower.ends_with(&suffix)
                    })
                    .take(8)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let chosen = match found.iter().find(|path| path.as_str() == file) {
            Some(exact) => Some(exact),
            None if found.len() == 1 => found.first(),
            None => None,
        };
        chosen
            .map(|path| codec::decode_path(path).map_err(source_error))
            .transpose()
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
    /// equal-value probe by `properties_by_string` or
    /// `properties_by_number` (`key_fold` and the value), the
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
            "SELECT note_path FROM properties WHERE key_fold = ? AND {equal} \
             UNION ALL SELECT note_path FROM properties WHERE key_fold = ? AND kind IN ({other})"
        );
        if matches!(value, ScalarLiteral::String(_)) {
            // A frontmatter wikilink is a link to the filter, never text.
            arguments.push(Argument::Text(fold));
            probes.push_str(
                " UNION ALL SELECT note_path FROM properties WHERE key_fold = ? \
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
        let mut found: BTreeSet<VaultPath> = paths
            .iter()
            .map(|path| codec::decode_path(path).map_err(source_error))
            .collect::<Result<_, _>>()?;
        // An attachment's backlinks are the notes whose links the resolver
        // left unresolved and `attachment` resolves to it, so that
        // `backlinks` agrees with `links` and `hasLink`.
        let is_attachment = self
            .facts(path)?
            .is_some_and(|facts| facts.kind == FileKind::File);
        if is_attachment {
            // Only a reference whose file target ends in this attachment's
            // name can resolve to it (`find_attachment` matches the whole
            // path or a `/`-suffix of it), so the candidates are one lookup.
            self.load_unresolved_by_name()?;
            let candidates = self
                .unresolved_by_name
                .borrow()
                .as_ref()
                .and_then(|by_name| by_name.get(&path.name().to_ascii_lowercase()).cloned())
                .unwrap_or_default();
            for (note, raw_target) in candidates {
                if self.attachment(&raw_target)?.as_ref() == Some(path) {
                    found.insert(codec::decode_path(&note).map_err(source_error)?);
                }
            }
        }
        Ok(found.into_iter().collect())
    }

    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError> {
        match self
            .resolver
            .resolve_target(from, &LinkTarget::parse(target))
        {
            Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
                Ok(Some(target))
            }
            Resolution::Unresolved => self.attachment(target),
            _ => Ok(None),
        }
    }

    /// A declared type, its key matched without case when no key matches
    /// exactly (captured, Task 13: `types.json` declaring `T13Typed` a date
    /// types a note's `t13typed`).
    fn property_type(&self, key: &str) -> Option<PropertyType> {
        self.types.get(key).copied().or_else(|| {
            let folded = key.to_lowercase();
            self.types
                .iter()
                .find(|(declared, _)| declared.to_lowercase() == folded)
                .map(|(_, kind)| *kind)
        })
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

/// How long `evaluate_base` keeps asking again when a refusal says the
/// generation moved under it (a foreign writer's commit, or the writer's
/// commit landing between the snapshot and the guard), before it answers the
/// typed error. An answer is never refused merely because the vault keeps
/// changing: each attempt pins whatever generation is published then.
const EVALUATION_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// The first pause between attempts; it doubles up to
/// [`EVALUATION_BACKOFF_MAX`].
const EVALUATION_BACKOFF: std::time::Duration = std::time::Duration::from_millis(1);
const EVALUATION_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_millis(32);

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
            let source = IndexRowSource::new(transaction, resolver, types);
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
            let source = IndexRowSource::new(transaction, resolver, types);
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
    /// publication or another read never waits for it. The resolver is the
    /// one for the pinned generation (built from a catalog copied under the
    /// same guard when none is), so the resolver, the base and the rows are
    /// always one generation. A refusal because the generation moved is
    /// asked again with backoff for up to [`EVALUATION_BUDGET`].
    pub fn evaluate_base(
        &self,
        query: &BaseQuery<'_>,
        clock: &Clock,
    ) -> Result<BaseAnswer, BaseQueryError> {
        let deadline = std::time::Instant::now() + EVALUATION_BUDGET;
        let mut pause = EVALUATION_BACKOFF;
        loop {
            let started = self.evaluation_read_resolving(deadline, |graph| {
                let record = graph
                    .base(query.path)
                    .map(|record| (record.file.clone(), record.error.clone()));
                let this_is_a_note = query.this_path.map(|this| graph.contains_note(this));
                (record, this_is_a_note)
            });
            match started {
                Ok((read, (record, this_is_a_note), resolver)) => {
                    return evaluate_in(&read, record, this_is_a_note, resolver, query, clock);
                }
                Err(error @ IndexError::LiveStateStale(_)) => {
                    if std::time::Instant::now() + pause > deadline {
                        return Err(error.into());
                    }
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(EVALUATION_BACKOFF_MAX);
                }
                Err(error) => return Err(error.into()),
            }
        }
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
    let source = IndexRowSource::new(read.connection(), resolver, query.types);
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

/// What prefilter matching needs to know about one changed path at the
/// current generation: its tags (as the `tags` table folds them) and its
/// property keys (as `properties.key_fold` folds them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrefilterFacts {
    pub tags: Vec<String>,
    pub keys: Vec<String>,
}

/// One base's views and what each reads: `None` for a view that does not
/// compile, and no views at all for a base that does not parse.
pub type BaseViewDependencies = Vec<(String, Option<ViewDependencies>)>;

impl IndexReader {
    /// Facts for the paths that exist as files or notes at the published
    /// generation, read in one generation-consistent read; a deleted path or
    /// a folder has no entry.
    pub fn prefilter_facts(
        &self,
        paths: &std::collections::BTreeSet<VaultPath>,
    ) -> Result<(Generation, BTreeMap<VaultPath, PrefilterFacts>), IndexError> {
        self.read(|transaction, generation| {
            let mut facts = BTreeMap::new();
            let mut exists = transaction.prepare_cached(
                "SELECT kind FROM tree_entries WHERE path = ?1 AND kind != 'folder'",
            )?;
            let mut tags = transaction
                .prepare_cached("SELECT comparison_key FROM tags WHERE note_path = ?1")?;
            let mut keys = transaction
                .prepare_cached("SELECT key_fold FROM properties WHERE note_path = ?1")?;
            for path in paths {
                let kind: Option<String> = exists
                    .query_row(params![path.as_str()], |row| row.get(0))
                    .optional()?;
                if kind.is_none() {
                    continue;
                }
                let tags = tags
                    .query_map(params![path.as_str()], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let keys = keys
                    .query_map(params![path.as_str()], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                facts.insert(path.clone(), PrefilterFacts { tags, keys });
            }
            Ok((generation, facts))
        })
    }

    /// Every view of every base (or of `bases` only) with its dependencies,
    /// at the published generation. The parsed bases are copied out of the
    /// live graph under the guard (`Arc` clones); the views compile with no
    /// lock held.
    pub fn base_dependencies(
        &self,
        bases: Option<&std::collections::BTreeSet<VaultPath>>,
    ) -> Result<(Generation, BTreeMap<VaultPath, BaseViewDependencies>), IndexError> {
        let (generation, files) = self.copy_from_graph(|graph| {
            graph
                .base_paths()
                .filter(|path| bases.is_none_or(|wanted| wanted.contains(*path)))
                .filter_map(|path| {
                    graph
                        .base(path)
                        .map(|record| (path.clone(), record.file.clone()))
                })
                .collect::<Vec<_>>()
        })?;
        let out = files
            .into_iter()
            .map(|(path, file)| {
                let views = match file {
                    Some(file) => file
                        .view_names()
                        .into_iter()
                        .map(|name| {
                            let dependencies = compile_view(&file, Some(&name))
                                .ok()
                                .map(|view| view.dependencies().clone());
                            (name, dependencies)
                        })
                        .collect(),
                    None => Vec::new(),
                };
                (path, views)
            })
            .collect();
        Ok((generation, out))
    }
}
