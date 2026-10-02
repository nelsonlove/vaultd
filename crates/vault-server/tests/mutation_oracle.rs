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
//!
//! Three axes are checked after every step, because the note axis alone
//! leaves the folder verbs proving almost nothing — four of the steps exist
//! mainly to move tree rows, and `list_notes` cannot see one:
//!
//! 1. **Note equivalence** — `list_notes` + `get_note` equal a fresh
//!    `scan_vault`, reference resolutions included.
//! 2. **Generation exactness** — the published generation advances exactly
//!    once when a fresh *walk* or a fresh scan moved, and exactly zero times
//!    when neither did. This is the axis a folder verb lives on: a
//!    `create_folder` whose outcome names nothing puts a folder on disk that
//!    no generation ever carries, and nothing in axis 1 can see it.
//! 3. **Tree honesty**, in two halves:
//!    - The tree the daemon *serves* equals a fresh walk. Every step pages a
//!      whole `snapshot_tree` out of a session it opens and closes, and
//!      compares it to `FileSystemVaultSource::scan()` row for row (path,
//!      kind, size — the walk vocabulary `vault-index`'s
//!      `tests/live_oracle.rs` already uses).
//!    - Every path the walk says moved appears in the generation's own
//!      published change set. Over-naming is free (the engine documents
//!      conservative invalidation as the safe direction); under-naming is the
//!      bug, so the relation asserted is superset, not equality.
//!
//! Until Task 14 the first half did not exist: `generation_committed` events
//! were the only surface on which this daemon said anything about non-note
//! paths, so the tree could only be *inferred* from a change set. The
//! `snapshot_tree` arm makes it directly observable, and both halves are kept
//! because they fail differently — the row comparison catches a tree the
//! daemon serves wrongly, the change-set half catches a tree it serves
//! correctly but never announced.

mod daemon;

use std::collections::{BTreeMap, BTreeSet};

use tempfile::TempDir;
use vault_core::{
    FileSystemVaultSource, Resolution, Subpath, TreeEntryKind, VaultPath, scan_vault,
};
use vault_protocol::{
    ChangeSetDto, ResolutionDto, Response, ResponseEnvelope, ResponseOutcome, RuntimeEventDto,
    SubpathDto,
};

use daemon::Daemon;

/// Every note the daemon reports, with its revision and the resolution of each
/// of its outgoing references — the shape a fresh scan can be compared against
/// without re-deriving spans.
type State = Vec<(String, String, Vec<String>)>;

/// The file tree as the pre-task's walk reports it: path, kind, and size.
///
/// Timestamps are deliberately absent, exactly as in `vault-index`'s
/// `tests/live_oracle.rs`: a folder's timestamps move whenever anything
/// inside it is created or removed, nothing reads them, and letting them
/// count as "changed" would make every step look generational.
type Tree = BTreeMap<String, (TreeEntryKind, Option<u64>)>;

/// What a fresh walk says the tree is.
fn scanned_tree(root: &std::path::Path) -> Tree {
    let source = FileSystemVaultSource::new(root).expect("tree scan source");
    source
        .scan()
        .expect("scan vault tree")
        .entries
        .into_iter()
        .map(|entry| (entry.path.as_str().to_string(), (entry.kind, entry.size)))
        .collect()
}

/// Every path whose walk row appeared, vanished, or changed between two
/// walks — the ground truth a generation's published change set must cover.
fn tree_changes(before: &Tree, after: &Tree) -> BTreeSet<String> {
    let mut changed = BTreeSet::new();
    for (path, row) in after {
        if before.get(path) != Some(row) {
            changed.insert(path.clone());
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            changed.insert(path.clone());
        }
    }
    changed
}

/// Notes whose revision appeared, vanished, or moved between two scans.
///
/// The tree walk catches most of this already — a rewritten note almost
/// always changes size — but not all of it: a same-length rewrite moves a
/// revision while leaving the walk row identical, and that path still has to
/// reach a client. Resolution-only changes are deliberately **not** included:
/// a note whose answers moved because some *other* note moved is a different
/// claim, and axis 1 already pins it.
fn revision_changes(before: &State, after: &State) -> BTreeSet<String> {
    let revisions = |state: &State| -> BTreeMap<String, String> {
        state
            .iter()
            .map(|(path, revision, _)| (path.clone(), revision.clone()))
            .collect()
    };
    let (before, after) = (revisions(before), revisions(after));
    let mut changed = BTreeSet::new();
    for (path, revision) in &after {
        if before.get(path) != Some(revision) {
            changed.insert(path.clone());
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            changed.insert(path.clone());
        }
    }
    changed
}

/// Whether a step is expected to land today.
#[derive(Clone, Copy, Debug)]
enum Expect {
    Lands,
    /// Lands **and** repairs exactly this many inbound links. The rename steps
    /// carry this: `rewrite_links` is honoured by the coordinator, so a rename
    /// that answered `links_rewritten: 0` would be claiming nothing pointed at
    /// what it moved — which the fixture below makes false on purpose. The
    /// three axes then check that the referrers the burst rewrote reached a
    /// generation, which is the half a bare `Lands` cannot see.
    ///
    /// The count is exact rather than a floor: the fixture pins which
    /// references each step has to repair, so a change that starts repairing
    /// three where one was meant is a change worth failing on.
    LandsRepairing(u64),
}

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

    /// Subscribe, so the tree axis has a surface to read. Returns nothing:
    /// the events are matched by generation, not by subscription id, and one
    /// subscription is all this walk opens.
    fn subscribe(&mut self) {
        let response = self.call("subscribe_events", "{}");
        assert!(
            matches!(
                response.outcome,
                ResponseOutcome::Ok(Response::SubscribeEvents(_))
            ),
            "subscribe_events failed: {:?}",
            response.outcome
        );
    }

    /// The generation the daemon currently serves.
    ///
    /// `get_vault_info` is a unit variant on the wire — it takes no `params`
    /// key at all, and sending an empty object is an `invalid_request`.
    fn generation(&mut self) -> u64 {
        self.next_id += 1;
        let id = format!("id-{}", self.next_id);
        let response = self.daemon.call(&format!(
            r#"{{"version":1,"id":"{id}","request":{{"method":"get_vault_info"}}}}"#
        ));
        assert_eq!(response.id, id, "answered the wrong request: {response:?}");
        match response.outcome {
            ResponseOutcome::Ok(Response::GetVaultInfo(info)) => info.generation,
            other => panic!("get_vault_info failed: {other:?}"),
        }
    }

    /// The file tree as the daemon serves it: a snapshot opened, paged to
    /// completion, and closed.
    ///
    /// A small page limit on purpose — the fixture never holds many entries,
    /// and paging is only exercised if more than one page is needed. The
    /// session is closed rather than left to the idle timeout, so the number
    /// of live sessions this walk holds stays at the one the scripted
    /// `open_snapshot` step deliberately abandons.
    fn snapshot_tree(&mut self) -> Tree {
        let opened = self.call("open_snapshot", "{}");
        let snapshot_id = match opened.outcome {
            ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
            other => panic!("open_snapshot failed: {other:?}"),
        };

        let mut tree = Tree::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(cursor) => {
                    format!(r#"{{"snapshot_id":"{snapshot_id}","cursor":"{cursor}","limit":3}}"#)
                }
                None => format!(r#"{{"snapshot_id":"{snapshot_id}","limit":3}}"#),
            };
            let page = match self.call("snapshot_tree", &params).outcome {
                ResponseOutcome::Ok(Response::SnapshotTree(page)) => page,
                other => panic!("snapshot_tree failed: {other:?}"),
            };
            for entry in page.entries {
                let previous = tree.insert(entry.path.clone(), (dto_kind(entry.kind), entry.size));
                assert!(
                    previous.is_none(),
                    "{} was served twice, so the keyset paging repeats rows",
                    entry.path
                );
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        let closed = self.call(
            "close_snapshot",
            &format!(r#"{{"snapshot_id":"{snapshot_id}"}}"#),
        );
        assert!(
            matches!(closed.outcome, ResponseOutcome::Ok(_)),
            "close_snapshot failed: {:?}",
            closed.outcome
        );
        tree
    }

    /// Every path the daemon published for `generation`, from its own
    /// `generation_committed` event.
    ///
    /// The cause is asserted here rather than at the call site because it is
    /// a property of the same event: a mutation this daemon applied must be
    /// attributed to `mutation`, never to the watcher — which is off.
    fn published_paths(&mut self, generation: u64) -> BTreeSet<String> {
        let event = self.daemon.wait_for_event(|event| match &event.event {
            RuntimeEventDto::GenerationCommitted(committed) => committed.generation == generation,
            _ => false,
        });
        let committed = match event.event {
            RuntimeEventDto::GenerationCommitted(committed) => committed,
            other => panic!("matched a non-generation event: {other:?}"),
        };
        assert_eq!(
            committed.cause,
            vault_protocol::GenerationCauseDto::Mutation,
            "a generation this walk caused must be attributed to the mutation path"
        );
        match committed.changes {
            ChangeSetDto::Detailed {
                created,
                modified,
                deleted,
            } => created.into_iter().chain(modified).chain(deleted).collect(),
            // Every step here moves a handful of paths; a counts-only change
            // set would mean the detail limit moved, and this axis would be
            // silently unable to check anything.
            ChangeSetDto::CountsOnly { .. } => {
                panic!("the change set for generation {generation} lost its per-path detail")
            }
        }
    }
}

/// The wire kind in the walk's own vocabulary. `Unknown` is unreachable from
/// this server — it exists so an older client survives a kind a later server
/// adds — and a panic is the honest answer if it ever arrives, because the
/// comparison below would otherwise have to invent a kind to compare against.
fn dto_kind(kind: vault_protocol::TreeEntryKindDto) -> TreeEntryKind {
    match kind {
        vault_protocol::TreeEntryKindDto::Folder => TreeEntryKind::Folder,
        vault_protocol::TreeEntryKindDto::Note => TreeEntryKind::Note,
        vault_protocol::TreeEntryKindDto::File => TreeEntryKind::File,
        vault_protocol::TreeEntryKindDto::Unknown => {
            panic!("this server produces only the three kinds the index's CHECK admits")
        }
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
        Some(SubpathDto::View(name)) => format!(" #view {name}"),
        Some(SubpathDto::Unknown) => " #unknown".to_string(),
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
        Some(Subpath::View(name)) => format!(" #view {name}"),
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
    // The external link and the missing block subpath are here so the
    // comparison vocabulary is fully exercised rather than merely defined:
    // without them `non-vault` and a block-flavoured `missing-subpath` are
    // arms no step ever produces.
    std::fs::write(
        root.join("Seed.md"),
        "# Seed\n[[Alpha]]\n[[Nowhere]]\n[[Alpha#^missing]]\n[site](https://example.com)\n",
    )
    .expect("write Seed");
    std::fs::write(root.join("Alpha.md"), "# Heading\n\ntext ^block\n").expect("write Alpha");

    let mut client = Client::new(&vault, &index);
    client.call("refresh_index", "{}");
    client.subscribe();
    assert_eq!(
        daemon_state(&mut client),
        scanned_state(&root),
        "the cold build already diverged, so nothing below would mean anything"
    );
    let mut generation = client.generation();
    let mut tree = scanned_tree(&root);
    let mut state = scanned_state(&root);

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
    let steps: Vec<(&str, String, Expect)> = vec![
        // `[[Nested/Gamma]]` is written before its note exists and in **path
        // form** on purpose: it is what gives the two rename steps below
        // something to repair, and a path form is the shape a rename really
        // breaks — a bare stem would keep resolving wherever the note landed.
        (
            "write_note",
            r##"{"path":"Beta.md","content":"# Beta\n[[Alpha#Heading]]\n[[Alpha#Missing]]\n[[Nested/Gamma]]\n","expected":{"absent":true}}"##.to_string(),
            Expect::Lands,
        ),
        ("create_folder", r#"{"path":"Nested"}"#.to_string(), Expect::Lands),
        // The ninth mutation verb, and the one whose only visible effect is a
        // non-note tree row — which is exactly why it belongs in a walk that
        // checks the tree.
        //
        // The Task 16 tripwire step, flipped: `write_file` is wired, so the
        // three axes now check the attachment's tree row for free — and the
        // note axis stays unmoved on this step, because an attachment is not
        // a note however much of a generation it earns.
        (
            "write_file",
            r#"{"path":"Nested/note.txt","content_base64":"aGVsbG8=","expected":{"absent":true}}"#.to_string(),
            Expect::Lands,
        ),
        (
            "write_note",
            r##"{"path":"Nested/Gamma.md","content":"# Gamma\n[[Beta]]\n[[Alpha#^block]]\n[[Zeta]]\n","expected":{"absent":true}}"##.to_string(),
            Expect::Lands,
        ),
        // The Task 14 tripwire step, flipped: `open_snapshot` now reaches the
        // registry and lands. It is deliberately never closed, so the rest of
        // the walk runs with a session pinned at this generation — which is
        // the claim worth having here: a pinned reader must not stop the
        // writer, and every step below still publishes with it open.
        ("open_snapshot", r#"{}"#.to_string(), Expect::Lands),
        (
            "patch_frontmatter",
            r#"{"path":"Beta.md","patch":[{"key_path":"title","value":"Titled"}],"expected":{"any":true}}"#.to_string(),
            Expect::Lands,
        ),
        (
            "write_note",
            r##"{"path":"Nested/Zeta.md","content":"# Zeta\n","expected":{"absent":true}}"##.to_string(),
            Expect::Lands,
        ),
        ("create_folder", r#"{"path":"Other"}"#.to_string(), Expect::Lands),
        (
            "copy_file",
            r#"{"from":"Nested/Zeta.md","to":"Other/Zeta.md","expected_source":{"any":true},"if_exists":"error"}"#.to_string(),
            Expect::Lands,
        ),
        // The Task 12 tripwire step, flipped. `rewrite_links` is honoured by
        // the coordinator, so this step now also moves `Beta.md` — the
        // referrer whose `[[Nested/Gamma]]` has to become `[[Nested/Delta]]`
        // — and axis 3 checks that the repair burst named it.
        (
            "rename_note",
            r#"{"from":"Nested/Gamma.md","to":"Nested/Delta.md","expected":{"any":true},"rewrite_links":true}"#.to_string(),
            Expect::LandsRepairing(1),
        ),
        (
            "delete_note",
            r#"{"path":"Other/Zeta.md","mode":"permanent","expected":{"any":true}}"#.to_string(),
            Expect::Lands,
        ),
        // The folder half of that tripwire step, flipped. Same reasoning one
        // level up: the moved folder's referencing notes join the change set
        // this step checks, and `[[Nested/Delta]]` in `Beta.md` — a path form,
        // so the move genuinely breaks it — becomes `[[Moved/Delta]]`.
        (
            "rename_folder",
            r#"{"from":"Nested","to":"Moved","rewrite_links":true}"#.to_string(),
            Expect::LandsRepairing(1),
        ),
        (
            "delete_folder",
            r#"{"path":"Moved","mode":"permanent","recursive":true}"#.to_string(),
            Expect::Lands,
        ),
    ];

    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (method, params, expect) in steps {
        let response = client.call(method, &params);
        match expect {
            Expect::Lands => assert!(
                matches!(response.outcome, ResponseOutcome::Ok(_)),
                "{method} {params} failed: {:?}",
                response.outcome
            ),
            Expect::LandsRepairing(expected) => {
                let (rewritten, failures) = match &response.outcome {
                    ResponseOutcome::Ok(Response::RenameNote(rename)) => {
                        (rename.links_rewritten, &rename.link_rewrite_failures)
                    }
                    ResponseOutcome::Ok(Response::RenameFolder(rename)) => {
                        (rename.links_rewritten, &rename.link_rewrite_failures)
                    }
                    other => panic!("{method} {params} failed: {other:?}"),
                };
                assert_eq!(
                    rewritten, expected,
                    "{method} {params} repaired {rewritten} links, not the {expected} the \
                     fixture pins"
                );
                assert!(
                    failures.is_empty(),
                    "{method} {params} skipped a referrer it should have rewritten: {failures:?}"
                );
            }
        }

        // Axis 1: the note answers equal a fresh scan.
        let answered = daemon_state(&mut client);
        seen.extend(
            answered
                .iter()
                .flat_map(|(_, _, targets)| targets.iter().cloned()),
        );
        let scanned = scanned_state(&root);
        assert_eq!(
            answered, scanned,
            "the daemon diverged from a fresh scan after {method} {params}"
        );

        // Axes 2 and 3, against the walk this step actually produced.
        let walked = scanned_tree(&root);

        // Axis 3, first half: the tree the daemon *serves* is the tree on
        // disk. Read before the generation is asked for, so a snapshot that
        // somehow moved the index would show up here rather than as a
        // surprise generation.
        assert_eq!(
            client.snapshot_tree(),
            walked,
            "the tree the daemon pages out diverged from a fresh walk after {method} {params}"
        );

        let mut moved = tree_changes(&tree, &walked);
        moved.extend(revision_changes(&state, &scanned));
        let changed = !moved.is_empty();
        let published = client.generation();
        assert_eq!(
            published,
            generation + u64::from(changed),
            "the generation must advance exactly once iff the vault moved \
             (moved = {moved:?}) after {method} {params}"
        );
        // Axis 3, second half: what moved was also announced.
        if changed {
            let announced = client.published_paths(published);
            let unannounced: Vec<&String> = moved
                .iter()
                .filter(|path| !announced.contains(*path))
                .collect();
            assert!(
                unannounced.is_empty(),
                "generation {published} never named {unannounced:?}, which the walk says \
                 moved, after {method} {params}; it named {announced:?}"
            );
        }
        generation = published;
        tree = walked;
        state = scanned;
    }

    // The scenario's own reachability claim. Comparing two answers that are
    // both trivial would pass forever, so the walk has to have produced every
    // resolution shape it was written to produce.
    for wanted in [
        "resolved Alpha.md",
        "resolved Alpha.md #heading Heading",
        "resolved Alpha.md #block block",
        "missing-subpath Alpha.md #heading Missing",
        "missing-subpath Alpha.md #block missing",
        "unresolved",
        "non-vault",
        "ambiguous Nested/Zeta.md|Other/Zeta.md",
    ] {
        assert!(
            seen.contains(wanted),
            "the scenario never produced {wanted:?}, so it is checking a smaller world \
             than it claims to: {seen:?}"
        );
    }
}
