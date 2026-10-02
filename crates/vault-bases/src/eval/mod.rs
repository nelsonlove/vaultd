//! The tree walker.
//!
//! One call evaluates one expression for one row. Errors are values the
//! caller decides about: a filter treats an error as "row excluded" only
//! where Task 7's capture says so, and a cell renders it as an error cell —
//! never a dropped row (the spec's error-handling section).

pub mod coerce;

use std::cell::Cell;

use vault_core::{PropertyValue, VaultPath};

use crate::clock::Clock;
use crate::expr::{BinaryOp, Expr, UnaryOp};
use crate::functions;
use crate::source::{RowSource, SourceError};
use crate::value::{RegexpValue, Value};

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum EvalError {
    #[error("{0}")]
    Type(String),
    #[error("division by zero")]
    DivisionByZero,
    #[error("unknown function {0}")]
    UnknownFunction(String),
    #[error("{target} has no method {name}")]
    NoSuchMethod { target: &'static str, name: String },
    #[error("{target} has no field {name}")]
    NoSuchField { target: &'static str, name: String },
    #[error("no formula named {0}")]
    UnknownFormula(String),
    #[error("formula cycle through {0}")]
    FormulaCycle(String),
    #[error("{0} is not captured yet")]
    Uncaptured(String),
    #[error("unsupported format token {0}")]
    UnsupportedFormatToken(String),
    #[error("{0}")]
    Argument(String),
    #[error(transparent)]
    Source(#[from] SourceError),
}

/// How `formula.x` is answered. A view supplies a memoizing table (Task 7);
/// a bare expression has none.
pub trait Formulas {
    fn formula(&self, name: &str, ctx: &EvalContext<'_>, scope: &Scope)
    -> Result<Value, EvalError>;
}

/// The answer when there is no formula table.
pub struct NoFormulas;

impl Formulas for NoFormulas {
    fn formula(&self, name: &str, _: &EvalContext<'_>, _: &Scope) -> Result<Value, EvalError> {
        Err(EvalError::UnknownFormula(name.to_string()))
    }
}

/// Everything constant across one evaluation of a view.
pub struct EvalContext<'a> {
    pub source: &'a dyn RowSource,
    pub clock: &'a Clock,
    pub base_path: &'a VaultPath,
    /// The embedding note, or the base itself when nothing embeds it.
    pub this_path: &'a VaultPath,
    pub formulas: &'a dyn Formulas,
    random_state: Cell<u64>,
}

impl<'a> EvalContext<'a> {
    pub fn new(
        source: &'a dyn RowSource,
        clock: &'a Clock,
        base_path: &'a VaultPath,
        this_path: &'a VaultPath,
    ) -> Self {
        Self {
            source,
            clock,
            base_path,
            this_path,
            formulas: &NoFormulas,
            // Any non-zero seed; xorshift never leaves zero once off it.
            random_state: Cell::new((clock.now_ms as u64) | 1),
        }
    }

    pub fn with_formulas(mut self, formulas: &'a dyn Formulas) -> Self {
        self.formulas = formulas;
        self
    }

    /// A number in `[0, 1)`. The functions page: "The number generation
    /// refreshes whenever a view is loaded" — so it is seeded per evaluation,
    /// and determinism across clients is a non-goal (the spec).
    pub(crate) fn next_random(&self) -> f64 {
        let mut x = self.random_state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.random_state.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The names in scope for one evaluation: the row being evaluated (absent
/// for a summary over `values`) and the lambda locals a list method binds.
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub row: Option<VaultPath>,
    pub locals: Vec<(String, Value)>,
}

impl Scope {
    pub fn row(path: &VaultPath) -> Self {
        Self {
            row: Some(path.clone()),
            locals: Vec::new(),
        }
    }

    /// This scope plus one more local, shadowing an outer one of that name.
    pub fn bind(&self, name: &str, value: Value) -> Self {
        let mut next = self.clone();
        next.locals.retain(|(have, _)| have != name);
        next.locals.push((name.to_string(), value));
        next
    }

    fn local(&self, name: &str) -> Option<&Value> {
        self.locals
            .iter()
            .rev()
            .find(|(have, _)| have == name)
            .map(|(_, value)| value)
    }
}

/// A YAML property value as a Bases value. A declared date type is applied
/// by `functions::typed_property`; links in frontmatter by
/// `functions::link::frontmatter_links` (Task 6). Here: the YAML types.
pub(crate) fn property_value(value: &PropertyValue) -> Value {
    match value {
        PropertyValue::Null => Value::Null,
        PropertyValue::Boolean(flag) => Value::Boolean(*flag),
        PropertyValue::Integer(number) => Value::Number(*number as f64),
        PropertyValue::Float(number) => Value::Number(*number),
        PropertyValue::String(text) => Value::String(text.clone()),
        PropertyValue::Sequence(items) => Value::List(
            items
                .iter()
                .map(|item| property_value(&item.value))
                .collect(),
        ),
        PropertyValue::Mapping(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.value.clone(), property_value(&value.value)))
                .collect(),
        ),
    }
}

/// A note property of the current row, by exact key. Missing is `null`.
pub(crate) fn row_property(
    ctx: &EvalContext<'_>,
    scope: &Scope,
    key: &str,
) -> Result<Value, EvalError> {
    let Some(row) = &scope.row else {
        return Ok(Value::Null);
    };
    let properties = ctx.source.properties(row)?;
    Ok(properties
        .iter()
        .find(|(have, _)| have == key)
        .map(|(_, value)| functions::typed_property(ctx, key, value))
        .unwrap_or(Value::Null))
}

fn row_file(scope: &Scope) -> Result<Value, EvalError> {
    scope
        .row
        .clone()
        .map(Value::File)
        .ok_or_else(|| EvalError::Type("`file` has no row here".into()))
}

fn arithmetic(
    op: BinaryOp,
    left: Value,
    right: Value,
    ctx: &EvalContext<'_>,
) -> Result<Value, EvalError> {
    if let Some(value) = functions::date_arithmetic(op, &left, &right, ctx)? {
        return Ok(value);
    }
    let finite = |number: f64| {
        if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(EvalError::Type("the result is not a finite number".into()))
        }
    };
    match (op, &left, &right) {
        (BinaryOp::Add, Value::Number(a), Value::Number(b)) => finite(a + b),
        (BinaryOp::Sub, Value::Number(a), Value::Number(b)) => finite(a - b),
        (BinaryOp::Mul, Value::Number(a), Value::Number(b)) => finite(a * b),
        (BinaryOp::Div, Value::Number(_), Value::Number(b)) if *b == 0.0 => {
            Err(EvalError::DivisionByZero)
        }
        (BinaryOp::Rem, Value::Number(_), Value::Number(b)) if *b == 0.0 => {
            Err(EvalError::DivisionByZero)
        }
        (BinaryOp::Div, Value::Number(a), Value::Number(b)) => finite(a / b),
        (BinaryOp::Rem, Value::Number(a), Value::Number(b)) => finite(a % b),
        (BinaryOp::Add, Value::String(_), Value::Null)
        | (BinaryOp::Add, Value::Null, Value::String(_)) => {
            Err(EvalError::Uncaptured("add:string:null".into()))
        }
        (BinaryOp::Add, Value::String(_), _) | (BinaryOp::Add, _, Value::String(_)) => Ok(
            Value::String(coerce::to_display_string(&left)? + &coerce::to_display_string(&right)?),
        ),
        (_, Value::Null, _) | (_, _, Value::Null) => {
            Err(EvalError::Uncaptured("arith:null".into()))
        }
        _ => Err(EvalError::Type(format!(
            "cannot apply {op:?} to {} and {}",
            left.type_name(),
            right.type_name()
        ))),
    }
}

/// JavaScript's `\s`: `WhiteSpace` and `LineTerminator`, as class members in
/// the `regex` crate's syntax. Rust's Unicode `\s` adds U+0085 and lacks
/// U+FEFF.
const JS_SPACE_CLASS: &str =
    r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Rewrite JavaScript's character-class escapes into the `regex` crate's
/// syntax with JavaScript's meaning. Without the `u` flag JavaScript's `\d`
/// is `[0-9]`, `\w` is `[0-9A-Za-z_]` and `\b` is the boundary of that `\w`;
/// the `regex` crate's are Unicode-wide (`\d` matches `٣`). `\s` is spelled
/// out as [`JS_SPACE_CLASS`]. Inside a class (`[\d.]`) the members are
/// inlined, or nested as a negated class for `\D`, `\W`, `\S`. Every other
/// escape is copied as written.
fn javascript_classes(source: &str) -> String {
    const WORD: &str = "0-9A-Za-z_";
    let mut out = String::with_capacity(source.len() + 16);
    let mut in_class = false;
    let mut chars = source.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(escaped) = chars.next() else {
                    out.push('\\');
                    break;
                };
                let rewritten = match (escaped, in_class) {
                    ('d', false) => "[0-9]".to_string(),
                    ('d', true) => "0-9".to_string(),
                    ('D', _) => "[^0-9]".to_string(),
                    // `(?-i:…)` so that case folding cannot widen the class
                    // (the `regex` crate folds `k` to the Kelvin sign).
                    ('w', false) => format!("(?-i:[{WORD}])"),
                    ('w', true) => WORD.to_string(),
                    ('W', _) => format!("[^{WORD}]"),
                    ('s', false) => format!("[{JS_SPACE_CLASS}]"),
                    ('s', true) => JS_SPACE_CLASS.to_string(),
                    ('S', _) => format!("[^{JS_SPACE_CLASS}]"),
                    ('b', false) => r"(?-u:\b)".to_string(),
                    ('B', false) => r"(?-u:\B)".to_string(),
                    (other, _) => format!("\\{other}"),
                };
                out.push_str(&rewritten);
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Compile a regular expression literal. The `regex` crate has no
/// look-around and no back-references; a pattern that needs them is an
/// argument error naming the pattern, never a silently different match.
///
/// Flags: `i`, `m`, `s` map onto the builder; `g` is read by `replace`; `u`
/// and `d` change nothing the evaluator exposes (`d` adds match indices no
/// function returns). `y` (sticky) is refused: it anchors each match at the
/// expression's `lastIndex`, state a Bases value does not carry, so no
/// function could honour it. A repeated flag is refused, as JavaScript
/// refuses it.
pub(crate) fn compile_regexp(source: &str, flags: &str) -> Result<RegexpValue, EvalError> {
    let mut builder = regex::RegexBuilder::new(&javascript_classes(source));
    for (at, flag) in flags.char_indices() {
        if flags[..at].contains(flag) {
            return Err(EvalError::Argument(format!(
                "regular expression flag {flag:?} is repeated"
            )));
        }
        match flag {
            'i' => {
                builder.case_insensitive(true);
            }
            'm' => {
                builder.multi_line(true);
            }
            's' => {
                builder.dot_matches_new_line(true);
            }
            'g' | 'u' | 'd' => {}
            'y' => {
                return Err(EvalError::Argument(
                    "the sticky regular expression flag 'y' is not supported".into(),
                ));
            }
            other => {
                return Err(EvalError::Argument(format!(
                    "unknown regular expression flag {other:?}"
                )));
            }
        }
    }
    let regex = builder.build().map_err(|error| {
        EvalError::Argument(format!(
            "unsupported regular expression /{source}/: {error}"
        ))
    })?;
    Ok(RegexpValue {
        source: source.to_string(),
        flags: flags.to_string(),
        regex: std::sync::Arc::new(regex),
    })
}

/// Evaluate `expr` for one row.
///
/// The walk recurses once per tree level, and the parser caps a tree at
/// [`crate::expr::MAX_DEPTH`] levels, so the recursion is bounded.
/// Each node kind is its own small function: one large `match` here would
/// give every level the frame of the largest arm, and a debug build at the
/// cap would then overflow a 2 MiB thread stack (the
/// `the_walk_fits_a_two_mebibyte_stack_at_the_nesting_cap` test).
pub fn evaluate(expr: &Expr, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match expr {
        Expr::Null => Ok(Value::Null),
        Expr::Boolean(flag) => Ok(Value::Boolean(*flag)),
        Expr::Number(number) => Ok(Value::Number(*number)),
        Expr::String(text) => Ok(Value::String(text.clone())),
        Expr::Regexp { source, flags } => compile_regexp(source, flags).map(Value::Regexp),
        Expr::List(items) => list(items, ctx, scope),
        Expr::Object(entries) => object(entries, ctx, scope),
        Expr::Identifier(name) => identifier(name, ctx, scope),
        Expr::Member { target, name } => member(target, name, ctx, scope),
        Expr::Index { target, index } => index_of(target, index, ctx, scope),
        Expr::Call { name, args, .. } => functions::call_global(name, args, ctx, scope),
        Expr::Method {
            target, name, args, ..
        } => method(target, name, args, ctx, scope),
        Expr::Unary { op, operand } => unary(*op, operand, ctx, scope),
        Expr::Binary { op, left, right } => binary(*op, left, right, ctx, scope),
    }
}

#[inline(never)]
fn list(items: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    Ok(Value::List(
        items
            .iter()
            .map(|item| evaluate(item, ctx, scope))
            .collect::<Result<_, _>>()?,
    ))
}

#[inline(never)]
fn object(
    entries: &[(String, Expr)],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    Ok(Value::Object(
        entries
            .iter()
            .map(|(key, value)| Ok((key.clone(), evaluate(value, ctx, scope)?)))
            .collect::<Result<_, EvalError>>()?,
    ))
}

#[inline(never)]
fn identifier(name: &str, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    if let Some(value) = scope.local(name) {
        return Ok(value.clone());
    }
    match name {
        "this" => Ok(Value::File(ctx.this_path.clone())),
        "file" => row_file(scope),
        "note" => {
            let Some(row) = &scope.row else {
                return Ok(Value::Null);
            };
            Ok(Value::Object(
                ctx.source
                    .properties(row)?
                    .iter()
                    .map(|(key, value)| (key.clone(), functions::typed_property(ctx, key, value)))
                    .collect(),
            ))
        }
        _ => row_property(ctx, scope, name),
    }
}

#[inline(never)]
fn member(
    target: &Expr,
    name: &str,
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if let Expr::Identifier(root) = target {
        if scope.local(root).is_none() {
            match root.as_str() {
                "note" => return row_property(ctx, scope, name),
                "formula" => return ctx.formulas.formula(name, ctx, scope),
                _ => {}
            }
        }
    }
    let value = evaluate(target, ctx, scope)?;
    match value {
        Value::Object(entries) => Ok(entries
            .into_iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .unwrap_or(Value::Null)),
        other => functions::field(&other, name, ctx),
    }
}

#[inline(never)]
fn index_of(
    target: &Expr,
    index: &Expr,
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if let (Expr::Identifier(root), Expr::String(key)) = (target, index) {
        if root == "note" && scope.local(root).is_none() {
            return row_property(ctx, scope, key);
        }
    }
    let value = evaluate(target, ctx, scope)?;
    let index = evaluate(index, ctx, scope)?;
    match (value, index) {
        (Value::List(items), Value::Number(at)) => Ok(if at >= 0.0 && at.fract() == 0.0 {
            items.get(at as usize).cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        }),
        (Value::Object(entries), Value::String(key)) => Ok(entries
            .into_iter()
            .find(|(have, _)| *have == key)
            .map(|(_, value)| value)
            .unwrap_or(Value::Null)),
        (Value::Null, _) => Ok(Value::Null),
        (Value::String(_), _) => Err(EvalError::Uncaptured("index:string".into())),
        (target, index) => Err(EvalError::Type(format!(
            "cannot index {} with {}",
            target.type_name(),
            index.type_name()
        ))),
    }
}

#[inline(never)]
fn method(
    target: &Expr,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let value = evaluate(target, ctx, scope)?;
    functions::call_method(value, name, args, ctx, scope)
}

#[inline(never)]
fn unary(
    op: UnaryOp,
    operand: &Expr,
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let value = evaluate(operand, ctx, scope)?;
    match op {
        UnaryOp::Not => Ok(Value::Boolean(!coerce::truthy(&value))),
        UnaryOp::Negate => match value {
            Value::Number(number) => Ok(Value::Number(-number)),
            other => Err(EvalError::Type(format!(
                "cannot negate {}",
                other.type_name()
            ))),
        },
    }
}

#[inline(never)]
fn binary(
    op: BinaryOp,
    left: &Expr,
    right: &Expr,
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match op {
        // The syntax page: boolean operators result "in a true or false
        // value" — so these return booleans, not JavaScript's operands, and
        // short-circuit.
        BinaryOp::And => {
            if !coerce::truthy(&evaluate(left, ctx, scope)?) {
                return Ok(Value::Boolean(false));
            }
            Ok(Value::Boolean(coerce::truthy(&evaluate(
                right, ctx, scope,
            )?)))
        }
        BinaryOp::Or => {
            if coerce::truthy(&evaluate(left, ctx, scope)?) {
                return Ok(Value::Boolean(true));
            }
            Ok(Value::Boolean(coerce::truthy(&evaluate(
                right, ctx, scope,
            )?)))
        }
        BinaryOp::Eq | BinaryOp::Ne => {
            let left = evaluate(left, ctx, scope)?;
            let equal = coerce::loose_equals(&left, &evaluate(right, ctx, scope)?)?;
            Ok(Value::Boolean(if op == BinaryOp::Eq {
                equal
            } else {
                !equal
            }))
        }
        BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
            let left = evaluate(left, ctx, scope)?;
            let ordering = coerce::compare(&left, &evaluate(right, ctx, scope)?)?;
            Ok(Value::Boolean(match op {
                BinaryOp::Lt => ordering.is_lt(),
                BinaryOp::Le => ordering.is_le(),
                BinaryOp::Gt => ordering.is_gt(),
                _ => ordering.is_ge(),
            }))
        }
        _ => {
            let left = evaluate(left, ctx, scope)?;
            arithmetic(op, left, evaluate(right, ctx, scope)?, ctx)
        }
    }
}
