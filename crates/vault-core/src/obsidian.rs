use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use crate::frontmatter::is_valid_tag_text;
use crate::{
    BlockId, Diagnostic, DiagnosticCode, Property, PropertyValue, Reference, ReferenceKind,
    ReferenceOrigin, Severity, SourceDocument, SourceSpan, Spanned, Subpath, Tag,
};

static TAG_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#[\p{Alphabetic}\p{N}_/-]+").expect("tag candidate pattern compiles")
});

pub(crate) struct ObsidianScan {
    pub references: Vec<Reference>,
    pub tags: Vec<Tag>,
    pub blocks: Vec<BlockId>,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn scan_text_ranges(document: &SourceDocument, ranges: &[SourceSpan]) -> ObsidianScan {
    let mut scan = ObsidianScan {
        references: Vec::new(),
        tags: Vec::new(),
        blocks: Vec::new(),
        diagnostics: Vec::new(),
    };
    let text = document.text();

    for range in coalesce(ranges) {
        let slice = &text[range.start..range.end];
        let mut consumed: Vec<Range<usize>> = Vec::new();
        scan_wikilinks(
            slice,
            range.start,
            ReferenceOrigin::Body,
            &mut scan.references,
            &mut scan.diagnostics,
            Some(&mut consumed),
        );
        for unconsumed in subtract(0..slice.len(), &consumed) {
            let sub = &slice[unconsumed.clone()];
            let base = range.start + unconsumed.start;
            scan_tags(sub, base, &mut scan.tags, &mut scan.diagnostics);
            scan_blocks(sub, base, text, &mut scan.blocks, &mut scan.diagnostics);
        }
    }
    scan
}

/// Scan every string-valued property's raw scalar source for wikilinks. The
/// scalar span is the anchor, so offsets stay correct even for quoted YAML.
pub(crate) fn scan_property_wikilinks(
    document: &SourceDocument,
    properties: &[Property],
) -> (Vec<Reference>, Vec<Diagnostic>) {
    let mut references = Vec::new();
    let mut diagnostics = Vec::new();
    let text = document.text();

    fn visit<'a>(value: &'a Spanned<PropertyValue>, out: &mut Vec<&'a Spanned<PropertyValue>>) {
        match &value.value {
            PropertyValue::String(_) => out.push(value),
            PropertyValue::Sequence(items) => {
                for item in items {
                    visit(item, out);
                }
            }
            PropertyValue::Mapping(entries) => {
                for (_, entry) in entries {
                    visit(entry, out);
                }
            }
            _ => {}
        }
    }

    for property in properties {
        let mut strings = Vec::new();
        visit(&property.value, &mut strings);
        for spanned in strings {
            let Some(slice) = text.get(spanned.span.start()..spanned.span.end()) else {
                continue;
            };
            scan_wikilinks(
                slice,
                spanned.span.start(),
                ReferenceOrigin::Property,
                &mut references,
                &mut diagnostics,
                None,
            );
        }
    }
    (references, diagnostics)
}

fn coalesce(ranges: &[SourceSpan]) -> Vec<Range<usize>> {
    let mut sorted: Vec<Range<usize>> =
        ranges.iter().map(|span| span.start()..span.end()).collect();
    sorted.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(sorted.len());
    for range in sorted {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

fn subtract(full: Range<usize>, consumed: &[Range<usize>]) -> Vec<Range<usize>> {
    let mut remaining = Vec::new();
    let mut cursor = full.start;
    for range in consumed {
        if range.start > cursor {
            remaining.push(cursor..range.start);
        }
        cursor = cursor.max(range.end);
    }
    if cursor < full.end {
        remaining.push(cursor..full.end);
    }
    remaining
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    index > 0 && bytes[index - 1] == b'\\'
}

fn scan_wikilinks(
    slice: &str,
    base: usize,
    origin: ReferenceOrigin,
    references: &mut Vec<Reference>,
    diagnostics: &mut Vec<Diagnostic>,
    mut consumed: Option<&mut Vec<Range<usize>>>,
) {
    let bytes = slice.as_bytes();
    let mut search = 0;
    while let Some(found) = slice[search..].find("[[") {
        let open = search + found;
        let mut start = open;
        let mut kind = ReferenceKind::Wikilink;
        if open >= 1 && bytes[open - 1] == b'!' && !is_escaped(bytes, open - 1) {
            start = open - 1;
            kind = ReferenceKind::WikiEmbed;
        }
        if is_escaped(bytes, start) {
            search = open + 2;
            continue;
        }

        let Some(close_offset) = slice[open + 2..].find("]]") else {
            diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MalformedWikilink,
                    Severity::Warning,
                    "wikilink is never closed",
                )
                .with_span(
                    SourceSpan::new(base + start, base + slice.len())
                        .expect("opener span is ordered"),
                ),
            );
            return;
        };
        let close = open + 2 + close_offset;
        let inner = &slice[open + 2..close];

        let (target, display) = match find_unescaped(inner, b'|') {
            Some(bar) => (&inner[..bar], Some(inner[bar + 1..].to_string())),
            None => (inner, None),
        };
        let target_start = base + open + 2;
        let target_span = SourceSpan::new(target_start, target_start + target.len())
            .expect("target span is ordered");
        let (file_target, subpath) = split_wikilink_target(target);

        references.push(Reference {
            kind,
            origin,
            raw_target: target.to_string(),
            file_target,
            subpath,
            display: display.filter(|value| !value.is_empty()),
            span: SourceSpan::new(base + start, base + close + 2)
                .expect("reference span is ordered"),
            target_span,
        });
        if let Some(consumed) = consumed.as_deref_mut() {
            consumed.push(start..close + 2);
        }
        search = close + 2;
    }
}

fn find_unescaped(text: &str, needle: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            byte if byte == needle => return Some(index),
            _ => {}
        }
        index += 1;
    }
    None
}

fn split_wikilink_target(target: &str) -> (Option<String>, Option<Subpath>) {
    let (file, fragment) = match target.split_once('#') {
        Some((file, fragment)) => (file, Some(fragment)),
        None => (target, None),
    };
    let file_target = (!file.is_empty()).then(|| file.to_string());
    let subpath = fragment.and_then(|fragment| {
        if fragment.is_empty() {
            None
        } else if let Some(block) = fragment.strip_prefix('^') {
            Some(Subpath::Block(block.to_string()))
        } else {
            Some(Subpath::Heading(fragment.to_string()))
        }
    });
    (file_target, subpath)
}

fn is_tag_boundary(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(c) => !(c.is_alphanumeric() || matches!(c, '_' | '-' | '/' | '#')),
    }
}

fn scan_tags(slice: &str, base: usize, tags: &mut Vec<Tag>, diagnostics: &mut Vec<Diagnostic>) {
    for candidate in TAG_CANDIDATE.find_iter(slice) {
        let start = candidate.start();
        let previous = slice[..start].chars().next_back();
        if previous == Some('\\') || !is_tag_boundary(previous) {
            continue;
        }
        let text = &candidate.as_str()[1..];
        let span =
            SourceSpan::new(base + start, base + candidate.end()).expect("tag span is ordered");
        if text.split('/').any(str::is_empty) {
            diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MalformedTag,
                    Severity::Warning,
                    format!("tag has an empty segment: {:?}", candidate.as_str()),
                )
                .with_span(span),
            );
        } else if is_valid_tag_text(text) {
            tags.push(Tag {
                value: text.to_string(),
                comparison_key: text.to_lowercase(),
                span,
            });
        }
    }
}

fn scan_blocks(
    slice: &str,
    base: usize,
    document_text: &str,
    blocks: &mut Vec<BlockId>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let bytes = slice.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'^' || is_escaped(bytes, index) {
            index += 1;
            continue;
        }
        let preceded_ok = index == 0 || bytes[index - 1].is_ascii_whitespace();
        let mut end = index + 1;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
            end += 1;
        }
        if !preceded_ok || end == index + 1 {
            index += 1;
            continue;
        }

        let absolute_end = base + end;
        let rest_of_line = document_text[absolute_end..]
            .split_terminator('\n')
            .next()
            .unwrap_or("");
        let value = &slice[index + 1..end];
        let span = SourceSpan::new(base + index, absolute_end).expect("block span is ordered");
        if rest_of_line
            .trim_end_matches('\r')
            .chars()
            .all(|c| c == ' ')
        {
            blocks.push(BlockId {
                value: value.to_string(),
                span,
            });
        } else {
            diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MalformedBlockId,
                    Severity::Warning,
                    format!("block id ^{value} is not at the end of a line"),
                )
                .with_span(span),
            );
        }
        index = end;
    }
}
