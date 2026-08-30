mod support;

use serde_json::Value;
use support::{CASES, load, utf16_offset};
use vault_core::ListItemParent;

/// Obsidian's `listItems[].parent` wire number, reconstructed from our
/// `ListItemParent` domain type per the pinned correction
/// (`docs/plans/structural-parse-extension-implementation.md`, "Pinned DDL
/// and corrections"): a nested item's wire number is its parent item's own
/// start line (positive); a root item's is the negated start line of its
/// containing list, except a list starting at line 0 wire-encodes as `-1`
/// (see fixtures `07`/`14` vs `15`).
fn wire_parent(parent: ListItemParent) -> i64 {
    match parent {
        ListItemParent::Root { list_start_line } => {
            if list_start_line == 0 {
                -1
            } else {
                -(list_start_line as i64)
            }
        }
        ListItemParent::Item { parent_start_line } => parent_start_line as i64,
    }
}

#[test]
fn every_fixture_list_items_match_obsidian_exactly() {
    for &name in CASES {
        let fixture = load(name);
        let expected_items = match &fixture.expected["listItems"] {
            Value::Null => Vec::new(),
            Value::Array(items) => items.clone(),
            other => panic!("{name}: listItems is neither null nor an array: {other:?}"),
        };

        assert_eq!(
            fixture.parsed.list_items.len(),
            expected_items.len(),
            "{name}: list item count mismatch (parsed: {:#?})",
            fixture.parsed.list_items
        );

        for (index, (actual, expected)) in fixture
            .parsed
            .list_items
            .iter()
            .zip(expected_items.iter())
            .enumerate()
        {
            let expected_start = expected["position"]["start"]["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("{name}: listItems[{index}] missing start offset"))
                as usize;
            let expected_end = expected["position"]["end"]["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("{name}: listItems[{index}] missing end offset"))
                as usize;
            assert_eq!(
                utf16_offset(&fixture.source, actual.span.start()),
                expected_start,
                "{name}: listItems[{index}] start offset mismatch"
            );
            assert_eq!(
                utf16_offset(&fixture.source, actual.span.end()),
                expected_end,
                "{name}: listItems[{index}] end offset mismatch"
            );

            let expected_parent = expected["parent"]
                .as_i64()
                .unwrap_or_else(|| panic!("{name}: listItems[{index}] missing parent"));
            assert_eq!(
                wire_parent(actual.parent),
                expected_parent,
                "{name}: listItems[{index}] parent mismatch"
            );

            let expected_task = expected["task"]
                .as_str()
                .map(|value| value.chars().next().expect("task is a single character"));
            assert_eq!(
                actual.task, expected_task,
                "{name}: listItems[{index}] task mismatch"
            );
        }
    }
}

#[test]
fn nested_item_parent_is_the_parent_items_own_start_line() {
    let fixture = load("07-unordered-nested");
    // "- top one" (line 0), "    - nested one" (line 1, parent line 0),
    // "        - deep one" (line 2, parent line 1), "    - nested two"
    // (line 3, parent line 0), "- top two" (line 4, root again).
    assert_eq!(
        fixture.parsed.list_items[0].parent,
        ListItemParent::Root { list_start_line: 0 }
    );
    assert_eq!(
        fixture.parsed.list_items[1].parent,
        ListItemParent::Item {
            parent_start_line: 0
        }
    );
    assert_eq!(
        fixture.parsed.list_items[2].parent,
        ListItemParent::Item {
            parent_start_line: 1
        }
    );
    assert_eq!(
        fixture.parsed.list_items[3].parent,
        ListItemParent::Item {
            parent_start_line: 0
        }
    );
    assert_eq!(
        fixture.parsed.list_items[4].parent,
        ListItemParent::Root { list_start_line: 0 }
    );
}

#[test]
fn a_list_starting_at_line_zero_wire_encodes_as_negative_one() {
    let fixture = load("07-unordered-nested");
    assert_eq!(wire_parent(fixture.parsed.list_items[0].parent), -1);
}

#[test]
fn task_characters_include_the_non_standard_state() {
    let fixture = load("09-task-list");
    let tasks: Vec<Option<char>> = fixture
        .parsed
        .list_items
        .iter()
        .map(|item| item.task)
        .collect();
    assert_eq!(tasks, [Some(' '), Some('x'), Some('/'), None]);
}

#[test]
fn embed_and_link_inside_a_list_item_still_surface_as_references() {
    let fixture = load("10-list-with-link-and-embed");
    assert_eq!(fixture.parsed.list_items.len(), 3);
    assert!(
        fixture
            .parsed
            .references
            .iter()
            .any(|reference| reference.raw_target == "Target Note"),
        "expected the wikilink reference to survive list-item extraction"
    );
    assert!(
        fixture
            .parsed
            .references
            .iter()
            .any(|reference| reference.raw_target == "Some Image.png"),
        "expected the embed reference to survive list-item extraction"
    );
}
