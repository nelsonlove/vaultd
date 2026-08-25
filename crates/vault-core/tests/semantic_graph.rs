use std::{collections::BTreeMap, fs, path::Path};

use blake3::Hash;
use serde_json::{Value, json};
use vault_core::{
    Diagnostic, DiagnosticCode, FileSystemVaultSource, ReferenceKind, ReferenceOrigin, Resolution,
    ResolvedReference, ScanReport, SemanticGraph, Severity, Subpath, scan_vault,
};

fn fixture_root() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/semantic-read-path/basic-vault"
    ))
}

fn digest_tree(root: &Path) -> BTreeMap<String, Hash> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            let relative = entry
                .path()
                .strip_prefix(root)
                .expect("inside fixture root");
            let bytes = fs::read(entry.path()).expect("read fixture");
            (
                relative.to_string_lossy().replace('\\', "/"),
                blake3::hash(&bytes),
            )
        })
        .collect()
}

fn expected(name: &str) -> Value {
    let path = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/semantic-read-path/expected"
    ))
    .join(name);
    serde_json::from_slice(&fs::read(path).expect("read expected snapshot"))
        .expect("valid expected JSON")
}

fn kind_name(kind: ReferenceKind) -> &'static str {
    match kind {
        ReferenceKind::MarkdownLink => "markdown_link",
        ReferenceKind::Wikilink => "wikilink",
        ReferenceKind::MarkdownEmbed => "markdown_embed",
        ReferenceKind::WikiEmbed => "wiki_embed",
    }
}

fn origin_name(origin: ReferenceOrigin) -> &'static str {
    match origin {
        ReferenceOrigin::Body => "body",
        ReferenceOrigin::Property => "property",
    }
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}

fn code_name(code: DiagnosticCode) -> &'static str {
    match code {
        DiagnosticCode::InaccessibleVaultRoot => "inaccessible_vault_root",
        DiagnosticCode::UnreadableFile => "unreadable_file",
        DiagnosticCode::InvalidUtf8 => "invalid_utf8",
        DiagnosticCode::SymlinkOutsideVault => "symlink_outside_vault",
        DiagnosticCode::UnterminatedFrontmatter => "unterminated_frontmatter",
        DiagnosticCode::MalformedFrontmatter => "malformed_frontmatter",
        DiagnosticCode::UnsupportedPropertyShape => "unsupported_property_shape",
        DiagnosticCode::MarkdownParseError => "markdown_parse_error",
        DiagnosticCode::MalformedWikilink => "malformed_wikilink",
        DiagnosticCode::MalformedTag => "malformed_tag",
        DiagnosticCode::MalformedBlockId => "malformed_block_id",
        DiagnosticCode::UnresolvedReference => "unresolved_reference",
        DiagnosticCode::AmbiguousReference => "ambiguous_reference",
        DiagnosticCode::MissingHeading => "missing_heading",
        DiagnosticCode::MissingBlock => "missing_block",
    }
}

fn subpath_json(subpath: &Option<Subpath>) -> Value {
    match subpath {
        None => Value::Null,
        Some(Subpath::Heading(heading)) => json!({ "heading": heading }),
        Some(Subpath::Block(block)) => json!({ "block": block }),
    }
}

fn reference_json(resolved: &ResolvedReference) -> Value {
    json!({
        "source": resolved.source.as_str(),
        "rawTarget": resolved.reference.raw_target,
    })
}

fn snapshot_notes(graph: &SemanticGraph) -> Value {
    let notes = graph
        .notes()
        .map(|note| {
            json!({
                "path": note.source.path().as_str(),
                "aliases": note.aliases.iter().map(|alias| json!({
                    "value": alias.value,
                    "source": note.source.slice(alias.span),
                })).collect::<Vec<_>>(),
                "headings": note.headings.iter().map(|heading| json!({
                    "level": heading.level,
                    "text": heading.text,
                    "source": note.source.slice(heading.span),
                })).collect::<Vec<_>>(),
                "blocks": note.blocks.iter().map(|block| json!({
                    "value": block.value,
                    "source": note.source.slice(block.span),
                })).collect::<Vec<_>>(),
                "tags": note.tags.iter().map(|tag| json!({
                    "value": tag.value,
                    "comparisonKey": tag.comparison_key,
                    "source": note.source.slice(tag.span),
                })).collect::<Vec<_>>(),
                "references": note.references.iter().map(|reference| json!({
                    "kind": kind_name(reference.kind),
                    "origin": origin_name(reference.origin),
                    "rawTarget": reference.raw_target,
                    "source": note.source.slice(reference.span),
                    "targetSource": note.source.slice(reference.target_span),
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    json!({ "notes": notes })
}

fn snapshot_resolution(graph: &SemanticGraph) -> Value {
    let mut resolved = Vec::new();
    for path in graph.note_paths() {
        for outgoing in graph.outgoing(path) {
            if let Resolution::Resolved { target, subpath } = &outgoing.resolution {
                resolved.push(json!({
                    "source": outgoing.source.as_str(),
                    "rawTarget": outgoing.reference.raw_target,
                    "target": target.as_str(),
                    "subpath": subpath_json(subpath),
                }));
            }
        }
    }

    let mut backlinks = serde_json::Map::new();
    for path in graph.note_paths() {
        let incoming = graph.backlinks(path);
        if !incoming.is_empty() {
            backlinks.insert(
                path.as_str().to_string(),
                Value::Array(incoming.iter().map(reference_json).collect()),
            );
        }
    }

    json!({
        "resolved": resolved,
        "unresolved": graph.unresolved().iter().map(reference_json).collect::<Vec<_>>(),
        "ambiguous": graph.ambiguous().iter().map(|reference| {
            let Resolution::Ambiguous { candidates } = &reference.resolution else {
                panic!("ambiguous query returned a non-ambiguous resolution");
            };
            json!({
                "source": reference.source.as_str(),
                "rawTarget": reference.reference.raw_target,
                "candidates": candidates.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "backlinks": backlinks,
    })
}

fn diagnostic_json(diagnostic: &Diagnostic) -> Value {
    json!({
        "code": code_name(diagnostic.code),
        "severity": severity_name(diagnostic.severity),
        "path": diagnostic.path.as_ref().map(|path| path.as_str()),
    })
}

fn snapshot_diagnostics(report: &ScanReport) -> Value {
    json!({
        "diagnostics": report
            .diagnostics
            .iter()
            .map(diagnostic_json)
            .collect::<Vec<_>>(),
    })
}

#[test]
fn scans_the_compatibility_vault_without_modifying_it() {
    let before = digest_tree(fixture_root());
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("fixture root is accessible");
    let after = digest_tree(fixture_root());

    assert_eq!(before, after);
    assert_eq!(report.graph.note_paths().len(), 9);
    assert_eq!(snapshot_notes(&report.graph), expected("parsed-notes.json"));
    assert_eq!(
        snapshot_resolution(&report.graph),
        expected("resolution.json")
    );
    assert_eq!(snapshot_diagnostics(&report), expected("diagnostics.json"));
}

#[test]
fn every_public_span_is_in_bounds_and_slices_exact_source() {
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("scan fixture");

    for note in report.graph.notes() {
        for span in note.source_spans() {
            assert!(span.end() <= note.source.text().len());
            assert!(note.source.text().is_char_boundary(span.start()));
            assert!(note.source.text().is_char_boundary(span.end()));
            assert!(note.source.slice(span).is_some());
        }
    }
}

#[test]
fn graph_queries_are_stably_ordered() {
    let report = scan_vault(&FileSystemVaultSource::new(fixture_root()).expect("fixture root"))
        .expect("scan fixture");
    let graph = &report.graph;

    let headings = vault_core::VaultPath::new("Headings and blocks.md").expect("valid path");
    assert_eq!(graph.note_paths().len(), 9);
    assert_eq!(graph.backlinks(&headings).len(), 3);
    assert_eq!(graph.unresolved().len(), 2);
    assert_eq!(graph.ambiguous().len(), 1);
    assert!(matches!(
        graph.ambiguous()[0].resolution,
        Resolution::Ambiguous { .. }
    ));
}
