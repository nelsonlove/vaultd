//! The two additive reads a plugin-host mirror needs: `get_tree_entries`, and
//! `get_note`'s `include`.
//!
//! Both exist for the same reason. A mirror that has just applied an edit
//! holds a change set naming a handful of paths, and the shipped wire could
//! answer neither question about it: `get_note` carried no structural rows, so
//! a note's sections and list items could only be refetched by paging the
//! whole vault through a snapshot session; and no read at all returned tree
//! rows by path, so an attachment or folder the change set named had no
//! answer short of paging the entire tree.
//!
//! Everything here crosses the real transport, because the claims are about
//! the wire: which keys are present, which are absent, and what a refusal
//! costs.
//!
//! | rule | witness |
//! | --- | --- |
//! | no `include` answers exactly what it always did | `get_note_without_include_answers_the_documented_shape` |
//! | a requested facet is present, an unrequested one absent | `get_note_serves_each_structural_facet_only_when_it_is_named` |
//! | requested-and-empty is `[]`, never absent | same test, `list_items` half |
//! | the rows are the snapshot pager's own | `get_notes_structural_rows_are_the_ones_snapshot_notes_pages` |
//! | a facet `get_note` already carries is `invalid_request` | `naming_a_facet_get_note_already_carries_is_refused` |
//! | an unknown facet name is `invalid_request` | `an_unknown_facet_name_is_refused_rather_than_ignored` |
//! | tree rows come back in request order | `get_tree_entries_answers_in_request_order_and_names_the_absentees` |
//! | a missing row is `absent`, never an error | same test |
//! | a hidden path is simply absent | same test |
//! | only a note carries a revision | same test |
//! | a bad path is `invalid_path` | `an_invalid_path_is_refused_before_anything_is_read` |
//! | more than the detail cap is `invalid_request` | `asking_for_more_paths_than_one_generations_detail_is_refused` |

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{
    ErrorCode, ListItemDto, NoteDto, Response, ResponseOutcome, SectionDto, TreeEntryKindDto,
};

/// A note with a heading, a paragraph, and a task list, so both structural
/// facets have rows to serve; an attachment and a folder, so a tree read has
/// all three entry kinds to answer about; and a zone file, so "hidden paths
/// are absent rather than an error" is a real path rather than an invented
/// one.
const NOTE: &str = "# One\n\nA paragraph.\n\n- [ ] first\n    - [x] nested\n";

fn wired() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create Folder");
    std::fs::create_dir_all(vault.path().join("Attachments")).expect("create Attachments");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("Folder/Note.md"), NOTE).expect("write Note");
    std::fs::write(vault.path().join("Attachments/a.png"), [1u8, 2, 3]).expect("write attachment");
    std::fs::write(vault.path().join(".obsidian/app.json"), "{}").expect("write app.json");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    (vault, index, daemon)
}

fn get_note(daemon: &mut Daemon, include: &str) -> NoteDto {
    let response = daemon.call(&format!(
        r#"{{"version":1,"id":"n","request":{{"method":"get_note","params":{{"path":"Folder/Note.md"{include}}}}}}}"#
    ));
    match response.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => response.note,
        other => panic!("get_note failed: {other:?}"),
    }
}

/// The keys of the `get_note` response's `note` object, as `docs/protocol.md`
/// documents them.
///
/// Read out of the document rather than restated here: the point of the pin is
/// that a `get_note` carrying no `include` answers **the documented shape**,
/// and a copy of that shape in this file could drift from the document while
/// both stayed green. `tests/protocol_doc_examples.rs` already proves the
/// example deserializes; this proves the server still produces it.
fn documented_note_keys() -> Vec<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/protocol.md");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    for line in text.lines() {
        if !line.contains(r#""type":"get_note""#) {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line).expect("a JSON example");
        let note = value
            .pointer("/outcome/value/value/note")
            .and_then(serde_json::Value::as_object)
            .expect("the documented get_note example carries a note object");
        return note.keys().cloned().collect();
    }
    panic!("docs/protocol.md has no get_note response example");
}

#[test]
fn get_note_without_include_answers_the_documented_shape() {
    let (_vault, _index, mut daemon) = wired();
    let note = get_note(&mut daemon, "");

    let encoded = serde_json::to_value(&note).expect("encode");
    let keys: Vec<String> = encoded
        .as_object()
        .expect("a note object")
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        keys,
        documented_note_keys(),
        "a get_note with no `include` must answer exactly the documented shape — \
         same keys, same order, and neither structural facet"
    );
    assert_eq!(note.sections, None);
    assert_eq!(note.list_items, None);
}

/// An explicitly empty `include` is the same request as an absent one: it
/// names no facet, so it gets none. The wire has one meaning for "asked for
/// nothing", not two.
#[test]
fn an_explicitly_empty_include_is_the_same_as_no_include() {
    let (_vault, _index, mut daemon) = wired();
    assert_eq!(
        get_note(&mut daemon, r#","include":[]"#),
        get_note(&mut daemon, "")
    );
}

#[test]
fn get_note_serves_each_structural_facet_only_when_it_is_named() {
    let (_vault, _index, mut daemon) = wired();

    let sections_only = get_note(&mut daemon, r#","include":["sections"]"#);
    assert!(
        !sections_only
            .sections
            .as_ref()
            .expect("sections were requested")
            .is_empty(),
        "this fixture's note has blocks: {sections_only:?}"
    );
    assert_eq!(
        sections_only.list_items, None,
        "a facet nobody asked for is absent, not empty"
    );

    let items_only = get_note(&mut daemon, r#","include":["list_items"]"#);
    assert_eq!(items_only.sections, None);
    let items = items_only.list_items.expect("list_items were requested");
    assert_eq!(
        items.len(),
        2,
        "one top-level task and one nested: {items:?}"
    );
    assert_eq!(items[0].task.as_deref(), Some(" "));
    assert!(items[0].list_start_line.is_some() && items[0].parent_start_line.is_none());
    assert_eq!(items[1].task.as_deref(), Some("x"));
    assert!(items[1].parent_start_line.is_some() && items[1].list_start_line.is_none());

    // Requested and empty is `[]`, which is the whole reason the field is an
    // `Option<Vec<_>>` rather than a `Vec<_>`: this note has no list at all,
    // and "there are none" must not read as "you did not ask".
    std::fs::write(
        _vault.path().join("Folder/Plain.md"),
        "# Plain\n\nNo lists here.\n",
    )
    .expect("write Plain");
    daemon.call(r#"{"version":1,"id":"r2","request":{"method":"refresh_index","params":{}}}"#);
    let response = daemon.call(
        r#"{"version":1,"id":"p","request":{"method":"get_note","params":{"path":"Folder/Plain.md","include":["list_items"]}}}"#,
    );
    let plain = match response.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => response.note,
        other => panic!("get_note failed: {other:?}"),
    };
    assert_eq!(plain.list_items, Some(Vec::new()));
    let encoded = serde_json::to_string(&plain).expect("encode");
    assert!(
        encoded.contains(r#""list_items":[]"#) && !encoded.contains("sections"),
        "requested-and-empty is a present empty list; unrequested is no key at all: {encoded}"
    );
}

/// The reuse claim, asserted rather than asserted-about: `get_note`'s
/// structural rows are the rows a `snapshot_notes` page serves for the same
/// note, because both come from the same two loaders. A second query text for
/// the per-path read would be free to disagree about ordering, about
/// `block_id`, or about the list-parent convention, and this is what would
/// catch it.
#[test]
fn get_notes_structural_rows_are_the_ones_snapshot_notes_pages() {
    let (_vault, _index, mut daemon) = wired();
    let note = get_note(&mut daemon, r#","include":["sections","list_items"]"#);

    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed: {other:?}"),
    };
    let paged = daemon.call(&format!(
        r#"{{"version":1,"id":"sn","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}","include":["sections","list_items"]}}}}}}"#
    ));
    let notes = match paged.outcome {
        ResponseOutcome::Ok(Response::SnapshotNotes(response)) => response.notes,
        other => panic!("snapshot_notes failed: {other:?}"),
    };
    let paged = notes
        .iter()
        .find(|paged| paged.path == "Folder/Note.md")
        .expect("the fixture's note is in the page");

    let sections: &Vec<SectionDto> = note.sections.as_ref().expect("sections were requested");
    let items: &Vec<ListItemDto> = note.list_items.as_ref().expect("list_items were requested");
    assert_eq!(Some(sections), paged.sections.as_ref());
    assert_eq!(Some(items), paged.list_items.as_ref());
    assert_eq!(note.revision, paged.revision);
}

/// The four facets `get_note` already carries unconditionally. Naming one is a
/// client asking for something this operation does not serve *in that
/// position*, and the evolution rule's value-versus-field split says such a
/// request must be refused rather than answered as though it named nothing.
#[test]
fn naming_a_facet_get_note_already_carries_is_refused() {
    let (_vault, _index, mut daemon) = wired();
    for facet in ["metadata", "references", "resolutions", "backlinks"] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"n","request":{{"method":"get_note","params":{{"path":"Folder/Note.md","include":["{facet}"]}}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => {
                assert_eq!(error.code, ErrorCode::InvalidRequest, "{error:?}");
                assert!(
                    error.message.contains(facet),
                    "the refusal must name the facet it is about: {}",
                    error.message
                );
            }
            other => panic!("{facet} must not be accepted by get_note: {other:?}"),
        }
    }
}

#[test]
fn an_unknown_facet_name_is_refused_rather_than_ignored() {
    let (_vault, _index, mut daemon) = wired();
    let response = daemon.call(
        r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Folder/Note.md","include":["futures"]}}}"#,
    );
    match response.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{error:?}")
        }
        other => panic!("an unknown facet must be refused: {other:?}"),
    }
}

fn tree_entries(daemon: &mut Daemon, paths: &[&str]) -> ResponseOutcome {
    let list = paths
        .iter()
        .map(|path| format!("\"{path}\""))
        .collect::<Vec<_>>()
        .join(",");
    daemon
        .call(&format!(
            r#"{{"version":1,"id":"te","request":{{"method":"get_tree_entries","params":{{"paths":[{list}]}}}}}}"#
        ))
        .outcome
}

/// One call, every kind, and the two answers a mirror actually needs: the rows
/// that exist and the paths that do not.
///
/// A hidden path is *absent*, not an error and not a refusal: the index never
/// lists the configuration zone, so there is genuinely no row at that
/// generation, and a mirror working from a change set has to be able to ask
/// about a path that turns out not to be there.
#[test]
fn get_tree_entries_answers_in_request_order_and_names_the_absentees() {
    let (_vault, _index, mut daemon) = wired();
    let outcome = tree_entries(
        &mut daemon,
        &[
            "Attachments/a.png",
            "gone.txt",
            "Folder",
            ".obsidian/app.json",
            "Folder/Note.md",
        ],
    );
    let response = match outcome {
        ResponseOutcome::Ok(Response::GetTreeEntries(response)) => response,
        other => panic!("get_tree_entries failed: {other:?}"),
    };

    let paths: Vec<&str> = response
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec!["Attachments/a.png", "Folder", "Folder/Note.md"],
        "entries come back in request order, with the absentees left out"
    );
    assert_eq!(
        response.absent,
        vec!["gone.txt".to_string(), ".obsidian/app.json".to_string()],
        "a path with no row is named back the way the caller spelled it"
    );
    assert!(response.generation > 0, "{response:?}");

    let attachment = &response.entries[0];
    assert_eq!(attachment.kind, TreeEntryKindDto::File);
    assert_eq!(attachment.size, Some(3));
    assert_eq!(
        attachment.revision, None,
        "the index stores no content revision for an attachment"
    );

    let folder = &response.entries[1];
    assert_eq!(folder.kind, TreeEntryKindDto::Folder);
    assert_eq!(folder.size, None, "a folder has no bytes");
    assert_eq!(folder.revision, None);

    let note = &response.entries[2];
    assert_eq!(note.kind, TreeEntryKindDto::Note);
    assert_eq!(note.size, Some(NOTE.len() as u64));
    assert!(
        note.revision
            .as_deref()
            .is_some_and(|revision| revision.starts_with("blake3:")),
        "a note carries the revision its `notes` row holds: {note:?}"
    );
    assert!(note.ctime_unix_ms > 0 && note.mtime_unix_ms > 0, "{note:?}");
}

/// Asking about nothing is a legal, cheap question with a real answer: the
/// generation, and two empty lists.
#[test]
fn asking_about_no_paths_still_names_the_generation() {
    let (_vault, _index, mut daemon) = wired();
    match tree_entries(&mut daemon, &[]) {
        ResponseOutcome::Ok(Response::GetTreeEntries(response)) => {
            assert!(response.entries.is_empty() && response.absent.is_empty());
            assert!(response.generation > 0);
        }
        other => panic!("an empty ask is not an error: {other:?}"),
    }
}

#[test]
fn an_invalid_path_is_refused_before_anything_is_read() {
    let (_vault, _index, mut daemon) = wired();
    // `\\u0000` is a JSON escape: the daemon decodes a real NUL byte from it.
    // A NUL is not a vault-relative path — no filesystem accepts one — and
    // answering `ok` for it puts a NUL byte on the wire inside a success
    // response, which a host's own path handling has no reason to expect.
    for spelling in ["../escape.md", "/absolute.md", "bad\\u0000name.md"] {
        match tree_entries(&mut daemon, &["Folder", spelling]) {
            ResponseOutcome::Err(error) => {
                assert_eq!(error.code, ErrorCode::InvalidPath, "{spelling}: {error:?}");
            }
            other => panic!("{spelling} must not be answered: {other:?}"),
        }
    }
}

/// A NUL byte is refused by **every** operation that takes a path, not just by
/// the ones whose engine happens to carry its own gate.
///
/// `VaultPath::new` rejects an empty component, `.`, `..`, a leading `/`, and
/// `\` — but never rejected a NUL. The write path did not notice because
/// `MutationEngine::refuse_nul` compensates for the verbs that reach the
/// filesystem; a *read* has no such gate, so `get_tree_entries` shipped
/// answering `ok` and echoing the NUL back inside `absent`. The fix belongs in
/// `parse_path`, which is the one door every path-taking request comes
/// through, so this test enumerates them rather than pinning the one that was
/// broken.
#[test]
fn every_request_that_takes_a_path_refuses_a_nul_byte() {
    let (_vault, _index, mut daemon) = wired();
    let nul = "bad\\u0000name.md";
    let requests = [
        format!(r#"{{"method":"get_note","params":{{"path":"{nul}"}}}}"#),
        format!(r#"{{"method":"get_backlinks","params":{{"path":"{nul}"}}}}"#),
        format!(r#"{{"method":"list_references","params":{{"source_path":"{nul}"}}}}"#),
        format!(r#"{{"method":"get_diagnostics","params":{{"path":"{nul}"}}}}"#),
        format!(
            r#"{{"method":"resolve_link","params":{{"source_path":"{nul}","destination":"Other"}}}}"#
        ),
        format!(r#"{{"method":"read_file","params":{{"path":"{nul}"}}}}"#),
        format!(r#"{{"method":"get_tree_entries","params":{{"paths":["{nul}"]}}}}"#),
        // The write half comes through the same door. `create_folder` also
        // has the engine's own `refuse_nul` behind this, which stays — it
        // guards a direct engine caller that never passes a dispatcher.
        format!(r#"{{"method":"create_folder","params":{{"path":"{nul}"}}}}"#),
        format!(
            r#"{{"method":"write_note","params":{{"path":"{nul}","content":"x\n","expected":{{"absent":true}}}}}}"#
        ),
        format!(
            r#"{{"method":"write_file","params":{{"path":"{nul}","content_base64":"AAEC","expected":{{"any":true}}}}}}"#
        ),
        format!(
            r#"{{"method":"delete_note","params":{{"path":"{nul}","mode":"permanent","expected":{{"any":true}}}}}}"#
        ),
        format!(r#"{{"method":"delete_folder","params":{{"path":"{nul}","recursive":false}}}}"#),
    ];
    for request in requests {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"nul","request":{request}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::InvalidPath,
                "a NUL byte must be `invalid_path` for {request}: {error:?}"
            ),
            other => panic!("{request} answered a NUL path: {other:?}"),
        }
    }
}

/// The cap is the transport's own per-generation detail limit, reused rather
/// than restated. A change set larger than it is already reported as counts
/// plus a resync rather than as paths, so a caller holding more than 1024
/// paths is not working from a detailed change set and has no answer this
/// operation could give it.
#[test]
fn asking_for_more_paths_than_one_generations_detail_is_refused() {
    let (_vault, _index, mut daemon) = wired();

    let at_cap: Vec<String> = (0..1024).map(|index| format!("p{index}.md")).collect();
    let at_cap: Vec<&str> = at_cap.iter().map(String::as_str).collect();
    match tree_entries(&mut daemon, &at_cap) {
        ResponseOutcome::Ok(Response::GetTreeEntries(response)) => {
            assert_eq!(response.absent.len(), 1024, "exactly at the cap is served");
        }
        other => panic!("1024 paths is within the cap: {other:?}"),
    }

    let past_cap: Vec<String> = (0..1025).map(|index| format!("p{index}.md")).collect();
    let past_cap: Vec<&str> = past_cap.iter().map(String::as_str).collect();
    match tree_entries(&mut daemon, &past_cap) {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{error:?}");
            assert!(error.message.contains("1024"), "{}", error.message);
        }
        other => panic!("one past the cap must be refused: {other:?}"),
    }
}
