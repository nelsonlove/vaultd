mod common;

use std::fs;
use std::thread;

use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexService, MatchContext, SearchQuery};
use vault_search::{DocumentKind, SortOrder, compile, parse_query};

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn service(files: &[(&str, &[u8])]) -> (IndexService, TempDir, TempDir) {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (path, body) in files {
        let full = vault.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    (service, vault, index)
}

fn found(service: &IndexService, query: &str) -> Vec<(String, DocumentKind)> {
    let compiled = compile(&parse_query(query).unwrap(), false).unwrap();
    let answer = service
        .reader()
        .unwrap()
        .search(&SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        })
        .unwrap();
    answer
        .hits
        .into_iter()
        .map(|h| (h.path.as_str().to_string(), h.kind))
        .collect()
}

const KICKOFF: &[u8] = b"The meeting ran long.\n#project\n";

#[test]
fn search_answers_notes_and_attachments_at_the_published_generation() {
    let (service, _vault, _index) = service(&[
        ("Notes/Kickoff.md", KICKOFF),
        ("Notes/Other.md", b"work\n"),
        ("img/cat.png", b"\x89PNG"),
    ]);
    assert_eq!(
        found(&service, "meeting"),
        [("Notes/Kickoff.md".to_string(), DocumentKind::Note)]
    );
    assert_eq!(
        found(&service, "file:.png"),
        [("img/cat.png".to_string(), DocumentKind::File)]
    );
    let compiled = compile(&parse_query("meeting").unwrap(), false).unwrap();
    let reader = service.reader().unwrap();
    let answer = reader
        .search(&SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        })
        .unwrap();
    assert_eq!(
        Some(answer.generation),
        reader.published_status().unwrap().generation
    );
    assert_eq!(answer.hits[0].content_matches[0].span, 4..11);
}

#[test]
fn body_and_frontmatter_tags_come_from_the_index() {
    let (service, _vault, _index) = service(&[("t.md", b"---\ntags: [alpha]\n---\n#beta\n")]);
    assert_eq!(found(&service, "tag:alpha").len(), 1);
    assert_eq!(found(&service, "tag:#beta").len(), 1);
    assert!(
        found(&service, "tag:alp").is_empty(),
        "a tag is matched whole, not by substring"
    );
}

#[test]
fn a_damaged_tag_span_is_a_storage_error_not_a_panic() {
    // "é " is three bytes, so the tag `#tag` sits at 3..7 and byte 1 is inside
    // the character.
    let (service, _vault, index) = service(&[("t.md", "é #tag\n".as_bytes())]);
    let compiled = compile(&parse_query("tag:#tag").unwrap(), false).unwrap();
    let request = SearchQuery {
        compiled: &compiled,
        sort: SortOrder::FileNameAsc,
    };
    let clean = service.reader().unwrap().search(&request).unwrap();
    assert_eq!(clean.hits.len(), 1);
    for (start, end) in [(1, 7), (3, 99), (7, 3)] {
        let connection = rusqlite::Connection::open(index.path().join("index.sqlite3")).unwrap();
        connection
            .execute(
                "UPDATE tags SET span_start = ?1, span_end = ?2 WHERE note_path = 't.md'",
                [start, end],
            )
            .unwrap();
        drop(connection);
        let error = service.reader().unwrap().search(&request).unwrap_err();
        assert!(
            matches!(&error, IndexError::Storage(message) if message.contains("tag span")),
            "span {start}..{end} gave {error:?}"
        );
    }
}

#[test]
fn a_tag_only_query_reports_located_spans_and_reads_only_tagged_bodies() {
    let (service, _vault, _index) = service(&[
        ("Notes/Kickoff.md", KICKOFF),
        ("Notes/Other.md", b"meeting\n"),
    ]);
    let compiled = compile(&parse_query("tag:#project").unwrap(), false).unwrap();
    let answer = service
        .reader()
        .unwrap()
        .search(&SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        })
        .unwrap();
    let first = &answer.hits[0].content_matches[0];
    // "The meeting ran long.\n" is 22 bytes; a body tag's span includes its `#`.
    assert_eq!(first.span, 22..30);
    assert_eq!((first.start.line, first.start.col), (1, 0));
    assert_eq!(answer.texts_read, 1, "the untagged note's body is not read");
}

#[test]
fn a_note_with_no_stored_body_searches_as_empty_text() {
    // An `.md` file that is not UTF-8 is diagnosed and its body is not stored.
    let (service, _vault, _index) =
        service(&[("bad.md", b"meeting \xff\n"), ("good.md", b"meeting\n")]);
    let paths: Vec<String> = found(&service, "meeting")
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    assert_eq!(paths, ["good.md"]);
    assert_eq!(
        found(&service, "file:bad").len(),
        1,
        "it is still found by its name"
    );
}

#[test]
fn a_note_with_no_stored_body_searches_as_empty_text_on_the_per_note_path() {
    // One kept note of five takes the per-note body path (fewer than a
    // quarter of the notes), and the kept note has no stored body.
    let (service, _vault, _index) = service(&[
        ("bad.md", b"meeting \xff\n"),
        ("a.md", b"meeting\n"),
        ("b.md", b"meeting\n"),
        ("c.md", b"other\n"),
        ("d.md", b"other\n"),
    ]);
    let compiled = compile(&parse_query("file:bad -meeting").unwrap(), false).unwrap();
    let answer = service
        .reader()
        .unwrap()
        .search(&SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        })
        .unwrap();
    let paths: Vec<&str> = answer.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, ["bad.md"], "it searches as the empty text");
    assert_eq!(answer.texts_read, 0, "no body is stored for it to read");
}

#[test]
fn only_candidate_bodies_are_read() {
    let (service, _vault, _index) = service(&[
        ("Notes/Kickoff.md", KICKOFF),
        ("Notes/Other.md", b"meeting\n"),
        ("Notes/Third.md", b"meeting\n"),
    ]);
    let reader = service.reader().unwrap();
    let read = |q: &str| {
        let compiled = compile(&parse_query(q).unwrap(), false).unwrap();
        reader
            .search(&SearchQuery {
                compiled: &compiled,
                sort: SortOrder::FileNameAsc,
            })
            .unwrap()
            .texts_read
    };
    assert_eq!(read("file:Kickoff meeting"), 1);
    assert_eq!(read("meeting"), 3);
    assert_eq!(read("file:Kickoff"), 0, "no text is needed");
}

/// A required `tag:` term reads only the tag rows of the notes that hold
/// the tag or a descendant (all of each such note's rows), case-folded; a
/// tag under OR or NOT reads every row. The answer never changes.
#[test]
fn a_required_tag_narrows_the_tag_rows_read() {
    let (service, _vault, _index) = service(&[
        ("a.md", b"#work\n#other\n"),
        ("b.md", b"#Work/Meeting\n"),
        ("c.md", b"#workshop\n"),
        ("d.md", b"#myjob/work\n"),
        ("e.md", b"#home\n"),
        ("f.md", b"meeting\n"),
    ]);
    let reader = service.reader().unwrap();
    let run = |q: &str| {
        let compiled = compile(&parse_query(q).unwrap(), false).unwrap();
        let request = SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        };
        let narrowed = reader.search(&request).unwrap();
        let full = reader.search_unnarrowed_for_test(&request).unwrap();
        assert_eq!(narrowed.hits, full.hits, "{q}");
        let paths: Vec<String> = narrowed
            .hits
            .iter()
            .map(|h| h.path.as_str().to_string())
            .collect();
        (paths, narrowed.tag_rows_read)
    };
    assert_eq!(run("tag:#WORK"), (vec!["a.md".into(), "b.md".into()], 3));
    assert_eq!(run("tag:work/meeting"), (vec!["b.md".into()], 1));
    assert_eq!(run("tag:work tag:other"), (vec!["a.md".into()], 3));
    assert_eq!(run("tag:work -tag:other"), (vec!["b.md".into()], 3));
    assert_eq!(run("tag:work meeting"), (vec!["b.md".into()], 3));
    assert_eq!(run("tag:nothing"), (vec![], 0));
    assert_eq!(
        run("tag:work OR tag:home"),
        (vec!["a.md".into(), "b.md".into(), "e.md".into()], 6),
        "a tag under OR is not narrowed"
    );
    assert_eq!(
        run("-tag:work meeting"),
        (vec!["f.md".into()], 6),
        "a negated tag is not narrowed"
    );
    assert_eq!(
        run("meeting"),
        (vec!["b.md".into(), "f.md".into()], 0),
        "no tags needed"
    );
}

/// The narrowing's range bounds and the stored fold hold for keys that are
/// not ASCII: `Ü` and `Ï` fold to two-byte letters, and `İ` folds to `i`
/// plus a combining dot (U+0307), so its stored key is longer than the
/// letter and is not the key `i`.
#[test]
fn a_required_unicode_tag_narrows_on_the_stored_fold() {
    let (service, _vault, _index) = service(&[
        ("a.md", "#Ünï/x\n#other\n".as_bytes()),
        ("b.md", "#ünï\n".as_bytes()),
        ("c.md", "#ünïon\n".as_bytes()),
        ("d.md", "#İ\n".as_bytes()),
        ("e.md", b"#i\n"),
        ("f.md", "#ÜNÏ0\n".as_bytes()),
    ]);
    let reader = service.reader().unwrap();
    let run = |q: &str| {
        let compiled = compile(&parse_query(q).unwrap(), false).unwrap();
        let request = SearchQuery {
            compiled: &compiled,
            sort: SortOrder::FileNameAsc,
        };
        let narrowed = reader.search(&request).unwrap();
        let full = reader.search_unnarrowed_for_test(&request).unwrap();
        assert_eq!(narrowed.hits, full.hits, "{q}");
        let paths: Vec<String> = narrowed
            .hits
            .iter()
            .map(|h| h.path.as_str().to_string())
            .collect();
        (paths, narrowed.tag_rows_read)
    };
    assert_eq!(run("tag:#ÜNÏ"), (vec!["a.md".into(), "b.md".into()], 3));
    assert_eq!(run("tag:ünï/X"), (vec!["a.md".into()], 2));
    assert_eq!(run("tag:İ"), (vec!["d.md".into()], 1));
    assert_eq!(run("tag:i"), (vec!["e.md".into()], 1));
    assert_eq!(run("tag:#ünï0"), (vec!["f.md".into()], 1));
}

#[test]
fn the_sort_reads_tree_times() {
    // The times are set before the first build: a metadata-only touch
    // publishes no generation, so setting them afterwards would not reach
    // the index.
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (name, seconds) in [("a.md", 300), ("b.md", 100), ("c.md", 200)] {
        let path = vault.path().join(name);
        fs::write(&path, "x").unwrap();
        filetime::set_file_mtime(
            &path,
            filetime::FileTime::from_unix_time(1_700_000_000 + seconds, 0),
        )
        .unwrap();
    }
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let compiled = compile(&parse_query("x").unwrap(), false).unwrap();
    let answer = service
        .reader()
        .unwrap()
        .search(&SearchQuery {
            compiled: &compiled,
            sort: SortOrder::ModifiedDesc,
        })
        .unwrap();
    let order: Vec<&str> = answer.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(order, ["a.md", "c.md", "b.md"]);
}

#[test]
fn a_publication_completes_while_a_search_is_in_flight() {
    let (mut service, vault, _index) = service(&[("a.md", b"meeting\n")]);
    let mut reader = service.reader().unwrap();
    let before = reader.published_status().unwrap().generation;
    let (rendezvous, hook) = common::rendezvous("search");
    reader.pause_evaluations_for_test(hook);
    let searching = thread::spawn(move || {
        let compiled = compile(&parse_query("meeting").unwrap(), false).unwrap();
        reader
            .search(&SearchQuery {
                compiled: &compiled,
                sort: SortOrder::FileNameAsc,
            })
            .unwrap()
    });
    rendezvous.arrived();
    fs::write(vault.path().join("b.md"), "meeting\n").unwrap();
    service.refresh(false).unwrap();
    rendezvous.release();
    let answer = searching.join().unwrap();
    assert_eq!(
        Some(answer.generation),
        before,
        "the search answers the generation it pinned"
    );
    assert_eq!(answer.hits.len(), 1, "and none of the newer one's rows");
}

#[test]
// One span per path is the point here: each `vec![a..b]` is a list of one
// span, not a list of the range's numbers.
#[allow(clippy::single_range_in_vec_init)]
fn line_context_is_read_at_the_answers_generation() {
    let long = format!("{}needle{}\n", "x".repeat(1000), "é".repeat(500));
    let (mut service, vault, _index) = service(&[
        ("a.md", b"a\nThe meeting ran long.\n"),
        ("b.md", long.as_bytes()),
    ]);
    let reader = service.reader().unwrap();
    let generation = reader.published_status().unwrap().generation.unwrap();
    let contexts = reader
        .match_contexts(
            generation,
            &[(vp("a.md"), vec![6..13]), (vp("b.md"), vec![1000..1006])],
        )
        .unwrap();
    assert_eq!(
        contexts[0],
        vec![MatchContext {
            line_text: "The meeting ran long.".into(),
            line_text_start: 2
        }]
    );
    let cut = &contexts[1][0];
    assert!(cut.line_text.len() <= vault_index::MAX_LINE_TEXT_BYTES);
    assert!(cut.line_text.contains("needle"));
    assert!(cut.line_text_start > 0 && long.is_char_boundary(cut.line_text_start));
    fs::write(vault.path().join("a.md"), "changed\n").unwrap();
    service.refresh(false).unwrap();
    match reader.match_contexts(generation, &[(vp("a.md"), vec![0..1])]) {
        Err(IndexError::GenerationMismatch { cursor, current }) => {
            assert_eq!(cursor, generation.get());
            assert!(current > cursor);
        }
        other => panic!("expected GenerationMismatch, got {other:?}"),
    }
}

/// The fix round's I1: the context read pins its generation under the
/// publication guard and reads the bodies with no lock held, so a
/// publication completes while a page's contexts are being read, and the
/// contexts are still the pinned generation's.
#[test]
#[allow(clippy::single_range_in_vec_init)]
fn a_publication_completes_while_a_pages_contexts_are_read() {
    let (mut service, vault, _index) = service(&[("a.md", b"x\nThe meeting ran long.\n")]);
    let mut reader = service.reader().unwrap();
    let generation = reader.published_status().unwrap().generation.unwrap();
    let (rendezvous, hook) = common::rendezvous("contexts");
    reader.pause_evaluations_for_test(hook);
    let reading =
        thread::spawn(move || reader.match_contexts(generation, &[(vp("a.md"), vec![6..13])]));
    rendezvous.arrived();
    fs::write(vault.path().join("a.md"), "changed\n").unwrap();
    // A guard held across the hook would make the refresh wait for the
    // hook's release timeout: it must return well inside it, with the
    // context read still parked.
    let started = std::time::Instant::now();
    service.refresh(false).unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the publication waited {:?} for the parked context read",
        started.elapsed()
    );
    assert!(
        !reading.is_finished(),
        "the context read is still parked when the publication returns"
    );
    assert!(
        service
            .reader()
            .unwrap()
            .published_status()
            .unwrap()
            .generation
            > Some(generation),
        "the publication completed while the contexts were being read"
    );
    rendezvous.release();
    let contexts = reading.join().unwrap().unwrap();
    assert_eq!(
        contexts,
        vec![vec![MatchContext {
            line_text: "The meeting ran long.".into(),
            line_text_start: 2
        }]],
        "the contexts are the pinned generation's"
    );
}

/// The fix round's I2: `search_with_contexts` reads a page's contexts on
/// the scan's own pinned read, so a publication landing after the pin
/// cannot make the contexts disagree with the hits or refuse them.
#[test]
fn a_page_s_contexts_are_read_on_the_scan_s_own_pin() {
    let (mut service, vault, _index) = service(&[
        ("a.md", b"x\nThe meeting ran long.\n"),
        ("b.md", b"meeting\n"),
        ("c.md", b"no\nmeeting here\n"),
    ]);
    let mut reader = service.reader().unwrap();
    let before = reader.published_status().unwrap().generation;
    let (rendezvous, hook) = common::rendezvous("scan");
    reader.pause_evaluations_for_test(hook);
    let searching = thread::spawn(move || {
        let compiled = compile(&parse_query("meeting").unwrap(), false).unwrap();
        reader.search_with_contexts(
            &SearchQuery {
                compiled: &compiled,
                sort: SortOrder::FileNameAsc,
            },
            1..5,
        )
    });
    rendezvous.arrived();
    fs::write(vault.path().join("b.md"), "gone\n").unwrap();
    fs::write(vault.path().join("c.md"), "gone\n").unwrap();
    service.refresh(false).unwrap();
    rendezvous.release();
    let (answer, contexts) = searching.join().unwrap().unwrap();
    assert_eq!(Some(answer.generation), before);
    assert_eq!(answer.hits.len(), 3, "the pinned generation's hits");
    assert_eq!(
        contexts,
        vec![
            vec![MatchContext {
                line_text: "meeting".into(),
                line_text_start: 0
            }],
            vec![MatchContext {
                line_text: "meeting here".into(),
                line_text_start: 3
            }],
        ],
        "one list per hit of the page, clamped to the answer, from the pinned bodies"
    );
}

/// A fixed vault with overlapping words, tags, names and attachments, and
/// random queries over them: narrowing must never change the answer.
#[test]
fn narrowing_never_drops_a_file_the_query_keeps() {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let words = ["alpha", "beta", "gamma", "Alpha", "BETA"];
    let tags = ["work", "work/meeting", "myjob/work", "Home"];
    for i in 0..40 {
        let body = format!(
            "{} {}\n#{}\n",
            words[i % 5],
            words[(i * 3) % 5],
            tags[i % 4]
        );
        files.push((
            format!(
                "{}/{}-{i}.md",
                ["notes", "img", "Work"][i % 3],
                words[(i * 7) % 5]
            ),
            body.into_bytes(),
        ));
    }
    for i in 0..10 {
        files.push((format!("img/{}-{i}.png", words[i % 5]), vec![0]));
    }
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect();
    let (service, _vault, _index) = service(&borrowed);
    let reader = service.reader().unwrap();
    let leaf = prop::sample::select(vec![
        "alpha",
        "beta",
        "gam",
        "file:alpha",
        "file:.png",
        "file:img",
        "path:img",
        "path:work",
        "tag:work",
        "tag:#work/meeting",
        "tag:home",
        "content:beta",
        "match-case:Alpha",
        "ignore-case:BETA",
    ]);
    let query =
        prop::collection::vec((leaf, any::<bool>(), any::<bool>()), 1..4).prop_map(|items| {
            items
                .into_iter()
                .enumerate()
                .map(|(i, (leaf, negate, or))| {
                    let joiner = if i == 0 {
                        ""
                    } else if or {
                        " OR "
                    } else {
                        " "
                    };
                    format!("{joiner}{}{leaf}", if negate { "-" } else { "" })
                })
                .collect::<String>()
        });
    let mut runner = TestRunner::new(Config::with_cases(256));
    runner
        .run(&query, |text| {
            let compiled = compile(&parse_query(&text).unwrap(), false).unwrap();
            let request = SearchQuery {
                compiled: &compiled,
                sort: SortOrder::FileNameAsc,
            };
            let narrowed = reader.search(&request).unwrap().hits;
            let full = reader.search_unnarrowed_for_test(&request).unwrap().hits;
            prop_assert_eq!(narrowed, full, "{}", text);
            Ok(())
        })
        .unwrap();
}
