use vault_protocol::{
    ErrorCode, GetDiagnosticsParams, GetNoteResponse, ListReferencesParams, NoteDto,
    NotePathParams, PageParams, PathPageParams, ReferenceStatusFilter, Request, RequestEnvelope,
    ResolveLinkParams, Response, ResponseEnvelope, ResponseOutcome, SeverityDto, SpanDto,
};

#[test]
fn every_indexed_request_round_trips_under_protocol_version_one() {
    let requests = [
        Request::GetVaultInfo,
        Request::ListNotes(PageParams {
            cursor: None,
            limit: Some(100),
        }),
        Request::GetNote(NotePathParams {
            path: "Folder/Note.md".into(),
        }),
        Request::ResolveLink(ResolveLinkParams {
            source_path: "Folder/Note.md".into(),
            destination: "Other#Heading".into(),
        }),
        Request::GetBacklinks(PathPageParams {
            path: "Folder/Note.md".into(),
            cursor: None,
            limit: Some(50),
        }),
        Request::ListReferences(ListReferencesParams {
            source_path: Some("Folder/Note.md".into()),
            status: Some(ReferenceStatusFilter::Resolved),
            cursor: None,
            limit: Some(50),
        }),
        Request::GetDiagnostics(GetDiagnosticsParams {
            path: None,
            severity: Some(SeverityDto::Warning),
            cursor: None,
            limit: Some(50),
        }),
        Request::RefreshIndex(vault_protocol::RefreshIndexParams { verify: true }),
    ];

    for (index, request) in requests.into_iter().enumerate() {
        let envelope = RequestEnvelope::new(format!("indexed-{index}"), request);
        let json = serde_json::to_string(&envelope).expect("serialize request");
        let decoded: RequestEnvelope = serde_json::from_str(&json).expect("deserialize request");
        assert_eq!(decoded, envelope);
    }
}

#[test]
fn indexed_note_response_carries_generation_and_exact_spans() {
    let response = ResponseEnvelope::success(
        "note-1",
        Response::GetNote(GetNoteResponse {
            generation: 7,
            note: NoteDto::empty_for_test(
                "Folder/Note.md",
                "blake3:abc",
                "# Note\n",
                SpanDto { start: 0, end: 6 },
            ),
        }),
    );
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: ResponseEnvelope = serde_json::from_str(&json).expect("deserialize response");

    assert_eq!(decoded, response);
    assert!(matches!(
        decoded.outcome,
        ResponseOutcome::Ok(Response::GetNote(_))
    ));
    assert!(json.contains("\"generation\":7"));
}

#[test]
fn indexed_error_codes_are_stable_snake_case_values() {
    assert_eq!(
        serde_json::to_string(&ErrorCode::GenerationMismatch).unwrap(),
        "\"generation_mismatch\""
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::VaultChangedDuringRefresh).unwrap(),
        "\"vault_changed_during_refresh\""
    );
}
