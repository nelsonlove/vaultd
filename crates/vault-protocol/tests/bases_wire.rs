use serde_json::json;
use vault_protocol::{
    BaseStatusDto, BaseSummaryDto, CellDto, ErrorCode, EvaluateBaseParams, ListBasesParams,
    ObjectEntryDto, Request, RowDto, RowKindDto,
};

fn round_trip(cell: CellDto, wire: serde_json::Value) {
    assert_eq!(serde_json::to_value(&cell).unwrap(), wire, "{cell:?}");
    assert_eq!(serde_json::from_value::<CellDto>(wire).unwrap(), cell);
}

#[test]
fn every_cell_kind_has_its_wire_shape() {
    round_trip(CellDto::Null, json!({"kind": "null"}));
    round_trip(
        CellDto::String { value: "x".into() },
        json!({"kind": "string", "value": "x"}),
    );
    round_trip(
        CellDto::Number {
            value: serde_json::Number::from(60),
        },
        json!({"kind": "number", "value": 60}),
    );
    round_trip(
        CellDto::Number {
            value: serde_json::Number::from_f64(14.3).unwrap(),
        },
        json!({"kind": "number", "value": 14.3}),
    );
    round_trip(
        CellDto::Boolean { value: true },
        json!({"kind": "boolean", "value": true}),
    );
    round_trip(
        CellDto::Date {
            value: "2025-01-01".into(),
            has_time: false,
        },
        json!({"kind": "date", "value": "2025-01-01", "has_time": false}),
    );
    round_trip(
        CellDto::Duration {
            value: 86_400_000,
            months: 0,
        },
        json!({"kind": "duration", "value": 86_400_000, "months": 0}),
    );
    round_trip(
        CellDto::List {
            value: vec![CellDto::Null],
        },
        json!({"kind": "list", "value": [{"kind": "null"}]}),
    );
    round_trip(
        CellDto::Object {
            value: vec![
                ObjectEntryDto {
                    key: "b".into(),
                    value: CellDto::Null,
                },
                ObjectEntryDto {
                    key: "a".into(),
                    value: CellDto::Boolean { value: false },
                },
            ],
        },
        json!({"kind": "object", "value": [
            {"key": "b", "value": {"kind": "null"}},
            {"key": "a", "value": {"kind": "boolean", "value": false}}
        ]}),
    );
    round_trip(
        CellDto::Link {
            target: "Other".into(),
            display: None,
            resolved: Some("Other.md".into()),
        },
        json!({"kind": "link", "target": "Other", "display": null, "resolved": "Other.md"}),
    );
    round_trip(
        CellDto::File {
            path: "a/b.md".into(),
        },
        json!({"kind": "file", "path": "a/b.md"}),
    );
    round_trip(
        CellDto::Image { value: "i".into() },
        json!({"kind": "image", "value": "i"}),
    );
    round_trip(
        CellDto::Icon { value: "c".into() },
        json!({"kind": "icon", "value": "c"}),
    );
    round_trip(
        CellDto::Html {
            value: "<b>".into(),
        },
        json!({"kind": "html", "value": "<b>"}),
    );
    round_trip(
        CellDto::Error {
            message: "division by zero".into(),
        },
        json!({"kind": "error", "message": "division by zero"}),
    );
}

#[test]
fn an_unknown_kind_or_state_decodes_as_unknown() {
    assert_eq!(
        serde_json::from_value::<CellDto>(json!({"kind": "hologram", "value": 1})).unwrap(),
        CellDto::Unknown
    );
    assert_eq!(
        serde_json::from_value::<RowKindDto>(json!("folder")).unwrap(),
        RowKindDto::Unknown
    );
    assert_eq!(
        serde_json::from_value::<BaseStatusDto>(json!({"state": "pending"})).unwrap(),
        BaseStatusDto::Unknown
    );
    let row: RowDto =
        serde_json::from_value(json!({"path": "a.md", "kind": "note", "cells": []})).unwrap();
    assert_eq!(row.group, None, "an absent group is an ungrouped row");
    assert_eq!(
        serde_json::to_value(&row).unwrap(),
        json!({"path": "a.md", "kind": "note", "cells": []}),
        "an ungrouped row carries no group key"
    );
}

#[test]
fn the_four_base_error_codes_round_trip() {
    for (code, wire) in [
        (ErrorCode::BaseInvalid, "base_invalid"),
        (ErrorCode::ViewNotFound, "view_not_found"),
        (ErrorCode::ExpressionInvalid, "expression_invalid"),
        (ErrorCode::UnsupportedFunction, "unsupported_function"),
    ] {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<ErrorCode>(json!(wire)).unwrap(),
            code
        );
    }
}

#[test]
fn both_requests_decode_with_their_optional_fields_absent() {
    let request: Request = serde_json::from_value(
        json!({"method": "evaluate_base", "params": {"path": "Views.base"}}),
    )
    .unwrap();
    assert_eq!(
        request,
        Request::EvaluateBase(EvaluateBaseParams {
            path: "Views.base".into(),
            ..EvaluateBaseParams::default()
        })
    );
    let request: Request =
        serde_json::from_value(json!({"method": "list_bases", "params": {}})).unwrap();
    assert_eq!(request, Request::ListBases(ListBasesParams::default()));
    let summary = BaseSummaryDto {
        path: "B.base".into(),
        status: BaseStatusDto::ParseFailed {
            message: "bad".into(),
            span: None,
        },
        views: vec![],
    };
    assert_eq!(
        serde_json::to_value(&summary).unwrap(),
        json!({"path": "B.base", "status": {"state": "parse_failed", "message": "bad", "span": null}, "views": []})
    );
}
