use super::token::{Spanned, Token, tokenize};
use super::{BinaryOp, Expr, ExpressionError, UnaryOp};

struct Parser {
    tokens: Vec<Spanned>,
    at: usize,
    end: usize,
}

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
            message: message.into(),
            position: self.position(),
        }
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

    fn expression(&mut self, minimum: u8) -> Result<Expr, ExpressionError> {
        let mut left = self.prefix()?;
        while let Some(spanned) = self.peek() {
            let Some((op, power)) = binary(&spanned.token) else {
                break;
            };
            if power < minimum {
                break;
            }
            self.at += 1;
            // Left-associative: the right operand binds strictly tighter.
            let right = self.expression(power + 1)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn arguments(&mut self, close: &str) -> Result<Vec<Expr>, ExpressionError> {
        let mut args = Vec::new();
        if self.eat(close) {
            return Ok(args);
        }
        loop {
            args.push(self.expression(1)?);
            if self.eat(close) {
                return Ok(args);
            }
            self.expect(",")?;
        }
    }

    fn prefix(&mut self) -> Result<Expr, ExpressionError> {
        let Some(spanned) = self.peek().cloned() else {
            return Err(self.error("expected an expression"));
        };
        self.at += 1;
        let primary = match spanned.token {
            Token::Number(number) => Expr::Number(number),
            Token::String(text) => Expr::String(text),
            Token::Regexp { source, flags } => Expr::Regexp { source, flags },
            Token::Ident(name) => match name.as_str() {
                "true" => Expr::Boolean(true),
                "false" => Expr::Boolean(false),
                "null" => Expr::Null,
                _ => {
                    if self.eat("(") {
                        let args = self.arguments(")")?;
                        Expr::Call {
                            name,
                            args,
                            position: spanned.start,
                        }
                    } else {
                        Expr::Identifier(name)
                    }
                }
            },
            Token::Punct("(") => {
                let inner = self.expression(1)?;
                self.expect(")")?;
                inner
            }
            Token::Punct("[") => Expr::List(self.arguments("]")?),
            Token::Punct("{") => {
                let mut entries = Vec::new();
                if !self.eat("}") {
                    loop {
                        let key = match self.peek().cloned() {
                            Some(Spanned {
                                token: Token::String(key),
                                ..
                            })
                            | Some(Spanned {
                                token: Token::Ident(key),
                                ..
                            }) => key,
                            _ => return Err(self.error("expected an object key")),
                        };
                        self.at += 1;
                        self.expect(":")?;
                        entries.push((key, self.expression(1)?));
                        if self.eat("}") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                Expr::Object(entries)
            }
            Token::Punct("!") => Expr::Unary {
                op: UnaryOp::Not,
                operand: Box::new(self.expression(PREFIX_POWER)?),
            },
            Token::Punct("-") => Expr::Unary {
                op: UnaryOp::Negate,
                operand: Box::new(self.expression(PREFIX_POWER)?),
            },
            Token::Punct(_) => {
                self.at -= 1;
                return Err(self.error("expected an expression"));
            }
        };
        self.postfix(primary)
    }

    fn postfix(&mut self, mut target: Expr) -> Result<Expr, ExpressionError> {
        loop {
            if self.eat(".") {
                let Some(Spanned {
                    token: Token::Ident(name),
                    start,
                }) = self.peek().cloned()
                else {
                    return Err(self.error("expected a name after `.`"));
                };
                self.at += 1;
                if self.eat("(") {
                    let args = self.arguments(")")?;
                    target = Expr::Method {
                        target: Box::new(target),
                        name,
                        args,
                        position: start,
                    };
                } else {
                    target = Expr::Member {
                        target: Box::new(target),
                        name,
                    };
                }
            } else if self.eat("[") {
                let index = self.expression(1)?;
                self.expect("]")?;
                target = Expr::Index {
                    target: Box::new(target),
                    index: Box::new(index),
                };
            } else {
                return Ok(target);
            }
        }
    }
}

/// Parse one expression string. The whole input must be one expression:
/// trailing tokens are an error naming where they start.
pub fn parse_expression(text: &str) -> Result<Expr, ExpressionError> {
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
        end: text.len(),
    };
    let expr = parser.expression(1)?;
    if parser.peek().is_some() {
        return Err(parser.error("unexpected token after the expression"));
    }
    Ok(expr)
}
