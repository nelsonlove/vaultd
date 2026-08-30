use markdown::mdast::Node;
use markdown::{ParseOptions, to_mdast};
use percent_encoding::percent_decode_str;
use regex::Regex;
use std::sync::LazyLock;

use crate::{
    Diagnostic, DiagnosticCode, Heading, ListItem, ListItemParent, Reference, ReferenceKind,
    ReferenceOrigin, Section, SectionKind, Severity, SourceDocument, SourceSpan, Subpath,
};

pub(crate) struct MarkdownParse {
    pub headings: Vec<Heading>,
    pub references: Vec<Reference>,
    pub text_ranges: Vec<SourceSpan>,
    pub sections: Vec<Section>,
    pub list_items: Vec<ListItem>,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn parse_markdown(document: &SourceDocument, body_start: usize) -> MarkdownParse {
    let mut parse = MarkdownParse {
        headings: Vec::new(),
        references: Vec::new(),
        text_ranges: Vec::new(),
        sections: Vec::new(),
        list_items: Vec::new(),
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

    parse.sections = extract_sections(&tree, body_start, text);
    parse.list_items = extract_list_items(&tree, body_start, text);

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

fn span_for(body_start: usize, node: &Node) -> Option<SourceSpan> {
    let position = node.position()?;
    SourceSpan::new(
        body_start + position.start.offset,
        body_start + position.end.offset,
    )
    .ok()
}

/// A callout is a blockquote whose very first text starts with `[!type]`
/// (mdast has no callout node of its own — Obsidian recognizes this pattern
/// on top of a plain blockquote; see `tests/fixtures/structural/README.md`).
static CALLOUT_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[!\w[\w-]*\]").expect("callout marker pattern compiles"));

fn is_callout(blockquote: &markdown::mdast::Blockquote) -> bool {
    let Some(first_child) = blockquote.children.first() else {
        return false;
    };
    let mut text = String::new();
    collect_text(first_child, &mut text);
    CALLOUT_MARKER.is_match(&text)
}

fn section_kind(node: &Node) -> SectionKind {
    match node {
        Node::Heading(_) => SectionKind::Heading,
        Node::Paragraph(_) => SectionKind::Paragraph,
        Node::Code(_) => SectionKind::Code,
        Node::Blockquote(blockquote) => {
            if is_callout(blockquote) {
                SectionKind::Callout
            } else {
                SectionKind::Blockquote
            }
        }
        Node::Table(_) => SectionKind::Table,
        Node::ThematicBreak(_) => SectionKind::ThematicBreak,
        Node::List(_) => SectionKind::List,
        Node::Html(_) => SectionKind::Html,
        other => SectionKind::Other(node_type_name(other).to_string()),
    }
}

/// A best-effort label for a top-level mdast node type this parser doesn't
/// otherwise recognize. Never observed in the Task 0 capture — Obsidian's
/// own string for these, if any, is unknown, so this exists only so an
/// unrecognized block is preserved rather than silently dropped.
fn node_type_name(node: &Node) -> &'static str {
    match node {
        Node::Definition(_) => "definition",
        Node::FootnoteDefinition(_) => "footnoteDefinition",
        Node::Math(_) => "math",
        Node::MdxFlowExpression(_) => "mdxFlowExpression",
        Node::MdxJsxFlowElement(_) => "mdxJsxFlowElement",
        Node::MdxjsEsm(_) => "mdxjsEsm",
        Node::Toml(_) => "toml",
        Node::Yaml(_) => "yaml",
        _ => "unknown",
    }
}

/// mdast reports a `List`'s (and a `ListItem`'s) end position one line past
/// its own last line — the start of the next line — whenever more content
/// follows; at end-of-document there is no next line and the position lands
/// exactly on the container's real last byte instead. Obsidian's captured
/// `sections`/`listItems` never include that swallowed newline (verified
/// against `tests/fixtures/structural/13-block-ids` and `14-mixed-deep`),
/// so trim it back off when present.
fn trim_list_trailing_newline(text: &str, span: SourceSpan) -> SourceSpan {
    let bytes = text.as_bytes();
    let mut end = span.end();
    if end > span.start() && bytes.get(end.wrapping_sub(1)) == Some(&b'\n') {
        end -= 1;
        if end > span.start() && bytes.get(end.wrapping_sub(1)) == Some(&b'\r') {
            end -= 1;
        }
    }
    SourceSpan::new(span.start(), end).unwrap_or(span)
}

/// Walk only the root node's direct children — one `Section` per top-level
/// block, never one nested inside another block. `Section.block_id` is
/// filled in later by `parse_note`, once `ParsedNote.blocks` exists.
fn extract_sections(tree: &Node, body_start: usize, text: &str) -> Vec<Section> {
    let Some(children) = tree.children() else {
        return Vec::new();
    };
    children
        .iter()
        .filter_map(|child| {
            let mut span = span_for(body_start, child)?;
            if matches!(child, Node::List(_)) {
                span = trim_list_trailing_newline(text, span);
            }
            Some(Section {
                kind: section_kind(child),
                span,
                block_id: None,
            })
        })
        .collect()
}

/// 0-based source line number for an absolute byte offset. mdast's own
/// `position.start.line` is relative to whatever `&str` it parsed (the body,
/// not the whole document), so it undercounts by the frontmatter's line
/// count whenever frontmatter is present. Counting newlines in the full
/// document text up to the absolute offset sidesteps that mismatch entirely.
fn line_of(text: &str, byte_offset: usize) -> u32 {
    text[..byte_offset].matches('\n').count() as u32
}

/// A task-list marker: a list/ordered marker immediately followed by a
/// single bracketed character, e.g. `- [ ]`, `1. [x]`, `- [/]`. Matched
/// against the raw source (never mdast's `checked` field) because mdast only
/// recognizes `[ ]`/`[x]`/`[X]` as GFM checkboxes — a non-standard state like
/// `[/]` parses as plain paragraph text, with `checked: None`, yet Obsidian
/// still reports its raw bracket character (`tests/fixtures/structural/09-task-list`).
static TASK_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\]").expect("task marker pattern compiles")
});

fn detect_task_char(text: &str, span: SourceSpan) -> Option<char> {
    let slice = text.get(span.start()..span.end())?;
    let capture = TASK_MARKER.captures(slice)?;
    capture.get(1)?.as_str().chars().next()
}

/// Descend every list, in document order, tracking the enclosing item's own
/// start line so `ListItemParent` can be built per the pinned correction: a
/// nested item carries its parent item's start line, a root item carries the
/// negated start line of its containing list (see
/// `crates/vault-core/src/semantic.rs::ListItemParent`).
fn extract_list_items(tree: &Node, body_start: usize, text: &str) -> Vec<ListItem> {
    let mut items = Vec::new();
    walk_for_list_items(tree, body_start, text, None, &mut items);
    items
}

/// A `ListItem`'s own span, per Obsidian's convention: the item's marker
/// through the end of its own direct (non-`List`) content, excluding any
/// nested sublist. mdast's own `ListItem.position` covers the item *and*
/// every nested sublist beneath it — Obsidian's `listItems[].position` does
/// not (verified against `07-unordered-nested` and `14-mixed-deep`, where a
/// naive `item.position` swallows the nested list that gets its own entries).
fn item_span(body_start: usize, text: &str, item_node: &Node) -> Option<SourceSpan> {
    let whole = span_for(body_start, item_node)?;
    let mut end = None;
    if let Some(children) = item_node.children() {
        for child in children {
            if matches!(child, Node::List(_)) {
                continue;
            }
            if let Some(child_span) = span_for(body_start, child) {
                end = Some(end.map_or(child_span.end(), |current: usize| {
                    current.max(child_span.end())
                }));
            }
        }
    }
    let span = SourceSpan::new(whole.start(), end.unwrap_or(whole.end())).ok()?;
    Some(trim_list_trailing_newline(text, span))
}

fn walk_for_list_items(
    node: &Node,
    body_start: usize,
    text: &str,
    parent_item_line: Option<u32>,
    items: &mut Vec<ListItem>,
) {
    if let Node::List(list) = node {
        let list_start_line = span_for(body_start, node)
            .map(|span| line_of(text, span.start()))
            .unwrap_or(0);
        for child in &list.children {
            if !matches!(child, Node::ListItem(_)) {
                continue;
            }
            let Some(span) = item_span(body_start, text, child) else {
                continue;
            };
            let item_line = line_of(text, span.start());
            let parent = match parent_item_line {
                None => ListItemParent::Root { list_start_line },
                Some(parent_line) => ListItemParent::Item {
                    parent_start_line: parent_line,
                },
            };
            let task = detect_task_char(text, span);
            items.push(ListItem { span, parent, task });

            if let Some(grandchildren) = child.children() {
                for grandchild in grandchildren {
                    walk_for_list_items(grandchild, body_start, text, Some(item_line), items);
                }
            }
        }
        return;
    }
    if let Some(children) = node.children() {
        for child in children {
            walk_for_list_items(child, body_start, text, parent_item_line, items);
        }
    }
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
                if html.value.trim_start().starts_with("<!--") {
                    return;
                }
                let opens = count_opening_tags(&html.value);
                let closes = html.value.matches("</").count();
                self.html_depth = (self.html_depth + opens).saturating_sub(closes);
            }
            Node::Text(_) => {
                if self.html_depth == 0 {
                    self.parse.text_ranges.extend(self.node_span(node));
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
        span_for(self.body_start, node)
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
