//! Capture fixtures: one JSON line per case, compared against the evaluator.
//!
//! Compiled only with the `fixtures` feature (the crate's own tests and
//! `vault-server`'s replay suite turn it on). A row is `published` (a
//! published page or standard fixes it), `uncaptured` (no published rule;
//! the evaluator must answer an error naming the case), or `captured` (Task
//! 13 recorded Obsidian's answer), or `provisional` (the evaluator's
//! reading, with no capture behind it yet; a `why` field says what will
//! settle it).
//!
//! A `captured` row whose answer reads the clock (`now()`, `today()`) holds
//! the text the captured rule gives at [`FIXTURE_NOW_MS`], not the text
//! Obsidian showed at its own instant: such a row is checked against
//! Obsidian only through `vault-server`'s replay suite, which evaluates each
//! captured view at the instant it was captured.
//!
//! A row of kind `invalid` holds an expression Obsidian 1.13.7 cannot parse
//! (it shows the cell empty): the parser must refuse it (ruling R1, spec
//! ruling 7).
//!
//! A row whose answer is the row file's own facts (its name, path, size or
//! times) carries `"expect_from": "corpus"` and a `"template"` in place of
//! `"text"`: here the template is filled from `Capture.md`'s facts, in the
//! replay from the corpus row note's (see [`fill_template`]).

use std::path::PathBuf;

use serde_json::Value as Json;
use vault_core::{PropertyValue, VaultPath};

use crate::clock::Clock;
use crate::eval::coerce::to_display_string;
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::parse_expression;
use crate::source::{MemoryFile, MemorySource, RowSource, no_span};
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
    /// `"corpus"` when the expected text is [`CaptureRow::template`] filled
    /// from the row file's facts.
    pub expect_from: Option<String>,
    pub template: Option<String>,
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
            let expect_from = field("expect_from");
            let template = field("template");
            // A template without `expect_from: corpus`, or with a literal
            // `text` beside it, is a broken row.
            if template.is_some() != (expect_from.as_deref() == Some("corpus"))
                || (template.is_some() && field("text").is_some())
            {
                panic!(
                    "{}:{}: a template needs expect_from corpus and no text",
                    path.display(),
                    number + 1
                );
            }
            CaptureRow {
                family: field("family").unwrap_or_else(|| family.to_string()),
                case: field("case")
                    .unwrap_or_else(|| panic!("{}:{}: no case", path.display(), number + 1)),
                expr: field("expr")
                    .unwrap_or_else(|| panic!("{}:{}: no expr", path.display(), number + 1)),
                kind: field("kind")
                    .unwrap_or_else(|| panic!("{}:{}: no kind", path.display(), number + 1)),
                text: field("text"),
                expect_from,
                template,
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

/// The text Obsidian's `base:query` shows for `value` (captured, Task 13;
/// Obsidian 1.13.7): an empty cell (`null`, an empty list) is `""`, and
/// anything else is the value's text as `toString()` gives it
/// ([`to_display_string`]).
pub fn render_text(value: &Value, clock: &Clock) -> String {
    match value {
        Value::Null => String::new(),
        Value::List(items) if items.is_empty() => String::new(),
        other => to_display_string(other, clock),
    }
}

/// The vault every capture row runs against, from Task 6 on. `Capture.md`
/// is the row (and `this`); the others exist to be linked, embedded and
/// listed (Task 13's generator writes the same companions at the same
/// paths). A row's `props` are added to `Capture.md`.
pub fn capture_vault(props: &[(String, PropertyValue)]) -> MemorySource {
    let mut capture = MemoryFile::note()
        .times(FIXTURE_NOW_MS - 86_400_000, FIXTURE_NOW_MS - 3_600_000)
        .size(42)
        .tag("book")
        .tag("Project/Active")
        .link("Other")
        .link("Missing")
        .embed("Folder/image.png");
    for (key, value) in props {
        capture = capture.property(key, value.clone());
    }
    MemorySource::new()
        .with("Capture.md", capture)
        .with(
            "Other.md",
            MemoryFile::note()
                .property("status", crate::source::text("done"))
                .link("Capture"),
        )
        .with("Folder/image.png", MemoryFile::attachment(1000))
        .with("Folder/Deep/Inner.md", MemoryFile::note())
        // A name with no extension and a dotfile, for `name`, `basename`
        // and `ext`.
        .with("Folder/README", MemoryFile::attachment(10))
        .with("Folder/.gitignore", MemoryFile::attachment(5))
}

/// The row file's own facts a template may name.
pub struct TemplateFacts {
    pub path: String,
    pub size: u64,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
}

/// Fill `{name}`, `{basename}`, `{path}`, `{folder}`, `{size}`,
/// `{ctime:<fmt>}`, `{mtime:<fmt>}`, `{age_ms}` (`now - ctime` in
/// milliseconds) and `{age}` (the same span as a cell shows a duration) from
/// `facts`. An unknown token is copied as written, so a misspelt template
/// goes red rather than silently empty.
///
/// Two limits. `{ctime:<fmt>}` and `{mtime:<fmt>}` format with
/// `dates::format_date`, the formatter `file.ctime.format(…)` itself calls,
/// so such a row tests the instant, not the formatter (the `date` family
/// tests that). `{folder}` of a root file is the unsettled `folder:root`
/// case, so it is left as `{folder}` and goes red rather than encode `""`.
pub fn fill_template(template: &str, facts: &TemplateFacts, clock: &Clock) -> String {
    let name = facts
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&facts.path)
        .to_string();
    let basename = match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name.clone(),
    };
    let folder = facts
        .path
        .rsplit_once('/')
        .map_or_else(|| "{folder}".to_string(), |(folder, _)| folder.to_string());
    let date = |ms: i64, format: &str| {
        crate::dates::format_date(
            crate::DateValue {
                epoch_ms: ms,
                has_time: true,
            },
            format,
            clock,
        )
        .unwrap_or_else(|error| format!("{{{error}}}"))
    };
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let close = rest[open..].find('}').map_or(rest.len(), |at| open + at);
        let token = &rest[open + 1..close];
        out.push_str(&match token.split_once(':') {
            Some(("ctime", format)) => date(facts.ctime_ms, format),
            Some(("mtime", format)) => date(facts.mtime_ms, format),
            _ => match token {
                "name" => name.clone(),
                "basename" => basename.clone(),
                "path" => facts.path.clone(),
                "folder" => folder.clone(),
                "size" => facts.size.to_string(),
                "age_ms" => (clock.now_ms - facts.ctime_ms).to_string(),
                // `now() - file.ctime`, a duration, as a cell shows it.
                "age" => crate::dates::humanize(crate::DurationValue {
                    months: 0,
                    ms: clock.now_ms - facts.ctime_ms,
                    timed: true,
                }),
                other => format!("{{{other}}}"),
            },
        });
        rest = &rest[(close + 1).min(rest.len())..];
    }
    out.push_str(rest);
    out
}

/// The text a row expects: its template filled from the row file's facts
/// in `source`, else its literal `text`.
fn expected_text(
    row: &CaptureRow,
    source: &MemorySource,
    row_path: &VaultPath,
    clock: &Clock,
) -> Option<String> {
    let Some(template) = &row.template else {
        return row.text.clone();
    };
    let facts = source
        .facts(row_path)
        .expect("a memory source never fails")
        .expect("the row file is in the capture vault");
    Some(fill_template(
        template,
        &TemplateFacts {
            path: facts.path.as_str().to_string(),
            size: facts.size,
            ctime_ms: facts.ctime_ms,
            mtime_ms: facts.mtime_ms,
        },
        clock,
    ))
}

/// Evaluate every row of one family file against [`capture_vault`] (the row
/// is `Capture.md`, carrying the row's `props`) and return one line per row
/// that disagrees. Empty means the whole family holds.
pub fn check_family(family: &str) -> Vec<String> {
    let mut failures = Vec::new();
    for row in load_captures(family) {
        let clock = Clock::fixed(
            row.now_ms.unwrap_or(FIXTURE_NOW_MS),
            row.zone.as_deref().unwrap_or(FIXTURE_ZONE),
        );
        let source = capture_vault(&row.props);
        let row_path = VaultPath::new("Capture.md").expect("a valid path");
        let base_path = VaultPath::new("Captures.base").expect("a valid path");
        let ctx = EvalContext::new(&source, &clock, &base_path, &row_path);
        let label = format!("[{}] {} `{}`", row.source, row.case, row.expr);
        // A row's expression must parse, unless the row is `invalid`: a parse
        // error is a broken row, never the error an `error` row expects.
        let parsed = parse_expression(&row.expr);
        if row.kind == "invalid" {
            if let Ok(expr) = parsed {
                failures.push(format!("{label}: expected a parse error, got {expr:?}"));
            }
            continue;
        }
        let expr = match parsed {
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
                } else if let Some(text) = expected_text(&row, &source, &row_path, &clock) {
                    let rendered = render_text(&value, &clock);
                    if rendered != text {
                        failures.push(format!("{label}: expected text {text:?}, got {rendered:?}"));
                    }
                }
            }
        }
    }
    failures
}
