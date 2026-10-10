//! Freshness over the wire: the per-generation result cache, its knob, and
//! the `views_invalidated` events the staleness rule emits. Each of the six
//! clauses has a test that fires it and a sibling that shows it stays quiet
//! when its condition is absent.

mod daemon;

use std::collections::BTreeSet;
use std::process::{Command, Stdio};

use tempfile::TempDir;
use vault_protocol::{EventEnvelope, Response, ResponseOutcome, RuntimeEventDto};

use daemon::Daemon;

/// The in-repo scratch root (`target/tmp`), from this crate's manifest
/// directory rather than `TMPDIR` — the socket harness's `tmp_root` rule.
fn scratch() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

const BASE: &str = "views:\n  - type: table\n    name: InBooks\n    filters: 'file.inFolder(\"Books\")'\n    order: [price]\n    sort:\n      - property: price\n        direction: ASC\n  - type: table\n    name: Tagged\n    filters: 'file.hasTag(\"t\")'\n";

fn setup() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    std::fs::create_dir_all(vault.path().join("Books")).unwrap();
    std::fs::create_dir_all(vault.path().join("Other")).unwrap();
    std::fs::write(vault.path().join("Books/A.md"), "---\nprice: 1\n---\n").unwrap();
    std::fs::write(vault.path().join("Books/B.md"), "---\nprice: 2\n---\n").unwrap();
    std::fs::write(vault.path().join("Other/T.md"), "#t\n").unwrap();
    std::fs::write(vault.path().join("V.base"), BASE).unwrap();
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.call(r#"{"version":1,"id":"s","request":{"method":"subscribe_events","params":{}}}"#);
    for view in ["InBooks", "Tagged"] {
        daemon.call(&format!(
            r#"{{"version":1,"id":"e","request":{{"method":"evaluate_base","params":{{"path":"V.base","view":"{view}"}}}}}}"#
        ));
    }
    (vault, index, daemon)
}

fn generation_of(daemon: &mut Daemon, line: &str) -> u64 {
    match daemon.call(line).outcome {
        ResponseOutcome::Ok(response) => {
            let value = serde_json::to_value(&response).unwrap();
            value["value"]["generation"]
                .as_u64()
                .unwrap_or_else(|| panic!("a generation in {value}"))
        }
        ResponseOutcome::Err(error) => panic!("{line}: {error:?}"),
    }
}

/// Every view invalidated at `generation`, read after that generation's own
/// commit event (the invalidations are enqueued right behind it). Panics if
/// one view is named twice for the generation.
fn invalidated_at(daemon: &mut Daemon, generation: u64) -> BTreeSet<String> {
    daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::GenerationCommitted(c) if c.generation == generation)
    });
    let named: Vec<String> = daemon
        .drain_events()
        .iter()
        .filter_map(|raw| {
            let event: EventEnvelope = serde_json::from_str(raw).unwrap();
            match event.event {
                RuntimeEventDto::ViewsInvalidated(v) if v.generation == generation => {
                    Some(format!("{}#{}", v.base, v.view))
                }
                _ => None,
            }
        })
        .collect();
    let unique: BTreeSet<String> = named.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        named.len(),
        "one event per view per generation: {named:?}"
    );
    unique
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn base64_of(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn write_base(daemon: &mut Daemon, path: &str, text: &str) -> u64 {
    generation_of(
        daemon,
        &format!(
            r#"{{"version":1,"id":"b","request":{{"method":"write_file","params":{{"path":"{path}","content_base64":"{}","expected":{{"any":true}}}}}}}}"#,
            base64_of(text)
        ),
    )
}

fn write_note(daemon: &mut Daemon, path: &str, content: &str) -> u64 {
    generation_of(
        daemon,
        &format!(
            r#"{{"version":1,"id":"w","request":{{"method":"write_note","params":{{"path":"{path}","content":{},"expected":{{"any":true}}}}}}}}"#,
            serde_json::to_string(content).unwrap()
        ),
    )
}

fn evaluate(daemon: &mut Daemon, path: &str) {
    match daemon
        .call(&format!(
            r#"{{"version":1,"id":"e","request":{{"method":"evaluate_base","params":{{"path":"{path}"}}}}}}"#
        ))
        .outcome
    {
        ResponseOutcome::Ok(_) => {}
        ResponseOutcome::Err(error) => panic!("evaluate {path}: {error:?}"),
    }
}

/// Clauses 2 and 3: entering (3), reordering (2 and 3), leaving (2), and a
/// recorded row changing (2).
#[test]
fn entering_reordering_and_leaving_a_view_invalidates_exactly_that_view() {
    let (_vault, _index, mut daemon) = setup();

    let entered = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Books/C.md","content":"---\nprice: 3\n---\n","expected":{"absent":true}}}}"#,
    );
    assert_eq!(
        invalidated_at(&mut daemon, entered),
        set(&["V.base#InBooks"]),
        "a note entering InBooks"
    );

    let reordered = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"p","request":{"method":"patch_frontmatter","params":{"path":"Books/A.md","patch":[{"key_path":"price","value":9}],"expected":{"any":true}}}}"#,
    );
    assert_eq!(
        invalidated_at(&mut daemon, reordered),
        set(&["V.base#InBooks"]),
        "a row reordering inside InBooks"
    );

    let left = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"m","request":{"method":"rename_note","params":{"from":"Books/A.md","to":"Other/A.md","expected":{"any":true},"rewrite_links":true}}}"#,
    );
    assert_eq!(
        invalidated_at(&mut daemon, left),
        set(&["V.base#InBooks"]),
        "a row leaving InBooks"
    );

    let tagged = generation_of(
        &mut daemon,
        r##"{"version":1,"id":"t","request":{"method":"write_note","params":{"path":"Other/T.md","content":"#t and more\n","expected":{"any":true}}}}"##,
    );
    assert_eq!(
        invalidated_at(&mut daemon, tagged),
        set(&["V.base#Tagged"]),
        "a tagged note changing"
    );
}

/// The sibling of every clause at once: neither fixture view reads formulas,
/// links, backlinks or `this`, `Other/U.md` passes neither view's prefilters
/// and was never a row, and nothing links to `U`, so no reference
/// re-resolves.
#[test]
fn a_change_unrelated_to_any_view_fires_nothing() {
    let (_vault, _index, mut daemon) = setup();
    let unrelated = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"plain\n","expected":{"absent":true}}}}"#,
    );
    assert_eq!(invalidated_at(&mut daemon, unrelated), BTreeSet::new());
}

/// Clause 2's sibling: a note that was never a row is deleted, and the views
/// stay quiet (it passes no prefilter, and no view reads notes).
#[test]
fn deleting_a_note_that_was_never_a_row_fires_nothing() {
    let (_vault, _index, mut daemon) = setup();
    let created = write_note(&mut daemon, "Other/U.md", "plain\n");
    let _ = invalidated_at(&mut daemon, created);
    let deleted = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"Other/U.md","mode":"permanent","expected":{"any":true}}}}"#,
    );
    assert_eq!(invalidated_at(&mut daemon, deleted), BTreeSet::new());
}

/// Clause 2 through a deleted folder: the folder alone is named, and every
/// row under it counts.
#[test]
fn deleting_the_folder_that_holds_a_views_rows_invalidates_it() {
    let (_vault, _index, mut daemon) = setup();
    let deleted = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"d","request":{"method":"delete_folder","params":{"path":"Books","mode":"permanent","recursive":true}}}"#,
    );
    assert_eq!(
        invalidated_at(&mut daemon, deleted),
        set(&["V.base#InBooks"])
    );
}

/// Clause 1.
#[test]
fn a_change_to_the_base_invalidates_every_view_it_declares() {
    let (_vault, _index, mut daemon) = setup();
    let changed = write_base(
        &mut daemon,
        "V.base",
        &format!("{BASE}  - type: list\n    name: Third\n"),
    );
    assert_eq!(
        invalidated_at(&mut daemon, changed),
        set(&["V.base#InBooks", "V.base#Tagged", "V.base#Third"])
    );
}

/// Clause 1 for a base that vanishes: its views' names come from the
/// catalog as it was.
#[test]
fn deleting_a_base_invalidates_every_view_it_had() {
    let (_vault, _index, mut daemon) = setup();
    let deleted = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"V.base","mode":"permanent","expected":{"any":true}}}}"#,
    );
    assert_eq!(
        invalidated_at(&mut daemon, deleted),
        set(&["V.base#InBooks", "V.base#Tagged"])
    );
}

/// Clause 3 for a view with no prefilter (the Task 7 review's carry): every
/// path that exists passes, so any change stales it, even one it never
/// answered (the view was never evaluated, so clause 2 cannot fire, and it
/// reads no notes, so clauses 4 and 5 cannot either).
#[test]
fn a_view_with_no_prefilter_is_stale_when_any_path_changes() {
    let (_vault, _index, mut daemon) = setup();
    let created = write_base(
        &mut daemon,
        "All.base",
        "views:\n  - type: table\n    name: Everything\n    filters: 'file.size >= 0'\n",
    );
    let _ = invalidated_at(&mut daemon, created);
    let unrelated = write_note(&mut daemon, "Other/U.md", "plain\n");
    assert_eq!(
        invalidated_at(&mut daemon, unrelated),
        set(&["All.base#Everything"])
    );
}

/// Clause 4: a view that reads formulas is stale when any note changes; its
/// sibling, a change that touches no note (an attachment outside every
/// prefilter), leaves it quiet.
#[test]
fn clause_four_a_view_reading_formulas_is_stale_when_any_note_changes() {
    let (_vault, _index, mut daemon) = setup();
    let created = write_base(
        &mut daemon,
        "F.base",
        "formulas:\n  double: 'price * 2'\nviews:\n  - type: table\n    name: Doubled\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.double]\n",
    );
    let _ = invalidated_at(&mut daemon, created);
    evaluate(&mut daemon, "F.base");

    let attachment = generation_of(
        &mut daemon,
        &format!(
            r#"{{"version":1,"id":"a","request":{{"method":"write_file","params":{{"path":"Other/x.png","content_base64":"{}","expected":{{"any":true}}}}}}}}"#,
            base64_of("png")
        ),
    );
    assert_eq!(
        invalidated_at(&mut daemon, attachment),
        BTreeSet::new(),
        "no note changed"
    );

    let note = write_note(&mut daemon, "Other/U.md", "plain\n");
    assert_eq!(
        invalidated_at(&mut daemon, note),
        set(&["F.base#Doubled"]),
        "a note outside the prefilter, never a row: only clause 4 names it"
    );
}

/// Clause 5.
#[test]
fn clause_five_a_view_reading_this_is_stale_when_any_note_changes() {
    let (_vault, _index, mut daemon) = setup();
    write_base(
        &mut daemon,
        "This.base",
        "views:\n  - type: table\n    name: ThisView\n    filters:\n      and:\n        - file.inFolder(\"Books\")\n        - 'file.name != this.file.name'\n",
    );
    daemon.call(
        r#"{"version":1,"id":"e","request":{"method":"evaluate_base","params":{"path":"This.base"}}}"#,
    );
    let formulas = write_base(
        &mut daemon,
        "F.base",
        "formulas:\n  double: 'price * 2'\nviews:\n  - type: table\n    name: Doubled\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.double]\n",
    );
    let _ = invalidated_at(&mut daemon, formulas);
    evaluate(&mut daemon, "F.base");
    let unrelated = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"plain\n","expected":{"absent":true}}}}"#,
    );
    // Other/U.md is outside the prefilters and was never a row: only clause
    // 5 can name ThisView (and clause 4 Doubled), and V.base's two views stay
    // quiet.
    assert_eq!(
        invalidated_at(&mut daemon, unrelated),
        set(&["This.base#ThisView", "F.base#Doubled"])
    );

    let attachment = generation_of(
        &mut daemon,
        &format!(
            r#"{{"version":1,"id":"a","request":{{"method":"write_file","params":{{"path":"Other/x.png","content_base64":"{}","expected":{{"any":true}}}}}}}}"#,
            base64_of("png")
        ),
    );
    // `this.file.links[…].asFile()` reaches attachments, so a view reading
    // `this` is named for any changed file (the M1 ruling); the sibling is a
    // view reading formulas without links, which an attachment cannot move.
    assert_eq!(
        invalidated_at(&mut daemon, attachment),
        set(&["This.base#ThisView"]),
        "a view reading `this` is named for an attachment; one reading formulas without links is not"
    );
}

/// Clause 6.
#[test]
fn clause_six_a_row_whose_link_target_appears_is_stale() {
    let (vault, _index, mut daemon) = setup();
    std::fs::create_dir_all(vault.path().join("Refs")).unwrap();
    std::fs::write(
        vault.path().join("Refs/R.md"),
        "---\nref: \"[[Target]]\"\n---\n",
    )
    .unwrap();
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    write_base(
        &mut daemon,
        "Refs.base",
        "views:\n  - type: table\n    name: Refs\n    filters: 'file.inFolder(\"Refs\")'\n",
    );
    daemon.call(
        r#"{"version":1,"id":"e","request":{"method":"evaluate_base","params":{"path":"Refs.base"}}}"#,
    );
    let appeared = generation_of(
        &mut daemon,
        r##"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Target.md","content":"# Target\n","expected":{"absent":true}}}}"##,
    );
    // Target.md is outside every prefilter and no row changed its bytes; the
    // only path to Refs is R.md's reference re-resolving.
    assert_eq!(
        invalidated_at(&mut daemon, appeared),
        set(&["Refs.base#Refs"])
    );

    let edited = write_note(&mut daemon, "Target.md", "# Target\n\nmore\n");
    assert_eq!(
        invalidated_at(&mut daemon, edited),
        BTreeSet::new(),
        "the sibling: a body edit of the target moves no resolution"
    );
}

#[test]
fn the_cache_hits_at_one_generation_and_misses_at_the_next() {
    // `random()` is seeded from the instant an answer is computed at and
    // fixed with it, so a repeat is the cached answer exactly when it is
    // equal. (`now()` no longer tells: a view reading it is never cached.)
    let (vault, _index, mut daemon) = setup();
    std::fs::write(
        vault.path().join("Now.base"),
        "formulas:\n  at: 'random()'\nviews:\n  - type: table\n    name: T\n    filters: 'file.path == \"Books/B.md\"'\n    order: [formula.at]\n",
    )
    .unwrap();
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let read = |daemon: &mut Daemon| -> (u64, String) {
        match daemon
            .call(r#"{"version":1,"id":"n","request":{"method":"evaluate_base","params":{"path":"Now.base"}}}"#)
            .outcome
        {
            ResponseOutcome::Ok(Response::EvaluateBase(answer)) => (
                answer.generation,
                serde_json::to_string(&answer.rows[0].cells[0]).unwrap(),
            ),
            other => panic!("{other:?}"),
        }
    };
    let first = read(&mut daemon);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let second = read(&mut daemon);
    assert_eq!(
        first, second,
        "a second read at one generation is the cached answer"
    );
    daemon.call(
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"x\n","expected":{"absent":true}}}}"#,
    );
    let third = read(&mut daemon);
    assert_eq!(third.0, first.0 + 1);
    assert_ne!(
        third.1, first.1,
        "a new generation recomputes, so random() was seeded again"
    );
}

#[test]
fn a_base_created_while_nobody_listened_is_tracked_once_someone_does() {
    let (vault, _index, mut daemon) = setup();
    daemon.call(
        r#"{"version":1,"id":"u","request":{"method":"unsubscribe","params":{"subscription_id":"sub-1"}}}"#,
    );
    std::fs::create_dir_all(vault.path().join("New")).unwrap();
    write_base(
        &mut daemon,
        "N.base",
        "views:\n  - type: table\n    name: V\n    filters: 'file.inFolder(\"New\")'\n",
    );
    daemon.drain_events();
    daemon.call(r#"{"version":1,"id":"s2","request":{"method":"subscribe_events","params":{}}}"#);
    let entered = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"New/X.md","content":"x\n","expected":{"absent":true}}}}"#,
    );
    assert!(
        invalidated_at(&mut daemon, entered).contains("N.base#V"),
        "the base born unobserved is in the catalog"
    );
}

/// A `resync_required` carries no change set, so no `views_invalidated`
/// accompanies it: neither a client refresh's resync nor an oversized
/// generation's.
#[test]
fn a_resync_is_never_accompanied_by_views_invalidated() {
    let (vault, _index, mut daemon) = setup();
    // A view with no prefilter, which every one of the oversized
    // generation's paths passes: without it the rule would name nothing
    // there, and the oversized half of this test would be vacuous.
    std::fs::write(
        vault.path().join("All.base"),
        "views:\n  - type: table\n    name: Everything\n    filters: 'file.size >= 0'\n",
    )
    .unwrap();
    std::fs::write(vault.path().join("Books/D.md"), "---\nprice: 4\n---\n").unwrap();
    let refreshed = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#,
    );
    daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::ResyncRequired(r) if r.current_generation == Some(refreshed))
    });

    // An oversized generation: more than 1024 paths in one change set.
    std::fs::create_dir_all(vault.path().join("Big")).unwrap();
    for at in 0..1100 {
        std::fs::write(vault.path().join(format!("Big/N{at}.md")), "x\n").unwrap();
    }
    daemon.call(r#"{"version":1,"id":"r2","request":{"method":"refresh_index","params":{}}}"#);
    let moved = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"m","request":{"method":"rename_folder","params":{"from":"Big","to":"Moved","rewrite_links":false}}}"#,
    );
    daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::ResyncRequired(r) if r.current_generation == Some(moved))
    });
    let views: Vec<String> = daemon
        .drain_events()
        .into_iter()
        .filter(|raw| raw.contains(r#""type":"views_invalidated""#))
        .collect();
    assert!(
        views.is_empty(),
        "no views_invalidated beside a resync: {views:?}"
    );
}

/// The first cell of the first row of `path`'s first view, as JSON.
fn first_cell(daemon: &mut Daemon, path: &str) -> String {
    match daemon
        .call(&format!(
            r#"{{"version":1,"id":"c","request":{{"method":"evaluate_base","params":{{"path":"{path}"}}}}}}"#
        ))
        .outcome
    {
        ResponseOutcome::Ok(Response::EvaluateBase(answer)) => {
            serde_json::to_string(&answer.rows[0].cells[0]).unwrap()
        }
        other => panic!("evaluate {path}: {other:?}"),
    }
}

/// Write `.obsidian/types.json` through the daemon (a `config_changed`, no
/// generation), and wait for its event.
fn write_types(daemon: &mut Daemon, text: &str) {
    match daemon
        .call(&format!(
            r#"{{"version":1,"id":"y","request":{{"method":"write_file","params":{{"path":".obsidian/types.json","content_base64":"{}","expected":{{"any":true}}}}}}}}"#,
            base64_of(text)
        ))
        .outcome
    {
        ResponseOutcome::Ok(_) => {}
        ResponseOutcome::Err(error) => panic!("write types.json: {error:?}"),
    }
    daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::ConfigChanged(c) if c.path == ".obsidian/types.json")
    });
}

/// `setup()` plus a note with a date-shaped `due` and a base showing it.
fn dated() -> (TempDir, TempDir, Daemon) {
    let (vault, index, mut daemon) = setup();
    std::fs::create_dir_all(vault.path().join("Dates")).unwrap();
    std::fs::create_dir_all(vault.path().join(".obsidian")).unwrap();
    std::fs::write(vault.path().join("Dates/D.md"), "---\ndue: x\n---\n").unwrap();
    std::fs::write(
        vault.path().join("Due.base"),
        "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Dates\")'\n    order: [due]\n",
    )
    .unwrap();
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.drain_events();
    (vault, index, daemon)
}

/// Untyped, `due: x` is the text `x`; declared a tags property it is `#x`
/// (captured, Task 13). Text that reads as a date is a date whether typed
/// or not, so a date type no longer changes what a cell shows.
const UNTYPED: &str = r#"{"kind":"string","value":"x"}"#;

/// H1: a `types.json` write is a `config_changed` with no generation, and
/// the cached answer must not outlive it: a client that re-asks on
/// `config_changed` gets the newly typed cell.
#[test]
fn a_types_change_reaches_a_re_asked_answer() {
    let (_vault, _index, mut daemon) = dated();
    assert_eq!(first_cell(&mut daemon, "Due.base"), UNTYPED);
    write_types(&mut daemon, r#"{"types":{"due":"tags"}}"#);
    let typed = first_cell(&mut daemon, "Due.base");
    assert!(
        typed.contains(r##""value":"#x""##),
        "still {typed} after config_changed"
    );
}

/// H1: the same write names every view the tracker knows, right behind the
/// `config_changed` event, at the current generation.
#[test]
fn a_types_change_invalidates_the_views_it_retypes() {
    let (_vault, _index, mut daemon) = dated();
    assert_eq!(first_cell(&mut daemon, "Due.base"), UNTYPED);
    let current = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"g","request":{"method":"evaluate_base","params":{"path":"Due.base"}}}"#,
    );
    write_types(&mut daemon, r#"{"types":{"due":"tags"}}"#);
    let named: BTreeSet<String> = daemon
        .drain_events()
        .iter()
        .filter_map(|raw| {
            let event: EventEnvelope = serde_json::from_str(raw).unwrap();
            match event.event {
                RuntimeEventDto::ViewsInvalidated(v) => {
                    assert_eq!(v.generation, current, "named at the current generation");
                    Some(format!("{}#{}", v.base, v.view))
                }
                _ => None,
            }
        })
        .collect();
    assert!(named.contains("Due.base#T"), "named {named:?}");
    assert!(named.contains("V.base#InBooks"), "named {named:?}");
}

/// H1 for an external edit: Obsidian writes `.obsidian/types.json` itself,
/// straight to disk. A watching daemon announces it as `config_changed`,
/// names every view it knows behind it, and a re-ask gets the new type.
#[test]
fn a_types_change_written_straight_to_disk_is_announced_and_reaches_a_re_ask() {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    std::fs::create_dir_all(vault.path().join("Dates")).unwrap();
    std::fs::create_dir_all(vault.path().join(".obsidian")).unwrap();
    std::fs::write(vault.path().join("Dates/D.md"), "---\ndue: x\n---\n").unwrap();
    std::fs::write(
        vault.path().join("Due.base"),
        "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Dates\")'\n    order: [due]\n",
    )
    .unwrap();
    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().unwrap(),
        "--index",
        index.path().join("index.sqlite3").to_str().unwrap(),
        "--reconcile-interval-seconds",
        "0",
    ]);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.call(r#"{"version":1,"id":"s","request":{"method":"subscribe_events","params":{}}}"#);
    assert_eq!(first_cell(&mut daemon, "Due.base"), UNTYPED);
    daemon.drain_events();

    std::fs::write(
        vault.path().join(".obsidian/types.json"),
        r#"{"types":{"due":"tags"}}"#,
    )
    .unwrap();
    daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::ConfigChanged(c) if c.path == ".obsidian/types.json")
    });
    let named: BTreeSet<String> = daemon
        .drain_events()
        .iter()
        .filter_map(|raw| {
            let event: EventEnvelope = serde_json::from_str(raw).unwrap();
            match event.event {
                RuntimeEventDto::ViewsInvalidated(v) => Some(format!("{}#{}", v.base, v.view)),
                _ => None,
            }
        })
        .collect();
    assert!(named.contains("Due.base#T"), "named {named:?}");
    let typed = first_cell(&mut daemon, "Due.base");
    assert!(typed.contains(r##""value":"#x""##), "still {typed}");
}

/// H1's control: one unrelated generation later the same request answers
/// the new type, so the stale answer above is the cache's, not the
/// evaluator's.
#[test]
fn a_new_generation_shows_the_new_type() {
    let (vault, _index, mut daemon) = dated();
    assert_eq!(first_cell(&mut daemon, "Due.base"), UNTYPED);
    std::fs::write(
        vault.path().join(".obsidian/types.json"),
        r#"{"types":{"due":"tags"}}"#,
    )
    .unwrap();
    write_note(&mut daemon, "Other/U.md", "plain\n");
    let typed = first_cell(&mut daemon, "Due.base");
    assert!(typed.contains(r##""value":"#x""##), "{typed}");
}

/// M1: a view that reads an attachment through `file()` reads its size and
/// existence, so a change to the attachment (not a note) stales it.
#[test]
fn a_view_reading_an_attachment_through_file_is_stale_when_it_changes() {
    let (_vault, _index, mut daemon) = setup();
    let write_png = |daemon: &mut Daemon, bytes: &str| {
        generation_of(
            daemon,
            &format!(
                r#"{{"version":1,"id":"a","request":{{"method":"write_file","params":{{"path":"Other/x.png","content_base64":"{}","expected":{{"any":true}}}}}}}}"#,
                base64_of(bytes)
            ),
        )
    };
    let first = write_png(&mut daemon, "png");
    let _ = invalidated_at(&mut daemon, first);
    let created = write_base(
        &mut daemon,
        "Att.base",
        "formulas:\n  size: 'file(\"Other/x.png\").size'\nviews:\n  - type: table\n    name: Sized\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.size]\n",
    );
    let _ = invalidated_at(&mut daemon, created);
    let before = first_cell(&mut daemon, "Att.base");
    assert_eq!(before, r#"{"kind":"number","value":3}"#);

    let grown = write_png(&mut daemon, "a longer png...");
    let after = first_cell(&mut daemon, "Att.base");
    assert_eq!(after, r#"{"kind":"number","value":15}"#, "the cell moved");
    assert!(
        invalidated_at(&mut daemon, grown).contains("Att.base#Sized"),
        "the cell moved {before} -> {after} and the view was not named"
    );
}

fn vaultd(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run vaultd")
}

/// The knob is parsed, refused outside 1 to 4096 and without a vault, and
/// reaches the cache: with one entry, asking a second view evicts the first,
/// so asking the first again at the same generation recomputes it.
#[test]
fn the_cache_entries_flag_is_parsed_bounded_and_applied() {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    let vault_arg = vault.path().to_str().unwrap().to_string();
    let index_arg = index
        .path()
        .join("index.sqlite3")
        .to_str()
        .unwrap()
        .to_string();
    for bad in ["0", "4097", "-1", "many"] {
        let output = vaultd(&[
            "--vault",
            &vault_arg,
            "--index",
            &index_arg,
            "--no-watch",
            "--bases-cache-entries",
            bad,
        ]);
        assert!(!output.status.success(), "{bad} is refused");
        assert!(
            output.stdout.is_empty(),
            "a refused invocation writes no protocol output"
        );
    }
    let output = vaultd(&["--bases-cache-entries", "8"]);
    assert!(!output.status.success(), "the flag requires --vault");

    std::fs::write(vault.path().join("A.md"), "---\nn: 1\n---\n").unwrap();
    std::fs::write(
        vault.path().join("Now.base"),
        "formulas:\n  at: 'random()'\nviews:\n  - type: table\n    name: T\n    order: [formula.at]\n  - type: table\n    name: U\n",
    )
    .unwrap();
    let ask = |daemon: &mut Daemon, view: &str| -> String {
        match daemon
            .call(&format!(
                r#"{{"version":1,"id":"n","request":{{"method":"evaluate_base","params":{{"path":"Now.base","view":"{view}"}}}}}}"#
            ))
            .outcome
        {
            ResponseOutcome::Ok(Response::EvaluateBase(answer)) => {
                serde_json::to_string(&answer.rows).unwrap()
            }
            other => panic!("{other:?}"),
        }
    };
    for (entries, recomputed) in [("1", true), ("4096", false)] {
        let index = TempDir::new_in(scratch()).unwrap();
        let mut daemon = Daemon::start(&[
            "--vault",
            &vault_arg,
            "--index",
            index.path().join("index.sqlite3").to_str().unwrap(),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
            "--bases-cache-entries",
            entries,
        ]);
        daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
        let first = ask(&mut daemon, "T");
        ask(&mut daemon, "U");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let again = ask(&mut daemon, "T");
        assert_eq!(
            first != again,
            recomputed,
            "--bases-cache-entries {entries}: first {first}, again {again}"
        );
    }
}

/// The bulk case over a 10,000-note vault with 500 bases (1,000 views): one
/// folder of 400 notes moves in one generation, and the events are bounded
/// by the (base, view) pairs, never by the 800-odd changed paths, with no
/// view named twice.
#[test]
fn a_bulk_change_emits_at_most_one_event_per_view() {
    const FOLDERS: usize = 25;
    const PER_FOLDER: usize = 400;
    const BASES: usize = 500;
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    for folder in 0..FOLDERS {
        let dir = vault.path().join(format!("F{folder:02}"));
        std::fs::create_dir_all(&dir).unwrap();
        for note in 0..PER_FOLDER {
            std::fs::write(
                dir.join(format!("N{note:03}.md")),
                format!("---\nn: {note}\n---\n"),
            )
            .unwrap();
        }
    }
    std::fs::create_dir_all(vault.path().join("Bases")).unwrap();
    for base in 0..BASES {
        std::fs::write(
            vault.path().join(format!("Bases/B{base:03}.base")),
            format!(
                "views:\n  - type: table\n    name: In\n    filters: 'file.inFolder(\"F{:02}\")'\n  - type: table\n    name: All\n    filters: 'file.size >= 0'\n",
                base % FOLDERS
            ),
        )
        .unwrap();
    }
    // The cold build runs in-process, with no per-line timeout; the daemon
    // then starts on the built cache and catches up warm.
    {
        let config =
            vault_index::IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
                .unwrap();
        let mut service = vault_index::IndexService::open(config).unwrap();
        service.refresh(false).unwrap();
    }
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"s","request":{"method":"subscribe_events","params":{}}}"#);
    // B007's In view answers F07's rows, which the move takes away.
    evaluate(&mut daemon, "Bases/B007.base");

    let moved = generation_of(
        &mut daemon,
        r#"{"version":1,"id":"m","request":{"method":"rename_folder","params":{"from":"F07","to":"M07","rewrite_links":false}}}"#,
    );
    let committed = daemon.wait_for_event(|event| {
        matches!(&event.event, RuntimeEventDto::GenerationCommitted(c) if c.generation == moved)
    });
    let RuntimeEventDto::GenerationCommitted(committed) = committed.event else {
        unreachable!()
    };
    let changed = serde_json::to_value(&committed.changes).unwrap();
    let paths = ["created", "modified", "deleted"]
        .iter()
        .map(|list| changed[list].as_array().map_or(0, Vec::len))
        .sum::<usize>();
    assert!(
        paths >= PER_FOLDER,
        "the move changed {paths} paths in one generation"
    );

    let named: Vec<String> = daemon
        .drain_events()
        .iter()
        .filter_map(|raw| {
            let event: EventEnvelope = serde_json::from_str(raw).unwrap();
            match event.event {
                RuntimeEventDto::ViewsInvalidated(v) if v.generation == moved => {
                    Some(format!("{}#{}", v.base, v.view))
                }
                RuntimeEventDto::ResyncRequired(r) => panic!("a resync in the bulk case: {r:?}"),
                _ => None,
            }
        })
        .collect();
    let unique: BTreeSet<&String> = named.iter().collect();
    assert_eq!(unique.len(), named.len(), "no view is named twice");
    assert!(
        named.len() <= 2 * BASES,
        "{} events for {} views",
        named.len(),
        2 * BASES
    );
    assert!(
        unique.contains(&"Bases/B007.base#In".to_string()),
        "the view whose rows moved"
    );
    assert!(
        !unique.contains(&"Bases/B008.base#In".to_string()),
        "a view over another folder stays quiet"
    );
    assert_eq!(
        unique.iter().filter(|name| name.ends_with("#All")).count(),
        BASES,
        "every no-prefilter view"
    );
}
