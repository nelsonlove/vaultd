//! The Bases expression language: one string to one tree.
//!
//! The grammar is the one the published syntax page describes, read with
//! JavaScript's precedence (the functions page: "Bases functions follow
//! JavaScript behavior"): `||` < `&&` < `== !=` < `< <= > >=` < `+ -` <
//! `* / %` < prefix `! -` < postfix `.name`, `[index]`, `(args)`.

mod parse;
mod token;

pub use parse::parse_expression;

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Regexp {
        source: String,
        flags: String,
    },
    List(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    /// A bare name: a note property (`price`), or one of the reserved roots
    /// `note`, `file`, `formula`, `this`, `values`, `value`, `index`, `acc`.
    Identifier(String),
    Member {
        target: Box<Expr>,
        name: String,
    },
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
    /// A global function call; `position` is the byte offset of the name.
    Call {
        name: String,
        args: Vec<Expr>,
        position: usize,
    },
    /// A method call; `position` is the byte offset of the method name.
    Method {
        target: Box<Expr>,
        name: String,
        args: Vec<Expr>,
        position: usize,
    },
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnaryOp {
    Not,
    Negate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

/// The deepest expression tree the parser builds, in nesting levels: a leaf
/// is one level, and each operator, call, member access, index, list, object
/// or parenthesis around it adds one.
///
/// A `.base` file is untrusted text, and everything that walks the tree
/// (the parser itself, `Drop`, `Clone`, `PartialEq`, `Debug` and the
/// evaluator) recurses once per level. Without a cap, a few kilobytes of
/// `((((…` or `a.b.b.b…` overflow the stack, and a stack overflow aborts the
/// whole daemon rather than failing one view.
///
/// Why 64 and not more: in a debug build the evaluator spends up to about
/// 10 KiB of stack per level (nested eager calls such as `max(max(…))`), so
/// 256 nested calls needed 2.5 MiB, and the daemon's connection threads have
/// 2 MiB. No real base nests past a handful of levels, so 64 keeps every
/// shape inside a 1 MiB stack, with room for the families still to come.
pub const MAX_DEPTH: usize = 64;

/// An expression that does not parse, with the byte offset into the
/// expression text where the parser gave up.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpressionError {
    pub kind: ExpressionErrorKind,
    pub message: String,
    pub position: usize,
}

/// Why an expression does not parse.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpressionErrorKind {
    /// The text is not in the grammar; `message` says what was expected.
    Syntax,
    /// The text nests deeper than `max` levels
    /// ([`MAX_DEPTH`]).
    ExpressionTooDeep { max: usize },
}
