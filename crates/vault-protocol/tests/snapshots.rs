//! Snapshot-session request and response shapes. These replace the v1
//! streaming design entirely: every call is ordinary request/response, so
//! there is no new framing here to test — only shapes and spellings.

use vault_protocol::{
    CloseSnapshotResponse, ErrorCode, ListItemDto, NoteFacetDto, NoteMetadataDto,
    OpenSnapshotResponse, Request, RequestEnvelope, Response, ResponseEnvelope, SectionDto,
    SnapshotNoteDto, SnapshotNotesResponse, SnapshotTreeResponse, SpanDto, TreeEntryDto,
    TreeEntryKindDto,
};

#[test]
fn open_snapshot_takes_no_parameters_and_reports_both_counts() {
    let line = r#"{"version":1,"id":"s1","request":{"method":"open_snapshot","params":{}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode open_snapshot");
    assert!(matches!(envelope.request, Request::OpenSnapshot(_)));
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);

    let response = ResponseEnvelope::success(
        "s1",
        Response::OpenSnapshot(OpenSnapshotResponse {
            snapshot_id: "snap-1".into(),
            generation: 9,
            note_count: 120,
            entry_count: 145,
        }),
    );
    let encoded = serde_json::to_string(&response).expect("encode");
    assert!(encoded.contains(r#""snapshot_id":"snap-1""#), "{encoded}");
    assert!(encoded.contains(r#""note_count":120"#), "{encoded}");
    assert!(encoded.contains(r#""entry_count":145"#), "{encoded}");
}

#[test]
fn a_tree_page_carries_folders_notes_and_plain_files_with_their_stat() {
    let page = SnapshotTreeResponse {
        snapshot_id: "snap-1".into(),
        generation: 9,
        entries: vec![
            TreeEntryDto {
                path: "Folder".into(),
                kind: TreeEntryKindDto::Folder,
                size: None,
                ctime_unix_ms: 1_700_000_000_000,
                mtime_unix_ms: 1_700_000_000_500,
                revision: None,
            },
            TreeEntryDto {
                path: "Folder/One.md".into(),
                kind: TreeEntryKindDto::Note,
                size: Some(7),
                ctime_unix_ms: 1_700_000_001_000,
                mtime_unix_ms: 1_700_000_002_000,
                revision: Some("blake3:abc".into()),
            },
            TreeEntryDto {
                path: "Folder/image.png".into(),
                kind: TreeEntryKindDto::File,
                size: Some(1024),
                ctime_unix_ms: 1_700_000_003_000,
                mtime_unix_ms: 1_700_000_003_000,
                revision: Some("blake3:def".into()),
            },
        ],
        next_cursor: Some("opaque".into()),
    };
    let encoded = serde_json::to_string(&page).expect("encode");
    assert!(encoded.contains(r#""kind":"folder""#), "{encoded}");
    assert!(encoded.contains(r#""kind":"note""#), "{encoded}");
    assert!(encoded.contains(r#""kind":"file""#), "{encoded}");
    assert!(
        encoded.contains(r#""ctime_unix_ms":1700000001000"#),
        "the host serves TFile.stat from these two fields: {encoded}"
    );
    assert!(
        encoded.contains(r#""mtime_unix_ms":1700000002000"#),
        "{encoded}"
    );
    let decoded: SnapshotTreeResponse = serde_json::from_str(&encoded).expect("round trip");
    assert_eq!(decoded.entries.len(), 3);
    assert_eq!(decoded.entries[0].size, None, "a folder has no size");
    assert_eq!(
        decoded.entries[0].ctime_unix_ms, 1_700_000_000_000,
        "a folder still has timestamps; only its size is absent"
    );
}

#[test]
fn a_notes_page_request_names_the_facets_it_wants() {
    let line = r#"{"version":1,"id":"s2","request":{"method":"snapshot_notes","params":{"snapshot_id":"snap-1","include":["metadata","references","sections","list_items"]}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode snapshot_notes");
    match &envelope.request {
        Request::SnapshotNotes(params) => {
            assert_eq!(params.snapshot_id, "snap-1");
            assert_eq!(
                params.include,
                vec![
                    NoteFacetDto::Metadata,
                    NoteFacetDto::References,
                    NoteFacetDto::Sections,
                    NoteFacetDto::ListItems,
                ]
            );
            assert_eq!(params.cursor, None);
            assert_eq!(params.limit, None);
        }
        other => panic!("expected snapshot_notes, got {other:?}"),
    }
}

#[test]
fn an_unrequested_facet_is_absent_rather_than_empty() {
    let note = SnapshotNoteDto {
        path: "One.md".into(),
        revision: "blake3:abc".into(),
        metadata: Some(NoteMetadataDto {
            properties: Vec::new(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            diagnostics: Vec::new(),
        }),
        references: None,
        resolutions: None,
        backlinks: None,
        sections: Some(vec![SectionDto {
            kind: "heading".into(),
            span: SpanDto { start: 0, end: 7 },
            block_id: None,
        }]),
        list_items: Some(vec![ListItemDto {
            span: SpanDto { start: 8, end: 16 },
            list_start_line: Some(1),
            parent_start_line: None,
            task: Some(" ".into()),
        }]),
    };
    let encoded = serde_json::to_string(&note).expect("encode");
    assert!(
        !encoded.contains("references"),
        "an unrequested facet must be absent, not an empty list: {encoded}"
    );
    assert!(
        encoded.contains(r#""sections":[{"kind":"heading""#),
        "{encoded}"
    );
    assert!(
        encoded.contains(r#""list_start_line":1"#) && !encoded.contains("parent_start_line"),
        "a top-level item names its list's start line and nothing else: {encoded}"
    );
    assert!(
        !encoded.contains("-1"),
        "the line-number model has no sentinel: {encoded}"
    );
}

#[test]
fn a_nested_list_item_names_its_parents_start_line_instead() {
    let nested = ListItemDto {
        span: SpanDto { start: 20, end: 30 },
        list_start_line: None,
        parent_start_line: Some(3),
        task: Some("x".into()),
    };
    let encoded = serde_json::to_string(&nested).expect("encode");
    assert_eq!(
        encoded,
        r#"{"span":{"start":20,"end":30},"parent_start_line":3,"task":"x"}"#
    );
    let decoded: ListItemDto = serde_json::from_str(&encoded).expect("round trip");
    assert_eq!(decoded.list_start_line, None);
    assert_eq!(decoded.parent_start_line, Some(3));
    assert_eq!(
        decoded.task.as_deref().map(str::len),
        Some(1),
        "task is one character on the wire, per the pre-task's pinned convention"
    );
}

#[test]
fn a_section_carries_its_block_id_when_it_has_one() {
    let section = SectionDto {
        kind: "paragraph".into(),
        span: SpanDto { start: 0, end: 12 },
        block_id: Some("anchor".into()),
    };
    assert_eq!(
        serde_json::to_string(&section).expect("encode"),
        r#"{"kind":"paragraph","span":{"start":0,"end":12},"block_id":"anchor"}"#
    );
}

#[test]
fn closing_a_snapshot_echoes_its_identifier() {
    let response = CloseSnapshotResponse {
        snapshot_id: "snap-1".into(),
    };
    assert_eq!(
        serde_json::to_string(&response).expect("encode"),
        r#"{"snapshot_id":"snap-1"}"#
    );
}

#[test]
fn the_snapshot_error_codes_have_their_documented_spellings() {
    assert_eq!(
        serde_json::to_string(&ErrorCode::SnapshotNotFound).expect("encode"),
        r#""snapshot_not_found""#
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::TooManySnapshots).expect("encode"),
        r#""too_many_snapshots""#
    );
    let decoded: ErrorCode =
        serde_json::from_str(r#""snapshot_not_found""#).expect("decode snapshot_not_found");
    assert_eq!(decoded, ErrorCode::SnapshotNotFound);
}

#[test]
fn an_empty_notes_page_still_reports_its_snapshot_and_generation() {
    let page = SnapshotNotesResponse {
        snapshot_id: "snap-1".into(),
        generation: 9,
        notes: Vec::new(),
        next_cursor: None,
    };
    assert_eq!(
        serde_json::to_string(&page).expect("encode"),
        r#"{"snapshot_id":"snap-1","generation":9,"notes":[],"next_cursor":null}"#
    );
}
