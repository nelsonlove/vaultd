//! Deciding one document and collecting its spans.

use std::ops::Range;

use vault_core::VaultPath;

use crate::compile::{Compiled, CompiledQuery, CompiledTerm};
use crate::document::{DocumentKind, SearchDocument, file_name};
use crate::text::{LineIndex, Loc, utf16_len};

/// 100, so a default page (100 files) with line text stays near 7 MB, inside
/// the protocol's 16 MiB payload cap; 1000 would put it near 66 MB.
pub const MAX_MATCHES_PER_FILE: usize = 100;

/// One match in a note's text: its byte span and its UTF-16 positions.
#[derive(Clone, Debug, PartialEq)]
pub struct ContentMatch {
    pub span: Range<usize>,
    pub start: Loc,
    pub end: Loc,
}

/// One matching file and its spans.
#[derive(Clone, Debug, PartialEq)]
pub struct FileHit {
    pub path: VaultPath,
    pub kind: DocumentKind,
    /// UTF-16 offsets into the path string.
    pub path_matches: Vec<Range<usize>>,
    pub content_matches: Vec<ContentMatch>,
    /// Every content and path match, before the cap.
    pub total_matches: usize,
    pub matches_truncated: bool,
}

/// What a term is matched against.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Domain {
    /// A note's text and path (P1, P2).
    Default,
    Content,
    /// The file name, extension included.
    Name,
    Path,
    Tag,
}

/// Decides one document; `None` when it does not match. The document must
/// carry the facets `query.needs()` names: a note without the text a query
/// needs is a bug in the source, caught by a debug assertion.
pub fn evaluate(query: &CompiledQuery, doc: &dyn SearchDocument) -> Option<FileHit> {
    debug_assert!(
        !query.needs().text || doc.kind() == DocumentKind::File || doc.text().is_some(),
        "the query needs the text of {}, and the source gave none",
        doc.path().as_str()
    );
    if let Some(text) = doc.text() {
        for tag in doc.tags() {
            debug_assert!(
                tag.span.start <= tag.span.end
                    && tag.span.end <= text.len()
                    && text.is_char_boundary(tag.span.start)
                    && text.is_char_boundary(tag.span.end),
                "tag span {:?} of {} is not a range of character boundaries of its {}-byte text",
                tag.span,
                doc.path().as_str(),
                text.len()
            );
        }
    }
    let root = query.root.as_ref()?;
    if doc.kind() == DocumentKind::File && !(query.reaches_files() && reaches_file(root, doc)) {
        return None;
    }
    if !holds(root, doc, Domain::Default) {
        return None;
    }
    let mut collector = Collector::default();
    collect(root, doc, Domain::Default, true, &mut collector);
    Some(collector.finish(doc))
}

pub(crate) fn holds(node: &Compiled, doc: &dyn SearchDocument, domain: Domain) -> bool {
    match node {
        Compiled::And(items) => items.iter().all(|n| holds(n, doc, domain)),
        Compiled::Or(items) => items.iter().any(|n| holds(n, doc, domain)),
        Compiled::Not(inner) => !holds(inner, doc, domain),
        Compiled::Scoped { domain, query } => holds(query, doc, *domain),
        Compiled::Term(term) => term_holds(term, doc, domain),
    }
}

/// P10, per file: whether a positive `file:` or `path:` term (at an even
/// depth of negation) holds for `doc`. Reads only the path, so `prefilter`
/// may call it.
pub(crate) fn reaches_file(root: &Compiled, doc: &dyn SearchDocument) -> bool {
    fn walk(node: &Compiled, doc: &dyn SearchDocument, positive: bool) -> bool {
        match node {
            Compiled::And(items) | Compiled::Or(items) => {
                items.iter().any(|item| walk(item, doc, positive))
            }
            Compiled::Not(inner) => walk(inner, doc, !positive),
            Compiled::Scoped { domain, query } => {
                (positive
                    && matches!(domain, Domain::Name | Domain::Path)
                    && holds(query, doc, *domain))
                    || walk(query, doc, positive)
            }
            Compiled::Term(_) => false,
        }
    }
    walk(root, doc, true)
}

fn term_holds(term: &CompiledTerm, doc: &dyn SearchDocument, domain: Domain) -> bool {
    let is_note = doc.kind() != DocumentKind::File;
    match domain {
        Domain::Default => {
            doc.text().is_some_and(|t| term.needle.is_match(t))
                || (is_note && term.needle.is_match(doc.path().as_str()))
        }
        Domain::Content => doc.text().is_some_and(|t| term.needle.is_match(t)),
        Domain::Name => term.needle.is_match(file_name(doc.path())),
        Domain::Path => term.needle.is_match(doc.path().as_str()),
        Domain::Tag => doc
            .tags()
            .iter()
            .any(|tag| tag_matches(&term.tag_key, &tag.folded)),
    }
}

/// P9: the tag itself or a descendant, ignoring case and a leading `#`. An
/// empty key matches nothing (P19). `tag` is the tag's stored fold
/// (`TagFact::folded`), so nothing is folded here.
fn tag_matches(key: &str, tag: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    tag == key
        || (tag.len() > key.len() && tag.starts_with(key) && tag.as_bytes()[key.len()] == b'/')
}

/// Byte spans gathered from the terms that make the document match.
#[derive(Default)]
struct Collector {
    content: Vec<Range<usize>>,
    path: Vec<Range<usize>>,
}

/// Adds the spans of every positive term (at an even depth of negation, as
/// `survey` counts it) whose branch makes the document match. Called only on
/// a node whose truth for `doc` equals `positive`, it descends into each item
/// whose truth also equals `positive`: under a positive `And` every item,
/// under a positive `Or` the items that hold, and under a `Not` the inner
/// node with the polarity flipped. A term adds spans only when positive, so
/// in `(a b) OR c` over a text with `a` and `c` only `c` is highlighted, and
/// in `-(-a)` the `a` is.
fn collect(
    node: &Compiled,
    doc: &dyn SearchDocument,
    domain: Domain,
    positive: bool,
    out: &mut Collector,
) {
    match node {
        Compiled::And(items) | Compiled::Or(items) => {
            for item in items {
                if holds(item, doc, domain) == positive {
                    collect(item, doc, domain, positive, out);
                }
            }
        }
        Compiled::Not(inner) => collect(inner, doc, domain, !positive, out),
        Compiled::Scoped { domain, query } => collect(query, doc, *domain, positive, out),
        Compiled::Term(term) => {
            if positive {
                collect_term(term, doc, domain, out);
            }
        }
    }
}

fn collect_term(
    term: &CompiledTerm,
    doc: &dyn SearchDocument,
    domain: Domain,
    out: &mut Collector,
) {
    let path = doc.path().as_str();
    match domain {
        Domain::Default => {
            if let Some(text) = doc.text() {
                out.content.extend(term.needle.find_all(text));
            }
            if doc.kind() != DocumentKind::File {
                out.path.extend(term.needle.find_all(path));
            }
        }
        Domain::Content => {
            if let Some(text) = doc.text() {
                out.content.extend(term.needle.find_all(text));
            }
        }
        Domain::Name => {
            let name = file_name(doc.path());
            let shift = path.len() - name.len();
            out.path.extend(
                term.needle
                    .find_all(name)
                    .into_iter()
                    .map(|span| span.start + shift..span.end + shift),
            );
        }
        Domain::Path => out.path.extend(term.needle.find_all(path)),
        Domain::Tag => out.content.extend(
            doc.tags()
                .iter()
                .filter(|tag| tag_matches(&term.tag_key, &tag.folded))
                .map(|tag| tag.span.clone()),
        ),
    }
}

impl Collector {
    fn finish(self, doc: &dyn SearchDocument) -> FileHit {
        // Without the text no content span can be located, so none is counted
        // either: `total_matches` stays the sum of what is reported whenever
        // nothing is truncated. (A source that honours `needs()` always gives
        // the text when content spans exist; `evaluate` asserts it in debug.)
        let content = match doc.text() {
            Some(_) => merge(self.content),
            None => Vec::new(),
        };
        let path_spans = merge(self.path);
        let total_matches = content.len() + path_spans.len();
        let matches_truncated = content.len() > MAX_MATCHES_PER_FILE;
        let path = doc.path().as_str();
        let path_matches = path_spans
            .into_iter()
            .map(|span| utf16_len(&path[..span.start])..utf16_len(&path[..span.end]))
            .collect();
        let content_matches = match doc.text() {
            Some(text) => {
                let index = LineIndex::new(text);
                content
                    .into_iter()
                    .take(MAX_MATCHES_PER_FILE)
                    .map(|span| ContentMatch {
                        start: index.loc(span.start),
                        end: index.loc(span.end),
                        span,
                    })
                    .collect()
            }
            None => Vec::new(),
        };
        FileHit {
            path: doc.path().clone(),
            kind: doc.kind(),
            path_matches,
            content_matches,
            total_matches,
            matches_truncated,
        }
    }
}

/// Sorts spans by start and merges the ones that overlap.
fn merge(mut spans: Vec<Range<usize>>) -> Vec<Range<usize>> {
    spans.sort_by_key(|span| (span.start, span.end));
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(spans.len());
    for span in spans {
        match merged.last_mut() {
            Some(last) if span.start < last.end => last.end = last.end.max(span.end),
            _ => merged.push(span),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::Collector;
    use crate::document::MemoryDocument;

    /// The release path of the `needs()` contract: a document without text
    /// reports no content matches and counts none.
    #[test]
    fn a_document_without_text_counts_no_content_matches() {
        let doc = MemoryDocument {
            text: None,
            ..MemoryDocument::note("a.md", "")
        };
        let path_span = 0..1;
        let collector = Collector {
            content: vec![0..5, 7..9],
            path: vec![path_span.clone()],
        };
        let hit = collector.finish(&doc);
        assert!(hit.content_matches.is_empty());
        assert_eq!(hit.path_matches, vec![path_span]);
        assert_eq!(hit.total_matches, 1);
        assert!(!hit.matches_truncated);
    }
}
