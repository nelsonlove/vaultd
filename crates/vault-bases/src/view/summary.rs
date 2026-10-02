//! The built-in summaries of the syntax page's "Default Summary Formulas"
//! table.

use crate::eval::EvalError;
use crate::eval::coerce::{sort_order, strict_equals};
use crate::value::{DateValue, Value};

/// The syntax page's "Default Summary Formulas" table. `Range` appears there
/// twice (numbers, dates); one name serves both and the input decides.
pub const BUILTIN_SUMMARIES: [&str; 14] = [
    "Average",
    "Min",
    "Max",
    "Sum",
    "Range",
    "Median",
    "Stddev",
    "Earliest",
    "Latest",
    "Checked",
    "Unchecked",
    "Empty",
    "Filled",
    "Unique",
];

fn numbers(values: &[Value]) -> Vec<f64> {
    values
        .iter()
        .filter_map(|value| match value {
            Value::Number(number) => Some(*number),
            _ => None,
        })
        .collect()
}

fn dates(values: &[Value]) -> Vec<DateValue> {
    values
        .iter()
        .filter_map(|value| match value {
            Value::Date(date) => Some(*date),
            _ => None,
        })
        .collect()
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::List(items) => items.is_empty(),
        Value::Object(entries) => entries.is_empty(),
        _ => false,
    }
}

fn count(values: &[Value], keep: impl Fn(&Value) -> bool) -> Value {
    Value::Number(values.iter().filter(|value| keep(value)).count() as f64)
}

fn mean(numbers: &[f64]) -> f64 {
    numbers.iter().sum::<f64>() / numbers.len() as f64
}

fn smallest(numbers: &[f64]) -> f64 {
    numbers.iter().copied().fold(f64::INFINITY, f64::min)
}

fn largest(numbers: &[f64]) -> f64 {
    numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max)
}

/// One built-in summary over one column's values (an error cell counts as
/// `null`). An aggregate over no qualifying input is `null` (an empty
/// summary cell), never a number made up. Number aggregates read only the
/// numbers in the column, date aggregates only the dates.
pub(crate) fn builtin(name: &str, values: &[Value]) -> Result<Value, EvalError> {
    let numbers = numbers(values);
    let over_numbers = |aggregate: fn(&[f64]) -> f64| {
        if numbers.is_empty() {
            Value::Null
        } else {
            Value::Number(aggregate(&numbers))
        }
    };
    Ok(match name {
        "Average" => over_numbers(mean),
        "Sum" => Value::Number(numbers.iter().sum()),
        "Min" => over_numbers(smallest),
        "Max" => over_numbers(largest),
        "Median" => over_numbers(|numbers| {
            let mut sorted = numbers.to_vec();
            sorted.sort_by(f64::total_cmp);
            let half = sorted.len() / 2;
            if sorted.len() % 2 == 1 {
                sorted[half]
            } else {
                (sorted[half - 1] + sorted[half]) / 2.0
            }
        }),
        // Population standard deviation, the reading of the syntax page's
        // "standard deviation of all numbers". **Provisional**:
        // `summary:stddev` (Task 13) confirms the divisor.
        "Stddev" => over_numbers(|numbers| {
            let mean = mean(numbers);
            let squares: f64 = numbers.iter().map(|x| (x - mean).powi(2)).sum();
            (squares / numbers.len() as f64).sqrt()
        }),
        // Over dates, the span in milliseconds: the same number `latest -
        // earliest` answers (date minus date is a number of milliseconds).
        // **Provisional** until a capture shows how Obsidian presents it.
        "Range" => {
            let dates = dates(values);
            if numbers.is_empty() && !dates.is_empty() {
                let earliest = dates.iter().map(|d| d.epoch_ms).min().unwrap_or(0);
                let latest = dates.iter().map(|d| d.epoch_ms).max().unwrap_or(0);
                Value::Number((latest - earliest) as f64)
            } else {
                over_numbers(|numbers| largest(numbers) - smallest(numbers))
            }
        }
        "Earliest" | "Latest" => {
            let mut dates = dates(values);
            dates.sort_by(|a, b| sort_order(&Value::Date(*a), &Value::Date(*b)));
            let pick = if name == "Earliest" {
                dates.first()
            } else {
                dates.last()
            };
            pick.map_or(Value::Null, |date| Value::Date(*date))
        }
        "Checked" => count(values, |value| matches!(value, Value::Boolean(true))),
        "Unchecked" => count(values, |value| matches!(value, Value::Boolean(false))),
        "Empty" => count(values, is_empty),
        "Filled" => count(values, |value| !is_empty(value)),
        "Unique" => {
            let mut seen: Vec<&Value> = Vec::new();
            for value in values {
                if !seen.iter().any(|have| strict_equals(have, value)) {
                    seen.push(value);
                }
            }
            Value::Number(seen.len() as f64)
        }
        _ => return Err(EvalError::UnknownFunction(name.to_string())),
    })
}
