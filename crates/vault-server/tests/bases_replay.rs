//! Replay every capture against vaultd's evaluator over the same corpus.
//!
//! The corpus suites are ignored by default: they need the hand-made corpus
//! under `target/tmp/bases-corpus` (Task 13). Run with
//! `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_replay -- --ignored`.
//!
//! Two capture sets. The synthetic captures (the generated `Captures/`
//! bases: the function families, the probes, the view family) are
//! committed under `tests/fixtures/bases-captures/`. The captures of
//! a real vault's bases never enter the repository (ruled 2026-10-08): they
//! live in `$VAULTD_CORPUS_CAPTURES`, default
//! `$XDG_DATA_HOME/vaultd/bases-captures/corpus` (`~/.local/share/…`), and
//! their test skips, saying why, when that folder is missing.
//!
//! The engine is driven through `IndexReader::evaluate_base` at each view's
//! captured instant (`captured_at_ms`, else `meta.json`'s) and zone, and
//! cells are compared as the text `vault_bases::fixtures::render_text`
//! gives them — the wire conversion is pinned separately by `bases_ops.rs`
//! and the conformance set, so this file pins exactly one thing: that
//! vaultd computes what Obsidian computed.
//!
//! Shape of `base:query format=json`, recorded at capture time (Obsidian
//! 1.13.7): a JSON array with one object per row, in the view's sorted and
//! limited order (`groupBy` does not reorder it); each object holds `path`
//! (the row's vault path) and then one key per column in column order,
//! keyed by the column's display name (a note property by its name,
//! `formula.x` as `x`, `file.name` as `file name`), so the replay reads the
//! keys in the order they are written. Every cell is the text Obsidian
//! shows for the value, or `null` for an empty one (null, `""`, an empty
//! list); an error shows as text starting `Error: `. A view with no `order`
//! has the one column `file name`. A base Obsidian cannot read prints
//! `Error: …` instead of an array. Groups and summaries are not in it: for
//! the generated views the capture also reads the rendered table
//! (`rendered`: each group's heading and rows, each footer summary).
//!
//! Two kinds of view are left out, each printed with why. In `base:query`,
//! `this` is nothing, so a view that reads `this` is compared against its
//! rendered table (an opened base, where `this` is the base) when the
//! capture holds one short enough to show every row, and is skipped
//! otherwise. And a view named in `deviations.json` beside the captures is
//! a known difference, with its reason: the committed file names only
//! generated views (where rulings R1 and R2, `docs/design/bases-evaluation.md`
//! rulings 7 and 8, leave vaultd apart from Obsidian, and what no collation
//! reproduces); the corpus captures carry their own, so a
//! corpus base's name never enters the repository.
//!
//! Two checks keep a real vault's notes out of the committed captures (the
//! ruling of 2026-10-08). `committed_captures_name_only_generated_paths` runs
//! everywhere, but sees only names written as paths (a wikilink target, a
//! run ending in a file extension). A real note's name written bare, with
//! no extension, is caught only by `committed_files_hold_no_corpus_name`,
//! which needs the local corpus (`MANIFEST.json` and the corpus captures)
//! and is skipped where that is missing.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use vault_bases::Clock;
use vault_bases::fixtures::render_text;
use vault_core::VaultPath;
use vault_index::{BaseQuery, IndexConfig, IndexReader, IndexService, parse_property_types};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn synthetic_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bases-captures")
}

/// Where the captures of a real vault's bases live: never in the repository.
fn corpus_captures_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VAULTD_CORPUS_CAPTURES") {
        return PathBuf::from(dir);
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("HOME is set")).join(".local/share")
        });
    data.join("vaultd/bases-captures/corpus")
}

/// One row object of `base:query`, its keys in the order written.
struct OrderedRow(Vec<(String, serde_json::Value)>);

impl<'de> Deserialize<'de> for OrderedRow {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RowVisitor;
        impl<'de> Visitor<'de> for RowVisitor {
            type Value = OrderedRow;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a row object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedRow, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(OrderedRow(entries))
            }
        }
        deserializer.deserialize_map(RowVisitor)
    }
}

struct OrderedRows(Vec<OrderedRow>);

impl<'de> Deserialize<'de> for OrderedRows {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RowsVisitor;
        impl<'de> Visitor<'de> for RowsVisitor {
            type Value = OrderedRows;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an array of row objects")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<OrderedRows, A::Error> {
                let mut rows = Vec::new();
                while let Some(row) = seq.next_element()? {
                    rows.push(row);
                }
                Ok(OrderedRows(rows))
            }
        }
        deserializer.deserialize_seq(RowsVisitor)
    }
}

/// A cell as the replay compares it: an error of any message is `<error>`,
/// an empty cell is `""`, anything else its text.
fn obsidian_cell(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) if text.starts_with("Error: ") => "<error>".into(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// One row as compared: its path, then each column's key (the display
/// name `base:query` writes) and cell text.
type Row = (String, Vec<(String, String)>);

/// One captured view.
struct Captured {
    file: PathBuf,
    base: String,
    view: String,
    at_ms: Option<i64>,
    /// `None` when Obsidian refused the base (`Error: …` instead of rows).
    rows: Option<Vec<Row>>,
    rendered: Option<serde_json::Value>,
}

/// The column a generated family view ends with: the instant Obsidian
/// evaluated it at (`now().format("x")`).
const NOW_COLUMN: &str = "t13_now";

/// A lone UTF-16 surrogate escape (`"a🙂".reverse()` shows one) is not a
/// string `serde_json` can hold: it becomes U+FFFD, as vaultd's reverse
/// writes it.
fn without_lone_surrogates(stdout: &str) -> String {
    let mut out = String::with_capacity(stdout.len());
    let mut rest = stdout;
    while let Some(at) = rest.find("\\u") {
        out.push_str(&rest[..at]);
        let code = rest
            .get(at + 2..at + 6)
            .and_then(|hex| u16::from_str_radix(hex, 16).ok());
        match code {
            Some(0xD800..=0xDBFF) => {
                let low = rest
                    .get(at + 6..at + 12)
                    .filter(|next| next.starts_with("\\u"))
                    .and_then(|next| u16::from_str_radix(&next[2..], 16).ok())
                    .filter(|low| (0xDC00..=0xDFFF).contains(low));
                if low.is_some() {
                    out.push_str(&rest[at..at + 12]);
                    rest = &rest[at + 12..];
                } else {
                    out.push_str("\\ufffd");
                    rest = &rest[at + 6..];
                }
            }
            Some(0xDC00..=0xDFFF) => {
                out.push_str("\\ufffd");
                rest = &rest[at + 6..];
            }
            _ => {
                out.push_str("\\u");
                rest = &rest[at + 2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The rows of one record, and the instant of its [`NOW_COLUMN`] when it
/// has one (that column is left out of the rows).
fn rows_of(stdout: &str) -> Option<(Vec<Row>, Option<i64>)> {
    let OrderedRows(rows) = serde_json::from_str(&without_lone_surrogates(stdout)).ok()?;
    let mut now = None;
    let rows = rows
        .into_iter()
        .map(|OrderedRow(entries)| {
            let mut path = String::new();
            let mut cells = Vec::new();
            for (key, value) in entries {
                if key == "path" && path.is_empty() {
                    path = value.as_str().unwrap_or_default().to_string();
                } else if key == NOW_COLUMN {
                    now = value.as_str().and_then(|text| text.parse().ok());
                } else {
                    cells.push((key, obsidian_cell(&value)));
                }
            }
            (path, cells)
        })
        .collect();
    Some((rows, now))
}

fn captures(dir: &Path) -> Vec<Captured> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            out.extend(captures(&path));
            continue;
        }
        if path.file_name().is_some_and(|name| name == "meta.json")
            || path.extension().is_none_or(|ext| ext != "json")
        {
            continue;
        }
        let record: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // A CLI call that never answered is no evidence either way.
        if record["exit_code"].as_i64() != Some(0) {
            continue;
        }
        let parsed = rows_of(record["stdout"].as_str().unwrap_or_default());
        let now = parsed.as_ref().and_then(|(_, now)| *now);
        out.push(Captured {
            base: record["base"].as_str().unwrap().to_string(),
            view: record["view"].as_str().unwrap().to_string(),
            at_ms: now.or_else(|| record["captured_at_ms"].as_i64()),
            rows: parsed.map(|(rows, _)| rows),
            rendered: record.get("rendered").cloned(),
            file: path,
        });
    }
    out
}

struct Corpus {
    _index: tempfile::TempDir,
    _service: IndexService,
    reader: IndexReader,
    types: BTreeMap<String, vault_bases::PropertyType>,
}

fn open_corpus() -> Corpus {
    let root = repo();
    let corpus = root.join("target/tmp/bases-corpus");
    let index = tempfile::TempDir::new_in(root.join("target/tmp")).unwrap();
    let config = IndexConfig::explicit(&corpus, index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let types = std::fs::read_to_string(corpus.join(".obsidian/types.json"))
        .map(|text| parse_property_types(&text))
        .unwrap_or_default();
    Corpus {
        _index: index,
        _service: service,
        reader,
        types,
    }
}

fn meta(dir: &Path) -> (i64, String) {
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).expect("meta.json"))
            .unwrap();
    (
        meta["captured_at_ms"].as_i64().unwrap(),
        meta["zone"].as_str().unwrap().to_string(),
    )
}

/// The key `base:query` writes for a column: its display name, else the
/// property's name (`note.x` and `formula.x` as `x`) or, for a file field,
/// Obsidian's label for it (captured, `probe-fields`).
fn column_key(column: &vault_bases::view::ColumnDecl) -> String {
    if let Some(name) = &column.display_name {
        return name.clone();
    }
    let property = column.property.as_str();
    if property == "file" {
        return "file".into();
    }
    if let Some(field) = property.strip_prefix("file.") {
        return match field {
            "name" => "file name",
            "basename" => "file base name",
            "ext" => "file extension",
            "path" => "file path",
            "folder" => "folder",
            "size" => "file size",
            "ctime" => "created time",
            "mtime" => "modified time",
            "tags" => "file tags",
            "links" => "file links",
            "embeds" => "file embeds",
            "backlinks" => "file backlinks",
            "properties" => "properties",
            "file" => "file",
            other => other,
        }
        .to_string();
    }
    property
        .strip_prefix("formula.")
        .or_else(|| property.strip_prefix("note."))
        .unwrap_or(property)
        .to_string()
}

/// One row's keyed cells as a JavaScript object holds them: a key written
/// twice keeps its first place and its last value (two columns with one
/// display name are one key in `base:query`'s output).
fn keyed(cells: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in cells {
        match out.iter_mut().find(|(have, _)| *have == key) {
            Some(entry) => entry.1 = value,
            None => out.push((key, value)),
        }
    }
    out
}

/// Labels of views whose difference from Obsidian is known and named, read
/// from `deviations.json` beside the captures (`{"<base>#<view>": "why"}`),
/// so a corpus deviation never puts a base's name in the repository.
fn known_deviations(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(dir.join("deviations.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<BTreeMap<String, String>>(&text).ok())
        .unwrap_or_default()
}

/// The rendered table's groups as the replay compares them: each group's
/// heading and its rows' first cells.
fn rendered_groups(rendered: &serde_json::Value) -> Vec<(String, usize)> {
    rendered["groups"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .map(|group| {
                    (
                        group["value"].as_str().unwrap_or_default().to_string(),
                        group["rows"].as_array().map_or(0, Vec::len),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Why a view that reads `this` is skipped.
const THIS_SKIP: &str = "reads `this`, which base:query leaves empty";

/// What one replay found.
struct Replayed {
    views: usize,
    failures: Vec<String>,
    /// Views left out, with why: each is a context `base:query` does not
    /// share with an embedded or opened base, or a deviation named in
    /// `deviations.json`.
    skipped: Vec<String>,
}

/// Replay every capture under `dir`; one line per view that differs.
fn replay(dir: &Path, corpus: &Corpus) -> Replayed {
    let (meta_ms, zone) = meta(dir);
    let all = captures(dir);
    assert!(!all.is_empty(), "no captures under {}", dir.display());
    let deviations = known_deviations(dir);
    let mut failures = Vec::new();
    let mut skipped = Vec::new();
    for captured in &all {
        let clock = Clock::fixed(captured.at_ms.unwrap_or(meta_ms), &zone);
        let label = format!("{}#{}", captured.base, captured.view);
        if let Some(reason) = deviations.get(&label) {
            skipped.push(format!("{label}: {reason}"));
            continue;
        }
        let base = VaultPath::new(captured.base.as_str()).unwrap();
        let query = BaseQuery {
            path: &base,
            view: Some(&captured.view),
            this_path: None,
            types: &corpus.types,
        };
        let answer = corpus.reader.evaluate_base(&query, &clock);
        let Some(expected) = &captured.rows else {
            if let Ok(answer) = answer {
                failures.push(format!(
                    "{label}: Obsidian refused the base, vaultd answered {} rows",
                    answer.result.rows.len()
                ));
            }
            continue;
        };
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                failures.push(format!("{label}: vaultd refused: {error:?}"));
                continue;
            }
        };
        // In `base:query`, `this` is nothing (captured: `this == null`),
        // while in an opened or embedded base it is that file. A view that
        // reads `this` is compared against the rendered table when the
        // capture holds one small enough to show every row, and is left out
        // otherwise.
        if answer.dependencies.reads_this {
            match captured.rendered.as_ref().and_then(rendered_rows) {
                Some(rendered) => {
                    let ours: Vec<Vec<String>> = answer
                        .result
                        .rows
                        .iter()
                        .map(|row| {
                            row.cells
                                .iter()
                                .map(|cell| rendered_text(cell, &clock))
                                .collect()
                        })
                        .collect();
                    if ours != rendered {
                        failures.push(format!(
                            "{label} (rendered, reads this):\n  obsidian {rendered:?}\n  vaultd   {ours:?}"
                        ));
                    }
                }
                None => skipped.push(format!("{label}: {THIS_SKIP}")),
            }
            continue;
        }
        // `base:query` lists only the notes among a view's rows (the rendered
        // table shows the attachments too).
        let mut ours: Vec<Row> = answer
            .result
            .rows
            .iter()
            .filter(|row| row.kind == vault_bases::FileKind::Note)
            .map(|row| {
                let cells = row
                    .cells
                    .iter()
                    .zip(&answer.columns)
                    .filter(|(_, column)| column.property != format!("formula.{NOW_COLUMN}"))
                    .map(|(cell, column)| {
                        let text = match cell {
                            Ok(value) => render_text(value, &clock),
                            // Ruling R1: a formula that does not parse is
                            // an error cell in vaultd, where Obsidian shows
                            // the cell empty (captured, `x_bad_syntax`).
                            Err(vault_bases::eval::EvalError::FormulaInvalid { .. }) => {
                                String::new()
                            }
                            Err(_) => "<error>".into(),
                        };
                        (column_key(column), text)
                    })
                    .collect();
                (row.path.as_str().to_string(), keyed(cells))
            })
            .collect();
        let mut theirs = expected.clone();
        // `base:query` lists a grouped view's rows ungrouped: compare the
        // rows as a set there, and the grouping against the rendered table.
        if answer.view.group_by.is_some() {
            ours.sort();
            theirs.sort();
            if let Some(rendered) = &captured.rendered {
                let groups = rendered_groups(rendered);
                let mut ours_groups: Vec<(String, usize)> = Vec::new();
                for row in &answer.result.rows {
                    // The rendered heading shows a list's items apart and an
                    // empty key as `None`.
                    let key = match &row.group {
                        Some(Ok(vault_bases::Value::List(items))) => items
                            .iter()
                            .map(|item| render_text(item, &clock))
                            .collect::<Vec<_>>()
                            .join(" "),
                        Some(Ok(value)) => render_text(value, &clock),
                        _ => String::new(),
                    };
                    let key = if key.is_empty() { "None".into() } else { key };
                    match ours_groups.last_mut() {
                        Some((last, count)) if *last == key => *count += 1,
                        _ => ours_groups.push((key, 1)),
                    }
                }
                if !groups.is_empty() && ours_groups != groups {
                    failures.push(format!(
                        "{label}: groups\n  obsidian {groups:?}\n  vaultd   {ours_groups:?}"
                    ));
                }
            }
        }
        if ours != theirs {
            // `VAULTD_REPLAY_DUMP=<file>` appends each difference as one JSON
            // line, for working a long failure list.
            if let Some(dump) = std::env::var_os("VAULTD_REPLAY_DUMP") {
                use std::io::Write;
                let line = serde_json::json!({
                    "label": label, "file": captured.file, "obsidian": theirs, "vaultd": ours,
                });
                let mut out = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dump)
                    .unwrap();
                writeln!(out, "{line}").unwrap();
            }
            failures.push(format!(
                "{label} ({}):\n  obsidian {theirs:?}\n  vaultd   {ours:?}",
                captured.file.display()
            ));
        }
        if let Some(rendered) = &captured.rendered {
            for summary in rendered["summaries"].as_array().into_iter().flatten() {
                let column = summary["column"].as_u64().unwrap_or(0) as usize;
                let want = summary["value"].as_str().unwrap_or_default();
                let property = answer
                    .columns
                    .get(column)
                    .map(|column| column.property.clone());
                let got = property.and_then(|property| {
                    answer
                        .result
                        .summaries
                        .iter()
                        .find(|summary| summary.property == property)
                        // The rendered footer rounds a number to two places.
                        .map(|summary| match &summary.value {
                            Ok(vault_bases::Value::Number(number)) => {
                                let rounded = (number * 100.0).round() / 100.0;
                                vault_bases::eval::coerce::number_to_string(rounded)
                            }
                            Ok(value) => render_text(value, &clock),
                            Err(_) => "<error>".into(),
                        })
                });
                if got.as_deref() != Some(want) {
                    failures.push(format!(
                        "{label}: summary in column {column}: obsidian {want:?}, vaultd {got:?}"
                    ));
                }
            }
        }
    }
    // A deviation naming no captured view is stale, not a skip.
    let labels: BTreeSet<String> = all
        .iter()
        .map(|captured| format!("{}#{}", captured.base, captured.view))
        .collect();
    for label in deviations.keys() {
        if !labels.contains(label) {
            failures.push(format!(
                "deviations.json names {label}, which no capture holds"
            ));
        }
    }
    Replayed {
        views: all.len(),
        failures,
        skipped,
    }
}

/// The rendered table's rows, when it shows them all: one list of cell
/// texts per row, in order. A table that scrolls renders only the rows in
/// view, so a capture of 15 rows or more is not used.
fn rendered_rows(rendered: &serde_json::Value) -> Option<Vec<Vec<String>>> {
    let groups = rendered["groups"].as_array()?;
    if groups.is_empty() || !rendered["error"].as_str().unwrap_or_default().is_empty() {
        return None;
    }
    let rows: Vec<Vec<String>> = groups
        .iter()
        .flat_map(|group| group["rows"].as_array().cloned().unwrap_or_default())
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|cell| cell.as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    (rows.len() < 15).then_some(rows)
}

/// A cell as the rendered table shows it: a list's items one per line, a
/// boolean as its checkbox (`on`), and a note's link by its text.
fn rendered_text(
    cell: &Result<vault_bases::Value, vault_bases::eval::EvalError>,
    clock: &Clock,
) -> String {
    match cell {
        Ok(vault_bases::Value::Boolean(_)) => "on".into(),
        Ok(vault_bases::Value::List(items)) => items
            .iter()
            .map(|item| render_text(item, clock))
            .collect::<Vec<_>>()
            .join("\n"),
        Ok(value) => render_text(value, clock),
        Err(_) => String::new(),
    }
}

/// Fail on the differences, and print what was left out and why.
///
/// The skips are bounded, so a silent growth fails: at most `this_skips`
/// views skipped for reading `this`, and every other skip a label
/// `deviations.json` names (which `replay` checks as it skips).
fn assert_replayed(replayed: Replayed, this_skips: usize) {
    for line in &replayed.skipped {
        eprintln!("skipped {line}");
    }
    let reading_this = replayed
        .skipped
        .iter()
        .filter(|line| line.ends_with(THIS_SKIP))
        .count();
    assert!(
        reading_this <= this_skips,
        "{reading_this} views skipped for reading `this`, more than the {this_skips} expected"
    );
    assert!(
        replayed.failures.is_empty(),
        "{} of {} views differ ({} skipped):\n{}",
        replayed.failures.len(),
        replayed.views,
        replayed.skipped.len(),
        replayed.failures.join("\n")
    );
}

#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn every_synthetic_capture_replays_exactly() {
    let corpus = open_corpus();
    assert_replayed(replay(&synthetic_dir(), &corpus), 1);
}

#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn every_corpus_capture_replays_exactly() {
    let dir = corpus_captures_dir();
    if !dir.join("meta.json").exists() {
        eprintln!(
            "skipped: no corpus captures at {} (set VAULTD_CORPUS_CAPTURES)",
            dir.display()
        );
        return;
    }
    let corpus = open_corpus();
    // 61 of the corpus views read `this` (Task 13's count).
    assert_replayed(replay(&dir, &corpus), 61);
}

/// Every family row with `expect_from: corpus` agrees with its capture once
/// the template is filled from the corpus row note's own facts.
#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn every_templated_row_agrees_with_its_capture() {
    use vault_bases::fixtures::{TemplateFacts, fill_template, load_captures};
    let dir = synthetic_dir();
    let (meta_ms, zone) = meta(&dir);
    let corpus = open_corpus();
    let captured = captures(&dir);
    let mut failures = Vec::new();
    let mut checked = 0;
    for family in [
        "coercion", "global", "any", "string", "number", "list", "object", "regexp", "date",
        "link", "file",
    ] {
        for (index, row) in load_captures(family).iter().enumerate() {
            let Some(template) = &row.template else {
                continue;
            };
            let note = format!("Captures/{family}/r{index}.md");
            let Some(capture) = captured.iter().find(|c| {
                c.base == format!("Captures/{family}.base") && c.view == format!("r{index}")
            }) else {
                failures.push(format!("{family} {}: no capture", row.case));
                continue;
            };
            let clock = Clock::fixed(capture.at_ms.unwrap_or(meta_ms), &zone);
            let (_, entries) = corpus
                .reader
                .tree_entries_for(&[VaultPath::new(note.as_str()).unwrap()])
                .unwrap();
            let entry = entries[0].clone().expect("the row note is indexed");
            let facts = TemplateFacts {
                path: note.clone(),
                size: entry.size.unwrap_or(0),
                ctime_ms: entry.ctime_unix_ms,
                mtime_ms: entry.mtime_unix_ms,
            };
            let expected = fill_template(template, &facts, &clock);
            let got = capture
                .rows
                .as_ref()
                .and_then(|rows| rows.first())
                .and_then(|(_, cells)| cells.first())
                .map(|(_, text)| text.clone())
                .unwrap_or_default();
            checked += 1;
            if got != expected {
                failures.push(format!(
                    "{family} {}: template gives {expected:?}, Obsidian showed {got:?}",
                    row.case
                ));
            }
        }
    }
    assert!(checked > 0, "no templated row was checked");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Every committed file the captures and the capture fixtures hold: the
/// synthetic captures and the family `.jsonl` rows.
fn committed_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&synthetic_dir(), &mut files);
    walk(
        &repo().join("crates/vault-bases/tests/fixtures/captures"),
        &mut files,
    );
    files.sort();
    files
}

/// Every string in a JSON value, object keys included; a string that is
/// itself JSON (a record's `stdout`) is walked too.
fn strings_of(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            if let Ok(inner) =
                serde_json::from_str::<serde_json::Value>(&without_lone_surrogates(text))
            {
                if inner.is_array() || inner.is_object() {
                    strings_of(&inner, out);
                }
            }
            out.push(text.clone());
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| strings_of(item, out)),
        serde_json::Value::Object(entries) => {
            for (key, item) in entries {
                out.push(key.clone());
                strings_of(item, out);
            }
        }
        _ => {}
    }
}

/// The names of notes and files a string points at: each wikilink's target,
/// and each run of text ending in a file extension the vault uses.
fn named_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let end = after.find("]]").unwrap_or(after.len());
        let target = after[..end].split(['|', '#']).next().unwrap_or_default();
        out.push(target.to_string());
        rest = &after[end.min(after.len())..];
    }
    for extension in [".md", ".base", ".canvas", ".png", ".jpg", ".pdf"] {
        let mut from = 0;
        while let Some(at) = text[from..].find(extension) {
            let end = from + at + extension.len();
            from = end;
            // `file.basename` names no file: the extension must end a word.
            if text[end..]
                .chars()
                .next()
                .is_some_and(|next| next.is_alphanumeric() || next == '_')
            {
                continue;
            }
            let start = text[..end - extension.len()]
                .rfind(['"', '[', ']', '|', '(', ')', ',', '\n', '`', '\'', ' '])
                .map_or(0, |at| at + 1);
            out.push(text[start..end].trim().to_string());
        }
    }
    out
}

/// A committed file's JSON documents: one per line of a `.jsonl`, else one.
fn json_documents(file: &Path, text: &str) -> Vec<serde_json::Value> {
    if file.extension().is_some_and(|ext| ext == "jsonl") {
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    } else {
        vec![serde_json::from_str(text).unwrap()]
    }
}

/// Whether a named path is one `generate` writes, or a name a probe spells
/// without a file behind it.
fn generated_name(name: &str, generated: &BTreeSet<String>) -> bool {
    const GENERATED: [&str; 15] = [
        "Capture",
        "Capture.md",
        "Other",
        "Other.md",
        "Missing",
        "Nowhere",
        "Root-probe.md",
        "probes.base",
        "stem",
        "B",
        "./B",
        "path to nowhere",
        "image.png",
        "{path}",
        "1], [2, 3",
    ];
    // A one-letter stem (`a.md`, `x.md`) is a fixture's own spelling.
    let one_letter = name
        .split('.')
        .next()
        .is_some_and(|stem| stem.chars().count() <= 1);
    // The tail of a generated path, as a rendered cell or a split run shows it.
    let tail_of_generated = generated.iter().any(|path| {
        path.ends_with(&format!("/{name}")) || (path.ends_with(name) && name.contains('.'))
    });
    let date_like = name.len() == 10
        && name.bytes().enumerate().all(|(at, b)| match at {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    name.is_empty()
        || one_letter
        || tail_of_generated
        || name.starts_with("docs/")
        || name.starts_with("Captures/")
        || name.starts_with("Folder/")
        || name.starts_with("https://")
        || date_like
        || GENERATED.contains(&name)
}

/// The ruling of 2026-10-08: captures of a real vault's bases never enter the
/// repository. Every string in every committed capture and capture fixture
/// (cells, keys, rendered rows, error text) names only generated notes and
/// files, a capture's base is a generated one, and nothing names the
/// guarded area. The corpus suite adds a cross-check against the real names
/// (`committed_files_hold_no_corpus_name`).
#[test]
fn committed_captures_name_only_generated_paths() {
    let files = committed_files();
    assert!(!files.is_empty(), "no committed captures");
    // Every `Captures/` path the committed files spell: the generated set
    // a bare name in a rendered cell must be the tail of.
    let mut generated = BTreeSet::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        for document in json_documents(file, &text) {
            let mut strings = Vec::new();
            strings_of(&document, &mut strings);
            generated.extend(
                strings
                    .into_iter()
                    .filter(|string| string.starts_with("Captures/")),
            );
        }
    }
    let mut offending = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        if text.contains("Private/") {
            offending.push(format!("{}: names the guarded area", file.display()));
        }
        for document in &json_documents(file, &text) {
            if let Some(base) = document.get("base").and_then(|base| base.as_str()) {
                if file.extension().is_some_and(|ext| ext == "json")
                    && !base.starts_with("Captures/")
                {
                    offending.push(format!("{}: base {base:?}", file.display()));
                }
            }
            if file
                .file_name()
                .is_some_and(|name| name == "deviations.json")
            {
                for label in document
                    .as_object()
                    .into_iter()
                    .flat_map(|labels| labels.keys())
                {
                    if !label.starts_with("Captures/") {
                        offending.push(format!("{}: deviation {label:?}", file.display()));
                    }
                }
            }
            let mut strings = Vec::new();
            strings_of(document, &mut strings);
            for string in &strings {
                for name in named_paths(string) {
                    if !generated_name(&name, &generated) {
                        offending.push(format!("{}: names {name:?}", file.display()));
                    }
                }
            }
        }
    }
    offending.sort();
    offending.dedup();
    assert!(offending.is_empty(), "{}", offending.join("\n"));
}

/// The corpus half of the ruling's check: no committed capture or capture
/// fixture holds the name of any file or folder the copy took from the real
/// vault (5 characters or more, outside `Captures/`), read at test time from
/// `MANIFEST.json` and the local corpus captures, never written anywhere;
/// and no comment or string literal of a source file in `crates/` or
/// `host/scripts/` holds a distinctive one (the final review's L2). A hit
/// is reported by file and length, never by the name.
#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn committed_files_hold_no_corpus_name() {
    let manifest = repo().join("target/tmp/bases-corpus/MANIFEST.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        eprintln!("skipped: no corpus manifest at {}", manifest.display());
        return;
    };
    let manifest: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mut real: BTreeSet<String> = BTreeSet::new();
    let mut add_path = |path: &str| {
        // `generate` writes `Captures/` and these companions; the corpus
        // captures list them beside the copied notes.
        let companion = ["Capture.md", "Other.md", "Root-probe.md"].contains(&path)
            || path.starts_with("Folder/");
        if path.starts_with("Captures/") || companion {
            return;
        }
        for segment in path.split('/') {
            let stem = segment.rsplit_once('.').map_or(segment, |(stem, _)| stem);
            if stem.chars().count() >= 5 {
                real.insert(stem.to_string());
            }
        }
    };
    for path in manifest["copied"]
        .as_object()
        .into_iter()
        .flat_map(|copied| copied.keys())
    {
        add_path(path);
    }
    for captured in captures(&corpus_captures_dir()) {
        add_path(&captured.base);
        for (path, _) in captured.rows.into_iter().flatten() {
            add_path(&path);
        }
    }
    // Words the generated probes and Obsidian's own messages share with
    // the copied names.
    for generic in [
        "Project",
        "bases",
        "tasknotes",
        "Notes",
        "index",
        "Inbox",
        "Other",
        "Templates",
        "Script",
        "types",
        // A public specification's name, cited by the parser's comments.
        "CommonMark",
    ] {
        real.remove(generic);
    }
    // Dates (`2026-10`, `2026-10-02`) name a day, not a note's subject.
    real.retain(|name| {
        !(name.starts_with("20") && name.bytes().all(|b| b.is_ascii_digit() || b == b'-'))
    });
    let mut hits = Vec::new();
    for file in committed_files() {
        let text = std::fs::read_to_string(&file).unwrap();
        for name in &real {
            if text.contains(name.as_str()) {
                hits.push(format!("{} holds a corpus name", file.display()));
                break;
            }
        }
    }
    // The final review's L2: the Task 13 leak was in code comments, so the
    // comments and string literals of every source file in `crates/` and
    // `host/scripts/` are read too. Only those: an identifier is code's own
    // English, not a quoted name. A top-level area folder (`NN-NN Name`)
    // names an area, not a note, and the copy script and the guard above
    // name one in order to exclude it.
    // Source prose is English, so a name that is one plain word (`Memory`,
    // `paths`) is not evidence: only a name of several words, or one word
    // with an inner capital, digit or mark (`SomeType`, `some-tag`), is
    // looked for.
    real.retain(|name| {
        let bytes = name.as_bytes();
        let area = bytes.len() > 6
            && bytes[..2].iter().all(u8::is_ascii_digit)
            && bytes[2] == b'-'
            && bytes[3..5].iter().all(u8::is_ascii_digit)
            && bytes[5] == b' ';
        let distinctive = name
            .chars()
            .skip(1)
            .any(|c| c.is_uppercase() || !c.is_alphabetic());
        distinctive && !area
    });
    for file in source_files() {
        let text = std::fs::read_to_string(&file).unwrap();
        let javascript = file
            .extension()
            .is_some_and(|ext| ext == "js" || ext == "mjs" || ext == "ts");
        for quoted in comments_and_strings(&text, javascript) {
            if let Some(name) = real.iter().find(|name| quoted.contains(name.as_str())) {
                hits.push(format!(
                    "{} holds a corpus name in a comment or string ({} characters)",
                    file.display(),
                    name.chars().count()
                ));
                break;
            }
        }
    }
    hits.dedup();
    assert!(hits.is_empty(), "{}", hits.join("\n"));
}

/// Every Rust source under `crates/` and every script under `host/scripts/`,
/// fixtures and build output excluded.
fn source_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, extensions: &[&str], out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                if !matches!(
                    name.to_str(),
                    Some("target" | "node_modules" | "fixtures" | "dist")
                ) {
                    walk(&path, extensions, out);
                }
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| extensions.contains(&ext))
            {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&repo().join("crates"), &["rs"], &mut files);
    walk(
        &repo().join("host/scripts"),
        &["js", "mjs", "ts"],
        &mut files,
    );
    files.sort();
    files
}

/// The comments and string literals of a source file, each as one text: a
/// small lexer, wide where it is unsure (an unterminated literal runs to the
/// end of the file, which only reads more). Rust's `'` is a lifetime or a
/// character, never a string; JavaScript's `'` and `` ` `` open strings.
fn comments_and_strings(text: &str, javascript: bool) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    let collect = |from: usize, to: usize| chars[from..to.min(chars.len())].iter().collect();
    while at < chars.len() {
        let c = chars[at];
        let next = chars.get(at + 1).copied();
        if c == '/' && next == Some('/') {
            let end = (at..chars.len())
                .find(|&i| chars[i] == '\n')
                .unwrap_or(chars.len());
            out.push(collect(at + 2, end));
            at = end;
        } else if c == '/' && next == Some('*') {
            let end = (at + 2..chars.len().saturating_sub(1))
                .find(|&i| chars[i] == '*' && chars[i + 1] == '/')
                .unwrap_or(chars.len());
            out.push(collect(at + 2, end));
            at = end + 2;
        } else if !javascript && c == 'r' && matches!(next, Some('"' | '#')) {
            // A raw string: `r"…"` or `r#"…"#`, any number of `#`.
            let hashes = chars[at + 1..].iter().take_while(|&&h| h == '#').count();
            let open = at + 1 + hashes;
            if chars.get(open) != Some(&'"') {
                at += 1;
                continue;
            }
            let close: String = std::iter::once('"')
                .chain(std::iter::repeat_n('#', hashes))
                .collect();
            let close: Vec<char> = close.chars().collect();
            let end = (open + 1..chars.len())
                .find(|&i| chars[i..].starts_with(&close))
                .unwrap_or(chars.len());
            out.push(collect(open + 1, end));
            at = end + close.len();
        } else if !javascript && c == '\'' {
            // A character literal (`'"'`, `'\''`, `'\u{22}'`) is skipped
            // whole, so its quote opens no string; a lifetime is one `'`.
            let close = if next == Some('\\') {
                (at + 3..chars.len().min(at + 12)).find(|&i| chars[i] == '\'')
            } else {
                (chars.get(at + 2) == Some(&'\'')).then_some(at + 2)
            };
            at = close.map_or(at + 1, |close| close + 1);
        } else if c == '"' || (javascript && (c == '\'' || c == '`')) {
            let mut end = at + 1;
            while end < chars.len() && chars[end] != c {
                end += if chars[end] == '\\' { 2 } else { 1 };
            }
            out.push(collect(at + 1, end));
            at = end + 1;
        } else {
            at += 1;
        }
    }
    out
}
