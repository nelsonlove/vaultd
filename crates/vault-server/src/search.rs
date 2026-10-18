//! `search`.
//!
//! A query's answer is computed once per (canonical query, `match_case`,
//! sort, generation) and its pages are cut from that one computation. The
//! store is a least-recently-used cache of at most `--search-cache-entries`
//! answers, and the first request at a newer generation drops every older
//! one, as the Bases cache does. `context` changes only what a page renders,
//! so it is not in the key. A cursor binds the generation, the canonical
//! query, the toggle, the sort and the next file position: a cursor
//! presented with other parameters is `invalid_cursor`, one from an older
//! generation `generation_mismatch`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use vault_index::{IndexReader, SearchAnswer, SearchQuery};
use vault_protocol::{
    ErrorCode, ProtocolError, SearchContextDto, SearchParams, SearchResponse, SearchSortDto,
};
use vault_search::{CompileError, CompiledQuery, SortOrder, compile, parse_query};

use crate::convert;
use crate::paging::{self, generation_mismatch, invalid_cursor};

/// How many answers the cache keeps by default (`--search-cache-entries`).
pub const DEFAULT_SEARCH_CACHE_ENTRIES: usize = 16;

/// An answer whose hits, content matches and path matches together number
/// more than this is not cached; each of its pages is computed again.
pub const MAX_STORED_MATCHES: usize = 200_000;

/// What one answer is computed for. Task 15 adds the exclusion epoch.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CacheKey {
    canonical: String,
    match_case: bool,
    sort: SortOrder,
    generation: u64,
}

impl CacheKey {
    fn new(compiled: &CompiledQuery, sort: SortOrder, generation: u64) -> Self {
        Self {
            canonical: compiled.canonical().to_string(),
            match_case: compiled.match_case(),
            sort,
            generation,
        }
    }
}

/// The entries and their use order, least recently used first.
#[derive(Default)]
struct Entries {
    values: HashMap<CacheKey, Arc<SearchAnswer>>,
    order: VecDeque<CacheKey>,
}

impl Entries {
    /// Drop every entry of a generation older than `generation`; a newer one
    /// stays, as in the Bases cache.
    fn drop_older(&mut self, generation: u64) {
        self.values.retain(|have, _| have.generation >= generation);
        self.order.retain(|have| have.generation >= generation);
    }

    fn touch(&mut self, key: &CacheKey) {
        self.order.retain(|have| have != key);
        self.order.push_back(key.clone());
    }
}

/// Search answers, bounded least-recently-used, at the newest generation
/// asked for.
pub(crate) struct SearchCache {
    capacity: usize,
    entries: Mutex<Entries>,
    /// Run once, on the next cached answer, after the cache answered and
    /// before its page's contexts are pinned. Test-only: it lands a
    /// publication in that window.
    #[cfg(test)]
    before_contexts: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Default for SearchCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_SEARCH_CACHE_ENTRIES)
    }
}

/// What an answer weighs against [`MAX_STORED_MATCHES`]: one per hit, per
/// content match and per path match, so an answer of many files with no
/// content matches is bounded too.
fn stored_weight(answer: &SearchAnswer) -> usize {
    answer
        .hits
        .iter()
        .map(|hit| 1 + hit.content_matches.len() + hit.path_matches.len())
        .sum()
}

impl SearchCache {
    /// A cache of at most `capacity` answers (at least one).
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: Mutex::new(Entries::default()),
            #[cfg(test)]
            before_contexts: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn before_contexts_for_test(&self, hook: Box<dyn FnOnce() + Send>) {
        *self
            .before_contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Entries> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn get(&self, key: &CacheKey) -> Option<Arc<SearchAnswer>> {
        let mut entries = self.lock();
        entries.drop_older(key.generation);
        let hit = entries.values.get(key).cloned()?;
        entries.touch(key);
        Some(hit)
    }

    /// Store `value` under `key`, unless its hits, content matches and path
    /// matches together number more than [`MAX_STORED_MATCHES`].
    pub(crate) fn put(&self, key: CacheKey, value: Arc<SearchAnswer>) {
        if stored_weight(&value) > MAX_STORED_MATCHES {
            return;
        }
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

    /// How many answers the cache holds. Test-only.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().values.len()
    }
}

/// A `search` cursor: the generation, the canonical query, the toggle, the
/// sort in its wire spelling, and the next file position.
#[derive(serde::Serialize, serde::Deserialize)]
struct Cursor {
    g: u64,
    q: String,
    c: bool,
    s: SearchSortDto,
    p: usize,
}

impl Cursor {
    /// Decode `cursor` and check it belongs to this query, toggle and sort.
    fn decode(
        cursor: &str,
        canonical: &str,
        match_case: bool,
        sort: SearchSortDto,
    ) -> Result<Self, ProtocolError> {
        let cursor: Self = paging::decode_cursor(cursor)?;
        if cursor.q != canonical || cursor.c != match_case || cursor.s != sort {
            return Err(invalid_cursor(
                "the cursor belongs to another query, match_case or sort".into(),
            ));
        }
        Ok(cursor)
    }

    fn encode(
        generation: u64,
        canonical: &str,
        match_case: bool,
        sort: SearchSortDto,
        position: usize,
    ) -> String {
        paging::encode_cursor(&Self {
            g: generation,
            q: canonical.to_string(),
            c: match_case,
            s: sort,
            p: position,
        })
    }
}

/// A query that does not parse or compile, with its wire code and the
/// character position.
pub(crate) fn query_error(error: &CompileError) -> ProtocolError {
    let (code, message, position) = match error {
        CompileError::Invalid(invalid) => (
            ErrorCode::QueryInvalid,
            invalid.message.clone(),
            invalid.position,
        ),
        // `what` names the construct, already quoted where it is an operator.
        CompileError::Unsupported { what, position } => (
            ErrorCode::UnsupportedOperator,
            format!("{what} is not supported by this build yet"),
            *position,
        ),
    };
    let mut refused = ProtocolError::new(code, message);
    refused.position = Some(u64::try_from(position).expect("a position fits u64"));
    refused
}

fn sort_order(sort: SearchSortDto) -> SortOrder {
    match sort {
        SearchSortDto::FileNameAsc => SortOrder::FileNameAsc,
        SearchSortDto::FileNameDesc => SortOrder::FileNameDesc,
        SearchSortDto::ModifiedDesc => SortOrder::ModifiedDesc,
        SearchSortDto::ModifiedAsc => SortOrder::ModifiedAsc,
        SearchSortDto::CreatedDesc => SortOrder::CreatedDesc,
        SearchSortDto::CreatedAsc => SortOrder::CreatedAsc,
    }
}

pub(crate) fn search(
    reader: &IndexReader,
    cache: &SearchCache,
    params: SearchParams,
) -> Result<SearchResponse, ProtocolError> {
    let limit = paging::page_limit(params.limit)?;
    let query = parse_query(&params.query).map_err(|e| query_error(&CompileError::Invalid(e)))?;
    let compiled = compile(&query, params.match_case).map_err(|e| query_error(&e))?;
    let sort = sort_order(params.sort);
    // A fresh request names no generation, so a publication that moves the
    // generation between its answer and its contexts is no reason to refuse
    // it: it is asked again, a bounded number of times. A miss reads the
    // contexts on the scan's own pin and cannot race; only a cached answer
    // whose generation moved before its contexts were pinned can, and the
    // next attempt then misses.
    let mut attempt = 1;
    loop {
        match page(reader, cache, &params, &compiled, sort, limit) {
            Err(refused)
                if params.cursor.is_none()
                    && refused.code == ErrorCode::GenerationMismatch
                    && attempt < FRESH_ATTEMPTS =>
            {
                attempt += 1;
            }
            answered => return answered,
        }
    }
}

/// How many times a fresh request is answered before a generation that
/// keeps moving under it is refused.
const FRESH_ATTEMPTS: usize = 3;

/// One attempt at a page: the cursor, the answer (cached or computed) and
/// the page cut from it.
fn page(
    reader: &IndexReader,
    cache: &SearchCache,
    params: &SearchParams,
    compiled: &CompiledQuery,
    sort: SortOrder,
    limit: usize,
) -> Result<SearchResponse, ProtocolError> {
    let current = reader
        .published_status()
        .map_err(convert::index_error)?
        .generation
        .ok_or_else(|| convert::index_error(vault_index::IndexError::IndexUnavailable))?
        .get();
    let start = match &params.cursor {
        None => 0,
        Some(cursor) => {
            let cursor = Cursor::decode(
                cursor,
                compiled.canonical(),
                compiled.match_case(),
                params.sort,
            )?;
            if cursor.g != current {
                return Err(generation_mismatch(cursor.g, current));
            }
            cursor.p
        }
    };

    let line = params.context == SearchContextDto::Line;
    // On a miss with `context: line`, the page's contexts come with the
    // answer, read on the scan's own pin.
    let (answer, mut contexts) = match cache.get(&CacheKey::new(compiled, sort, current)) {
        Some(answer) => (answer, None),
        None => {
            let query = SearchQuery { compiled, sort };
            let (answer, contexts) = if line {
                let (answer, contexts) = reader
                    .search_with_contexts(&query, start..start.saturating_add(limit))
                    .map_err(convert::index_error)?;
                (answer, Some(contexts))
            } else {
                (reader.search(&query).map_err(convert::index_error)?, None)
            };
            let answer = Arc::new(answer);
            let computed = answer.generation.get();
            // A page must come from its cursor's generation: a publication
            // between the status read and the pin moved it.
            if params.cursor.is_some() && computed != current {
                return Err(generation_mismatch(current, computed));
            }
            // Keyed by the generation the answer was computed at.
            cache.put(CacheKey::new(compiled, sort, computed), Arc::clone(&answer));
            (answer, contexts)
        }
    };
    if start > answer.hits.len() {
        return Err(invalid_cursor(format!(
            "the cursor's position {start} is past the answer's {} files",
            answer.hits.len()
        )));
    }

    let page: Vec<&vault_search::FileHit> = answer.hits.iter().skip(start).take(limit).collect();
    if line && contexts.is_none() {
        #[cfg(test)]
        {
            let hook = cache
                .before_contexts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let wanted: Vec<_> = page
            .iter()
            .map(|hit| {
                (
                    hit.path.clone(),
                    hit.content_matches
                        .iter()
                        .map(|found| found.span.clone())
                        .collect(),
                )
            })
            .collect();
        contexts = Some(
            reader
                .match_contexts(answer.generation, &wanted)
                .map_err(convert::index_error)?,
        );
    }
    let next = start + page.len();
    let generation = answer.generation.get();
    Ok(SearchResponse {
        generation,
        total_files: answer.hits.len() as u64,
        total_matches: answer.hits.iter().map(|hit| hit.total_matches as u64).sum(),
        items: page
            .iter()
            .enumerate()
            .map(|(at, hit)| {
                convert::search_hit(
                    hit,
                    contexts
                        .as_ref()
                        .map(|contexts| contexts.get(at).map_or(&[][..], Vec::as_slice)),
                )
            })
            .collect::<Result<Vec<_>, _>>()?,
        next_cursor: (next < answer.hits.len()).then(|| {
            Cursor::encode(
                generation,
                compiled.canonical(),
                compiled.match_case(),
                params.sort,
                next,
            )
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::VaultPath;
    use vault_index::{Generation, MatchContext};
    use vault_search::text::Loc;
    use vault_search::{ContentMatch, DocumentKind, FileHit};

    fn key(canonical: &str, generation: u64) -> CacheKey {
        CacheKey {
            canonical: canonical.to_string(),
            match_case: false,
            sort: SortOrder::FileNameAsc,
            generation,
        }
    }

    fn content_match(start: usize) -> ContentMatch {
        let at = |offset| Loc {
            line: 0,
            col: offset,
            offset,
        };
        ContentMatch {
            span: start..start + 1,
            start: at(start),
            end: at(start + 1),
        }
    }

    fn hit(path: &str, matches: usize) -> FileHit {
        FileHit {
            path: VaultPath::new(path).unwrap(),
            kind: DocumentKind::Note,
            path_matches: Vec::new(),
            content_matches: (0..matches).map(content_match).collect(),
            total_matches: matches,
            matches_truncated: false,
        }
    }

    fn answer(generation: u64, hits: Vec<FileHit>) -> Arc<SearchAnswer> {
        Arc::new(SearchAnswer {
            generation: Generation::new(generation),
            hits,
            texts_read: 0,
            tag_rows_read: 0,
        })
    }

    #[test]
    fn the_cache_hits_at_one_generation_and_misses_at_the_next() {
        let cache = SearchCache::with_capacity(8);
        cache.put(key("a", 3), answer(3, Vec::new()));
        cache.put(key("b", 3), answer(3, Vec::new()));
        assert!(cache.get(&key("a", 3)).is_some(), "a hit at generation 3");
        cache.put(key("a", 4), answer(4, Vec::new()));
        assert_eq!(cache.len(), 1, "the put at 4 dropped every entry of 3");
        assert!(cache.get(&key("b", 3)).is_none());
        assert!(cache.get(&key("a", 4)).is_some());
    }

    #[test]
    fn the_least_recently_used_entry_is_evicted() {
        let cache = SearchCache::with_capacity(2);
        cache.put(key("a", 1), answer(1, Vec::new()));
        cache.put(key("b", 1), answer(1, Vec::new()));
        assert!(cache.get(&key("a", 1)).is_some(), "touch a");
        cache.put(key("c", 1), answer(1, Vec::new()));
        assert!(
            cache.get(&key("b", 1)).is_none(),
            "b was the least recently used"
        );
        assert!(cache.get(&key("a", 1)).is_some());
        assert!(cache.get(&key("c", 1)).is_some());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn an_answer_over_the_stored_match_bound_is_not_stored() {
        let cache = SearchCache::with_capacity(8);
        cache.put(
            key("big", 1),
            answer(1, vec![hit("a.md", MAX_STORED_MATCHES), hit("b.md", 1)]),
        );
        assert!(cache.get(&key("big", 1)).is_none());
        assert_eq!(cache.len(), 0);
        // One hit and its matches weigh one each: exactly the bound is stored.
        cache.put(
            key("bound", 1),
            answer(1, vec![hit("a.md", MAX_STORED_MATCHES - 1)]),
        );
        assert!(
            cache.get(&key("bound", 1)).is_some(),
            "exactly the bound is stored"
        );
    }

    /// The fix round's M1: hits and path matches weigh against the bound as
    /// content matches do, so a `file:` query over a huge vault is not
    /// stored for having no content matches.
    #[test]
    fn hits_and_path_matches_weigh_against_the_stored_bound() {
        let cache = SearchCache::with_capacity(8);
        let many: Vec<FileHit> = (0..=MAX_STORED_MATCHES)
            .map(|at| hit(&format!("{at}.png"), 0))
            .collect();
        cache.put(key("files", 1), answer(1, many));
        assert_eq!(cache.len(), 0, "more hits than the bound are not stored");
        let mut named = hit("a.md", MAX_STORED_MATCHES - 1);
        named.path_matches.push(0..1);
        cache.put(key("named", 1), answer(1, vec![named]));
        assert_eq!(cache.len(), 0, "a path match tips it over the bound");
    }

    /// The fix round's M3: a cursor whose position is past the end of its
    /// answer is refused, not answered as an empty page.
    #[test]
    fn a_cursor_past_the_end_is_invalid_cursor() {
        let fixture = Fixture::new(&[("a.md", "meeting\n"), ("b.md", "meeting\n")]);
        let first = fixture.ask("meeting", None, Some(1)).unwrap();
        let at_end = Cursor::encode(
            first.generation,
            "meeting",
            false,
            SearchSortDto::FileNameAsc,
            2,
        );
        let empty = fixture.ask("meeting", Some(at_end), Some(1)).unwrap();
        assert!(
            empty.items.is_empty(),
            "the end itself is an empty last page"
        );
        let past = Cursor::encode(
            first.generation,
            "meeting",
            false,
            SearchSortDto::FileNameAsc,
            3,
        );
        let refused = fixture.ask("meeting", Some(past), Some(1)).unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidCursor);
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
        cache: SearchCache,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let vault = scratch();
            let index = scratch();
            for (path, body) in files {
                std::fs::write(vault.path().join(path), body).unwrap();
            }
            let config = vault_index::IndexConfig::explicit(
                vault.path(),
                index.path().join("index.sqlite3"),
            )
            .unwrap();
            let mut service = vault_index::IndexService::open(config).unwrap();
            service.refresh(false).unwrap();
            let reader = service.reader().unwrap();
            Self {
                vault,
                _index: index,
                service,
                reader,
                cache: SearchCache::default(),
            }
        }

        fn ask(
            &self,
            query: &str,
            cursor: Option<String>,
            limit: Option<u32>,
        ) -> Result<SearchResponse, ProtocolError> {
            ask(&self.reader, &self.cache, query, cursor, limit)
        }
    }

    fn ask(
        reader: &IndexReader,
        cache: &SearchCache,
        query: &str,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<SearchResponse, ProtocolError> {
        search(
            reader,
            cache,
            SearchParams {
                query: query.into(),
                cursor,
                limit,
                ..SearchParams::default()
            },
        )
    }

    /// Write `name` and publish it: one new generation.
    fn publish(vault: &std::path::Path, service: &mut vault_index::IndexService, name: &str) {
        std::fs::write(vault.join(name), "meeting\n").unwrap();
        service
            .refresh_paths(
                [VaultPath::new(name).unwrap()].into(),
                vault_index::ChangeCause::Watcher,
            )
            .unwrap();
    }

    /// The fix round's I2, deterministically: every pin is followed at once
    /// by a publication, so every scan's generation has moved on before its
    /// first page's contexts are read. A fresh `context: line` request still
    /// answers, at the generation it pinned, with its line text.
    #[test]
    fn a_fresh_search_answers_when_every_pin_is_followed_by_a_publication() {
        let Fixture {
            vault,
            _index,
            service,
            mut reader,
            cache,
        } = Fixture::new(&[("a.md", "x\nmeeting\n")]);
        let service = Mutex::new(service);
        let root = vault.path().to_path_buf();
        let published = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&published);
        reader.pause_evaluations_for_test(Arc::new(move || {
            let at = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut service = service.lock().unwrap();
            publish(&root, &mut service, &format!("n{at}.md"));
        }));
        for _ in 0..3 {
            let found = ask(&reader, &cache, "meeting", None, Some(1)).unwrap();
            assert_eq!(found.items.len(), 1);
            assert_eq!(
                found.items[0].content_matches[0].line_text.as_deref(),
                Some("meeting")
            );
        }
        assert!(
            published.load(std::sync::atomic::Ordering::SeqCst) >= 3,
            "a publication followed every pin"
        );
    }

    /// The re-ask loop, deterministically: an answer cached at generation N
    /// is served, a publication to N+1 lands before its contexts are pinned,
    /// and the fresh request still answers, from a second attempt that
    /// computes the answer at N+1.
    #[test]
    fn a_cached_answer_whose_generation_moves_before_its_contexts_is_asked_again() {
        let Fixture {
            vault,
            _index,
            service,
            reader,
            cache,
        } = Fixture::new(&[("a.md", "x\nmeeting\n")]);
        let first = ask(&reader, &cache, "meeting", None, None).unwrap();
        assert_eq!(cache.len(), 1, "the answer at N is cached");
        let service = Mutex::new(service);
        let root = vault.path().to_path_buf();
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let firing = Arc::clone(&fired);
        cache.before_contexts_for_test(Box::new(move || {
            firing.store(true, std::sync::atomic::Ordering::SeqCst);
            publish(&root, &mut service.lock().unwrap(), "b.md");
        }));
        let again = ask(&reader, &cache, "meeting", None, None).unwrap();
        assert!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            "the cached answer was served and the publication landed"
        );
        assert_eq!(again.generation, first.generation + 1, "answered at N+1");
        assert_eq!(
            again
                .items
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            ["a.md", "b.md"]
        );
        assert_eq!(
            again.items[0].content_matches[0].line_text.as_deref(),
            Some("meeting")
        );
    }

    /// The fix round's I2 under a real writer: a thread publishes in a loop
    /// while fresh `context: line` requests, hits and misses both, keep
    /// answering.
    #[test]
    fn a_fresh_search_answers_under_a_steady_stream_of_publications() {
        let Fixture {
            vault,
            _index,
            mut service,
            reader,
            cache,
        } = Fixture::new(&[("a.md", "x\nmeeting\n"), ("b.md", "meeting\n")]);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let root = vault.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            let mut at = 0;
            while !stopping.load(std::sync::atomic::Ordering::SeqCst) {
                publish(&root, &mut service, &format!("n{}.md", at % 8));
                at += 1;
            }
            at
        });
        for round in 0..200 {
            let query = if round % 2 == 0 { "meeting" } else { "x" };
            if let Err(refused) = ask(&reader, &cache, query, None, Some(2)) {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
                panic!("round {round}: {refused:?}");
            }
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let publications = writer.join().unwrap();
        assert!(publications > 0, "the writer published while we searched");
    }

    #[test]
    fn contexts_that_do_not_pair_with_the_matches_are_internal() {
        let two = hit("a.md", 2);
        let one = [MatchContext {
            line_text: "ab".into(),
            line_text_start: 0,
        }];
        let refused = convert::search_hit(&two, Some(&one)).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Internal);
        assert!(refused.message.contains("a.md"), "{}", refused.message);
        let none = convert::search_hit(&two, Some(&[])).unwrap_err();
        assert_eq!(none.code, ErrorCode::Internal);
        let bare = convert::search_hit(&two, None).unwrap();
        assert_eq!(bare.content_matches.len(), 2);
        assert_eq!(bare.content_matches[0].line_text, None);
    }
}
