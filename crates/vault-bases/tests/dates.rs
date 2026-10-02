use vault_bases::eval::{EvalContext, EvalError, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE, check_family, render_text};
use vault_bases::{
    Clock, DateValue, DurationValue, MemoryFile, MemorySource, PropertyType, Value, format_date,
    text,
};
use vault_core::VaultPath;

#[test]
fn the_date_family_holds() {
    let failures = check_family("date");
    assert!(
        failures.is_empty(),
        "{} date rows disagree:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn run(source: &MemorySource, expression: &str) -> Value {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let row = VaultPath::new("Task.md").unwrap();
    let base = VaultPath::new("Tasks.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base, &row);
    evaluate(
        &parse_expression(expression).unwrap(),
        &ctx,
        &Scope::row(&row),
    )
    .unwrap()
}

#[test]
fn a_date_typed_property_is_a_date_and_an_untyped_one_stays_text() {
    let source = MemorySource::new()
        .with(
            "Task.md",
            MemoryFile::note()
                .property("due", text("2025-01-01"))
                .property("stamp", text("2025-01-01T10:15:00"))
                .property("memo", text("2025-01-01")),
        )
        .typed("due", PropertyType::Date)
        .typed("stamp", PropertyType::DateTime);
    assert_eq!(run(&source, "due.isType(\"date\")"), Value::Boolean(true));
    assert_eq!(
        run(&source, "due.format(\"YYYY-MM-DD\")"),
        Value::String("2025-01-01".into())
    );
    assert_eq!(
        run(&source, "stamp.format(\"HH:mm\")"),
        Value::String("10:15".into())
    );
    assert_eq!(
        run(&source, "memo.isType(\"string\")"),
        Value::Boolean(true)
    );
    assert_eq!(run(&source, "due < today()"), Value::Boolean(true));
}

#[test]
fn a_date_typed_property_that_does_not_parse_stays_text() {
    let source = MemorySource::new()
        .with(
            "Task.md",
            MemoryFile::note().property("due", text("someday")),
        )
        .typed("due", PropertyType::Date);
    assert_eq!(run(&source, "due"), Value::String("someday".into()));
}

fn eval_at(now_ms: i64, zone: &str, expression: &str) -> Result<Value, EvalError> {
    let clock = Clock::fixed(now_ms, zone);
    let source = MemorySource::new().with("Task.md", MemoryFile::note());
    let row = VaultPath::new("Task.md").unwrap();
    let base = VaultPath::new("Tasks.base").unwrap();
    let ctx = EvalContext::new(&source, &clock, &base, &row);
    evaluate(
        &parse_expression(expression).unwrap(),
        &ctx,
        &Scope::row(&row),
    )
}

fn eval(expression: &str) -> Result<Value, EvalError> {
    eval_at(FIXTURE_NOW_MS, FIXTURE_ZONE, expression)
}

fn string(expression: &str) -> String {
    match eval(expression) {
        Ok(Value::String(text)) => text,
        other => panic!("{expression}: expected a string, got {other:?}"),
    }
}

/// Every Moment token on the brief's list, one at a time, on a fixed
/// instant whose fields all differ from their padded forms: Monday
/// 2025-02-03 04:05:06.789 in New York (-05:00), epoch 1738573506789.
#[test]
fn every_listed_moment_token_formats_a_fixed_instant() {
    let at = "date(\"2025-02-03 04:05:06.789\")";
    let cases = [
        ("YYYY", "2025"),
        ("YY", "25"),
        ("Q", "1"),
        ("MMMM", "February"),
        ("MMM", "Feb"),
        ("MM", "02"),
        ("M", "2"),
        ("Do", "3rd"),
        ("DDDD", "034"),
        ("DDD", "34"),
        ("DD", "03"),
        ("D", "3"),
        ("dddd", "Monday"),
        ("ddd", "Mon"),
        ("dd", "Mo"),
        ("d", "1"),
        ("HH", "04"),
        ("H", "4"),
        ("hh", "04"),
        ("h", "4"),
        ("mm", "05"),
        ("m", "5"),
        ("ss", "06"),
        ("s", "6"),
        ("SSS", "789"),
        ("SS", "78"),
        ("S", "7"),
        ("A", "AM"),
        ("a", "am"),
        ("ZZ", "-0500"),
        ("Z", "-05:00"),
        ("X", "1738573506"),
        ("x", "1738573506789"),
        ("[at] HH", "at 04"),
        ("[Do not] YYYY", "Do not 2025"),
    ];
    for (format, expected) in cases {
        assert_eq!(
            string(&format!("{at}.format({format:?})")),
            expected,
            "token {format}"
        );
    }
}

#[test]
fn twelve_hour_tokens_meridiem_and_ordinals_turn_at_their_edges() {
    let at = |time: &str| string(&format!("date(\"2025-02-03 {time}\").format(\"h hh A a\")"));
    assert_eq!(at("00:00:00"), "12 12 AM am");
    assert_eq!(at("11:59:00"), "11 11 AM am");
    assert_eq!(at("12:00:00"), "12 12 PM pm");
    assert_eq!(at("16:00:00"), "4 04 PM pm");
    for (day, expected) in [
        (1, "1st"),
        (2, "2nd"),
        (3, "3rd"),
        (4, "4th"),
        (11, "11th"),
        (12, "12th"),
        (13, "13th"),
        (21, "21st"),
        (22, "22nd"),
        (23, "23rd"),
        (31, "31st"),
    ] {
        assert_eq!(
            string(&format!("date(\"2025-01-{day:02}\").format(\"Do\")")),
            expected
        );
    }
}

#[test]
fn the_offset_tokens_follow_the_injected_zone() {
    let in_zone = |zone: &str| eval_at(FIXTURE_NOW_MS, zone, "now().format(\"Z ZZ HH:mm\")");
    assert_eq!(
        in_zone("Asia/Kolkata"),
        Ok(Value::String("+05:30 +0530 21:00".into()))
    );
    assert_eq!(
        in_zone("UTC"),
        Ok(Value::String("+00:00 +0000 15:30".into()))
    );
    assert_eq!(
        in_zone("America/New_York"),
        Ok(Value::String("-05:00 -0500 10:30".into()))
    );
}

#[test]
fn any_other_format_letter_is_an_unsupported_token_named() {
    for (format, token) in [
        ("W", "W"),
        ("WW", "WW"),
        ("YYYY-ww", "ww"),
        ("k", "k"),
        ("E", "E"),
    ] {
        assert_eq!(
            eval(&format!("now().format({format:?})")),
            Err(EvalError::UnsupportedFormatToken(token.into())),
            "format {format}"
        );
    }
    // Escaped letters and non-letters are not tokens.
    assert_eq!(string("now().format(\"[W] -/:.,\")"), "W -/:.,");
}

#[test]
fn now_and_today_come_from_the_injected_clock() {
    let later = FIXTURE_NOW_MS + 3 * 86_400_000 + 3_600_000;
    let at = |now_ms: i64, expression: &str| eval_at(now_ms, FIXTURE_ZONE, expression);
    let now = "now().format(\"YYYY-MM-DD HH:mm\")";
    assert_eq!(
        at(FIXTURE_NOW_MS, now),
        Ok(Value::String("2026-01-15 10:30".into()))
    );
    assert_eq!(at(later, now), Ok(Value::String("2026-01-18 11:30".into())));
    let today = "today().format(\"YYYY-MM-DD HH:mm\")";
    assert_eq!(
        at(FIXTURE_NOW_MS, today),
        Ok(Value::String("2026-01-15 00:00".into()))
    );
    assert_eq!(
        at(later, today),
        Ok(Value::String("2026-01-18 00:00".into()))
    );
    assert_ne!(at(FIXTURE_NOW_MS, "now()"), at(later, "now()"));
    assert_ne!(at(FIXTURE_NOW_MS, "today()"), at(later, "today()"));
    // today() is local midnight in the injected zone, not in UTC.
    assert_eq!(
        eval_at(
            FIXTURE_NOW_MS,
            "Asia/Kolkata",
            "today().format(\"YYYY-MM-DD HH:mm Z\")"
        ),
        Ok(Value::String("2026-01-15 00:00 +05:30".into()))
    );
    assert_eq!(
        eval_at(
            FIXTURE_NOW_MS,
            "Pacific/Kiritimati",
            "today().format(\"YYYY-MM-DD\")"
        ),
        Ok(Value::String("2026-01-16".into()))
    );
}

#[test]
fn the_has_time_flag_is_set_by_parsing_and_kept_by_calendar_arithmetic() {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let has_time = |expression: &str| match eval(expression) {
        Ok(Value::Date(date)) => date.has_time,
        other => panic!("{expression}: expected a date, got {other:?}"),
    };
    assert!(!has_time("date(\"2025-01-01\")"));
    assert!(has_time("date(\"2025-01-01 00:00\")"));
    assert!(has_time("date(\"2025-01-01T00:00:00\")"));
    assert!(has_time("now()"));
    assert!(!has_time("today()"));
    assert!(!has_time("now().date()"));
    assert!(!has_time("today() + \"1M\""));
    assert!(!has_time("today() - \"2w\""));
    assert!(has_time("today() + \"36h\""));
    assert!(has_time("now() + \"1d\""));
    let rendered = |expression: &str| render_text(&eval(expression).unwrap(), &clock);
    assert_eq!(rendered("date(\"2025-01-01\")"), "2025-01-01");
    assert_eq!(
        rendered("date(\"2025-01-01 00:00:00\")"),
        "2025-01-01 00:00"
    );
    // An explicit format shows what it names, flag or not.
    let without_time = DateValue {
        epoch_ms: 1_738_573_506_789,
        has_time: false,
    };
    assert_eq!(
        format_date(without_time, "YYYY-MM-DD HH:mm", &clock),
        Ok("2025-02-03 04:05".into())
    );
}

#[test]
fn date_fields_read_the_local_calendar() {
    let field = |name: &str| eval(&format!("date(\"2025-02-03 04:05:06.789\").{name}"));
    for (name, expected) in [
        ("year", 2025.0),
        ("month", 2.0),
        ("day", 3.0),
        ("hour", 4.0),
        ("minute", 5.0),
        ("second", 6.0),
        ("millisecond", 789.0),
    ] {
        assert_eq!(field(name), Ok(Value::Number(expected)), "field {name}");
    }
    assert_eq!(
        field("week"),
        Err(EvalError::NoSuchField {
            target: "date",
            name: "week".into()
        })
    );
}

#[test]
fn durations_add_subtract_and_scale() {
    let duration = |months: i64, ms: i64| Ok(Value::Duration(DurationValue { months, ms }));
    assert_eq!(
        string(
            "(date(\"2024-01-31\") + (duration(\"1M\") + duration(\"1d\"))).format(\"YYYY-MM-DD\")"
        ),
        "2024-03-01"
    );
    assert_eq!(
        eval("duration(\"2h\") - duration(\"30m\")"),
        duration(0, 5_400_000)
    );
    assert_eq!(eval("duration(\"1y\") * 1.5"), duration(18, 0));
    assert_eq!(
        eval("duration(duration(\"-2 weeks\"))"),
        duration(0, -14 * 86_400_000)
    );
    assert_eq!(
        string("(now() - duration(\"90m\")).format(\"HH:mm\")"),
        "09:00"
    );
    assert_eq!(string("(now() + \"1.5h\").format(\"HH:mm\")"), "12:00");
    // `M` is months and `m` minutes.
    assert_eq!(
        string("(now() + \"1m\").format(\"YYYY-MM-DD HH:mm\")"),
        "2026-01-15 10:31"
    );
    assert_eq!(
        string("(now() + \"1M\").format(\"YYYY-MM-DD HH:mm\")"),
        "2026-02-15 10:30"
    );
    assert_eq!(
        eval("date(\"2024-01-01\") > date(\"2024-02-01\")"),
        Ok(Value::Boolean(false))
    );
    assert_eq!(eval("now() == now()"), Ok(Value::Boolean(true)));
    assert_eq!(eval("today() < now()"), Ok(Value::Boolean(true)));
}

/// Provisional wording (Moment's `fromNow`), settled by Task 13's capture.
#[test]
fn relative_turns_at_moments_default_thresholds() {
    for (offset, expected) in [
        ("44s", "a few seconds ago"),
        ("46s", "a minute ago"),
        ("2m", "2 minutes ago"),
        ("44m", "44 minutes ago"),
        ("46m", "an hour ago"),
        ("21h", "21 hours ago"),
        ("23h", "a day ago"),
        ("25d", "25 days ago"),
        ("27d", "a month ago"),
        ("3M", "3 months ago"),
        ("13M", "a year ago"),
    ] {
        assert_eq!(
            string(&format!("(now() - {offset:?}).relative()")),
            expected,
            "minus {offset}"
        );
    }
    assert_eq!(string("now().relative()"), "a few seconds ago");
    assert_eq!(string("(now() + \"3d\").relative()"), "in 3 days");
}

#[test]
fn bad_dates_durations_and_overflows_are_typed_errors_never_panics() {
    for expression in [
        "date(\"not a date\")",
        "date(\"2025-02-30\")",
        "date(\"2025-01-01 25:00\")",
        "date(\"2025-01-01 10:00:00.é\")",
        "date(\"2025-01-01 10:00:00.1x\")",
        "date(1)",
        "date()",
        "duration(\"soon\")",
        "duration(\"1.5M\")",
        "duration(\"99999999999999999999y\")",
        "duration(5)",
        "2 * duration(\"5h\")",
        "now() + \"soon\"",
        "date(\"2025-01-01\") + \"200000y\"",
        "date(\"2025-01-01\") + \"9999999999999d\"",
        "now() + \"9999999999999d\"",
        "now() - \"9999999999999d\"",
        "duration(\"9223372036854775807s\") + duration(\"9223372036854775807s\")",
        "duration(\"9223372036854775807s\") - duration(\"-9223372036854775807s\")",
        "now(1)",
        "today(1)",
        "now().date(1)",
        "now().time(1)",
        "now().relative(1)",
        "now().isEmpty(1)",
        "now().format()",
        "now().format(1)",
    ] {
        match eval(expression) {
            Err(EvalError::Argument(_)) => {}
            other => panic!("{expression}: expected an Argument error, got {other:?}"),
        }
    }
    assert_eq!(
        eval("now().nope()"),
        Err(EvalError::NoSuchMethod {
            target: "date",
            name: "nope".into()
        })
    );
    assert!(matches!(eval("now() + 1"), Err(EvalError::Type(_))));
    assert!(matches!(eval("1 + now()"), Err(EvalError::Type(_))));
}
