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

/// An answer holding more stored content matches than this is not cached;
/// each of its pages is computed again.
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
}

impl Default for SearchCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_SEARCH_CACHE_ENTRIES)
    }
}

/// How many content matches an answer stores, across every hit.
fn stored_matches(answer: &SearchAnswer) -> usize {
    answer
        .hits
        .iter()
        .map(|hit| hit.content_matches.len())
        .sum()
}

impl SearchCache {
    /// A cache of at most `capacity` answers (at least one).
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: Mutex::new(Entries::default()),
        }
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

    /// Store `value` under `key`, unless it holds more than
    /// [`MAX_STORED_MATCHES`] content matches.
    pub(crate) fn put(&self, key: CacheKey, value: Arc<SearchAnswer>) {
        if stored_matches(&value) > MAX_STORED_MATCHES {
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

    let answer = match cache.get(&CacheKey::new(&compiled, sort, current)) {
        Some(answer) => answer,
        None => {
            let answer = Arc::new(
                reader
                    .search(&SearchQuery {
                        compiled: &compiled,
                        sort,
                    })
                    .map_err(convert::index_error)?,
            );
            let computed = answer.generation.get();
            // A page must come from its cursor's generation: a publication
            // between the status read and the pin moved it.
            if params.cursor.is_some() && computed != current {
                return Err(generation_mismatch(current, computed));
            }
            // Keyed by the generation the answer was computed at.
            cache.put(
                CacheKey::new(&compiled, sort, computed),
                Arc::clone(&answer),
            );
            answer
        }
    };

    let page: Vec<&vault_search::FileHit> = answer.hits.iter().skip(start).take(limit).collect();
    let contexts = match params.context {
        SearchContextDto::None => None,
        SearchContextDto::Line => {
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
            Some(
                reader
                    .match_contexts(answer.generation, &wanted)
                    .map_err(convert::index_error)?,
            )
        }
    };
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
        cache.put(
            key("bound", 1),
            answer(1, vec![hit("a.md", MAX_STORED_MATCHES)]),
        );
        assert!(
            cache.get(&key("bound", 1)).is_some(),
            "exactly the bound is stored"
        );
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
