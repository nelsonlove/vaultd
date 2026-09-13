use markdown::mdast::Node;
use markdown::{Constructs, ParseOptions, to_mdast};
use percent_encoding::percent_decode_str;
use regex::Regex;
use std::sync::LazyLock;

use crate::{
    Diagnostic, DiagnosticCode, Heading, ListItem, ListItemParent, Reference, ReferenceKind,
    ReferenceOrigin, Section, SectionKind, Severity, SourceDocument, SourceSpan, Subpath,
};

thread_local! {
    /// Set while the contained `to_mdast` call is on this thread's stack, and
    /// nowhere else.
    static CONTAINED_PARSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether this thread is currently inside the contained markdown parse — the
/// one place in the process where a panic is expected, caught, and degraded to
/// a diagnostic.
///
/// For a panic hook, and for nothing else. A hook runs *before* the unwind
/// reaches `catch_unwind`, so by the time the containment takes effect the
/// default hook has already printed a crash report for a process that is not
/// crashing. Consulting this lets a hook tell the one contained site apart
/// from every genuine panic and report it as a warning instead. Every other
/// panic must still reach the default hook untouched: silencing panics
/// generally is how a real defect goes unnoticed.
pub fn in_contained_markdown_parse() -> bool {
    CONTAINED_PARSE.with(std::cell::Cell::get)
}

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

    // `to_mdast` can **panic** on legal Markdown, not merely return `Err`:
    // markdown 1.0.0 aborts with "Cannot push to non-parent"
    // (`to_mdast.rs:193`) on a run of setext-ish underlines such as
    // `a\n-\n--\nA\n-\n`. A note body is arbitrary content that arrives from
    // the filesystem, and `vaultd` runs this parser on its coordinator
    // thread — so an unwind here aborts the daemon over a file somebody
    // merely saved, with no request involved at all.
    //
    // Every route into the parser reaches this one call (the cold scan, the
    // live reconcile, and the semantic graph build), so the boundary belongs
    // here rather than repeated at each caller.
    //
    // This is containment for an upstream defect and nothing more. Fixing
    // markdown-rs is out of scope for this branch, and a panicking dependency
    // must not be able to take the process with it. Degrading to the same
    // shape the `Err` arm already produces keeps the note indexable — its
    // frontmatter is parsed before this point and survives — and records the
    // loss of body semantics as a diagnostic rather than swallowing it.
    // No `AssertUnwindSafe`: the closure captures only `&str`, which is
    // `UnwindSafe` on its own, so the compiler proves the invariant. If a
    // future edit captures something mutable here, the build fails instead
    // of silently defeating this boundary. NOTE this containment depends on
    // panic = "unwind" (the workspace default, left implicit; a profile
    // switch to "abort" would reopen the process-kill this guards against).
    //
    // The flag below is the *cosmetic* half of the same containment. A caught
    // unwind is contained, but the panic runtime still ran the process-wide
    // hook on the way out, and the default hook prints `thread … panicked at
    // …` plus a backtrace invitation. An operator reading `vaultd`'s stderr
    // sees a crash report for a daemon that is still serving — the loudest
    // possible way to say the wrong thing. Marking the window lets a hook
    // recognise this site and report it as the warning it is; see
    // [`in_contained_markdown_parse`].
    let restore = CONTAINED_PARSE.with(|flag| flag.replace(true));
    let parsed = std::panic::catch_unwind(|| to_mdast(body, &parse_options()));
    CONTAINED_PARSE.with(|flag| flag.set(restore));

    let tree = match parsed {
        Ok(Ok(tree)) => tree,
        outcome => {
            let reason = match outcome {
                Ok(Err(error)) => format!("markdown body failed to parse: {error}"),
                _ => "the markdown parser panicked on this body and was contained; \
                      the note's frontmatter is indexed and its body semantics are not"
                    .to_string(),
            };
            let span = SourceSpan::new(body_start, text.len()).expect("body span is ordered");
            parse.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MarkdownParseError,
                    Severity::Warning,
                    reason,
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

/// GFM plus math (block `$$...$$`): Obsidian renders `$$` blocks as their own
/// `math` section (`tests/fixtures/structural/18-math-block`), which mdast
/// only emits when `math_flow` is explicitly enabled — off in
/// `Constructs::gfm()` since it isn't part of the GFM spec. Footnotes and
/// link-reference definitions need no extra opt-in: `Constructs::gfm()`
/// already turns on `gfm_footnote_definition`, and plain `[label]: url`
/// definitions are a core CommonMark construct.
fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            math_flow: true,
            ..Constructs::gfm()
        },
        ..ParseOptions::gfm()
    }
}

fn span_for(body_start: usize, node: &Node) -> Option<SourceSpan> {
    let position = node.position()?;
    SourceSpan::new(
        body_start + position.start.offset,
        body_start + position.end.offset,
    )
    .ok()
}

/// A callout marker: `[!type]`, optionally with spaces in `type`
/// (`tests/fixtures/structural/20-callout-edges`: `[!my type]`) and an
/// optional trailing fold indicator (`[!NOTE]-`, `[!NOTE]+`) which this
/// pattern doesn't need to care about since it only anchors the opening
/// bracket run.
static CALLOUT_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[!\w[\w -]*\]").expect("callout marker pattern compiles"));

/// A callout is a blockquote whose FIRST source line (after stripping the
/// `>` marker and at most one following space) starts with a `[!type]`
/// marker. This reads the raw source at the quote's own start rather than
/// mdast's merged multi-line paragraph text: the merged text would still
/// start with the marker even when it actually sits on the blockquote's
/// *second* quoted line preceded by a blank first line (`20-callout-edges`,
/// `> ` then `> [!note] marker on second line` — Obsidian classifies that as
/// a plain `blockquote`, not a `callout`), so only the true first line can
/// be trusted.
fn is_callout(text: &str, span: SourceSpan) -> bool {
    let Some(slice) = text.get(span.start()..span.end()) else {
        return false;
    };
    let first_line = slice.split('\n').next().unwrap_or(slice);
    // CommonMark allows up to three spaces of indentation before `>`;
    // Obsidian still renders such a quote as a callout (fixture 22).
    let content = first_line
        .trim_start()
        .strip_prefix('>')
        .unwrap_or(first_line);
    let content = content.strip_prefix(' ').unwrap_or(content);
    CALLOUT_MARKER.is_match(content)
}

fn section_kind(node: &Node, text: &str, span: SourceSpan) -> SectionKind {
    match node {
        Node::Heading(_) => SectionKind::Heading,
        Node::Paragraph(_) => SectionKind::Paragraph,
        Node::Code(_) => SectionKind::Code,
        Node::Blockquote(_) => {
            if is_callout(text, span) {
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
/// otherwise map to a known `SectionKind`. `definition`, `footnoteDefinition`,
/// and `math` are confirmed real Obsidian section-type strings (second
/// capture, fixtures 17-18) — everything else here is an unmapped mdast node
/// type never observed in either capture, preserved rather than dropped.
/// `Node::Yaml` never reaches this function: `parse_markdown` only ever runs
/// on the post-frontmatter body, and frontmatter's own `---` fences are
/// consumed by `frontmatter.rs` before mdast ever sees the text.
fn node_type_name(node: &Node) -> &'static str {
    match node {
        Node::Definition(_) => "definition",
        Node::FootnoteDefinition(_) => "footnoteDefinition",
        Node::Math(_) => "math",
        Node::MdxFlowExpression(_) => "mdxFlowExpression",
        Node::MdxJsxFlowElement(_) => "mdxJsxFlowElement",
        Node::MdxjsEsm(_) => "mdxjsEsm",
        Node::Toml(_) => "toml",
        _ => "unknown",
    }
}

/// mdast reports certain multi-line block containers' end positions one
/// line past their own last line — the start of the next line — whenever
/// more content follows; at end-of-document there is no next line and the
/// position lands exactly on the container's real last byte instead.
/// Confirmed on `List`/`ListItem` (`tests/fixtures/structural/13-block-ids`,
/// `14-mixed-deep`) and on `FootnoteDefinition`
/// (`17-definitions-and-footnotes`); NOT reproduced on `Blockquote`
/// (`04-blockquote`, `11-callout` both matched without this trim) or any
/// single-line construct (`Definition`, `Heading`, `Paragraph`, ...).
/// Obsidian's captured `sections`/`listItems` never include the swallowed
/// newline, so trim it back off when present — a no-op for any span whose
/// real last byte isn't itself `\n`.
fn trim_swallowed_trailing_newline(text: &str, span: SourceSpan) -> SourceSpan {
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
            if matches!(child, Node::List(_) | Node::FootnoteDefinition(_)) {
                span = trim_swallowed_trailing_newline(text, span);
            }
            Some(Section {
                kind: section_kind(child, text, span),
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
/// single bracketed character, e.g. `- [ ]`, `1. [x]`, `- [/]`, then either
/// whitespace or end-of-line. Matched against the raw source (never mdast's
/// `checked` field) because mdast only recognizes `[ ]`/`[x]`/`[X]` as GFM
/// checkboxes — a non-standard state like `[/]` parses as plain paragraph
/// text, with `checked: None`, yet Obsidian still reports its raw bracket
/// character (`tests/fixtures/structural/09-task-list`). The trailing
/// `(?:[ \t]|$)` requires whitespace or line-end right after `]` — without
/// it, `- [x]nospace` and `- [x](link)` would misdetect a task state that
/// Obsidian does not report (`19-task-nospace`).
static TASK_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]|$)")
        .expect("task marker pattern compiles")
});

/// Only the item's own first source line is a candidate for the marker —
/// `$` in `TASK_MARKER` must mean "end of that line", not "end of the
/// item's entire (possibly multi-line) span".
fn detect_task_char(text: &str, span: SourceSpan) -> Option<char> {
    let slice = text.get(span.start()..span.end())?;
    let first_line = slice.split('\n').next().unwrap_or(slice);
    let capture = TASK_MARKER.captures(first_line)?;
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

/// A nested item's mdast span starts where the parent's content column is —
/// the indent *left over* after the parent item's own marker is stripped is
/// part of the child item. Obsidian keeps that leftover indent when it is two
/// columns or more and drops it when it is a single space, so an item nested
/// under an ordered parent starts on its marker.
///
/// `parity-list-nested-3deep` pins both halves against one file: under `- `
/// (content column 2) a four-space indent leaves two columns and Obsidian
/// reports cols 2 and 6 — which mdast already matches — while under `1. `
/// (content column 3) the same four-space indent leaves one space and Obsidian
/// reports cols 4 and 8, one past mdast. `14-mixed-deep` rules out the other
/// reading: the item at its line 6 is *ordered* but nested under an unordered
/// parent, leaving two columns, and Obsidian reports col 2 — so the rule is
/// about the leftover indent, not about the child's own marker.
///
/// Every capture in both corpora has a leftover of exactly one or exactly two
/// columns, so "drop a lone space" and "drop the leftover under an ordered
/// parent" fit the evidence equally. The narrower, text-observable form is
/// implemented here; a capture with, say, a three-space indent under `1. `
/// would separate them.
fn trim_lone_leftover_indent_space(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let lone_space =
        bytes.get(start) == Some(&b' ') && !matches!(bytes.get(start + 1), None | Some(b' '));
    if lone_space { start + 1 } else { start }
}

/// A `ListItem`'s own span, per Obsidian's convention: the item's marker
/// through the end of its own direct (non-`List`) content, excluding any
/// nested sublist. mdast's own `ListItem.position` covers the item *and*
/// every nested sublist beneath it — Obsidian's `listItems[].position` does
/// not (verified against `07-unordered-nested` and `14-mixed-deep`, where a
/// naive `item.position` swallows the nested list that gets its own entries).
///
/// `nested` says whether this item sits under a parent *item*, which is the
/// only case where leftover indent exists at all; see
/// [`trim_lone_leftover_indent_space`].
fn item_span(body_start: usize, text: &str, item_node: &Node, nested: bool) -> Option<SourceSpan> {
    let whole = span_for(body_start, item_node)?;
    let start = if nested {
        trim_lone_leftover_indent_space(text, whole.start())
    } else {
        whole.start()
    };
    let whole = SourceSpan::new(start, whole.end()).unwrap_or(whole);
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
    Some(trim_swallowed_trailing_newline(text, span))
}

fn walk_for_list_items(
    node: &Node,
    body_start: usize,
    text: &str,
    parent_item_line: Option<u32>,
    items: &mut Vec<ListItem>,
) {
    if let Node::List(list) = node {
        let list_position = span_for(body_start, node);
        debug_assert!(
            list_position.is_some(),
            "a List node produced by to_mdast from real source text always has a position"
        );
        let list_start_line = list_position.map_or(0, |span| line_of(text, span.start()));
        for child in &list.children {
            if !matches!(child, Node::ListItem(_)) {
                continue;
            }
            let item_position = item_span(body_start, text, child, parent_item_line.is_some());
            debug_assert!(
                item_position.is_some(),
                "a ListItem node produced by to_mdast from real source text always has a position"
            );
            let Some(span) = item_position else {
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
            debug_assert!(
                items
                    .last()
                    .is_none_or(|previous: &ListItem| previous.span.start() <= span.start()),
                "list items must be pushed in ascending document order"
            );
            items.push(ListItem { span, parent, task });

            // Only a DIRECT nested `List` child continues under this item
            // (`ListItemParent::Item`); anything reached through some other
            // wrapper (e.g. a blockquote) is structurally independent and
            // gets its own `Root` treatment, per
            // `tests/fixtures/structural/21-list-in-blockquote-in-item`:
            // items inside a quoted list nested inside an item are emitted
            // as root items of that inner list, not as children of the
            // outer item.
            if let Some(grandchildren) = child.children() {
                for grandchild in grandchildren {
                    let next_parent_line = matches!(grandchild, Node::List(_)).then_some(item_line);
                    walk_for_list_items(grandchild, body_start, text, next_parent_line, items);
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
pub(crate) fn split_markdown_target(raw: &str) -> (Option<String>, Option<Subpath>) {
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
