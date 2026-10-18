//! Deciding one document and collecting its spans.

use std::ops::Range;

use vault_core::VaultPath;

use crate::compile::{Compiled, CompiledQuery, CompiledTerm};
use crate::document::{DocumentKind, SearchDocument, file_name};
use crate::query::Scope;
use crate::text::{LineIndex, Loc, fold_js, utf16_len};

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

pub(crate) fn scope_domain(scope: Scope) -> Domain {
    match scope {
        Scope::File => Domain::Name,
        Scope::Path => Domain::Path,
        Scope::Content => Domain::Content,
        Scope::Tag => Domain::Tag,
        // `compile` refuses every other scope.
        _ => unreachable!("scope {scope:?} is refused by compile"),
    }
}

/// Decides one document; `None` when it does not match.
pub fn evaluate(query: &CompiledQuery, doc: &dyn SearchDocument) -> Option<FileHit> {
    let root = query.root.as_ref()?;
    if doc.kind() == DocumentKind::File && !query.reaches_files() {
        return None;
    }
    if !holds(root, doc, Domain::Default) {
        return None;
    }
    let mut collector = Collector::default();
    collect(root, doc, Domain::Default, &mut collector);
    Some(collector.finish(doc))
}

pub(crate) fn holds(node: &Compiled, doc: &dyn SearchDocument, domain: Domain) -> bool {
    match node {
        Compiled::And(items) => items.iter().all(|n| holds(n, doc, domain)),
        Compiled::Or(items) => items.iter().any(|n| holds(n, doc, domain)),
        Compiled::Not(inner) => !holds(inner, doc, domain),
        Compiled::Scoped { scope, query } => holds(query, doc, scope_domain(*scope)),
        Compiled::Term(term) => term_holds(term, doc, domain),
    }
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
            .any(|tag| tag_matches(&term.tag_key, &tag.value)),
    }
}

/// P9: the tag itself or a descendant, ignoring case and a leading `#`. An
/// empty key matches nothing (P19).
fn tag_matches(key: &str, tag: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let tag = fold_js(tag);
    tag == key
        || (tag.len() > key.len() && tag.starts_with(key) && tag.as_bytes()[key.len()] == b'/')
}

/// Byte spans gathered from the terms that make the document match.
#[derive(Default)]
struct Collector {
    content: Vec<Range<usize>>,
    path: Vec<Range<usize>>,
}

/// Adds the spans of every positive term in a branch that holds: called only
/// on nodes that hold for `doc`, it descends into the items of an `Or` that
/// hold, into every item of an `And` (all of which hold), and never under a
/// `Not`.
fn collect(node: &Compiled, doc: &dyn SearchDocument, domain: Domain, out: &mut Collector) {
    match node {
        Compiled::And(items) => {
            for item in items {
                collect(item, doc, domain, out);
            }
        }
        Compiled::Or(items) => {
            for item in items {
                if holds(item, doc, domain) {
                    collect(item, doc, domain, out);
                }
            }
        }
        Compiled::Not(_) => {}
        Compiled::Scoped { scope, query } => collect(query, doc, scope_domain(*scope), out),
        Compiled::Term(term) => collect_term(term, doc, domain, out),
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
                .filter(|tag| tag_matches(&term.tag_key, &tag.value))
                .map(|tag| tag.span.clone()),
        ),
    }
}

impl Collector {
    fn finish(self, doc: &dyn SearchDocument) -> FileHit {
        let content = merge(self.content);
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
            // Positive tag terms need the text, so a source that honours
            // `needs()` never lands here with content spans.
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
