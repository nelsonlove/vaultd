mod convert;

use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexService, ReferenceStatus};
use vault_protocol::{
    ErrorCode, PageResponse, ProtocolError, ReferenceStatusFilter, RefreshIndexResponse, Request,
    RequestEnvelope, ResolveLinkResponse, Response, ResponseEnvelope, SeverityDto,
    validate_version,
};

pub struct Server {
    index: Option<IndexService>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServerStartupError {
    #[error(transparent)]
    Index(#[from] IndexError),
}

fn index_unavailable() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::IndexUnavailable,
        message: "no vault is configured".into(),
        supported_version: None,
        current_generation: None,
    }
}

fn parse_path(value: &str) -> Result<VaultPath, ProtocolError> {
    VaultPath::new(value).map_err(|_| ProtocolError {
        code: ErrorCode::InvalidPath,
        message: format!("invalid vault path: {value:?}"),
        supported_version: None,
        current_generation: None,
    })
}

fn status_filter(value: ReferenceStatusFilter) -> ReferenceStatus {
    match value {
        ReferenceStatusFilter::Resolved => ReferenceStatus::Resolved,
        ReferenceStatusFilter::Unresolved => ReferenceStatus::Unresolved,
        ReferenceStatusFilter::Ambiguous => ReferenceStatus::Ambiguous,
    }
}

fn severity_filter(value: SeverityDto) -> vault_core::Severity {
    match value {
        SeverityDto::Warning => vault_core::Severity::Warning,
        SeverityDto::Error => vault_core::Severity::Error,
    }
}

impl Server {
    pub fn health_only() -> Self {
        Self { index: None }
    }

    pub fn for_index(index: IndexService) -> Self {
        Self { index: Some(index) }
    }

    /// Open the index service and attempt one normal refresh. A refresh
    /// failure with a representable stale/unavailable state still starts the
    /// daemon; opening the storage itself must succeed.
    pub fn open(config: IndexConfig) -> Result<Self, ServerStartupError> {
        let mut index = IndexService::open(config)?;
        if let Err(error) = index.refresh(false) {
            index.record_refresh_failure(&error)?;
        }
        Ok(Self::for_index(index))
    }

    pub fn handle(&mut self, request: RequestEnvelope) -> ResponseEnvelope {
        let id = request.id;
        if let Err(error) = validate_version(request.version) {
            return ResponseEnvelope::error(id, error);
        }

        match request.request {
            Request::Health => ResponseEnvelope::success(id, Response::health("vaultd")),
            Request::GetVaultInfo => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match index.vault_info() {
                    Ok(info) => ResponseEnvelope::success(
                        id,
                        Response::GetVaultInfo(convert::vault_info(info)),
                    ),
                    Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                },
            },
            Request::ListNotes(params) => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match index.list_notes(params.cursor.as_deref(), params.limit) {
                    Ok(page) => ResponseEnvelope::success(
                        id,
                        Response::ListNotes(PageResponse {
                            generation: page.generation.get(),
                            items: page.items.iter().map(convert::note_summary).collect(),
                            next_cursor: page.next_cursor,
                        }),
                    ),
                    Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                },
            },
            Request::GetNote(params) => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match parse_path(&params.path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(path) => match index.get_note(&path) {
                        Ok(indexed) => {
                            let generation = indexed.generation.get();
                            ResponseEnvelope::success(
                                id,
                                Response::GetNote(vault_protocol::GetNoteResponse {
                                    generation,
                                    note: convert::note(indexed),
                                }),
                            )
                        }
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    },
                },
            },
            Request::ResolveLink(params) => match self.index.as_mut() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match parse_path(&params.source_path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(source) => match index.resolve_link(&source, &params.destination) {
                        Ok((generation, resolution)) => ResponseEnvelope::success(
                            id,
                            Response::ResolveLink(ResolveLinkResponse {
                                generation: generation.get(),
                                resolution: convert::resolution(&resolution),
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    },
                },
            },
            Request::GetBacklinks(params) => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match parse_path(&params.path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(path) => {
                        match index.get_backlinks(&path, params.cursor.as_deref(), params.limit) {
                            Ok(page) => ResponseEnvelope::success(
                                id,
                                Response::GetBacklinks(PageResponse {
                                    generation: page.generation.get(),
                                    items: page.items.iter().map(convert::reference).collect(),
                                    next_cursor: page.next_cursor,
                                }),
                            ),
                            Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                        }
                    }
                },
            },
            Request::ListReferences(params) => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => {
                    let source = match params.source_path.as_deref().map(parse_path).transpose() {
                        Ok(source) => source,
                        Err(error) => return ResponseEnvelope::error(id, error),
                    };
                    match index.list_references(
                        source.as_ref(),
                        params.status.map(status_filter),
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::ListReferences(PageResponse {
                                generation: page.generation.get(),
                                items: page.items.iter().map(convert::reference).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::GetDiagnostics(params) => match self.index.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => {
                    let path = match params.path.as_deref().map(parse_path).transpose() {
                        Ok(path) => path,
                        Err(error) => return ResponseEnvelope::error(id, error),
                    };
                    match index.get_diagnostics(
                        path.as_ref(),
                        params.severity.map(severity_filter),
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::GetDiagnostics(PageResponse {
                                generation: page.generation.get(),
                                items: page.items.iter().map(convert::diagnostic).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::RefreshIndex(params) => match self.index.as_mut() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(index) => match index.refresh(params.verify) {
                    Ok(report) => ResponseEnvelope::success(
                        id,
                        Response::RefreshIndex(RefreshIndexResponse {
                            previous_generation: report
                                .previous_generation
                                .map(vault_index::Generation::get),
                            generation: report.generation.get(),
                            added: report.added,
                            changed: report.changed,
                            deleted: report.deleted,
                            unchanged: report.unchanged,
                            reparsed: report.reparsed,
                            verified: report.verified,
                        }),
                    ),
                    Err(error) => {
                        let response = convert::index_error(error);
                        let _ = self
                            .index
                            .as_mut()
                            .expect("index is present on this arm")
                            .record_refresh_failure(&IndexError::Storage(response.message.clone()));
                        ResponseEnvelope::error(id, response)
                    }
                },
            },
        }
    }
}
