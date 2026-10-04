//! One view, compiled and evaluated.
//!
//! Evaluation order is the spec's: prefilters, then the global filters and
//! the view's filters as one conjunction, then formulas (memoized per row),
//! then `sort` (stable), then `limit`, then `groupBy`, then summaries over the
//! surviving rows. The daemon renders nothing: a row is a path, a kind, an
//! optional group key and one cell per column.
//!
//! Recursion: an expression walk is bounded by the parser's
//! [`MAX_DEPTH`]; a filter tree by the same number of levels, checked at
//! compile time; and a chain of formulas reading formulas by a depth budget
//! of the same size, checked as each formula is entered (an error cell past
//! it), so no `.base` file can overflow the evaluating thread's stack.

mod prefilter;
mod summary;

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use vault_core::{PropertyValue, VaultPath};

use crate::eval::coerce::{sort_order, truthy};
use crate::eval::{EvalContext, EvalError, Formulas, Scope, evaluate, row_property};
use crate::expr::{Expr, MAX_DEPTH, parse_expression};
use crate::file::{BaseFile, Direction, FilterNode, ViewDecl};
use crate::functions::{self, is_known_global, is_known_method};
use crate::source::{FileKind, Prefilter, SourceError};
use crate::value::Value;

pub use summary::BUILTIN_SUMMARIES;

/// One evaluated cell: a value, or the error that cell shows.
pub type Cell = Result<Value, EvalError>;

/// Where a column, sort key or group key reads from. Keys are names, not
/// expressions: `note.my prop` is a property called "my prop", and a bare
/// key is a note property.
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyRef {
    File(String),
    Formula(String),
    Note(String),
}

pub fn property_ref(key: &str) -> PropertyRef {
    if let Some(field) = key.strip_prefix("file.") {
        PropertyRef::File(field.to_string())
    } else if let Some(name) = key.strip_prefix("formula.") {
        PropertyRef::Formula(name.to_string())
    } else if let Some(name) = key.strip_prefix("note.") {
        PropertyRef::Note(name.to_string())
    } else {
        PropertyRef::Note(key.to_string())
    }
}

/// One column of a view, as declared: the `order` entry and the base's
/// `properties` settings for it.
#[derive(Clone, Debug, PartialEq)]
pub struct ColumnDecl {
    pub property: String,
    pub display_name: Option<String>,
    pub settings: Vec<(String, PropertyValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CompileError {
    ViewNotFound {
        declared: Vec<String>,
    },
    ExpressionInvalid {
        expression: String,
        message: String,
        position: usize,
    },
    UnsupportedFunction {
        name: String,
    },
}

/// What the per-commit staleness rule needs to know about a view.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewDependencies {
    pub prefilters: Vec<Prefilter>,
    pub reads_formulas: bool,
    pub reads_links: bool,
    pub reads_backlinks: bool,
    pub reads_this: bool,
    pub reads_properties: bool,
}

/// A compiled filter tree. A statement carries its tree height, the depth
/// it starts the formula budget at.
#[derive(Clone, Debug)]
enum Filter {
    Expr(Expr, usize),
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Vec<Filter>),
}

/// One summary of a view: the property key it is declared under, where the
/// column reads from, the summary's name, and its expression when it is
/// one of the base's own `summaries`.
#[derive(Clone, Debug)]
struct SummaryDecl {
    property: String,
    reference: PropertyRef,
    name: String,
    custom: Option<Expr>,
}

#[derive(Clone, Debug)]
pub struct CompiledView {
    decl: ViewDecl,
    filters: Vec<Filter>,
    /// Every formula the view reads, transitively, with its tree height.
    formulas: BTreeMap<String, (Expr, usize)>,
    columns: Vec<ColumnDecl>,
    sort: Vec<(PropertyRef, Direction)>,
    group: Option<(PropertyRef, Direction)>,
    summaries: Vec<SummaryDecl>,
    prefilters: Vec<Prefilter>,
    dependencies: ViewDependencies,
}

impl CompiledView {
    pub fn decl(&self) -> &ViewDecl {
        &self.decl
    }

    pub fn columns(&self) -> &[ColumnDecl] {
        &self.columns
    }

    pub fn prefilters(&self) -> &[Prefilter] {
        &self.prefilters
    }

    pub fn dependencies(&self) -> &ViewDependencies {
        &self.dependencies
    }

    /// The same view with no prefilters: what the superset property test
    /// compares against. Not for production use.
    #[doc(hidden)]
    pub fn without_prefilters(&self) -> CompiledView {
        let mut copy = self.clone();
        copy.prefilters.clear();
        copy
    }
}

fn parse(text: &str) -> Result<Expr, CompileError> {
    parse_expression(text).map_err(|error| CompileError::ExpressionInvalid {
        expression: text.to_string(),
        message: error.message,
        position: error.position,
    })
}

/// A tree's height: a leaf is 1. Bounded by [`MAX_DEPTH`], since the parser
/// builds no taller tree.
fn height(expr: &Expr) -> usize {
    let tallest = |items: &mut dyn Iterator<Item = &Expr>| items.map(height).max().unwrap_or(0);
    1 + match expr {
        Expr::Null
        | Expr::Boolean(_)
        | Expr::Number(_)
        | Expr::String(_)
        | Expr::Regexp { .. }
        | Expr::Identifier(_) => 0,
        Expr::List(items) => tallest(&mut items.iter()),
        Expr::Object(entries) => tallest(&mut entries.iter().map(|(_, value)| value)),
        Expr::Member { target, .. } => height(target),
        Expr::Index { target, index } => height(target).max(height(index)),
        Expr::Call { args, .. } => tallest(&mut args.iter()),
        Expr::Method { target, args, .. } => height(target).max(tallest(&mut args.iter())),
        Expr::Unary { operand, .. } => height(operand),
        Expr::Binary { left, right, .. } => height(left).max(height(right)),
    }
}

/// A filter tree nested deeper than an expression may be is refused: the
/// tree is YAML, which the parser's cap does not reach, and every walk over
/// it recurses once per level.
fn compile_filter(node: &FilterNode, depth: usize) -> Result<Filter, CompileError> {
    if depth > MAX_DEPTH {
        return Err(CompileError::ExpressionInvalid {
            expression: "filters".into(),
            message: format!("filters nested too deeply (more than {MAX_DEPTH} levels)"),
            position: 0,
        });
    }
    let children = |items: &[FilterNode]| -> Result<Vec<Filter>, CompileError> {
        items
            .iter()
            .map(|item| compile_filter(item, depth + 1))
            .collect()
    };
    Ok(match node {
        FilterNode::Expr(text) => {
            let expr = parse(text)?;
            let height = height(&expr);
            Filter::Expr(expr, height)
        }
        FilterNode::And(items) => Filter::And(children(items)?),
        FilterNode::Or(items) => Filter::Or(children(items)?),
        FilterNode::Not(items) => Filter::Not(children(items)?),
    })
}

fn filter_exprs<'a>(filter: &'a Filter, out: &mut Vec<&'a Expr>) {
    match filter {
        Filter::Expr(expr, _) => out.push(expr),
        Filter::And(items) | Filter::Or(items) | Filter::Not(items) => {
            items.iter().for_each(|item| filter_exprs(item, out))
        }
    }
}

fn scan_all(
    exprs: &[Expr],
    deps: &mut ViewDependencies,
    formulas: &mut BTreeSet<String>,
) -> Result<(), CompileError> {
    for expr in exprs {
        scan(expr, deps, formulas)?;
    }
    Ok(())
}

/// Walk an expression, checking function names and noting what it reads.
fn scan(
    expr: &Expr,
    deps: &mut ViewDependencies,
    formulas: &mut BTreeSet<String>,
) -> Result<(), CompileError> {
    match expr {
        Expr::Call { name, args, .. } => {
            if !is_known_global(name) {
                return Err(CompileError::UnsupportedFunction { name: name.clone() });
            }
            if name == "link" || name == "file" {
                deps.reads_links = true;
            }
            scan_all(args, deps, formulas)?;
        }
        Expr::Method {
            target, name, args, ..
        } => {
            if !is_known_method(name) {
                return Err(CompileError::UnsupportedFunction { name: name.clone() });
            }
            if matches!(name.as_str(), "hasLink" | "linksTo" | "asFile") {
                deps.reads_links = true;
            }
            if name == "hasProperty" {
                deps.reads_properties = true;
            }
            scan(target, deps, formulas)?;
            scan_all(args, deps, formulas)?;
        }
        Expr::Member { target, name } => {
            match target.as_ref() {
                Expr::Identifier(root) if root == "formula" => {
                    deps.reads_formulas = true;
                    formulas.insert(name.clone());
                }
                Expr::Identifier(root) if root == "note" => deps.reads_properties = true,
                _ => {}
            }
            match name.as_str() {
                "links" | "embeds" => deps.reads_links = true,
                "backlinks" => deps.reads_backlinks = true,
                "properties" => deps.reads_properties = true,
                _ => {}
            }
            scan(target, deps, formulas)?;
        }
        Expr::Identifier(name) => match name.as_str() {
            "this" => deps.reads_this = true,
            "file" | "formula" | "values" | "value" | "index" | "acc" => {}
            _ => deps.reads_properties = true,
        },
        Expr::Index { target, index } => {
            scan(target, deps, formulas)?;
            scan(index, deps, formulas)?;
        }
        Expr::List(items) => scan_all(items, deps, formulas)?,
        Expr::Object(entries) => {
            for (_, value) in entries {
                scan(value, deps, formulas)?;
            }
        }
        Expr::Unary { operand, .. } => scan(operand, deps, formulas)?,
        Expr::Binary { left, right, .. } => {
            scan(left, deps, formulas)?;
            scan(right, deps, formulas)?;
        }
        Expr::Null | Expr::Boolean(_) | Expr::Number(_) | Expr::String(_) | Expr::Regexp { .. } => {
        }
    }
    Ok(())
}

fn note_ref(reference: &PropertyRef, deps: &mut ViewDependencies, formulas: &mut BTreeSet<String>) {
    match reference {
        PropertyRef::Formula(name) => {
            deps.reads_formulas = true;
            formulas.insert(name.clone());
        }
        PropertyRef::Note(_) => deps.reads_properties = true,
        PropertyRef::File(field) => match field.as_str() {
            "links" | "embeds" => deps.reads_links = true,
            "backlinks" => deps.reads_backlinks = true,
            "properties" => deps.reads_properties = true,
            _ => {}
        },
    }
}

/// The base's `properties` settings for one column: the entry declared
/// under the same key, else one naming the same property another way
/// (`status` and `note.status`).
fn column(base: &BaseFile, property: &str) -> ColumnDecl {
    let reference = property_ref(property);
    let settings = base
        .properties
        .iter()
        .find(|(key, _)| key == property)
        .or_else(|| {
            base.properties
                .iter()
                .find(|(key, _)| property_ref(key) == reference)
        })
        .map(|(_, settings)| settings.clone());
    ColumnDecl {
        property: property.to_string(),
        display_name: settings
            .as_ref()
            .and_then(|settings| settings.display_name.clone()),
        settings: settings
            .map(|settings| settings.options)
            .unwrap_or_default(),
    }
}

/// Compile one view of `base`: the named one (matched exactly), or the first
/// when `view` is `None`. Only what the view reads is parsed, so a broken
/// formula fails only the views that read it.
pub fn compile_view(base: &BaseFile, view: Option<&str>) -> Result<CompiledView, CompileError> {
    let decl = base
        .view(view)
        .cloned()
        .ok_or_else(|| CompileError::ViewNotFound {
            declared: base.view_names(),
        })?;
    let mut filters = Vec::new();
    if let Some(global) = &base.filters {
        filters.push(compile_filter(global, 1)?);
    }
    if let Some(local) = &decl.filters {
        filters.push(compile_filter(local, 1)?);
    }

    let mut deps = ViewDependencies::default();
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    let mut exprs = Vec::new();
    for filter in &filters {
        filter_exprs(filter, &mut exprs);
    }
    for expr in exprs {
        scan(expr, &mut deps, &mut wanted)?;
    }

    let columns: Vec<ColumnDecl> = decl
        .order
        .iter()
        .map(|property| column(base, property))
        .collect();
    let sort: Vec<(PropertyRef, Direction)> = decl
        .sort
        .iter()
        .map(|key| (property_ref(&key.property), key.direction))
        .collect();
    let group = decl
        .group_by
        .as_ref()
        .map(|group| (property_ref(&group.property), group.direction));
    for reference in columns
        .iter()
        .map(|column| property_ref(&column.property))
        .chain(sort.iter().map(|(reference, _)| reference.clone()))
        .chain(group.iter().map(|(reference, _)| reference.clone()))
    {
        note_ref(&reference, &mut deps, &mut wanted);
    }

    let mut summaries = Vec::new();
    for (property, name) in &decl.summaries {
        let reference = property_ref(property);
        note_ref(&reference, &mut deps, &mut wanted);
        let custom = match base.summaries.iter().rev().find(|(key, _)| key == name) {
            Some((_, text)) => {
                let expr = parse(text)?;
                scan(&expr, &mut deps, &mut wanted)?;
                Some(expr)
            }
            None if BUILTIN_SUMMARIES.contains(&name.as_str()) => None,
            None => return Err(CompileError::UnsupportedFunction { name: name.clone() }),
        };
        summaries.push(SummaryDecl {
            property: property.clone(),
            reference,
            name: name.clone(),
            custom,
        });
    }

    // Formulas the view reads, transitively (a work list, not recursion).
    // One that does not parse fails this view; one no view reads fails
    // nothing.
    let mut formulas = BTreeMap::new();
    let mut queue: Vec<String> = wanted.iter().cloned().collect();
    while let Some(name) = queue.pop() {
        if formulas.contains_key(&name) {
            continue;
        }
        let Some((_, text)) = base.formulas.iter().rev().find(|(key, _)| *key == name) else {
            // An undeclared formula is an error cell per row, not a compile
            // failure: Obsidian keeps the column and shows nothing usable.
            continue;
        };
        let expr = parse(text)?;
        let mut more = BTreeSet::new();
        scan(&expr, &mut deps, &mut more)?;
        queue.extend(more.into_iter().filter(|next| !formulas.contains_key(next)));
        let height = height(&expr);
        formulas.insert(name, (expr, height));
    }

    let mut prefilters = Vec::new();
    for filter in &filters {
        top_level_prefilters(filter, &mut prefilters);
    }
    deps.prefilters = prefilters.clone();
    Ok(CompiledView {
        decl,
        filters,
        formulas,
        columns,
        sort,
        group,
        summaries,
        prefilters,
        dependencies: deps,
    })
}

/// Only conjuncts at the top of the tree may narrow: an `and`'s children and
/// a bare statement. Nothing under `or` or `not` is a prefilter.
fn top_level_prefilters(filter: &Filter, out: &mut Vec<Prefilter>) {
    match filter {
        Filter::Expr(expr, _) => prefilter::extract(expr, out),
        Filter::And(items) => items
            .iter()
            .for_each(|item| top_level_prefilters(item, out)),
        Filter::Or(_) | Filter::Not(_) => {}
    }
}

/// `formula.x`, memoized per row, with cycle detection and a depth budget.
struct FormulaTable<'v> {
    formulas: &'v BTreeMap<String, (Expr, usize)>,
    memo: RefCell<BTreeMap<(VaultPath, String), Cell>>,
    active: RefCell<Vec<String>>,
    /// An upper bound on the expression levels on the stack: the height of
    /// the statement being evaluated plus the height of each formula
    /// entered. A formula is read through a `formula.x` node its caller's
    /// height already counts, so one formula read directly may be as tall
    /// as the parser allows.
    depth: std::cell::Cell<usize>,
}

impl FormulaTable<'_> {
    /// Evaluate a statement of `height` levels as the root of the budget.
    fn rooted(&self, height: usize, run: impl FnOnce() -> Cell) -> Cell {
        let before = self.depth.replace(height);
        let result = run();
        self.depth.set(before);
        result
    }
}

impl Formulas for FormulaTable<'_> {
    fn formula(
        &self,
        name: &str,
        ctx: &EvalContext<'_>,
        scope: &Scope,
    ) -> Result<Value, EvalError> {
        let Some(row) = &scope.row else {
            return Err(EvalError::UnknownFormula(name.to_string()));
        };
        let key = (row.clone(), name.to_string());
        if let Some(done) = self.memo.borrow().get(&key) {
            return done.clone();
        }
        if self.active.borrow().iter().any(|active| active == name) {
            return Err(EvalError::FormulaCycle(name.to_string()));
        }
        let Some((expr, height)) = self.formulas.get(name) else {
            return Err(EvalError::UnknownFormula(name.to_string()));
        };
        let before = self.depth.get();
        let depth = before + height;
        if depth > MAX_DEPTH {
            // Not memoized: the same formula entered from a shallower place
            // may fit.
            return Err(EvalError::FormulaTooDeep { max: MAX_DEPTH });
        }
        self.depth.set(depth);
        self.active.borrow_mut().push(name.to_string());
        // Formulas see the row and nothing a lambda bound around the caller.
        let result = evaluate(expr, ctx, &Scope::row(row));
        self.active.borrow_mut().pop();
        self.depth.set(before);
        if !matches!(result, Err(EvalError::FormulaTooDeep { .. })) {
            self.memo.borrow_mut().insert(key, result.clone());
        }
        result
    }
}

fn read(reference: &PropertyRef, ctx: &EvalContext<'_>, row: &VaultPath) -> Cell {
    let scope = Scope::row(row);
    match reference {
        PropertyRef::File(field) => functions::field(&Value::File(row.clone()), field, ctx),
        PropertyRef::Formula(name) => ctx.formulas.formula(name, ctx, &scope),
        PropertyRef::Note(key) => row_property(ctx, &scope, key),
    }
}

/// A filter's verdict for one row, three-valued: `None` is a statement that
/// errored. An error is "unknown", not "false" — otherwise `not` would turn
/// an erroring statement into an admitted row. `and` is false if any child
/// is false, else unknown if any is unknown; `or` is true if any child is
/// true, else unknown if any is unknown; `not` (the views page: "results
/// will not be shown if any of the conditions in the filter group are met")
/// is false if any child is true, else unknown if any is unknown. An unknown
/// verdict at the top excludes the row. **Provisional** — `filter:error_row`
/// (Task 13) settles whether Obsidian shows such a row.
fn verdict(
    filter: &Filter,
    ctx: &EvalContext<'_>,
    table: &FormulaTable<'_>,
    row: &VaultPath,
) -> Option<bool> {
    let children = |items: &[Filter]| -> Vec<Option<bool>> {
        items
            .iter()
            .map(|item| verdict(item, ctx, table, row))
            .collect()
    };
    let combine = |all: Vec<Option<bool>>, decisive: bool, otherwise: bool| {
        if all.contains(&Some(decisive)) {
            Some(!otherwise)
        } else if all.contains(&None) {
            None
        } else {
            Some(otherwise)
        }
    };
    match filter {
        Filter::Expr(expr, height) => table
            .rooted(*height, || evaluate(expr, ctx, &Scope::row(row)))
            .ok()
            .map(|value| truthy(&value)),
        // Any false makes it false; else all true makes it true.
        Filter::And(items) => combine(children(items), false, true),
        // Any true makes it true; else all false makes it false.
        Filter::Or(items) => combine(children(items), true, false),
        // Any true makes it false; else all false makes it true.
        Filter::Not(items) => combine(children(items), true, true),
    }
}

fn directed(ordering: Ordering, direction: Direction) -> Ordering {
    match direction {
        Direction::Asc => ordering,
        Direction::Desc => ordering.reverse(),
    }
}

/// An error cell sorts with the empty values: last ascending, and first
/// descending, since `DESC` reverses the whole total order. **Provisional**,
/// with the mixed-type order (`sort:mixed`, `sort:empty_descending`).
fn order(a: &Cell, b: &Cell) -> Ordering {
    sort_order(
        a.as_ref().unwrap_or(&Value::Null),
        b.as_ref().unwrap_or(&Value::Null),
    )
}

/// One row of a view's answer.
#[derive(Clone, Debug)]
pub struct RowResult {
    pub path: VaultPath,
    pub kind: FileKind,
    /// The row's `groupBy` key, when the view groups.
    pub group: Option<Cell>,
    /// One cell per [`CompiledView::columns`] entry, in order.
    pub cells: Vec<Cell>,
}

/// One summary of a view's answer.
#[derive(Clone, Debug)]
pub struct SummaryResult {
    /// The key the view's `summaries` map declares it under.
    pub property: String,
    /// The summary: a built-in name or a key of the base's `summaries`.
    pub name: String,
    pub value: Cell,
}

#[derive(Clone, Debug)]
pub struct ViewResult {
    pub rows: Vec<RowResult>,
    pub summaries: Vec<SummaryResult>,
    pub total_rows: usize,
}

struct Kept {
    path: VaultPath,
    keys: Vec<Cell>,
    group: Option<Cell>,
}

/// Evaluate one compiled view. Only a row-source failure is an `Err`: every
/// expression failure is an error cell, a filtered-out row, or an error
/// summary, as the spec's error-handling section lays out.
pub fn evaluate_view(
    view: &CompiledView,
    ctx: &EvalContext<'_>,
) -> Result<ViewResult, SourceError> {
    let table = FormulaTable {
        formulas: &view.formulas,
        memo: RefCell::new(BTreeMap::new()),
        active: RefCell::new(Vec::new()),
        depth: std::cell::Cell::new(0),
    };
    let ctx = ctx.reborrow().with_formulas(&table);

    let mut rows: Vec<Kept> = Vec::new();
    for path in ctx.source.candidates(&view.prefilters)? {
        if view
            .filters
            .iter()
            .all(|filter| verdict(filter, &ctx, &table, &path) == Some(true))
        {
            let keys = view
                .sort
                .iter()
                .map(|(reference, _)| read(reference, &ctx, &path))
                .collect();
            let group = view
                .group
                .as_ref()
                .map(|(reference, _)| read(reference, &ctx, &path));
            rows.push(Kept { path, keys, group });
        }
    }

    // `sort_by` is stable: rows equal on every key keep path order.
    rows.sort_by(|a, b| {
        for (index, (_, direction)) in view.sort.iter().enumerate() {
            let ordering = directed(order(&a.keys[index], &b.keys[index]), *direction);
            if ordering.is_ne() {
                return ordering;
            }
        }
        Ordering::Equal
    });
    // `limit` counts sorted rows before grouping (`limit:before_group`, the
    // spec's stated order; the capture settles it).
    if let Some(limit) = view.decl.limit {
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    }
    // Stable again, so the sorted order holds inside each group.
    if let Some((_, direction)) = &view.group {
        let null = Ok(Value::Null);
        rows.sort_by(|a, b| {
            let a = a.group.as_ref().unwrap_or(&null);
            let b = b.group.as_ref().unwrap_or(&null);
            directed(order(a, b), *direction)
        });
    }

    let mut results = Vec::with_capacity(rows.len());
    for Kept { path, group, .. } in rows {
        let kind = functions::file::kind_of(&ctx, &path).map_err(|error| match error {
            EvalError::Source(error) => error,
            other => SourceError(other.to_string()),
        })?;
        let cells = view
            .columns
            .iter()
            .map(|column| read(&property_ref(&column.property), &ctx, &path))
            .collect();
        results.push(RowResult {
            path,
            kind,
            group,
            cells,
        });
    }

    let summaries = view
        .summaries
        .iter()
        .map(|summary| {
            // An error cell counts as `null` in the column's values.
            let values: Vec<Value> = results
                .iter()
                .map(|row| read(&summary.reference, &ctx, &row.path).unwrap_or(Value::Null))
                .collect();
            let value = match &summary.custom {
                Some(expr) => evaluate(
                    expr,
                    &ctx,
                    &Scope::default().bind("values", Value::list(values)),
                ),
                None => summary::builtin(&summary.name, &values),
            };
            SummaryResult {
                property: summary.property.clone(),
                name: summary.name.clone(),
                value,
            }
        })
        .collect();

    Ok(ViewResult {
        total_rows: results.len(),
        rows: results,
        summaries,
    })
}
