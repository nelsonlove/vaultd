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

/// Links as `file.links` and `file.embeds` give them: each shows its
/// written display, else its target as written (captured:
/// `[[Other|Other]], [[Folder/image.png|Folder/image.png]]`).
///
/// A link or embed of a URL is not one of them (seen in a corpus view: a
/// note whose first embed is a web image is not found by `file.embeds[0]`).
fn link_values(facts: Vec<LinkFact>) -> Vec<Value> {
    facts
        .into_iter()
        .filter(|fact| {
            let target = fact.raw_target.as_str();
            !(super::link::is_url(target)
                || target.starts_with("data:")
                || target.starts_with("mailto:"))
        })
        .map(|fact| {
            let display = fact.display.unwrap_or_else(|| fact.raw_target.clone());
            Value::Link(LinkValue {
                target: fact.raw_target,
                display: Some(Box::new(Value::String(display))),
                resolved: fact.resolved,
            })
        })
        .collect()
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
        // Captured: a note's name drops `.md` (`a.md` is `a`), any other
        // file keeps its extension (`image.png`).
        "name" => Value::String(match extension(path) {
            "md" => basename(path).to_string(),
            _ => path.name().to_string(),
        }),
        "basename" => Value::String(basename(path).to_string()),
        "ext" => Value::String(extension(path).to_string()),
        // Captured: a file at the root is in the folder `/`.
        "folder" => Value::String(match path.as_str().rsplit_once('/') {
            Some((folder, _)) => folder.to_string(),
            None => "/".to_string(),
        }),
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
        // Captured: each tag with its `#`, the body's tags first and then
        // the frontmatter's, each spelling once (`#alpha, #ALPHA, #delta,
        // #Beta/gamma` for a note whose frontmatter holds `alpha` and
        // `Beta/gamma` and whose body holds `#alpha #ALPHA #delta`).
        "tags" => Value::list(ordered_tags(ctx, path)?),
        // Captured: `file.links` holds the embeds too (three for a note with
        // two links and one embed).
        "links" => {
            let mut links = link_values(ctx.source.links(path)?);
            links.extend(link_values(ctx.source.embeds(path)?));
            Value::list(links)
        }
        "embeds" => Value::list(link_values(ctx.source.embeds(path)?)),
        // Captured: each backlink is a link to the linking file, shown by
        // its name (`[[Other.md|Other]]`), not a file.
        "backlinks" => Value::list(
            ctx.source
                .backlinks(path)?
                .into_iter()
                .map(|from| {
                    let shown = match extension(&from) {
                        "md" => basename(&from).to_string(),
                        _ => from.name().to_string(),
                    };
                    Value::Link(LinkValue {
                        target: from.as_str().to_string(),
                        display: Some(Box::new(Value::String(shown))),
                        resolved: Some(from),
                    })
                })
                .collect(),
        ),
        // Captured: `file.tasks` in a formula is an error ("Cannot find
        // \"tasks\" on type File"); as a column it is empty (`view::read`).
        _ => {
            return Err(EvalError::NoSuchField {
                target: "file",
                name: name.to_string(),
            });
        }
    })
}

/// The frontmatter's tags of `path`: the items of its `tags` or `tag`
/// property, without a leading `#`.
fn frontmatter_tags(ctx: &EvalContext<'_>, path: &VaultPath) -> Result<Vec<String>, EvalError> {
    let mut tags = Vec::new();
    for (key, value) in ctx.source.properties(path)? {
        if !key.eq_ignore_ascii_case("tags") && !key.eq_ignore_ascii_case("tag") {
            continue;
        }
        let items = match &value {
            vault_core::PropertyValue::Sequence(items) => {
                items.iter().map(|item| item.value.clone()).collect()
            }
            other => vec![other.clone()],
        };
        for item in items {
            if let vault_core::PropertyValue::String(text) = item {
                for tag in text.split([',', ' ']).filter(|tag| !tag.is_empty()) {
                    tags.push(tag.trim_start_matches('#').to_string());
                }
            }
        }
    }
    Ok(tags)
}

/// `file.tags`: the body's tags in order, then the frontmatter's, each
/// exact spelling once, each with its `#`.
fn ordered_tags(ctx: &EvalContext<'_>, path: &VaultPath) -> Result<Vec<Value>, EvalError> {
    let frontmatter = frontmatter_tags(ctx, path)?;
    // The row source lists every tag; each frontmatter tag accounts for one
    // of them, and the rest were written in the body.
    let mut unclaimed = frontmatter.clone();
    let mut body = Vec::new();
    for tag in ctx.source.tags(path)? {
        let tag = tag.trim_start_matches('#').to_string();
        match unclaimed.iter().position(|front| *front == tag) {
            Some(at) => {
                unclaimed.remove(at);
            }
            None => body.push(tag),
        }
    }
    let mut seen = std::collections::HashSet::new();
    Ok(body
        .into_iter()
        .chain(frontmatter)
        .filter(|tag| seen.insert(tag.clone()))
        .map(|tag| Value::String(format!("#{tag}")))
        .collect())
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
        // Captured: a link to the file's path, with the display given or
        // none (`[[Captures/file/r17.md]]`).
        "asLink" => {
            arity(name, args, 0, 1)?;
            let display = values.into_iter().next();
            if let Some(display) = &display {
                crate::eval::ensure_room(display)?;
            }
            Value::Link(LinkValue {
                target: path.as_str().to_string(),
                display: display.map(Box::new),
                resolved: Some(path.clone()),
            })
        }
        "hasLink" => {
            arity(name, args, 1, 1)?;
            let argument = values.into_iter().next().expect("one argument");
            match target_path(ctx, path, argument)? {
                Some(wanted) => Value::Boolean(super::link::reaches(ctx, path, &wanted, true)?),
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
