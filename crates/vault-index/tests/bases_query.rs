mod common;

use std::collections::BTreeMap;
use std::fs;

use tempfile::TempDir;
use vault_bases::eval::EvalContext;
use vault_bases::view::{compile_view, evaluate_view};
use vault_bases::{
    Clock, MemoryFile, MemorySource, Prefilter, PropertyType, RowSource, ScalarLiteral, Value,
    parse_base, text,
};
use vault_core::{PropertyValue, VaultPath};
use vault_index::{BaseQuery, BaseQueryError, IndexConfig, IndexService};

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
    assert_eq!(
        rows(&service, "Q.base", Some("Done"), None),
        vec!["Books/A.md"],
        "list, key case and value case never match"
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
