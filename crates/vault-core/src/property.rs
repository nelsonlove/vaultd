use crate::{SourceSpan, Spanned};

#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<Spanned<PropertyValue>>),
    Mapping(Vec<(Spanned<String>, Spanned<PropertyValue>)>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Property {
    pub key: Spanned<String>,
    pub value: Spanned<PropertyValue>,
    pub span: SourceSpan,
}
