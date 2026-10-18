use vault_search::text::Loc;
use vault_search::{
    CompileError, ContentMatch, FileHit, MAX_MATCHES_PER_FILE, MemoryDocument, Needs, compile,
    evaluate, parse_query,
};

fn hits_case(query: &str, match_case: bool, docs: &[MemoryDocument]) -> Vec<FileHit> {
    let compiled = compile(&parse_query(query).unwrap(), match_case)
        .unwrap_or_else(|e| panic!("{query:?}: {e:?}"));
    docs.iter()
        .filter_map(|doc| evaluate(&compiled, doc))
        .collect()
}
fn hits(query: &str, docs: &[MemoryDocument]) -> Vec<FileHit> {
    hits_case(query, false, docs)
}
fn paths(query: &str, docs: &[MemoryDocument]) -> Vec<String> {
    hits(query, docs)
        .into_iter()
        .map(|hit| hit.path.as_str().to_string())
        .collect()
}
fn spans(hit: &FileHit) -> Vec<std::ops::Range<usize>> {
    hit.content_matches.iter().map(|m| m.span.clone()).collect()
}

fn meetings() -> Vec<MemoryDocument> {
    vec![
        MemoryDocument::note("a.md", "meeting at work"),
        MemoryDocument::note("b.md", "meeting"),
        MemoryDocument::note("c.md", "homework"),
        MemoryDocument::note("d.md", "meetup personal"),
        MemoryDocument::note("e.md", "meeting work meetup"),
    ]
}

#[test]
fn plain_words_and_together_by_substring() {
    assert_eq!(paths("meeting work", &meetings()), ["a.md", "e.md"]);
    assert_eq!(
        paths("work", &meetings()),
        ["a.md", "c.md", "e.md"],
        "P1: substring"
    );
}

#[test]
fn or_grouping_and_negation_follow_the_help_page() {
    assert_eq!(
        paths("meeting work OR meetup personal", &meetings()),
        ["a.md", "d.md", "e.md"]
    );
    assert_eq!(paths("meeting -work", &meetings()), ["b.md"]);
    assert_eq!(
        paths("meeting -(work meetup)", &meetings()),
        ["a.md", "b.md"],
        "not both"
    );
}

#[test]
fn a_plain_term_matches_a_notes_path_and_content_does_not() {
    let docs = [MemoryDocument::note("Projects/Alpha.md", "x")];
    let found = hits("alpha", &docs);
    assert_eq!(found.len(), 1, "P2: the path of a note is searched");
    assert_eq!(found[0].path_matches, vec![9..14]);
    assert!(found[0].content_matches.is_empty());
    assert!(hits("content:alpha", &docs).is_empty());
}

#[test]
fn file_matches_the_name_with_its_extension_and_path_the_whole_path() {
    let docs = [
        MemoryDocument::note("img/notes.md", ""),
        MemoryDocument::file("img/cat.png"),
        MemoryDocument::file("img/dog.png"),
    ];
    assert_eq!(paths("file:.png", &docs), ["img/cat.png", "img/dog.png"]);
    assert_eq!(
        hits("file:.png", &docs)[0].path_matches,
        vec![7..11],
        "UTF-16 offsets into the path"
    );
    assert!(
        paths("file:img", &docs).is_empty(),
        "the folder is not the name"
    );
    assert_eq!(
        paths("path:img", &docs),
        ["img/notes.md", "img/cat.png", "img/dog.png"]
    );
}

#[test]
fn a_negated_query_reaches_attachments_only_through_a_positive_file_or_path_term() {
    let docs = [
        MemoryDocument::note("img/notes.md", "cat"),
        MemoryDocument::file("img/cat.png"),
        MemoryDocument::file("img/dog.png"),
    ];
    assert_eq!(paths("-foo", &docs), ["img/notes.md"], "P10");
    assert_eq!(paths("-file:.png", &docs), ["img/notes.md"]);
    assert_eq!(paths("file:.png -file:cat", &docs), ["img/dog.png"]);
    assert_eq!(
        paths("-(-path:img)", &docs),
        ["img/notes.md", "img/cat.png", "img/dog.png"],
        "an even depth is positive"
    );
    assert_eq!(
        paths("cat", &docs),
        ["img/notes.md"],
        "a default-scope term never matches an attachment"
    );
}

#[test]
fn tag_matches_itself_and_its_descendants_but_not_a_suffix() {
    let docs = [
        MemoryDocument::note("t1.md", "#work").with_tag("work", 0..5),
        MemoryDocument::note("t2.md", "#work/meeting").with_tag("work/meeting", 0..13),
        MemoryDocument::note("t3.md", "#myjob/work").with_tag("myjob/work", 0..11),
        MemoryDocument::note("t4.md", "#Work").with_tag("Work", 0..5),
    ];
    for query in ["tag:#work", "tag:work", "tag:WORK"] {
        assert_eq!(paths(query, &docs), ["t1.md", "t2.md", "t4.md"], "{query}");
    }
    assert_eq!(paths("tag:#work/meeting", &docs), ["t2.md"]);
    assert_eq!(
        spans(&hits("tag:work", &docs)[0]),
        vec![0..5],
        "a tag's span is the tag"
    );
}

/// `tag:` matches the tag's stored fold (the index's `comparison_key`), not
/// a fold computed per term: a fact whose `folded` names another tag is
/// matched by that one.
#[test]
fn tag_matches_read_the_stored_fold() {
    let mut doc = MemoryDocument::note("t.md", "#Work").with_tag("Work", 0..5);
    assert_eq!(doc.tags[0].folded, "work", "with_tag folds as fold_js does");
    doc.tags[0].folded = "elsewhere".into();
    let docs = [doc];
    assert!(paths("tag:work", &docs).is_empty());
    assert_eq!(paths("tag:elsewhere", &docs), ["t.md"]);
}

#[test]
fn the_case_toggle_and_the_case_operators() {
    let docs = [MemoryDocument::note("h.md", "HappyCat happycat")];
    assert_eq!(spans(&hits_case("happycat", true, &docs)[0]), vec![9..17]);
    assert_eq!(
        spans(&hits_case("ignore-case:HAPPYCAT", true, &docs)[0]),
        vec![0..8, 9..17]
    );
    assert_eq!(
        spans(&hits_case("match-case:HappyCat", false, &docs)[0]),
        vec![0..8]
    );
    assert_eq!(
        spans(&hits_case("HAPPYCAT", false, &docs)[0]),
        vec![0..8, 9..17]
    );
}

#[test]
fn spans_come_only_from_terms_outside_a_negation() {
    let docs = [MemoryDocument::note("m.md", "meeting notes")];
    assert_eq!(spans(&hits("meeting -work", &docs)[0]), vec![0..7]);
    assert_eq!(spans(&hits("meeting OR zzz", &docs)[0]), vec![0..7]);
    assert_eq!(spans(&hits("notes -(meeting zzz)", &docs)[0]), vec![8..13]);
}

#[test]
fn spans_come_only_from_branches_that_hold() {
    let docs = [MemoryDocument::note("o.md", "a c")];
    assert_eq!(
        spans(&hits("(a b) OR c", &docs)[0]),
        vec![2..3],
        "the branch `a b` fails, so its `a` adds no span"
    );
}

#[test]
fn a_content_match_carries_utf16_locs() {
    let found = hits(
        "meeting",
        &[MemoryDocument::note("l.md", "one\ntwo meeting")],
    );
    assert_eq!(
        found[0].content_matches,
        vec![ContentMatch {
            span: 8..15,
            start: Loc {
                line: 1,
                col: 4,
                offset: 8
            },
            end: Loc {
                line: 1,
                col: 11,
                offset: 15
            },
        }]
    );
}

#[test]
fn content_matches_are_capped_and_the_true_count_is_kept() {
    let found = hits("a", &[MemoryDocument::note("x.md", &"a ".repeat(150))]);
    assert_eq!(found[0].content_matches.len(), MAX_MATCHES_PER_FILE);
    assert!(found[0].matches_truncated);
    assert_eq!(found[0].total_matches, 150);
}

#[test]
fn an_empty_query_matches_nothing() {
    let compiled = compile(&parse_query("   ").unwrap(), false).unwrap();
    assert!(compiled.is_empty());
    assert!(
        meetings()
            .iter()
            .all(|doc| evaluate(&compiled, doc).is_none())
    );
}

#[test]
fn every_parity_operator_is_refused_by_name_in_the_mvp() {
    for (query, what, position) in [
        ("line:(a)", "line:", 0),
        ("block:(a)", "block:", 0),
        ("section:(a)", "section:", 0),
        ("x task:a", "task:", 2),
        ("task-todo:a", "task-todo:", 0),
        ("task-done:a", "task-done:", 0),
        ("a [prop]", "property search", 2),
        ("/re/", "regular expression", 0),
        ("path:/re/", "regular expression", 5),
    ] {
        match compile(&parse_query(query).unwrap(), false) {
            Err(CompileError::Unsupported {
                what: got,
                position: at,
            }) => {
                assert!(got.contains(what), "{query}: {got}");
                assert_eq!(at, position, "{query}");
            }
            other => panic!("{query}: expected Unsupported, got {other:?}"),
        }
    }
}

#[test]
fn needs_and_the_file_universe_are_computed_from_the_tree() {
    let needs = |q: &str| compile(&parse_query(q).unwrap(), false).unwrap().needs();
    assert_eq!(
        needs("file:x"),
        Needs {
            text: false,
            tags: false
        }
    );
    // A tag match is a content match: its Locs need the text.
    assert_eq!(
        needs("tag:x"),
        Needs {
            text: true,
            tags: true
        }
    );
    assert_eq!(
        needs("-tag:x"),
        Needs {
            text: false,
            tags: true
        },
        "a negated term adds no span"
    );
    assert_eq!(
        needs("x"),
        Needs {
            text: true,
            tags: false
        }
    );
    assert_eq!(
        needs("x -tag:y"),
        Needs {
            text: true,
            tags: true
        }
    );
    let reaches = |q: &str| {
        compile(&parse_query(q).unwrap(), false)
            .unwrap()
            .reaches_files()
    };
    assert!(reaches("file:x"));
    assert!(!reaches("-file:x"));
    assert!(reaches("-(-path:x)"));
    assert!(!reaches("x"));
}

#[test]
fn the_prefilter_rejects_only_on_metadata_and_never_reads_text() {
    let compiled = compile(&parse_query("meeting tag:work file:.md").unwrap(), false).unwrap();
    let tagged = MemoryDocument {
        text: None,
        ..MemoryDocument::note("a.md", "").with_tag("work", 0..5)
    };
    let untagged = MemoryDocument {
        text: None,
        ..MemoryDocument::note("b.md", "")
    };
    assert!(
        compiled.prefilter(&tagged),
        "the text conjunct is skipped, not failed"
    );
    assert!(!compiled.prefilter(&untagged));
    assert!(
        !compiled.prefilter(&MemoryDocument::file("c.png")),
        "no tag"
    );
    let notes_only = compile(&parse_query("meeting").unwrap(), false).unwrap();
    assert!(
        !notes_only.prefilter(&MemoryDocument::file("c.png")),
        "the file universe"
    );
}

#[test]
fn an_attachment_is_a_candidate_only_when_a_positive_file_or_path_term_holds_for_it() {
    let docs = [
        MemoryDocument::note("n.md", "bar"),
        MemoryDocument::file("img/x.png"),
        MemoryDocument::file("img/y.png"),
    ];
    // P10: `-foo` holds for every attachment, but only `x.png` is named by
    // the positive `file:` term.
    assert_eq!(paths("file:x OR -foo", &docs), ["n.md", "img/x.png"]);
    let compiled = compile(&parse_query("file:x OR -foo").unwrap(), false).unwrap();
    assert!(!compiled.prefilter(&MemoryDocument::file("img/y.png")));
    assert!(compiled.prefilter(&MemoryDocument::file("img/x.png")));
}

#[test]
fn a_double_negation_is_positive_for_spans_as_for_needs() {
    let docs = [MemoryDocument::note("img/notes.md", "cat")];
    assert_eq!(hits("-(-path:img)", &docs)[0].path_matches, vec![0..3]);
    let tagged = [MemoryDocument::note("t.md", "#work").with_tag("work", 0..5)];
    assert_eq!(spans(&hits("-(-tag:work)", &tagged)[0]), vec![0..5]);
}

#[test]
fn the_prefilter_rejects_everything_for_an_empty_query() {
    let compiled = compile(&parse_query("").unwrap(), false).unwrap();
    assert!(!compiled.prefilter(&MemoryDocument::note("a.md", "x")));
}

#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "needs")]
fn a_source_that_omits_the_text_a_query_needs_is_caught_in_debug() {
    let compiled = compile(&parse_query("x").unwrap(), false).unwrap();
    let doc = MemoryDocument {
        text: None,
        ..MemoryDocument::note("a.md", "")
    };
    let _ = evaluate(&compiled, &doc);
}

#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "tag span")]
fn a_tag_span_outside_the_text_is_caught_in_debug() {
    let compiled = compile(&parse_query("x").unwrap(), false).unwrap();
    let doc = MemoryDocument::note("a.md", "x").with_tag("work", 0..9);
    let _ = evaluate(&compiled, &doc);
}

fn required_tag(query: &str) -> Option<String> {
    compile(&parse_query(query).unwrap(), false)
        .unwrap()
        .required_tag_key()
        .map(str::to_owned)
}

#[test]
fn a_required_tag_key_is_a_positive_top_level_tag_conjunct() {
    assert_eq!(required_tag("tag:#Work").as_deref(), Some("work"));
    assert_eq!(
        required_tag("tag:work/Meeting").as_deref(),
        Some("work/meeting")
    );
    assert_eq!(required_tag("meeting tag:#work").as_deref(), Some("work"));
    assert_eq!(
        required_tag("match-case:(tag:Work)").as_deref(),
        Some("work")
    );
    assert_eq!(
        required_tag("tag:a tag:b").as_deref(),
        Some("a"),
        "the first"
    );
}

#[test]
fn no_required_tag_key_under_or_or_not_or_for_an_empty_key() {
    assert_eq!(required_tag("tag:work OR meeting"), None);
    assert_eq!(required_tag("(tag:work OR tag:home) meeting"), None);
    assert_eq!(required_tag("-tag:work"), None);
    assert_eq!(required_tag("-(-tag:work)"), None);
    assert_eq!(required_tag("meeting"), None);
    assert_eq!(required_tag("tag:#"), None, "an empty key matches nothing");
    assert_eq!(required_tag(""), None);
}

/// The contract the index relies on: whenever the query holds for a
/// document, one of its tags is the key or a descendant of it.
#[test]
fn every_hit_of_a_query_with_a_required_tag_holds_that_tag() {
    let docs = [
        MemoryDocument::note("a.md", "#work").with_tag("work", 0..5),
        MemoryDocument::note("b.md", "#work/meeting").with_tag("work/meeting", 0..13),
        MemoryDocument::note("c.md", "#workshop").with_tag("workshop", 0..9),
        MemoryDocument::note("d.md", "#myjob/work").with_tag("myjob/work", 0..11),
        MemoryDocument::note("e.md", "#WORK").with_tag("WORK", 0..5),
    ];
    for query in ["tag:work", "x tag:#Work", "tag:WORK -tag:work/meeting"] {
        let compiled = compile(&parse_query(query).unwrap(), false).unwrap();
        let key = compiled.required_tag_key().expect(query);
        let descendant = format!("{key}/");
        for doc in &docs {
            if evaluate(&compiled, doc).is_some() {
                assert!(
                    doc.tags
                        .iter()
                        .any(|tag| tag.folded == key || tag.folded.starts_with(&descendant)),
                    "{query}: {}",
                    doc.path.as_str()
                );
            }
        }
    }
}
