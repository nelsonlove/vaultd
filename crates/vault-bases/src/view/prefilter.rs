//! Prefilter extraction: the narrowings a row source can serve from an
//! index before any expression runs.
//!
//! Every prefilter is a superset of the statement it came from: the
//! statement still runs on every row the prefilter admits, so a prefilter may
//! only drop rows its statement could never keep.

use crate::expr::{BinaryOp, Expr};
use crate::source::{Prefilter, ScalarLiteral, folder_key};

/// The roots that are not note properties.
const RESERVED: [&str; 8] = [
    "file", "note", "formula", "this", "values", "value", "index", "acc",
];

fn is_root(expr: &Expr, root: &str) -> bool {
    matches!(expr, Expr::Identifier(name) if name == root)
}

fn note_key(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(name) if !RESERVED.contains(&name.as_str()) => Some(name.clone()),
        Expr::Member { target, name } if is_root(target, "note") => Some(name.clone()),
        Expr::Index { target, index } if is_root(target, "note") => match index.as_ref() {
            Expr::String(key) => Some(key.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// A literal a note lacking the property can never equal: a non-empty
/// string, a non-zero number, `true`. A falsy literal is refused, because
/// whether `null` equals `false`, `0` or `""` is not published, and a
/// prefilter that guessed would be able to drop a row.
fn truthy_literal(expr: &Expr) -> Option<ScalarLiteral> {
    match expr {
        Expr::String(text) if !text.is_empty() => Some(ScalarLiteral::String(text.clone())),
        Expr::Number(number) if *number != 0.0 && !number.is_nan() => {
            Some(ScalarLiteral::Number(*number))
        }
        Expr::Boolean(true) => Some(ScalarLiteral::Boolean(true)),
        _ => None,
    }
}

fn is_file_member(expr: &Expr, field: &str) -> bool {
    matches!(expr, Expr::Member { target, name } if name == field && is_root(target, "file"))
}

fn string_args(args: &[Expr]) -> Option<Vec<String>> {
    args.iter()
        .map(|arg| match arg {
            Expr::String(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn ext_literal(field: &Expr, literal: &Expr) -> Option<String> {
    match literal {
        Expr::String(ext) if is_file_member(field, "ext") => Some(ext.clone()),
        _ => None,
    }
}

/// The prefilters one top-level statement contributes. `&&` splits;
/// anything else contributes nothing and simply runs per row. The recursion
/// follows `&&` only, and a parsed tree is at most
/// [`crate::expr::MAX_DEPTH`] levels deep.
pub(crate) fn extract(expr: &Expr, out: &mut Vec<Prefilter>) {
    match expr {
        Expr::Binary {
            op: BinaryOp::And,
            left,
            right,
        } => {
            extract(left, out);
            extract(right, out);
        }
        Expr::Method {
            target, name, args, ..
        } if is_root(target, "file") => match (name.as_str(), string_args(args)) {
            // The method's own normalisation, so `inFolder("/Notes")` and
            // `inFolder("Notes")` ask the source for the same rows.
            ("inFolder", Some(folders)) if folders.len() == 1 => {
                out.push(Prefilter::InFolder(folder_key(&folders[0]).to_string()));
            }
            ("hasTag", Some(tags)) if !tags.is_empty() => out.push(Prefilter::HasTag(tags)),
            _ => {}
        },
        Expr::Binary {
            op: BinaryOp::Eq,
            left,
            right,
        } => {
            if let Some(ext) = ext_literal(left, right).or_else(|| ext_literal(right, left)) {
                out.push(Prefilter::Ext(ext));
                return;
            }
            let pair = match (note_key(left), truthy_literal(right)) {
                (Some(key), Some(value)) => Some((key, value)),
                _ => match (note_key(right), truthy_literal(left)) {
                    (Some(key), Some(value)) => Some((key, value)),
                    _ => None,
                },
            };
            if let Some((key, value)) = pair {
                out.push(Prefilter::PropertyEquals { key, value });
            }
        }
        _ => {}
    }
}
