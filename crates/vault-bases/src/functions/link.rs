//! The global `link()` and `file()`, and the link methods `asFile` and
//! `linksTo`.

use vault_core::VaultPath;

use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::{LinkValue, Value};

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &["link", "file"];
pub(crate) const METHODS: &[&str] = &["asFile", "linksTo"];

/// `[[Target|Display]]` or `[[Target]]` as written in a property, else
/// `None`. The display half is kept; the subpath stays in the target text.
/// Exactly one wikilink: text holding a second `[[` or `]]`
/// (`"[[a]] and [[b]]"`) or an empty target (`"[[]]"`) is not one.
pub(crate) fn parse_wikilink(text: &str) -> Option<(String, Option<String>)> {
    let inner = text.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.contains("[[") || inner.contains("]]") {
        return None;
    }
    let (target, display) = match inner.split_once('|') {
        Some((target, display)) => (target, Some(display.to_string())),
        None => (inner, None),
    };
    if target.trim().is_empty() {
        return None;
    }
    Some((target.to_string(), display))
}

/// The file `spelling` names, written in `from`: a wikilink's brackets come
/// off first, and a URL names no file. `make_link`, `hasLink` and `linksTo`
/// all resolve a string this way.
pub(crate) fn resolve_spelling(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    spelling: &str,
) -> Result<Option<VaultPath>, EvalError> {
    let target =
        parse_wikilink(spelling).map_or_else(|| spelling.to_string(), |(target, _)| target);
    if is_url(&target) {
        return Ok(None);
    }
    Ok(ctx.source.resolve(from, &target)?)
}

/// `scheme://…` with a URL scheme (RFC 3986: a letter, then letters, digits,
/// `+`, `-`, `.`).
fn is_url(text: &str) -> bool {
    text.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    })
}

/// A link value for `target` written in `from`: a URL never resolves; a
/// wikilink spelling has its brackets taken off before resolution.
pub(crate) fn make_link(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    target: &str,
    display: Option<Value>,
) -> Result<LinkValue, EvalError> {
    let resolved = resolve_spelling(ctx, from, target)?;
    let (target, written_display) = match parse_wikilink(target) {
        Some((target, display)) => (target, display),
        None => (target.to_string(), None),
    };
    Ok(LinkValue {
        target,
        display: display.or(written_display.map(Value::String)).map(Box::new),
        resolved,
    })
}

/// Whether `from` links to `wanted`, the one rule `file.hasLink` and
/// `link.linksTo` share. **Provisional** (cases `hasLink:embed` and
/// `linksTo:embed`, settled by Task 13's capture): an embed counts as a
/// link, as it counts as a backlink.
pub(crate) fn reaches(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    wanted: &VaultPath,
) -> Result<bool, EvalError> {
    let hits = |facts: Vec<crate::source::LinkFact>| {
        facts
            .iter()
            .any(|fact| fact.resolved.as_ref() == Some(wanted))
    };
    Ok(hits(ctx.source.links(from)?) || hits(ctx.source.embeds(from)?))
}

fn missing() -> EvalError {
    EvalError::Uncaptured("file:missing".into())
}

pub(crate) fn call_global(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = match eager(args, ctx, scope) {
        // The functions page's daily-note example,
        // `link(file.ctime.date().toString())`, needs a date's text, which
        // is not captured yet; the link it builds is uncaptured by name.
        Err(EvalError::Uncaptured(case)) if name == "link" && case == "tostring:date" => {
            return Err(EvalError::Uncaptured("link:from_date_string".into()));
        }
        other => other?,
    };
    match name {
        // Resolved from the base file: a formula's link has no note of its own.
        "link" => {
            arity(name, args, 1, 2)?;
            let display = values.get(1).cloned();
            if let Some(display) = &display {
                crate::eval::ensure_room(display)?;
            }
            match &values[0] {
                Value::String(target) => {
                    Ok(Value::Link(make_link(ctx, ctx.base_path, target, display)?))
                }
                Value::File(path) => Ok(Value::Link(LinkValue {
                    target: path.as_str().to_string(),
                    display: display.map(Box::new),
                    resolved: Some(path.clone()),
                })),
                other => Err(EvalError::Argument(format!(
                    "link takes a path or a file, not {}",
                    other.type_name()
                ))),
            }
        }
        "file" => {
            arity(name, args, 1, 1)?;
            match &values[0] {
                Value::File(path) => Ok(Value::File(path.clone())),
                Value::Link(link) => link.resolved.clone().map(Value::File).ok_or_else(missing),
                Value::String(spelling) => {
                    // An exact vault path first, then the link rules.
                    let exact = match VaultPath::new(spelling.as_str()) {
                        Ok(path) if ctx.source.facts(&path)?.is_some() => Some(path),
                        _ => None,
                    };
                    let found = match exact {
                        Some(path) => Some(path),
                        None => make_link(ctx, ctx.base_path, spelling, None)?.resolved,
                    };
                    found.map(Value::File).ok_or_else(missing)
                }
                other => Err(EvalError::Argument(format!(
                    "file takes a path, a link or a file, not {}",
                    other.type_name()
                ))),
            }
        }
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}

pub(crate) fn call(
    link: &LinkValue,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "asFile" => {
            arity(name, args, 0, 0)?;
            Ok(link
                .resolved
                .clone()
                .map(Value::File)
                .unwrap_or(Value::Null))
        }
        // The functions page: true "if the file represented by link has a
        // link to file" — the linked file's own links, one direction only.
        "linksTo" => {
            arity(name, args, 1, 1)?;
            let wanted = eager(args, ctx, scope)?.into_iter().next();
            let Some(from) = &link.resolved else {
                return Ok(Value::Boolean(false));
            };
            let wanted = match wanted {
                Some(Value::File(path)) => Some(path),
                Some(Value::Link(other)) => other.resolved,
                Some(Value::String(spelling)) => resolve_spelling(ctx, from, &spelling)?,
                _ => return Err(EvalError::Argument("linksTo takes a file".into())),
            };
            let Some(wanted) = wanted else {
                return Ok(Value::Boolean(false));
            };
            Ok(Value::Boolean(reaches(ctx, from, &wanted)?))
        }
        _ => Err(EvalError::NoSuchMethod {
            target: "link",
            name: name.to_string(),
        }),
    }
}
