use vault_protocol::{
    DocumentKindDto, ErrorCode, ProtocolError, Request, RequestEnvelope, Response,
    ResponseEnvelope, ResponseOutcome, SearchContextDto, SearchParams, SearchSortDto,
};

const REQUEST: &str = r#"{"version":1,"id":"q","request":{"method":"search","params":{"query":"meeting -work tag:#project","limit":1}}}"#;
const RESPONSE: &str = r#"{"version":1,"id":"q","outcome":{"status":"ok","value":{"type":"search","value":{"generation":12,"total_files":3,"total_matches":5,"items":[{"path":"Notes/Kickoff.md","kind":"note","path_matches":[],"content_matches":[{"span":{"start":21,"end":28},"start":{"line":2,"col":4,"offset":21},"end":{"line":2,"col":11,"offset":28},"line_text":"The meeting ran long.","line_text_start":17}],"matches_truncated":false}],"next_cursor":"eyJn"}}}}"#;

#[test]
fn the_request_decodes_with_its_defaults() {
    let envelope: RequestEnvelope = serde_json::from_str(REQUEST).unwrap();
    let Request::Search(params) = envelope.request else {
        panic!("a search request")
    };
    assert_eq!(
        params,
        SearchParams {
            query: "meeting -work tag:#project".into(),
            match_case: false,
            sort: SearchSortDto::FileNameAsc,
            context: SearchContextDto::Line,
            cursor: None,
            limit: Some(1),
        }
    );
}

#[test]
fn the_response_round_trips_byte_for_byte() {
    let envelope: ResponseEnvelope = serde_json::from_str(RESPONSE).unwrap();
    assert_eq!(serde_json::to_string(&envelope).unwrap(), RESPONSE);
    let ResponseOutcome::Ok(Response::Search(answer)) = envelope.outcome else {
        panic!("a search answer")
    };
    assert_eq!(answer.items[0].kind, DocumentKindDto::Note);
}

#[test]
fn an_unknown_document_kind_is_tolerated_and_an_unknown_sort_is_not() {
    let unknown = RESPONSE.replace(r#""kind":"note""#, r#""kind":"hologram""#);
    let envelope: ResponseEnvelope = serde_json::from_str(&unknown).unwrap();
    let ResponseOutcome::Ok(Response::Search(answer)) = envelope.outcome else {
        panic!("a search answer")
    };
    assert_eq!(answer.items[0].kind, DocumentKindDto::Unknown);
    let bad_sort = REQUEST.replace(r#""limit":1"#, r#""sort":"relevance""#);
    assert!(
        serde_json::from_str::<RequestEnvelope>(&bad_sort).is_err(),
        "a value from a closed set a client chose"
    );
}

#[test]
fn the_new_codes_and_position_serialize() {
    let error = ProtocolError {
        position: Some(3),
        ..ProtocolError::new(ErrorCode::QueryInvalid, "unmatched `)`")
    };
    let text = serde_json::to_string(&error).unwrap();
    assert_eq!(
        text,
        r#"{"code":"query_invalid","message":"unmatched `)`","position":3}"#
    );
    let unsupported = serde_json::to_string(&ProtocolError::new(
        ErrorCode::UnsupportedOperator,
        "`line:`",
    ))
    .unwrap();
    assert!(
        unsupported.contains(r#""code":"unsupported_operator""#)
            && !unsupported.contains("position")
    );
}

/// The round-trip rows `variant_anchors.rs` points at for the two codes.
#[test]
fn the_two_search_error_codes_round_trip() {
    for (code, wire) in [
        (ErrorCode::QueryInvalid, "query_invalid"),
        (ErrorCode::UnsupportedOperator, "unsupported_operator"),
    ] {
        assert_eq!(serde_json::to_value(code).unwrap(), serde_json::json!(wire));
        assert_eq!(
            serde_json::from_value::<ErrorCode>(serde_json::json!(wire)).unwrap(),
            code
        );
    }
}

/// The round-trip rows for every known `DocumentKindDto`.
#[test]
fn every_document_kind_round_trips() {
    for (kind, wire) in [
        (DocumentKindDto::Note, "note"),
        (DocumentKindDto::Canvas, "canvas"),
        (DocumentKindDto::File, "file"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), serde_json::json!(wire));
        assert_eq!(
            serde_json::from_value::<DocumentKindDto>(serde_json::json!(wire)).unwrap(),
            kind
        );
    }
}
