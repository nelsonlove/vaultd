//! Search over the index: the document source and the exact scan.
//!
//! Everything a search reads comes from one generation, through a private
//! connection pinned to it under the publication guard
//! (`IndexReader::evaluation_read_current`); the scan itself runs with no lock
//! held. The tree rows (and the tag rows, when the query reads tags) narrow
//! the candidates through the compiled query's metadata prefilter before any
//! note body is read, and a body is read only for a surviving note, only when
//! the query reads text, evaluated at once and dropped. Nothing is cached
//! here and nothing is written.

use std::collections::HashMap;
use std::ops::Range;
use std::time::{Duration, Instant};

use rusqlite::types::{FromSqlError, ValueRef};
use rusqlite::{OptionalExtension, params};
use vault_core::VaultPath;
use vault_search::text::LineIndex;
use vault_search::{
    CompiledQuery, DocumentKind, FileHit, SearchDocument, SortOrder, TagFact, Times, evaluate,
    sort_hits,
};

use crate::codec;
use crate::error::IndexError;
use crate::model::Generation;
use crate::reader::{EvaluationRead, IndexReader};

/// One search: the compiled query and the order of its hits.
pub struct SearchQuery<'a> {
    pub compiled: &'a CompiledQuery,
    pub sort: SortOrder,
}

/// Every hit of one search, sorted, at the generation it was read from.
#[derive(Clone, Debug)]
pub struct SearchAnswer {
    pub generation: Generation,
    pub hits: Vec<FileHit>,
    /// Note bodies read for this answer: a work counter, for tests and the baseline.
    pub texts_read: usize,
}

/// The line holding a match, cut to at most [`MAX_LINE_TEXT_BYTES`] around
/// it on character boundaries, and the cut's byte offset in the source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchContext {
    pub line_text: String,
    pub line_text_start: usize,
}

/// The longest line text a match context carries.
pub const MAX_LINE_TEXT_BYTES: usize = 512;

/// How long `search` keeps pinning again when a refusal says the generation
/// moved under it, before it answers the typed error: the Bases evaluation
/// budget's value (`query/bases.rs`), named separately so either can move
/// alone.
const SEARCH_BUDGET: Duration = Duration::from_secs(2);

/// The first pause between attempts; it doubles up to [`SEARCH_BACKOFF_MAX`].
const SEARCH_BACKOFF: Duration = Duration::from_millis(1);
const SEARCH_BACKOFF_MAX: Duration = Duration::from_millis(32);

/// One non-folder tree row.
struct FileRow {
    path: VaultPath,
    kind: DocumentKind,
    times: Times,
}

/// One file as the query sees it: its tree row, its text when read, and its
/// tags when the query reads tags.
struct IndexDocument<'a> {
    row: &'a FileRow,
    text: Option<&'a str>,
    tags: &'a [TagFact],
}

impl SearchDocument for IndexDocument<'_> {
    fn path(&self) -> &VaultPath {
        &self.row.path
    }

    fn kind(&self) -> DocumentKind {
        self.row.kind
    }

    fn text(&self) -> Option<&str> {
        self.text
    }

    fn tags(&self) -> &[TagFact] {
        self.tags
    }
}

impl IndexReader {
    /// Every file `query` matches, sorted, at the published generation.
    ///
    /// Only the pin runs under the publication guard (the eighth shape in
    /// `reader.rs`); the scan runs with no lock held, so a publication or
    /// another read never waits for it, and the answer is the generation it
    /// pinned. A refusal because the generation moved is asked again with
    /// backoff for up to [`SEARCH_BUDGET`].
    pub fn search(&self, query: &SearchQuery<'_>) -> Result<SearchAnswer, IndexError> {
        self.search_with(query, true)
    }

    /// [`Self::search`] without the metadata narrowing: every file is
    /// evaluated, every note with its text when the query reads text.
    /// Test-only: the property test pins narrowing to this answer.
    #[doc(hidden)]
    pub fn search_unnarrowed_for_test(
        &self,
        query: &SearchQuery<'_>,
    ) -> Result<SearchAnswer, IndexError> {
        self.search_with(query, false)
    }

    fn search_with(
        &self,
        query: &SearchQuery<'_>,
        narrow: bool,
    ) -> Result<SearchAnswer, IndexError> {
        let deadline = Instant::now() + SEARCH_BUDGET;
        let mut pause = SEARCH_BACKOFF;
        loop {
            match self.evaluation_read_current(|_| ()) {
                Ok((read, ())) => return scan(&read, query, narrow),
                Err(error @ IndexError::LiveStateStale(_)) => {
                    if Instant::now() + pause > deadline {
                        return Err(error);
                    }
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(SEARCH_BACKOFF_MAX);
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// One context per requested span, in request order, read at `generation`.
    ///
    /// Refused with `GenerationMismatch` when `generation` is no longer the
    /// published one. A path with no note row at that generation answers an
    /// empty list: a page's notes are the answer's own, so that is a defect
    /// the caller reports, not a refusal here.
    pub fn match_contexts(
        &self,
        generation: Generation,
        wanted: &[(VaultPath, Vec<Range<usize>>)],
    ) -> Result<Vec<Vec<MatchContext>>, IndexError> {
        self.read(|transaction, current| {
            if current != generation {
                return Err(IndexError::GenerationMismatch {
                    cursor: generation.get(),
                    current: current.get(),
                });
            }
            let mut statement =
                transaction.prepare("SELECT source_bytes FROM notes WHERE path = ?1")?;
            let mut contexts = Vec::with_capacity(wanted.len());
            for (path, spans) in wanted {
                let source: Option<Vec<u8>> = statement
                    .query_row(params![path.as_str()], |row| row.get(0))
                    .optional()?;
                let Some(source) = source else {
                    contexts.push(Vec::new());
                    continue;
                };
                let text = utf8(&source, path)?;
                let lines = LineIndex::new(text);
                let mut cut = Vec::with_capacity(spans.len());
                for span in spans {
                    cut.push(line_context(text, &lines, span, path)?);
                }
                contexts.push(cut);
            }
            Ok(contexts)
        })
    }
}

/// The scan proper, outside every lock, on the pinned connection.
fn scan(
    read: &EvaluationRead<'_>,
    query: &SearchQuery<'_>,
    narrow: bool,
) -> Result<SearchAnswer, IndexError> {
    let compiled = query.compiled;
    let mut answer = SearchAnswer {
        generation: read.generation,
        hits: Vec::new(),
        texts_read: 0,
    };
    if compiled.is_empty() {
        return Ok(answer);
    }
    let connection = read.connection();
    let needs = compiled.needs();
    let rows = file_rows(connection)?;
    let tags = if needs.tags {
        tag_rows(connection)?
    } else {
        HashMap::new()
    };
    let tags_of = |row: &FileRow| -> &[TagFact] {
        tags.get(row.path.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default()
    };

    let kept: Vec<&FileRow> = rows
        .iter()
        .filter(|row| {
            !narrow
                || compiled.prefilter(&IndexDocument {
                    row,
                    text: None,
                    tags: tags_of(row),
                })
        })
        .collect();

    let mut decide = |row: &FileRow, text: Option<&str>| {
        let doc = IndexDocument {
            row,
            text,
            tags: tags_of(row),
        };
        if let Some(hit) = evaluate(compiled, &doc) {
            answer.hits.push(hit);
        }
    };

    if !needs.text {
        for row in &kept {
            decide(row, None);
        }
    } else {
        let notes_total = rows
            .iter()
            .filter(|row| row.kind == DocumentKind::Note)
            .count();
        let mut kept_notes: Vec<&FileRow> = Vec::new();
        for row in &kept {
            match row.kind {
                DocumentKind::Note => kept_notes.push(row),
                _ => decide(row, None),
            }
        }
        let mut texts_read = 0;
        if kept_notes.len() * 4 < notes_total {
            let mut statement =
                connection.prepare("SELECT source_bytes FROM notes WHERE path = ?1")?;
            for row in kept_notes {
                let mut found = statement.query(params![row.path.as_str()])?;
                match found.next()? {
                    Some(stored) => {
                        let text = utf8(blob(stored.get_ref(0)?, &row.path)?, &row.path)?;
                        texts_read += 1;
                        decide(row, Some(text));
                    }
                    // A note with no stored body (not UTF-8, diagnosed at
                    // reconcile): it matches by its path, never its content.
                    None => decide(row, Some("")),
                }
            }
        } else {
            let mut waiting: HashMap<&str, &FileRow> = kept_notes
                .iter()
                .map(|row| (row.path.as_str(), *row))
                .collect();
            // In storage order: the waiting map picks the kept notes, and the
            // sort's path tie-break makes the answer independent of it.
            let mut statement = connection.prepare("SELECT path, source_bytes FROM notes")?;
            let mut stored = statement.query([])?;
            while let Some(note) = stored.next()? {
                let path = note.get_ref(0)?.as_str().map_err(stored_path)?;
                let Some(row) = waiting.remove(path) else {
                    continue;
                };
                let text = utf8(blob(note.get_ref(1)?, &row.path)?, &row.path)?;
                texts_read += 1;
                decide(row, Some(text));
            }
            // The kept notes the pass did not meet have no stored body.
            for row in waiting.into_values() {
                decide(row, Some(""));
            }
        }
        answer.texts_read = texts_read;
    }

    let times: HashMap<&str, Times> = rows
        .iter()
        .map(|row| (row.path.as_str(), row.times))
        .collect();
    sort_hits(&mut answer.hits, query.sort, &|path| {
        times.get(path.as_str()).copied().unwrap_or_default()
    });
    Ok(answer)
}

/// Every note and file row of the tree, in path order. A canvas is a `file`
/// row: canvas content is out of this phase (Ruling 4, issue #3).
fn file_rows(connection: &rusqlite::Connection) -> Result<Vec<FileRow>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT path, kind, mtime_unix_ms, ctime_unix_ms FROM tree_entries \
         WHERE kind IN ('note','file') ORDER BY path",
    )?;
    let raw = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|(path, kind, mtime_ms, ctime_ms)| {
            let kind = match kind.as_str() {
                "note" => DocumentKind::Note,
                "file" => DocumentKind::File,
                other => {
                    return Err(IndexError::IncompatibleIndex(format!(
                        "unknown tree entry kind {other:?}"
                    )));
                }
            };
            Ok(FileRow {
                path: codec::decode_path(&path)?,
                kind,
                times: Times { mtime_ms, ctime_ms },
            })
        })
        .collect()
}

/// Every tag row, grouped by note in ordinal order.
fn tag_rows(
    connection: &rusqlite::Connection,
) -> Result<HashMap<String, Vec<TagFact>>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT note_path, value, span_start, span_end FROM tags ORDER BY note_path, ordinal",
    )?;
    let raw = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut tags: HashMap<String, Vec<TagFact>> = HashMap::new();
    for (path, value, start, end) in raw {
        let offset = |value: i64| {
            usize::try_from(value)
                .map_err(|_| IndexError::IncompatibleIndex(format!("negative tag span in {path}")))
        };
        let span = offset(start)?..offset(end)?;
        tags.entry(path.clone())
            .or_default()
            .push(TagFact { value, span });
    }
    Ok(tags)
}

/// A stored source as the borrowed blob it is stored as.
fn blob<'a>(value: ValueRef<'a>, path: &VaultPath) -> Result<&'a [u8], IndexError> {
    value.as_blob().map_err(|error| {
        IndexError::Storage(format!(
            "the stored source of {} is not a blob: {error}",
            path.as_str()
        ))
    })
}

fn stored_path(error: FromSqlError) -> IndexError {
    IndexError::Storage(format!("a stored note path is not text: {error}"))
}

/// A stored source as text. The index stores only UTF-8 sources, so a
/// failure is damage, reported with the path, never a panic.
fn utf8<'a>(source: &'a [u8], path: &VaultPath) -> Result<&'a str, IndexError> {
    std::str::from_utf8(source).map_err(|error| {
        IndexError::Storage(format!(
            "the stored source of {} is not UTF-8: {error}",
            path.as_str()
        ))
    })
}

/// The line holding `span.start`, whole when it fits in
/// [`MAX_LINE_TEXT_BYTES`]; otherwise a window of that many bytes starting
/// `(MAX_LINE_TEXT_BYTES - span_len) / 2` bytes before the match (never
/// before the line start, and at the match when the match is longer), its
/// start moved forward and its end moved back to character boundaries.
fn line_context(
    text: &str,
    lines: &LineIndex<'_>,
    span: &Range<usize>,
    path: &VaultPath,
) -> Result<MatchContext, IndexError> {
    if span.start > text.len() || !text.is_char_boundary(span.start) {
        return Err(IndexError::Storage(format!(
            "span {span:?} is not a character boundary of {}",
            path.as_str()
        )));
    }
    let line = lines.line_range(span.start);
    if line.len() <= MAX_LINE_TEXT_BYTES {
        return Ok(MatchContext {
            line_text: text[line.clone()].to_owned(),
            line_text_start: line.start,
        });
    }
    let span_len = span.end.min(line.end).saturating_sub(span.start);
    let lead = MAX_LINE_TEXT_BYTES.saturating_sub(span_len) / 2;
    let mut start = span.start.saturating_sub(lead).max(line.start);
    let mut end = (start + MAX_LINE_TEXT_BYTES).min(line.end);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(MatchContext {
        line_text: text[start..end].to_owned(),
        line_text_start: start,
    })
}
