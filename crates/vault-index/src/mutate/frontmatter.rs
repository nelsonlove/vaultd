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
//!   lines move; key order, every other property, and the entire body do not.
//!   Inside that one property the re-emit normalizes: indentation becomes the
//!   dialect's two spaces and **comments between its own lines are dropped**.
//!   Correction #9 licenses exactly that, and nothing outside the property is
//!   touched either way.
//!
//! What is still refused is only what has no value to address at all:
//! descending into a scalar, indexing a sequence with a non-numeric segment,
//! or indexing one past its end on a set — plus two document-level refusals
//! ([`MutationError::MalformedFrontmatter`] and
//! [`MutationError::AnchoredProperty`]) for frontmatter where *any* edit
//! would damage bytes outside the property it addresses.
//!
//! Spans come from `vault_core::parse_properties`, which already converts saphyr's
//! char-indexed markers into byte offsets into the whole document. Nothing
//! here re-derives them — but two stored shapes need correcting before they
//! can be spliced, and [`value_end`] is the one place that happens.

use std::collections::BTreeMap;
use std::ops::Range;

use vault_core::{Property, PropertyValue, SourceDocument, Spanned, VaultPath, parse_properties};

use super::MutationError;

/// One frontmatter value a patch sets.
///
/// [`PatchValue::Null`] is the value a caller asked for *explicitly* — the
/// wire's `set_null: true` — and it writes a YAML null. It is not the
/// deletion spelling: a JSON `null` in `value` still deletes, and arrives as
/// `FrontmatterEdit::value == None`. The two have to stay distinguishable,
/// because `processFrontMatter` parity turns on exactly that difference:
/// `fm.key = null` leaves a null-valued key behind, `delete fm.key` does not.
#[derive(Clone, Debug, PartialEq)]
pub enum PatchValue {
    Null,
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
    /// A null the document already spells for itself, which in this vault's
    /// dialect is the bare `key:` the linter writes. Round-tripping one back
    /// through a re-serialization must not respell it.
    Null,
    /// A null the caller just asked for, spelled `null` — what Obsidian's own
    /// `stringifyYaml` emits for `fm.key = null`, and what a reader of the
    /// note sees as a deliberate null rather than an empty property.
    ExplicitNull,
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
            PatchValue::Null => Self::ExplicitNull,
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
    // `parse_properties`, not `parse_note`: a frontmatter edit never looks at
    // the body, and the body parse is where arbitrary user content meets an
    // upstream Markdown parser that panics on some legal input. A patch had no
    // use for the result and every reason not to run it.
    let properties = parse_properties(&SourceDocument::new(path.clone(), source.to_string()));

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

    // Emitted lines take the document's own terminator. Mixing them parses
    // fine and churns every diff, which is the opposite of what this module
    // is for.
    let newline = dominant_newline(source);
    let payload = payload_range(source);

    let mut splices: Vec<Splice> = Vec::new();
    let mut additions: Vec<String> = Vec::new();
    for key in &order {
        let group = &groups[key];
        match properties
            .iter()
            .find(|property| &property.key.value == key)
        {
            Some(property) => {
                if let Some(payload) = payload.clone() {
                    if let Some(anchor) =
                        aliased_anchor(source, payload, entry_range(source, property))
                    {
                        return Err(MutationError::AnchoredProperty {
                            path: path.clone(),
                            anchor,
                        });
                    }
                }
                if let Some(splice) = plan_existing(source, property, group, newline)? {
                    splices.push(splice);
                }
            }
            None => {
                if let Some(line) = plan_addition(key, group, newline)? {
                    additions.push(line);
                }
            }
        }
    }

    // A frontmatter block the parser turned into no properties at all is the
    // state in which every key looks absent, so every set below would append
    // a *duplicate* into a document nobody can read — and report success.
    // Checked only once something would actually change, so a delete of a key
    // that is not there stays the no-op it is at every other granularity.
    if !(splices.is_empty() && additions.is_empty())
        && frontmatter_is_unreadable(source, &properties)
    {
        return Err(MutationError::MalformedFrontmatter { path: path.clone() });
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
                replacement: format!("---{newline}{}---{newline}", additions.concat()),
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

    // The gate above validates the **input**; this validates the **result**,
    // and they are not the same check. `---\na: 1\n...\n---` is perfectly
    // readable — one document, one property — so it passes every input test,
    // and a key added after the `...` document-end marker starts a *second*
    // YAML document. The frontmatter then re-parses with zero properties: the
    // index loses every one of them while the caller is told the write
    // succeeded. Only re-reading what was actually produced catches that
    // class, so the last thing this function does is read its own output.
    //
    // Reached only when something changed, so a no-op on a document that was
    // already broken is still the no-op it was. Costs one extra parse of one
    // note per changed patch, which is the right price for never handing back
    // a document that has quietly stopped being frontmatter.
    if patched != source {
        let reparsed = parse_properties(&SourceDocument::new(path.clone(), patched.clone()));
        if frontmatter_is_unreadable(&patched, &reparsed) {
            return Err(MutationError::MalformedFrontmatter { path: path.clone() });
        }
    }
    Ok(patched)
}

/// The splice for one top-level key that **exists** in the document.
fn plan_existing(
    source: &str,
    property: &Property,
    group: &[&FrontmatterEdit],
    newline: &str,
) -> Result<Option<Splice>, MutationError> {
    let indent = indent_of(source, property.key.span.start());
    let entry = entry_range(source, property);

    // At the stored granularity: pure span surgery, nothing re-serialized.
    if group.len() == 1 && group[0].key_path.len() == 1 {
        return Ok(Some(match &group[0].value {
            Some(value) => Splice {
                // The replacement owns the separator after the `:`, so it can
                // choose one space for a scalar and a newline for a block.
                range: value_range(source, property),
                replacement: after_key(&Yaml::from(value), indent, newline),
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

    // Below the stored granularity, but still addressing one scalar: the
    // parse carries a span for that scalar too, so it can be spliced on its
    // own and the layout around it — the `- ` item it sits in, its sibling
    // keys, its indentation — never moves. Only when this declines does the
    // enclosing property get re-emitted.
    if let Some(splice) = plan_nested_scalar(source, property, group, &entry, newline) {
        return Ok(Some(splice));
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
            "{}{}:{}{newline}",
            " ".repeat(indent),
            scalar(&property.key.value),
            after_key(&root, indent, newline)
        ),
    }))
}

/// The splice for one edit that sets a **scalar that is already there**,
/// below the stored granularity — or `None` when this narrowing does not
/// apply and the enclosing property must be re-emitted after all.
///
/// The index stores spans per top-level key, but `vault-core`'s parse carries
/// a span for every nested key and value inside one. This reads the addressed
/// leaf's own span out of that parse and splices exactly it, so the bytes
/// around it — the `- ` that opens its map item, the sibling keys of that
/// item, the block indentation — are not rewritten at all. Re-emitting the
/// property instead is correct YAML but reflows it: a block-style list of
/// maps comes back as `- {name: a, value: 9}`, which is a whole-property diff
/// for a one-scalar edit.
///
/// It declines — and today's re-serialization takes over — in every case
/// where the narrow splice would not be obviously right:
///
/// * more than one edit under the same top-level key (they may address
///   overlapping subtrees, and one re-emit is the defined answer for that);
/// * a **deletion**, which has to remove a key from its mapping rather than
///   replace a value;
/// * a new value that is a sequence or a mapping, whose block layout depends
///   on the indentation of the place it lands;
/// * an addressed target that does not exist yet, or is itself a sequence or
///   mapping;
/// * a leaf addressed as a **sequence element** (`tags.0`) rather than as a
///   mapping key: there is no key span to take the separator from, and a
///   `- ` item's own geometry is not the same splice;
/// * a leaf inside a **flow** collection (`{a: 1, b: 2}`, `[{a: 1}]`), where a
///   `,` or a bracket ends the token. The replacement is built by [`after_key`],
///   which quotes for *block* context, so writing it into flow context would
///   split one value into two — `{a: x, y, b: 2}` is valid YAML holding
///   `a: "x"` and a stray key `y`. The re-emit renders flow collections
///   through [`flow_scalar`] and gets this right, so declining is both the
///   smaller change and the correct one.
///
/// `VAULTD-COMPATIBILITY.md` records what is left reflowing.
fn plan_nested_scalar(
    source: &str,
    property: &Property,
    group: &[&FrontmatterEdit],
    entry: &Range<usize>,
    newline: &str,
) -> Option<Splice> {
    if group.len() != 1 {
        return None;
    }
    let edit = group[0];
    let value = edit.value.as_ref()?;
    if !matches!(
        value,
        PatchValue::Null
            | PatchValue::Boolean(_)
            | PatchValue::Integer(_)
            | PatchValue::Float(_)
            | PatchValue::String(_)
    ) {
        return None;
    }
    let (key, target) = locate_scalar(&property.value, &edit.key_path[1..])?;
    if !opens_its_own_line(source, key.span.start()) {
        return None;
    }
    let start = after_colon(source, key.span.end());
    // `after_colon` answers the key's own end when it finds no `:` at all.
    // Nothing sensible can be spliced then, so fall back rather than guess.
    if start <= key.span.end() {
        return None;
    }
    let range = start..value_end(source, start, target.span.end());
    // The splice must stay inside the property it belongs to. A span that
    // escaped it would be a parse this code does not understand, and the
    // conservative answer is to re-emit instead.
    if range.start < entry.start || range.end > entry.end {
        return None;
    }
    Some(Splice {
        range,
        replacement: after_key(
            &Yaml::from(value),
            indent_of(source, key.span.start()),
            newline,
        ),
    })
}

/// Whether the key at `key_start` **opens its own line** — the bytes before it
/// on that line are only indentation and block sequence markers.
///
/// This is how block context is told from flow context, and it is deliberately
/// a question about the *source bytes* rather than about the parsed tree: the
/// parse reports a `Mapping` for `{a: 1}` and for a block mapping alike, so
/// nothing in [`PropertyValue`] can answer it. A key inside `{…}` or `[…]`
/// always has something other than indentation in front of it on its line —
/// the opening brace, or the `,` that separated it from the entry before —
/// while a block key has at most spaces, tabs, and `- ` markers.
///
/// A flow collection written across several lines is handled by the same
/// test: its first key follows the `{` on that line, and a later key follows
/// the `,` or the `{` on its own. The only shape this treats as block when it
/// is not would need a key sitting alone on a line inside a flow collection
/// with no separator before it, which no YAML flow syntax produces.
fn opens_its_own_line(source: &str, key_start: usize) -> bool {
    let mut prefix =
        source[line_start(source, key_start)..key_start].trim_start_matches([' ', '\t']);
    while let Some(rest) = prefix.strip_prefix("- ") {
        prefix = rest.trim_start_matches([' ', '\t']);
    }
    prefix.is_empty()
}

/// The addressed entry inside one parsed property — its key and its value —
/// when every segment resolves and the value it lands on is a scalar.
///
/// `None` for everything else: a missing segment, a non-numeric index into a
/// sequence, an index past its end, a target that is a collection, and the
/// sequence-element case, which has a value span but no key span.
fn locate_scalar<'a>(
    value: &'a Spanned<PropertyValue>,
    segments: &[String],
) -> Option<(&'a Spanned<String>, &'a Spanned<PropertyValue>)> {
    let (segment, rest) = segments.split_first()?;
    match &value.value {
        PropertyValue::Mapping(entries) => {
            let (key, child) = entries.iter().find(|(key, _)| &key.value == segment)?;
            if !rest.is_empty() {
                return locate_scalar(child, rest);
            }
            match child.value {
                PropertyValue::Sequence(_) | PropertyValue::Mapping(_) => None,
                _ => Some((key, child)),
            }
        }
        PropertyValue::Sequence(items) => {
            let index = segment.parse::<usize>().ok()?;
            let child = items.get(index)?;
            if rest.is_empty() {
                return None;
            }
            locate_scalar(child, rest)
        }
        _ => None,
    }
}

/// The new line for one top-level key that is **not** in the document.
///
/// A multi-segment path creates every intermediate mapping — `processFrontMatter`
/// parity, and the alternative would make a plugin's first write to a nested
/// key fail while its second succeeded.
fn plan_addition(
    key: &str,
    group: &[&FrontmatterEdit],
    newline: &str,
) -> Result<Option<String>, MutationError> {
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
            "{}:{}{newline}",
            scalar(key),
            after_key(&Yaml::from(value), 0, newline)
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
    Ok(Some(format!(
        "{}:{}{newline}",
        scalar(key),
        after_key(&root, 0, newline)
    )))
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
        // `title:` — the linter's empty-property spelling. A null holds no
        // value, so building the path through it discards nothing, and this
        // is the same `fm.a = fm.a ?? {}` parity that makes a missing
        // top-level key create its whole structure. A *scalar* is the case
        // below, and stays refused precisely because it does hold something.
        Yaml::Null => match new {
            Some(value) => {
                *target = wrap(segments, value);
                Ok(())
            }
            None => Ok(()),
        },
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

/// The byte range a **set** replaces: everything after the key's `:` that
/// belongs to this property's value, separator included, so the replacement
/// can choose one space for a scalar and a line break for a block.
fn value_range(source: &str, property: &Property) -> Range<usize> {
    let start = after_colon(source, property.key.span.end());
    start..value_end(source, start, property.value.span.end())
}

/// The property's whole entry, trailing line terminator included: the stored
/// span stops at the value, so a deletion that used it would leave a blank
/// line behind.
fn entry_range(source: &str, property: &Property) -> Range<usize> {
    let start = line_start(source, property.span.start());
    let value = value_range(source, property);
    start..line_end(source, value.end.max(start))
}

/// The offset just past the last byte of a property's value.
///
/// The one place stored span geometry is corrected, because exactly two
/// shapes report an end that cannot be spliced as-is — and both were found by
/// a reviewer running documents the brief never imagined, not by reasoning:
///
/// * a **null** value (`title:`, the linter's own empty-property spelling) is
///   a zero-width span sitting *at* the colon, so its stored end is *behind*
///   `start`. Used raw it builds a reversed range and `replace_range` panics
///   — and nothing above the engine installs a `catch_unwind`, so that panic
///   takes the coordinator thread down.
/// * a **block scalar** (`|`, `>`, and their chomping variants) reports an
///   end at the first byte of the *next key*, past its own last line. Used
///   raw, a set splices away the neighbouring property — or the closing
///   fence, when the block scalar is last — and the engine commits the
///   wreckage as `Ok`. That is the exact damage correction #9 exists to
///   prevent, and worse than the naive full re-serialization it replaced.
///
/// One clamp fixes both: never before the start, and never past the last
/// non-blank byte the value's own text occupies.
///
/// Known cosmetic limitation, deliberately not fixed here. Under keep
/// chomping (`|+`) the trailing blank lines *are* part of the value, so a set
/// on `desc: |+` leaves them behind as blank lines between properties. The
/// result is valid YAML and the neighbouring property is untouched — the
/// safety claim holds — it is only untidy. Consuming them would mean telling
/// a value's own kept blank lines apart from an author's blank separator
/// lines, which needs the chomping indicator and is not a one-line change;
/// guessing wrong would delete formatting nobody asked this to touch, which
/// is worse than an extra blank line.
fn value_end(source: &str, start: usize, span_end: usize) -> usize {
    let clamped = span_end.clamp(start, source.len());
    // Trims the overshoot of a block scalar's span; a no-op for every other
    // shape, whose span already ends at its last content byte.
    let end = start + source[start..clamped].trim_end().len();
    // A value that is empty or trailing-padded leaves spaces between the
    // colon and the line break. They belong to this value, so a replacement
    // takes them rather than leaving `key:  new`. Anything else on the line
    // is not ours to take — not a trailing `# comment`, and not the `\r` of a
    // CRLF terminator.
    let padding = source[end..]
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    match source.as_bytes().get(end + padding) {
        None | Some(b'\n') | Some(b'\r') => end + padding,
        Some(_) => end,
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

/// The byte range of the frontmatter payload — everything between the fences
/// — or `None` when the document opens no fence at all.
fn payload_range(source: &str) -> Option<Range<usize>> {
    let start = if source.starts_with("---\n") {
        4
    } else if source.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    Some(match closing_fence(source) {
        Fence::Closing(end) => start..end,
        // An unterminated block has no end. Treating the rest of the file as
        // payload is conservative in the direction that refuses.
        Fence::Unterminated | Fence::Absent => start..source.len(),
    })
}

/// Whether the frontmatter holds content the parser turned into no properties
/// at all.
///
/// That is exactly the state in which every key looks absent, so every set
/// appends a **duplicate** into a document nobody can parse: `title:
/// [unclosed`, a non-mapping root (`- a`), a `null` document, a bare `{}`,
/// and tab-indented YAML all land here. A comment-only or blank payload does
/// not — appending to one of those is well-defined and right.
///
/// Deliberately structural rather than keyed on a diagnostic code.
/// `UnsupportedPropertyShape` is *also* raised for a malformed `aliases:` or
/// `tags:` **value** in a block whose properties all parsed perfectly, and
/// refusing to patch that note would be wrong.
fn frontmatter_is_unreadable(source: &str, properties: &[Property]) -> bool {
    if !properties.is_empty() {
        return false;
    }
    let Some(payload) = payload_range(source) else {
        return false;
    };
    source[payload].lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#')
    })
}

/// The anchor the addressed property declares that another property aliases,
/// if there is one.
///
/// `base: &shared` … `user: *shared` is the shape. `vault-core` resolves the
/// alias before this module sees the value, so a re-serialization or a delete
/// of `base` emits a document in which `*shared` points at nothing — and the
/// *whole* frontmatter then fails to parse, including properties the caller
/// never named. See [`MutationError::AnchoredProperty`].
///
/// The scan is deliberately narrow: a sigil counts only where a YAML token
/// could begin — at the start of the region, or after whitespace — so
/// `team: R&D` declares no anchor and a body's `*emphasis*` is no alias. The
/// alias half is confined to the frontmatter payload for that second reason.
/// A false positive costs one refusal; a false negative costs the document.
fn aliased_anchor(source: &str, payload: Range<usize>, entry: Range<usize>) -> Option<String> {
    let declared = sigil_tokens(source, payload.clone(), '&');
    if declared.is_empty() {
        return None;
    }
    // Everything in the payload that is not this property's own lines.
    let before = payload.start..entry.start.clamp(payload.start, payload.end);
    let after = entry.end.clamp(payload.start, payload.end)..payload.end;
    let mine = sigil_tokens(source, entry, '&');
    let mut used = sigil_tokens(source, before, '*');
    used.extend(sigil_tokens(source, after, '*'));
    mine.into_iter().find(|anchor| used.contains(anchor))
}

/// The `&name` or `*name` tokens in `region`, counting a sigil only where a
/// token could start.
fn sigil_tokens(source: &str, region: Range<usize>, sigil: char) -> Vec<String> {
    if region.start >= region.end {
        return Vec::new();
    }
    let text = &source[region];
    let mut found = Vec::new();
    let mut previous: Option<char> = None;
    for (offset, character) in text.char_indices() {
        if character == sigil && previous.is_none_or(char::is_whitespace) {
            let name: String = text[offset + sigil.len_utf8()..]
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
                .collect();
            if !name.is_empty() {
                found.push(name);
            }
        }
        previous = Some(character);
    }
    found
}

/// The line terminator the document predominantly uses.
///
/// An emitted line has to match its neighbours: mixing terminators parses
/// fine and churns every diff, which is the opposite of what a module built
/// for byte fidelity is for. Deletion already handled CRLF, because
/// [`line_end`] takes the whole `\r\n`; only the emitter needed telling.
fn dominant_newline(source: &str) -> &'static str {
    let crlf = source.matches("\r\n").count();
    let lf = source.matches('\n').count() - crlf;
    if crlf > lf { "\r\n" } else { "\n" }
}

/// The payload weight of `edits`: roughly the bytes a client spent describing
/// them.
///
/// The *result* of a patch is deliberately uncapped — see
/// `MutationEngine::patch_frontmatter` — so that a note already over the cap
/// stays patchable by the only interface that could shrink it. The **edits**
/// are a different thing: they are a payload the client hands the daemon, and
/// `DEFAULT_MAX_FILE_BYTES`'s own rule applies to those. Without this, a
/// client that cannot `write_note` a 100 MB note can patch one key to a
/// 100 MB string and get the same file.
///
/// An approximation is the right instrument: what matters is that a huge
/// string weighs huge, not that the count matches the JSON byte for byte.
pub(crate) fn patch_weight(edits: &[FrontmatterEdit]) -> u64 {
    edits
        .iter()
        .map(|edit| {
            let path: u64 = edit
                .key_path
                .iter()
                .map(|segment| segment.len() as u64 + 1)
                .sum();
            path + edit.value.as_ref().map_or(0, value_weight)
        })
        .sum()
}

fn value_weight(value: &PatchValue) -> u64 {
    match value {
        PatchValue::Null
        | PatchValue::Boolean(_)
        | PatchValue::Integer(_)
        | PatchValue::Float(_) => 8,
        PatchValue::String(text) => text.len() as u64,
        PatchValue::Sequence(items) => {
            items.iter().map(value_weight).sum::<u64>() + items.len() as u64
        }
        PatchValue::Mapping(entries) => entries
            .iter()
            .map(|(key, value)| key.len() as u64 + value_weight(value) + 2)
            .sum(),
    }
}

/// Serialize `value` exactly as it appears after its key's `:` — the
/// separator included, so a scalar gets one space and a block collection gets
/// a newline instead of a dangling space. The reference vault's dominant
/// obsidian-linter style: block sequences and mappings indented two spaces
/// past their key, scalars inline.
fn after_key(value: &Yaml, indent: usize, newline: &str) -> String {
    match value {
        // A bare `key:` — the linter's empty-value style, and what a document
        // that already held one round-trips back to.
        Yaml::Null => String::new(),
        // A null the caller asked for is spelled out, so the note says what
        // the plugin meant. Both forms read back as null.
        Yaml::ExplicitNull => " null".to_string(),
        Yaml::Boolean(value) => format!(" {value}"),
        Yaml::Integer(value) => format!(" {value}"),
        Yaml::Float(value) => format!(" {}", float(*value)),
        Yaml::String(value) => format!(" {}", scalar(value)),
        Yaml::Sequence(items) if items.is_empty() => " []".to_string(),
        Yaml::Sequence(items) => {
            let pad = " ".repeat(indent + 2);
            let mut text = String::new();
            for item in items {
                text.push_str(newline);
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
                text.push_str(newline);
                text.push_str(&pad);
                // A key is a scalar and gets a scalar's quoting. A key path
                // segment is whatever the caller sent, so `on` or `1.5` can
                // reach here, and bare it would come back a bool or a float
                // — or, for `mapping keys must be strings`, not come back at
                // all.
                text.push_str(&scalar(key));
                text.push(':');
                text.push_str(&after_key(value, indent + 2, newline));
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
        Yaml::Null | Yaml::ExplicitNull => "null".to_string(),
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
        || reads_as_a_number(text);
    if needs_quotes {
        quote(text)
    } else {
        text.to_string()
    }
}

/// Whether YAML would read `text` as a number rather than as the string it
/// is.
///
/// **Not** `parse::<f64>()`, which is *Rust's* number grammar. The two differ
/// in both directions, and one direction is a silent type change:
///
/// | spelling | Rust `parse::<f64>` | YAML |
/// | --- | --- | --- |
/// | `.inf`, `.nan` | rejects | float — **must** be quoted |
/// | `0x1A`, `0o17` | rejects | integer — **must** be quoted |
/// | `inf`, `nan`, `infinity` | accepts | plain string — over-quoting, harmless |
///
/// The first two rows were live bugs a reviewer found by round-tripping a
/// hostile matrix: a caller setting the string `"0x1A"` got a note that read
/// back as the integer 26. Over-quoting in the third row costs nothing and is
/// Obsidian-compat prudence, so `parse::<f64>` stays as the decimal case.
fn reads_as_a_number(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let lowercase = unsigned.to_ascii_lowercase();
    if matches!(lowercase.as_str(), ".inf" | ".nan") {
        return true;
    }
    if let Some(digits) = lowercase.strip_prefix("0x") {
        return !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if let Some(digits) = lowercase.strip_prefix("0o") {
        return !digits.is_empty() && digits.bytes().all(|byte| matches!(byte, b'0'..=b'7'));
    }
    text.parse::<f64>().is_ok()
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
