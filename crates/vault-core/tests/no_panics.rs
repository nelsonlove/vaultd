use proptest::prelude::*;
use vault_core::{SourceDocument, VaultPath, parse_note};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn arbitrary_utf8_never_panics(
        chars in proptest::collection::vec(any::<char>(), 0..=1024)
    ) {
        let text = chars.into_iter().collect::<String>();
        let source = SourceDocument::new(
            VaultPath::new("Fuzz.md").expect("valid path"),
            text,
        );
        let parsed = parse_note(source);
        prop_assert!(parsed.source.text().is_char_boundary(parsed.source.text().len()));
    }
}
