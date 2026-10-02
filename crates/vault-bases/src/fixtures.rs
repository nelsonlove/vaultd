//! Capture fixtures: one JSON line per case, compared against the evaluator.
//!
//! Compiled only with the `fixtures` feature (the crate's own tests and
//! `vault-server`'s replay suite turn it on). A row is `published` (a
//! published page or standard fixes it), `uncaptured` (no published rule;
//! the evaluator must answer an error naming the case), or `captured` (Task
//! 13 recorded Obsidian's answer).

use std::path::PathBuf;

use serde_json::Value as Json;
use vault_core::{PropertyValue, VaultPath};

use crate::clock::Clock;
use crate::eval::coerce::number_to_string;
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::parse_expression;
use crate::source::{MemoryFile, MemorySource, no_span};
use crate::value::Value;

/// 2026-01-15T10:30:00-05:00: a Thursday, mid-month, outside DST, so a
/// fixture's weekday, month and offset are all unambiguous.
pub const FIXTURE_NOW_MS: i64 = 1_768_491_000_000;
pub const FIXTURE_ZONE: &str = "America/New_York";

#[derive(Clone, Debug)]
pub struct CaptureRow {
    pub family: String,
    pub case: String,
    pub expr: String,
    pub kind: String,
    pub text: Option<String>,
    pub source: String,
    pub props: Vec<(String, PropertyValue)>,
    pub now_ms: Option<i64>,
    pub zone: Option<String>,
}

fn property_from_json(value: &Json) -> PropertyValue {
    match value {
        Json::Null => PropertyValue::Null,
        Json::Bool(flag) => PropertyValue::Boolean(*flag),
        Json::Number(number) => match number.as_i64() {
            Some(integer) => PropertyValue::Integer(integer),
            None => PropertyValue::Float(number.as_f64().expect("a JSON number is an f64")),
        },
        Json::String(text) => PropertyValue::String(text.clone()),
        Json::Array(items) => PropertyValue::Sequence(
            items
                .iter()
                .map(|item| no_span(property_from_json(item)))
                .collect(),
        ),
        Json::Object(entries) => PropertyValue::Mapping(
            entries
                .iter()
                .map(|(key, value)| (no_span(key.clone()), no_span(property_from_json(value))))
                .collect(),
        ),
    }
}

fn captures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/captures")
}

/// Every row of `tests/fixtures/captures/<family>.jsonl`. Panics on a
/// malformed line, naming it: a broken fixture is a test bug.
pub fn load_captures(family: &str) -> Vec<CaptureRow> {
    let path = captures_dir().join(format!("{family}.jsonl"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(number, line)| {
            let row: Json = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("{}:{}: {error}", path.display(), number + 1));
            let field = |name: &str| row.get(name).and_then(Json::as_str).map(str::to_string);
            CaptureRow {
                family: field("family").unwrap_or_else(|| family.to_string()),
                case: field("case")
                    .unwrap_or_else(|| panic!("{}:{}: no case", path.display(), number + 1)),
                expr: field("expr")
                    .unwrap_or_else(|| panic!("{}:{}: no expr", path.display(), number + 1)),
                kind: field("kind")
                    .unwrap_or_else(|| panic!("{}:{}: no kind", path.display(), number + 1)),
                text: field("text"),
                source: field("source").unwrap_or_else(|| "published".into()),
                props: row
                    .get("props")
                    .and_then(Json::as_object)
                    .map(|props| {
                        props
                            .iter()
                            .map(|(key, value)| (key.clone(), property_from_json(value)))
                            .collect()
                    })
                    .unwrap_or_default(),
                now_ms: row.get("now_ms").and_then(Json::as_i64),
                zone: field("zone"),
            }
        })
        .collect()
}

/// The text a table cell shows for `value`.
///
/// **Provisional where marked.** Strings, numbers and booleans follow
/// JavaScript's `ToString` (published). How a cell shows a date, a list, a
/// link and a file is what Task 13's view captures settle; until then the
/// rules below are the renderer's, and a disagreement with a capture is
/// fixed here, in one place.
pub fn render_text(value: &Value, clock: &Clock) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_string(*number),
        Value::Boolean(flag) => flag.to_string(),
        // Provisional: ISO date, or date and minutes in the clock's zone.
        Value::Date(date) => {
            let zoned = jiff::Timestamp::from_millisecond(date.epoch_ms)
                .expect("a representable instant")
                .to_zoned(clock.zone.clone());
            if date.has_time {
                zoned.strftime("%Y-%m-%d %H:%M").to_string()
            } else {
                zoned.strftime("%Y-%m-%d").to_string()
            }
        }
        // Provisional: milliseconds, as the cell model carries them.
        Value::Duration(duration) => duration.ms.to_string(),
        // Provisional: items joined by ", ".
        Value::List(items) => items
            .iter()
            .map(|item| render_text(item, clock))
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(entries) => entries
            .iter()
            .map(|(key, value)| format!("{key}: {}", render_text(value, clock)))
            .collect::<Vec<_>>()
            .join(", "),
        // Provisional: the display text, else the target as written.
        Value::Link(link) => match &link.display {
            Some(display) => render_text(display, clock),
            None => link
                .target
                .trim_start_matches("[[")
                .trim_end_matches("]]")
                .to_string(),
        },
        // Provisional: the file name without a `.md` extension.
        Value::File(path) => path
            .name()
            .strip_suffix(".md")
            .unwrap_or(path.name())
            .to_string(),
        Value::Regexp(regexp) => format!("/{}/{}", regexp.source, regexp.flags),
        Value::Image(text) | Value::Icon(text) | Value::Html(text) => text.clone(),
    }
}

/// Evaluate every row of one family file against a one-note vault
/// (`Capture.md`, carrying the row's `props`) and return one line per row
/// that disagrees. Empty means the whole family holds.
pub fn check_family(family: &str) -> Vec<String> {
    let mut failures = Vec::new();
    for row in load_captures(family) {
        let clock = Clock::fixed(
            row.now_ms.unwrap_or(FIXTURE_NOW_MS),
            row.zone.as_deref().unwrap_or(FIXTURE_ZONE),
        );
        let mut note = MemoryFile::note()
            .times(FIXTURE_NOW_MS - 86_400_000, FIXTURE_NOW_MS - 3_600_000)
            .size(42);
        for (key, value) in &row.props {
            note = note.property(key, value.clone());
        }
        let source = MemorySource::new()
            .with("Capture.md", note)
            .with("Other.md", MemoryFile::note());
        let row_path = VaultPath::new("Capture.md").expect("a valid path");
        let base_path = VaultPath::new("Captures.base").expect("a valid path");
        let ctx = EvalContext::new(&source, &clock, &base_path, &row_path);
        let label = format!("[{}] {} `{}`", row.source, row.case, row.expr);
        // A row's expression must parse: a parse error is a broken row, never
        // the error an `error` row expects.
        let expr = match parse_expression(&row.expr) {
            Ok(expr) => expr,
            Err(error) => {
                failures.push(format!(
                    "{label}: does not parse: {} at {}",
                    error.message, error.position
                ));
                continue;
            }
        };
        let outcome = evaluate(&expr, &ctx, &Scope::row(&row_path));
        match (row.kind.as_str(), outcome) {
            ("error", Err(error)) => {
                // An uncaptured row must answer `Uncaptured` naming exactly
                // its own case, so a renamed case goes red.
                let named = EvalError::Uncaptured(row.case.clone());
                if row.source == "uncaptured" && error != named {
                    failures.push(format!(
                        "{label}: an uncaptured case must answer {named:?}, got {error:?}"
                    ));
                }
            }
            ("error", Ok(value)) => {
                failures.push(format!("{label}: expected an error, got {value:?}"))
            }
            (_, Err(error)) => {
                failures.push(format!("{label}: expected {}, got error {error}", row.kind))
            }
            (kind, Ok(value)) => {
                if value.type_name() != kind {
                    failures.push(format!(
                        "{label}: expected kind {kind}, got {} ({value:?})",
                        value.type_name()
                    ));
                } else if let Some(text) = &row.text {
                    let rendered = render_text(&value, &clock);
                    if &rendered != text {
                        failures.push(format!("{label}: expected text {text:?}, got {rendered:?}"));
                    }
                }
            }
        }
    }
    failures
}
