use saphyr::{LoadableYamlNode, MarkedYaml, Scalar, YamlData};

use crate::{
    Alias, Diagnostic, DiagnosticCode, Property, PropertyValue, Severity, SourceDocument,
    SourceSpan, Spanned, Tag,
};

pub(crate) struct FrontmatterParse {
    pub properties: Vec<Property>,
    pub aliases: Vec<Alias>,
    pub tags: Vec<Tag>,
    pub body_start: usize,
    pub diagnostics: Vec<Diagnostic>,
}

impl FrontmatterParse {
    fn empty(body_start: usize) -> Self {
        Self {
            properties: Vec::new(),
            aliases: Vec::new(),
            tags: Vec::new(),
            body_start,
            diagnostics: Vec::new(),
        }
    }
}

struct Fences {
    payload_start: usize,
    payload_end: usize,
    body_start: usize,
}

fn find_fences(text: &str) -> Option<Result<Fences, ()>> {
    let payload_start = if text.starts_with("---\n") {
        4
    } else if text.starts_with("---\r\n") {
        5
    } else {
        return None;
    };

    let mut offset = payload_start;
    for line in text[payload_start..].split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == "---" {
            return Some(Ok(Fences {
                payload_start,
                payload_end: offset,
                body_start: offset + line.len(),
            }));
        }
        offset += line.len();
    }
    Some(Err(()))
}

/// saphyr markers index the payload in CHARS, not bytes (measured against
/// saphyr 0.0.12; the parser's own field/accessor docs disagree with each
/// other). This table converts a char index into a byte offset.
struct CharToByte {
    offsets: Vec<usize>,
}

impl CharToByte {
    fn new(payload: &str) -> Self {
        let mut offsets: Vec<usize> = payload.char_indices().map(|(byte, _)| byte).collect();
        offsets.push(payload.len());
        Self { offsets }
    }

    fn byte(&self, char_index: usize) -> usize {
        self.offsets
            .get(char_index)
            .copied()
            .unwrap_or_else(|| *self.offsets.last().expect("offset table is never empty"))
    }
}

fn span_from_marked(node: &MarkedYaml, table: &CharToByte, payload_start: usize) -> SourceSpan {
    let start = payload_start + table.byte(node.span.start.index());
    let end = payload_start + table.byte(node.span.end.index());
    SourceSpan::new(start.min(end), end.max(start)).expect("ordered span from ordered offsets")
}

/// saphyr's end markers stop one character short of a flow collection's
/// closing bracket and overshoot block collections into trailing whitespace.
/// Adjust container spans so `text[span]` is the exact raw source (measured
/// against saphyr 0.0.12).
fn adjust_container_span(text: &str, span: SourceSpan) -> SourceSpan {
    let bytes = text.as_bytes();
    let start = span.start();
    let mut end = span.end().min(bytes.len());
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let closer = match bytes.get(start) {
        Some(b'[') => Some(b']'),
        Some(b'{') => Some(b'}'),
        _ => None,
    };
    if let Some(closer) = closer {
        let mut probe = end;
        while bytes
            .get(probe)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            probe += 1;
        }
        if bytes.get(probe) == Some(&closer) {
            end = probe + 1;
        }
    }
    SourceSpan::new(start, end.max(start)).expect("adjusted span is ordered")
}

fn unsupported(span: SourceSpan, message: &str) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::UnsupportedPropertyShape,
        Severity::Warning,
        message,
    )
    .with_span(span)
}

fn convert_value(
    node: &MarkedYaml,
    table: &CharToByte,
    payload_start: usize,
    text: &str,
) -> Result<Spanned<PropertyValue>, Diagnostic> {
    let mut span = span_from_marked(node, table, payload_start);
    let value = match &node.data {
        YamlData::Value(scalar) => match scalar {
            Scalar::Null => PropertyValue::Null,
            Scalar::Boolean(value) => PropertyValue::Boolean(*value),
            Scalar::Integer(value) => PropertyValue::Integer(*value),
            Scalar::FloatingPoint(value) => PropertyValue::Float(value.into_inner()),
            Scalar::String(value) => PropertyValue::String(value.to_string()),
        },
        YamlData::Sequence(items) => {
            span = adjust_container_span(text, span);
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                values.push(convert_value(item, table, payload_start, text)?);
            }
            PropertyValue::Sequence(values)
        }
        YamlData::Mapping(map) => {
            let mut entries = Vec::with_capacity(map.len());
            for (key, value) in map.iter() {
                let key_span = span_from_marked(key, table, payload_start);
                let YamlData::Value(Scalar::String(key_text)) = &key.data else {
                    return Err(unsupported(key_span, "mapping keys must be strings"));
                };
                entries.push((
                    Spanned::new(key_text.to_string(), key_span),
                    convert_value(value, table, payload_start, text)?,
                ));
            }
            span = adjust_container_span(text, span);
            PropertyValue::Mapping(entries)
        }
        YamlData::Tagged(_, inner) => {
            return convert_value(inner, table, payload_start, text).map(|converted| Spanned {
                value: converted.value,
                span,
            });
        }
        YamlData::Representation(..) | YamlData::Alias(_) | YamlData::BadValue => {
            return Err(unsupported(span, "unsupported YAML value"));
        }
    };
    Ok(Spanned::new(value, span))
}

fn convert_mapping(
    root: &MarkedYaml,
    table: &CharToByte,
    payload_start: usize,
    text: &str,
) -> Result<Vec<Property>, Diagnostic> {
    let YamlData::Mapping(map) = &root.data else {
        return Err(unsupported(
            span_from_marked(root, table, payload_start),
            "frontmatter must be a top-level mapping",
        ));
    };

    let mut properties = Vec::with_capacity(map.len());
    for (key, value) in map.iter() {
        let key_span = span_from_marked(key, table, payload_start);
        let YamlData::Value(Scalar::String(key_text)) = &key.data else {
            return Err(unsupported(key_span, "property keys must be strings"));
        };
        let value = convert_value(value, table, payload_start, text)?;
        let span = SourceSpan::new(key_span.start(), value.span.end().max(key_span.end()))
            .expect("property span is ordered");
        properties.push(Property {
            key: Spanned::new(key_text.to_string(), key_span),
            value,
            span,
        });
    }
    Ok(properties)
}

pub(crate) fn is_valid_tag_text(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
        && text.chars().any(|c| !c.is_numeric())
        && text.split('/').all(|segment| !segment.is_empty())
}

fn string_items(value: &Spanned<PropertyValue>) -> Result<Vec<(&str, SourceSpan)>, SourceSpan> {
    match &value.value {
        PropertyValue::String(text) => Ok(vec![(text.as_str(), value.span)]),
        PropertyValue::Sequence(items) => {
            let mut collected = Vec::with_capacity(items.len());
            for item in items {
                let PropertyValue::String(text) = &item.value else {
                    return Err(item.span);
                };
                collected.push((text.as_str(), item.span));
            }
            Ok(collected)
        }
        _ => Err(value.span),
    }
}

fn project_aliases_and_tags(
    properties: &[Property],
    aliases: &mut Vec<Alias>,
    tags: &mut Vec<Tag>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for property in properties {
        let key = property.key.value.to_lowercase();
        match key.as_str() {
            "aliases" | "alias" => match string_items(&property.value) {
                Ok(items) => {
                    for (text, span) in items {
                        aliases.push(Alias {
                            value: text.to_string(),
                            span,
                        });
                    }
                }
                Err(span) => diagnostics.push(unsupported(
                    span,
                    "aliases must be a string or a sequence of strings",
                )),
            },
            "tags" | "tag" => match string_items(&property.value) {
                Ok(items) => {
                    for (text, span) in items {
                        let candidate = text.strip_prefix('#').unwrap_or(text);
                        if is_valid_tag_text(candidate) {
                            tags.push(Tag {
                                value: candidate.to_string(),
                                comparison_key: candidate.to_lowercase(),
                                span,
                            });
                        } else {
                            diagnostics.push(
                                Diagnostic::new(
                                    DiagnosticCode::MalformedTag,
                                    Severity::Warning,
                                    format!("invalid tag {text:?}"),
                                )
                                .with_span(span),
                            );
                        }
                    }
                }
                Err(span) => diagnostics.push(unsupported(
                    span,
                    "tags must be a string or a sequence of strings",
                )),
            },
            _ => {}
        }
    }
}

pub(crate) fn parse_frontmatter(document: &SourceDocument) -> FrontmatterParse {
    let text = document.text();
    let fences = match find_fences(text) {
        None => return FrontmatterParse::empty(0),
        Some(Err(())) => {
            let mut parse = FrontmatterParse::empty(0);
            parse.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::UnterminatedFrontmatter,
                    Severity::Warning,
                    "frontmatter fence is never closed",
                )
                .with_path(document.path().clone())
                .with_span(SourceSpan::new(0, 3).expect("opening fence span")),
            );
            return parse;
        }
        Some(Ok(fences)) => fences,
    };

    let mut parse = FrontmatterParse::empty(fences.body_start);
    let payload = &text[fences.payload_start..fences.payload_end];
    if payload.trim().is_empty() {
        return parse;
    }

    let table = CharToByte::new(payload);
    let payload_span =
        SourceSpan::new(fences.payload_start, fences.payload_end).expect("payload span is ordered");

    let documents = match MarkedYaml::load_from_str(payload) {
        Ok(documents) => documents,
        Err(error) => {
            parse.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::MalformedFrontmatter,
                    Severity::Warning,
                    format!("frontmatter YAML failed to parse: {error}"),
                )
                .with_path(document.path().clone())
                .with_span(payload_span),
            );
            return parse;
        }
    };

    let root = match documents.as_slice() {
        [] => return parse,
        [root] => root,
        _ => {
            parse.diagnostics.push(
                unsupported(payload_span, "frontmatter must be one YAML document")
                    .with_path(document.path().clone()),
            );
            return parse;
        }
    };

    if matches!(root.data, YamlData::Value(Scalar::Null)) {
        return parse;
    }

    match convert_mapping(root, &table, fences.payload_start, text) {
        Ok(properties) => {
            parse.properties = properties;
            project_aliases_and_tags(
                &parse.properties,
                &mut parse.aliases,
                &mut parse.tags,
                &mut parse.diagnostics,
            );
        }
        Err(diagnostic) => {
            parse
                .diagnostics
                .push(diagnostic.with_path(document.path().clone()));
        }
    }
    parse
}

#[cfg(test)]
mod tests {
    use super::parse_frontmatter;
    use crate::{SourceDocument, VaultPath};

    #[test]
    fn malformed_closed_frontmatter_yields_body_start_at_recovered_markdown() {
        let text = "---\ntags: [broken\n---\n# Recoverable\n";
        let document = SourceDocument::new(VaultPath::new("Broken.md").expect("valid path"), text);
        let parse = parse_frontmatter(&document);
        assert_eq!(parse.body_start, text.find("# Recoverable").unwrap());
    }
}
