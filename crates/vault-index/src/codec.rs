use vault_core::{
    DependencyKey, DependencyKind, Diagnostic, DiagnosticCode, ListItemParent, PropertyValue,
    Reference, ReferenceKind, ReferenceOrigin, Resolution, SectionKind, Severity, SourceSpan,
    Spanned, Subpath, TreeEntryKind, VaultPath,
};

use crate::error::IndexError;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum StoredPropertyValue {
    Null,
    Boolean(bool),
    Integer(i64),
    FloatBits(u64),
    String(String),
    Sequence(Vec<StoredSpannedValue>),
    Mapping(Vec<StoredMappingEntry>),
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSpan {
    start: usize,
    end: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSpannedValue {
    value: StoredPropertyValue,
    span: StoredSpan,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredMappingEntry {
    key: String,
    key_span: StoredSpan,
    value: StoredSpannedValue,
}

fn stored_span(span: SourceSpan) -> StoredSpan {
    StoredSpan {
        start: span.start(),
        end: span.end(),
    }
}

pub(crate) fn decode_span(start: usize, end: usize) -> Result<SourceSpan, IndexError> {
    SourceSpan::new(start, end)
        .map_err(|error| IndexError::IncompatibleIndex(format!("invalid stored span: {error}")))
}

fn decode_stored_span(span: &StoredSpan) -> Result<SourceSpan, IndexError> {
    decode_span(span.start, span.end)
}

fn stored_value(value: &PropertyValue) -> StoredPropertyValue {
    match value {
        PropertyValue::Null => StoredPropertyValue::Null,
        PropertyValue::Boolean(value) => StoredPropertyValue::Boolean(*value),
        PropertyValue::Integer(value) => StoredPropertyValue::Integer(*value),
        PropertyValue::Float(value) => StoredPropertyValue::FloatBits(value.to_bits()),
        PropertyValue::String(value) => StoredPropertyValue::String(value.clone()),
        PropertyValue::Sequence(items) => StoredPropertyValue::Sequence(
            items
                .iter()
                .map(|item| StoredSpannedValue {
                    value: stored_value(&item.value),
                    span: stored_span(item.span),
                })
                .collect(),
        ),
        PropertyValue::Mapping(entries) => StoredPropertyValue::Mapping(
            entries
                .iter()
                .map(|(key, value)| StoredMappingEntry {
                    key: key.value.clone(),
                    key_span: stored_span(key.span),
                    value: StoredSpannedValue {
                        value: stored_value(&value.value),
                        span: stored_span(value.span),
                    },
                })
                .collect(),
        ),
    }
}

fn restored_value(value: &StoredPropertyValue) -> Result<PropertyValue, IndexError> {
    Ok(match value {
        StoredPropertyValue::Null => PropertyValue::Null,
        StoredPropertyValue::Boolean(value) => PropertyValue::Boolean(*value),
        StoredPropertyValue::Integer(value) => PropertyValue::Integer(*value),
        StoredPropertyValue::FloatBits(bits) => PropertyValue::Float(f64::from_bits(*bits)),
        StoredPropertyValue::String(value) => PropertyValue::String(value.clone()),
        StoredPropertyValue::Sequence(items) => PropertyValue::Sequence(
            items
                .iter()
                .map(|item| {
                    Ok(Spanned::new(
                        restored_value(&item.value)?,
                        decode_stored_span(&item.span)?,
                    ))
                })
                .collect::<Result<Vec<_>, IndexError>>()?,
        ),
        StoredPropertyValue::Mapping(entries) => PropertyValue::Mapping(
            entries
                .iter()
                .map(|entry| {
                    Ok((
                        Spanned::new(entry.key.clone(), decode_stored_span(&entry.key_span)?),
                        Spanned::new(
                            restored_value(&entry.value.value)?,
                            decode_stored_span(&entry.value.span)?,
                        ),
                    ))
                })
                .collect::<Result<Vec<_>, IndexError>>()?,
        ),
    })
}

pub(crate) fn encode_property_value(value: &PropertyValue) -> Result<String, IndexError> {
    Ok(serde_json::to_string(&stored_value(value))?)
}

pub(crate) fn decode_property_value(json: &str) -> Result<PropertyValue, IndexError> {
    let stored: StoredPropertyValue = serde_json::from_str(json).map_err(|error| {
        IndexError::IncompatibleIndex(format!("invalid property JSON: {error}"))
    })?;
    restored_value(&stored)
}

pub(crate) fn decode_path(value: &str) -> Result<VaultPath, IndexError> {
    VaultPath::new(value)
        .map_err(|error| IndexError::IncompatibleIndex(format!("invalid stored path: {error}")))
}

pub(crate) fn encode_diagnostic_code(code: DiagnosticCode) -> &'static str {
    match code {
        DiagnosticCode::InaccessibleVaultRoot => "inaccessible_vault_root",
        DiagnosticCode::UnreadableFile => "unreadable_file",
        DiagnosticCode::InvalidUtf8 => "invalid_utf8",
        DiagnosticCode::SymlinkOutsideVault => "symlink_outside_vault",
        DiagnosticCode::UnterminatedFrontmatter => "unterminated_frontmatter",
        DiagnosticCode::MalformedFrontmatter => "malformed_frontmatter",
        DiagnosticCode::UnsupportedPropertyShape => "unsupported_property_shape",
        DiagnosticCode::MarkdownParseError => "markdown_parse_error",
        DiagnosticCode::MalformedWikilink => "malformed_wikilink",
        DiagnosticCode::MalformedTag => "malformed_tag",
        DiagnosticCode::MalformedBlockId => "malformed_block_id",
        DiagnosticCode::UnresolvedReference => "unresolved_reference",
        DiagnosticCode::AmbiguousReference => "ambiguous_reference",
        DiagnosticCode::MissingHeading => "missing_heading",
        DiagnosticCode::MissingBlock => "missing_block",
        DiagnosticCode::MissingView => "missing_view",
        DiagnosticCode::MalformedBase => "malformed_base",
    }
}

pub(crate) fn decode_diagnostic_code(value: &str) -> Result<DiagnosticCode, IndexError> {
    Ok(match value {
        "inaccessible_vault_root" => DiagnosticCode::InaccessibleVaultRoot,
        "unreadable_file" => DiagnosticCode::UnreadableFile,
        "invalid_utf8" => DiagnosticCode::InvalidUtf8,
        "symlink_outside_vault" => DiagnosticCode::SymlinkOutsideVault,
        "unterminated_frontmatter" => DiagnosticCode::UnterminatedFrontmatter,
        "malformed_frontmatter" => DiagnosticCode::MalformedFrontmatter,
        "unsupported_property_shape" => DiagnosticCode::UnsupportedPropertyShape,
        "markdown_parse_error" => DiagnosticCode::MarkdownParseError,
        "malformed_wikilink" => DiagnosticCode::MalformedWikilink,
        "malformed_tag" => DiagnosticCode::MalformedTag,
        "malformed_block_id" => DiagnosticCode::MalformedBlockId,
        "unresolved_reference" => DiagnosticCode::UnresolvedReference,
        "ambiguous_reference" => DiagnosticCode::AmbiguousReference,
        "missing_heading" => DiagnosticCode::MissingHeading,
        "missing_block" => DiagnosticCode::MissingBlock,
        "missing_view" => DiagnosticCode::MissingView,
        "malformed_base" => DiagnosticCode::MalformedBase,
        other => {
            return Err(IndexError::IncompatibleIndex(format!(
                "unknown diagnostic code {other:?}"
            )));
        }
    })
}

pub(crate) fn encode_severity(severity: Severity) -> &'static str {
    match severity {
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

pub(crate) fn decode_severity(value: &str) -> Result<Severity, IndexError> {
    Ok(match value {
        "warning" => Severity::Warning,
        "error" => Severity::Error,
        other => {
            return Err(IndexError::IncompatibleIndex(format!(
                "unknown severity {other:?}"
            )));
        }
    })
}

pub(crate) fn encode_reference_kind(kind: ReferenceKind) -> &'static str {
    match kind {
        ReferenceKind::MarkdownLink => "markdown_link",
        ReferenceKind::Wikilink => "wikilink",
        ReferenceKind::MarkdownEmbed => "markdown_embed",
        ReferenceKind::WikiEmbed => "wiki_embed",
    }
}

pub(crate) fn decode_reference_kind(value: &str) -> Result<ReferenceKind, IndexError> {
    Ok(match value {
        "markdown_link" => ReferenceKind::MarkdownLink,
        "wikilink" => ReferenceKind::Wikilink,
        "markdown_embed" => ReferenceKind::MarkdownEmbed,
        "wiki_embed" => ReferenceKind::WikiEmbed,
        other => {
            return Err(IndexError::IncompatibleIndex(format!(
                "unknown reference kind {other:?}"
            )));
        }
    })
}

pub(crate) fn encode_reference_origin(origin: ReferenceOrigin) -> &'static str {
    match origin {
        ReferenceOrigin::Body => "body",
        ReferenceOrigin::Property => "property",
    }
}

pub(crate) fn decode_reference_origin(value: &str) -> Result<ReferenceOrigin, IndexError> {
    Ok(match value {
        "body" => ReferenceOrigin::Body,
        "property" => ReferenceOrigin::Property,
        other => {
            return Err(IndexError::IncompatibleIndex(format!(
                "unknown reference origin {other:?}"
            )));
        }
    })
}

pub(crate) fn encode_subpath(subpath: &Subpath) -> (&'static str, &str) {
    match subpath {
        Subpath::Heading(value) => ("heading", value),
        Subpath::Block(value) => ("block", value),
        Subpath::View(value) => ("view", value),
    }
}

pub(crate) fn decode_subpath(
    kind: Option<&str>,
    value: Option<&str>,
) -> Result<Option<Subpath>, IndexError> {
    match (kind, value) {
        (None, None) => Ok(None),
        (Some("heading"), Some(value)) => Ok(Some(Subpath::Heading(value.to_string()))),
        (Some("block"), Some(value)) => Ok(Some(Subpath::Block(value.to_string()))),
        (Some("view"), Some(value)) => Ok(Some(Subpath::View(value.to_string()))),
        other => Err(IndexError::IncompatibleIndex(format!(
            "invalid stored subpath {other:?}"
        ))),
    }
}

pub(crate) struct StoredResolution {
    pub kind: &'static str,
    pub target_path: Option<String>,
    pub subpath_kind: Option<&'static str>,
    pub subpath_value: Option<String>,
    pub candidates: Vec<String>,
}

pub(crate) fn encode_resolution(resolution: &Resolution) -> StoredResolution {
    match resolution {
        Resolution::Resolved { target, subpath } => {
            let (kind, value) = match subpath {
                Some(subpath) => {
                    let (kind, value) = encode_subpath(subpath);
                    (Some(kind), Some(value.to_string()))
                }
                None => (None, None),
            };
            StoredResolution {
                kind: "resolved",
                target_path: Some(target.as_str().to_string()),
                subpath_kind: kind,
                subpath_value: value,
                candidates: Vec::new(),
            }
        }
        Resolution::MissingSubpath { target, subpath } => {
            let (kind, value) = encode_subpath(subpath);
            StoredResolution {
                kind: "missing_subpath",
                target_path: Some(target.as_str().to_string()),
                subpath_kind: Some(kind),
                subpath_value: Some(value.to_string()),
                candidates: Vec::new(),
            }
        }
        Resolution::Unresolved => StoredResolution {
            kind: "unresolved",
            target_path: None,
            subpath_kind: None,
            subpath_value: None,
            candidates: Vec::new(),
        },
        Resolution::Ambiguous { candidates } => StoredResolution {
            kind: "ambiguous",
            target_path: None,
            subpath_kind: None,
            subpath_value: None,
            candidates: candidates
                .iter()
                .map(|path| path.as_str().to_string())
                .collect(),
        },
        Resolution::NonVault => StoredResolution {
            kind: "non_vault",
            target_path: None,
            subpath_kind: None,
            subpath_value: None,
            candidates: Vec::new(),
        },
    }
}

pub(crate) fn decode_resolution(
    kind: &str,
    target_path: Option<&str>,
    subpath_kind: Option<&str>,
    subpath_value: Option<&str>,
    candidates: Vec<String>,
) -> Result<Resolution, IndexError> {
    match kind {
        "resolved" => {
            let target = target_path.ok_or_else(|| {
                IndexError::IncompatibleIndex("resolved row without a target".into())
            })?;
            Ok(Resolution::Resolved {
                target: decode_path(target)?,
                subpath: decode_subpath(subpath_kind, subpath_value)?,
            })
        }
        "missing_subpath" => {
            let target = target_path.ok_or_else(|| {
                IndexError::IncompatibleIndex("missing-subpath row without a target".into())
            })?;
            let subpath = decode_subpath(subpath_kind, subpath_value)?.ok_or_else(|| {
                IndexError::IncompatibleIndex("missing-subpath row without a subpath".into())
            })?;
            Ok(Resolution::MissingSubpath {
                target: decode_path(target)?,
                subpath,
            })
        }
        "unresolved" => Ok(Resolution::Unresolved),
        "ambiguous" => Ok(Resolution::Ambiguous {
            candidates: candidates
                .iter()
                .map(|candidate| decode_path(candidate))
                .collect::<Result<Vec<_>, _>>()?,
        }),
        "non_vault" => Ok(Resolution::NonVault),
        other => Err(IndexError::IncompatibleIndex(format!(
            "unknown resolution kind {other:?}"
        ))),
    }
}

pub(crate) fn diagnostic_from_row(
    code: &str,
    severity: &str,
    message: String,
    path: Option<&str>,
    span_start: Option<i64>,
    span_end: Option<i64>,
) -> Result<Diagnostic, IndexError> {
    let mut diagnostic = Diagnostic::new(
        decode_diagnostic_code(code)?,
        decode_severity(severity)?,
        message,
    );
    if let Some(path) = path {
        diagnostic = diagnostic.with_path(decode_path(path)?);
    }
    match (span_start, span_end) {
        (None, None) => {}
        (Some(start), Some(end)) => {
            diagnostic = diagnostic.with_span(decode_span(
                crate::store::i64_to_usize(start, "diagnostic span start")?,
                crate::store::i64_to_usize(end, "diagnostic span end")?,
            )?);
        }
        _ => {
            return Err(IndexError::IncompatibleIndex(
                "diagnostic row with a half-present span".into(),
            ));
        }
    }
    Ok(diagnostic)
}

pub(crate) fn encode_dependency_kind(kind: DependencyKind) -> &'static str {
    match kind {
        DependencyKind::ExactPath => "exact_path",
        DependencyKind::ExactPathWithExtension => "exact_path_with_extension",
        DependencyKind::Filename => "filename",
        DependencyKind::Stem => "stem",
        DependencyKind::ResolvedTarget => "resolved_target",
    }
}

pub(crate) fn decode_dependency_kind(value: &str) -> Result<DependencyKind, IndexError> {
    Ok(match value {
        "exact_path" => DependencyKind::ExactPath,
        "exact_path_with_extension" => DependencyKind::ExactPathWithExtension,
        "filename" => DependencyKind::Filename,
        "stem" => DependencyKind::Stem,
        "resolved_target" => DependencyKind::ResolvedTarget,
        other => {
            return Err(IndexError::IncompatibleIndex(format!(
                "unknown dependency kind {other:?}"
            )));
        }
    })
}

pub(crate) fn decode_dependency_key(
    kind: &str,
    comparison_key: &str,
) -> Result<DependencyKey, IndexError> {
    Ok(DependencyKey::new(
        decode_dependency_kind(kind)?,
        comparison_key.to_string(),
    ))
}

/// A tree entry's `kind` column. Total in both directions: the three
/// spellings are the ones the schema's own `CHECK` constraint admits, so an
/// unknown string can only come from a foreign writer and is an incompatible
/// index rather than a value to guess at.
pub(crate) fn encode_tree_entry_kind(kind: TreeEntryKind) -> &'static str {
    kind.as_str()
}

pub(crate) fn decode_tree_entry_kind(value: &str) -> Result<TreeEntryKind, IndexError> {
    match value {
        "folder" => Ok(TreeEntryKind::Folder),
        "note" => Ok(TreeEntryKind::Note),
        "file" => Ok(TreeEntryKind::File),
        other => Err(IndexError::IncompatibleIndex(format!(
            "unknown tree entry kind {other:?}"
        ))),
    }
}

/// A section kind's wire string. The known variants spell Obsidian's own
/// `sections[].type` vocabulary; `Other(s)` stores `s` literally, so an
/// unrecognized kind survives storage instead of being flattened.
///
/// The literal encoding is only lossless because no `Other` value can spell a
/// known variant: `vault_core`'s `node_type_name` produces exactly
/// `definition`, `footnoteDefinition`, `math`, the three `mdx*` names, `toml`,
/// and `unknown`, none of which collide with the strings below.
pub(crate) fn encode_section_kind(kind: &SectionKind) -> &str {
    match kind {
        SectionKind::Yaml => "yaml",
        SectionKind::Heading => "heading",
        SectionKind::Paragraph => "paragraph",
        SectionKind::Code => "code",
        SectionKind::Blockquote => "blockquote",
        SectionKind::Table => "table",
        SectionKind::ThematicBreak => "thematicBreak",
        SectionKind::List => "list",
        SectionKind::Callout => "callout",
        SectionKind::Html => "html",
        SectionKind::Other(value) => value.as_str(),
    }
}

/// Total, by construction: an unknown string is an `Other`, never an error,
/// because that is exactly what `Other` is for.
pub(crate) fn decode_section_kind(value: &str) -> SectionKind {
    match value {
        "yaml" => SectionKind::Yaml,
        "heading" => SectionKind::Heading,
        "paragraph" => SectionKind::Paragraph,
        "code" => SectionKind::Code,
        "blockquote" => SectionKind::Blockquote,
        "table" => SectionKind::Table,
        "thematicBreak" => SectionKind::ThematicBreak,
        "list" => SectionKind::List,
        "callout" => SectionKind::Callout,
        "html" => SectionKind::Html,
        other => SectionKind::Other(other.to_string()),
    }
}

/// `(list_start_line, parent_start_line)` — exactly one is `Some`, which is
/// also what the table's `CHECK` constraint enforces. Line numbers, never a
/// negated sentinel: the sign trick lives in Obsidian's wire format, not in
/// this store.
pub(crate) fn encode_list_item_parent(parent: ListItemParent) -> (Option<i64>, Option<i64>) {
    match parent {
        ListItemParent::Root { list_start_line } => (Some(i64::from(list_start_line)), None),
        ListItemParent::Item { parent_start_line } => (None, Some(i64::from(parent_start_line))),
    }
}

pub(crate) fn decode_list_item_parent(
    list_start_line: Option<i64>,
    parent_start_line: Option<i64>,
) -> Result<ListItemParent, IndexError> {
    let line = |value: i64| -> Result<u32, IndexError> {
        u32::try_from(value).map_err(|_| {
            IndexError::IncompatibleIndex(format!("list item parent line {value} out of range"))
        })
    };
    match (list_start_line, parent_start_line) {
        (Some(value), None) => Ok(ListItemParent::Root {
            list_start_line: line(value)?,
        }),
        (None, Some(value)) => Ok(ListItemParent::Item {
            parent_start_line: line(value)?,
        }),
        _ => Err(IndexError::IncompatibleIndex(
            "list item row sets both parent columns or neither".into(),
        )),
    }
}

/// A task marker is one character in the domain and a one-character string on
/// the wire, so the column stays readable in SQL.
pub(crate) fn encode_task(task: Option<char>) -> Option<String> {
    task.map(|task| task.to_string())
}

pub(crate) fn decode_task(value: Option<String>) -> Result<Option<char>, IndexError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mut characters = value.chars();
    let task = characters.next().ok_or_else(|| {
        IndexError::IncompatibleIndex("list item task marker is an empty string".into())
    })?;
    if characters.next().is_some() {
        return Err(IndexError::IncompatibleIndex(format!(
            "list item task marker {value:?} is longer than one character"
        )));
    }
    Ok(Some(task))
}

/// The lowercase filename/stem comparison keys must use the same spelling
/// rules as the core resolver's catalog.
pub(crate) fn comparison_keys(path: &VaultPath) -> (String, String) {
    let filename = path
        .as_str()
        .rsplit('/')
        .next()
        .expect("split always yields one part")
        .to_lowercase();
    let stem = filename
        .strip_suffix(".md")
        .unwrap_or(filename.as_str())
        .to_string();
    (filename, stem)
}

pub(crate) fn encode_reference_columns(reference: &Reference) -> ReferenceColumns<'_> {
    let (subpath_kind, subpath_value) = match &reference.subpath {
        Some(subpath) => {
            let (kind, value) = encode_subpath(subpath);
            (Some(kind), Some(value))
        }
        None => (None, None),
    };
    ReferenceColumns {
        kind: encode_reference_kind(reference.kind),
        origin: encode_reference_origin(reference.origin),
        raw_target: &reference.raw_target,
        file_target: reference.file_target.as_deref(),
        subpath_kind,
        subpath_value,
        display: reference.display.as_deref(),
    }
}

pub(crate) struct ReferenceColumns<'a> {
    pub kind: &'static str,
    pub origin: &'static str,
    pub raw_target: &'a str,
    pub file_target: Option<&'a str>,
    pub subpath_kind: Option<&'static str>,
    pub subpath_value: Option<&'a str>,
    pub display: Option<&'a str>,
}

/// One `property_scalars` row's value columns.
pub(crate) struct StoredScalar {
    pub kind: &'static str,
    pub string_value: Option<String>,
    pub number_value: Option<f64>,
}

fn digits(text: &[u8]) -> bool {
    !text.is_empty() && text.iter().all(u8::is_ascii_digit)
}

/// Two ASCII digits whose value lies in `low..=high`.
fn two_digits_in(text: &[u8], low: u8, high: u8) -> bool {
    text.len() == 2 && digits(text) && {
        let value = (text[0] - b'0') * 10 + (text[1] - b'0');
        (low..=high).contains(&value)
    }
}

/// `YYYY-MM-DD`, optionally followed by `[ T]HH:mm[:ss[.fff]]`, with the
/// month in 01-12, the day in 01-31, the hour in 00-23 and the minute and
/// second in 00-59. The check is lexical: it does not know month lengths,
/// so `2026-02-31` is date-shaped.
fn looks_like_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 10
        || !(digits(&bytes[0..4])
            && bytes[4] == b'-'
            && two_digits_in(&bytes[5..7], 1, 12)
            && bytes[7] == b'-'
            && two_digits_in(&bytes[8..10], 1, 31))
    {
        return false;
    }
    let rest = &bytes[10..];
    if rest.is_empty() {
        return true;
    }
    if !(rest[0] == b' ' || rest[0] == b'T') || rest.len() < 6 {
        return false;
    }
    let time = &rest[1..];
    if !(two_digits_in(&time[0..2], 0, 23) && time[2] == b':' && two_digits_in(&time[3..5], 0, 59))
    {
        return false;
    }
    let tail = &time[5..];
    match tail {
        [] => true,
        [b':', seconds @ ..] => {
            let (whole, fraction) = match seconds.iter().position(|b| *b == b'.') {
                Some(at) => (&seconds[..at], Some(&seconds[at + 1..])),
                None => (seconds, None),
            };
            two_digits_in(whole, 0, 59) && fraction.is_none_or(digits)
        }
        _ => false,
    }
}

/// Classify one property value into its `property_scalars` columns. The
/// `date` kind is lexical (see `looks_like_date`): the index knows no
/// property types, so the kind is a read optimisation, never a correctness
/// input.
pub(crate) fn property_scalar(value: &PropertyValue) -> StoredScalar {
    let (kind, string_value, number_value) = match value {
        PropertyValue::Null => ("null", None, None),
        PropertyValue::Boolean(flag) => ("boolean", None, Some(if *flag { 1.0 } else { 0.0 })),
        PropertyValue::Integer(number) => ("number", None, Some(*number as f64)),
        PropertyValue::Float(number) => ("number", None, Some(*number)),
        PropertyValue::String(text) if looks_like_date(text) => ("date", Some(text.clone()), None),
        PropertyValue::String(text) => ("string", Some(text.clone()), None),
        PropertyValue::Sequence(_) => ("list", None, None),
        PropertyValue::Mapping(_) => ("object", None, None),
    };
    StoredScalar {
        kind,
        string_value,
        number_value,
    }
}

#[cfg(test)]
mod wire_spellings {
    use super::*;

    #[test]
    fn the_stored_spellings_of_bases_are_pinned() {
        assert_eq!(
            encode_diagnostic_code(DiagnosticCode::MissingView),
            "missing_view"
        );
        assert_eq!(
            encode_diagnostic_code(DiagnosticCode::MalformedBase),
            "malformed_base"
        );
        assert_eq!(
            decode_diagnostic_code("malformed_base").unwrap(),
            DiagnosticCode::MalformedBase
        );
        assert_eq!(
            decode_diagnostic_code("missing_view").unwrap(),
            DiagnosticCode::MissingView
        );
        let view = Subpath::View("Table".into());
        assert_eq!(encode_subpath(&view), ("view", "Table"));
        assert_eq!(
            decode_subpath(Some("view"), Some("Table")).unwrap(),
            Some(view)
        );
        assert_eq!(
            decode_subpath(Some("heading"), Some("Table")).unwrap(),
            Some(Subpath::Heading("Table".into())),
            "the stored kind `heading` stays a heading"
        );
    }
}
