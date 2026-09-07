//! Span-surgical frontmatter editing.
//!
//! Every edit becomes one byte range and its replacement; the ranges are
//! applied back to front, so no earlier edit invalidates a later span. Bytes
//! outside those ranges are never touched — which is the whole point, and is
//! what `tests/frontmatter_patch.rs` and its property test assert.
//!
//! Two granularities, per the design's correction #9. The index stores spans
//! per **top-level** frontmatter key and no deeper:
//!
//! * an edit addressing a top-level key splices that key's stored value span,
//!   or deletes the key's line range — every other byte of the document is
//!   untouched;
//! * an edit addressing anything *below* a top-level key has no stored span of
//!   its own, so the smallest enclosing top-level property is deserialized,
//!   edited in memory, and re-emitted in the addition dialect. One property's
//!   lines move; key order, every other property, comments, whitespace, and
//!   the entire body do not.
//!
//! What is still refused is only what has no value to address at all:
//! descending into a scalar, indexing a sequence with a non-numeric segment,
//! or indexing one past its end on a set.
//!
//! Spans come from `vault_core::parse_note`, which already converts saphyr's
//! char-indexed markers into byte offsets into the whole document. Nothing
//! here re-derives them.

use std::collections::BTreeMap;
use std::ops::Range;

use vault_core::{Property, PropertyValue, SourceDocument, VaultPath, parse_note};

use super::MutationError;

/// One frontmatter value a patch sets. No null variant: a JSON `null` in
/// `value` is the deletion spelling, and arrives as `FrontmatterEdit::value
/// == None`.
#[derive(Clone, Debug, PartialEq)]
pub enum PatchValue {
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<PatchValue>),
    Mapping(Vec<(String, PatchValue)>),
}

/// One addressed key and what becomes of it.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontmatterEdit {
    /// The dot-path, already split into segments.
    pub key_path: Vec<String>,
    /// `None` deletes the addressed key.
    pub value: Option<PatchValue>,
}

struct Splice {
    range: Range<usize>,
    replacement: String,
}

/// The re-serialization tree.
///
/// Deliberately not [`PatchValue`]: this one has to represent a value that is
/// *already in the document*, and a document may hold a null. [`PatchValue`]
/// has no null variant on purpose — a JSON `null` on the wire is the deletion
/// spelling — so a stored null would have nowhere to go and a round trip
/// through the caller's type would corrupt it.
#[derive(Clone, Debug, PartialEq)]
enum Yaml {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<Yaml>),
    Mapping(Vec<(String, Yaml)>),
}

impl From<&PatchValue> for Yaml {
    fn from(value: &PatchValue) -> Self {
        match value {
            PatchValue::Boolean(value) => Self::Boolean(*value),
            PatchValue::Integer(value) => Self::Integer(*value),
            PatchValue::Float(value) => Self::Float(*value),
            PatchValue::String(value) => Self::String(value.clone()),
            PatchValue::Sequence(items) => Self::Sequence(items.iter().map(Self::from).collect()),
            PatchValue::Mapping(entries) => Self::Mapping(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from(value)))
                    .collect(),
            ),
        }
    }
}

impl From<&PropertyValue> for Yaml {
    /// Total, and it must stay total: this is what makes re-serializing an
    /// enclosing property safe. A shape this could not represent would be a
    /// shape the round trip silently dropped.
    fn from(value: &PropertyValue) -> Self {
        match value {
            PropertyValue::Null => Self::Null,
            PropertyValue::Boolean(value) => Self::Boolean(*value),
            PropertyValue::Integer(value) => Self::Integer(*value),
            PropertyValue::Float(value) => Self::Float(*value),
            PropertyValue::String(value) => Self::String(value.clone()),
            PropertyValue::Sequence(items) => {
                Self::Sequence(items.iter().map(|item| Self::from(&item.value)).collect())
            }
            PropertyValue::Mapping(entries) => Self::Mapping(
                entries
                    .iter()
                    .map(|(key, value)| (key.value.clone(), Self::from(&value.value)))
                    .collect(),
            ),
        }
    }
}

/// Where a new top-level key goes.
enum Fence {
    /// The offset of the closing `---`, so an addition lands just before it.
    Closing(usize),
    /// No frontmatter block at all: one has to be synthesized.
    Absent,
    /// A block that opens and never closes. Prepending a second fence would
    /// bury the first, so this is refused instead.
    Unterminated,
}

/// Apply `edits` to `source`, returning the patched document.
pub fn patch_source(
    path: &VaultPath,
    source: &str,
    edits: &[FrontmatterEdit],
) -> Result<String, MutationError> {
    if edits.is_empty() {
        return Ok(source.to_string());
    }
    let note = parse_note(SourceDocument::new(path.clone(), source.to_string()));

    // Group by top-level key, keeping first-appearance order so additions land
    // in the order the caller wrote them. Grouping is what lets two edits under
    // one key (`a.b` and `a.c`) become one re-serialization instead of two
    // conflicting ones.
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<&FrontmatterEdit>> = BTreeMap::new();
    for edit in edits {
        if edit.key_path.is_empty() || edit.key_path.iter().any(String::is_empty) {
            return Err(MutationError::UnaddressablePatch {
                key_path: edit.key_path.join("."),
            });
        }
        let first = &edit.key_path[0];
        if !groups.contains_key(first) {
            order.push(first.clone());
        }
        groups.entry(first.clone()).or_default().push(edit);
    }
    // Two edits addressing the identical path have no defined result, at any
    // depth. Refusing beats picking one silently.
    for group in groups.values() {
        for (index, edit) in group.iter().enumerate() {
            if group[..index]
                .iter()
                .any(|earlier| earlier.key_path == edit.key_path)
            {
                return Err(MutationError::OverlappingPatch);
            }
        }
    }

    let mut splices: Vec<Splice> = Vec::new();
    let mut additions: Vec<String> = Vec::new();
    for key in &order {
        let group = &groups[key];
        match note
            .properties
            .iter()
            .find(|property| &property.key.value == key)
        {
            Some(property) => {
                if let Some(splice) = plan_existing(source, property, group)? {
                    splices.push(splice);
                }
            }
            None => {
                if let Some(line) = plan_addition(key, group)? {
                    additions.push(line);
                }
            }
        }
    }

    // Every addition shares one anchor, and the fence is synthesized **once**.
    // Letting each addition wrap itself would emit one `---` block per new key
    // in a document that had no frontmatter, and only the first would be
    // frontmatter at all.
    if !additions.is_empty() {
        match closing_fence(source) {
            Fence::Closing(fence) => splices.push(Splice {
                range: fence..fence,
                replacement: additions.concat(),
            }),
            Fence::Absent => splices.push(Splice {
                range: 0..0,
                replacement: format!("---\n{}---\n", additions.concat()),
            }),
            Fence::Unterminated => {
                return Err(MutationError::MalformedFrontmatter { path: path.clone() });
            }
        }
    }

    splices.sort_by_key(|splice| (splice.range.start, splice.range.end));
    for window in splices.windows(2) {
        if window[0].range.end > window[1].range.start {
            return Err(MutationError::OverlappingPatch);
        }
    }
    // Back to front, so no earlier splice invalidates a later span. The
    // addition anchor sits at or past every property's end, so it is applied
    // first and the property splices below it stay valid.
    let mut patched = source.to_string();
    for splice in splices.iter().rev() {
        patched.replace_range(splice.range.clone(), &splice.replacement);
    }
    Ok(patched)
}

/// The splice for one top-level key that **exists** in the document.
fn plan_existing(
    source: &str,
    property: &Property,
    group: &[&FrontmatterEdit],
) -> Result<Option<Splice>, MutationError> {
    let indent = indent_of(source, property.key.span.start());
    // The key's whole entry, terminator included: the stored span stops at the
    // value, so a deletion that used it would leave a blank line behind.
    let entry =
        line_start(source, property.span.start())..line_end(source, property.value.span.end());

    // At the stored granularity: pure span surgery, nothing re-serialized.
    if group.len() == 1 && group[0].key_path.len() == 1 {
        return Ok(Some(match &group[0].value {
            Some(value) => Splice {
                // The replacement owns the separator after the `:`, so it can
                // choose one space for a scalar and a newline for a block.
                range: after_colon(source, property.key.span.end())..property.value.span.end(),
                replacement: after_key(&Yaml::from(value), indent),
            },
            None => Splice {
                range: entry,
                replacement: String::new(),
            },
        }));
    }
    // Replacing a key and editing something inside it in one patch has no
    // defined order either.
    if group.iter().any(|edit| edit.key_path.len() == 1) {
        return Err(MutationError::OverlappingPatch);
    }

    // Below the stored granularity: deserialize, apply, re-emit.
    let mut root = Yaml::from(&property.value.value);
    for edit in group {
        let key_path = edit.key_path.join(".");
        let replacement = edit.value.as_ref().map(Yaml::from);
        apply_nested(
            &mut root,
            &edit.key_path[1..],
            replacement.as_ref(),
            &key_path,
        )?;
    }
    Ok(Some(Splice {
        range: entry,
        replacement: format!(
            "{}{}:{}\n",
            " ".repeat(indent),
            property.key.value,
            after_key(&root, indent)
        ),
    }))
}

/// The new line for one top-level key that is **not** in the document.
///
/// A multi-segment path creates every intermediate mapping — `processFrontMatter`
/// parity, and the alternative would make a plugin's first write to a nested
/// key fail while its second succeeded.
fn plan_addition(key: &str, group: &[&FrontmatterEdit]) -> Result<Option<String>, MutationError> {
    // Deleting a key that is not there is a no-op, at every depth.
    if group.iter().all(|edit| edit.value.is_none()) {
        return Ok(None);
    }
    if group.len() == 1 && group[0].key_path.len() == 1 {
        let value = group[0]
            .value
            .as_ref()
            .expect("a set was established just above");
        return Ok(Some(format!(
            "{key}:{}\n",
            after_key(&Yaml::from(value), 0)
        )));
    }
    let mut root = Yaml::Mapping(Vec::new());
    for edit in group {
        if edit.key_path.len() == 1 {
            return Err(MutationError::OverlappingPatch);
        }
        let key_path = edit.key_path.join(".");
        let replacement = edit.value.as_ref().map(Yaml::from);
        apply_nested(
            &mut root,
            &edit.key_path[1..],
            replacement.as_ref(),
            &key_path,
        )?;
    }
    Ok(Some(format!("{key}:{}\n", after_key(&root, 0))))
}

/// Apply one edit to an in-memory value, `segments` deep.
///
/// `new = None` deletes. A missing intermediate is created on a set and
/// ignored on a delete; a scalar in the way is refused, because turning it
/// into a mapping would discard the value the caller never mentioned.
fn apply_nested(
    target: &mut Yaml,
    segments: &[String],
    new: Option<&Yaml>,
    key_path: &str,
) -> Result<(), MutationError> {
    let unaddressable = || MutationError::UnaddressablePatch {
        key_path: key_path.to_string(),
    };
    let Some(segment) = segments.first() else {
        return Err(unaddressable());
    };
    let last = segments.len() == 1;
    match target {
        Yaml::Mapping(entries) => match entries.iter().position(|(key, _)| key == segment) {
            Some(index) => {
                if !last {
                    return apply_nested(&mut entries[index].1, &segments[1..], new, key_path);
                }
                match new {
                    Some(value) => entries[index].1 = value.clone(),
                    None => {
                        entries.remove(index);
                    }
                }
                Ok(())
            }
            None => {
                let Some(value) = new else {
                    return Ok(());
                };
                entries.push((segment.clone(), wrap(&segments[1..], value)));
                Ok(())
            }
        },
        Yaml::Sequence(items) => {
            let Ok(index) = segment.parse::<usize>() else {
                return Err(unaddressable());
            };
            if index >= items.len() {
                // Nothing there: a delete is a no-op, a set has nowhere to go.
                return match new {
                    None => Ok(()),
                    Some(_) => Err(unaddressable()),
                };
            }
            if !last {
                return apply_nested(&mut items[index], &segments[1..], new, key_path);
            }
            match new {
                Some(value) => items[index] = value.clone(),
                None => {
                    items.remove(index);
                }
            }
            Ok(())
        }
        _ => Err(unaddressable()),
    }
}

/// `value` wrapped in a mapping per remaining segment, innermost last.
fn wrap(segments: &[String], value: &Yaml) -> Yaml {
    match segments.split_first() {
        None => value.clone(),
        Some((head, rest)) => Yaml::Mapping(vec![(head.clone(), wrap(rest, value))]),
    }
}

/// The offset of the first byte of the line containing `offset`.
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind('\n').map_or(0, |index| index + 1)
}

/// The offset just past the line terminator that ends the line containing
/// `offset`. The stored property span stops at the value, so a deletion has
/// to extend through the terminator itself — otherwise the key vanishes and
/// an empty line takes its place.
fn line_end(source: &str, offset: usize) -> usize {
    match source[offset..].find('\n') {
        Some(index) => offset + index + 1,
        None => source.len(),
    }
}

/// The indentation column of the line containing `offset`.
fn indent_of(source: &str, offset: usize) -> usize {
    let start = line_start(source, offset);
    source[start..offset]
        .bytes()
        .take_while(|byte| *byte == b' ')
        .count()
}

/// The offset just past the `:` that separates `key_span_end` from its value,
/// so a replacement can own the separator and choose its own spacing.
fn after_colon(source: &str, key_span_end: usize) -> usize {
    match source[key_span_end..].find(':') {
        Some(index) => key_span_end + index + 1,
        None => key_span_end,
    }
}

/// Where a new top-level key is inserted: immediately before the closing
/// fence.
fn closing_fence(source: &str) -> Fence {
    let payload_start = if source.starts_with("---\n") {
        4
    } else if source.starts_with("---\r\n") {
        5
    } else {
        return Fence::Absent;
    };
    let mut offset = payload_start;
    for line in source[payload_start..].split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == "---" {
            return Fence::Closing(offset);
        }
        offset += line.len();
    }
    Fence::Unterminated
}

/// Serialize `value` exactly as it appears after its key's `:` — the
/// separator included, so a scalar gets one space and a block collection gets
/// a newline instead of a dangling space. The reference vault's dominant
/// obsidian-linter style: block sequences and mappings indented two spaces
/// past their key, scalars inline.
fn after_key(value: &Yaml, indent: usize) -> String {
    match value {
        // A bare `key:` — the linter's empty-value style, and what a document
        // that already held one round-trips back to.
        Yaml::Null => String::new(),
        Yaml::Boolean(value) => format!(" {value}"),
        Yaml::Integer(value) => format!(" {value}"),
        Yaml::Float(value) => format!(" {}", float(*value)),
        Yaml::String(value) => format!(" {}", scalar(value)),
        Yaml::Sequence(items) if items.is_empty() => " []".to_string(),
        Yaml::Sequence(items) => {
            let pad = " ".repeat(indent + 2);
            let mut text = String::new();
            for item in items {
                text.push('\n');
                text.push_str(&pad);
                text.push_str("- ");
                text.push_str(&one_line(item, Style::Block));
            }
            text
        }
        Yaml::Mapping(entries) if entries.is_empty() => " {}".to_string(),
        Yaml::Mapping(entries) => {
            let pad = " ".repeat(indent + 2);
            let mut text = String::new();
            for (key, value) in entries {
                text.push('\n');
                text.push_str(&pad);
                // A key is a scalar and gets a scalar's quoting. A key path
                // segment is whatever the caller sent, so `on` or `1.5` can
                // reach here, and bare it would come back a bool or a float
                // — or, for `mapping keys must be strings`, not come back at
                // all.
                text.push_str(&scalar(key));
                text.push(':');
                text.push_str(&after_key(value, indent + 2));
            }
            text
        }
    }
}

/// Where a one-line value sits, which is what decides how hard a string has
/// to be quoted.
#[derive(Clone, Copy)]
enum Style {
    /// A `- ` item on its own line. A `,` or a bracket is an ordinary
    /// character here.
    Block,
    /// Inside a flow collection, where a `,` or a bracket ends the token.
    Flow,
}

/// One value on a single line. Collections nested inside a sequence take flow
/// style, which keeps the block form to one level and stays unambiguous.
fn one_line(value: &Yaml, style: Style) -> String {
    match value {
        Yaml::Null => "null".to_string(),
        Yaml::Boolean(value) => value.to_string(),
        Yaml::Integer(value) => value.to_string(),
        Yaml::Float(value) => float(*value),
        Yaml::String(value) => match style {
            Style::Block => scalar(value),
            Style::Flow => flow_scalar(value),
        },
        Yaml::Sequence(items) => {
            let rendered: Vec<String> = items
                .iter()
                .map(|item| one_line(item, Style::Flow))
                .collect();
            format!("[{}]", rendered.join(", "))
        }
        Yaml::Mapping(entries) => {
            let rendered: Vec<String> = entries
                .iter()
                .map(|(key, value)| {
                    format!("{}: {}", flow_scalar(key), one_line(value, Style::Flow))
                })
                .collect();
            format!("{{{}}}", rendered.join(", "))
        }
    }
}

/// A float that still reads as a float. `1.0` formats as `1` by default,
/// which YAML would read back as an integer — so a whole-numbered finite
/// float gets its `.0` back.
fn float(value: f64) -> String {
    let rendered = format!("{value}");
    if rendered.contains(['.', 'e', 'E']) || !value.is_finite() {
        rendered
    } else {
        format!("{rendered}.0")
    }
}

/// Quote a string only when leaving it bare would change its meaning: empty,
/// padded with whitespace, opening with a YAML indicator, carrying a `: ` or
/// ` #`, spanning lines, or spelling a bool, null, or number.
///
/// Block context — after a `key:` or on a `- ` line — where a `,` or a
/// bracket is an ordinary character. [`flow_scalar`] is the same judgement
/// inside a flow collection, where they are not.
fn scalar(text: &str) -> String {
    let indicators = [
        '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@',
        '`',
    ];
    let needs_quotes = text.is_empty()
        || text != text.trim()
        || text.starts_with(indicators)
        || text.contains(": ")
        || text.contains(" #")
        || text.contains('\n')
        || matches!(
            text.to_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~"
        )
        || text.parse::<f64>().is_ok();
    if needs_quotes {
        quote(text)
    } else {
        text.to_string()
    }
}

/// [`scalar`] inside a flow collection, where `,`, `[`, `]`, `{`, `}` and `:`
/// end the token **wherever** they appear rather than only at the start.
///
/// Without this, `[["a, b"]]` is emitted as `[[a, b]]` and reads back as two
/// items — the caller's one value silently becoming two, which is the exact
/// class of quiet corruption this whole module exists to prevent. The same
/// string on a block `- ` line stays bare, because there it means itself.
fn flow_scalar(text: &str) -> String {
    if text.contains([',', '[', ']', '{', '}', ':']) {
        quote(text)
    } else {
        scalar(text)
    }
}

/// The double-quoted form.
///
/// A literal newline inside double quotes is legal YAML and *folds to a
/// space* on the way back, so a multi-line string would round-trip as a
/// single line. Written as the `\n` escape instead, along with the tab and
/// carriage return that have the same problem.
fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}
