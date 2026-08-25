use vault_core::{
    Diagnostic, DiagnosticCode, PropertyValue, Reference, ReferenceKind, ReferenceOrigin,
    Resolution, Severity, SourceSpan, Spanned, Subpath, VaultPath,
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
