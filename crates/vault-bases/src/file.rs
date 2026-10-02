use vault_core::{PropertyValue, SourceSpan, Spanned, parse_yaml_document};

/// A `.base` file, read but not compiled: every expression is still text.
///
/// Compilation happens per view (`view::compile_view`), so a base whose
/// formula does not parse still indexes, still lists its views, and answers
/// `expression_invalid` only for the view that reads the broken formula.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BaseFile {
    pub filters: Option<FilterNode>,
    /// Formula name to expression text, in declared order.
    pub formulas: Vec<(String, String)>,
    /// Per-property display settings, in declared order.
    pub properties: Vec<(String, PropertySettings)>,
    /// Custom summary name to expression text over `values`.
    pub summaries: Vec<(String, String)>,
    pub views: Vec<ViewDecl>,
}

/// The recursive filter tree the syntax page defines: a single statement, or
/// one of `and`, `or`, `not` over a heterogeneous list of statements and
/// trees. `not` means "none of the following are true" (the views page).
#[derive(Clone, Debug, PartialEq)]
pub enum FilterNode {
    Expr(String),
    And(Vec<FilterNode>),
    Or(Vec<FilterNode>),
    Not(Vec<FilterNode>),
}

/// One `properties:` entry. `displayName` is the one key the core reads;
/// every other key is kept, in order, so a view's own settings survive.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PropertySettings {
    pub display_name: Option<String>,
    pub options: Vec<(String, PropertyValue)>,
}

/// One entry of `views:`. Every key the core plugin owns is a field; every
/// other key is kept in `options`, in declared order, so a plugin's view
/// (`fileclass-table`) survives the round trip. An unknown `type` is kept as
/// declared and never interpreted.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewDecl {
    pub kind: String,
    pub name: String,
    pub filters: Option<FilterNode>,
    pub order: Vec<String>,
    pub sort: Vec<SortKey>,
    pub group_by: Option<GroupBy>,
    pub limit: Option<u64>,
    /// Property name to summary name (a built-in such as `Average`, or a key
    /// of the base's own `summaries`).
    pub summaries: Vec<(String, String)>,
    pub options: Vec<(String, PropertyValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SortKey {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GroupBy {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Asc,
    Desc,
}

/// Why a document is not a base, and where. `span` is a byte range into the
/// document; it is `None` only when the whole document is the culprit and no
/// narrower position exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaseParseError {
    pub message: String,
    pub span: Option<SourceSpan>,
}

impl BaseParseError {
    fn at(span: SourceSpan, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            span: Some(span),
        }
    }
}

impl BaseFile {
    /// The declared view names, in order.
    pub fn view_names(&self) -> Vec<String> {
        self.views.iter().map(|view| view.name.clone()).collect()
    }

    /// The named view, matched exactly, or the first view when `name` is
    /// `None` (the views page: "The first view in your list of views will
    /// load by default").
    pub fn view(&self, name: Option<&str>) -> Option<&ViewDecl> {
        match name {
            None => self.views.first(),
            Some(name) => self.views.iter().find(|view| view.name == name),
        }
    }
}

type Entries<'a> = &'a [(Spanned<String>, Spanned<PropertyValue>)];

fn mapping<'a>(
    value: &'a Spanned<PropertyValue>,
    what: &str,
) -> Result<Entries<'a>, BaseParseError> {
    match &value.value {
        PropertyValue::Mapping(entries) => Ok(entries),
        _ => Err(BaseParseError::at(
            value.span,
            format!("{what} must be a mapping"),
        )),
    }
}

/// A scalar read as expression text. Formulas and filter statements are
/// "always stored as strings in YAML" (the syntax page), but an unquoted
/// `true` or `5` is YAML's to type, so it is read back as the text it was.
fn expression_text(value: &Spanned<PropertyValue>, what: &str) -> Result<String, BaseParseError> {
    match &value.value {
        PropertyValue::String(text) => Ok(text.clone()),
        PropertyValue::Boolean(flag) => Ok(flag.to_string()),
        PropertyValue::Integer(number) => Ok(number.to_string()),
        PropertyValue::Float(number) => Ok(number.to_string()),
        _ => Err(BaseParseError::at(
            value.span,
            format!("{what} must be an expression string"),
        )),
    }
}

fn plain_string(value: &Spanned<PropertyValue>, what: &str) -> Result<String, BaseParseError> {
    match &value.value {
        PropertyValue::String(text) => Ok(text.clone()),
        PropertyValue::Integer(number) => Ok(number.to_string()),
        PropertyValue::Float(number) => Ok(number.to_string()),
        PropertyValue::Boolean(flag) => Ok(flag.to_string()),
        _ => Err(BaseParseError::at(
            value.span,
            format!("{what} must be a string"),
        )),
    }
}

fn direction(value: &Spanned<PropertyValue>) -> Result<Direction, BaseParseError> {
    let text = plain_string(value, "direction")?;
    match text.to_ascii_uppercase().as_str() {
        "ASC" => Ok(Direction::Asc),
        "DESC" => Ok(Direction::Desc),
        _ => Err(BaseParseError::at(
            value.span,
            format!("direction must be ASC or DESC, not {text:?}"),
        )),
    }
}

fn filter(value: &Spanned<PropertyValue>) -> Result<FilterNode, BaseParseError> {
    match &value.value {
        PropertyValue::String(_) => Ok(FilterNode::Expr(expression_text(
            value,
            "a filter statement",
        )?)),
        PropertyValue::Mapping(entries) => {
            let [(key, items)] = entries.as_slice() else {
                return Err(BaseParseError::at(
                    value.span,
                    "a filter object holds exactly one of and, or, or not",
                ));
            };
            let PropertyValue::Sequence(list) = &items.value else {
                return Err(BaseParseError::at(
                    items.span,
                    format!("filter `{}` must be a list", key.value),
                ));
            };
            let children = list.iter().map(filter).collect::<Result<Vec<_>, _>>()?;
            match key.value.as_str() {
                "and" => Ok(FilterNode::And(children)),
                "or" => Ok(FilterNode::Or(children)),
                "not" => Ok(FilterNode::Not(children)),
                other => Err(BaseParseError::at(
                    key.span,
                    format!("a filter object holds one of and, or, or not — not {other:?}"),
                )),
            }
        }
        _ => Err(BaseParseError::at(
            value.span,
            "a filter must be a statement string or an and/or/not object",
        )),
    }
}

fn named_expressions(
    value: &Spanned<PropertyValue>,
    what: &str,
) -> Result<Vec<(String, String)>, BaseParseError> {
    mapping(value, what)?
        .iter()
        .map(|(key, value)| Ok((key.value.clone(), expression_text(value, what)?)))
        .collect()
}

fn options_of(entries: Entries<'_>, core: &[&str]) -> Vec<(String, PropertyValue)> {
    entries
        .iter()
        .filter(|(key, _)| !core.contains(&key.value.as_str()))
        .map(|(key, value)| (key.value.clone(), value.value.clone()))
        .collect()
}

/// The keys the core Bases plugin owns on a view. Everything else is a view
/// type's own option and is kept verbatim.
const VIEW_KEYS: [&str; 8] = [
    "type",
    "name",
    "filters",
    "order",
    "sort",
    "groupBy",
    "limit",
    "summaries",
];

fn view(value: &Spanned<PropertyValue>, index: usize) -> Result<ViewDecl, BaseParseError> {
    let entries = mapping(value, "a view")?;
    let get = |name: &str| {
        entries
            .iter()
            .find(|(key, _)| key.value == name)
            .map(|(_, v)| v)
    };
    let kind = match get("type") {
        Some(kind) => plain_string(kind, "a view type")?,
        None => {
            return Err(BaseParseError::at(
                value.span,
                format!("view {index} has no type"),
            ));
        }
    };
    let name = match get("name") {
        Some(name) => plain_string(name, "a view name")?,
        None => {
            return Err(BaseParseError::at(
                value.span,
                format!("view {index} has no name"),
            ));
        }
    };
    let filters = get("filters").map(filter).transpose()?;
    let order = match get("order") {
        None => Vec::new(),
        Some(order) => match &order.value {
            PropertyValue::Sequence(items) => items
                .iter()
                .map(|item| plain_string(item, "an order entry"))
                .collect::<Result<_, _>>()?,
            _ => return Err(BaseParseError::at(order.span, "order must be a list")),
        },
    };
    let sort = match get("sort") {
        None => Vec::new(),
        Some(sort) => match &sort.value {
            PropertyValue::Sequence(items) => items
                .iter()
                .map(|item| {
                    let entries = mapping(item, "a sort key")?;
                    let property = entries
                        .iter()
                        .find(|(key, _)| key.value == "property")
                        .ok_or_else(|| {
                            BaseParseError::at(item.span, "a sort key needs a property")
                        })?;
                    let direction_value = entries.iter().find(|(key, _)| key.value == "direction");
                    Ok(SortKey {
                        property: plain_string(&property.1, "a sort property")?,
                        direction: match direction_value {
                            Some((_, value)) => direction(value)?,
                            None => Direction::Asc,
                        },
                    })
                })
                .collect::<Result<_, BaseParseError>>()?,
            _ => return Err(BaseParseError::at(sort.span, "sort must be a list")),
        },
    };
    let group_by = match get("groupBy") {
        None => None,
        Some(group) => {
            let entries = mapping(group, "groupBy")?;
            let property = entries
                .iter()
                .find(|(key, _)| key.value == "property")
                .ok_or_else(|| BaseParseError::at(group.span, "groupBy needs a property"))?;
            let direction_value = entries.iter().find(|(key, _)| key.value == "direction");
            Some(GroupBy {
                property: plain_string(&property.1, "a groupBy property")?,
                direction: match direction_value {
                    Some((_, value)) => direction(value)?,
                    None => Direction::Asc,
                },
            })
        }
    };
    let limit = match get("limit") {
        None => None,
        Some(limit) => match &limit.value {
            PropertyValue::Integer(count) if *count >= 0 => Some(*count as u64),
            _ => {
                return Err(BaseParseError::at(
                    limit.span,
                    "limit must be a non-negative integer",
                ));
            }
        },
    };
    let summaries = match get("summaries") {
        None => Vec::new(),
        Some(summaries) => mapping(summaries, "a view's summaries")?
            .iter()
            .map(|(key, value)| Ok((key.value.clone(), plain_string(value, "a summary name")?)))
            .collect::<Result<_, BaseParseError>>()?,
    };
    Ok(ViewDecl {
        kind,
        name,
        filters,
        order,
        sort,
        group_by,
        limit,
        summaries,
        options: options_of(entries, &VIEW_KEYS),
    })
}

/// Read a `.base` document.
///
/// Unknown **top-level** keys are ignored (a later Obsidian may add one; the
/// file still opens there). Unknown **view** keys are kept in
/// [`ViewDecl::options`]. Every shape the model cannot read is an error with a
/// byte position — never a silently empty base.
pub fn parse_base(text: &str) -> Result<BaseFile, BaseParseError> {
    let root = match parse_yaml_document(text) {
        Ok(Some(root)) => root,
        Ok(None) => return Ok(BaseFile::default()),
        Err(error) => return Err(BaseParseError::at(error.span, error.message)),
    };
    let entries = mapping(&root, "a base")?;
    let mut base = BaseFile::default();
    for (key, value) in entries {
        match key.value.as_str() {
            "filters" => base.filters = Some(filter(value)?),
            "formulas" => base.formulas = named_expressions(value, "a formula")?,
            "summaries" => base.summaries = named_expressions(value, "a summary formula")?,
            "properties" => {
                for (property, settings) in mapping(value, "properties")? {
                    let settings_entries = mapping(settings, "a property's settings")?;
                    let display_name = settings_entries
                        .iter()
                        .find(|(key, _)| key.value == "displayName")
                        .map(|(_, value)| plain_string(value, "displayName"))
                        .transpose()?;
                    base.properties.push((
                        property.value.clone(),
                        PropertySettings {
                            display_name,
                            options: options_of(settings_entries, &["displayName"]),
                        },
                    ));
                }
            }
            "views" => match &value.value {
                PropertyValue::Sequence(items) => {
                    for (index, item) in items.iter().enumerate() {
                        base.views.push(view(item, index)?);
                    }
                }
                PropertyValue::Null => {}
                _ => return Err(BaseParseError::at(value.span, "views must be a list")),
            },
            _ => {}
        }
    }
    Ok(base)
}
