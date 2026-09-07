//! The equivalence claim, routed through the real protocol: after every
//! protocol mutation, what the daemon answers equals what a clean
//! `scan_vault` of the same vault would answer.
//!
//! `vault-index`'s `tests/live_oracle.rs` checks the same claim over a
//! randomized alphabet, in process. This suite is the other half, and the
//! division is deliberate: a spawned daemon per proptest case would make the
//! randomized sweep unusably slow, so the randomized half stays in process
//! and the protocol half is scripted. What only this half can catch is a
//! mutation whose `changed_paths` under-name what it moved — in process the
//! oracle supplies its own hints, while here the daemon's own outcome is what
//! drives reconciliation, so a folder rename that forgets its descendants
//! shows up as a daemon that answers from rows a fresh scan does not have.
//!
//! The daemon runs with no watcher and no periodic tick, so nothing but the
//! scripted mutations can move the index: a divergence here is the mutation
//! path's, never a background cycle's.

mod daemon;

use std::collections::BTreeSet;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, Resolution, Subpath, VaultPath, scan_vault};
use vault_protocol::{ResolutionDto, Response, ResponseEnvelope, ResponseOutcome, SubpathDto};

use daemon::Daemon;

/// Every note the daemon reports, with its revision and the resolution of each
/// of its outgoing references — the shape a fresh scan can be compared against
/// without re-deriving spans.
type State = Vec<(String, String, Vec<String>)>;

/// A daemon plus the request-id bookkeeping this suite needs. Ids are unique
/// per request so a stale line can never be mistaken for the answer in hand.
struct Client {
    daemon: Daemon,
    next_id: u64,
}

impl Client {
    fn new(vault: &TempDir, index: &TempDir) -> Self {
        Self {
            daemon: Daemon::for_vault(vault, index),
            next_id: 0,
        }
    }

    fn call(&mut self, method: &str, params: &str) -> ResponseEnvelope {
        self.next_id += 1;
        let id = format!("id-{}", self.next_id);
        let envelope = self.daemon.call(&format!(
            r#"{{"version":1,"id":"{id}","request":{{"method":"{method}","params":{params}}}}}"#
        ));
        assert_eq!(envelope.id, id, "answered the wrong request: {envelope:?}");
        envelope
    }
}

/// The two sides of every comparison speak different types — a wire DTO and
/// the core enum — describing the same answer. Both are rendered into this
/// one vocabulary rather than compared through `Debug`, whose spellings differ
/// where they wrap a `VaultPath` (`target: VaultPath("A.md")` against
/// `target: "A.md"`) and would report a false divergence on every ambiguous
/// or missing-subpath reference.
fn dto_resolution(resolution: &ResolutionDto) -> String {
    match resolution {
        ResolutionDto::Resolved { target, subpath } => {
            format!("resolved {target}{}", dto_subpath(subpath.as_ref()))
        }
        ResolutionDto::MissingSubpath { target, subpath } => {
            format!("missing-subpath {target}{}", dto_subpath(Some(subpath)))
        }
        ResolutionDto::Unresolved => "unresolved".to_string(),
        ResolutionDto::Ambiguous { candidates } => {
            format!("ambiguous {}", candidates.join("|"))
        }
        ResolutionDto::NonVault => "non-vault".to_string(),
    }
}

fn dto_subpath(subpath: Option<&SubpathDto>) -> String {
    match subpath {
        Some(SubpathDto::Heading(text)) => format!(" #heading {text}"),
        Some(SubpathDto::Block(id)) => format!(" #block {id}"),
        None => String::new(),
    }
}

fn core_resolution(resolution: &Resolution) -> String {
    match resolution {
        Resolution::Resolved { target, subpath } => {
            format!(
                "resolved {}{}",
                target.as_str(),
                core_subpath(subpath.as_ref())
            )
        }
        Resolution::MissingSubpath { target, subpath } => {
            format!(
                "missing-subpath {}{}",
                target.as_str(),
                core_subpath(Some(subpath))
            )
        }
        Resolution::Unresolved => "unresolved".to_string(),
        Resolution::Ambiguous { candidates } => {
            let candidates: Vec<&str> = candidates.iter().map(VaultPath::as_str).collect();
            format!("ambiguous {}", candidates.join("|"))
        }
        Resolution::NonVault => "non-vault".to_string(),
    }
}

fn core_subpath(subpath: Option<&Subpath>) -> String {
    match subpath {
        Some(Subpath::Heading(text)) => format!(" #heading {text}"),
        Some(Subpath::Block(id)) => format!(" #block {id}"),
        None => String::new(),
    }
}

/// What the daemon says the vault is, through the paging read API and
/// `get_note` — the same two calls any client would make.
fn daemon_state(client: &mut Client) -> State {
    let mut paths = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => format!(r#"{{"cursor":"{cursor}","limit":50}}"#),
            None => r#"{"limit":50}"#.to_string(),
        };
        let response = client.call("list_notes", &params);
        let page = match response.outcome {
            ResponseOutcome::Ok(Response::ListNotes(page)) => page,
            other => panic!("list_notes failed: {other:?}"),
        };
        paths.extend(page.items.into_iter().map(|item| item.path));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let mut state = State::new();
    for path in paths {
        let response = client.call("get_note", &format!(r#"{{"path":"{path}"}}"#));
        let note = match response.outcome {
            ResponseOutcome::Ok(Response::GetNote(response)) => response.note,
            other => panic!("get_note failed for {path}: {other:?}"),
        };
        let targets = note
            .outgoing
            .iter()
            .map(|reference| dto_resolution(&reference.resolution))
            .collect();
        state.push((note.path, note.revision, targets));
    }
    state.sort();
    state
}

/// The same shape from a clean scan of the same directory.
fn scanned_state(root: &std::path::Path) -> State {
    let source = FileSystemVaultSource::new(root).expect("scan source");
    let report = scan_vault(&source).expect("scan the vault");
    let mut state = State::new();
    for path in report.graph.note_paths() {
        let note = report.graph.note(path).expect("a scanned note");
        let targets = report
            .graph
            .outgoing(path)
            .iter()
            .map(|resolved| core_resolution(&resolved.resolution))
            .collect();
        state.push((
            path.as_str().to_string(),
            note.source.revision().as_str().to_string(),
            targets,
        ));
    }
    state.sort();
    state
}

#[test]
fn every_protocol_mutation_leaves_the_daemon_equivalent_to_a_fresh_scan() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    // Wikilinks rather than bare names, because a bare name is not a
    // reference: a bare-text fixture would compare empty outgoing lists on
    // both sides and pass for the wrong reason.
    std::fs::write(root.join("Seed.md"), "# Seed\n[[Alpha]]\n[[Nowhere]]\n").expect("write Seed");
    std::fs::write(root.join("Alpha.md"), "# Heading\n\ntext ^block\n").expect("write Alpha");

    let mut client = Client::new(&vault, &index);
    client.call("refresh_index", "{}");
    assert_eq!(
        daemon_state(&mut client),
        scanned_state(&root),
        "the cold build already diverged, so nothing below would mean anything"
    );

    // Every operation in the mutation surface, in an order that walks a note
    // through creation, reference, patching, folder moves, copying, and
    // deletion — each step followed by the same equivalence check.
    //
    // The `[[Zeta]]` thread is what moves the *reference* axis under the
    // daemon's own writes rather than only the note axis: the reference is
    // written while unresolved, resolves when its note is created, turns
    // ambiguous when the copy gives the stem a second nested spelling, and
    // resolves again when one of them is deleted. Ambiguity needs two nested
    // spellings and no root one, because an exact vault path wins outright —
    // a root `Zeta.md` would keep `[[Zeta]]` unambiguous however many nested
    // namesakes existed.
    let steps: Vec<(&str, String)> = vec![
        (
            "write_note",
            r##"{"path":"Beta.md","content":"# Beta\n[[Alpha#Heading]]\n[[Alpha#Missing]]\n","expected":{"absent":true}}"##.to_string(),
        ),
        ("create_folder", r#"{"path":"Nested"}"#.to_string()),
        (
            "write_note",
            r##"{"path":"Nested/Gamma.md","content":"# Gamma\n[[Beta]]\n[[Alpha#^block]]\n[[Zeta]]\n","expected":{"absent":true}}"##.to_string(),
        ),
        (
            "patch_frontmatter",
            r#"{"path":"Beta.md","patch":[{"key_path":"title","value":"Titled"}],"expected":{"any":true}}"#.to_string(),
        ),
        (
            "write_note",
            r##"{"path":"Nested/Zeta.md","content":"# Zeta\n","expected":{"absent":true}}"##.to_string(),
        ),
        ("create_folder", r#"{"path":"Other"}"#.to_string()),
        (
            "copy_file",
            r#"{"from":"Nested/Zeta.md","to":"Other/Zeta.md","expected_source":{"any":true},"if_exists":"error"}"#.to_string(),
        ),
        (
            "rename_note",
            r#"{"from":"Nested/Gamma.md","to":"Nested/Delta.md","expected":{"any":true},"rewrite_links":true}"#.to_string(),
        ),
        (
            "delete_note",
            r#"{"path":"Other/Zeta.md","mode":"permanent","expected":{"any":true}}"#.to_string(),
        ),
        (
            "rename_folder",
            r#"{"from":"Nested","to":"Moved","rewrite_links":true}"#.to_string(),
        ),
        (
            "delete_folder",
            r#"{"path":"Moved","mode":"permanent","recursive":true}"#.to_string(),
        ),
    ];

    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (method, params) in steps {
        let response = client.call(method, &params);
        assert!(
            matches!(response.outcome, ResponseOutcome::Ok(_)),
            "{method} {params} failed: {:?}",
            response.outcome
        );
        let answered = daemon_state(&mut client);
        seen.extend(
            answered
                .iter()
                .flat_map(|(_, _, targets)| targets.iter().cloned()),
        );
        assert_eq!(
            answered,
            scanned_state(&root),
            "the daemon diverged from a fresh scan after {method} {params}"
        );
    }

    // The scenario's own reachability claim. Comparing two answers that are
    // both trivial would pass forever, so the walk has to have produced every
    // resolution shape it was written to produce.
    for wanted in [
        "resolved Alpha.md",
        "resolved Alpha.md #heading Heading",
        "resolved Alpha.md #block block",
        "missing-subpath Alpha.md #heading Missing",
        "unresolved",
        "ambiguous Nested/Zeta.md|Other/Zeta.md",
    ] {
        assert!(
            seen.contains(wanted),
            "the scenario never produced {wanted:?}, so it is checking a smaller world \
             than it claims to: {seen:?}"
        );
    }
}
