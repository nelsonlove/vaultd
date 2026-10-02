use super::token::{Spanned, Token, tokenize};
use super::{BinaryOp, Expr, ExpressionError, ExpressionErrorKind, MAX_DEPTH, UnaryOp};

struct Parser {
    tokens: Vec<Spanned>,
    at: usize,
    end: usize,
    /// How many `expression` calls are open, so that parentheses, which
    /// add no node, still cannot recurse past the cap.
    depth: usize,
}

/// A parsed subtree and its height in levels (a leaf is 1).
type Node = (Expr, usize);

fn binary(token: &Token) -> Option<(BinaryOp, u8)> {
    let Token::Punct(punct) = token else {
        return None;
    };
    Some(match *punct {
        "||" => (BinaryOp::Or, 1),
        "&&" => (BinaryOp::And, 2),
        "==" => (BinaryOp::Eq, 3),
        "!=" => (BinaryOp::Ne, 3),
        "<" => (BinaryOp::Lt, 4),
        "<=" => (BinaryOp::Le, 4),
        ">" => (BinaryOp::Gt, 4),
        ">=" => (BinaryOp::Ge, 4),
        "+" => (BinaryOp::Add, 5),
        "-" => (BinaryOp::Sub, 5),
        "*" => (BinaryOp::Mul, 6),
        "/" => (BinaryOp::Div, 6),
        "%" => (BinaryOp::Rem, 6),
        _ => return None,
    })
}

const PREFIX_POWER: u8 = 7;

impl Parser {
    fn peek(&self) -> Option<&Spanned> {
        self.tokens.get(self.at)
    }

    fn position(&self) -> usize {
        self.peek().map_or(self.end, |spanned| spanned.start)
    }

    fn error(&self, message: impl Into<String>) -> ExpressionError {
        ExpressionError {
            kind: ExpressionErrorKind::Syntax,
            message: message.into(),
            position: self.position(),
        }
    }

    fn too_deep(&self) -> ExpressionError {
        ExpressionError {
            kind: ExpressionErrorKind::ExpressionTooDeep { max: MAX_DEPTH },
            message: format!("expression nested too deeply (more than {MAX_DEPTH} levels)"),
            position: self.position(),
        }
    }

    /// The height of a node over children of height `children`, or the
    /// typed error when it would pass the cap. Every node that wraps another
    /// gets its height here, so no tree deeper than the cap can exist.
    fn wrap(&self, children: usize) -> Result<usize, ExpressionError> {
        let height = children + 1;
        if height > MAX_DEPTH {
            return Err(self.too_deep());
        }
        Ok(height)
    }

    fn eat(&mut self, punct: &str) -> bool {
        if matches!(self.peek(), Some(Spanned { token: Token::Punct(p), .. }) if *p == punct) {
            self.at += 1;
            return true;
        }
        false
    }

    fn expect(&mut self, punct: &str) -> Result<(), ExpressionError> {
        if self.eat(punct) {
            return Ok(());
        }
        Err(self.error(format!("expected `{punct}`")))
    }

    fn expression(&mut self, minimum: u8) -> Result<Node, ExpressionError> {
        if self.depth >= MAX_DEPTH {
            return Err(self.too_deep());
        }
        self.depth += 1;
        let result = self.binary_chain(minimum);
        self.depth -= 1;
        result
    }

    fn binary_chain(&mut self, minimum: u8) -> Result<Node, ExpressionError> {
        let (mut left, mut height) = self.prefix()?;
        while let Some(spanned) = self.peek() {
            let Some((op, power)) = binary(&spanned.token) else {
                break;
            };
            if power < minimum {
                break;
            }
            self.at += 1;
            // Left-associative: the right operand binds strictly tighter.
            let (right, right_height) = self.expression(power + 1)?;
            height = self.wrap(height.max(right_height))?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok((left, height))
    }

    /// Comma-separated expressions up to `close`, and the tallest one's
    /// height (0 when there are none). A comma before `close` is accepted
    /// only when `trailing_comma` is set.
    fn arguments(
        &mut self,
        close: &str,
        trailing_comma: bool,
    ) -> Result<(Vec<Expr>, usize), ExpressionError> {
        let mut args = Vec::new();
        let mut height = 0;
        if self.eat(close) {
            return Ok((args, height));
        }
        loop {
            let (arg, arg_height) = self.expression(1)?;
            args.push(arg);
            height = height.max(arg_height);
            if self.eat(close) {
                return Ok((args, height));
            }
            self.expect(",")?;
            if trailing_comma && self.eat(close) {
                return Ok((args, height));
            }
        }
    }

    /// A call's arguments after its `(`. A trailing comma is accepted, as in
    /// JavaScript. Provisional (ruling N3, 2026-10-02): Task 13's capture
    /// settles it.
    fn call_arguments(&mut self) -> Result<(Vec<Expr>, usize), ExpressionError> {
        self.arguments(")", true)
    }

    // Each compound form below has its own function rather than an arm of
    // one large match: an unoptimised build gives a function one stack slot
    // per local of every arm, and these frames repeat once per nesting
    // level, so small frames are what keep MAX_DEPTH levels
    // inside a 2 MiB thread stack.

    fn prefix(&mut self) -> Result<Node, ExpressionError> {
        let primary = self.primary()?;
        self.postfix(primary)
    }

    fn primary(&mut self) -> Result<Node, ExpressionError> {
        let Some(spanned) = self.peek().cloned() else {
            return Err(self.error("expected an expression"));
        };
        self.at += 1;
        Ok(match spanned.token {
            Token::Number(number) => (Expr::Number(number), 1),
            Token::String(text) => (Expr::String(text), 1),
            Token::Regexp { source, flags } => (Expr::Regexp { source, flags }, 1),
            Token::Ident(name) => return self.name(name, spanned.start),
            Token::Punct("(") => return self.parenthesized(),
            Token::Punct("[") => return self.list(),
            Token::Punct("{") => return self.object(),
            Token::Punct("!") => return self.unary(UnaryOp::Not),
            Token::Punct("-") => return self.unary(UnaryOp::Negate),
            Token::Punct(_) => {
                self.at -= 1;
                return Err(self.error("expected an expression"));
            }
        })
    }

    /// A literal keyword, a global call, or a bare identifier.
    fn name(&mut self, name: String, start: usize) -> Result<Node, ExpressionError> {
        Ok(match name.as_str() {
            "true" => (Expr::Boolean(true), 1),
            "false" => (Expr::Boolean(false), 1),
            "null" => (Expr::Null, 1),
            _ if self.eat("(") => {
                let (args, height) = self.call_arguments()?;
                let height = self.wrap(height)?;
                let call = Expr::Call {
                    name,
                    args,
                    position: start,
                };
                (call, height)
            }
            _ => (Expr::Identifier(name), 1),
        })
    }

    fn parenthesized(&mut self) -> Result<Node, ExpressionError> {
        let inner = self.expression(1)?;
        self.expect(")")?;
        Ok(inner)
    }

    fn list(&mut self) -> Result<Node, ExpressionError> {
        let (items, height) = self.arguments("]", false)?;
        Ok((Expr::List(items), self.wrap(height)?))
    }

    fn object(&mut self) -> Result<Node, ExpressionError> {
        let mut entries = Vec::new();
        let mut height = 0;
        if !self.eat("}") {
            loop {
                let key = self.object_key()?;
                self.expect(":")?;
                let (value, value_height) = self.expression(1)?;
                entries.push((key, value));
                height = height.max(value_height);
                if self.eat("}") {
                    break;
                }
                self.expect(",")?;
            }
        }
        Ok((Expr::Object(entries), self.wrap(height)?))
    }

    fn object_key(&mut self) -> Result<String, ExpressionError> {
        let key = match self.peek() {
            Some(Spanned {
                token: Token::String(key) | Token::Ident(key),
                ..
            }) => key.clone(),
            _ => return Err(self.error("expected an object key")),
        };
        self.at += 1;
        Ok(key)
    }

    fn unary(&mut self, op: UnaryOp) -> Result<Node, ExpressionError> {
        let (operand, height) = self.expression(PREFIX_POWER)?;
        let height = self.wrap(height)?;
        let unary = Expr::Unary {
            op,
            operand: Box::new(operand),
        };
        Ok((unary, height))
    }

    fn postfix(&mut self, mut node: Node) -> Result<Node, ExpressionError> {
        loop {
            if self.eat(".") {
                node = self.member(node)?;
            } else if self.eat("[") {
                node = self.index(node)?;
            } else {
                return Ok(node);
            }
        }
    }

    /// `.name` or `.name(args)` after `target`, the `.` already eaten.
    fn member(&mut self, (target, height): Node) -> Result<Node, ExpressionError> {
        let (name, start) = match self.peek() {
            Some(Spanned {
                token: Token::Ident(name),
                start,
            }) => (name.clone(), *start),
            _ => return Err(self.error("expected a name after `.`")),
        };
        self.at += 1;
        if !self.eat("(") {
            let member = Expr::Member {
                target: Box::new(target),
                name,
            };
            return Ok((member, self.wrap(height)?));
        }
        let (args, args_height) = self.call_arguments()?;
        let height = self.wrap(height.max(args_height))?;
        let method = Expr::Method {
            target: Box::new(target),
            name,
            args,
            position: start,
        };
        Ok((method, height))
    }

    /// `[index]` after `target`, the `[` already eaten.
    fn index(&mut self, (target, height): Node) -> Result<Node, ExpressionError> {
        let (index, index_height) = self.expression(1)?;
        self.expect("]")?;
        let height = self.wrap(height.max(index_height))?;
        let index = Expr::Index {
            target: Box::new(target),
            index: Box::new(index),
        };
        Ok((index, height))
    }
}

/// Parse one expression string. The whole input must be one expression:
/// trailing tokens are an error naming where they start. An expression that
/// nests deeper than [`MAX_DEPTH`] levels is an
/// [`ExpressionErrorKind::ExpressionTooDeep`] error, never a stack overflow.
pub fn parse_expression(text: &str) -> Result<Expr, ExpressionError> {
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
        end: text.len(),
        depth: 0,
    };
    let (expr, _) = parser.expression(1)?;
    if parser.peek().is_some() {
        return Err(parser.error("unexpected token after the expression"));
    }
    Ok(expr)
}
