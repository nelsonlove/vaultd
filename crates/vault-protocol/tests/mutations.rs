//! The mutation request and response shapes, pinned to the exact JSON the
//! design names. Wire spellings are contractual: a rename here is a protocol
//! break, not a refactor.

use vault_protocol::{
    CopyConflictDto, DeleteModeDto, ExpectedDto, LinkRewriteFailureDto, MutationResponse,
    PatchValueDto, RenameResponse, Request, RequestEnvelope, Response, ResponseEnvelope,
    ResponseOutcome, WriteNoteParams,
};

#[test]
fn a_write_note_request_round_trips_through_its_documented_json() {
    let line = r##"{"version":1,"id":"w1","request":{"method":"write_note","params":{"path":"One.md","content":"# One\n","expected":{"revision":"blake3:abc"}}}}"##;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode write_note");
    match &envelope.request {
        Request::WriteNote(params) => {
            assert_eq!(params.path, "One.md");
            assert_eq!(params.content, "# One\n");
            assert_eq!(params.expected.revision.as_deref(), Some("blake3:abc"));
            assert_eq!(params.expected.absent, None);
            assert_eq!(params.expected.any, None);
        }
        other => panic!("expected write_note, got {other:?}"),
    }
    assert_eq!(
        serde_json::to_string(&envelope).expect("re-encode"),
        line,
        "the encoded form must be byte-identical to the documented one"
    );
}

#[test]
fn the_three_expected_shapes_each_decode_to_exactly_one_field() {
    let absent: ExpectedDto =
        serde_json::from_str(r#"{"absent":true}"#).expect("decode absent precondition");
    assert_eq!(absent.absent, Some(true));
    assert_eq!(absent.revision, None);

    let any: ExpectedDto =
        serde_json::from_str(r#"{"any":true}"#).expect("decode any precondition");
    assert_eq!(any.any, Some(true));

    let empty: ExpectedDto = serde_json::from_str("{}").expect("an omitted precondition decodes");
    assert_eq!(empty.revision, None);
    assert_eq!(empty.absent, None);
    assert_eq!(empty.any, None);

    let extra = serde_json::from_str::<ExpectedDto>(r#"{"whatever":true}"#);
    assert!(
        extra.is_err(),
        "an unknown precondition field is a client bug, not a variant to tolerate"
    );
}

#[test]
fn a_write_note_request_omits_an_absent_precondition_entirely() {
    let params = WriteNoteParams {
        path: "One.md".into(),
        content: "# One\n".into(),
        expected: ExpectedDto::default(),
    };
    assert_eq!(
        serde_json::to_string(&params).expect("encode"),
        r##"{"path":"One.md","content":"# One\n","expected":{}}"##
    );
}

#[test]
fn delete_and_copy_modes_use_their_documented_spellings() {
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::TrashSystem).expect("encode"),
        r#""trash_system""#
    );
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::TrashLocal).expect("encode"),
        r#""trash_local""#
    );
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::Permanent).expect("encode"),
        r#""permanent""#
    );
    assert_eq!(
        serde_json::to_string(&CopyConflictDto::Error).expect("encode"),
        r#""error""#
    );
    assert_eq!(
        serde_json::to_string(&CopyConflictDto::Suffix).expect("encode"),
        r#""suffix""#
    );
}

#[test]
fn a_frontmatter_patch_carries_dot_paths_and_a_null_deletion() {
    let line = r#"{"version":1,"id":"p1","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a.b.c","value":"set"},{"key_path":"gone","value":null}],"expected":{"any":true}}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode patch_frontmatter");
    match &envelope.request {
        Request::PatchFrontmatter(params) => {
            assert_eq!(params.patch.len(), 2);
            assert_eq!(params.patch[0].key_path, "a.b.c");
            assert_eq!(
                params.patch[0].value,
                Some(PatchValueDto::String("set".into()))
            );
            assert_eq!(
                params.patch[1].value, None,
                "an explicit JSON null is the deletion spelling"
            );
        }
        other => panic!("expected patch_frontmatter, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);
}

#[test]
fn a_patch_value_decodes_every_json_shape_the_design_allows() {
    let sequence: PatchValueDto =
        serde_json::from_str(r#"["one",2,true]"#).expect("decode a sequence");
    assert_eq!(
        sequence,
        PatchValueDto::Sequence(vec![
            PatchValueDto::String("one".into()),
            PatchValueDto::Integer(2),
            PatchValueDto::Boolean(true),
        ])
    );
    let mapping: PatchValueDto =
        serde_json::from_str(r#"{"key":"value"}"#).expect("decode a mapping");
    assert_eq!(
        mapping,
        PatchValueDto::Mapping(vec![(
            "key".to_string(),
            PatchValueDto::String("value".into())
        )])
    );
    let float: PatchValueDto = serde_json::from_str("1.5").expect("decode a float");
    assert_eq!(float, PatchValueDto::Float(1.5));
}

#[test]
fn a_mutation_response_reports_its_generation_and_revision() {
    let response = ResponseEnvelope::success(
        "w1",
        Response::WriteNote(MutationResponse {
            generation: 4,
            revision: "blake3:def".into(),
        }),
    );
    assert_eq!(
        serde_json::to_string(&response).expect("encode"),
        r#"{"version":1,"id":"w1","outcome":{"status":"ok","value":{"type":"write_note","value":{"generation":4,"revision":"blake3:def"}}}}"#
    );
}

#[test]
fn a_rename_response_reports_rewrites_and_the_files_it_skipped() {
    let response = ResponseEnvelope::success(
        "r1",
        Response::RenameNote(RenameResponse {
            generation: 5,
            revision: "blake3:def".into(),
            links_rewritten: 3,
            link_rewrite_failures: vec![LinkRewriteFailureDto {
                path: "Busy.md".into(),
                reason: "revision_conflict".into(),
            }],
        }),
    );
    let encoded = serde_json::to_string(&response).expect("encode");
    assert!(encoded.contains(r#""links_rewritten":3"#), "{encoded}");
    assert!(
        encoded.contains(
            r#""link_rewrite_failures":[{"path":"Busy.md","reason":"revision_conflict"}]"#
        ),
        "{encoded}"
    );
}

#[test]
fn a_revision_conflict_carries_both_the_current_revision_and_generation() {
    let line = r#"{"version":1,"id":"w1","outcome":{"status":"err","value":{"code":"revision_conflict","message":"One.md moved","current_generation":7,"current_revision":"blake3:ghi"}}}"#;
    let envelope: ResponseEnvelope = serde_json::from_str(line).expect("decode conflict");
    match envelope.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, vault_protocol::ErrorCode::RevisionConflict);
            assert_eq!(error.current_generation, Some(7));
            assert_eq!(error.current_revision.as_deref(), Some("blake3:ghi"));
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}
