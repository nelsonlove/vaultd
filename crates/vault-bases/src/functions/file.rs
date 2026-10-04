//! The `file` fields and methods. Every row is a file; `this` is one too.

use vault_core::VaultPath;

use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::source::{FileKind, LinkFact, extension, folder_key};
use crate::value::{DateValue, LinkValue, Value};

use super::{arity, eager, typed_property};

pub(crate) const METHODS: &[&str] = &["asLink", "hasLink", "hasProperty", "hasTag", "inFolder"];
#[allow(
    dead_code,
    reason = "the family's published field list; no reader in this phase"
)]
pub(crate) const FIELDS: &[&str] = &[
    "name",
    "basename",
    "path",
    "folder",
    "ext",
    "size",
    "properties",
    "tags",
    "links",
    "ctime",
    "mtime",
    "backlinks",
    "embeds",
    "file",
];

fn link_values(facts: Vec<LinkFact>) -> Value {
    Value::list(
        facts
            .into_iter()
            .map(|fact| {
                Value::Link(LinkValue {
                    target: fact.raw_target,
                    display: fact.display.map(|display| Box::new(Value::String(display))),
                    resolved: fact.resolved,
                })
            })
            .collect(),
    )
}

/// Whether `tag` is `wanted` or a nested tag under it, ignoring case — tags
/// are case-insensitive in Obsidian (the Tags help page), and the functions
/// page says `hasTag` "also includes any nested tags, such as `#tag1/a`".
fn tag_matches(tag: &str, wanted: &str) -> bool {
    let tag = tag.trim_start_matches('#').to_lowercase();
    let wanted = wanted.trim_start_matches('#').to_lowercase();
    tag == wanted || tag.starts_with(&format!("{wanted}/"))
}

/// The file name without its extension; a dotfile (`.gitignore`) and a name
/// with no dot keep the whole name, as [`extension`] gives them none.
fn basename(path: &VaultPath) -> &str {
    let name = path.name();
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    }
}

pub(crate) fn field(
    path: &VaultPath,
    name: &str,
    ctx: &EvalContext<'_>,
) -> Result<Value, EvalError> {
    let facts = || -> Result<_, EvalError> {
        ctx.source
            .facts(path)?
            .ok_or_else(|| EvalError::Type(format!("{} is not in the vault", path.as_str())))
    };
    Ok(match name {
        "file" => Value::File(path.clone()),
        "path" => Value::String(path.as_str().to_string()),
        "name" => Value::String(path.name().to_string()),
        "basename" => Value::String(basename(path).to_string()),
        "ext" => Value::String(extension(path).to_string()),
        // Whether a root file's folder is `""` or `"/"` is not published.
        "folder" => match path.as_str().rsplit_once('/') {
            Some((folder, _)) => Value::String(folder.to_string()),
            None => return Err(EvalError::Uncaptured("folder:root".into())),
        },
        "size" => Value::Number(facts()?.size as f64),
        // The row source decides what a creation time is (on Linux, with no
        // birth time, it is the modification time); this only reads it.
        "ctime" => Value::Date(DateValue {
            epoch_ms: facts()?.ctime_ms,
            has_time: true,
        }),
        "mtime" => Value::Date(DateValue {
            epoch_ms: facts()?.mtime_ms,
            has_time: true,
        }),
        "properties" => Value::object(
            ctx.source
                .properties(path)?
                .iter()
                .map(|(key, value)| (key.clone(), typed_property(ctx, Some(path), key, value)))
                .collect(),
        ),
        // Whether the items carry their `#` is not published; an empty list
        // is the same either way.
        "tags" => {
            if !ctx.source.tags(path)?.is_empty() {
                return Err(EvalError::Uncaptured("tags:spelling".into()));
            }
            Value::list(Vec::new())
        }
        "links" => link_values(ctx.source.links(path)?),
        "embeds" => link_values(ctx.source.embeds(path)?),
        "backlinks" => Value::list(
            ctx.source
                .backlinks(path)?
                .into_iter()
                .map(Value::File)
                .collect(),
        ),
        _ => {
            return Err(EvalError::NoSuchField {
                target: "file",
                name: name.to_string(),
            });
        }
    })
}

/// The file a `hasLink` argument names: a file, a link's resolution, or a
/// path resolved from the row as a link written there would be.
fn target_path(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    value: Value,
) -> Result<Option<VaultPath>, EvalError> {
    Ok(match value {
        Value::File(path) => Some(path),
        Value::Link(link) => link.resolved,
        Value::String(spelling) => super::link::resolve_spelling(ctx, from, &spelling)?,
        other => {
            return Err(EvalError::Argument(format!(
                "expected a file or a path, not {}",
                other.type_name()
            )));
        }
    })
}

pub(crate) fn call(
    path: &VaultPath,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        // **Provisional** (`asLink`, settled by Task 13's capture): with no
        // display given, the link shows what Obsidian shows for a link to a
        // file, its basename.
        "asLink" => {
            arity(name, args, 0, 1)?;
            let display = values
                .into_iter()
                .next()
                .unwrap_or_else(|| Value::String(basename(path).to_string()));
            crate::eval::ensure_room(&display)?;
            Value::Link(LinkValue {
                target: path.as_str().to_string(),
                display: Some(Box::new(display)),
                resolved: Some(path.clone()),
            })
        }
        "hasLink" => {
            arity(name, args, 1, 1)?;
            let argument = values.into_iter().next().expect("one argument");
            match target_path(ctx, path, argument)? {
                Some(wanted) => Value::Boolean(super::link::reaches(ctx, path, &wanted)?),
                None => Value::Boolean(false),
            }
        }
        "hasProperty" => match values.as_slice() {
            [Value::String(key)] => Value::Boolean(
                ctx.source
                    .properties(path)?
                    .iter()
                    .any(|(have, _)| have == key),
            ),
            _ => {
                return Err(EvalError::Argument(
                    "hasProperty takes one property name".into(),
                ));
            }
        },
        "hasTag" => {
            arity(name, args, 1, usize::MAX)?;
            let wanted: Vec<String> = values
                .into_iter()
                .map(|value| match value {
                    Value::String(tag) => Ok(tag),
                    other => Err(EvalError::Argument(format!(
                        "hasTag takes tag names, not {}",
                        other.type_name()
                    ))),
                })
                .collect::<Result<_, _>>()?;
            let tags = ctx.source.tags(path)?;
            Value::Boolean(
                tags.iter()
                    .any(|tag| wanted.iter().any(|want| tag_matches(tag, want))),
            )
        }
        // The functions page: "the specified folder or one of its
        // sub-folders" — a whole path segment, so `Notes` never matches
        // `Notes2/…`; the vault root (`""`) holds every file. The folder is
        // read by `folder_key`, as the prefilter reads it.
        "inFolder" => match values.as_slice() {
            [Value::String(folder)] => {
                let folder = folder_key(folder);
                Value::Boolean(
                    folder.is_empty() || path.as_str().starts_with(&format!("{folder}/")),
                )
            }
            _ => {
                return Err(EvalError::Argument("inFolder takes one folder path".into()));
            }
        },
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "file",
                name: name.to_string(),
            });
        }
    })
}

/// Whether a row is a note, for the row's `kind`.
pub(crate) fn kind_of(ctx: &EvalContext<'_>, path: &VaultPath) -> Result<FileKind, EvalError> {
    Ok(ctx
        .source
        .facts(path)?
        .map_or(FileKind::File, |facts| facts.kind))
}
