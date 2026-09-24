use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use crate::frontmatter::is_valid_tag_text;
use crate::markdown::split_markdown_target;
use crate::{
    BlockId, Diagnostic, DiagnosticCode, Property, PropertyValue, Reference, ReferenceKind,
    ReferenceOrigin, Severity, SourceDocument, SourceSpan, Spanned, Subpath, Tag,
};

/// The run of characters a `#` can start.
///
/// Obsidian documents a tag as letters, numbers, underscore, hyphen and
/// forward slash — and `parity-tags-nested-unicode` shows it also keeping a
/// Unicode **symbol** inside the value: `#tag-🙂` is captured whole, where this
/// class once stopped at the emoji and reported `#tag-`. That is a *category*
/// question and not an astral-plane one — `#tag-☺` (U+263A) is in the BMP and
/// truncated the same way, while `#tag-𝐀` (U+1D400) is astral and never did,
/// because it is a letter.
///
/// So the class is the documented set plus the Unicode Symbol categories
/// **outside ASCII** — `[\p{S}&&[^\x00-\x7F]]`. Punctuation stays out, which
/// is what ends `#parent/child/grandchild.` before its full stop in the same
/// capture.
///
/// **Why the ASCII symbols are excluded, though `\p{S}` would cover them.**
/// The capture demonstrates one thing: a *non-ASCII* symbol stays inside a tag
/// value. Admitting non-ASCII symbols explains that completely; admitting
/// `+ = ^ $ ~ < > |` and the backtick as well explains nothing further and
/// changes what nine characters that appear constantly in ASCII prose mean.
/// The two errors are not symmetric. Too narrow truncates a tag exactly where
/// this scanner already truncated it before the fix — no regression, and the
/// damage is visible as a short tag. Too wide silently **invents** tag values
/// Obsidian never reported: new rows in the tag index, changed values and end
/// offsets, and tag searches that disagree with Obsidian over the same vault.
/// Widening later on a new capture is a one-character edit; unwinding a wrong
/// widening means re-indexing. Accepting U+1F642 is equally consistent with
/// "stop at ASCII punctuation and ASCII symbols, keep everything else", which
/// is what Obsidian's own documentation describes for the ASCII range.
///
/// ASCII-versus-non-ASCII is not a principled Unicode boundary, so this is a
/// holding position, not a finding. **The capture that settles it** is
/// **Captured 2026-09-24 on a live Obsidian: `#tag #a #c #p #tag-☺`,**
/// **exactly this class.** The line below was the pending experiment:
/// `#tag+more #a=b #c^d #p$ #tag-☺` written into a scratch note and read back
/// through `app.metadataCache.getFileCache` on a live Obsidian 1.13.4 — a
/// minute's work for whoever next has the app open, and it belongs in the
/// corpus before this reaches a real vault. Characters a symbol sequence can
/// carry but no capture shows — a variation selector (`Mn`), a zero-width
/// joiner (`Cf`) — are outside the class for the same reason.
///
/// [`crate::frontmatter::is_valid_tag_text`] validates the same set, for tags
/// that arrive through frontmatter rather than through this scan.
static TAG_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#[\p{Alphabetic}\p{N}_/\-[\p{S}&&[^\x00-\x7F]]]+")
        .expect("tag candidate pattern compiles")
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

/// Scan every string-valued property's raw scalar source for references. The
/// scalar span is the anchor, so offsets stay correct even for quoted YAML.
///
/// Both written forms count. Obsidian reports a Markdown link in a property
/// under `frontmatterLinks` exactly as it reports a wikilink there —
/// `parity-frontmatter-links` captures `related.1` as
/// `[Markdown target](Parity%20target.md)` with `link: "Parity target.md"` —
/// so scanning only the wikilink form dropped the reference entirely. The
/// wikilink scan runs first and the Markdown scan sees only what it did not
/// consume, which is what keeps `[[Target]]` from also reading as a Markdown
/// label.
///
/// **Known gap: a `"…"` link title inside a double-quoted YAML scalar.** The
/// scan reads the *raw source* deliberately, so that a span stays correct for
/// a quoted scalar; the cost is that YAML's own escapes are still in the text
/// it reads. `t: "[Label](Target.md \"A title\")"` therefore finds `\"` where
/// a closing quote belongs, fails the closing-paren check, and yields no
/// reference. The single-quoted spellings — `t: '[Label](Target.md "A
/// title")'` and a `'…'` title — both work, as does the same link in the body.
/// This is the same raw-source-versus-YAML-escape tension the wikilink scan
/// already lives with rather than a new one, and no capture covers it;
/// unescaping would have to keep a byte-exact map back to the raw span.
pub(crate) fn scan_property_references(
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
            let mut consumed: Vec<Range<usize>> = Vec::new();
            scan_wikilinks(
                slice,
                spanned.span.start(),
                ReferenceOrigin::Property,
                &mut references,
                &mut diagnostics,
                Some(&mut consumed),
            );
            for unconsumed in subtract(0..slice.len(), &consumed) {
                scan_markdown_links(
                    &slice[unconsumed.clone()],
                    spanned.span.start() + unconsumed.start,
                    ReferenceOrigin::Property,
                    &mut references,
                );
            }
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

/// One inline Markdown link, located in raw source text. Every range is
/// relative to the slice it was found in.
struct MarkdownLinkMatch {
    whole: Range<usize>,
    label: Range<usize>,
    destination: Range<usize>,
    kind: ReferenceKind,
}

/// Scan a slice of raw source for inline Markdown links and embeds.
///
/// This is the property-value counterpart of the body's CommonMark walk, which
/// never sees frontmatter. It reads the source directly — a property value is
/// a YAML scalar, not a Markdown document, so there is no mdast to walk — and
/// recognises the inline form only: a reference-style link has no destination
/// to resolve inside a property, and no capture shows Obsidian resolving one
/// there. The embed form (`![label](target)`) is scanned for symmetry with the
/// wikilink scanner, which reads `![[…]]` in a property; no capture exercises
/// it.
fn scan_markdown_links(
    slice: &str,
    base: usize,
    origin: ReferenceOrigin,
    references: &mut Vec<Reference>,
) {
    let mut search = 0;
    while let Some(offset) = slice[search..].find('[') {
        let index = search + offset;
        let Some(found) = parse_markdown_link(slice, index) else {
            // With no `]` left after this bracket, no later `[` can close
            // either — so a run of unmatched brackets ends the scan here
            // instead of rescanning the tail once per bracket.
            if !slice[index + 1..].contains(']') {
                return;
            }
            search = index + 1;
            continue;
        };
        let raw_target = slice[found.destination.clone()].to_string();
        let (file_target, subpath) = split_markdown_target(&raw_target);
        let display = slice[found.label].to_string();
        let target_span =
            SourceSpan::new(base + found.destination.start, base + found.destination.end)
                .expect("destination span is ordered");
        references.push(Reference {
            kind: found.kind,
            origin,
            raw_target,
            file_target,
            subpath,
            display: (!display.is_empty()).then_some(display),
            span: SourceSpan::new(base + found.whole.start, base + found.whole.end)
                .expect("reference span is ordered"),
            target_span,
        });
        search = found.whole.end;
    }
}

/// Parse one inline Markdown link whose label opens at `index`, or return
/// `None` when the text there is not one.
///
/// Byte scanning is safe over UTF-8: every position this function stops at is
/// an ASCII delimiter, and a continuation byte matches no arm.
///
/// Escaping is [`is_escaped`]'s, which reads one byte back and so treats `\\[`
/// — an escaped backslash *before* a bracket — as an escaped bracket. That is
/// pre-existing and shared with [`scan_wikilinks`]; the two stay consistent
/// rather than one of them being quietly stricter.
fn parse_markdown_link(slice: &str, index: usize) -> Option<MarkdownLinkMatch> {
    let bytes = slice.as_bytes();
    if bytes.get(index) != Some(&b'[') || is_escaped(bytes, index) {
        return None;
    }
    let mut start = index;
    let mut kind = ReferenceKind::MarkdownLink;
    if index >= 1 && bytes[index - 1] == b'!' && !is_escaped(bytes, index - 1) {
        start = index - 1;
        kind = ReferenceKind::MarkdownEmbed;
    }

    let mut cursor = index + 1;
    let mut depth = 1usize;
    while cursor < bytes.len() && depth > 0 {
        match bytes[cursor] {
            b'\\' => cursor += 1,
            b'[' => depth += 1,
            b']' => depth -= 1,
            b'\n' => return None,
            _ => {}
        }
        cursor += 1;
    }
    if depth != 0 || bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    let label = index + 1..cursor - 1;
    cursor += 1;

    while matches!(bytes.get(cursor), Some(byte) if byte.is_ascii_whitespace()) {
        cursor += 1;
    }
    let destination = if bytes.get(cursor) == Some(&b'<') {
        let opened = cursor + 1;
        let mut end = opened;
        loop {
            match bytes.get(end) {
                Some(b'\\') => end += 2,
                Some(b'>') => break,
                Some(_) => end += 1,
                None => return None,
            }
        }
        cursor = end + 1;
        opened..end
    } else {
        let opened = cursor;
        let mut parens = 0usize;
        while cursor < bytes.len() {
            match bytes[cursor] {
                b'\\' => cursor += 1,
                b'(' => parens += 1,
                b')' => {
                    if parens == 0 {
                        break;
                    }
                    parens -= 1;
                }
                byte if byte.is_ascii_whitespace() => break,
                _ => {}
            }
            cursor += 1;
        }
        opened..cursor.min(bytes.len())
    };

    // An optional title, then the closing parenthesis.
    while matches!(bytes.get(cursor), Some(byte) if byte.is_ascii_whitespace()) {
        cursor += 1;
    }
    if let Some(&quote @ (b'"' | b'\'')) = bytes.get(cursor) {
        cursor += 1;
        loop {
            match bytes.get(cursor) {
                Some(b'\\') => cursor += 2,
                Some(byte) if *byte == quote => break,
                Some(_) => cursor += 1,
                None => return None,
            }
        }
        cursor += 1;
        while matches!(bytes.get(cursor), Some(byte) if byte.is_ascii_whitespace()) {
            cursor += 1;
        }
    }
    if bytes.get(cursor) != Some(&b')') {
        return None;
    }

    Some(MarkdownLinkMatch {
        whole: start..cursor + 1,
        label,
        destination,
        kind,
    })
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
