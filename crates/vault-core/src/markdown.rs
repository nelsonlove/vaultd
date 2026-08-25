use markdown::mdast::Node;
use markdown::{ParseOptions, to_mdast};
use percent_encoding::percent_decode_str;

use crate::{
    Diagnostic, DiagnosticCode, Heading, Reference, ReferenceKind, ReferenceOrigin, Severity,
    SourceDocument, SourceSpan, Subpath,
};

pub(crate) struct MarkdownParse {
    pub headings: Vec<Heading>,
    pub references: Vec<Reference>,
    pub text_ranges: Vec<SourceSpan>,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn parse_markdown(document: &SourceDocument, body_start: usize) -> MarkdownParse {
    let mut parse = MarkdownParse {
        headings: Vec::new(),
        references: Vec::new(),
        text_ranges: Vec::new(),
        diagnostics: Vec::new(),
    };
    let text = document.text();
    let body = &text[body_start..];
    if body.is_empty() {
        return parse;
    }

    let tree = match to_mdast(body, &ParseOptions::gfm()) {
        Ok(tree) => tree,
        Err(error) => {
            let span = SourceSpan::new(body_start, text.len()).expect("body span is ordered");
            parse.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MarkdownParseError,
                    Severity::Warning,
                    format!("markdown body failed to parse: {error}"),
                )
                .with_path(document.path().clone())
                .with_span(span),
            );
            return parse;
        }
    };

    let mut walker = Walker {
        document,
        body_start,
        html_depth: 0,
        parse: &mut parse,
    };
    walker.walk(&tree);

    parse
        .headings
        .sort_by_key(|heading| (heading.span.start(), heading.span.end()));
    parse
        .references
        .sort_by_key(|reference| (reference.span.start(), reference.span.end()));
    parse.text_ranges.sort_unstable();
    parse
}

struct Walker<'a> {
    document: &'a SourceDocument,
    body_start: usize,
    html_depth: usize,
    parse: &'a mut MarkdownParse,
}

impl Walker<'_> {
    fn walk(&mut self, node: &Node) {
        match node {
            Node::Heading(heading) => {
                if let Some(span) = self.node_span(node) {
                    let mut text = String::new();
                    for child in &heading.children {
                        collect_text(child, &mut text);
                    }
                    self.parse.headings.push(Heading {
                        level: heading.depth,
                        text,
                        span,
                    });
                }
                for child in &heading.children {
                    self.walk(child);
                }
            }
            Node::Link(link) => {
                let mut display = String::new();
                for child in &link.children {
                    collect_text(child, &mut display);
                }
                self.emit_reference(
                    node,
                    ReferenceKind::MarkdownLink,
                    (!display.is_empty()).then_some(display),
                );
            }
            Node::Image(image) => {
                self.emit_reference(
                    node,
                    ReferenceKind::MarkdownEmbed,
                    (!image.alt.is_empty()).then_some(image.alt.clone()),
                );
            }
            Node::Code(_) | Node::InlineCode(_) | Node::Math(_) | Node::InlineMath(_) => {}
            Node::Html(html) => {
                let opens = count_opening_tags(&html.value);
                let closes = html.value.matches("</").count();
                self.html_depth = (self.html_depth + opens).saturating_sub(closes);
            }
            Node::Text(_) => {
                if self.html_depth == 0
                    && let Some(span) = self.node_span(node)
                {
                    self.parse.text_ranges.push(span);
                }
            }
            _ => {
                if let Some(children) = node.children() {
                    for child in children {
                        self.walk(child);
                    }
                }
            }
        }
    }

    fn node_span(&self, node: &Node) -> Option<SourceSpan> {
        let position = node.position()?;
        SourceSpan::new(
            self.body_start + position.start.offset,
            self.body_start + position.end.offset,
        )
        .ok()
    }

    fn emit_reference(&mut self, node: &Node, kind: ReferenceKind, display: Option<String>) {
        let Some(span) = self.node_span(node) else {
            return;
        };
        let Some(target_span) = destination_span(self.document.text(), span) else {
            self.parse.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MarkdownParseError,
                    Severity::Warning,
                    "cannot map a markdown destination back to source",
                )
                .with_path(self.document.path().clone())
                .with_span(span),
            );
            return;
        };
        let raw_target = self.document.text()[target_span.start()..target_span.end()].to_string();
        let (file_target, subpath) = split_markdown_target(&raw_target);
        self.parse.references.push(Reference {
            kind,
            origin: ReferenceOrigin::Body,
            raw_target,
            file_target,
            subpath,
            display,
            span,
            target_span,
        });
    }
}

fn collect_text(node: &Node, into: &mut String) {
    match node {
        Node::Text(text) => into.push_str(&text.value),
        Node::InlineCode(code) => into.push_str(&code.value),
        _ => {
            if let Some(children) = node.children() {
                for child in children {
                    collect_text(child, into);
                }
            }
        }
    }
}

/// HTML5 void elements never take a closing tag, so they must not open a
/// depth level — an unmatched opener would silently exclude the rest of the
/// document from prose scanning.
const VOID_ELEMENTS: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

fn count_opening_tags(html: &str) -> usize {
    let mut count = 0;
    let bytes = html.as_bytes();
    for (index, window) in bytes.windows(2).enumerate() {
        if window[0] == b'<' && window[1].is_ascii_alphabetic() {
            let name: String = html[index + 1..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            if VOID_ELEMENTS.contains(&name.as_str()) {
                continue;
            }
            let close = html[index..].find('>').map(|offset| index + offset);
            let self_closing = close.is_some_and(|end| html[..end].ends_with('/'));
            if !self_closing {
                count += 1;
            }
        }
    }
    count
}

/// Locate the exact inline-destination slice of a Markdown link or embed,
/// starting from the syntax span mdast reported. Returns `None` when the
/// destination cannot be mapped back to one unambiguous source slice.
fn destination_span(text: &str, span: SourceSpan) -> Option<SourceSpan> {
    let slice = &text[span.start()..span.end()];
    let bytes = slice.as_bytes();

    let mut index = 0;
    if bytes.first() == Some(&b'!') {
        index += 1;
    }
    if bytes.get(index) != Some(&b'[') {
        return None;
    }
    index += 1;

    let mut depth = 1usize;
    while index < bytes.len() && depth > 0 {
        match bytes[index] {
            b'\\' => index += 1,
            b'[' => depth += 1,
            b']' => depth -= 1,
            _ => {}
        }
        index += 1;
    }
    if depth != 0 || bytes.get(index) != Some(&b'(') {
        return None;
    }
    index += 1;

    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }

    if bytes.get(index) == Some(&b'<') {
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() {
            match bytes[end] {
                b'\\' => end += 2,
                b'>' => {
                    return SourceSpan::new(span.start() + start, span.start() + end).ok();
                }
                _ => end += 1,
            }
        }
        return None;
    }

    let start = index;
    let mut paren_depth = 0usize;
    let mut end = start;
    while end < bytes.len() {
        match bytes[end] {
            b'\\' => end += 1,
            b'(' => paren_depth += 1,
            b')' => {
                if paren_depth == 0 {
                    break;
                }
                paren_depth -= 1;
            }
            byte if byte.is_ascii_whitespace() => break,
            _ => {}
        }
        end += 1;
    }
    if end > bytes.len() {
        return None;
    }
    SourceSpan::new(span.start() + start, span.start() + end).ok()
}

/// Percent-decode a Markdown destination and split it into file and subpath
/// portions. A recognized URI scheme yields no file target.
fn split_markdown_target(raw: &str) -> (Option<String>, Option<Subpath>) {
    if has_uri_scheme(raw) {
        return (None, None);
    }
    let (file_raw, fragment_raw) = match raw.split_once('#') {
        Some((file, fragment)) => (file, Some(fragment)),
        None => (raw, None),
    };
    let file_target = if file_raw.is_empty() {
        None
    } else {
        Some(percent_decode(file_raw))
    };
    let subpath = fragment_raw.and_then(|fragment| {
        if fragment.is_empty() {
            None
        } else if let Some(block) = fragment.strip_prefix('^') {
            Some(Subpath::Block(percent_decode(block)))
        } else {
            Some(Subpath::Heading(percent_decode(fragment)))
        }
    });
    (file_target, subpath)
}

fn percent_decode(value: &str) -> String {
    percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

pub(crate) fn has_uri_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {
            chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        }
        _ => false,
    }
}
