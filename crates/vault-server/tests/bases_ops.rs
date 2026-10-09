mod daemon;

use std::collections::BTreeSet;

use tempfile::TempDir;
use vault_protocol::{CellDto, ErrorCode, Response, ResponseOutcome};

use daemon::Daemon;

/// The in-repo scratch root (`target/tmp`), from this crate's manifest
/// directory rather than `TMPDIR` — the socket harness's `tmp_root` rule.
fn scratch() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

const BASE: &str = "formulas:\n  double: 'price * 2'\n  bad: 'price +'\nproperties:\n  note.price:\n    displayName: Price\nsummaries:\n  top: 'values.reduce(if(acc == null || value > acc, value, acc), null)'\nviews:\n  - type: table\n    name: Table\n    filters: 'file.inFolder(\"Books\")'\n    order: [file.name, price, formula.double]\n    sort:\n      - property: price\n        direction: DESC\n    summaries:\n      price: top\n  - type: cards\n    name: Cards\n    image: cover\n  - type: table\n    name: Bad\n    filters: 'price +'\n  - type: table\n    name: Odd\n    filters: 'frobnicate(price)'\n";

fn vault() -> (TempDir, TempDir) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    std::fs::create_dir_all(vault.path().join("Books")).unwrap();
    for (name, price) in [("A", 3), ("B", 30), ("C", 10)] {
        std::fs::write(
            vault.path().join(format!("Books/{name}.md")),
            format!("---\nprice: {price}\n---\n"),
        )
        .unwrap();
    }
    std::fs::write(vault.path().join("Views.base"), BASE).unwrap();
    std::fs::write(vault.path().join("Broken.base"), "views: [\n").unwrap();
    std::fs::write(vault.path().join("Home.md"), "![[Views.base#Table]]\n").unwrap();
    (vault, index)
}

/// A scratch vault holding exactly `files`.
fn vault_of(files: &[(&str, &str)]) -> (TempDir, TempDir) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    for (path, body) in files {
        let full = vault.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, body).unwrap();
    }
    (vault, index)
}

fn started(vault: &TempDir, index: &TempDir) -> Daemon {
    let mut daemon = Daemon::for_vault(vault, index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon
}

fn ok(daemon: &mut Daemon, line: &str) -> Response {
    match daemon.call(line).outcome {
        ResponseOutcome::Ok(response) => response,
        ResponseOutcome::Err(error) => panic!("{line}: {error:?}"),
    }
}

fn err(daemon: &mut Daemon, line: &str) -> vault_protocol::ProtocolError {
    match daemon.call(line).outcome {
        ResponseOutcome::Err(error) => error,
        ResponseOutcome::Ok(response) => panic!("{line}: expected an error, got {response:?}"),
    }
}

fn evaluate(params: &str) -> String {
    format!(r#"{{"version":1,"id":"e","request":{{"method":"evaluate_base","params":{params}}}}}"#)
}

fn answer(daemon: &mut Daemon, params: &str) -> vault_protocol::EvaluateBaseResponse {
    match ok(daemon, &evaluate(params)) {
        Response::EvaluateBase(answer) => answer,
        other => panic!("{params}: an evaluate_base answer, got {other:?}"),
    }
}

fn paths(answer: &vault_protocol::EvaluateBaseResponse) -> Vec<&str> {
    answer.rows.iter().map(|row| row.path.as_str()).collect()
}

#[test]
fn evaluate_base_answers_rows_columns_summaries_and_typed_cells() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Views.base"}"#);
    assert_eq!(answer.view.kind, "table");
    assert_eq!(answer.view.name, "Table", "absent view means the first");
    let columns: Vec<(&str, Option<&str>)> = answer
        .columns
        .iter()
        .map(|c| (c.property.as_str(), c.display_name.as_deref()))
        .collect();
    assert_eq!(
        columns,
        vec![
            ("file.name", None),
            ("price", Some("Price")),
            ("formula.double", None)
        ]
    );
    assert_eq!(
        paths(&answer),
        vec!["Books/B.md", "Books/C.md", "Books/A.md"]
    );
    assert_eq!(answer.rows[0].kind, vault_protocol::RowKindDto::Note);
    assert_eq!(answer.rows[0].group, None);
    assert_eq!(
        answer.rows[0].cells[0],
        CellDto::String { value: "B".into() }
    );
    assert_eq!(
        answer.rows[0].cells[2],
        CellDto::Number {
            value: serde_json::Number::from(60)
        }
    );
    assert_eq!(answer.total_rows, 3);
    assert!(answer.next_cursor.is_none());
    assert_eq!(answer.summaries.len(), 1);
    assert_eq!(
        answer.summaries["price"],
        CellDto::Number {
            value: serde_json::Number::from(30)
        }
    );

    let cards = self::answer(&mut daemon, r#"{"path":"Views.base","view":"Cards"}"#);
    assert_eq!(
        cards.view.options,
        vec![vault_protocol::OptionEntryDto {
            key: "image".into(),
            value: vault_protocol::PropertyValueDto::String("cover".into()),
        }]
    );
}

/// View options and column settings keep their declared order (and a key
/// order no hash or sorted map would keep), as the property DTO does.
#[test]
fn options_and_settings_keep_declared_order() {
    let (vault, index) = vault_of(&[
        ("A.md", "---\nprice: 1\n---\n"),
        (
            "Order.base",
            "properties:\n  note.price:\n    displayName: Price\n    zeta: 1\n    beta: 2\n    omega: 3\n    alpha: 4\n    kappa: 5\nviews:\n  - type: cards\n    name: Cards\n    order: [price]\n    zulu: 1\n    bravo: 2\n    yankee: 3\n    alpha: 4\n    mike: 5\n",
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Order.base"}"#);
    let keys = |entries: &[vault_protocol::OptionEntryDto]| -> Vec<String> {
        entries.iter().map(|entry| entry.key.clone()).collect()
    };
    assert_eq!(
        keys(&answer.view.options),
        vec!["zulu", "bravo", "yankee", "alpha", "mike"]
    );
    assert_eq!(answer.columns[0].display_name.as_deref(), Some("Price"));
    assert_eq!(
        keys(&answer.columns[0].settings),
        vec!["zeta", "beta", "omega", "alpha", "kappa"]
    );
    assert_eq!(
        answer.view.options[0].value,
        vault_protocol::PropertyValueDto::Integer(1)
    );
}

/// An object cell keeps its entries in the order the value holds them.
#[test]
fn an_object_cell_keeps_its_entry_order() {
    let (vault, index) = vault_of(&[
        (
            "A.md",
            "---\nm:\n  e: 1\n  b: 2\n  d: 3\n  a: 4\n  c: 5\n---\n",
        ),
        (
            "Obj.base",
            "views:\n  - type: table\n    name: T\n    order: [m]\n",
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Obj.base"}"#);
    let CellDto::Object { value } = &answer.rows[0].cells[0] else {
        panic!("an object cell: {:?}", answer.rows[0].cells[0]);
    };
    let keys: Vec<&str> = value.iter().map(|entry| entry.key.as_str()).collect();
    assert_eq!(keys, vec!["e", "b", "d", "a", "c"]);
    assert_eq!(
        value[0].value,
        CellDto::Number {
            value: serde_json::Number::from(1)
        }
    );
}

/// All three non-finite numbers travel as `string` cells holding
/// JavaScript's text. Provisional until the Task 13 capture.
#[test]
fn non_finite_numbers_are_javascript_text() {
    let (vault, index) = vault_of(&[
        ("A.md", "---\nbig: .inf\nsmall: -.inf\nodd: .nan\n---\n"),
        (
            "Num.base",
            "views:\n  - type: table\n    name: T\n    order: [big, small, odd]\n",
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Num.base"}"#);
    let text = |value: &str| CellDto::String {
        value: value.into(),
    };
    assert_eq!(
        answer.rows[0].cells,
        vec![text("Infinity"), text("-Infinity"), text("NaN")]
    );
}

/// A cursor names its base: replayed on another base with the same view
/// argument and `this_path`, it is refused.
#[test]
fn a_cursor_belongs_to_its_base() {
    use base64::Engine as _;
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let content = base64::engine::general_purpose::STANDARD.encode(BASE);
    ok(
        &mut daemon,
        &format!(
            r#"{{"version":1,"id":"w","request":{{"method":"write_file","params":{{"path":"Other.base","content_base64":"{content}","expected":{{"absent":true}}}}}}}}"#
        ),
    );
    let first = answer(&mut daemon, r#"{"path":"Views.base","limit":2}"#);
    let cursor = first.next_cursor.expect("a next page");
    let other = answer(&mut daemon, r#"{"path":"Other.base","limit":2}"#);
    assert_eq!(other.total_rows, 3, "the other base evaluates on its own");
    let error = err(
        &mut daemon,
        &evaluate(&format!(
            r#"{{"path":"Other.base","limit":2,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(error.code, ErrorCode::InvalidCursor, "{error:?}");
}

#[test]
fn pages_follow_the_cursor_and_a_stale_cursor_is_generation_mismatch() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let first = answer(&mut daemon, r#"{"path":"Views.base","limit":2}"#);
    assert_eq!(first.rows.len(), 2);
    assert_eq!(first.total_rows, 3);
    let cursor = first.next_cursor.clone().expect("a next page");
    let second = answer(
        &mut daemon,
        &format!(r#"{{"path":"Views.base","limit":2,"cursor":"{cursor}"}}"#),
    );
    assert_eq!(second.rows.len(), 1);
    assert_eq!(second.rows[0].path, "Books/A.md");
    assert_eq!(second.generation, first.generation);

    ok(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Books/D.md","content":"---\nprice: 1\n---\n","expected":{"absent":true}}}}"#,
    );
    let error = err(
        &mut daemon,
        &evaluate(&format!(
            r#"{{"path":"Views.base","limit":2,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(error.code, ErrorCode::GenerationMismatch);
    assert_eq!(error.current_generation, Some(first.generation + 1));

    let error = err(
        &mut daemon,
        &evaluate(&format!(
            r#"{{"path":"Views.base","view":"Cards","limit":2,"cursor":"{cursor}"}}"#
        )),
    );
    assert_eq!(
        error.code,
        ErrorCode::InvalidCursor,
        "a cursor belongs to one view"
    );
    let error = err(
        &mut daemon,
        &evaluate(r#"{"path":"Views.base","cursor":"not a cursor"}"#),
    );
    assert_eq!(error.code, ErrorCode::InvalidCursor);
}

#[test]
fn paging_walks_every_row_exactly_once() {
    let mut files: Vec<(String, String)> = (0..23)
        .map(|n| (format!("N/{n:02}.md"), format!("---\nn: {n}\n---\n")))
        .collect();
    files.push((
        "All.base".into(),
        "views:\n  - type: table\n    name: All\n    filters: 'file.inFolder(\"N\")'\n    order: [n]\n    sort:\n      - property: n\n        direction: DESC\n".into(),
    ));
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, body)| (path.as_str(), body.as_str()))
        .collect();
    let (vault, index) = vault_of(&borrowed);
    let mut daemon = started(&vault, &index);
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        // A pager that never ends fails here rather than running into the
        // suite's timeout: 23 rows cannot take more than 24 pages.
        assert!(pages <= 23, "the pager did not end after {pages} pages");
        let params = match &cursor {
            None => r#"{"path":"All.base","limit":5}"#.to_string(),
            Some(cursor) => format!(r#"{{"path":"All.base","limit":5,"cursor":"{cursor}"}}"#),
        };
        let page = answer(&mut daemon, &params);
        assert_eq!(page.total_rows, 23);
        assert!(page.rows.len() <= 5);
        seen.extend(page.rows.iter().map(|row| row.path.clone()));
        pages += 1;
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(pages, 5);
    let expected: Vec<String> = (0..23).rev().map(|n| format!("N/{n:02}.md")).collect();
    assert_eq!(seen, expected, "every row once, in the view's order");
    assert_eq!(seen.iter().collect::<BTreeSet<_>>().len(), 23);
}

#[test]
fn this_path_changes_the_rows_of_a_view_that_reads_this() {
    let (vault, index) = vault_of(&[
        ("Hub.md", "# Hub\n"),
        ("Other.md", "# Other\n"),
        ("A.md", "[[Hub]]\n"),
        ("B.md", "[[Other]]\n"),
        (
            "Back.base",
            "views:\n  - type: list\n    name: Back\n    filters: 'file.hasLink(this.file)'\n",
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let hub = answer(&mut daemon, r#"{"path":"Back.base","this_path":"Hub.md"}"#);
    assert_eq!(paths(&hub), vec!["A.md"]);
    let other = answer(
        &mut daemon,
        r#"{"path":"Back.base","this_path":"Other.md"}"#,
    );
    assert_eq!(paths(&other), vec!["B.md"]);
    let none = answer(&mut daemon, r#"{"path":"Back.base"}"#);
    assert!(none.rows.is_empty(), "absent, `this` is the base itself");
    let cursor_mix = err(
        &mut daemon,
        &evaluate(
            r#"{"path":"Back.base","this_path":"Other.md","cursor":"eyJnZW5lcmF0aW9uIjoxLCJiYXNlIjoiQmFjay5iYXNlIiwidmlldyI6bnVsbCwidGhpc19wYXRoIjoiSHViLm1kIiwib2Zmc2V0IjowfQ"}"#,
        ),
    );
    assert_eq!(
        cursor_mix.code,
        ErrorCode::InvalidCursor,
        "a cursor belongs to one this_path"
    );
}

/// Ruling R1 (2026-10-09; the project picked
/// Obsidian's behaviour): a formula that does not parse, or names an unknown
/// function, answers the view with an error cell in its column in every row;
/// only a filter that does not compile refuses the request
/// (`every_error_code_has_a_cause`).
#[test]
fn a_broken_formula_answers_the_view_with_error_cells() {
    let (vault, index) = vault_of(&[
        ("A.md", "---\nprice: 1\n---\n"),
        ("B.md", "---\nprice: 2\n---\n"),
        (
            "Cells.base",
            "formulas:\n  bad: 'price +'\n  odd: 'frobnicate(price)'\nviews:\n  - type: table\n    name: T\n    filters: 'price > 0'\n    order: [file.name, formula.bad, formula.odd]\n",
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Cells.base"}"#);
    assert_eq!(paths(&answer), vec!["A.md", "B.md"]);
    for row in &answer.rows {
        assert_eq!(
            row.cells[0].clone(),
            CellDto::String {
                value: row.path.trim_end_matches(".md").into()
            }
        );
        match (&row.cells[1], &row.cells[2]) {
            (CellDto::Error { message: bad }, CellDto::Error { message: odd }) => {
                assert!(bad.contains("does not parse"), "{bad}");
                assert!(odd.contains("frobnicate"), "{odd}");
            }
            other => panic!("expected two error cells, got {other:?}"),
        }
    }
}

#[test]
fn every_error_code_has_a_cause() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    for (params, code, needle) in [
        (r#"{"path":"Broken.base"}"#, ErrorCode::BaseInvalid, "parse"),
        (
            r#"{"path":"Views.base","view":"Nope"}"#,
            ErrorCode::ViewNotFound,
            "Table, Cards, Bad, Odd",
        ),
        (
            r#"{"path":"Views.base","view":"Bad"}"#,
            ErrorCode::ExpressionInvalid,
            "price +",
        ),
        (
            r#"{"path":"Views.base","view":"Odd"}"#,
            ErrorCode::UnsupportedFunction,
            "frobnicate",
        ),
        (
            r#"{"path":"Nowhere.base"}"#,
            ErrorCode::NotFound,
            "Nowhere.base",
        ),
        (
            r#"{"path":"Views.base","this_path":"Gone.md"}"#,
            ErrorCode::InvalidRequest,
            "Gone.md",
        ),
        (
            r#"{"path":"Views.base","limit":0}"#,
            ErrorCode::InvalidCursor,
            "limit",
        ),
        (
            r#"{"path":"Views.base","limit":1001}"#,
            ErrorCode::InvalidCursor,
            "limit",
        ),
        (r#"{"path":"../x.base"}"#, ErrorCode::InvalidPath, "x.base"),
    ] {
        let error = err(&mut daemon, &evaluate(params));
        assert_eq!(error.code, code, "{params}: {error:?}");
        assert!(
            error.message.contains(needle),
            "{params}: {:?} should mention {needle:?}",
            error.message
        );
    }
    let error = err(&mut daemon, &evaluate(r#"{"path":"Broken.base"}"#));
    assert!(
        error.message.contains("at byte"),
        "a parse error carries its position: {:?}",
        error.message
    );
    for (params, code) in [
        (r#"{"limit":0}"#, ErrorCode::InvalidCursor),
        (r#"{"cursor":"nope"}"#, ErrorCode::InvalidCursor),
    ] {
        let line = format!(
            r#"{{"version":1,"id":"l","request":{{"method":"list_bases","params":{params}}}}}"#
        );
        assert_eq!(err(&mut daemon, &line).code, code, "{params}");
    }
}

#[test]
fn health_only_mode_is_index_unavailable() {
    let mut daemon = Daemon::start(&[]);
    assert_eq!(
        err(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#)).code,
        ErrorCode::IndexUnavailable
    );
    assert_eq!(
        err(
            &mut daemon,
            r#"{"version":1,"id":"l","request":{"method":"list_bases","params":{}}}"#
        )
        .code,
        ErrorCode::IndexUnavailable
    );
}

#[test]
fn a_deleted_base_is_not_found() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    ok(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#));
    ok(
        &mut daemon,
        r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"Views.base","mode":"permanent","expected":{"any":true}}}}"#,
    );
    assert_eq!(
        err(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#)).code,
        ErrorCode::NotFound
    );
}

#[test]
fn list_bases_names_every_base_with_its_status() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let Response::ListBases(page) = ok(
        &mut daemon,
        r#"{"version":1,"id":"l","request":{"method":"list_bases","params":{}}}"#,
    ) else {
        panic!("a list_bases answer")
    };
    let summary: Vec<(&str, bool, usize)> = page
        .items
        .iter()
        .map(|item| {
            (
                item.path.as_str(),
                matches!(item.status, vault_protocol::BaseStatusDto::Parsed),
                item.views.len(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![("Broken.base", false, 0), ("Views.base", true, 4)]
    );
    assert!(page.next_cursor.is_none());
}

#[test]
fn a_view_embed_resolves_over_the_wire() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let raw = daemon.call_raw(
        r#"{"version":1,"id":"r","request":{"method":"resolve_link","params":{"source_path":"Home.md","destination":"Views.base#Table"}}}"#,
    );
    assert!(
        raw.contains(r#""resolution":{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}"#),
        "{raw}"
    );
}

/// A raw write of a `.base` joins the indexed universe: `semantic` and a
/// generation on the wire, and the base is listed and evaluated at it.
#[test]
fn a_written_base_is_semantic_and_evaluates() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let Response::WriteFile(written) = ok(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_file","params":{"path":"New.base","content_base64":"dmlld3M6CiAgLSB0eXBlOiBsaXN0CiAgICBuYW1lOiBPbmx5Cg==","expected":{"absent":true}}}}"#,
    ) else {
        panic!("a write_file answer")
    };
    assert!(written.semantic);
    let generation = written
        .generation
        .expect("a write into the vault has a generation");
    let only = answer(&mut daemon, r#"{"path":"New.base"}"#);
    assert_eq!(only.view.name, "Only");
    assert_eq!(only.generation, generation);
}

/// `.obsidian/types.json` is read through the configuration zone on each
/// evaluation: a declared date turns text into a date cell, and a missing or
/// malformed file is no declared types, never an error.
#[test]
fn declared_property_types_come_from_the_configuration_zone() {
    let (vault, index) = vault_of(&[
        ("A.md", "---\ndue: x\nbig: .inf\n---\n"),
        (
            "Due.base",
            "views:\n  - type: table\n    name: T\n    order: [due, big]\n",
        ),
        (".obsidian/types.json", "{ not json"),
    ]);
    let mut daemon = started(&vault, &index);
    let malformed = answer(&mut daemon, r#"{"path":"Due.base"}"#);
    assert_eq!(
        malformed.rows[0].cells[0],
        CellDto::String { value: "x".into() }
    );
    assert_eq!(
        malformed.rows[0].cells[1],
        CellDto::String {
            value: "Infinity".into()
        },
        "a non-finite number travels as JavaScript's text"
    );
    std::fs::write(
        vault.path().join(".obsidian/types.json"),
        r#"{"types":{"due":"tags"}}"#,
    )
    .unwrap();
    // A new generation, so the evaluation is not the cached one.
    ok(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"B.md","content":"x\n","expected":{"absent":true}}}}"#,
    );
    let typed = answer(&mut daemon, r#"{"path":"Due.base"}"#);
    // Declared a tags property, `x` is the tag `#x` (captured, Task 13).
    assert_eq!(
        typed.rows[0].cells[0],
        CellDto::String { value: "#x".into() }
    );
}

/// Nested list cells and how many of them there are before a non-list.
fn list_levels(cell: &CellDto) -> (usize, &CellDto) {
    let mut cell = cell;
    let mut levels = 0;
    while let CellDto::List { value } = cell {
        assert_eq!(value.len(), 1);
        cell = &value[0];
        levels += 1;
    }
    (levels, cell)
}

/// The depth cap at its boundary. A cell may be 32 levels deep counting its
/// leaf: 31 nested lists around a number arrive whole, 32 nested lists keep
/// their 32 levels and the leaf becomes the error cell; 31 nested objects
/// (three JSON levels each, the widest cell) still fit a client's 128-level
/// JSON reading limit, which this harness's own parse proves. 40 levels are
/// cut at the same place.
#[test]
fn a_cell_nested_too_deeply_is_an_error_cell() {
    let lists = |depth: usize| format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
    let objects = |depth: usize| format!("{}1{}", "{\"a\": ".repeat(depth), "}".repeat(depth));
    let (vault, index) = vault_of(&[
        ("A.md", "x\n"),
        (
            "Deep.base",
            &format!(
                "formulas:\n  whole: '{}'\n  cut: '{}'\n  far: '{}'\n  objects: '{}'\nviews:\n  - type: table\n    name: T\n    order: [formula.whole, formula.cut, formula.far, formula.objects]\n",
                lists(31),
                lists(32),
                lists(40),
                objects(31)
            ),
        ),
    ]);
    let mut daemon = started(&vault, &index);
    let answer = answer(&mut daemon, r#"{"path":"Deep.base"}"#);
    let cells = &answer.rows[0].cells;

    let (levels, leaf) = list_levels(&cells[0]);
    assert_eq!(levels, 31);
    assert_eq!(
        leaf,
        &CellDto::Number {
            value: serde_json::Number::from(1)
        },
        "31 lists arrive whole"
    );
    for (index, wanted) in [(1, 32), (2, 32)] {
        let (levels, leaf) = list_levels(&cells[index]);
        assert_eq!(levels, wanted, "column {index}");
        assert!(
            matches!(leaf, CellDto::Error { message } if message.contains("nested too deeply")),
            "column {index}: {leaf:?}"
        );
    }

    let mut cell = &cells[3];
    let mut levels = 0;
    while let CellDto::Object { value } = cell {
        assert_eq!(value.len(), 1);
        cell = &value[0].value;
        levels += 1;
    }
    assert_eq!(levels, 31);
    assert_eq!(
        cell,
        &CellDto::Number {
            value: serde_json::Number::from(1)
        },
        "31 objects arrive whole"
    );
}
