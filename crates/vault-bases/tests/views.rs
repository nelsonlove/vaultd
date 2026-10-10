use std::collections::BTreeSet;

use vault_bases::PropertyType;
use vault_bases::eval::{EvalContext, EvalError};
use vault_bases::expr::{MAX_DEPTH, parse_expression};
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE, render_text};
use vault_bases::view::{CompileError, ViewResult, compile_view, evaluate_view};
use vault_bases::{
    Clock, FileKind, MemoryFile, MemorySource, Prefilter, ScalarLiteral, Value, number, parse_base,
    text,
};
use vault_core::VaultPath;

fn books() -> MemorySource {
    MemorySource::new()
        .with(
            "Books/Dune.md",
            MemoryFile::note()
                .tag("book")
                .property("price", number(10.0))
                .property("age", number(2.0))
                .property("status", text("reading")),
        )
        .with(
            "Books/Emma.md",
            MemoryFile::note()
                .tag("book")
                .property("price", number(3.0))
                .property("age", number(1.0))
                .property("status", text("done")),
        )
        .with(
            "Books/Ulysses.md",
            MemoryFile::note()
                .tag("book")
                .property("price", number(30.0))
                .property("age", number(3.0))
                .property("status", text("queued")),
        )
        .with(
            "Required Reading/Kafka.md",
            MemoryFile::note()
                .tag("book")
                .property("price", number(8.0))
                .property("age", number(2.0)),
        )
        .with("Notes/Textbook.md", MemoryFile::note().tag("tag"))
        .with(
            "Notes/Lecture.md",
            MemoryFile::note()
                .tag("book")
                .link("Textbook")
                .property("price", number(5.0))
                .property("age", number(1.0)),
        )
        .with("Images/cover.png", MemoryFile::attachment(2048))
}

fn run(source: &MemorySource, base_yaml: &str, view: Option<&str>) -> ViewResult {
    let base = parse_base(base_yaml).expect("the base parses");
    let compiled = compile_view(&base, view).expect("the view compiles");
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let base_path = VaultPath::new("Books.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base_path, &base_path);
    evaluate_view(&compiled, &ctx).expect("the source answers")
}

fn paths(result: &ViewResult) -> Vec<&str> {
    result.rows.iter().map(|row| row.path.as_str()).collect()
}

fn cell(result: &ViewResult, row: usize, column: usize) -> Value {
    result.rows[row].cells[column]
        .clone()
        .expect("a value, not an error cell")
}

const SYNTAX_PAGE_EXAMPLE: &str = r#"filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
"#;

#[test]
fn the_syntax_page_example_evaluates() {
    let result = run(&books(), SYNTAX_PAGE_EXAMPLE, None);
    // Global filter: Textbook (#tag), Lecture (#book and links Textbook), the
    // attachment (neither #book nor in Required Reading). View filter: status
    // is not "done" (missing status is not "done"), and ppu > 5 or price > 2.1;
    // the attachment has no price, so `price > 2.1` compares null and errors,
    // and an erroring filter excludes the row (`filter:error_row`).
    assert_eq!(paths(&result), vec!["Notes/Lecture.md"]);
    assert_eq!(cell(&result, 0, 0), Value::String("Lecture".into()));
    assert_eq!(cell(&result, 0, 1), Value::String("md".into()));
    assert_eq!(cell(&result, 0, 2), Value::Number(1.0));
    assert_eq!(cell(&result, 0, 3), Value::String("5.00".into()));
    assert_eq!(cell(&result, 0, 4), Value::String("5.00 dollars".into()));
    assert_eq!(result.rows[0].kind, FileKind::Note);
    assert_eq!(
        result.rows[0].group.clone().unwrap().unwrap(),
        Value::Number(1.0)
    );
    assert_eq!(result.summaries.len(), 1);
    assert_eq!(result.summaries[0].property, "formula.ppu");
    assert_eq!(result.summaries[0].name, "Average");
}

#[test]
fn sort_is_stable_multi_key_and_directional_and_limit_applies_before_grouping() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\")'\n    order: [file.name, price, note.age]\n    sort:\n      - property: note.age\n        direction: DESC\n      - property: price\n        direction: ASC\n    limit: 3\n    groupBy:\n      property: note.age\n      direction: ASC\n";
    let result = run(&books(), yaml, None);
    // Sorted by age desc then price asc: Ulysses(3,30), Kafka(2,8), Dune(2,10),
    // Emma(1,3), Lecture(1,5). Limit 3 keeps the first three; grouping by age
    // ascending then puts the age-2 group before the age-3 group, keeping the
    // sorted order inside each group.
    assert_eq!(
        paths(&result),
        vec![
            "Required Reading/Kafka.md",
            "Books/Dune.md",
            "Books/Ulysses.md"
        ]
    );
    assert_eq!(result.total_rows, 3);
}

#[test]
fn without_a_sort_rows_keep_path_order() {
    let result = run(
        &books(),
        "views:\n  - type: list\n    name: L\n    filters: 'file.inFolder(\"Books\")'\n",
        None,
    );
    assert_eq!(
        paths(&result),
        vec!["Books/Dune.md", "Books/Emma.md", "Books/Ulysses.md"]
    );
}

#[test]
fn not_means_none_of_the_following() {
    let result = run(
        &books(),
        "views:\n  - type: table\n    name: T\n    filters:\n      not:\n        - file.hasTag(\"book\")\n        - file.ext == \"png\"\n",
        None,
    );
    assert_eq!(paths(&result), vec!["Notes/Textbook.md"]);
}

#[test]
fn an_error_inside_not_excludes_the_row() {
    // `file.nosuch` errors on every row (a file has no such field); `not`
    // must not turn that error into an admitted row.
    let result = run(
        &books(),
        "views:\n  - type: table\n    name: T\n    filters:\n      not:\n        - 'file.nosuch > 2'\n",
        None,
    );
    assert_eq!(paths(&result), Vec::<&str>::new());
}

#[test]
fn built_in_and_custom_summaries() {
    let yaml = "summaries:\n  rounded: 'values.mean().round(3)'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [price, status, file.mtime]\n    summaries:\n      price: Average\n      status: Filled\n      note.price: rounded\n";
    let result = run(&books(), yaml, None);
    let summary = |property: &str| {
        result
            .summaries
            .iter()
            .find(|summary| summary.property == property)
            .unwrap_or_else(|| panic!("a summary for {property}"))
            .value
            .clone()
            .expect("a value")
    };
    assert_eq!(summary("price"), Value::Number(43.0 / 3.0));
    assert_eq!(summary("status"), Value::Number(3.0));
    assert_eq!(summary("note.price"), Value::Number(14.333));
}

#[test]
fn every_builtin_summary_has_a_definition() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [price]\n    summaries:\n      price: Median\n";
    let result = run(&books(), yaml, None);
    assert_eq!(
        result.summaries[0].value.clone().unwrap(),
        Value::Number(10.0)
    );
    for name in vault_bases::view::BUILTIN_SUMMARIES {
        let yaml = format!(
            "views:\n  - type: table\n    name: T\n    order: [price]\n    summaries:\n      price: {name}\n"
        );
        let base = parse_base(&yaml).unwrap();
        assert!(compile_view(&base, None).is_ok(), "{name} compiles");
    }
}

#[test]
fn a_cell_that_fails_is_an_error_cell_and_its_row_stays() {
    let yaml = "formulas:\n  broken: 'price + true'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [file.name, formula.broken]\n";
    let result = run(&books(), yaml, None);
    assert_eq!(result.rows.len(), 3);
    for row in &result.rows {
        assert!(row.cells[0].is_ok());
        assert!(
            row.cells[1].is_err(),
            "a number plus a boolean is an error cell"
        );
    }
}

#[test]
fn a_formula_cycle_is_an_error_cell_not_a_hang() {
    let yaml = "formulas:\n  a: 'formula.b + 1'\n  b: 'formula.a + 1'\n  c: '2'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.a, formula.c]\n";
    let result = run(&books(), yaml, None);
    let error = result.rows[0].cells[0].clone().unwrap_err();
    assert!(error.to_string().contains("cycle"), "{error}");
    assert_eq!(cell(&result, 0, 1), Value::Number(2.0));
}

#[test]
fn compile_errors_name_what_is_wrong() {
    let base =
        parse_base("views:\n  - type: table\n    name: A\n  - type: cards\n    name: B\n").unwrap();
    assert_eq!(
        compile_view(&base, Some("C")).unwrap_err(),
        CompileError::ViewNotFound {
            declared: vec!["A".into(), "B".into()]
        }
    );
    // Filters that do not compile still refuse the request (ruling R1:
    // there are no rows to show).
    let base =
        parse_base("views:\n  - type: table\n    name: T\n    filters: 'price +'\n").unwrap();
    assert!(matches!(
        compile_view(&base, None).unwrap_err(),
        CompileError::ExpressionInvalid { expression, position: 7, .. } if expression == "price +"
    ));
    let base =
        parse_base("views:\n  - type: table\n    name: T\n    filters: 'frobnicate(price)'\n")
            .unwrap();
    assert_eq!(
        compile_view(&base, None).unwrap_err(),
        CompileError::UnsupportedFunction {
            name: "frobnicate".into()
        }
    );
    let base =
        parse_base("views:\n  - type: table\n    name: T\n    filters: 'price.frobnicate()'\n")
            .unwrap();
    assert_eq!(
        compile_view(&base, None).unwrap_err(),
        CompileError::UnsupportedFunction {
            name: "frobnicate".into()
        }
    );
}

/// Ruling R1 (2026-10-09; the project
/// picked Obsidian's behaviour): a formula that does not parse, or that
/// calls an unknown function or method, does not refuse the view. Its column
/// is an error cell in every row, naming the parse or lookup failure, and
/// every other column answers.
#[test]
fn a_broken_formula_is_an_error_cell_in_every_row_that_reads_it() {
    use vault_bases::eval::EvalError;
    let yaml = "formulas:\n  bad: 'price +'\n  unknown: 'frobnicate(price)'\n  method: 'price.frobnicate()'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.bad, formula.unknown, formula.method, price]\n    summaries:\n      price: Broken\nsummaries:\n  Broken: 'values.frobnicate()'\n";
    let result = run(&books(), yaml, None);
    assert_eq!(result.rows.len(), 3);
    for row in &result.rows {
        assert!(
            matches!(&row.cells[0], Err(EvalError::FormulaInvalid { name, message }) if name == "bad" && message.ends_with("at 7")),
            "{:?}",
            row.cells[0]
        );
        assert_eq!(
            row.cells[1],
            Err(EvalError::UnknownFunction("frobnicate".into()))
        );
        assert_eq!(
            row.cells[2],
            Err(EvalError::UnknownFunction("frobnicate".into()))
        );
        assert!(row.cells[3].is_ok());
    }
    assert_eq!(
        result.summaries[0].value,
        Err(EvalError::UnknownFunction("frobnicate".into()))
    );
    let base = parse_base("formulas:\n  bad: 'price +'\nviews:\n  - type: table\n    name: Reads\n    order: [formula.bad]\n  - type: table\n    name: Ignores\n    order: [file.name]\n").unwrap();
    assert!(compile_view(&base, Some("Reads")).is_ok());
    assert!(compile_view(&base, Some("Ignores")).is_ok());
}

#[test]
fn prefilters_come_only_from_the_top_level_conjunction() {
    let base = parse_base("filters:\n  and:\n    - file.inFolder(\"Books\")\n    - 'file.ext == \"md\" && status == \"done\"'\n    - or:\n        - file.hasTag(\"x\")\n        - file.hasTag(\"y\")\nviews:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\", \"novel\")'\n").unwrap();
    let compiled = compile_view(&base, None).unwrap();
    assert_eq!(
        compiled.prefilters(),
        &[
            Prefilter::InFolder("Books".into()),
            Prefilter::Ext("md".into()),
            Prefilter::PropertyEquals {
                key: "status".into(),
                value: ScalarLiteral::String("done".into())
            },
            Prefilter::HasTag(vec!["book".into(), "novel".into()]),
        ]
    );
    // A falsy literal is never a prefilter: `x == false` may hold for a note
    // that lacks `x` under some coercion, and a prefilter must be a superset.
    let base =
        parse_base("views:\n  - type: table\n    name: T\n    filters: 'done == false'\n").unwrap();
    assert!(compile_view(&base, None).unwrap().prefilters().is_empty());
}

#[test]
fn every_view_type_is_row_data_with_its_options_kept() {
    for kind in ["table", "cards", "list", "kanban", "map", "fileclass-table"] {
        let yaml = format!(
            "views:\n  - type: {kind}\n    name: V\n    filters: 'file.inFolder(\"Books\")'\n    image: cover\n"
        );
        let base = parse_base(&yaml).unwrap();
        let compiled = compile_view(&base, None).unwrap();
        assert_eq!(compiled.decl().kind, kind);
        assert_eq!(compiled.decl().options[0].0, "image");
        assert_eq!(run(&books(), &yaml, None).rows.len(), 3);
    }
}

#[test]
fn this_in_a_filter_is_the_embedding_note() {
    let source = books();
    let base = parse_base(
        "views:\n  - type: list\n    name: Backlinks\n    filters: 'file.hasLink(this.file)'\n",
    )
    .unwrap();
    let compiled = compile_view(&base, None).unwrap();
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let base_path = VaultPath::new("Books.base").unwrap();
    let this = VaultPath::new("Notes/Textbook.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &base_path, &this);
    let result = evaluate_view(&compiled, &ctx).unwrap();
    assert_eq!(paths(&result), vec!["Notes/Lecture.md"]);
    assert!(compiled.dependencies().reads_this);
    assert!(compiled.dependencies().reads_links);
}

#[test]
fn dependencies_name_what_the_staleness_rule_needs() {
    let base = parse_base(SYNTAX_PAGE_EXAMPLE).unwrap();
    let dependencies = compile_view(&base, None).unwrap().dependencies().clone();
    assert!(dependencies.reads_formulas);
    assert!(
        dependencies.reads_links,
        "file.hasLink in the global filter"
    );
    assert!(!dependencies.reads_backlinks);
}

/// The final review's M2: what a view reads of the clock, through filters,
/// formulas (transitively) and summaries.
#[test]
fn dependencies_name_what_the_view_reads_of_the_clock() {
    use vault_bases::view::ClockReads;
    let reads = |base: &str, view: &str| {
        compile_view(&parse_base(base).unwrap(), Some(view))
            .unwrap()
            .dependencies()
            .reads_clock
    };
    let base = "formulas:\n  d: 'today()'\n  n: 'now() - \"1d\"'\n  via: 'formula.d'\n  rel: 'file.mtime.relative()'\nviews:\n  - type: table\n    name: Plain\n    order: [file.name]\n  - type: table\n    name: Day\n    order: [formula.via]\n  - type: table\n    name: Both\n    order: [formula.d, formula.n]\n  - type: table\n    name: Rel\n    order: [formula.rel]\n  - type: table\n    name: Filter\n    filters: 'file.mtime > today()'\n";
    assert_eq!(reads(base, "Plain"), ClockReads::Never);
    assert_eq!(reads(base, "Day"), ClockReads::Day, "through a formula");
    assert_eq!(reads(base, "Both"), ClockReads::Instant);
    assert_eq!(reads(base, "Rel"), ClockReads::Instant);
    assert_eq!(reads(base, "Filter"), ClockReads::Day);
}

// ---------------------------------------------------------------------------
// Beyond the brief: prefilters seen from the row source, the stable sort on a
// view large enough for an unstable sort to differ, one erroring row, every
// built-in summary's value, the view-level open questions for Task 13, and
// the depth proofs.
// ---------------------------------------------------------------------------

fn table(filters: &str) -> String {
    format!(
        "views:\n  - type: table\n    name: T\n    filters: '{filter}'\n",
        filter = filters
    )
}

fn read_paths(source: &MemorySource) -> BTreeSet<String> {
    source
        .log()
        .rows_read
        .iter()
        .map(|path| path.as_str().to_string())
        .collect()
}

/// The prefilter is tested by what the row source was asked, not only by the
/// answer: the view asks for `Books/` and reads nothing outside it. A
/// mutation that drops prefilter extraction asks for every file and reads
/// `Notes/` and `Images/` too.
#[test]
fn a_prefilter_narrows_what_the_source_is_asked_for() {
    let source = books();
    let result = run(
        &source,
        &table(r#"file.inFolder("Books") && status == "done""#),
        None,
    );
    assert_eq!(paths(&result), vec!["Books/Emma.md"]);
    let log = source.log();
    assert_eq!(
        log.candidates,
        vec![vec![
            Prefilter::InFolder("Books".into()),
            Prefilter::PropertyEquals {
                key: "status".into(),
                value: ScalarLiteral::String("done".into())
            },
        ]]
    );
    // The source compares a scalar `status` of the literal's own kind, so
    // only the note whose status is "done" is read.
    assert_eq!(
        read_paths(&source),
        ["Books/Emma.md"].into_iter().map(String::from).collect()
    );

    let source = books();
    run(&source, &table(r#"file.ext == "png""#), None);
    assert_eq!(
        source.log().candidates,
        vec![vec![Prefilter::Ext("png".into())]]
    );
    assert_eq!(
        read_paths(&source),
        ["Images/cover.png"].into_iter().map(String::from).collect()
    );

    // Under `or`, nothing narrows: the source is asked for every file.
    let source = books();
    run(
        &source,
        "views:\n  - type: table\n    name: T\n    filters:\n      or:\n        - file.inFolder(\"Books\")\n        - file.hasTag(\"tag\")\n",
        None,
    );
    assert_eq!(source.log().candidates, vec![Vec::<Prefilter>::new()]);
    assert_eq!(read_paths(&source).len(), 7);
}

/// The Task 6 review's carry: `inFolder` trims a leading and a trailing `/`,
/// so its prefilter must too. `/Notes`, `Notes/` and `Notes` ask the source
/// for the same candidates and answer the same rows.
#[test]
fn a_folder_with_slashes_asks_for_the_same_candidates() {
    let mut answers = Vec::new();
    for folder in ["Notes", "/Notes", "Notes/", "/Notes/"] {
        let source = books();
        let result = run(
            &source,
            &table(&format!(r#"file.inFolder("{folder}")"#)),
            None,
        );
        let log = source.log();
        answers.push((
            log.candidates,
            read_paths(&source),
            paths(&result)
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>(),
        ));
    }
    assert_eq!(
        answers[0].0,
        vec![vec![Prefilter::InFolder("Notes".into())]]
    );
    assert_eq!(answers[0].2, vec!["Notes/Lecture.md", "Notes/Textbook.md"]);
    for answer in &answers[1..] {
        assert_eq!(answer, &answers[0]);
    }
}

fn many(count: usize) -> MemorySource {
    let mut source = MemorySource::new();
    for at in 0..count {
        // Keys repeat out of path order, so a sort that is not stable has
        // ties to reorder.
        let key = (at * 7) % 3;
        source = source.with(
            &format!("N/{at:03}.md"),
            MemoryFile::note()
                .property("key", number(key as f64))
                .property("other", number((at % 2) as f64)),
        );
    }
    source
}

/// Stable sort, pinned on a view large enough (96 rows, three keys) that an
/// unstable sort reorders ties: rows equal on every key keep path order,
/// both under `sort` and inside each `groupBy` group.
#[test]
fn equal_keys_keep_path_order_on_a_large_view() {
    let source = many(96);
    let check = |result: &ViewResult, key: &dyn Fn(&vault_bases::view::RowResult) -> Value| {
        assert_eq!(result.rows.len(), 96);
        for pair in result.rows.windows(2) {
            let (a, b) = (key(&pair[0]), key(&pair[1]));
            if a == b {
                assert!(
                    pair[0].path < pair[1].path,
                    "{} before {}",
                    pair[0].path.as_str(),
                    pair[1].path.as_str()
                );
            }
        }
    };
    let sorted = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [key]\n    sort:\n      - property: key\n        direction: DESC\n",
        None,
    );
    check(&sorted, &|row| row.cells[0].clone().unwrap());
    let keys: Vec<Value> = sorted
        .rows
        .iter()
        .map(|row| row.cells[0].clone().unwrap())
        .collect();
    assert_eq!(keys.first(), Some(&Value::Number(2.0)));
    assert_eq!(keys.last(), Some(&Value::Number(0.0)));

    let grouped = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [key]\n    groupBy:\n      property: key\n      direction: ASC\n",
        None,
    );
    check(&grouped, &|row| row.group.clone().unwrap().unwrap());
    assert_eq!(
        grouped.rows[0].group.clone().unwrap().unwrap(),
        Value::Number(0.0)
    );

    // Sorted by `other`, grouped by `key`: inside a group the `other` order
    // holds, and within equal `other` the path order.
    let both = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [key, other]\n    sort:\n      - property: other\n    groupBy:\n      property: key\n      direction: ASC\n",
        None,
    );
    check(&both, &|row| {
        Value::list(vec![
            row.cells[0].clone().unwrap(),
            row.cells[1].clone().unwrap(),
        ])
    });
    for pair in both.rows.windows(2) {
        if pair[0].cells[0] == pair[1].cells[0] {
            assert!(order_le(&pair[0].cells[1], &pair[1].cells[1]));
        }
    }
}

fn order_le(a: &vault_bases::view::Cell, b: &vault_bases::view::Cell) -> bool {
    vault_bases::eval::coerce::sort_order(a.as_ref().unwrap(), b.as_ref().unwrap()).is_le()
}

/// `limit:before_group` (captured, Task 13: the probe `limit_group` keeps
/// one row in each of its two groups): the limit keeps the first rows of the
/// sorted order, then the kept rows are grouped. Grouping first would keep
/// Emma and Lecture (age 1), which this answer does not hold.
#[test]
fn captured_limit_counts_sorted_rows_before_grouping() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\")'\n    order: [price]\n    sort:\n      - property: price\n        direction: DESC\n    limit: 2\n    groupBy:\n      property: age\n      direction: ASC\n";
    let result = run(&books(), yaml, None);
    // Sorted by price desc: Ulysses(30, age 3), Dune(10, age 2), Kafka, ...
    // Limit 2, then grouped by age ascending: Dune before Ulysses.
    assert_eq!(paths(&result), vec!["Books/Dune.md", "Books/Ulysses.md"]);
    assert_eq!(result.total_rows, 2);
    // The same rows grouped by age descending: the age-3 group first.
    let result = run(
        &books(),
        &yaml.replace("direction: ASC", "direction: DESC"),
        None,
    );
    assert_eq!(paths(&result), vec!["Books/Ulysses.md", "Books/Dune.md"]);
}

/// `sort:default` (captured, Task 13): with no `sort`, rows are in file
/// name order, whatever order the notes were added in and whatever folder
/// they are in.
#[test]
fn captured_without_a_sort_rows_are_in_name_order() {
    let source = MemorySource::new()
        .with("b.md", MemoryFile::note())
        .with("C.md", MemoryFile::note())
        .with("a.md", MemoryFile::note())
        .with("A/z.md", MemoryFile::note());
    let result = run(&source, "views:\n  - type: list\n    name: L\n", None);
    assert_eq!(paths(&result), vec!["a.md", "b.md", "C.md", "A/z.md"]);
}

/// `filter:error_row` (captured, Task 13: the probe `filter_error_row` shows
/// only the note whose `price > 2` holds): a statement that errors is unknown;
/// `and` with a false child is false, `or` with a true child is true, and an
/// unknown verdict excludes the row, at the top and inside `not`.
#[test]
fn captured_an_erroring_statement_is_unknown_and_excludes_the_row() {
    let source = MemorySource::new()
        .with(
            "priced.md",
            MemoryFile::note().property("price", number(5.0)),
        )
        .with("plain.md", MemoryFile::note());
    let view = |filters: &str| -> Vec<String> {
        let yaml = format!("views:\n  - type: table\n    name: T\n    filters:\n{filters}");
        paths(&run(&source, &yaml, None))
            .iter()
            .map(|p| p.to_string())
            .collect()
    };
    // `price > 1` is empty on plain.md (null compared with a number), which
    // a filter reads as false.
    assert_eq!(
        view("      and:\n        - 'price > 1'\n"),
        vec!["priced.md"]
    );
    assert_eq!(
        view("      or:\n        - 'price > 1'\n        - 'file.name == \"plain\"'\n"),
        vec!["plain.md", "priced.md"]
    );
    assert_eq!(
        view("      or:\n        - 'price > 1'\n        - 'false'\n"),
        vec!["priced.md"]
    );
    assert_eq!(
        view("      and:\n        - 'price > 1'\n        - 'false'\n"),
        Vec::<String>::new()
    );
    // A comparison with an empty side is empty (captured), and an empty
    // statement is false, so `not` admits plain.md.
    assert_eq!(
        view("      not:\n        - 'price > 9'\n"),
        vec!["plain.md", "priced.md"]
    );
    assert_eq!(
        view("      not:\n        - 'price > 9'\n        - 'true'\n"),
        Vec::<String>::new()
    );
}

/// A sort over mixed kinds is ruling R2's total order (2026-10-09; the
/// project picked a total order): booleans, then
/// numbers, then dates, then text, reversed for `DESC`, and an empty value
/// last in either direction (captured, `sort:empty_descending`). Obsidian's
/// own order differs where a boolean meets another kind (its comparator ties
/// `true` with every truthy value, `sort_mixed2`).
#[test]
fn a_mixed_type_sort_is_the_total_order_of_ruling_r2() {
    let source = MemorySource::new()
        .typed("x", PropertyType::Date)
        .with(
            "bool.md",
            MemoryFile::note().property("x", vault_core::PropertyValue::Boolean(true)),
        )
        .with(
            "date.md",
            MemoryFile::note().property("x", text("2025-01-01")),
        )
        .with("missing.md", MemoryFile::note())
        .with("number.md", MemoryFile::note().property("x", number(7.0)))
        .with(
            "string.md",
            MemoryFile::note().property("x", text("not a date")),
        );
    let result = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [x]\n    sort:\n      - property: x\n",
        None,
    );
    assert_eq!(
        paths(&result),
        vec!["bool.md", "number.md", "date.md", "string.md", "missing.md"]
    );
    let result = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [x]\n    sort:\n      - property: x\n        direction: DESC\n",
        None,
    );
    assert_eq!(
        paths(&result),
        vec!["string.md", "date.md", "number.md", "bool.md", "missing.md"]
    );
    // An error cell sorts with the missing values, last in either direction,
    // and the error rows keep name order among themselves.
    for direction in ["ASC", "DESC"] {
        let yaml = format!(
            "formulas:\n  k: 'if(x.isType(\"number\"), x, 1 + true)'\nviews:\n  - type: table\n    name: T\n    order: [formula.k]\n    sort:\n      - property: formula.k\n        direction: {direction}\n"
        );
        let result = run(&source, &yaml, None);
        assert_eq!(
            paths(&result),
            vec!["number.md", "bool.md", "date.md", "missing.md", "string.md"],
            "{direction}"
        );
        assert!(
            result.rows[1..].iter().all(|row| row.cells[0].is_err()),
            "{direction}"
        );
    }
}

/// `summary:stddev` (captured, Task 13: 2, 4, 4, 4, 5, 5, 7, 9 give 2): the population standard deviation
/// (divide by n). The sample deviation (n - 1) is a different number here.
#[test]
fn captured_stddev_is_the_population_deviation() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    summaries:\n      price: Stddev\n";
    let result = run(&books(), yaml, None);
    let prices = [10.0_f64, 3.0, 30.0];
    let mean = prices.iter().sum::<f64>() / 3.0;
    let squares: f64 = prices.iter().map(|x| (x - mean).powi(2)).sum();
    let Value::Number(stddev) = result.summaries[0].value.clone().unwrap() else {
        panic!("a number")
    };
    assert!((stddev - (squares / 3.0).sqrt()).abs() < 1e-12, "{stddev}");
    assert!((stddev - (squares / 2.0).sqrt()).abs() > 1.0);
}

/// A date with no time, as `date("…")` answers it.
fn date(text: &str) -> Value {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let path = VaultPath::new("a.md").unwrap();
    let source = MemorySource::new();
    let ctx = EvalContext::new(&source, &clock, &path, &path);
    let expr = parse_expression(&format!("date(\"{text}\")")).unwrap();
    vault_bases::eval::evaluate(&expr, &ctx, &vault_bases::eval::Scope::default()).unwrap()
}

/// Every built-in summary's value over one column of each kind it reads.
#[test]
fn every_builtin_summary_computes_its_value() {
    let source = MemorySource::new()
        .typed("due", PropertyType::Date)
        .with(
            "a.md",
            MemoryFile::note()
                .property("n", number(4.0))
                .property("due", text("2025-01-03"))
                .property("done", vault_core::PropertyValue::Boolean(true))
                .property("s", text("x")),
        )
        .with(
            "b.md",
            MemoryFile::note()
                .property("n", number(1.0))
                .property("due", text("2025-01-01"))
                .property("done", vault_core::PropertyValue::Boolean(false))
                .property("s", text("")),
        )
        .with(
            "c.md",
            MemoryFile::note()
                .property("n", number(4.0))
                .property("due", text("2025-01-02"))
                .property("done", vault_core::PropertyValue::Boolean(true))
                .property("s", text("x")),
        )
        .with(
            "d.md",
            MemoryFile::note()
                .property("n", number(7.0))
                .property("s", text("y")),
        )
        .with(
            "e.md",
            MemoryFile::note().property("n", text("not a number")),
        );
    let cases: [(&str, &str, Value); 17] = [
        // Captured (Task 13): the numbers' total over every row.
        ("n", "Average", Value::Number(16.0 / 5.0)),
        ("n", "Min", Value::Number(1.0)),
        ("n", "Max", Value::Number(7.0)),
        ("n", "Sum", Value::Number(16.0)),
        ("n", "Range", Value::Number(6.0)),
        ("n", "Median", Value::Number(4.0)),
        (
            "n",
            "Stddev",
            Value::Number(((0.0f64 + 9.0 + 0.0 + 9.0) / 4.0).sqrt()),
        ),
        (
            "due",
            "Range",
            Value::Duration(vault_bases::DurationValue {
                months: 0,
                ms: 2 * 86_400_000,
                timed: true,
            }),
        ),
        ("due", "Earliest", date("2025-01-01")),
        ("due", "Latest", date("2025-01-03")),
        ("done", "Checked", Value::Number(2.0)),
        ("done", "Unchecked", Value::Number(1.0)),
        ("s", "Empty", Value::Number(2.0)),
        ("s", "Filled", Value::Number(3.0)),
        ("s", "Unique", Value::Number(4.0)),
        ("missing", "Average", Value::Null),
        ("missing", "Sum", Value::Number(0.0)),
    ];
    for (property, name, expected) in cases {
        let yaml = format!(
            "views:\n  - type: table\n    name: T\n    summaries:\n      {property}: {name}\n"
        );
        let result = run(&source, &yaml, None);
        assert_eq!(
            result.summaries[0].value,
            Ok(expected),
            "{property}: {name}"
        );
    }
    // An even count takes the mean of the middle two.
    let even = run(
        &source,
        "views:\n  - type: table\n    name: T\n    filters: 'file.name == \"a\" || file.name == \"b\"'\n    summaries:\n      n: Median\n",
        None,
    );
    assert_eq!(even.summaries[0].value, Ok(Value::Number(2.5)));
    // A summary name that is neither built in nor declared is an error
    // summary; the view still answers its rows (captured, in the corpus).
    let unknown = run(
        &source,
        "views:\n  - type: table\n    name: T\n    summaries:\n      n: Mode\n",
        None,
    );
    assert_eq!(
        unknown.summaries[0].value,
        Err(EvalError::UnknownFunction("Mode".into()))
    );
}

/// `view:name_case` (**provisional**): a view is found by its exact name.
/// Whether Obsidian's `base:query` matches a name in another case is the
/// probe base's question.
#[test]
fn provisional_a_view_name_matches_exactly() {
    let base = parse_base("views:\n  - type: table\n    name: Table\n").unwrap();
    assert!(compile_view(&base, Some("Table")).is_ok());
    assert_eq!(
        compile_view(&base, Some("table")).unwrap_err(),
        CompileError::ViewNotFound {
            declared: vec!["Table".into()]
        }
    );
}

/// `expr:hyphenated_identifier` (**uncaptured** in the parser since Task 2):
/// in an expression `my-prop` is `my - prop`, so a filter must spell the
/// property `note["my-prop"]`; as an `order` key, `my-prop` is a name and
/// reads the property directly.
#[test]
fn provisional_a_hyphenated_name_is_subtraction_in_an_expression_and_a_name_as_a_key() {
    let source =
        MemorySource::new().with("a.md", MemoryFile::note().property("my-prop", number(1.0)));
    let subtraction = run(&source, &table("my-prop == 1"), None);
    assert!(
        subtraction.rows.is_empty(),
        "my - prop is null arithmetic, an error, so the row is excluded"
    );
    let indexed = run(
        &source,
        "views:\n  - type: table\n    name: T\n    filters: 'note[\"my-prop\"] == 1'\n    order: [my-prop, note.my-prop]\n",
        None,
    );
    assert_eq!(paths(&indexed), vec!["a.md"]);
    assert_eq!(cell(&indexed, 0, 0), Value::Number(1.0));
    assert_eq!(cell(&indexed, 0, 1), Value::Number(1.0));
}

/// A formula that errors on one row only: that row stays, with an error
/// cell in that column, and its other cells are values.
#[test]
fn a_formula_that_errors_on_one_row_keeps_the_row() {
    let yaml = "formulas:\n  per: 'price / (age - 1) + if(age == 1, true, 0)'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [file.name, formula.per]\n";
    let result = run(&books(), yaml, None);
    assert_eq!(
        paths(&result),
        vec!["Books/Dune.md", "Books/Emma.md", "Books/Ulysses.md"]
    );
    assert_eq!(cell(&result, 0, 1), Value::Number(10.0));
    assert!(matches!(result.rows[1].cells[1], Err(EvalError::Type(_))));
    assert_eq!(cell(&result, 1, 0), Value::String("Emma".into()));
    assert_eq!(cell(&result, 2, 1), Value::Number(15.0));
}

/// Formulas are evaluated once per row and formula, however many columns,
/// sort keys, filters and other formulas read them.
#[test]
fn a_formula_is_memoized_per_row() {
    // `random()` changes on every call; memoized, the two columns, the sort
    // key and the formula that reads it agree on each row.
    let yaml = "formulas:\n  r: 'random()'\n  r2: 'formula.r'\nviews:\n  - type: table\n    name: T\n    filters: 'formula.r >= 0'\n    order: [formula.r, formula.r2, formula.r]\n    sort:\n      - property: formula.r\n";
    let result = run(&books(), yaml, None);
    assert_eq!(result.rows.len(), 7);
    let mut previous = f64::NEG_INFINITY;
    for row in &result.rows {
        let value = row.cells[0].clone().unwrap();
        assert_eq!(row.cells[1].clone().unwrap(), value);
        assert_eq!(row.cells[2].clone().unwrap(), value);
        let Value::Number(number) = value else {
            panic!("a number")
        };
        assert!(number >= previous, "sorted by the memoized value");
        previous = number;
    }
}

#[test]
fn dependencies_see_backlinks_and_this_in_keys_and_summaries() {
    let base = parse_base("summaries:\n  s: 'values.length'\nviews:\n  - type: table\n    name: T\n    order: [file.backlinks]\n    summaries:\n      file.size: s\n").unwrap();
    let dependencies = compile_view(&base, None).unwrap().dependencies().clone();
    assert!(dependencies.reads_backlinks);
    assert!(!dependencies.reads_links);
    assert!(!dependencies.reads_formulas);
    let base = parse_base("formulas:\n  f: 'this.file.name'\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: formula.f\n").unwrap();
    let dependencies = compile_view(&base, None).unwrap().dependencies().clone();
    assert!(dependencies.reads_formulas);
    assert!(
        dependencies.reads_this,
        "through a formula the view sorts by"
    );
}

/// The deepest expression `open` × k, `inner`, `close` × k that parses.
fn deepest(open: &str, inner: &str, close: &str) -> String {
    let build = |levels: usize| format!("{}{inner}{}", open.repeat(levels), close.repeat(levels));
    let mut levels = 1;
    while parse_expression(&build(levels + 1)).is_ok() {
        levels += 1;
    }
    build(levels)
}

fn on_a_one_mebibyte_stack(run: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(run)
        .expect("a thread")
        .join()
        .expect("no stack overflow and no panic");
}

/// Every recursive path a view adds fits a 1 MiB stack in a debug build:
/// view filters at the expression cap (nested `filter` and `map` lambdas
/// included), a filter tree at its cap, and formula chains at and past the
/// depth budget.
#[test]
fn a_view_at_every_depth_cap_fits_a_one_mebibyte_stack() {
    on_a_one_mebibyte_stack(|| {
        let source = books();
        for (open, inner, close) in [
            ("[1].filter(", "true", ")"),
            ("[1].map(", "price", ")"),
            ("if(", "price", ")"),
            ("!", "price", ""),
            ("(", "price", ")"),
            ("[1].reduce(", "acc", ", 0)"),
        ] {
            let expr = deepest(open, inner, close);
            let yaml = format!(
                "formulas:\n  deep: '{expr}'\nviews:\n  - type: table\n    name: T\n    filters: '{expr}'\n    order: [formula.deep]\n    sort:\n      - property: formula.deep\n"
            );
            let result = run(&source, &yaml, None);
            assert!(result.rows.len() <= 7, "{open}");
        }

        // A filter tree at the cap compiles and evaluates; one level more is
        // refused at compile time.
        let tree = |levels: usize| {
            format!(
                "filters: {}'file.hasTag(\"book\")'{}\nviews:\n  - type: table\n    name: T\n",
                "{and: [".repeat(levels - 1),
                "]}".repeat(levels - 1)
            )
        };
        assert_eq!(run(&source, &tree(MAX_DEPTH), None).rows.len(), 5);
        assert!(matches!(
            compile_view(&parse_base(&tree(MAX_DEPTH + 1)).unwrap(), None).unwrap_err(),
            CompileError::ExpressionInvalid { message, .. } if message.contains("nested too deeply")
        ));

        // A formula chain: f0 = 1, f{n} = formula.f{n-1} + 1. Each link is
        // three levels and f0 one; the budget is MAX_DEPTH levels.
        let chain = |links: usize| {
            let mut yaml = String::from("formulas:\n  f0: '1'\n");
            for at in 1..=links {
                yaml.push_str(&format!("  f{at}: 'formula.f{} + 1'\n", at - 1));
            }
            yaml.push_str(&format!("views:\n  - type: table\n    name: T\n    filters: 'file.name == \"Dune\"'\n    order: [formula.f{links}]\n"));
            yaml
        };
        // 3 per link and 1 for f0: 21 links fit in 64, 22 do not.
        let fits = run(&source, &chain(21), None);
        assert_eq!(cell(&fits, 0, 0), Value::Number(22.0));
        let past = run(&source, &chain(22), None);
        assert_eq!(
            past.rows[0].cells[0],
            Err(EvalError::FormulaTooDeep { max: MAX_DEPTH })
        );
        // A thousand links, or a cycle, is an error cell, never an overflow.
        let long = run(&source, &chain(1000), None);
        assert_eq!(
            long.rows[0].cells[0],
            Err(EvalError::FormulaTooDeep { max: MAX_DEPTH })
        );

        // A deep filter reading a deep formula shares one budget: the
        // statement errors (so the row is excluded) instead of nesting two
        // capped trees.
        let deep = deepest("[1].map(", "formula.d", ")");
        let shallow_formula = deepest("[1].map(", "price", ")");
        let yaml = format!(
            "formulas:\n  d: '{shallow_formula}'\nviews:\n  - type: table\n    name: T\n    filters: '{deep}'\n"
        );
        assert!(run(&source, &yaml, None).rows.is_empty());

        // The thinnest links, `formula.prev` (two levels each, so the most
        // formula calls per budget), and links through a lambda.
        for link in [
            "formula.h{prev}",
            "[1].map(formula.h{prev})",
            "if(true, formula.h{prev})",
        ] {
            let mut yaml = String::from("formulas:\n  h0: '1'\n");
            for at in 1..200 {
                yaml.push_str(&format!(
                    "  h{at}: '{}'\n",
                    link.replace("{prev}", &(at - 1).to_string())
                ));
            }
            for at in [10, 20, 31, 32, 63, 199] {
                let view = format!(
                    "{yaml}views:\n  - type: table\n    name: T\n    order: [formula.h{at}]\n"
                );
                let result = run(&source, &view, None);
                let cell = &result.rows[0].cells[0];
                assert!(
                    cell.is_ok() || *cell == Err(EvalError::FormulaTooDeep { max: MAX_DEPTH }),
                    "{link} {at}: {cell:?}"
                );
            }
        }

        // Formulas whose every link is a tall tree of lambdas.
        let mut yaml = String::from("formulas:\n  g0: '1'\n");
        for at in 1..40 {
            let body = format!(
                "{}formula.g{}{}",
                "[1].map(".repeat(20),
                at - 1,
                ")".repeat(20)
            );
            yaml.push_str(&format!("  g{at}: '{body}'\n"));
        }
        yaml.push_str("views:\n  - type: table\n    name: T\n    order: [formula.g39]\n");
        let result = run(&source, &yaml, None);
        assert_eq!(
            result.rows[0].cells[0],
            Err(EvalError::FormulaTooDeep { max: MAX_DEPTH })
        );
    });
}

// ---------------------------------------------------------------------------
// Fix round 1: the view fixture rows, a sound PropertyEquals prefilter, and
// one test for each mutation the review found surviving.
// ---------------------------------------------------------------------------

/// The vault every `view.jsonl` row runs against.
fn view_vault() -> MemorySource {
    let list = |items: &[&str]| {
        vault_core::PropertyValue::Sequence(
            items
                .iter()
                .map(|item| vault_bases::no_span(text(item)))
                .collect(),
        )
    };
    MemorySource::new()
        .with(
            "a.md",
            MemoryFile::note()
                .tag("book")
                .property("list", list(&["x"]))
                .property("status", text("p")),
        )
        .with(
            "b.md",
            MemoryFile::note()
                .tag("Book/fiction")
                .property("list", list(&["x"])),
        )
        .with(
            "c.md",
            MemoryFile::note()
                .tag("other")
                .property("list", list(&["x", "y"])),
        )
        .with("d.md", MemoryFile::note())
}

/// `tests/fixtures/captures/view.jsonl`: one view per row over
/// [`view_vault`], with the rows it answers (in order), their group keys,
/// or one summary's text. `provisional` rows are this crate's reading of a
/// question no published page settles; `uncaptured` rows are an answer
/// given only so the view has one, flagged for Task 13's probe base to
/// replace. Both are checked here like published rows.
#[test]
fn the_view_family_holds() {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/captures/view.jsonl");
    let mut failures = Vec::new();
    for line in std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let row: serde_json::Value = serde_json::from_str(line).unwrap();
        let case = row["case"].as_str().unwrap();
        let source = view_vault();
        let base = parse_base(row["base"].as_str().unwrap()).unwrap();
        let compiled = compile_view(&base, None).unwrap();
        let base_path = VaultPath::new("View.base").unwrap();
        let ctx = EvalContext::new(&source, &clock, &base_path, &base_path);
        let result = evaluate_view(&compiled, &ctx).unwrap();
        let unfiltered = evaluate_view(&compiled.without_prefilters(), &ctx).unwrap();
        if paths(&result) != paths(&unfiltered) {
            failures.push(format!("{case}: the prefilters changed the rows"));
        }
        if let Some(expected) = row.get("rows") {
            let expected: Vec<&str> = expected
                .as_array()
                .unwrap()
                .iter()
                .map(|path| path.as_str().unwrap())
                .collect();
            if paths(&result) != expected {
                failures.push(format!(
                    "{case}: rows {:?}, expected {expected:?}",
                    paths(&result)
                ));
            }
        }
        if let Some(expected) = row.get("groups") {
            let expected: Vec<&str> = expected
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap())
                .collect();
            let groups: Vec<String> = result
                .rows
                .iter()
                .map(|row| render_text(&row.group.clone().unwrap().unwrap(), &clock))
                .collect();
            if groups != expected {
                failures.push(format!("{case}: groups {groups:?}, expected {expected:?}"));
            }
        }
        if let Some(expected) = row.get("summary") {
            let property = expected["property"].as_str().unwrap();
            let summary = result
                .summaries
                .iter()
                .find(|summary| summary.property == property)
                .unwrap();
            let text = render_text(summary.value.as_ref().unwrap(), &clock);
            if text != expected["text"].as_str().unwrap() {
                failures.push(format!(
                    "{case}: summary {text:?}, expected {}",
                    expected["text"]
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// `summary:sum_empty`: `Sum` over no numbers is `0`, never `-0` (the wire
/// would write `-0.0`; the row's text cannot see the sign).
#[test]
fn provisional_sum_over_no_numbers_is_positive_zero() {
    let result = run(
        &view_vault(),
        "views:\n  - type: table\n    name: T\n    summaries:\n      missing: Sum\n",
        None,
    );
    let Ok(Value::Number(sum)) = result.summaries[0].value else {
        panic!("a number")
    };
    assert_eq!(sum, 0.0);
    assert!(sum.is_sign_positive(), "{sum:?}");
}

/// `summary:unique` (captured, Task 13: `[x]`, `[x]`, `[x, y]` and an empty
/// cell count 3): equal lists are one value, every empty cell is one
/// `null`, and numbers compare as SameValueZero.
#[test]
fn captured_unique_counts_equal_values_once() {
    let result = run(
        &view_vault(),
        "views:\n  - type: table\n    name: T\n    summaries:\n      list: Unique\n      missing: Unique\n",
        None,
    );
    assert_eq!(
        result.summaries[0].value,
        Ok(Value::Number(3.0)),
        "[x], [x], [x, y], null"
    );
    assert_eq!(
        result.summaries[1].value,
        Ok(Value::Number(1.0)),
        "four empty cells are one null"
    );
    let yaml = "formulas:\n  z: 'if(file.name == \"a\", -0, if(file.name == \"b\", 0, \"0\"))'\nviews:\n  - type: table\n    name: T\n    summaries:\n      formula.z: Unique\n";
    let result = run(&view_vault(), yaml, None);
    assert_eq!(
        result.summaries[0].value,
        Ok(Value::Number(2.0)),
        "-0 and 0 are one value; the string \"0\" is another"
    );
}

/// `filter:empty_or`, `filter:empty_and`, `group:list`, `sort:empty_descending`
/// as named tests beside their rows.
#[test]
fn captured_empty_groups_list_groups_and_empty_values_descending() {
    let source = view_vault();
    assert_eq!(
        run(
            &source,
            "views:\n  - type: table\n    name: T\n    filters:\n      or: []\n",
            None
        )
        .rows
        .len(),
        4,
        "an empty `or` constrains nothing"
    );
    assert_eq!(
        run(
            &source,
            "views:\n  - type: table\n    name: T\n    filters:\n      and: []\n",
            None
        )
        .rows
        .len(),
        4
    );
    assert_eq!(
        run(
            &source,
            "views:\n  - type: table\n    name: T\n    filters:\n      not: []\n",
            None
        )
        .rows
        .len(),
        4
    );
    let grouped = run(
        &source,
        "views:\n  - type: table\n    name: T\n    groupBy:\n      property: list\n      direction: ASC\n",
        None,
    );
    let keys: Vec<Value> = grouped
        .rows
        .iter()
        .map(|row| row.group.clone().unwrap().unwrap())
        .collect();
    assert_eq!(keys[0], keys[1], "two [x] lists are one group");
    assert_ne!(keys[1], keys[2], "[x, y] is its own group, not also in [x]");
    assert_eq!(
        keys[3],
        Value::Null,
        "a missing property is the null group, last"
    );
    let sorted = run(
        &source,
        "views:\n  - type: table\n    name: T\n    order: [status]\n    sort:\n      - property: status\n        direction: DESC\n",
        None,
    );
    assert_eq!(paths(&sorted), vec!["a.md", "b.md", "c.md", "d.md"]);
}

/// `prefilter:has_tag_spelling`: a `#`, the case and a nested tag do not
/// change what `hasTag` and its prefilter admit.
#[test]
fn provisional_has_tag_ignores_the_hash_and_the_case() {
    let source = view_vault();
    let result = run(&source, &table(r##"file.hasTag("#BOOK")"##), None);
    assert_eq!(paths(&result), vec!["a.md", "b.md"]);
    assert_eq!(
        source.log().candidates,
        vec![vec![Prefilter::HasTag(vec!["#BOOK".into()])]]
    );
}

/// The review's M1: a `status == "p"` prefilter must not skip a note whose
/// `status` is a list or a mapping (or a scalar of another kind), whatever
/// `==` answers for it today. The source must be asked about those notes.
#[test]
fn a_property_prefilter_never_skips_a_list_or_mapping_value() {
    let list = vault_core::PropertyValue::Sequence(vec![vault_bases::no_span(text("p"))]);
    let mapping = vault_core::PropertyValue::Mapping(vec![(
        vault_bases::no_span("k".to_string()),
        vault_bases::no_span(text("p")),
    )]);
    let source = MemorySource::new()
        .with("list.md", MemoryFile::note().property("status", list))
        .with("mapping.md", MemoryFile::note().property("status", mapping))
        .with("match.md", MemoryFile::note().property("status", text("p")))
        .with(
            "null.md",
            MemoryFile::note().property("status", vault_core::PropertyValue::Null),
        )
        .with(
            "number.md",
            MemoryFile::note().property("status", number(1.0)),
        )
        .with("other.md", MemoryFile::note().property("status", text("q")))
        .with("plain.md", MemoryFile::note());
    let base = parse_base(&table(r#"status == "p""#)).unwrap();
    let compiled = compile_view(&base, None).unwrap();
    assert_eq!(
        compiled.prefilters(),
        &[Prefilter::PropertyEquals {
            key: "status".into(),
            value: ScalarLiteral::String("p".into())
        }]
    );
    let with = paths(&run(&source, &table(r#"status == "p""#), None))
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        read_paths(&source),
        ["list.md", "mapping.md", "match.md", "number.md"]
            .into_iter()
            .map(String::from)
            .collect(),
        "every non-scalar and every other-kind scalar is asked about; null, a missing key and a differing string are not"
    );
    source.clear_log();
    let without = ctx_paths(&source, &compiled.without_prefilters());
    assert_eq!(with, without);
    // Captured (Task 13): a one-item list equals that item's text, so
    // `[p] == "p"` holds.
    assert_eq!(with, vec!["list.md", "match.md"]);
}

fn ctx_paths(source: &MemorySource, compiled: &vault_bases::view::CompiledView) -> Vec<String> {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let base_path = VaultPath::new("Books.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base_path, &base_path);
    evaluate_view(compiled, &ctx)
        .unwrap()
        .rows
        .iter()
        .map(|row| row.path.as_str().to_string())
        .collect()
}

/// The final review's H1 over the memory source: an untyped date text in
/// another spelling, and a `tags`-typed value read with its `#`, are kept by
/// the filter, so the `PropertyEquals` prefilter must admit them.
#[test]
fn a_property_prefilter_admits_what_coercion_makes_equal() {
    let dated = MemorySource::new()
        .with(
            "A.md",
            MemoryFile::note().property("due", text("2026-10-01T00:00")),
        )
        .with(
            "B.md",
            MemoryFile::note().property("due", text("2026-10-02")),
        );
    let compiled =
        compile_view(&parse_base(&table(r#"due == "2026-10-01""#)).unwrap(), None).unwrap();
    assert!(!compiled.prefilters().is_empty());
    assert_eq!(ctx_paths(&dated, &compiled.without_prefilters()), ["A.md"]);
    assert_eq!(ctx_paths(&dated, &compiled), ["A.md"]);

    let tagged = MemorySource::new()
        .typed("tags", PropertyType::Tags)
        .with("A.md", MemoryFile::note().property("tags", text("alpha")))
        .with("B.md", MemoryFile::note().property("tags", text("beta")));
    let compiled =
        compile_view(&parse_base(&table(r##"tags == "#alpha""##)).unwrap(), None).unwrap();
    assert!(!compiled.prefilters().is_empty());
    assert_eq!(ctx_paths(&tagged, &compiled.without_prefilters()), ["A.md"]);
    assert_eq!(ctx_paths(&tagged, &compiled), ["A.md"]);
}

/// The review's R4: a negated statement lifts no prefilter.
#[test]
fn a_negated_statement_lifts_no_prefilter() {
    for filter in [
        r#"!file.inFolder("Books")"#,
        r#"!(status == "done")"#,
        r#"!file.hasTag("book")"#,
        r#"!(file.ext == "md")"#,
    ] {
        let base = parse_base(&table(filter)).unwrap();
        assert!(
            compile_view(&base, None).unwrap().prefilters().is_empty(),
            "{filter}"
        );
    }
    let result = run(&books(), &table(r#"!file.inFolder("Books")"#), None);
    assert_eq!(
        paths(&result),
        vec![
            "Images/cover.png",
            "Required Reading/Kafka.md",
            "Notes/Lecture.md",
            "Notes/Textbook.md"
        ]
    );
}

/// The review's R11: only `file.ext` is the row's extension. `this.file.ext`
/// is the base's, the same for every row, and lifts no prefilter.
#[test]
fn an_ext_prefilter_comes_only_from_the_rows_file() {
    for filter in [
        r#"this.file.ext == "base""#,
        r#"note.file.ext == "md""#,
        r#"x.ext == "md""#,
    ] {
        let base = parse_base(&table(filter)).unwrap();
        assert!(
            compile_view(&base, None).unwrap().prefilters().is_empty(),
            "{filter}"
        );
    }
    let result = run(&books(), &table(r#"this.file.ext == "base""#), None);
    assert_eq!(result.rows.len(), 7, "the attachment too");
}

/// The review's R6: summaries read only the rows left after `limit`.
#[test]
fn summaries_read_only_the_rows_left_after_the_limit() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [price]\n    sort:\n      - property: price\n        direction: DESC\n    limit: 2\n    summaries:\n      price: Sum\n      status: Filled\n";
    let result = run(&books(), yaml, None);
    assert_eq!(paths(&result), vec!["Books/Ulysses.md", "Books/Dune.md"]);
    assert_eq!(result.summaries[0].value, Ok(Value::Number(40.0)));
    assert_eq!(result.summaries[1].value, Ok(Value::Number(2.0)));
}

/// The review's R7: the formula depth budget is restored after each
/// formula, so a long table reading formulas never runs out of it. No
/// filter reads the formulas: a filter statement resets the budget around
/// itself, which would hide a leak from the column and sort reads.
#[test]
fn the_formula_depth_is_restored_after_each_formula() {
    let yaml = "formulas:\n  inner: 'key + 1'\n  outer: 'formula.inner + formula.inner'\nviews:\n  - type: table\n    name: T\n    order: [formula.inner, formula.outer]\n    sort:\n      - property: formula.outer\n";
    let result = run(&many(200), yaml, None);
    assert_eq!(result.rows.len(), 200);
    for row in &result.rows {
        assert!(
            row.cells.iter().all(Result::is_ok),
            "{}: {:?}",
            row.path.as_str(),
            row.cells
        );
    }
}
