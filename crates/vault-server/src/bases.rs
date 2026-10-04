//! `evaluate_base` and `list_bases`.
//!
//! A view's result is computed once per (base, view, `this_path`,
//! generation) and its pages are cut from that one computation, so a page
//! never disagrees with its neighbour about `now()` or `random()`. The store
//! holds one generation's results at most: the first request at a new
//! generation drops the rest. Task 12 bounds it by entry count.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use vault_bases::view::CompileError;
use vault_core::VaultPath;
use vault_index::{BaseAnswer, BaseQuery, BaseQueryError, BaseStatus, IndexError, IndexReader};
use vault_protocol::{
    BaseStatusDto, BaseSummaryDto, ColumnDto, ErrorCode, EvaluateBaseParams, EvaluateBaseResponse,
    ListBasesParams, OptionEntryDto, PageResponse, ProtocolError, RowDto, RowKindDto, ViewDto,
};

use crate::convert;

/// How many evaluated views the per-generation store keeps. Task 12 makes
/// it a knob and enforces it.
#[allow(dead_code)]
pub const DEFAULT_BASE_CACHE_ENTRIES: usize = 64;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CacheKey {
    pub base: VaultPath,
    pub view: Option<String>,
    pub this_path: Option<VaultPath>,
    pub generation: u64,
}

/// One evaluation, with the clock it ran under so every page renders its
/// dates in the same zone.
pub(crate) struct Cached {
    pub answer: BaseAnswer,
    pub clock: vault_bases::Clock,
}

/// One generation's evaluated views.
#[derive(Default)]
pub(crate) struct BaseCache {
    entries: Mutex<HashMap<CacheKey, Arc<Cached>>>,
}

impl BaseCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<CacheKey, Arc<Cached>>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn get(&self, key: &CacheKey) -> Option<Arc<Cached>> {
        let mut entries = self.lock();
        entries.retain(|have, _| have.generation == key.generation);
        entries.get(key).cloned()
    }

    pub(crate) fn put(&self, key: CacheKey, value: Arc<Cached>) {
        let mut entries = self.lock();
        entries.retain(|have, _| have.generation == key.generation);
        entries.insert(key, value);
    }
}

fn error(code: ErrorCode, message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code,
        message: message.into(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    }
}

/// An `evaluate_base` cursor: the generation, the base, the view, the
/// `this_path` and the row position, as the spec names them.
#[derive(serde::Serialize, serde::Deserialize)]
struct Cursor {
    generation: u64,
    base: String,
    view: Option<String>,
    this_path: Option<String>,
    offset: usize,
}

/// The refusals a page meets, worded exactly as every other pager's.
fn invalid_cursor(message: String) -> ProtocolError {
    convert::index_error(IndexError::InvalidCursor(message))
}

fn generation_mismatch(cursor: u64, current: u64) -> ProtocolError {
    convert::index_error(IndexError::GenerationMismatch { cursor, current })
}

fn decode(cursor: &str) -> Result<Cursor, ProtocolError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|failure| invalid_cursor(format!("invalid encoding: {failure}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|failure| invalid_cursor(format!("invalid payload: {failure}")))
}

fn encode(cursor: &Cursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect("a cursor serializes"))
}

/// Every refusal an evaluation can meet, with its wire code.
pub(crate) fn query_error(value: BaseQueryError) -> ProtocolError {
    match value {
        BaseQueryError::Index(index) => convert::index_error(index),
        BaseQueryError::NotFound(path) => {
            error(ErrorCode::NotFound, format!("no base at {}", path.as_str()))
        }
        BaseQueryError::Invalid(parse) => error(
            ErrorCode::BaseInvalid,
            match parse.span {
                Some(span) => format!(
                    "the base failed to parse at byte {}: {}",
                    span.start(),
                    parse.message
                ),
                None => format!("the base failed to parse: {}", parse.message),
            },
        ),
        BaseQueryError::Compile(CompileError::ViewNotFound { declared }) => error(
            ErrorCode::ViewNotFound,
            format!("no such view; declared views: {}", declared.join(", ")),
        ),
        BaseQueryError::Compile(CompileError::ExpressionInvalid {
            expression,
            message,
            position,
        }) => error(
            ErrorCode::ExpressionInvalid,
            format!("expression {expression:?} is invalid at position {position}: {message}"),
        ),
        BaseQueryError::Compile(CompileError::UnsupportedFunction { name }) => error(
            ErrorCode::UnsupportedFunction,
            format!("unsupported function {name}"),
        ),
        BaseQueryError::ThisPath(message) => error(ErrorCode::InvalidRequest, message),
    }
}

/// The protocol's page rule: default 100, from 1 to 1000, `invalid_cursor`
/// outside it.
fn limit(limit: Option<u32>) -> Result<usize, ProtocolError> {
    let limit = limit.unwrap_or(vault_index::DEFAULT_PAGE_LIMIT);
    if limit == 0 || limit > vault_index::MAX_PAGE_LIMIT {
        return Err(invalid_cursor(format!(
            "limit must be between 1 and {}",
            vault_index::MAX_PAGE_LIMIT
        )));
    }
    Ok(limit as usize)
}

pub(crate) fn evaluate_base(
    reader: &IndexReader,
    cache: &BaseCache,
    types: impl FnOnce() -> BTreeMap<String, vault_bases::PropertyType>,
    params: EvaluateBaseParams,
) -> Result<EvaluateBaseResponse, ProtocolError> {
    let limit = limit(params.limit)?;
    let path = crate::parse_path(&params.path)?;
    let this_path = params
        .this_path
        .as_deref()
        .map(crate::parse_path)
        .transpose()?;
    let current = reader
        .published_status()
        .map_err(convert::index_error)?
        .generation
        .ok_or_else(|| convert::index_error(vault_index::IndexError::IndexUnavailable))?
        .get();

    let offset = match &params.cursor {
        None => 0,
        Some(cursor) => {
            let cursor = decode(cursor)?;
            if cursor.base != params.path
                || cursor.view != params.view
                || cursor.this_path != params.this_path
            {
                return Err(invalid_cursor(
                    "the cursor belongs to another base, view or this_path".into(),
                ));
            }
            if cursor.generation != current {
                return Err(generation_mismatch(cursor.generation, current));
            }
            cursor.offset
        }
    };

    let key = CacheKey {
        base: path.clone(),
        view: params.view.clone(),
        this_path: this_path.clone(),
        generation: current,
    };
    let cached = match cache.get(&key) {
        Some(hit) => hit,
        None => {
            let clock = vault_bases::Clock::system();
            let types = types();
            let answer = reader
                .evaluate_base(
                    &BaseQuery {
                        path: &path,
                        view: params.view.as_deref(),
                        this_path: this_path.as_ref(),
                        types: &types,
                    },
                    &clock,
                )
                .map_err(query_error)?;
            let entry = Arc::new(Cached { answer, clock });
            // Keyed by the generation the answer was computed at, which a
            // publication between the status read and the evaluation moves.
            let key = CacheKey {
                generation: entry.answer.generation.get(),
                ..key
            };
            cache.put(key, Arc::clone(&entry));
            entry
        }
    };
    let answer = &cached.answer;
    let generation = answer.generation.get();
    if params.cursor.is_some() && generation != current {
        // The cursor matched `current`, but the evaluation ran at a newer
        // generation: its offset would index another generation's rows.
        return Err(generation_mismatch(current, generation));
    }
    let clock = &cached.clock;
    let rows = &answer.result.rows;
    let page: Vec<RowDto> = rows
        .iter()
        .skip(offset)
        .take(limit)
        .map(|row| RowDto {
            path: row.path.as_str().to_string(),
            kind: match row.kind {
                vault_bases::FileKind::Note => RowKindDto::Note,
                vault_bases::FileKind::File => RowKindDto::File,
            },
            group: row.group.as_ref().map(|group| convert::cell(group, clock)),
            cells: row
                .cells
                .iter()
                .map(|cell| convert::cell(cell, clock))
                .collect(),
        })
        .collect();
    let next = offset + page.len();
    Ok(EvaluateBaseResponse {
        generation,
        view: ViewDto {
            kind: answer.view.kind.clone(),
            name: answer.view.name.clone(),
            options: option_entries(&answer.view.options),
        },
        columns: answer
            .columns
            .iter()
            .map(|column| ColumnDto {
                property: column.property.clone(),
                display_name: column.display_name.clone(),
                settings: option_entries(&column.settings),
            })
            .collect(),
        rows: page,
        summaries: answer
            .result
            .summaries
            .iter()
            .map(|summary| {
                (
                    summary.property.clone(),
                    convert::cell(&summary.value, clock),
                )
            })
            .collect(),
        total_rows: rows.len() as u64,
        next_cursor: (next < rows.len()).then(|| {
            encode(&Cursor {
                generation,
                base: params.path.clone(),
                view: params.view.clone(),
                this_path: params.this_path.clone(),
                offset: next,
            })
        }),
    })
}

/// Declared key-value pairs as ordered entries, each value in the existing
/// property DTO's shape.
fn option_entries(entries: &[(String, vault_core::PropertyValue)]) -> Vec<OptionEntryDto> {
    entries
        .iter()
        .map(|(key, value)| OptionEntryDto {
            key: key.clone(),
            value: convert::property_value(value),
        })
        .collect()
}

pub(crate) fn list_bases(
    reader: &IndexReader,
    params: ListBasesParams,
) -> Result<PageResponse<BaseSummaryDto>, ProtocolError> {
    let page = reader
        .list_bases(params.cursor.as_deref(), params.limit)
        .map_err(convert::index_error)?;
    Ok(PageResponse {
        generation: page.generation.get(),
        items: page
            .items
            .into_iter()
            .map(|item| BaseSummaryDto {
                path: item.path.as_str().to_string(),
                status: match item.status {
                    BaseStatus::Parsed => BaseStatusDto::Parsed,
                    BaseStatus::ParseFailed(parse) => BaseStatusDto::ParseFailed {
                        message: parse.message,
                        span: parse.span.map(convert::span),
                    },
                },
                views: item.views,
            })
            .collect(),
        next_cursor: page.next_cursor,
    })
}
