//! Dates, durations, Moment formatting and Moment's `fromNow`.
//!
//! An instant is interpreted in the [`Clock`]'s zone, as Obsidian
//! interprets it in the device's. Two published rules govern arithmetic and
//! they are both kept: months and years are calendar arithmetic (the syntax
//! page's `2024-12-01 + 1M = 2025-01-01`), while days, weeks, hours,
//! minutes and seconds are exact milliseconds (the syntax page: `now() +
//! "1 day"` "returns a datetime exactly 24 hours from the time of
//! execution") — except that whole days added to a date *without* a time
//! move its calendar date, so a date stays a date across a DST change.

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

/// `YYYY-MM-DD`, then optionally `[ T]HH:mm[:ss[.SSS]]`, in local time — the
/// form the functions page names for `date()` (`YYYY-MM-DD HH:mm:ss`) and the
/// forms Obsidian's date and date-time properties store.
pub(crate) fn parse_date_text(text: &str, clock: &Clock) -> Option<DateValue> {
    let text = text.trim();
    let (day, time) = match text.find([' ', 'T']) {
        Some(at) => (&text[..at], Some(text[at + 1..].trim())),
        None => (text, None),
    };
    let mut parts = day.split('-');
    let year = number(parts.next()?)?;
    let month = number(parts.next()?)?;
    let date = number(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
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
    let local = civil.to_zoned(clock.zone.clone()).ok()?;
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
    let whole = |scale: i64| {
        Some(DurationValue {
            months: 0,
            ms: (amount * scale as f64).round() as i64,
        })
    };
    match unit {
        // `checked_mul`: a huge year count saturates the cast, and the
        // product would overflow (a panic in a debug build).
        "y" | "year" | "years" => (amount.fract() == 0.0)
            .then(|| (amount as i64).checked_mul(12))
            .flatten()
            .map(|months| DurationValue { months, ms: 0 }),
        "M" | "month" | "months" => (amount.fract() == 0.0).then_some(DurationValue {
            months: amount as i64,
            ms: 0,
        }),
        "w" | "week" | "weeks" => whole(7 * DAY_MS),
        "d" | "day" | "days" => whole(DAY_MS),
        "h" | "hour" | "hours" => whole(3_600_000),
        "m" | "minute" | "minutes" => whole(60_000),
        "s" | "second" | "seconds" => whole(1_000),
        _ => None,
    }
}

/// `date ± duration`. Every step is checked: a month or day count outside
/// jiff's span range, or a result outside its timestamp range, is an
/// argument error, never a panic and never a silent wrap to the epoch.
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
    if ms == 0 {
        return Ok(DateValue {
            epoch_ms: moved.timestamp().as_millisecond(),
            has_time: date.has_time,
        });
    }
    if !date.has_time && ms % DAY_MS == 0 {
        let span = Span::new().try_days(ms / DAY_MS).map_err(|_| overflow())?;
        moved = moved.checked_add(span).map_err(|_| overflow())?;
        return Ok(DateValue {
            epoch_ms: moved.timestamp().as_millisecond(),
            has_time: false,
        });
    }
    let epoch_ms = moved
        .timestamp()
        .as_millisecond()
        .checked_add(ms)
        .ok_or_else(overflow)?;
    Timestamp::from_millisecond(epoch_ms).map_err(|_| overflow())?;
    Ok(DateValue {
        epoch_ms,
        has_time: true,
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

/// The tokens, longest first within each letter, so `MMMM` wins over `MM`.
const TOKENS: [&str; 33] = [
    "YYYY", "YY", "Q", "MMMM", "MMM", "MM", "M", "Do", "DDDD", "DDD", "DD", "D", "dddd", "ddd",
    "dd", "d", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "SSS", "SS", "S", "A", "a", "ZZ", "Z",
    "X", "x",
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

/// Moment.js `format`, locale `en`.
pub fn format_date(date: DateValue, format: &str, clock: &Clock) -> Result<String, EvalError> {
    let at = zoned(date, clock);
    let hour = i32::from(at.hour());
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let weekday = usize::from(at.weekday().to_sunday_zero_offset() as u8);
    let offset = at.offset().seconds();
    let (sign, offset) = if offset < 0 {
        ('-', -offset)
    } else {
        ('+', offset)
    };
    let millis = i32::from(at.millisecond());
    let mut out = String::new();
    let mut rest = format;
    while let Some(c) = rest.chars().next() {
        if c == '[' {
            let close = rest.find(']').unwrap_or(rest.len());
            out.push_str(&rest[1..close]);
            rest = &rest[(close + 1).min(rest.len())..];
            continue;
        }
        if !c.is_ascii_alphabetic() {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let Some(token) = TOKENS.iter().find(|token| rest.starts_with(**token)) else {
            let run: String = rest.chars().take_while(|d| *d == c).collect();
            return Err(EvalError::UnsupportedFormatToken(run));
        };
        let year = i32::from(at.year());
        let month = i32::from(at.month());
        let day = i32::from(at.day());
        let text = match *token {
            "YYYY" => format!("{year:04}"),
            "YY" => format!("{:02}", year.rem_euclid(100)),
            "Q" => ((month - 1) / 3 + 1).to_string(),
            "MMMM" => MONTHS[(month - 1) as usize].to_string(),
            "MMM" => MONTHS[(month - 1) as usize][..3].to_string(),
            "MM" => format!("{month:02}"),
            "M" => month.to_string(),
            "Do" => ordinal(day),
            "DDDD" => format!("{:03}", at.day_of_year()),
            "DDD" => at.day_of_year().to_string(),
            "DD" => format!("{day:02}"),
            "D" => day.to_string(),
            "dddd" => WEEKDAYS[weekday].to_string(),
            "ddd" => WEEKDAYS[weekday][..3].to_string(),
            "dd" => WEEKDAYS[weekday][..2].to_string(),
            "d" => weekday.to_string(),
            "HH" => format!("{hour:02}"),
            "H" => hour.to_string(),
            "hh" => format!("{twelve:02}"),
            "h" => twelve.to_string(),
            "mm" => format!("{:02}", at.minute()),
            "m" => at.minute().to_string(),
            "ss" => format!("{:02}", at.second()),
            "s" => at.second().to_string(),
            "SSS" => format!("{millis:03}"),
            "SS" => format!("{:02}", millis / 10),
            "S" => (millis / 100).to_string(),
            "A" => (if hour < 12 { "AM" } else { "PM" }).to_string(),
            "a" => (if hour < 12 { "am" } else { "pm" }).to_string(),
            "ZZ" => format!("{sign}{:02}{:02}", offset / 3600, offset % 3600 / 60),
            "Z" => format!("{sign}{:02}:{:02}", offset / 3600, offset % 3600 / 60),
            "X" => date.epoch_ms.div_euclid(1000).to_string(),
            "x" => date.epoch_ms.to_string(),
            _ => unreachable!("every token in TOKENS has an arm"),
        };
        out.push_str(&text);
        rest = &rest[token.len()..];
    }
    Ok(out)
}

/// JavaScript's `Math.round`.
fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// Moment's `fromNow` with its default thresholds (`ss` 44, `s` 45, `m` 45,
/// `h` 22, `d` 26, `M` 11), locale `en`: the duration is measured in each
/// unit and rounded, and the first threshold that holds picks the wording.
pub(crate) fn relative(date: DateValue, clock: &Clock) -> String {
    let difference = date.epoch_ms - clock.now_ms;
    let ms = difference.unsigned_abs() as f64;
    let seconds = round(ms / 1000.0);
    let minutes = round(ms / 60_000.0);
    let hours = round(ms / 3_600_000.0);
    let days_exact = ms / DAY_MS as f64;
    let days = round(days_exact);
    let months_exact = days_exact * 4800.0 / 146_097.0;
    let months = round(months_exact);
    let years = round(months_exact / 12.0);
    let phrase = if seconds <= 44 {
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
    };
    if difference > 0 {
        format!("in {phrase}")
    } else {
        format!("{phrase} ago")
    }
}
