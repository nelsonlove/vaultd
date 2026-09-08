use vault_core::{
    Diagnostic, DiagnosticCode, PropertyValue, ReferenceKind, ReferenceOrigin, Resolution,
    ResolvedReference, Severity, SourceSpan, Subpath,
};
use vault_index::{
    CopyConflict, DeleteMode, FrontmatterEdit, IndexError, IndexState, IndexedNote, NoteSummary,
    PatchValue, Precondition, VaultInfo,
};
use vault_protocol::{
    AliasDto, BlockDto, CopyConflictDto, DeleteModeDto, DiagnosticDto, ErrorCode, ExpectedDto,
    FrontmatterEditDto, GetVaultInfoResponse, HeadingDto, IndexStateDto, LinkRewriteFailureDto,
    LiveStateDto, NoteDto, NoteSummaryDto, PatchValueDto, PropertyDto, PropertyMappingEntryDto,
    PropertyValueDto, ProtocolError, ReferenceDto, ReferenceKindDto, ReferenceOriginDto,
    ResolutionDto, SeverityDto, SpanDto, SpannedPropertyValueDto, SubpathDto, TagDto,
};

use crate::runtime::{MutationFailure, RefreshFailure};

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

/// `live_state` is `None` for a server with no runtime — health-only mode —
/// and is otherwise the runtime's own observational state. It stays optional
/// on the wire precisely so a transport without a runtime says nothing
/// rather than guessing.
pub(crate) fn vault_info(
    value: VaultInfo,
    live_state: Option<LiveStateDto>,
) -> GetVaultInfoResponse {
    GetVaultInfoResponse {
        generation: value.generation.get(),
        canonical_root: value.canonical_root.to_string_lossy().into_owned(),
        vault_identity: value.vault_identity,
        state: index_state(value.state),
        note_count: value.note_count,
        refreshed_at_unix_ms: value.refreshed_at_unix_ms,
        live_state,
    }
}

/// A refresh that produced no report. The three cases are distinct on the
/// wire because a client can act on the difference: retry soon, never retry,
/// or treat it as an index failure.
pub(crate) fn refresh_failure(value: RefreshFailure) -> ProtocolError {
    match value {
        RefreshFailure::Overloaded => ProtocolError {
            code: ErrorCode::RuntimeOverloaded,
            message: "the runtime is saturated; the vault will be reconciled completely".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        RefreshFailure::NotReady => ProtocolError {
            code: ErrorCode::RuntimeNotReady,
            message: "the runtime is not running".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        RefreshFailure::Failed(error) => index_error(error),
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
        current_revision: None,
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
        // `Busy` and `LiveStateStale` are distinct *internally* — one is
        // retryable lock contention, the other is cured by
        // `resync_published` — but both deliberately keep the existing
        // `StorageFailure` code and message here. The protocol work that
        // added dedicated codes considered these and kept this mapping:
        // both faults are invisible to a well-behaved client (the runtime
        // retries or resyncs before answering), so a distinct wire code
        // would document noise, and protocol output stays byte-identical
        // to what a single `Storage` variant produced.
        IndexError::Busy(_) | IndexError::LiveStateStale(_) | IndexError::Storage(_) => {
            error.code = ErrorCode::StorageFailure;
            error.message = "index storage failed".into();
        }
        IndexError::IncompleteResolutionCoverage(_) => {
            error.code = ErrorCode::StorageFailure;
            error.message = "index storage failed".into();
        }
        IndexError::InvalidVaultRoot(_) => {
            error.code = ErrorCode::StorageFailure;
            error.message = "the vault root became unavailable".into();
        }
        IndexError::InvalidIndexPath(message) => {
            error.code = ErrorCode::InvalidPath;
            error.message = format!("invalid index path: {message}");
        }
        // A different writer holds the exclusive lease on this cache. Not a
        // storage failure and not retryable by this process: nothing here is
        // damaged, and nothing this process does will make the lease
        // available.
        IndexError::IndexInUse => {
            error.code = ErrorCode::IndexInUse;
            error.message = "the index is held by another writer".into();
        }
        // One mapping, one place. The dispatch path calls `mutation_error`
        // directly for the refusals it produces itself, and this arm routes
        // the ones that arrive wrapped in an `IndexError` to exactly the same
        // table — a refusal must never mean two different things depending on
        // which layer carried it.
        IndexError::Mutation(refusal) => return mutation_error(refusal),
    }
    error
}

/// Map one mutation refusal onto its typed protocol error. Every one of these
/// means *nothing changed*, so the codes are precise on purpose: a client
/// retries a `revision_conflict`, fixes a `parent_not_found`, and gives up on
/// a `read_only`.
pub(crate) fn mutation_error(value: vault_index::MutationError) -> ProtocolError {
    use vault_index::MutationError;

    let mut error = ProtocolError {
        code: ErrorCode::Internal,
        message: value.to_string(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    };
    match value {
        MutationError::RevisionConflict { current, .. } => {
            error.code = ErrorCode::RevisionConflict;
            error.current_revision = current;
        }
        MutationError::NotFound { .. } => error.code = ErrorCode::NotFound,
        MutationError::ParentNotFound { .. } => error.code = ErrorCode::ParentNotFound,
        // A folder that is not empty is refused for the same reason a taken
        // path is: something is already there.
        MutationError::TargetExists { .. } | MutationError::FolderNotEmpty { .. } => {
            error.code = ErrorCode::TargetExists;
        }
        MutationError::CaseCollision { .. } => error.code = ErrorCode::CaseCollision,
        MutationError::ZoneViolation { .. } => error.code = ErrorCode::ZoneViolation,
        MutationError::TooLarge { .. } => error.code = ErrorCode::PayloadTooLarge,
        MutationError::ReadOnly => error.code = ErrorCode::ReadOnly,
        // Every one of these is a malformed request rather than a state
        // conflict: no retry helps, and the caller has to change what it
        // asked for. `UnaddressablePatch` is the narrowed post-correction-#9
        // variant — a path with no value to address at all — not the old
        // "below stored-span granularity", which is now served rather than
        // refused.
        MutationError::NotANote { .. }
        | MutationError::IsANote { .. }
        | MutationError::InvalidPrecondition { .. }
        | MutationError::UnaddressablePatch { .. }
        | MutationError::MalformedFrontmatter { .. }
        | MutationError::AnchoredProperty { .. }
        | MutationError::OverlappingPatch => error.code = ErrorCode::InvalidRequest,
        MutationError::Io { .. } => {
            error.code = ErrorCode::StorageFailure;
            // Never leak a filesystem path or an OS error string.
            error.message = "the vault filesystem write failed".into();
        }
    }
    error
}

/// A mutation that produced no report.
///
/// `Unpublished` is why this is not just [`index_error`]. The write it belongs
/// to *reached disk* and only its generation is missing, and a client's next
/// move differs completely between "nothing happened, retry" and "it happened,
/// the index is behind". Rather than invent a code for a state that is still a
/// storage failure, the difference is carried in the payload the protocol
/// already has: `current_revision` names the revision now on disk. Present
/// means the bytes landed; absent means they did not. `docs/protocol.md`'s
/// `storage_failure` row states the same rule to clients.
///
/// The mapping is **unconditional** — the inner `IndexError` chooses nothing.
/// It describes why the *reconciliation* failed, and every one of its codes
/// would say something false about the mutation: `vault_changed_during_refresh`
/// is documented as "nothing was published", which is true of a refresh and
/// exactly backwards here, and passing it through would recreate the
/// blind-retry hazard one code over from where it was fixed. One situation,
/// one code, with the revision as the proof.
pub(crate) fn mutation_failure(value: MutationFailure) -> ProtocolError {
    match value {
        MutationFailure::Unpublished { revision, .. } => ProtocolError {
            code: ErrorCode::StorageFailure,
            message: "the write reached the vault but its generation was not published".into(),
            supported_version: None,
            current_generation: None,
            current_revision: revision,
        },
        MutationFailure::Overloaded => ProtocolError {
            code: ErrorCode::RuntimeOverloaded,
            message: "the runtime is saturated; retry this mutation".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        MutationFailure::NotReady => ProtocolError {
            code: ErrorCode::RuntimeNotReady,
            message: "the runtime is not running".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        MutationFailure::Failed(error) => index_error(error),
    }
}

fn invalid_request(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::InvalidRequest,
        message: message.into(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    }
}

/// Exactly one precondition field may be set. A two-field precondition has no
/// meaning, and silently preferring one would turn a client's typo into an
/// unconditional overwrite.
pub(crate) fn precondition(value: Option<&ExpectedDto>) -> Result<Precondition, ProtocolError> {
    // Omitting `expected` entirely means unconditional. An expected object
    // that is PRESENT but names no field is a typo-shaped client bug and is
    // refused (checkpoint-1 ruling I1).
    let Some(value) = value else {
        return Ok(Precondition::Any);
    };
    match (&value.revision, value.absent, value.any) {
        (Some(revision), None, None) => Ok(Precondition::Revision(revision.clone())),
        (None, Some(true), None) => Ok(Precondition::Absent),
        (None, None, Some(true)) => Ok(Precondition::Any),
        (None, Some(false), None) | (None, None, Some(false)) => Err(invalid_request(
            "expected.absent and expected.any must be true when present",
        )),
        _ => Err(invalid_request(
            "expected must name exactly one of revision, absent, or any",
        )),
    }
}

pub(crate) fn delete_mode(value: DeleteModeDto) -> DeleteMode {
    match value {
        DeleteModeDto::TrashSystem => DeleteMode::TrashSystem,
        DeleteModeDto::TrashLocal => DeleteMode::TrashLocal,
        DeleteModeDto::Permanent => DeleteMode::Permanent,
    }
}

pub(crate) fn copy_conflict(value: CopyConflictDto) -> CopyConflict {
    match value {
        CopyConflictDto::Error => CopyConflict::Error,
        CopyConflictDto::Suffix => CopyConflict::Suffix,
    }
}

pub(crate) fn patch_value(value: &PatchValueDto) -> PatchValue {
    match value {
        PatchValueDto::Boolean(value) => PatchValue::Boolean(*value),
        PatchValueDto::Integer(value) => PatchValue::Integer(*value),
        PatchValueDto::Float(value) => PatchValue::Float(*value),
        PatchValueDto::String(value) => PatchValue::String(value.clone()),
        PatchValueDto::Sequence(items) => {
            PatchValue::Sequence(items.iter().map(patch_value).collect())
        }
        PatchValueDto::Mapping(entries) => PatchValue::Mapping(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), patch_value(value)))
                .collect(),
        ),
    }
}

/// Split each wire dot-path into segments. An empty path, or a path with an
/// empty segment, is a client bug rather than a key named "".
pub(crate) fn frontmatter_edits(
    edits: &[FrontmatterEditDto],
) -> Result<Vec<FrontmatterEdit>, ProtocolError> {
    let mut converted = Vec::with_capacity(edits.len());
    for edit in edits {
        let segments: Vec<String> = edit.key_path.split('.').map(str::to_string).collect();
        if segments.iter().any(String::is_empty) {
            return Err(invalid_request(&format!(
                "invalid frontmatter key path: {:?}",
                edit.key_path
            )));
        }
        converted.push(FrontmatterEdit {
            key_path: segments,
            value: edit.value.as_ref().map(patch_value),
        });
    }
    Ok(converted)
}

pub(crate) fn link_rewrite_failures(
    failures: Vec<vault_index::LinkRewriteFailure>,
) -> Vec<LinkRewriteFailureDto> {
    failures
        .into_iter()
        .map(|failure| LinkRewriteFailureDto {
            path: failure.path.as_str().to_string(),
            reason: failure.reason.as_str().to_string(),
        })
        .collect()
}
