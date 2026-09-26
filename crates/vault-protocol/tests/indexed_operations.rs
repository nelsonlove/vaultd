use vault_protocol::{
    ErrorCode, GetDiagnosticsParams, GetNoteResponse, GetTreeEntriesResponse, GetVaultInfoResponse,
    IndexStateDto, ListReferencesParams, LiveStateDto, NoteDto, NoteFacetDto, NotePathParams,
    PageParams, PathPageParams, ReferenceStatusFilter, Request, RequestEnvelope, ResolveLinkParams,
    Response, ResponseEnvelope, ResponseOutcome, SectionDto, SeverityDto, SpanDto, TreeEntryDto,
    TreeEntryKindDto,
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
            include: vec![NoteFacetDto::Sections],
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
fn old_vault_info_fixture_without_live_state_still_deserializes() {
    // Fixture as it existed before Task 11 added `live_state`. Additive
    // protocol change: an old JSON payload lacking the new field must still
    // decode.
    let json = r#"{
        "generation": 3,
        "canonical_root": "/vault",
        "vault_identity": "vault-1",
        "state": {"state": "ready"},
        "note_count": 10,
        "refreshed_at_unix_ms": 1000
    }"#;
    let decoded: GetVaultInfoResponse = serde_json::from_str(json).expect("deserialize response");
    assert_eq!(decoded.live_state, None);
    assert_eq!(decoded.generation, 3);
    assert_eq!(decoded.state, IndexStateDto::Ready);

    // Re-serializing an absent `live_state` must not synthesize the field.
    let reserialized = serde_json::to_string(&decoded).expect("serialize response");
    assert!(!reserialized.contains("live_state"));
}

#[test]
fn vault_info_response_round_trips_with_live_state_present() {
    let response = GetVaultInfoResponse {
        generation: 8,
        canonical_root: "/vault".into(),
        vault_identity: "vault-1".into(),
        state: IndexStateDto::Ready,
        note_count: 12,
        refreshed_at_unix_ms: Some(2000),
        live_state: Some(LiveStateDto::Watching),
        socket_path: None,
    };
    let json = serde_json::to_string(&response).expect("serialize response");
    assert!(json.contains("\"live_state\":\"watching\""));
    let decoded: GetVaultInfoResponse = serde_json::from_str(&json).expect("deserialize response");
    assert_eq!(decoded, response);
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

#[test]
fn get_note_asks_for_the_two_structural_facets_by_name() {
    let line = r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Folder/Note.md","include":["sections","list_items"]}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode get_note");
    match &envelope.request {
        Request::GetNote(params) => {
            assert_eq!(params.path, "Folder/Note.md");
            assert_eq!(
                params.include,
                vec![NoteFacetDto::Sections, NoteFacetDto::ListItems],
                "`include` reuses the snapshot facet names rather than inventing a second set"
            );
        }
        other => panic!("expected get_note, got {other:?}"),
    }
    // Byte-exact in the encode direction too: a same-struct round trip alone
    // would not catch a renamed `include` or a reordered facet list.
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);
}

/// The additive half. Every `get_note` a client already sends omits `include`
/// entirely, and must keep decoding to "ask for nothing" — the same
/// `#[serde(default)]` treatment `snapshot_notes` gives its own `include`.
#[test]
fn a_get_note_request_without_include_asks_for_no_structural_facet() {
    let line = r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Folder/Note.md"}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode get_note");
    match &envelope.request {
        Request::GetNote(params) => assert!(
            params.include.is_empty(),
            "an omitted `include` is the empty facet list, never a full hydration"
        ),
        other => panic!("expected get_note, got {other:?}"),
    }
}

/// A facet name this build has never heard of is `invalid_request` at decode
/// time — the evolution rule's field-versus-value split, which `get_note`'s
/// `include` inherits by reusing `NoteFacetDto`.
#[test]
fn an_unknown_get_note_facet_fails_to_decode_rather_than_meaning_nothing() {
    let line = r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"One.md","include":["sections","futures"]}}}"#;
    serde_json::from_str::<RequestEnvelope>(line)
        .expect_err("an unknown facet name must not decode to an empty ask");
}

/// The two new `NoteDto` facets follow the snapshot convention exactly:
/// absent when not requested, `[]` when requested and empty. Absent is not
/// empty, and the pin is on both halves in one shot.
#[test]
fn a_notes_structural_facets_are_absent_unless_they_were_requested() {
    let mut note = NoteDto::empty_for_test(
        "One.md",
        "blake3:abc",
        "# One\n",
        SpanDto { start: 0, end: 6 },
    );
    let encoded = serde_json::to_string(&note).expect("encode");
    assert!(
        !encoded.contains("sections") && !encoded.contains("list_items"),
        "an unrequested facet must be absent, not an empty list: {encoded}"
    );

    note.sections = Some(vec![SectionDto {
        kind: "heading".into(),
        span: SpanDto { start: 0, end: 6 },
        block_id: Some("anchor".into()),
    }]);
    note.list_items = Some(Vec::new());
    let encoded = serde_json::to_string(&note).expect("encode");
    assert!(
        encoded.ends_with(
            r#""sections":[{"kind":"heading","span":{"start":0,"end":6},"block_id":"anchor"}],"list_items":[]}"#
        ),
        "the two facets are appended after `outgoing`, in that order: {encoded}"
    );
    let decoded: NoteDto = serde_json::from_str(&encoded).expect("decode");
    assert_eq!(decoded, note);
}

#[test]
fn get_tree_entries_names_the_paths_it_wants_in_request_order() {
    let line = r#"{"version":1,"id":"te","request":{"method":"get_tree_entries","params":{"paths":["Attachments/a.png","Folder","gone.txt"]}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode get_tree_entries");
    match &envelope.request {
        Request::GetTreeEntries(params) => {
            assert_eq!(
                params.paths,
                vec!["Attachments/a.png", "Folder", "gone.txt"]
            );
        }
        other => panic!("expected get_tree_entries, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);
}

/// The response's three field names and their order, plus the two rules that
/// make `absent` worth having: a path with no row is listed there rather than
/// failing the request, and `entries` carries only what was found.
#[test]
fn a_tree_entries_response_separates_what_was_found_from_what_was_absent() {
    let response = ResponseEnvelope::success(
        "te",
        Response::GetTreeEntries(GetTreeEntriesResponse {
            generation: 12,
            entries: vec![
                TreeEntryDto {
                    path: "Attachments/a.png".into(),
                    kind: TreeEntryKindDto::File,
                    size: Some(7),
                    ctime_unix_ms: 1_700_000_001_000,
                    mtime_unix_ms: 1_700_000_002_000,
                    revision: None,
                },
                TreeEntryDto {
                    path: "Folder".into(),
                    kind: TreeEntryKindDto::Folder,
                    size: None,
                    ctime_unix_ms: 1_700_000_001_000,
                    mtime_unix_ms: 1_700_000_002_000,
                    revision: None,
                },
            ],
            absent: vec!["gone.txt".into()],
        }),
    );
    let line = r#"{"version":1,"id":"te","outcome":{"status":"ok","value":{"type":"get_tree_entries","value":{"generation":12,"entries":[{"path":"Attachments/a.png","kind":"file","size":7,"ctime_unix_ms":1700000001000,"mtime_unix_ms":1700000002000},{"path":"Folder","kind":"folder","ctime_unix_ms":1700000001000,"mtime_unix_ms":1700000002000}],"absent":["gone.txt"]}}}}"#;
    assert_eq!(serde_json::to_string(&response).expect("encode"), line);
    let decoded: ResponseEnvelope = serde_json::from_str(line).expect("decode");
    assert_eq!(decoded, response);
}

/// An empty answer still names its generation: "nothing is there at
/// generation 12" is a different statement from "I could not tell you".
#[test]
fn an_empty_tree_entries_answer_still_names_its_generation() {
    let response = GetTreeEntriesResponse {
        generation: 12,
        entries: Vec::new(),
        absent: Vec::new(),
    };
    assert_eq!(
        serde_json::to_string(&response).expect("encode"),
        r#"{"generation":12,"entries":[],"absent":[]}"#
    );
}
