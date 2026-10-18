//! Compiling a query tree for evaluation: each term gets its needle and its
//! case mode, every construct this build does not evaluate is refused by
//! name, and the facets a document must carry are computed.

use crate::document::{DocumentKind, SearchDocument};
use crate::evaluate::{Domain, holds, reaches_file};
use crate::query::{Node, Pattern, Query, QueryError, Scope, Term};
use crate::text::{Needle, fold_js};

/// The facets of a document a query reads, beside its path and kind.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Needs {
    pub text: bool,
    pub tags: bool,
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum CompileError {
    #[error("{what} is not supported by this build (at character {position})")]
    Unsupported { what: String, position: usize },
    #[error(transparent)]
    Invalid(#[from] QueryError),
}

/// A query ready to evaluate.
#[derive(Debug)]
pub struct CompiledQuery {
    pub(crate) root: Option<Compiled>,
    needs: Needs,
    reaches_files: bool,
    canonical: String,
    match_case: bool,
}

/// The query tree with each term compiled; `Case` nodes are resolved into
/// their terms' needles.
#[derive(Debug)]
pub(crate) enum Compiled {
    And(Vec<Compiled>),
    Or(Vec<Compiled>),
    Not(Box<Compiled>),
    Term(CompiledTerm),
    /// A scope operator, resolved to the domain its operand is matched in.
    Scoped {
        domain: Domain,
        query: Box<Compiled>,
    },
}

#[derive(Debug)]
pub(crate) struct CompiledTerm {
    pub needle: Needle,
    /// The text folded by `fold_js`, without a leading `#`: the tag-scope
    /// comparison key.
    pub tag_key: String,
}

impl CompiledQuery {
    /// Whether the query is empty; an empty query matches nothing.
    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    pub fn needs(&self) -> Needs {
        self.needs
    }

    /// Whether a non-note file can match: only through a positive `file:` or
    /// `path:` term (P10).
    pub fn reaches_files(&self) -> bool {
        self.reaches_files
    }

    /// The canonical spelling and the case toggle: the cache key's query part.
    pub fn canonical(&self) -> &str {
        &self.canonical
    }

    pub fn match_case(&self) -> bool {
        self.match_case
    }

    /// False only when a top-level conjunct that reads no text (`file:`,
    /// `path:`, `tag:`) rejects the document, or the file universe excludes
    /// it. Never reads `text()`.
    pub fn prefilter(&self, doc: &dyn SearchDocument) -> bool {
        let Some(root) = &self.root else {
            return false;
        };
        if doc.kind() == DocumentKind::File && !(self.reaches_files && reaches_file(root, doc)) {
            return false;
        }
        let conjuncts = match root {
            Compiled::And(items) => items.as_slice(),
            single => std::slice::from_ref(single),
        };
        conjuncts
            .iter()
            .filter(|item| !reads_text(item, Domain::Default))
            .all(|item| holds(item, doc, Domain::Default))
    }
}

/// Compiles `query` with the request's case toggle.
pub fn compile(query: &Query, match_case: bool) -> Result<CompiledQuery, CompileError> {
    let root = match &query.root {
        None => None,
        Some(node) => Some(lower(node, match_case)?),
    };
    let mut needs = Needs::default();
    let mut reaches_files = false;
    if let Some(root) = &root {
        survey(root, Domain::Default, true, &mut needs, &mut reaches_files);
    }
    Ok(CompiledQuery {
        root,
        needs,
        reaches_files,
        canonical: query.to_string(),
        match_case,
    })
}

fn lower(node: &Node, sensitive: bool) -> Result<Compiled, CompileError> {
    Ok(match node {
        Node::And(items) => Compiled::And(lower_all(items, sensitive)?),
        Node::Or(items) => Compiled::Or(lower_all(items, sensitive)?),
        Node::Not(inner) => Compiled::Not(Box::new(lower(inner, sensitive)?)),
        Node::Case {
            sensitive, query, ..
        } => lower(query, *sensitive)?,
        Node::Term(term) => Compiled::Term(lower_term(term, sensitive)?),
        Node::Scoped { scope, query, at } => {
            let domain = match scope {
                Scope::File => Domain::Name,
                Scope::Path => Domain::Path,
                Scope::Content => Domain::Content,
                Scope::Tag => Domain::Tag,
                other => {
                    return Err(CompileError::Unsupported {
                        what: format!("`{}:`", other.name()),
                        position: at.start,
                    });
                }
            };
            Compiled::Scoped {
                domain,
                query: Box::new(lower(query, sensitive)?),
            }
        }
        Node::Property { at, .. } => {
            return Err(CompileError::Unsupported {
                what: "property search".into(),
                position: at.start,
            });
        }
    })
}

fn lower_all(items: &[Node], sensitive: bool) -> Result<Vec<Compiled>, CompileError> {
    items.iter().map(|node| lower(node, sensitive)).collect()
}

fn lower_term(term: &Term, sensitive: bool) -> Result<CompiledTerm, CompileError> {
    match &term.pattern {
        Pattern::Text(text) => Ok(CompiledTerm {
            needle: Needle::text(text, sensitive),
            tag_key: fold_js(text.strip_prefix('#').unwrap_or(text)),
        }),
        Pattern::Regex { .. } => Err(CompileError::Unsupported {
            what: "regular expression".into(),
            position: term.at.start,
        }),
    }
}

/// Walks the tree once: a term that reads the text sets `needs.text`, a tag
/// term sets `needs.tags` (and `needs.text` when positive, since its spans
/// need the text for their `Loc`s), and a positive `file:` or `path:` scope
/// opens the file universe.
fn survey(
    node: &Compiled,
    domain: Domain,
    positive: bool,
    needs: &mut Needs,
    reaches_files: &mut bool,
) {
    match node {
        Compiled::And(items) | Compiled::Or(items) => {
            for item in items {
                survey(item, domain, positive, needs, reaches_files);
            }
        }
        Compiled::Not(inner) => survey(inner, domain, !positive, needs, reaches_files),
        Compiled::Scoped { domain, query } => {
            if positive && matches!(domain, Domain::Name | Domain::Path) {
                *reaches_files = true;
            }
            survey(query, *domain, positive, needs, reaches_files);
        }
        Compiled::Term(_) => match domain {
            Domain::Default | Domain::Content => needs.text = true,
            Domain::Tag => {
                needs.tags = true;
                if positive {
                    needs.text = true;
                }
            }
            Domain::Name | Domain::Path => {}
        },
    }
}

/// Whether deciding `node` reads the document's text.
fn reads_text(node: &Compiled, domain: Domain) -> bool {
    match node {
        Compiled::And(items) | Compiled::Or(items) => {
            items.iter().any(|item| reads_text(item, domain))
        }
        Compiled::Not(inner) => reads_text(inner, domain),
        Compiled::Scoped { domain, query } => reads_text(query, *domain),
        Compiled::Term(_) => matches!(domain, Domain::Default | Domain::Content),
    }
}
