use vault_protocol::{ResolutionDto, SubpathDto};

#[test]
fn a_view_subpath_has_its_own_kind() {
    let resolution = ResolutionDto::Resolved {
        target: "Views.base".into(),
        subpath: Some(SubpathDto::View("Table".into())),
    };
    let text = serde_json::to_string(&resolution).unwrap();
    assert_eq!(
        text,
        r#"{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}"#
    );
    assert_eq!(
        serde_json::from_str::<ResolutionDto>(&text).unwrap(),
        resolution
    );
}

#[test]
fn the_existing_kinds_read_back_byte_for_byte() {
    for (dto, text) in [
        (
            SubpathDto::Heading("H".into()),
            r#"{"kind":"heading","value":"H"}"#,
        ),
        (
            SubpathDto::Block("b".into()),
            r#"{"kind":"block","value":"b"}"#,
        ),
    ] {
        assert_eq!(serde_json::to_string(&dto).unwrap(), text);
        assert_eq!(serde_json::from_str::<SubpathDto>(text).unwrap(), dto);
    }
}

#[test]
fn an_unknown_subpath_kind_is_tolerated_not_fatal() {
    let text = r#"{"kind":"missing_subpath","target":"X.base","subpath":{"kind":"shape","value":{"x":1}}}"#;
    let resolution: ResolutionDto = serde_json::from_str(text).expect("the line decodes");
    assert_eq!(
        resolution,
        ResolutionDto::MissingSubpath {
            target: "X.base".into(),
            subpath: SubpathDto::Unknown
        }
    );
}

#[test]
fn a_known_kind_with_a_missing_value_still_fails() {
    assert!(serde_json::from_str::<SubpathDto>(r#"{"kind":"view"}"#).is_err());
}
