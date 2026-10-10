mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;
use vault_bases::eval::EvalContext;
use vault_bases::view::{compile_view, evaluate_view};
use vault_bases::{
    Clock, MemoryFile, MemorySource, Prefilter, PropertyType, RowSource, ScalarLiteral, Value,
    parse_base, text,
};
use vault_core::{PropertyValue, VaultPath};
use vault_index::{BaseQuery, BaseQueryError, ChangeCause, IndexConfig, IndexReader, IndexService};

const NOW: i64 = 1_768_491_000_000;

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn service(files: &[(&str, &str)]) -> (IndexService, TempDir, TempDir) {
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

fn rows(service: &IndexService, base: &str, view: Option<&str>, this: Option<&str>) -> Vec<String> {
    let types = BTreeMap::new();
    let this = this.map(vp);
    let answer = service
        .reader()
        .unwrap()
        .evaluate_base(
            &BaseQuery {
                path: &vp(base),
                view,
                this_path: this.as_ref(),
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
        .unwrap_or_else(|error| panic!("{error:?}"));
    answer
        .result
        .rows
        .iter()
        .map(|row| row.path.as_str().to_string())
        .collect()
}

/// The Task 13 review's M5: an attachment a note links to is found from
/// both ends. The note `hasLink` it and lists it in `file.embeds`, and the
/// attachment's `file.backlinks` names the note, though the note-only link
/// resolver leaves the embed unresolved. A name with no extension names no
/// attachment (captured).
#[test]
fn an_attachment_a_note_links_to_is_found_from_both_ends() {
    let files = [
        ("Notes/N.md", "![[pic.png]] [[README]]\n"),
        ("Notes/Other.md", "nothing here\n"),
        ("Images/pic.png", "png"),
        ("Images/README", "readme"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: Linking\n    filters: 'file.hasLink(\"Images/pic.png\")'\n  - type: table\n    name: Linked\n    filters: 'file.backlinks.length > 0'\n  - type: table\n    name: Readme\n    filters: 'file.hasLink(\"Images/README\")'\n",
        ),
    ];
    let (service, _vault, _index) = service(&files);
    assert_eq!(
        rows(&service, "Q.base", Some("Linking"), None),
        vec!["Notes/N.md"]
    );
    assert_eq!(
        rows(&service, "Q.base", Some("Linked"), None),
        vec!["Images/pic.png"]
    );
    assert!(rows(&service, "Q.base", Some("Readme"), None).is_empty());
}

#[test]
fn the_sqlite_source_answers_what_the_memory_source_answers() {
    let files = [
        (
            "Books/A.md",
            "---\nstatus: done\nprice: 3\ntags: [book]\n---\n[[B]]\n",
        ),
        ("Books/B.md", "---\nstatus: [done]\nprice: 10\n---\n#book\n"),
        ("Books/C.md", "---\nStatus: done\n---\n"),
        ("Books/D.md", "---\nstatus: DONE\n---\n![[A]]\n"),
        ("Other/E.md", "---\nstatus: done\n---\n"),
        ("Other/pic.png", "png"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: Done\n    filters:\n      and:\n        - file.inFolder(\"Books\")\n        - 'status == \"done\"'\n  - type: table\n    name: Tagged\n    filters: 'file.hasTag(\"BOOK\")'\n  - type: table\n    name: Linked\n    filters: 'file.hasLink(\"B\") || file.backlinks.length > 0'\n  - type: list\n    name: Pngs\n    filters: 'file.ext == \"png\"'\n",
        ),
    ];
    let (service, _vault, _index) = service(&files);
    let memory = MemorySource::new()
        .with(
            "Books/A.md",
            MemoryFile::note()
                .property("status", text("done"))
                .property("price", PropertyValue::Integer(3))
                .tag("book")
                .link("B"),
        )
        .with(
            "Books/B.md",
            MemoryFile::note()
                .property(
                    "status",
                    PropertyValue::Sequence(vec![vault_bases::no_span(text("done"))]),
                )
                .property("price", PropertyValue::Integer(10))
                .tag("book"),
        )
        .with(
            "Books/C.md",
            MemoryFile::note().property("Status", text("done")),
        )
        .with(
            "Books/D.md",
            MemoryFile::note()
                .property("status", text("DONE"))
                .embed("A"),
        )
        .with(
            "Other/E.md",
            MemoryFile::note().property("status", text("done")),
        )
        .with("Other/pic.png", MemoryFile::attachment(3))
        .with("Q.base", MemoryFile::attachment(10));
    let base = parse_base(files[6].1).unwrap();
    let clock = Clock::fixed(NOW, "UTC");
    let base_path = vp("Q.base");
    for view in ["Done", "Tagged", "Linked", "Pngs"] {
        let compiled = compile_view(&base, Some(view)).unwrap();
        let ctx = EvalContext::new(&memory, &clock, &base_path, &base_path);
        let expected: Vec<String> = evaluate_view(&compiled, &ctx)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.path.as_str().to_string())
            .collect();
        assert_eq!(
            rows(&service, "Q.base", Some(view), None),
            expected,
            "view {view}"
        );
    }
    // Captured (Task 13): a one-item list equals its item's text, so
    // `status: [done]` matches; the key's and the value's case still do not.
    assert_eq!(
        rows(&service, "Q.base", Some("Done"), None),
        vec!["Books/A.md", "Books/B.md"],
        "key case and value case never match"
    );
}

#[test]
fn property_equality_prefilter_keeps_list_and_mixed_case_values() {
    // Review Focus 1, over SQLite: the prefilter narrows by key alone (folded),
    // so the per-row conjunct is what decides, and a key spelled `Status`
    // reaches the conjunct (which then does not match it).
    let (service, _vault, _index) = service(&[
        ("A.md", "---\nstatus: done\n---\n"),
        ("B.md", "---\nStatus: done\n---\n"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: T\n    filters: 'note[\"Status\"] == \"done\"'\n",
        ),
    ]);
    assert_eq!(rows(&service, "Q.base", None, None), vec!["B.md"]);
}

#[test]
fn this_is_the_embedding_note_and_must_be_a_note() {
    let (service, _vault, _index) = service(&[
        ("Hub.md", "# Hub\n"),
        ("A.md", "[[Hub]]\n"),
        ("B.md", "nothing\n"),
        (
            "Q.base",
            "views:\n  - type: list\n    name: Back\n    filters: 'file.hasLink(this.file)'\n",
        ),
    ]);
    assert_eq!(rows(&service, "Q.base", None, Some("Hub.md")), vec!["A.md"]);
    assert_eq!(
        rows(&service, "Q.base", None, None),
        Vec::<String>::new(),
        "absent, `this` is the base, which nothing links to"
    );
    let types = BTreeMap::new();
    let error = service
        .reader()
        .unwrap()
        .evaluate_base(
            &BaseQuery {
                path: &vp("Q.base"),
                view: None,
                this_path: Some(&vp("Gone.md")),
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
        .expect_err("a missing this_path is refused");
    assert!(matches!(error, BaseQueryError::ThisPath(_)));
}

#[test]
fn declared_property_types_reach_the_evaluator() {
    let (service, _vault, _index) = service(&[
        ("A.md", "---\ndue: 2020-01-01\n---\n"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: T\n    filters: 'due < today()'\n    order: [due]\n",
        ),
    ]);
    let types: BTreeMap<String, PropertyType> =
        vault_index::parse_property_types(r#"{"types":{"due":"date"}}"#);
    let answer = service
        .reader()
        .unwrap()
        .evaluate_base(
            &BaseQuery {
                path: &vp("Q.base"),
                view: None,
                this_path: None,
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
        .unwrap();
    assert_eq!(answer.result.rows.len(), 1);
    assert!(matches!(answer.result.rows[0].cells[0], Ok(Value::Date(_))));
}

#[test]
fn list_bases_pages_with_status_and_views() {
    let (service, _vault, _index) = service(&[
        ("A.base", "views:\n  - type: table\n    name: One\n"),
        ("B.base", "views: [\n"),
        ("C.base", ""),
    ]);
    let reader = service.reader().unwrap();
    let first = reader.list_bases(None, Some(2)).unwrap();
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].views, vec!["One".to_string()]);
    assert!(matches!(
        first.items[1].status,
        vault_index::BaseStatus::ParseFailed(_)
    ));
    let second = reader
        .list_bases(first.next_cursor.as_deref(), Some(2))
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].path.as_str(), "C.base");
    assert!(second.next_cursor.is_none());
}

#[test]
fn parse_property_types_tolerates_anything_that_is_not_the_shape() {
    for json in ["", "not json", "[]", r#"{"types":[]}"#, r#"{"other":{}}"#] {
        assert!(vault_index::parse_property_types(json).is_empty(), "{json}");
    }
    let types = vault_index::parse_property_types(
        r#"{"types":{"a":"date","b":"datetime","c":"multitext","d":"weird","e":7}}"#,
    );
    assert_eq!(types.get("a"), Some(&PropertyType::Date));
    assert_eq!(types.get("b"), Some(&PropertyType::DateTime));
    assert_eq!(types.get("c"), Some(&PropertyType::List));
    assert_eq!(types.get("d"), Some(&PropertyType::Unknown));
    assert_eq!(types.get("e"), None, "a non-string type names nothing");
}

fn candidates(
    service: &IndexService,
    prefilters: &[Prefilter],
    types: &BTreeMap<String, PropertyType>,
) -> Vec<String> {
    service
        .reader()
        .unwrap()
        .base_candidates_for_test(prefilters, types)
        .unwrap()
        .iter()
        .map(|path| path.as_str().to_string())
        .collect()
}

fn equals(key: &str, value: ScalarLiteral) -> Prefilter {
    Prefilter::PropertyEquals {
        key: key.to_string(),
        value,
    }
}

/// The Task 7 contract on `Prefilter::PropertyEquals`, over SQLite: a list,
/// a mapping and a scalar of another kind are always admitted; only a
/// missing key, a null, or a differing scalar of the literal's own kind is
/// skipped. The memory source models the same rule, so the two must agree.
#[test]
fn a_property_prefilter_never_skips_a_list_a_mapping_or_another_kind() {
    let (service, _vault, _index) = service(&[
        ("list.md", "---\nstatus: [p]\n---\n"),
        ("map.md", "---\nstatus:\n  k: p\n---\n"),
        ("match.md", "---\nstatus: p\n---\n"),
        ("upper.md", "---\nStatus: p\n---\n"),
        ("null.md", "---\nstatus:\n---\n"),
        ("one.md", "---\nstatus: 1\n---\n"),
        ("flag.md", "---\nstatus: true\n---\n"),
        ("other.md", "---\nstatus: q\n---\n"),
        ("wiki.md", "---\nstatus: \"[[p]]\"\n---\n"),
        ("day.md", "---\nstatus: 2020-01-01\n---\n"),
        ("none.md", "nothing\n"),
        ("pic.png", "png"),
    ]);
    let none = BTreeMap::new();
    assert_eq!(
        candidates(
            &service,
            &[equals("status", ScalarLiteral::String("p".into()))],
            &none
        ),
        vec![
            "flag.md", "list.md", "map.md", "match.md", "one.md", "upper.md", "wiki.md"
        ],
        "text: lists, mappings, numbers, booleans, a wikilink and the folded key reach the filter"
    );
    assert_eq!(
        candidates(
            &service,
            &[equals("status", ScalarLiteral::Number(1.0))],
            &none
        ),
        vec![
            "day.md", "flag.md", "list.md", "map.md", "match.md", "one.md", "other.md", "upper.md",
            "wiki.md"
        ],
        "a number: every non-number reaches the filter, the differing number does not"
    );
    assert_eq!(
        candidates(
            &service,
            &[equals("status", ScalarLiteral::Boolean(true))],
            &none
        ),
        vec![
            "day.md", "flag.md", "list.md", "map.md", "match.md", "one.md", "other.md", "upper.md",
            "wiki.md"
        ],
    );
    let dated: BTreeMap<String, PropertyType> =
        vault_index::parse_property_types(r#"{"types":{"Status":"date"}}"#);
    assert_eq!(
        candidates(
            &service,
            &[equals("status", ScalarLiteral::String("p".into()))],
            &dated
        ),
        vec![
            "day.md", "flag.md", "list.md", "map.md", "match.md", "one.md", "other.md", "upper.md",
            "wiki.md"
        ],
        "a date-typed key: every text row reaches the filter, which decides or errors"
    );

    // The memory source's rule, with the exact key: the index is a superset.
    let memory = MemorySource::new()
        .with(
            "list.md",
            MemoryFile::note().property(
                "status",
                PropertyValue::Sequence(vec![vault_bases::no_span(text("p"))]),
            ),
        )
        .with("match.md", MemoryFile::note().property("status", text("p")))
        .with(
            "null.md",
            MemoryFile::note().property("status", PropertyValue::Null),
        )
        .with(
            "one.md",
            MemoryFile::note().property("status", PropertyValue::Integer(1)),
        )
        .with("other.md", MemoryFile::note().property("status", text("q")))
        .with("none.md", MemoryFile::note());
    let from_memory: Vec<String> = memory
        .candidates(&[equals("status", ScalarLiteral::String("p".into()))])
        .unwrap()
        .iter()
        .map(|path| path.as_str().to_string())
        .collect();
    assert_eq!(from_memory, vec!["list.md", "match.md", "one.md"]);
}

/// Folder and tag narrowing over SQLite: `%` and `_` in a folder are
/// literal, a nested folder and a nested tag are admitted, a tag matches
/// case-insensitively with or without its `#`, and an extension is exact.
#[test]
fn folder_tag_and_extension_prefilters_narrow_exactly() {
    let (service, _vault, _index) = service(&[
        ("50%_off/a.md", "#Book/fiction\n"),
        ("50xyoff/b.md", "#book\n"),
        ("50%_off/deep/c.png", "png"),
        ("Books/d.md", "#booking\n"),
        ("e.md", "---\ntags: [BOOK]\n---\n"),
    ]);
    let none = BTreeMap::new();
    assert_eq!(
        candidates(&service, &[Prefilter::InFolder("50%_off".into())], &none),
        vec!["50%_off/a.md", "50%_off/deep/c.png"]
    );
    assert_eq!(
        candidates(&service, &[Prefilter::HasTag(vec!["#BOOK".into()])], &none),
        vec!["50%_off/a.md", "50xyoff/b.md", "e.md"]
    );
    assert_eq!(
        candidates(&service, &[Prefilter::Ext("png".into())], &none),
        vec!["50%_off/deep/c.png"]
    );
    assert_eq!(
        candidates(
            &service,
            &[
                Prefilter::InFolder("50%_off".into()),
                Prefilter::HasTag(vec!["book".into()])
            ],
            &none
        ),
        vec!["50%_off/a.md"],
        "prefilters are a conjunction"
    );
    assert_eq!(
        candidates(&service, &[], &none).len(),
        5,
        "no prefilter is every file"
    );
}

/// The equal-value probe of each `PropertyEquals` literal is served by its
/// value index, not by the `key_fold` prefix alone.
#[test]
fn the_value_indexes_serve_the_property_prefilter() {
    let (service, _vault, _index) = service(&[
        ("a.md", "---\nstatus: p\nn: 1\n---\n"),
        ("b.md", "---\nstatus: q\nn: 2\n---\n"),
    ]);
    let none = BTreeMap::new();
    let plan = |prefilter: Prefilter| -> String {
        service
            .reader()
            .unwrap()
            .base_candidates_plan_for_test(&[prefilter], &none)
            .unwrap()
            .join("\n")
    };
    let text = plan(equals("status", ScalarLiteral::String("p".into())));
    assert!(
        text.contains("properties_by_string (key_fold=? AND string_value=?)"),
        "{text}"
    );
    let number = plan(equals("n", ScalarLiteral::Number(1.0)));
    assert!(
        number.contains("properties_by_number (key_fold=? AND number_value=?)"),
        "{number}"
    );
    let flag = plan(equals("n", ScalarLiteral::Boolean(true)));
    assert!(
        flag.contains("properties_by_number (key_fold=? AND number_value=?)"),
        "{flag}"
    );
}

/// A parking hook for an evaluation: it reports that the evaluation is
/// parked (after the publication guard is released, before evaluating) and
/// waits for a release, at most 30 s so a failed test cannot wedge.
fn parking(reader: &mut IndexReader) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (parked_tx, parked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let parked_tx = Mutex::new(parked_tx);
    let release_rx = Mutex::new(release_rx);
    reader.pause_evaluations_for_test(Arc::new(move || {
        let _ = parked_tx.lock().unwrap().send(());
        let _ = release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(30));
    }));
    (parked_rx, release_tx)
}

const PARKED_VAULT: [(&str, &str); 2] = [
    ("A.md", "---\nn: 1\n---\n"),
    (
        "Q.base",
        "views:\n  - type: table\n    name: T\n    filters: 'file.ext == \"md\"'\n    order: [n]\n",
    ),
];

fn evaluate_rows(reader: &IndexReader) -> (u64, Vec<String>) {
    let types = BTreeMap::new();
    let answer = reader
        .evaluate_base(
            &BaseQuery {
                path: &vp("Q.base"),
                view: None,
                this_path: None,
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
        .unwrap_or_else(|error| panic!("{error:?}"));
    (
        answer.generation.get(),
        answer
            .result
            .rows
            .iter()
            .map(|row| row.path.as_str().to_string())
            .collect(),
    )
}

/// H1: a publication completes while an evaluation is in flight, and the
/// evaluation still answers at the generation it started on (snapshot
/// isolation). The `recv_timeout` is a hang detector, not a timing bound.
#[test]
fn a_publication_never_waits_for_an_evaluation() {
    let (mut service, vault, _index) = service(&PARKED_VAULT);
    let mut reader = service.reader().unwrap();
    let (parked, release) = parking(&mut reader);
    let before = reader.published_status().unwrap().generation.unwrap().get();
    let evaluation = thread::spawn(move || evaluate_rows(&reader));
    parked
        .recv_timeout(Duration::from_secs(10))
        .expect("the evaluation parks after releasing the guard");

    fs::write(vault.path().join("B.md"), "---\nn: 2\n---\n").unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let publisher = thread::spawn(move || {
        let report = service.refresh_paths(BTreeSet::from([vp("B.md")]), ChangeCause::Watcher);
        let _ = done_tx.send(());
        (service, report)
    });
    let published = done_rx.recv_timeout(Duration::from_secs(10));
    let _ = release.send(());
    let (service, report) = publisher.join().unwrap();
    published.expect("a publication completes while an evaluation is parked");
    report.unwrap();
    let after = service
        .reader()
        .unwrap()
        .published_status()
        .unwrap()
        .generation
        .unwrap()
        .get();
    assert_eq!(after, before + 1, "the publication landed");

    let (generation, rows) = evaluation.join().unwrap();
    assert_eq!(
        generation, before,
        "the parked evaluation keeps its generation"
    );
    assert_eq!(rows, vec!["A.md"], "and that generation's rows");
    assert_eq!(
        evaluate_rows(&service.reader().unwrap()),
        (after, vec!["A.md".to_string(), "B.md".to_string()]),
        "a new evaluation sees the publication"
    );
}

/// H1: another read on the same reader answers while an evaluation is in
/// flight, so one evaluation never blocks every other connection's reads.
#[test]
fn an_evaluation_never_blocks_another_read() {
    let (service, _vault, _index) = service(&PARKED_VAULT);
    let mut reader = service.reader().unwrap();
    let (parked, release) = parking(&mut reader);
    let reader = Arc::new(reader);
    let evaluating = Arc::clone(&reader);
    let evaluation = thread::spawn(move || evaluate_rows(&evaluating));
    parked
        .recv_timeout(Duration::from_secs(10))
        .expect("the evaluation parks after releasing the guard");

    let (done_tx, done_rx) = mpsc::channel();
    let listing = Arc::clone(&reader);
    let other = thread::spawn(move || {
        let notes = listing.list_notes(None, None).map(|page| page.items.len());
        let _ = done_tx.send(());
        notes
    });
    let answered = done_rx.recv_timeout(Duration::from_secs(10));
    let _ = release.send(());
    let notes = other.join().unwrap();
    answered.expect("another read answers while an evaluation is parked");
    assert_eq!(notes.unwrap(), 1);
    assert_eq!(evaluation.join().unwrap().1, vec!["A.md"]);
}

/// A hook that counts its visits, reports each on `visits`, and parks until
/// `release` (at most 30 s, so a failed test cannot wedge).
fn reporting_hook(
    label: &'static str,
    count: Arc<std::sync::atomic::AtomicUsize>,
    visits: mpsc::Sender<&'static str>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
) -> vault_index::PauseHook {
    let visits = Mutex::new(visits);
    Arc::new(move || {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = visits.lock().unwrap().send(label);
        let _ = release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(30));
    })
}

/// The Task 11 carry, and the Task 12 review's H3: the first resolving read
/// of a generation builds the whole-vault resolver, and a publication landing
/// then must not wait for it. The read copies the catalog under the guard and
/// builds outside it, so a publication made while it is parked in the build
/// completes; the writer never builds one (a publication's cost does not
/// depend on whether anyone resolves). Under the Task 11 shape the read parks
/// in the build hook while holding the guard, and the publication's hang
/// detector fires.
#[test]
fn a_publication_never_waits_for_the_first_resolving_read_of_a_generation() {
    let (mut service, vault, _index) = service(&PARKED_VAULT);
    // A reader has resolved once already.
    evaluate_rows(&service.reader().unwrap());

    fs::write(vault.path().join("B.md"), "---\nn: 2\n---\n").unwrap();
    service
        .refresh_paths(BTreeSet::from([vp("B.md")]), ChangeCause::Watcher)
        .unwrap();

    let builds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (visits_tx, visits) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let mut reader = service.reader().unwrap();
    reader.pause_resolver_builds_for_test(reporting_hook(
        "the resolver build, guard released",
        Arc::clone(&builds),
        visits_tx.clone(),
        Arc::clone(&release_rx),
    ));
    reader.pause_evaluations_for_test(reporting_hook(
        "the evaluation, guard released",
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        visits_tx,
        release_rx,
    ));
    let evaluation = thread::spawn(move || evaluate_rows(&reader));
    let parked_in = visits
        .recv_timeout(Duration::from_secs(10))
        .expect("the first resolving read of the generation parks somewhere");
    assert_eq!(
        parked_in, "the resolver build, guard released",
        "nothing built this generation's resolver before its first resolving read"
    );

    fs::write(vault.path().join("C.md"), "---\nn: 3\n---\n").unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let publisher = thread::spawn(move || {
        let report = service.refresh_paths(BTreeSet::from([vp("C.md")]), ChangeCause::Watcher);
        let _ = done_tx.send(());
        (service, report)
    });
    let published = done_rx.recv_timeout(Duration::from_secs(10));
    // One release per park: the build and the evaluation, twice if the read
    // retries at C's generation.
    for _ in 0..4 {
        let _ = release_tx.send(());
    }
    let (service, report) = publisher.join().unwrap();
    published.unwrap_or_else(|_| {
        panic!("a publication completes during the first resolving read (parked in {parked_in})")
    });
    report.unwrap();
    let (generation, rows) = evaluation.join().unwrap();
    let current = service
        .reader()
        .unwrap()
        .published_status()
        .unwrap()
        .generation
        .unwrap()
        .get();
    // The read built the resolver for the generation it first saw, which C
    // then moved past, so its evaluation refused that generation and retried
    // at C's (building once more): either way it answers one generation's
    // rows whole.
    let expected: &[&str] = if generation == current {
        &["A.md", "B.md", "C.md"]
    } else {
        assert_eq!(
            generation + 1,
            current,
            "C landed after the read's generation"
        );
        &["A.md", "B.md"]
    };
    assert_eq!(rows, expected, "the read answers at its generation");
    let built = builds.load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        (1..=2).contains(&built),
        "the read built a resolver per generation it read at: {built}"
    );
}

/// A second resolving read of a generation whose resolver another read is
/// building waits for that build, with no lock held, rather than building a
/// second one; then it uses the one built.
#[test]
fn a_read_that_meets_a_build_in_flight_waits_for_it() {
    let (mut service, vault, _index) = service(&PARKED_VAULT);
    evaluate_rows(&service.reader().unwrap());
    fs::write(vault.path().join("B.md"), "---\nn: 2\n---\n").unwrap();
    service
        .refresh_paths(BTreeSet::from([vp("B.md")]), ChangeCause::Watcher)
        .unwrap();
    let current = service
        .reader()
        .unwrap()
        .published_status()
        .unwrap()
        .generation
        .unwrap()
        .get();

    let (build, hook) = common::rendezvous("the first read's resolver build");
    let mut first = service.reader().unwrap();
    first.pause_resolver_builds_for_test(hook);
    let builds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&builds);
    let mut second = service.reader().unwrap();
    second.pause_resolver_builds_for_test(Arc::new(move || {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));

    let building = thread::spawn(move || evaluate_rows(&first));
    build.arrived();
    let (done_tx, done_rx) = mpsc::channel();
    let waiting = thread::spawn(move || {
        let answer = evaluate_rows(&second);
        let _ = done_tx.send(());
        answer
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "the second read waits while the build for its generation is in flight"
    );
    build.release();
    assert_eq!(building.join().unwrap().0, current);
    assert_eq!(waiting.join().unwrap().0, current);
    assert_eq!(
        builds.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the second read used the build it waited for"
    );
}

/// The Task 11 re-review carry: the pooled evaluation connection goes back
/// to the pool on every path, the refusals included.
#[test]
fn every_evaluation_path_returns_its_pooled_connection() {
    let (mut service, vault, _index) = service(&PARKED_VAULT);
    let reader = service.reader().unwrap();
    evaluate_rows(&reader);
    let idle = reader.evaluation_pool_len_for_test();
    assert_eq!(idle, 1, "one evaluation leaves one idle connection");

    let types = BTreeMap::new();
    let ask = |path: &str, view: Option<&str>| {
        reader.evaluate_base(
            &BaseQuery {
                path: &vp(path),
                view,
                this_path: None,
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
    };
    assert!(matches!(
        ask("Q.base", Some("Nope")),
        Err(BaseQueryError::Compile(_))
    ));
    assert_eq!(
        reader.evaluation_pool_len_for_test(),
        idle,
        "after a compile error"
    );
    assert!(matches!(
        ask("Nowhere.base", None),
        Err(BaseQueryError::NotFound(_))
    ));
    assert_eq!(
        reader.evaluation_pool_len_for_test(),
        idle,
        "after not found"
    );

    let stale = reader.published_status().unwrap().generation.unwrap().get();
    fs::write(vault.path().join("B.md"), "---\nn: 2\n---\n").unwrap();
    service
        .refresh_paths(BTreeSet::from([vp("B.md")]), ChangeCause::Watcher)
        .unwrap();
    assert!(matches!(
        reader.open_evaluation_for_test(stale),
        Err(vault_index::IndexError::LiveStateStale(_))
    ));
    assert_eq!(
        reader.evaluation_pool_len_for_test(),
        idle,
        "after a refusal at a generation the writer moved past"
    );
    assert_eq!(
        reader.open_evaluation_for_test(stale + 1).unwrap(),
        stale + 1
    );
    assert_eq!(
        reader.evaluation_pool_len_for_test(),
        idle,
        "after a pinned read"
    );
    evaluate_rows(&reader);
    assert_eq!(reader.evaluation_pool_len_for_test(), idle);
}

/// Task 14 fix round: the attachment backlinks arm looks its candidates up by
/// the target's file name (ASCII case folded, as SQLite's `lower` folds it)
/// instead of scanning every unresolved reference. A different-case spelling
/// and a folder-qualified one still find the attachment; a name that only
/// contains the attachment's name does not. The backlinks are read back
/// whole, so a lost spelling is seen (fix round 2: a key left unfolded
/// dropped `Notes/Folder.md`, and a `length > 0` filter could not tell).
#[test]
fn attachment_backlinks_match_by_name_without_case_and_never_by_substring() {
    let files = [
        ("Notes/Lower.md", "![[photo.png]]\n"),
        ("Notes/Folder.md", "![[Images/Photo.PNG]]\n"),
        ("Notes/Near.md", "![[xphoto.png]] ![[photo.png.bak]]\n"),
        ("Notes/None.md", "nothing\n"),
        ("Images/Photo.PNG", "png"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: Linked\n    filters: 'file.backlinks.length > 0'\n    order: [file.backlinks]\n  - type: table\n    name: Backlinkers\n    filters: 'file.hasLink(\"Images/Photo.PNG\")'\n",
        ),
    ];
    let (service, _vault, _index) = service(&files);
    assert_eq!(
        rows(&service, "Q.base", Some("Linked"), None),
        vec!["Images/Photo.PNG"]
    );
    let types = BTreeMap::new();
    let answer = service
        .reader()
        .unwrap()
        .evaluate_base(
            &BaseQuery {
                path: &vp("Q.base"),
                view: Some("Linked"),
                this_path: None,
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        )
        .unwrap();
    let Ok(Value::List(backlinks)) = &answer.result.rows[0].cells[0] else {
        panic!(
            "the backlinks cell is a list: {:?}",
            answer.result.rows[0].cells[0]
        );
    };
    let mut from: Vec<String> = backlinks
        .iter()
        .map(|link| match link {
            Value::Link(link) => link.target.clone(),
            other => panic!("a backlink is a link: {other:?}"),
        })
        .collect();
    from.sort();
    assert_eq!(
        from,
        ["Notes/Folder.md", "Notes/Lower.md"],
        "exactly the two spellings that resolve to the attachment"
    );
    // The backlinks agree with the links from the other end.
    assert_eq!(
        rows(&service, "Q.base", Some("Backlinkers"), None),
        vec!["Notes/Folder.md", "Notes/Lower.md"]
    );
}

/// Task 14 fix round: an evaluation is never refused merely because the vault
/// keeps changing. A whole-vault view is evaluated in a loop for 10 s while a
/// writer publishes one new note every 7 ms; every request answers, and each
/// answer is one generation's: its row count is exactly the files that
/// generation held (the base, the starting notes, one more per publication
/// since). Ignored by default (it runs 10 s); run it with
/// `TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test bases_query --
/// --ignored a_whole_vault_evaluation_answers`.
#[test]
#[ignore = "runs for 10 s; run with --ignored"]
fn a_whole_vault_evaluation_answers_while_the_writer_publishes_every_seven_ms() {
    const START: usize = 3_000;
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for at in 0..START {
        fs::write(
            vault.path().join(format!("N{at:05}.md")),
            format!("n {at}\n"),
        )
        .unwrap();
    }
    fs::write(
        vault.path().join("All.base"),
        "views:\n  - type: table\n    name: All\n    order: [file.name]\n",
    )
    .unwrap();
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let first = reader.published_status().unwrap().generation.unwrap().get();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let (answered, refused) = thread::scope(|scope| {
        let evaluations = scope.spawn(|| {
            let types = BTreeMap::new();
            let mut answered = 0usize;
            let mut refused = Vec::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                match reader.evaluate_base(
                    &BaseQuery {
                        path: &vp("All.base"),
                        view: None,
                        this_path: None,
                        types: &types,
                    },
                    &Clock::fixed(NOW, "UTC"),
                ) {
                    Ok(answer) => {
                        let generation = answer.generation.get();
                        let published = usize::try_from(generation - first).unwrap();
                        assert_eq!(
                            answer.result.total_rows,
                            START + 1 + published,
                            "the answer at generation {generation} mixes generations"
                        );
                        answered += 1;
                    }
                    Err(error) => refused.push(format!("{error:?}")),
                }
            }
            (answered, refused)
        });
        let started = std::time::Instant::now();
        let mut at = 0usize;
        while started.elapsed() < Duration::from_secs(10) {
            let path = vp(&format!("New{at:06}.md"));
            fs::write(vault.path().join(path.as_str()), "new\n").unwrap();
            service
                .refresh_paths(BTreeSet::from([path]), ChangeCause::Watcher)
                .unwrap();
            at += 1;
            thread::sleep(Duration::from_millis(7));
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        evaluations.join().unwrap()
    });
    assert!(answered > 0, "no evaluation answered");
    assert!(
        refused.is_empty(),
        "{} of {} evaluations were refused: {:?}",
        refused.len(),
        answered + refused.len(),
        refused
    );
}

/// Task 14 fix round 2: an evaluation's resolver is the pinned generation's.
/// A note's frontmatter `up: "[[Target]]"` is unresolved at the generation an
/// evaluation pins; `Target.md` is published while the evaluation is parked
/// after the pin; the answer is at the old generation and still shows the
/// link unresolved. A resolver taken from the newer generation would resolve
/// it beside the old generation's rows.
#[test]
fn an_evaluations_resolver_belongs_to_the_generation_it_pinned() {
    let files = [
        ("A.md", "---\nup: \"[[Target]]\"\n---\n"),
        (
            "Q.base",
            "views:\n  - type: table\n    name: T\n    filters: 'file.ext == \"md\"'\n    order: [up]\n",
        ),
    ];
    let (mut service, vault, _index) = service(&files);
    let up_resolved = |reader: &IndexReader| {
        let types = BTreeMap::new();
        let answer = reader
            .evaluate_base(
                &BaseQuery {
                    path: &vp("Q.base"),
                    view: None,
                    this_path: None,
                    types: &types,
                },
                &Clock::fixed(NOW, "UTC"),
            )
            .unwrap_or_else(|error| panic!("{error:?}"));
        let row = answer
            .result
            .rows
            .iter()
            .find(|row| row.path.as_str() == "A.md")
            .expect("A.md is a row");
        let resolved = match &row.cells[0] {
            Ok(Value::Link(link)) => link.resolved.clone(),
            other => panic!("`up` is a link: {other:?}"),
        };
        (answer.generation.get(), resolved)
    };
    // Built once for this generation, so the parked read takes it ready.
    let (before, resolved) = up_resolved(&service.reader().unwrap());
    assert_eq!(resolved, None, "no Target yet");

    let mut reader = service.reader().unwrap();
    let (parked, release) = parking(&mut reader);
    let evaluation = thread::spawn(move || up_resolved(&reader));
    parked
        .recv_timeout(Duration::from_secs(10))
        .expect("the evaluation parks after its pin");
    fs::write(vault.path().join("Target.md"), "target\n").unwrap();
    service
        .refresh_paths(BTreeSet::from([vp("Target.md")]), ChangeCause::Watcher)
        .unwrap();
    // The newer generation's resolver exists before the parked read goes on.
    let (after, resolved_after) = up_resolved(&service.reader().unwrap());
    assert_eq!(after, before + 1);
    assert_eq!(
        resolved_after,
        Some(vp("Target.md")),
        "the new generation resolves it"
    );
    release.send(()).unwrap();
    let (generation, resolved) = evaluation.join().unwrap();
    assert_eq!(
        generation, before,
        "the parked read answers at its pinned generation"
    );
    assert_eq!(
        resolved, None,
        "the parked read resolves with its own generation's resolver"
    );
}

/// Task 14 fix round 2: an evaluation that is refused as stale on every
/// attempt gives up with the typed error once its 2 s budget runs out,
/// instead of retrying forever. The `recv_timeout` is a hang detector.
#[test]
fn an_evaluation_that_never_holds_still_answers_live_state_stale_within_its_budget() {
    let (service, _vault, _index) = service(&PARKED_VAULT);
    let mut reader = service.reader().unwrap();
    reader.force_stale_evaluations_for_test();
    let (done_tx, done_rx) = mpsc::channel();
    let started = std::time::Instant::now();
    thread::spawn(move || {
        let types = BTreeMap::new();
        let answer = reader.evaluate_base(
            &BaseQuery {
                path: &vp("Q.base"),
                view: None,
                this_path: None,
                types: &types,
            },
            &Clock::fixed(NOW, "UTC"),
        );
        let _ = done_tx.send(answer.map(|answer| answer.generation.get()));
    });
    let answer = done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the evaluation gives up within its budget");
    let took = started.elapsed();
    assert!(
        matches!(
            answer,
            Err(BaseQueryError::Index(
                vault_index::IndexError::LiveStateStale(_)
            ))
        ),
        "{answer:?}"
    );
    assert!(
        took >= Duration::from_millis(1_900),
        "it retried for its budget: {took:?}"
    );
    assert!(
        took < Duration::from_secs(3),
        "it stopped at its budget: {took:?}"
    );
}
