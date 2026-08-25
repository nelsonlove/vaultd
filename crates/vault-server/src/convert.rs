use vault_core::{
    Diagnostic, DiagnosticCode, PropertyValue, ReferenceKind, ReferenceOrigin, Resolution,
    ResolvedReference, Severity, SourceSpan, Subpath,
};
use vault_index::{IndexError, IndexState, IndexedNote, NoteSummary, VaultInfo};
use vault_protocol::{
    AliasDto, BlockDto, DiagnosticDto, ErrorCode, GetVaultInfoResponse, HeadingDto, IndexStateDto,
    NoteDto, NoteSummaryDto, PropertyDto, PropertyMappingEntryDto, PropertyValueDto, ProtocolError,
    ReferenceDto, ReferenceKindDto, ReferenceOriginDto, ResolutionDto, SeverityDto, SpanDto,
    SpannedPropertyValueDto, SubpathDto, TagDto,
};

pub(crate) fn span(value: SourceSpan) -> SpanDto {
    // usize -> u64 cannot lose range on supported platforms; use try_from to
    // keep the conversion explicit anyway.
    SpanDto {
        start: u64::try_from(value.start()).expect("span start fits u64"),
        end: u64::try_from(value.end()).expect("span end fits u64"),
    }
}

/// Finite floats use Rust's shortest round-trippable formatting; non-finite
/// values become exact lowercase strings so JSON never carries a non-finite
/// numeric token.
fn float_string(value: f64) -> String {
    if value.is_nan() {
        "nan".to_string()
    } else if value == f64::INFINITY {
        "infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-infinity".to_string()
    } else {
        value.to_string()
    }
}

pub(crate) fn property_value(value: &PropertyValue) -> PropertyValueDto {
    match value {
        PropertyValue::Null => PropertyValueDto::Null,
        PropertyValue::Boolean(value) => PropertyValueDto::Boolean(*value),
        PropertyValue::Integer(value) => PropertyValueDto::Integer(*value),
        PropertyValue::Float(value) => PropertyValueDto::Float(float_string(*value)),
        PropertyValue::String(value) => PropertyValueDto::String(value.clone()),
        PropertyValue::Sequence(items) => PropertyValueDto::Sequence(
            items
                .iter()
                .map(|item| SpannedPropertyValueDto {
                    value: property_value(&item.value),
                    span: span(item.span),
                })
                .collect(),
        ),
        PropertyValue::Mapping(entries) => PropertyValueDto::Mapping(
            entries
                .iter()
                .map(|(key, value)| PropertyMappingEntryDto {
                    key: key.value.clone(),
                    key_span: span(key.span),
                    value: SpannedPropertyValueDto {
                        value: property_value(&value.value),
                        span: span(value.span),
                    },
                })
                .collect(),
        ),
    }
}

fn severity(value: Severity) -> SeverityDto {
    match value {
        Severity::Warning => SeverityDto::Warning,
        Severity::Error => SeverityDto::Error,
    }
}

fn diagnostic_code(value: DiagnosticCode) -> &'static str {
    match value {
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

pub(crate) fn diagnostic(value: &Diagnostic) -> DiagnosticDto {
    DiagnosticDto {
        code: diagnostic_code(value.code).to_string(),
        severity: severity(value.severity),
        message: value.message.clone(),
        path: value.path.as_ref().map(|path| path.as_str().to_string()),
        span: value.span.map(span),
    }
}

fn subpath(value: &Subpath) -> SubpathDto {
    match value {
        Subpath::Heading(text) => SubpathDto::Heading(text.clone()),
        Subpath::Block(text) => SubpathDto::Block(text.clone()),
    }
}

pub(crate) fn resolution(value: &Resolution) -> ResolutionDto {
    match value {
        Resolution::Resolved {
            target,
            subpath: sub,
        } => ResolutionDto::Resolved {
            target: target.as_str().to_string(),
            subpath: sub.as_ref().map(subpath),
        },
        Resolution::MissingSubpath {
            target,
            subpath: sub,
        } => ResolutionDto::MissingSubpath {
            target: target.as_str().to_string(),
            subpath: subpath(sub),
        },
        Resolution::Unresolved => ResolutionDto::Unresolved,
        Resolution::Ambiguous { candidates } => ResolutionDto::Ambiguous {
            candidates: candidates
                .iter()
                .map(|candidate| candidate.as_str().to_string())
                .collect(),
        },
        Resolution::NonVault => ResolutionDto::NonVault,
    }
}

fn reference_kind(value: ReferenceKind) -> ReferenceKindDto {
    match value {
        ReferenceKind::MarkdownLink => ReferenceKindDto::MarkdownLink,
        ReferenceKind::Wikilink => ReferenceKindDto::Wikilink,
        ReferenceKind::MarkdownEmbed => ReferenceKindDto::MarkdownEmbed,
        ReferenceKind::WikiEmbed => ReferenceKindDto::WikiEmbed,
    }
}

fn reference_origin(value: ReferenceOrigin) -> ReferenceOriginDto {
    match value {
        ReferenceOrigin::Body => ReferenceOriginDto::Body,
        ReferenceOrigin::Property => ReferenceOriginDto::Property,
    }
}

pub(crate) fn reference(value: &ResolvedReference) -> ReferenceDto {
    ReferenceDto {
        source_path: value.source.as_str().to_string(),
        kind: reference_kind(value.reference.kind),
        origin: reference_origin(value.reference.origin),
        raw_target: value.reference.raw_target.clone(),
        file_target: value.reference.file_target.clone(),
        subpath: value.reference.subpath.as_ref().map(subpath),
        display: value.reference.display.clone(),
        span: span(value.reference.span),
        target_span: span(value.reference.target_span),
        resolution: resolution(&value.resolution),
    }
}

pub(crate) fn note_summary(value: &NoteSummary) -> NoteSummaryDto {
    NoteSummaryDto {
        path: value.path.as_str().to_string(),
        revision: value.revision.as_str().to_string(),
        title: value.title.clone(),
    }
}

pub(crate) fn note(value: IndexedNote) -> NoteDto {
    let parsed = &value.note;
    NoteDto {
        path: parsed.source.path().as_str().to_string(),
        revision: parsed.source.revision().as_str().to_string(),
        source: parsed.source.text().to_string(),
        properties: parsed
            .properties
            .iter()
            .map(|property| PropertyDto {
                key: property.key.value.clone(),
                value: property_value(&property.value.value),
                span: span(property.span),
                key_span: span(property.key.span),
                value_span: span(property.value.span),
            })
            .collect(),
        aliases: parsed
            .aliases
            .iter()
            .map(|alias| AliasDto {
                value: alias.value.clone(),
                span: span(alias.span),
            })
            .collect(),
        headings: parsed
            .headings
            .iter()
            .map(|heading| HeadingDto {
                level: heading.level,
                text: heading.text.clone(),
                span: span(heading.span),
            })
            .collect(),
        blocks: parsed
            .blocks
            .iter()
            .map(|block| BlockDto {
                value: block.value.clone(),
                span: span(block.span),
            })
            .collect(),
        tags: parsed
            .tags
            .iter()
            .map(|tag| TagDto {
                value: tag.value.clone(),
                comparison_key: tag.comparison_key.clone(),
                span: span(tag.span),
            })
            .collect(),
        diagnostics: value.diagnostics.iter().map(diagnostic).collect(),
        outgoing: value.outgoing.iter().map(reference).collect(),
    }
}

fn index_state(value: IndexState) -> IndexStateDto {
    match value {
        IndexState::Ready => IndexStateDto::Ready,
        IndexState::Stale { last_error } => IndexStateDto::Stale { last_error },
        IndexState::Unavailable { last_error } => IndexStateDto::Unavailable { last_error },
    }
}

pub(crate) fn vault_info(value: VaultInfo) -> GetVaultInfoResponse {
    GetVaultInfoResponse {
        generation: value.generation.get(),
        canonical_root: value.canonical_root.to_string_lossy().into_owned(),
        vault_identity: value.vault_identity,
        state: index_state(value.state),
        note_count: value.note_count,
        refreshed_at_unix_ms: value.refreshed_at_unix_ms,
    }
}

/// Map every index error to a stable protocol error. Messages never include
/// SQL text, cache paths, or backtraces.
pub(crate) fn index_error(value: IndexError) -> ProtocolError {
    let mut error = ProtocolError {
        code: ErrorCode::Internal,
        message: String::new(),
        supported_version: None,
        current_generation: None,
    };
    match value {
        IndexError::InvalidPath(message) => {
            error.code = ErrorCode::InvalidPath;
            error.message = format!("invalid vault path: {message}");
        }
        IndexError::InvalidCursor(message) => {
            error.code = ErrorCode::InvalidCursor;
            error.message = format!("invalid cursor: {message}");
        }
        IndexError::NoteNotFound(path) => {
            error.code = ErrorCode::NoteNotFound;
            error.message = format!("note not found: {path}");
        }
        IndexError::IndexUnavailable => {
            error.code = ErrorCode::IndexUnavailable;
            error.message = "no complete index generation is available".into();
        }
        IndexError::GenerationMismatch { cursor, current } => {
            error.code = ErrorCode::GenerationMismatch;
            error.message =
                format!("cursor generation {cursor} does not match current generation {current}");
            error.current_generation = Some(current);
        }
        IndexError::VaultChangedDuringRefresh => {
            error.code = ErrorCode::VaultChangedDuringRefresh;
            error.message = "the vault changed while refreshing; retry".into();
        }
        IndexError::IncompatibleIndex(_) => {
            error.code = ErrorCode::IncompatibleIndex;
            error.message = "the index is incompatible with this vault or version".into();
        }
        IndexError::Storage(_) => {
            error.code = ErrorCode::StorageFailure;
            error.message = "index storage failed".into();
        }
        IndexError::InvalidVaultRoot(_) => {
            error.code = ErrorCode::StorageFailure;
            error.message = "the vault root became unavailable".into();
        }
    }
    error
}
