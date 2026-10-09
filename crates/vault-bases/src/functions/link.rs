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
pub(crate) fn is_url(text: &str) -> bool {
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

/// Whether `from` links to `wanted`. Captured (Task 13): for
/// `file.hasLink` an embed counts as a link (a note embedding an image
/// `hasLink` it), for `link.linksTo` it does not (`linksTo` an embedded
/// image is false), so `embeds` says which.
pub(crate) fn reaches(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    wanted: &VaultPath,
    embeds: bool,
) -> Result<bool, EvalError> {
    let hits = |facts: Vec<crate::source::LinkFact>| {
        facts
            .iter()
            .any(|fact| fact.resolved.as_ref() == Some(wanted))
    };
    Ok(hits(ctx.source.links(from)?) || (embeds && hits(ctx.source.embeds(from)?)))
}

pub(crate) fn call_global(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
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
                // A link given a link is that link (seen in a corpus view:
                // `link(x)` over a frontmatter link), its display replaced
                // when one is given.
                Value::Link(link) => Ok(Value::Link(LinkValue {
                    display: display.map(Box::new).or_else(|| link.display.clone()),
                    ..link.clone()
                })),
                Value::Null => Ok(Value::Null),
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
        // A name that finds no file is an empty cell (captured:
        // `file("path to file")`), found by the link rules alone (captured:
        // `file("Folder/README")`, a file with no extension, is empty).
        "file" => {
            arity(name, args, 1, 1)?;
            match &values[0] {
                Value::File(path) => Ok(Value::File(path.clone())),
                Value::Link(link) => Ok(link.resolved.clone().map_or(Value::Null, Value::File)),
                Value::String(spelling) => Ok(make_link(ctx, ctx.base_path, spelling, None)?
                    .resolved
                    .map_or(Value::Null, Value::File)),
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
        // Captured: a URL link has no `asFile` ("Cannot find function
        // \"asFile\" on type URL").
        "asFile" if is_url(&link.target) => Err(EvalError::NoSuchMethod {
            target: "url",
            name: name.to_string(),
        }),
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
            Ok(Value::Boolean(reaches(ctx, from, &wanted, false)?))
        }
        // A text method reads the link's target (seen in a corpus view:
        // `file.embeds[0].containsAny("png")` picks the notes with an image
        // embed).
        _ if super::string::METHODS.contains(&name) => {
            super::string::call(&link.target, name, args, ctx, scope)
        }
        _ => Err(EvalError::NoSuchMethod {
            target: "link",
            name: name.to_string(),
        }),
    }
}
