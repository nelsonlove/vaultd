//! Print snapshot-page JSON for markdown fed on stdin, one request per line.
//!
//! This exists so the host's test fixtures are produced by the real parser
//! rather than by hand. A parity test fed hand-written rows proves nothing: it
//! compares one person's idea of the parse against another's. A second parser
//! written in TypeScript would be worse still — two parsers means two answers
//! and no way to know which is right. So the host asks this, and this asks
//! `vault_core`.
//!
//! It is a test-support binary: it reads no vault, opens no index, takes no
//! lease, and writes nothing but its own stdout.
//!
//! **It prints exactly what a `snapshot_notes` page would carry** — a
//! `SnapshotNoteDto`, through `crate::convert::snapshot_note`, the same
//! function the daemon serves that page with. That is the whole point of
//! living in `vault-server` rather than beside the index: the host's
//! `mirrorNoteRow()` then converts these rows through the same code path a
//! real hydration uses, so a fixture cannot differ from the wire without the
//! wire's own converter differing too.
//!
//! Two request shapes, because resolution needs the whole vault and a parse
//! does not:
//!
//! - `{"path": "A.md", "source": "..."}` prints one `SnapshotNoteDto` line.
//!   Nothing else is in the resolver's catalog, so every link out of the note
//!   resolves to itself or to nothing — which is right for a fixture that is
//!   one note.
//! - `{"vault": [{"path": ..., "source": ...}, ...]}` prints one
//!   `{"rows": [...]}` line, in the order the notes were given, with every
//!   note resolved against every other. `FixtureVault` uses this one.
//!
//! A malformed line prints `{"error": "..."}` and the run continues, so a
//! caller batching a hundred fixtures learns which one it spelled wrong.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use vault_core::{
    Diagnostic, ParsedNote, Resolver, SourceDocument, VaultPath, parse_note, resolution_diagnostic,
};
use vault_index::{ListItemRow, SectionRow, SnapshotMetadata, SnapshotNoteRow};
use vault_protocol::SnapshotNoteDto;

#[derive(Deserialize)]
struct Document {
    path: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Request {
    /// Every note at once, resolved against each other.
    Vault { vault: Vec<Document> },
    /// One note, with nothing else in the catalog.
    One(Document),
}

#[derive(Serialize)]
struct Rows {
    rows: Vec<SnapshotNoteDto>,
}

#[derive(Serialize)]
struct Failure {
    error: String,
}

/// Read requests from `input`, write one answer line per request to `output`.
///
/// Flushing per line rather than at the end is deliberate: a caller that keeps
/// the child alive and reads as it goes would otherwise deadlock behind the
/// pipe buffer.
pub fn run(input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(Request::One(document)) => match note_rows(vec![document]) {
                Ok(rows) => {
                    let row = rows.into_iter().next().expect("one document, one row");
                    writeln!(output, "{}", json(&row))?;
                }
                Err(error) => writeln!(output, "{}", json(&Failure { error }))?,
            },
            Ok(Request::Vault { vault }) => match note_rows(vault) {
                Ok(rows) => writeln!(output, "{}", json(&Rows { rows }))?,
                Err(error) => writeln!(output, "{}", json(&Failure { error }))?,
            },
            Err(error) => writeln!(
                output,
                "{}",
                json(&Failure {
                    error: error.to_string()
                })
            )?,
        }
        output.flush()?;
    }
    Ok(())
}

/// The production parse, the production resolution, and the production DTO
/// mapping — in that order, with nothing reimplemented in between.
fn note_rows(documents: Vec<Document>) -> Result<Vec<SnapshotNoteDto>, String> {
    let mut notes = Vec::with_capacity(documents.len());
    for document in documents {
        let path = VaultPath::new(document.path).map_err(|error| error.to_string())?;
        notes.push(parse_note(SourceDocument::new(path, document.source)));
    }

    // The same catalog `build_graph` builds, and the same per-note resolution
    // call. `build_graph` itself is not used only because it hands back a
    // `SemanticGraph` keyed by path, and this needs each note beside its own
    // answers in the order the caller asked for them.
    let resolver = Resolver::new(&notes);
    Ok(notes.iter().map(|note| row(note, &resolver)).collect())
}

fn row(note: &ParsedNote, resolver: &Resolver) -> SnapshotNoteDto {
    let outgoing = resolver.resolve_note(note);

    // The diagnostics a snapshot page carries are the union the index stores:
    // the note's own parse diagnostics plus one per reference that failed to
    // resolve. (The third member of that union, the scan diagnostics, records
    // files the vault walk could not read — a fixture has none.) Sorted the way
    // `build_graph` sorts, so two runs over the same markdown cannot differ.
    let mut diagnostics: Vec<Diagnostic> = note.diagnostics.clone();
    diagnostics.extend(outgoing.iter().filter_map(resolution_diagnostic));
    diagnostics.sort_by(|a, b| {
        (&a.path, a.span, a.code, &a.message).cmp(&(&b.path, b.span, b.code, &b.message))
    });

    crate::convert::snapshot_note(&SnapshotNoteRow {
        path: note.source.path().clone(),
        revision: note.source.revision().as_str().to_string(),
        metadata: Some(SnapshotMetadata {
            properties: note.properties.clone(),
            aliases: note.aliases.clone(),
            headings: note.headings.clone(),
            blocks: note.blocks.clone(),
            tags: note.tags.clone(),
            diagnostics,
        }),
        references: Some(outgoing),
        // A hydration asks for neither: `resolutions` is the answers-only
        // projection of `references`, and `backlinks` is a whole-vault question
        // the host answers from its own mirror.
        resolutions: None,
        backlinks: None,
        sections: Some(note.sections.iter().map(SectionRow::from_parsed).collect()),
        list_items: Some(
            note.list_items
                .iter()
                .map(ListItemRow::from_parsed)
                .collect(),
        ),
    })
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("a protocol DTO serializes")
}

/// The binary's whole body, so `src/bin/fixture-row.rs` is one line.
///
/// The work lives in the library because `crate::convert` — the single source
/// of the domain-to-wire mapping — is `pub(crate)`, and a `src/bin/*.rs` file
/// is its own crate root. Widening that module to `pub` for a test-support
/// binary would put the whole conversion surface in the daemon's public API.
pub fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    run(stdin.lock(), stdout.lock())
}
