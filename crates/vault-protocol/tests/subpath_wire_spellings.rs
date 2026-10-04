use vault_protocol::SubpathDto;

#[test]
fn a_view_is_written_as_view_and_never_as_a_heading() {
    let text = serde_json::to_string(&SubpathDto::View("Table".into())).unwrap();
    assert_eq!(text, r#"{"kind":"view","value":"Table"}"#);
    assert_ne!(
        text,
        serde_json::to_string(&SubpathDto::Heading("Table".into())).unwrap(),
        "a view and a heading of one name are different on the wire"
    );
    assert_eq!(
        serde_json::from_str::<SubpathDto>(r#"{"kind":"heading","value":"Table"}"#).unwrap(),
        SubpathDto::Heading("Table".into()),
        "a heading is still read as a heading"
    );
}

#[test]
fn a_decoded_unknown_subpath_is_never_written_again() {
    let decoded: SubpathDto =
        serde_json::from_str(r#"{"kind":"shape","value":{"x":1}}"#).expect("tolerated");
    assert_eq!(decoded, SubpathDto::Unknown);
    assert!(
        serde_json::to_string(&decoded).is_err(),
        "an unknown subpath cannot be serialised"
    );
}
