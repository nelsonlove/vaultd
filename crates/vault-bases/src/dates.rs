//! Dates, durations, Moment formatting and Moment's `fromNow`.
//!
//! An instant is interpreted in the [`Clock`]'s zone, as Obsidian
//! interprets it in the device's. Arithmetic is as captured (Task 13), not
//! as the syntax page words it: months and years are calendar arithmetic
//! (`2024-12-01 + 1M = 2025-01-01`), and so are the whole days in a span,
//! which keep the wall-clock time across a DST change (the page's "exactly
//! 24 hours" is not what Obsidian does); only a part of a day is exact
//! milliseconds. See [`add`].

use jiff::civil::DateTime;
use jiff::{Span, Timestamp, Zoned};

use crate::clock::Clock;
use crate::eval::EvalError;
use crate::value::{DateValue, DurationValue};

const DAY_MS: i64 = 86_400_000;

pub(crate) fn zoned(date: DateValue, clock: &Clock) -> Zoned {
    Timestamp::from_millisecond(date.epoch_ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(clock.zone.clone())
}

/// Local midnight of the day containing `epoch_ms`, without a time.
pub(crate) fn start_of_day(epoch_ms: i64, clock: &Clock) -> DateValue {
    let day = zoned(
        DateValue {
            epoch_ms,
            has_time: true,
        },
        clock,
    );
    let midnight = day.start_of_day().unwrap_or(day);
    DateValue {
        epoch_ms: midnight.timestamp().as_millisecond(),
        has_time: false,
    }
}

fn number(text: &str) -> Option<i32> {
    (!text.is_empty() && text.chars().all(|c| c.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Exactly `width` digits (captured, Task 13: `date("2025-1-1")` is empty).
fn padded(text: &str, width: usize) -> Option<i32> {
    (text.len() == width).then(|| number(text)).flatten()
}

/// A trailing `Z` or `±HH:MM` (`±HHMM`) on a time: its offset in seconds,
/// and the time without it.
fn split_offset(time: &str) -> (&str, Option<i32>) {
    if let Some(rest) = time.strip_suffix(['Z', 'z']) {
        return (rest, Some(0));
    }
    let Some(at) = time.rfind(['+', '-']) else {
        return (time, None);
    };
    let (rest, zone) = time.split_at(at);
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let digits: String = zone[1..].chars().filter(|c| *c != ':').collect();
    match (digits.len(), padded(digits.get(..2).unwrap_or(""), 2)) {
        (4, Some(hours)) => match padded(&digits[2..], 2) {
            Some(minutes) => (rest, Some(sign * (hours * 3600 + minutes * 60))),
            None => (time, None),
        },
        (2, Some(hours)) => (rest, Some(sign * hours * 3600)),
        _ => (time, None),
    }
}

/// `YYYY-MM-DD`, then optionally `[ T]HH:mm[:ss[.SSS]]` and an offset (`Z`,
/// `+02:00`), in local time when no offset is given — the form the
/// functions page names for `date()` (`YYYY-MM-DD HH:mm:ss`), the forms
/// Obsidian's date and date-time properties store, and the ISO offsets
/// `date()` reads (captured, Task 13).
pub(crate) fn parse_date_text(text: &str, clock: &Clock) -> Option<DateValue> {
    let text = text.trim();
    let (day, time) = match text.find([' ', 'T']) {
        Some(at) => (&text[..at], Some(text[at + 1..].trim())),
        None => (text, None),
    };
    let mut parts = day.split('-');
    let year = padded(parts.next()?, 4)?;
    let month = padded(parts.next()?, 2)?;
    let date = padded(parts.next()?, 2)?;
    if parts.next().is_some() {
        return None;
    }
    let (time, offset) = match time {
        Some(time) => {
            let (time, offset) = split_offset(time);
            (Some(time), offset)
        }
        None => (None, None),
    };
    let (hour, minute, second, millis) = match time {
        None => (0, 0, 0, 0),
        Some(time) => {
            let (clock_part, fraction) = match time.split_once('.') {
                Some((clock_part, fraction)) => (clock_part, Some(fraction)),
                None => (time, None),
            };
            let mut fields = clock_part.split(':');
            let hour = number(fields.next()?)?;
            let minute = number(fields.next()?)?;
            let second = match fields.next() {
                Some(second) => number(second)?,
                None => 0,
            };
            if fields.next().is_some() {
                return None;
            }
            // Checked as digits before the slice: a byte slice of a
            // multi-byte character would panic.
            let millis = match fraction {
                Some(fraction) if fraction.bytes().all(|b| b.is_ascii_digit()) => {
                    number(&format!("{fraction:0<3}")[..3])?
                }
                Some(_) => return None,
                None => 0,
            };
            (hour, minute, second, millis)
        }
    };
    let civil = DateTime::new(
        i16::try_from(year).ok()?,
        i8::try_from(month).ok()?,
        i8::try_from(date).ok()?,
        i8::try_from(hour).ok()?,
        i8::try_from(minute).ok()?,
        i8::try_from(second).ok()?,
        millis * 1_000_000,
    )
    .ok()?;
    let zone = match offset {
        Some(seconds) => jiff::tz::TimeZone::fixed(jiff::tz::Offset::from_seconds(seconds).ok()?),
        None => clock.zone.clone(),
    };
    let local = civil.to_zoned(zone).ok()?;
    Some(DateValue {
        epoch_ms: local.timestamp().as_millisecond(),
        has_time: time.is_some(),
    })
}

/// One `<number><unit>` component, the space optional and the sign allowed:
/// `1M`, `4h`, `1 day`, `-2 weeks`. The units are the syntax page's table;
/// `M` is months and `m` minutes, so the match is case-sensitive.
pub(crate) fn parse_duration_text(text: &str) -> Option<DurationValue> {
    let text = text.trim();
    let split = text
        .char_indices()
        .find(|(at, c)| *at > 0 && !c.is_ascii_digit() && *c != '.')
        .map(|(at, _)| at)?;
    let amount: f64 = text[..split].trim().parse().ok()?;
    let unit = text[split..].trim();
    let whole = |scale: i64, timed: bool| {
        let ms = (amount * scale as f64).round() as i64;
        Some(DurationValue {
            months: 0,
            ms,
            timed: timed || ms % DAY_MS != 0,
        })
    };
    match unit {
        // `checked_mul`: a huge year count saturates the cast, and the
        // product would overflow (a panic in a debug build).
        "y" | "year" | "years" => (amount.fract() == 0.0)
            .then(|| (amount as i64).checked_mul(12))
            .flatten()
            .map(|months| DurationValue {
                months,
                ms: 0,
                timed: false,
            }),
        "M" | "month" | "months" => (amount.fract() == 0.0).then_some(DurationValue {
            months: amount as i64,
            ms: 0,
            timed: false,
        }),
        "w" | "week" | "weeks" => whole(7 * DAY_MS, false),
        "d" | "day" | "days" => whole(DAY_MS, false),
        "h" | "hour" | "hours" => whole(3_600_000, true),
        "m" | "minute" | "minutes" => whole(60_000, true),
        "s" | "second" | "seconds" => whole(1_000, true),
        _ => None,
    }
}

/// `date ± duration`, as captured (Task 13): months, then the whole days in
/// the span, move the local calendar date and keep the wall-clock time even
/// across a DST change (`2026-03-07 12:00 + "24h"` is `2026-03-08 12:00` in
/// New York); only the part of a day left over is exact milliseconds (`+
/// "25h"` is `13:00`). The result carries a time when the date did or the
/// span is [`DurationValue::timed`]. Every step is checked: a month or day
/// count outside jiff's span range, or a result outside its timestamp range,
/// is an argument error, never a panic and never a silent wrap to the epoch.
pub(crate) fn add(
    date: DateValue,
    duration: DurationValue,
    sign: i64,
    clock: &Clock,
) -> Result<DateValue, EvalError> {
    let overflow = || EvalError::Argument("the date is out of range".into());
    let mut moved = zoned(date, clock);
    if duration.months != 0 {
        let months = duration.months.checked_mul(sign).ok_or_else(overflow)?;
        let span = Span::new().try_months(months).map_err(|_| overflow())?;
        moved = moved.checked_add(span).map_err(|_| overflow())?;
    }
    let ms = duration.ms.checked_mul(sign).ok_or_else(overflow)?;
    let days = ms / DAY_MS;
    if days != 0 {
        let span = Span::new().try_days(days).map_err(|_| overflow())?;
        moved = moved.checked_add(span).map_err(|_| overflow())?;
    }
    let epoch_ms = moved
        .timestamp()
        .as_millisecond()
        .checked_add(ms % DAY_MS)
        .ok_or_else(overflow)?;
    Timestamp::from_millisecond(epoch_ms).map_err(|_| overflow())?;
    Ok(DateValue {
        epoch_ms,
        has_time: date.has_time || duration.timed,
    })
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Moment's format tokens, longest first within each family, as Moment's
/// `formattingTokens` expression lists them (2.30): a run is matched against
/// these in order, and a character no token starts is copied as written
/// (captured, Task 13: `format("[at")` is `[amt`, the unclosed `[` and the
/// `t` literal, the `a` a token).
const TOKENS: [&str; 76] = [
    "Hmmss",
    "Hmm",
    "hmmss",
    "hmm",
    "Mo",
    "MMMM",
    "MMM",
    "MM",
    "M",
    "Do",
    "DDDo",
    "DDDD",
    "DDD",
    "DD",
    "D",
    "dddd",
    "ddd",
    "dd",
    "do",
    "d",
    "wo",
    "ww",
    "w",
    "Wo",
    "WW",
    "W",
    "Qo",
    "Q",
    "NNNNN",
    "NNNN",
    "NNN",
    "NN",
    "N",
    "YYYYYY",
    "YYYYY",
    "YYYY",
    "YY",
    "Y",
    "yyyy",
    "yyy",
    "yy",
    "yo",
    "y",
    "ggggg",
    "gggg",
    "gg",
    "GGGGG",
    "GGGG",
    "GG",
    "e",
    "E",
    "a",
    "A",
    "hh",
    "h",
    "HH",
    "H",
    "kk",
    "k",
    "mm",
    "m",
    "ss",
    "s",
    "SSSSSSSSS",
    "SSSSSSSS",
    "SSSSSSS",
    "SSSSSS",
    "SSSSS",
    "SSSS",
    "SSS",
    "SS",
    "S",
    "x",
    "X",
    "ZZ",
    "Z",
];

/// Moment's `en` long date formats, expanded before the tokens are read.
const LONG_FORMATS: [(&str, &str); 10] = [
    ("LTS", "h:mm:ss A"),
    ("LT", "h:mm A"),
    ("LLLL", "dddd, MMMM D, YYYY h:mm A"),
    ("LLL", "MMMM D, YYYY h:mm A"),
    ("LL", "MMMM D, YYYY"),
    ("L", "MM/DD/YYYY"),
    ("llll", "ddd, MMM D, YYYY h:mm A"),
    ("lll", "MMM D, YYYY h:mm A"),
    ("ll", "MMM D, YYYY"),
    ("l", "M/D/YYYY"),
];

fn ordinal(day: i32) -> String {
    let suffix = match (day % 100, day % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{day}{suffix}")
}

fn days_in_year(year: i32) -> i32 {
    if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
        366
    } else {
        365
    }
}

/// Moment's `firstWeekOffset`: where week 1 of `year` starts, relative to
/// 1 January, for a week starting on `dow` whose first week holds the
/// January day `7 + dow - doy`.
///
/// The weekday comes from the proleptic Gregorian calendar by arithmetic,
/// not from `jiff`, so a week next to the calendar's ends (year 9999's last
/// week reaches into year 10000) never builds a date `jiff` refuses.
fn first_week_offset(year: i32, dow: i32, doy: i32) -> i32 {
    let fwd = 7 + dow - doy;
    let fwdlw = (7 + weekday_of_january(year, fwd) - dow) % 7;
    -fwdlw + fwd - 1
}

/// The weekday (0 is Sunday) of `day` January of `year`, by Howard
/// Hinnant's `days_from_civil`, total over every `i32` year.
fn weekday_of_january(year: i32, day: i32) -> i32 {
    // January counts as month 13 of the year before.
    let year = i64::from(year) - 1;
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (13 - 3) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    // 1970-01-01 was a Thursday.
    (days + 4).rem_euclid(7) as i32
}

fn weeks_in_year(year: i32, dow: i32, doy: i32) -> i32 {
    (days_in_year(year) - first_week_offset(year, dow, doy) + first_week_offset(year + 1, dow, doy))
        / 7
}

/// Moment's `weekOfYear`: the week and its year, ISO (`dow` 1, `doy` 4) or
/// `en` (`dow` 0, `doy` 6).
fn week_of_year(year: i32, day_of_year: i32, dow: i32, doy: i32) -> (i32, i32) {
    let week = (day_of_year - first_week_offset(year, dow, doy) - 1).div_euclid(7) + 1;
    if week < 1 {
        (week + weeks_in_year(year - 1, dow, doy), year - 1)
    } else if week > weeks_in_year(year, dow, doy) {
        (week - weeks_in_year(year, dow, doy), year + 1)
    } else {
        (week, year)
    }
}

/// Moment.js `format`, locale `en`, in the clock's zone.
///
/// The format is read as Moment reads it: `[text]` is literal, `\x` is a
/// literal `x`, the `en` long formats (`LT`, `LL`, …) expand first, a token
/// is the longest of [`TOKENS`] at that point, and any other character is
/// copied. Era names are the Gregorian `AD`; a zone name (`z`) has no token
/// here, as Moment without its timezone add-on has none.
pub fn format_date(date: DateValue, format: &str, clock: &Clock) -> Result<String, EvalError> {
    let at = zoned(date, clock);
    let year = i32::from(at.year());
    let month = i32::from(at.month());
    let day = i32::from(at.day());
    let day_of_year = i32::from(at.day_of_year());
    let hour = i32::from(at.hour());
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let weekday = at.weekday().to_sunday_zero_offset() as i32;
    let offset = at.offset().seconds();
    let (sign, offset) = if offset < 0 {
        ('-', -offset)
    } else {
        ('+', offset)
    };
    let millis = i32::from(at.millisecond());
    // Week numbers only when a week token asks for them.
    let iso = || week_of_year(year, day_of_year, 1, 4);
    let en = || week_of_year(year, day_of_year, 0, 6);

    // The long formats expand first, outside brackets.
    let mut expanded = String::new();
    let mut rest = format;
    while let Some(c) = rest.chars().next() {
        if c == '[' {
            if let Some(close) = rest[1..]
                .find(['[', ']'])
                .filter(|at| rest.as_bytes()[at + 1] == b']')
            {
                expanded.push_str(&rest[..close + 2]);
                rest = &rest[close + 2..];
                continue;
            }
        }
        if c == '\\' && rest.len() > 1 {
            let next = rest[1..].chars().next().map_or(1, char::len_utf8);
            expanded.push_str(&rest[..1 + next]);
            rest = &rest[1 + next..];
            continue;
        }
        if let Some((name, long)) = LONG_FORMATS.iter().find(|(name, _)| rest.starts_with(name)) {
            expanded.push_str(long);
            rest = &rest[name.len()..];
            continue;
        }
        expanded.push(c);
        rest = &rest[c.len_utf8()..];
    }

    let mut out = String::new();
    let mut rest = expanded.as_str();
    while let Some(c) = rest.chars().next() {
        // `[…]` holding no `[` is literal; an unclosed `[` is a plain `[`.
        if c == '[' {
            if let Some(close) = rest[1..]
                .find(['[', ']'])
                .filter(|at| rest.as_bytes()[at + 1] == b']')
            {
                out.push_str(&rest[1..close + 1]);
                rest = &rest[close + 2..];
                continue;
            }
        }
        if c == '\\' && rest.len() > 1 {
            let next = rest[1..].chars().next().expect("a character follows");
            out.push(next);
            rest = &rest[1 + next.len_utf8()..];
            continue;
        }
        let Some(token) = TOKENS.iter().find(|token| rest.starts_with(**token)) else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        };
        let fraction = |digits: usize| {
            let text = format!("{millis:03}");
            if digits <= 3 {
                text[..digits].to_string()
            } else {
                format!("{text}{}", "0".repeat(digits - 3))
            }
        };
        let text = match *token {
            "Hmmss" => format!("{hour}{:02}{:02}", at.minute(), at.second()),
            "Hmm" => format!("{hour}{:02}", at.minute()),
            "hmmss" => format!("{twelve}{:02}{:02}", at.minute(), at.second()),
            "hmm" => format!("{twelve}{:02}", at.minute()),
            "Mo" => ordinal(month),
            "MMMM" => MONTHS[(month - 1) as usize].to_string(),
            "MMM" => MONTHS[(month - 1) as usize][..3].to_string(),
            "MM" => format!("{month:02}"),
            "M" => month.to_string(),
            "Do" => ordinal(day),
            "DDDo" => ordinal(day_of_year),
            "DDDD" => format!("{day_of_year:03}"),
            "DDD" => day_of_year.to_string(),
            "DD" => format!("{day:02}"),
            "D" => day.to_string(),
            "dddd" => WEEKDAYS[weekday as usize].to_string(),
            "ddd" => WEEKDAYS[weekday as usize][..3].to_string(),
            "dd" => WEEKDAYS[weekday as usize][..2].to_string(),
            "do" => ordinal(weekday),
            "d" | "e" => weekday.to_string(),
            "E" => (if weekday == 0 { 7 } else { weekday }).to_string(),
            "wo" => ordinal(en().0),
            "ww" => format!("{:02}", en().0),
            "w" => en().0.to_string(),
            "Wo" => ordinal(iso().0),
            "WW" => format!("{:02}", iso().0),
            "W" => iso().0.to_string(),
            "Qo" => ordinal((month - 1) / 3 + 1),
            "Q" => ((month - 1) / 3 + 1).to_string(),
            "NNNN" => "Anno Domini".to_string(),
            "NNNNN" | "NNN" | "NN" | "N" => "AD".to_string(),
            "YYYYYY" => format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs()),
            "YYYYY" => format!("{:05}", year),
            "YYYY" | "Y" if year <= 9999 => format!("{year:04}"),
            "YYYY" | "Y" => format!("+{year}"),
            "YY" => format!("{:02}", year.rem_euclid(100)),
            "yyyy" | "yyy" | "y" => year.to_string(),
            "yy" => format!("{:02}", year.rem_euclid(100)),
            "yo" => ordinal(year),
            "ggggg" => format!("{:05}", en().1),
            "gggg" => format!("{:04}", en().1),
            "gg" => format!("{:02}", en().1.rem_euclid(100)),
            "GGGGG" => format!("{:05}", iso().1),
            "GGGG" => format!("{:04}", iso().1),
            "GG" => format!("{:02}", iso().1.rem_euclid(100)),
            "a" => (if hour < 12 { "am" } else { "pm" }).to_string(),
            "A" => (if hour < 12 { "AM" } else { "PM" }).to_string(),
            "hh" => format!("{twelve:02}"),
            "h" => twelve.to_string(),
            "HH" => format!("{hour:02}"),
            "H" => hour.to_string(),
            "kk" => format!("{:02}", if hour == 0 { 24 } else { hour }),
            "k" => (if hour == 0 { 24 } else { hour }).to_string(),
            "mm" => format!("{:02}", at.minute()),
            "m" => at.minute().to_string(),
            "ss" => format!("{:02}", at.second()),
            "s" => at.second().to_string(),
            "x" => date.epoch_ms.to_string(),
            "X" => date.epoch_ms.div_euclid(1000).to_string(),
            "ZZ" => format!("{sign}{:02}{:02}", offset / 3600, offset % 3600 / 60),
            "Z" => format!("{sign}{:02}:{:02}", offset / 3600, offset % 3600 / 60),
            fraction_token if fraction_token.starts_with('S') => fraction(fraction_token.len()),
            other => return Err(EvalError::UnsupportedFormatToken(other.to_string())),
        };
        out.push_str(&text);
        rest = &rest[token.len()..];
    }
    Ok(out)
}

/// JavaScript's `Math.round`: a half rounds up, and the fraction is taken
/// from the floor, so `0.49999999999999994` stays 0.
fn round(value: f64) -> i64 {
    let floor = value.floor();
    (if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }) as i64
}

/// Moment's `positiveMomentsDifference`, for `base <= other`: the whole
/// calendar months between the two local dates, one fewer when adding them
/// to `base` passes `other`, and the rest in exact milliseconds.
fn months_and_ms(base: &Zoned, other: &Zoned) -> (i64, i64) {
    let plus = |months: i64| {
        let span = Span::new().try_months(months).ok()?;
        base.checked_add(span).ok()
    };
    let mut months = (i64::from(other.year()) - i64::from(base.year())) * 12
        + i64::from(other.month())
        - i64::from(base.month());
    let mut landed = plus(months);
    if landed
        .as_ref()
        .is_some_and(|at| at.timestamp() > other.timestamp())
    {
        months -= 1;
        landed = plus(months);
    }
    let end = other.timestamp().as_millisecond();
    match landed {
        Some(at) => (months, end - at.timestamp().as_millisecond()),
        None => (0, end - base.timestamp().as_millisecond()),
    }
}

/// Moment's `fromNow` (2.30), locale `en`, default thresholds (`ss` 44, `s`
/// 45, `m` 45, `h` 22, `d` 26, `M` 11). As Moment's `from` does, the span is
/// whole calendar months plus milliseconds; each unit is then measured as
/// `Duration#as` measures it (months spread into days by the average month
/// for the small units, the milliseconds folded into months for the large
/// ones) and rounded, and the first threshold that holds picks the wording.
/// Captured (Task 13): `date("2026-02-14 10:30:00").relative()` on
/// 2026-10-09 shows `8 months ago`.
pub(crate) fn relative(date: DateValue, clock: &Clock) -> String {
    let now = zoned(
        DateValue {
            epoch_ms: clock.now_ms,
            has_time: true,
        },
        clock,
    );
    let then = zoned(date, clock);
    let future = date.epoch_ms > clock.now_ms;
    let (months, ms) = if future {
        months_and_ms(&now, &then)
    } else {
        months_and_ms(&then, &now)
    };
    let phrase = humanize_parts(months, ms);
    if future {
        format!("in {phrase}")
    } else {
        format!("{phrase} ago")
    }
}

/// Moment's `Duration#humanize` without a suffix, locale `en`: how a
/// duration shows in a cell (captured, Task 13: `duration("36h")` shows
/// `2 days`, `date - date` one day apart shows `a day` in either order). The
/// sign is dropped, as Moment's `abs()` drops it.
pub fn humanize(duration: DurationValue) -> String {
    humanize_parts(
        duration.months.saturating_abs(),
        duration.ms.saturating_abs(),
    )
}

/// The wording for a span of whole `months` plus `ms` milliseconds, both
/// non-negative, with Moment's default thresholds.
fn humanize_parts(months: i64, ms: i64) -> String {
    let (months, ms) = (months as f64, ms as f64);
    let month_days = round(months * 146_097.0 / 4800.0) as f64;
    let seconds = round(month_days * 86_400.0 + ms / 1000.0);
    let minutes = round(month_days * 1440.0 + ms / 60_000.0);
    let hours = round(month_days * 24.0 + ms / 3_600_000.0);
    let days = round(month_days + ms / DAY_MS as f64);
    let months_exact = months + ms / DAY_MS as f64 * 4800.0 / 146_097.0;
    let months = round(months_exact);
    let years = round(months_exact / 12.0);
    if seconds <= 44 {
        "a few seconds".to_string()
    } else if seconds < 45 {
        format!("{seconds} seconds")
    } else if minutes <= 1 {
        "a minute".to_string()
    } else if minutes < 45 {
        format!("{minutes} minutes")
    } else if hours <= 1 {
        "an hour".to_string()
    } else if hours < 22 {
        format!("{hours} hours")
    } else if days <= 1 {
        "a day".to_string()
    } else if days < 26 {
        format!("{days} days")
    } else if months <= 1 {
        "a month".to_string()
    } else if months < 11 {
        format!("{months} months")
    } else if years <= 1 {
        "a year".to_string()
    } else {
        format!("{years} years")
    }
}
