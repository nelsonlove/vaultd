//! `evaluate_base` and `list_bases`.
//!
//! A view's result is computed once per (base, view, `this_path`,
//! generation) and its pages are cut from that one computation, so a page
//! never disagrees with its neighbour about `now()` or `random()`. The store
//! is a least-recently-used cache of at most `--bases-cache-entries`
//! results, and the first request at a newer generation drops every older
//! one. A cursor carries the instant its result was computed at, so a page
//! whose result was evicted is recomputed at that same instant (the same
//! `now()`, and the same `random()` sequence, which is seeded from it).

use std::collections::{BTreeMap, HashMap, VecDeque};
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
use crate::views::ViewTracker;

/// How many evaluated views the cache keeps by default
/// (`--bases-cache-entries`).
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

/// The entries and their use order, least recently used first.
#[derive(Default)]
struct Entries {
    values: HashMap<CacheKey, Arc<Cached>>,
    order: VecDeque<CacheKey>,
}

impl Entries {
    /// Drop every entry of a generation older than `generation`. A newer
    /// one stays: a request racing a commit may still carry the older
    /// current generation for an instant, and must not evict an answer
    /// another connection already computed at the newer one.
    fn drop_older(&mut self, generation: u64) {
        self.values.retain(|have, _| have.generation >= generation);
        self.order.retain(|have| have.generation >= generation);
    }

    fn touch(&mut self, key: &CacheKey) {
        self.order.retain(|have| have != key);
        self.order.push_back(key.clone());
    }
}

/// Evaluated views, bounded least-recently-used, at the newest generation
/// asked for.
pub(crate) struct BaseCache {
    capacity: usize,
    entries: Mutex<Entries>,
    /// How many evaluations this cache could not answer. Test-only.
    #[cfg(test)]
    misses: std::sync::atomic::AtomicUsize,
}

impl Default for BaseCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_BASE_CACHE_ENTRIES)
    }
}

impl BaseCache {
    /// A cache of at most `capacity` results (at least one).
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: Mutex::new(Entries::default()),
            #[cfg(test)]
            misses: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Entries> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn get(&self, key: &CacheKey) -> Option<Arc<Cached>> {
        let mut entries = self.lock();
        entries.drop_older(key.generation);
        let hit = entries.values.get(key).cloned()?;
        entries.touch(key);
        Some(hit)
    }

    pub(crate) fn put(&self, key: CacheKey, value: Arc<Cached>) {
        let mut entries = self.lock();
        entries.drop_older(key.generation);
        entries.touch(&key);
        entries.values.insert(key, value);
        while entries.values.len() > self.capacity {
            match entries.order.pop_front() {
                Some(oldest) => {
                    entries.values.remove(&oldest);
                }
                None => break,
            }
        }
    }

    /// How many results the cache holds. Test-only.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().values.len()
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
    /// The instant (milliseconds) the result was computed at: a page whose
    /// result left the cache is recomputed at it.
    instant: i64,
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
    tracker: &ViewTracker,
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

    let (offset, instant) = match &params.cursor {
        None => (0, None),
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
            (cursor.offset, Some(cursor.instant))
        }
    };

    let key = CacheKey {
        base: path.clone(),
        view: params.view.clone(),
        this_path: this_path.clone(),
        generation: current,
    };
    // A page is cut only from a result computed at its cursor's instant.
    let hit = cache
        .get(&key)
        .filter(|hit| instant.is_none_or(|at| hit.clock.now_ms == at));
    let cached = match hit {
        Some(hit) => hit,
        None => {
            #[cfg(test)]
            cache
                .misses
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut clock = vault_bases::Clock::system();
            if let Some(at) = instant {
                clock.now_ms = at;
            }
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
            tracker.record(
                &path,
                &entry.answer.view.name,
                entry.answer.generation.get(),
                entry.answer.result.rows.iter().map(|row| row.path.clone()),
            );
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
                instant: clock.now_ms,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(base: &str, generation: u64) -> CacheKey {
        CacheKey {
            base: VaultPath::new(base).unwrap(),
            view: None,
            this_path: None,
            generation,
        }
    }

    fn entry() -> Arc<Cached> {
        Arc::new(Cached {
            answer: BaseAnswer {
                generation: vault_index::Generation::new(1),
                view: vault_bases::parse_base("views:\n  - type: table\n    name: T\n")
                    .unwrap()
                    .views
                    .remove(0),
                columns: Vec::new(),
                result: vault_bases::view::ViewResult {
                    rows: Vec::new(),
                    summaries: Vec::new(),
                    total_rows: 0,
                },
                dependencies: Default::default(),
            },
            clock: vault_bases::Clock::fixed(0, "UTC"),
        })
    }

    #[test]
    fn the_cache_is_bounded_least_recently_used_first() {
        let cache = BaseCache::with_capacity(2);
        cache.put(key("A.base", 1), entry());
        cache.put(key("B.base", 1), entry());
        assert!(cache.get(&key("A.base", 1)).is_some(), "touch A");
        cache.put(key("C.base", 1), entry());
        assert!(
            cache.get(&key("B.base", 1)).is_none(),
            "B was the least recently used"
        );
        assert!(cache.get(&key("A.base", 1)).is_some());
        assert!(cache.get(&key("C.base", 1)).is_some());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn a_newer_generation_drops_every_older_entry() {
        let cache = BaseCache::with_capacity(8);
        cache.put(key("A.base", 1), entry());
        assert!(cache.get(&key("A.base", 2)).is_none());
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn an_older_request_never_evicts_a_newer_answer() {
        let cache = BaseCache::with_capacity(8);
        cache.put(key("A.base", 2), entry());
        assert!(cache.get(&key("A.base", 1)).is_none());
        assert!(cache.get(&key("A.base", 2)).is_some());
    }

    #[test]
    fn a_capacity_below_one_is_one() {
        let cache = BaseCache::with_capacity(0);
        cache.put(key("A.base", 1), entry());
        cache.put(key("B.base", 1), entry());
        assert_eq!(cache.len(), 1);
    }

    /// A scratch directory under the workspace's `target/tmp`, never the
    /// system temporary directory.
    fn scratch() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::TempDir::new_in(root.canonicalize().unwrap()).unwrap()
    }

    struct Fixture {
        vault: tempfile::TempDir,
        _index: tempfile::TempDir,
        service: vault_index::IndexService,
        reader: IndexReader,
        cache: BaseCache,
        tracker: ViewTracker,
    }

    fn fixture(capacity: usize) -> Fixture {
        let vault = scratch();
        let index = scratch();
        for (path, body) in [
            ("A.md", "---\nn: 1\n---\n"),
            ("B.md", "---\nn: 2\n---\n"),
            ("C.md", "---\nn: 3\n---\n"),
            (
                "R.base",
                "formulas:\n  r: 'random()'\nviews:\n  - type: table\n    name: T\n    order: [formula.r, n]\n    sort:\n      - property: formula.r\n        direction: ASC\n  - type: table\n    name: U\n",
            ),
        ] {
            std::fs::write(vault.path().join(path), body).unwrap();
        }
        let config =
            vault_index::IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
                .unwrap();
        let mut service = vault_index::IndexService::open(config).unwrap();
        service.refresh(false).unwrap();
        let reader = service.reader().unwrap();
        Fixture {
            vault,
            _index: index,
            service,
            reader,
            cache: BaseCache::with_capacity(capacity),
            tracker: ViewTracker::default(),
        }
    }

    impl Fixture {
        fn ask(
            &self,
            view: Option<&str>,
            cursor: Option<String>,
            limit: Option<u32>,
        ) -> Result<EvaluateBaseResponse, ProtocolError> {
            evaluate_base(
                &self.reader,
                &self.cache,
                &self.tracker,
                BTreeMap::new,
                EvaluateBaseParams {
                    path: "R.base".into(),
                    view: view.map(str::to_string),
                    this_path: None,
                    cursor,
                    limit,
                },
            )
        }

        fn misses(&self) -> usize {
            self.cache.misses.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn publish(&mut self, name: &str) {
            std::fs::write(self.vault.path().join(name), "x\n").unwrap();
            self.service
                .refresh_paths(
                    [VaultPath::new(name).unwrap()].into(),
                    vault_index::ChangeCause::Watcher,
                )
                .unwrap();
        }
    }

    #[test]
    fn a_repeated_request_is_answered_from_the_cache_and_a_new_generation_recomputes() {
        let mut fixture = fixture(DEFAULT_BASE_CACHE_ENTRIES);
        let first = fixture.ask(None, None, None).unwrap();
        let second = fixture.ask(None, None, None).unwrap();
        assert_eq!(fixture.misses(), 1, "the second request was a hit");
        assert_eq!(first, second);

        fixture.publish("D.md");
        let third = fixture.ask(None, None, None).unwrap();
        assert_eq!(third.generation, first.generation + 1);
        assert_eq!(fixture.misses(), 2, "a new generation recomputes");
        assert_eq!(fixture.cache.len(), 1, "and the older answer is gone");
    }

    /// The Task 11 carry: a page whose result was evicted is recomputed at
    /// the instant its cursor names, so `random()` (seeded from it) orders
    /// the rows exactly as it did for the first page.
    #[test]
    fn an_evicted_page_is_recomputed_at_its_cursors_instant() {
        let fixture = fixture(1);
        let first = fixture.ask(Some("T"), None, Some(1)).unwrap();
        let whole = fixture.ask(Some("T"), None, None).unwrap();
        assert_eq!(fixture.misses(), 1);
        // Evict T's result with another view's, and let the clock move.
        fixture.ask(Some("U"), None, None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = fixture
            .ask(Some("T"), first.next_cursor.clone(), Some(1))
            .unwrap();
        assert_eq!(fixture.misses(), 3, "the page was recomputed");
        assert_eq!(first.rows[0], whole.rows[0]);
        assert_eq!(
            second.rows[0], whole.rows[1],
            "the recomputed page continues the first page's ordering"
        );
        let third = fixture.ask(Some("T"), second.next_cursor, Some(1)).unwrap();
        assert_eq!(third.rows[0], whole.rows[2]);
    }

    /// The Task 11 re-review carry, at the server: an evaluation that errors
    /// and a page refused `generation_mismatch` leave the reader's pool of
    /// evaluation connections as they found it.
    #[test]
    fn the_reader_pool_is_restored_after_an_error_and_a_generation_mismatch() {
        let mut fixture = fixture(DEFAULT_BASE_CACHE_ENTRIES);
        let page = fixture.ask(Some("T"), None, Some(1)).unwrap();
        let idle = fixture.reader.evaluation_pool_len_for_test();
        assert_eq!(idle, 1);

        let error = fixture.ask(Some("Nope"), None, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::ViewNotFound);
        assert_eq!(fixture.reader.evaluation_pool_len_for_test(), idle);

        fixture.publish("D.md");
        let error = fixture
            .ask(Some("T"), page.next_cursor, Some(1))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::GenerationMismatch);
        assert_eq!(fixture.reader.evaluation_pool_len_for_test(), idle);
        fixture.ask(Some("T"), None, None).unwrap();
        assert_eq!(fixture.reader.evaluation_pool_len_for_test(), idle);
    }
}
