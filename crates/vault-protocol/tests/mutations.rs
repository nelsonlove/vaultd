//! The mutation request and response shapes, pinned to the exact JSON the
//! design names. Wire spellings are contractual: a rename here is a protocol
//! break, not a refactor.

use vault_protocol::{
    CopyConflictDto, DeleteModeDto, ExpectedDto, GenerationResponse, KeyPathDto,
    LinkRewriteFailureDto, MutationResponse, PatchValueDto, ReadFileResponse, RenameResponse,
    Request, RequestEnvelope, Response, ResponseEnvelope, ResponseOutcome, WriteFileResponse,
    WriteNoteParams,
};

#[test]
fn a_write_note_request_round_trips_through_its_documented_json() {
    let line = r##"{"version":1,"id":"w1","request":{"method":"write_note","params":{"path":"One.md","content":"# One\n","expected":{"revision":"blake3:abc"}}}}"##;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode write_note");
    match &envelope.request {
        Request::WriteNote(params) => {
            assert_eq!(params.path, "One.md");
            assert_eq!(params.content, "# One\n");
            let expected = params.expected.as_ref().expect("precondition present");
            assert_eq!(expected.revision.as_deref(), Some("blake3:abc"));
            assert_eq!(expected.absent, None);
            assert_eq!(expected.any, None);
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
    // Omission means unconditional and the key disappears from the wire; an
    // explicit empty object is a distinct (and refusable) shape, so the two
    // must not serialize alike.
    let params = WriteNoteParams {
        path: "One.md".into(),
        content: "# One\n".into(),
        expected: None,
    };
    assert_eq!(
        serde_json::to_string(&params).expect("encode"),
        r##"{"path":"One.md","content":"# One\n"}"##
    );
    let explicit_empty = WriteNoteParams {
        expected: Some(ExpectedDto::default()),
        ..params
    };
    assert_eq!(
        serde_json::to_string(&explicit_empty).expect("encode"),
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
            revision: Some("blake3:def".into()),
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

/// The module header claims every wire spelling here is pinned. Before this
/// test, only `write_note` and `patch_frontmatter` actually were — nothing
/// guarded `create_folder`, `rename_note`, `rename_folder`, `copy_file`,
/// `delete_note`, `delete_folder`, `write_file`, or `read_file`, nor their
/// field names. A rename during a later refactor would otherwise be a
/// silent protocol break with a green suite.
#[test]
fn every_new_method_name_and_field_spelling_round_trips_through_its_exact_json() {
    let lines = [
        r##"{"version":1,"id":"1","request":{"method":"write_note","params":{"path":"a.md","content":"c","expected":{"any":true}}}}"##,
        r##"{"version":1,"id":"2","request":{"method":"create_folder","params":{"path":"a"}}}"##,
        r##"{"version":1,"id":"3","request":{"method":"rename_note","params":{"from":"a.md","to":"b.md","expected":{"any":true},"rewrite_links":true}}}"##,
        r##"{"version":1,"id":"4","request":{"method":"rename_folder","params":{"from":"a","to":"b","rewrite_links":true}}}"##,
        r##"{"version":1,"id":"5","request":{"method":"copy_file","params":{"from":"a.md","to":"b.md","expected_source":{"any":true},"if_exists":"error"}}}"##,
        r##"{"version":1,"id":"6","request":{"method":"delete_note","params":{"path":"a.md","expected":{"any":true}}}}"##,
        r##"{"version":1,"id":"7","request":{"method":"delete_folder","params":{"path":"a","mode":"trash_local","recursive":true}}}"##,
        r##"{"version":1,"id":"8","request":{"method":"patch_frontmatter","params":{"path":"a.md","patch":[],"expected":{"any":true}}}}"##,
        r##"{"version":1,"id":"9","request":{"method":"write_file","params":{"path":"a.png","content_base64":"Zm9v","expected":{"any":true}}}}"##,
        r##"{"version":1,"id":"10","request":{"method":"read_file","params":{"path":"a.png"}}}"##,
    ];
    for line in lines {
        let envelope: RequestEnvelope =
            serde_json::from_str(line).unwrap_or_else(|error| panic!("decode {line}: {error}"));
        assert_eq!(
            serde_json::to_string(&envelope).expect("re-encode"),
            line,
            "re-encode must match the documented spelling exactly"
        );
    }
}

/// Same guarantee on the response side, including the two omission rules the
/// module doc calls out: `mode`/`generation`-style optional fields disappear
/// entirely when absent rather than serializing as `null`.
#[test]
fn every_new_response_shape_round_trips_through_its_exact_json() {
    let cases: [(Response, &str); 12] = [
        (
            Response::WriteNote(MutationResponse {
                generation: 1,
                revision: "r".into(),
            }),
            r#"{"type":"write_note","value":{"generation":1,"revision":"r"}}"#,
        ),
        (
            Response::CreateFolder(GenerationResponse {
                generation: Some(2),
            }),
            r#"{"type":"create_folder","value":{"generation":2}}"#,
        ),
        // The unindexable half of the same verb: a folder the index will never
        // list joins no generation, and the key is omitted outright rather
        // than fabricated as `0` — which is a well-formed generation a client
        // would then read at.
        (
            Response::CreateFolder(GenerationResponse { generation: None }),
            r#"{"type":"create_folder","value":{}}"#,
        ),
        (
            Response::RenameNote(RenameResponse {
                generation: 3,
                revision: Some("r".into()),
                links_rewritten: 0,
                link_rewrite_failures: vec![],
            }),
            r#"{"type":"rename_note","value":{"generation":3,"revision":"r","links_rewritten":0,"link_rewrite_failures":[]}}"#,
        ),
        (
            Response::RenameFolder(RenameResponse {
                generation: 4,
                revision: None,
                links_rewritten: 1,
                link_rewrite_failures: vec![],
            }),
            r#"{"type":"rename_folder","value":{"generation":4,"links_rewritten":1,"link_rewrite_failures":[]}}"#,
        ),
        (
            Response::CopyFile(MutationResponse {
                generation: 5,
                revision: "r".into(),
            }),
            r#"{"type":"copy_file","value":{"generation":5,"revision":"r"}}"#,
        ),
        (
            Response::DeleteNote(GenerationResponse {
                generation: Some(6),
            }),
            r#"{"type":"delete_note","value":{"generation":6}}"#,
        ),
        (
            Response::DeleteFolder(GenerationResponse {
                generation: Some(7),
            }),
            r#"{"type":"delete_folder","value":{"generation":7}}"#,
        ),
        (
            Response::PatchFrontmatter(MutationResponse {
                generation: 8,
                revision: "r".into(),
            }),
            r#"{"type":"patch_frontmatter","value":{"generation":8,"revision":"r"}}"#,
        ),
        (
            Response::WriteFile(WriteFileResponse {
                generation: Some(9),
                revision: "r".into(),
                semantic: true,
            }),
            r#"{"type":"write_file","value":{"generation":9,"revision":"r","semantic":true}}"#,
        ),
        (
            Response::WriteFile(WriteFileResponse {
                generation: None,
                revision: "r".into(),
                semantic: false,
            }),
            r#"{"type":"write_file","value":{"revision":"r","semantic":false}}"#,
        ),
        (
            Response::ReadFile(ReadFileResponse {
                content_base64: "Zm9v".into(),
                revision: "r".into(),
            }),
            r#"{"type":"read_file","value":{"content_base64":"Zm9v","revision":"r"}}"#,
        ),
    ];
    for (response, expected_value) in cases {
        let envelope = ResponseEnvelope::success("id", response);
        let encoded = serde_json::to_string(&envelope).expect("encode");
        let expected = format!(
            r#"{{"version":1,"id":"id","outcome":{{"status":"ok","value":{expected_value}}}}}"#
        );
        assert_eq!(encoded, expected, "wire spelling must match exactly");
        let decoded: ResponseEnvelope = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, envelope);
    }
}

/// I3, first shape: a misspelled `expected` key must be a typed error, not a
/// silent downgrade to an unconditional write. Checked at both nesting
/// levels the review named: a top-level mutation params struct, and
/// `patch_frontmatter`'s own params (one level deeper than `write_note`, but
/// still the outermost params object for that method).
#[test]
fn a_misspelled_precondition_key_is_a_typed_error_not_a_silent_downgrade() {
    let write_note_typo = r#"{"path":"a.md","content":"c","expect":{"revision":"blake3:abc"}}"#;
    let error = serde_json::from_str::<vault_protocol::WriteNoteParams>(write_note_typo)
        .expect_err("a misspelled `expected` key must not decode as an unconditional write");
    let message = error.to_string();
    assert!(
        message.contains("expect") || message.contains("unknown field"),
        "error should name the problem: {message}"
    );

    let patch_typo = r#"{"path":"a.md","patch":[],"expect":{"any":true}}"#;
    serde_json::from_str::<vault_protocol::PatchFrontmatterParams>(patch_typo)
        .expect_err("a misspelled `expected` key on patch_frontmatter must also be rejected");
}

/// I3, second shape (nested level): a misspelled key inside one patch entry
/// — not the precondition, the addressed edit itself — must also be
/// rejected, not silently dropped.
#[test]
fn a_misspelled_key_inside_one_patch_entry_is_a_typed_error() {
    let typo = r#"{"key_path":"a","vlaue":"set"}"#;
    serde_json::from_str::<vault_protocol::FrontmatterEditDto>(typo)
        .expect_err("an unrecognized field inside a patch entry must not be silently ignored");
}

/// I3, third shape: the brief's own doc text defines only an *explicit* JSON
/// `null` as the deletion spelling ("`value: null` deletes" —
/// `mutations.rs`'s `FrontmatterEditDto` doc comment). It never says an
/// absent `value` key means the same thing. Serde's default handling of
/// `Option<T>` fields would silently treat "forgot to set a value" the same
/// as "delete this key" — a real data-loss hazard — so omission is now a
/// typed decode error instead, and only an explicit `null` deletes.
#[test]
fn an_omitted_value_key_is_an_error_only_an_explicit_null_deletes() {
    let omitted = r#"{"key_path":"tags"}"#;
    let error = serde_json::from_str::<vault_protocol::FrontmatterEditDto>(omitted)
        .expect_err("an omitted `value` key must not silently mean deletion");
    assert!(
        error.to_string().contains("value"),
        "error should name the missing field: {error}"
    );

    let explicit_null: vault_protocol::FrontmatterEditDto =
        serde_json::from_str(r#"{"key_path":"tags","value":null}"#)
            .expect("an explicit null is still the deletion spelling");
    assert_eq!(explicit_null.value, None);
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

/// Task 1e (a): `key_path` also accepts an **array of literal segments**, so a
/// key whose own name carries a `.` can be addressed at all. The dot-string
/// form is unchanged and still splits on every `.`; the array form splits on
/// nothing.
#[test]
fn a_key_path_may_be_an_array_of_literal_segments() {
    let line = r#"{"version":1,"id":"p2","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":["my.key","sub"],"value":"set"}],"expected":{"any":true}}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode an array key path");
    match &envelope.request {
        Request::PatchFrontmatter(params) => {
            assert_eq!(
                params.patch[0].key_path,
                KeyPathDto::Segments(vec!["my.key".into(), "sub".into()]),
                "each element is one literal key, dots included"
            );
            assert_eq!(
                params.patch[0].key_path.segments(),
                vec!["my.key", "sub"],
                "the array form splits on nothing"
            );
        }
        other => panic!("expected patch_frontmatter, got {other:?}"),
    }
    assert_eq!(
        serde_json::to_string(&envelope).expect("re-encode"),
        line,
        "the array form round-trips as an array"
    );
}

/// What an array `key_path` is **not**. A segment is a string; anything else
/// is a typed decode error rather than a panic or a coerced value, and the
/// transport reports every one of them as `invalid_request` with the serde
/// text carried through. The empty array is pinned end to end in
/// `vault-server`'s `frontmatter_patch_wire.rs`, because it decodes fine and
/// is refused one layer later.
#[test]
fn an_array_key_path_takes_strings_and_nothing_else() {
    for spelling in [
        r#"{"key_path":["a",3],"value":"set"}"#,
        r#"{"key_path":["a",null],"value":"set"}"#,
        r#"{"key_path":[["a"]],"value":"set"}"#,
        r#"{"key_path":{"a":1},"value":"set"}"#,
        r#"{"key_path":7,"value":"set"}"#,
    ] {
        let error = serde_json::from_str::<vault_protocol::FrontmatterEditDto>(spelling)
            .expect_err("a key path is a string or an array of strings");
        assert!(
            error.to_string().contains("invalid type"),
            "error should name the type mismatch for {spelling}: {error}"
        );
    }
}

/// The dot-string form keeps its meaning exactly: every `.` starts a new
/// segment, which is why the array form had to exist.
#[test]
fn the_dot_string_key_path_still_splits_on_every_dot() {
    let dotted: vault_protocol::FrontmatterEditDto =
        serde_json::from_str(r#"{"key_path":"my.key","value":"set"}"#).expect("decode a dot path");
    assert_eq!(dotted.key_path, KeyPathDto::Dotted("my.key".into()));
    assert_eq!(dotted.key_path.segments(), vec!["my", "key"]);
}

/// Task 1e (b): `set_null: true` with **no** `value` key writes a YAML null
/// for the addressed key. It is the one action that is neither a set nor a
/// deletion, and `processFrontMatter` parity needs it: a plugin setting
/// `fm.key = null` must not delete the key.
#[test]
fn set_null_decodes_as_its_own_action_without_a_value_key() {
    let line = r#"{"version":1,"id":"p3","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"reviewed","set_null":true}],"expected":{"any":true}}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode set_null");
    match &envelope.request {
        Request::PatchFrontmatter(params) => {
            assert!(params.patch[0].set_null);
            assert_eq!(params.patch[0].value, None);
        }
        other => panic!("expected patch_frontmatter, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);
}

/// `set_null` and `value` say contradictory things about one key — write a
/// null, or set/delete it — so the pair is refused rather than silently
/// resolved. Both spellings of `value` are covered, the explicit `null`
/// (deletion) included; over the transport either is `invalid_request`.
#[test]
fn set_null_together_with_value_is_refused_rather_than_ordered() {
    for spelling in [
        r#"{"key_path":"a","value":"set","set_null":true}"#,
        r#"{"key_path":"a","value":null,"set_null":true}"#,
    ] {
        let error = serde_json::from_str::<vault_protocol::FrontmatterEditDto>(spelling)
            .expect_err("`set_null` with a `value` has no defined meaning");
        assert!(
            error.to_string().contains("set_null"),
            "error should name the conflict: {error}"
        );
    }
}

/// `set_null: false` says nothing, so an omitted `value` beside it is the
/// same decode error it was before (b) existed.
#[test]
fn an_omitted_value_beside_a_false_set_null_is_still_a_decode_error() {
    let spelling = r#"{"key_path":"a","set_null":false}"#;
    let error = serde_json::from_str::<vault_protocol::FrontmatterEditDto>(spelling)
        .expect_err("an omitted `value` must not silently mean deletion");
    assert!(
        error.to_string().contains("value"),
        "error should name the missing field: {error}"
    );
}
