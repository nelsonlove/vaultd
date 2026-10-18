use std::ops::Range;

use proptest::prelude::*;
use vault_search::text::{LineIndex, Loc, Needle, fold_js, utf16_len};

const NONE: Vec<Range<usize>> = Vec::new();

#[test]
fn insensitive_match_finds_every_occurrence_case_folded() {
    assert_eq!(
        Needle::text("Meet", false).find_all("meeting MEET meet"),
        vec![0..4, 8..12, 13..17]
    );
}

#[test]
fn sensitive_match_is_exact() {
    assert_eq!(
        Needle::text("Meet", true).find_all("meeting MEET Meet"),
        vec![13..17]
    );
}

#[test]
fn matches_do_not_overlap() {
    assert_eq!(Needle::text("aa", false).find_all("aaaa"), vec![0..2, 2..4]);
}

#[test]
fn spans_point_into_the_original_after_a_length_changing_fold() {
    // "İ" (2 bytes) folds to "i" + U+0307, so "ist" does not match at the start.
    assert_eq!(
        Needle::text("ist", false).find_all("İstanbul ist"),
        vec![10..13]
    );
    // The Kelvin sign (3 bytes) folds to "k".
    assert_eq!(
        Needle::text("kelvin", false).find_all("\u{212A}elvin"),
        vec![0..8]
    );
    assert_eq!(Needle::text("kelvin", true).find_all("\u{212A}elvin"), NONE);
    // A Kelvin needle folds to "k", so it matches an ASCII haystack through
    // the fast path.
    assert_eq!(
        Needle::text("\u{212A}", false).find_all("Ok k"),
        vec![1..2, 3..4]
    );
}

#[test]
fn a_match_inside_one_characters_fold_is_widened_to_the_character() {
    assert_eq!(Needle::text("i", false).find_all("İ"), vec![0..2]);
}

#[test]
fn diacritics_and_normalization_are_not_folded() {
    // P4: provisional until captured.
    assert_eq!(Needle::text("cafe", false).find_all("café"), NONE);
    assert_eq!(
        Needle::text("caf\u{e9}", false).find_all("cafe\u{301}"),
        NONE
    );
}

#[test]
fn final_sigma_folds_as_javascript_does() {
    // "οδος" ending in the final sigma U+03C2, written with escapes so no
    // editor can swap it for U+03C3.
    let final_form = "\u{3bf}\u{3b4}\u{3bf}\u{3c2}";
    assert_eq!(fold_js("\u{39f}\u{394}\u{39f}\u{3a3}"), final_form);
    assert_eq!(
        fold_js("\u{39f}\u{394}\u{39f}\u{3a3} \u{39f}\u{394}\u{39f}\u{3a3}."),
        format!("{final_form} {final_form}.")
    );
    assert_eq!(
        fold_js("\u{3a3}\u{391}"),
        "\u{3c3}\u{3b1}",
        "a sigma before a letter is the medial form"
    );
    // The Unicode Final_Sigma context JavaScript applies: a cased letter
    // before (case-ignorable characters skipped), no cased letter after.
    // Expected values checked with `node -e` on each input.
    assert_eq!(
        fold_js("\u{4e2d}\u{3a3}"),
        "\u{4e2d}\u{3c3}",
        "中 is alphabetic but not cased"
    );
    assert_eq!(
        fold_js("\u{391}\u{3a3}\u{4e2d}"),
        "\u{3b1}\u{3c2}\u{4e2d}",
        "中 after the sigma is not cased"
    );
    assert_eq!(
        fold_js("\u{391}'\u{3a3}"),
        "\u{3b1}'\u{3c2}",
        "the apostrophe is case-ignorable"
    );
    assert_eq!(
        fold_js("\u{391}\u{3a3}\u{301}\u{392}"),
        "\u{3b1}\u{3c3}\u{301}\u{3b2}",
        "a combining mark is skipped before the next letter"
    );
    // The byte map stays on the original characters around a final sigma.
    assert_eq!(
        Needle::text("\u{3b1}\u{3c2}", false).find_all("\u{391}\u{3a3}\u{4e2d}"),
        vec![0..4]
    );
}

#[test]
fn loc_counts_utf16_units_per_line() {
    let text = "a😀b\nxé y";
    let index = LineIndex::new(text);
    assert_eq!(
        index.loc(5),
        Loc {
            line: 0,
            col: 3,
            offset: 3
        }
    );
    assert_eq!(
        index.loc(11),
        Loc {
            line: 1,
            col: 3,
            offset: 8
        }
    );
    assert_eq!(index.line_range(11), 7..12);
    assert_eq!(
        index.loc(text.len()),
        Loc {
            line: 1,
            col: 4,
            offset: 9
        }
    );
    assert_eq!(utf16_len("😀é"), 3);
}

#[test]
fn a_crlf_line_break_ends_the_line_before_the_carriage_return() {
    let index = LineIndex::new("ab\r\ncd");
    assert_eq!(index.line_range(0), 0..2);
    assert_eq!(
        index.loc(4),
        Loc {
            line: 1,
            col: 0,
            offset: 4
        }
    );
}

#[test]
fn an_empty_needle_matches_nothing() {
    // P19: an empty phrase `""` parses; the matcher answers no spans for it,
    // never a span at every position.
    assert_eq!(Needle::text("", false).find_all("abc"), NONE);
    assert_eq!(Needle::text("", true).find_all("abc"), NONE);
    assert!(!Needle::text("", false).is_match(""));
}

proptest! {
    #[test]
    fn fast_path_equals_reference(haystack in "[ -~\n]{0,200}", needle in "[ -~\u{212A}İ]{1,4}") {
        // The fast path exists only for an insensitive needle over an ASCII
        // haystack. A sensitive needle runs the same `match_indices` in both
        // finders, so drawing one here would compare a function with itself.
        let needle = Needle::text(&needle, false);
        prop_assert_eq!(needle.find_all(&haystack), needle.find_all_reference(&haystack));
    }

    /// `is_match` decides without collecting spans; it must answer exactly
    /// whether `find_all` finds any, for both toggles, over ASCII and over
    /// text whose fold changes length.
    #[test]
    fn is_match_equals_find_all_is_not_empty(
        haystack in "[ -~\nİıK\u{212A}ßé😀σΣ]{0,120}",
        needle in "[a-zA-Z0-9 İıK\u{212A}ßσΣ]{0,4}",
        sensitive in any::<bool>(),
    ) {
        let needle = Needle::text(&needle, sensitive);
        prop_assert_eq!(needle.is_match(&haystack), !needle.find_all(&haystack).is_empty());
    }

    #[test]
    fn is_match_equals_find_all_is_not_empty_over_ascii(
        haystack in "[ -~\n]{0,200}",
        needle in "[ -~\u{212A}İ]{0,4}",
        sensitive in any::<bool>(),
    ) {
        let needle = Needle::text(&needle, sensitive);
        prop_assert_eq!(needle.is_match(&haystack), !needle.find_all(&haystack).is_empty());
    }

    #[test]
    fn spans_are_char_boundaries_of_the_original_and_fold_to_the_needle(
        haystack in "[a-zA-Z İıK\u{212A}ßẞé\u{301}😀σΟ]{1,40}",
        from in 0usize..40,
        len in 1usize..6,
    ) {
        let chars: Vec<char> = haystack.chars().collect();
        let from = from % chars.len();
        let needle: String = chars[from..(from + len).min(chars.len())].iter().collect();
        let spans = Needle::text(&needle, false).find_all(&haystack);
        prop_assert!(!spans.is_empty(), "the leftmost occurrence is always found");
        for pair in spans.windows(2) {
            prop_assert!(pair[0].end <= pair[1].start, "spans sorted and disjoint: {:?}", spans);
        }
        let folded_needle = fold_js(&needle);
        for span in spans {
            prop_assert!(haystack.is_char_boundary(span.start) && haystack.is_char_boundary(span.end));
            prop_assert!(fold_js(&haystack[span.clone()]).contains(&folded_needle), "{:?} in {:?}", span, haystack);
        }
    }
}
