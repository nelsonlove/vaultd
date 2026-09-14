//! `patch_frontmatter`: every byte outside an addressed span survives.

use vault_core::{DiagnosticCode, PropertyValue, SourceDocument, VaultPath, parse_note};
use vault_index::{FrontmatterEdit, MutationError, PatchValue, patch_source};

fn path() -> VaultPath {
    VaultPath::new("One.md").expect("valid vault path")
}

fn edit(key_path: &str, value: Option<PatchValue>) -> FrontmatterEdit {
    FrontmatterEdit {
        key_path: key_path.split('.').map(str::to_string).collect(),
        value,
    }
}

const DOCUMENT: &str = "---\ntitle: Original\ncount: 3\ntags:\n  - one\n  - two\nnested:\n  inner:\n    leaf: old\n---\n# Body\n\nUntouched prose with a link.\n";

/// The body is every byte after the closing fence. Nothing a frontmatter
/// patch does may move one of them.
fn body(text: &str) -> &str {
    let rest = text.strip_prefix("---\n").expect("fixture has frontmatter");
    let end = rest.find("\n---\n").expect("fixture has a closing fence");
    &rest[end + "\n---\n".len()..]
}

/// Every source line of `DOCUMENT` that does not belong to the top-level
/// property `key` — the exact bytes a patch addressing `key` (at any depth
/// below it) is allowed to leave alone and nothing else.
///
/// This is the assertion correction #9 calls for: an edit below a stored
/// span's granularity re-serializes its enclosing property, so "nothing
/// changed" is scoped to *outside that property*, not to every byte of the
/// frontmatter.
///
/// A top-level property owns its key line plus every line indented under it,
/// and nothing else. So *any* unindented line ends the previous property —
/// not only another key line. Testing for a colon as well would leave the
/// closing `---` and the whole body inside a property that happens to be the
/// last one in the block, which is exactly the shape a fresh key added before
/// the fence produces.
fn outside_property(text: &str, key: &str) -> Vec<String> {
    let mut kept = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if !line.starts_with(' ') {
            inside = line.starts_with(&format!("{key}:"));
        }
        if !inside {
            kept.push(line.to_string());
        }
    }
    kept
}

#[test]
fn replacing_a_scalar_touches_only_that_value() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title", Some(PatchValue::String("Replaced".into())))],
    )
    .expect("replace a scalar");
    assert!(patched.contains("title: Replaced\n"), "{patched}");
    assert!(patched.contains("count: 3\n"), "{patched}");
    assert!(patched.contains("  - one\n  - two\n"), "{patched}");
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn a_nested_dot_path_edits_the_leaf_and_nothing_outside_its_property() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "nested.inner.leaf",
            Some(PatchValue::String("new".into())),
        )],
    )
    .expect("edit a nested leaf");
    assert!(
        patched.contains("nested:\n  inner:\n    leaf: new\n"),
        "{patched}"
    );
    assert!(!patched.contains("leaf: old"), "{patched}");
    // The `nested` property is re-serialized whole, per correction #9, so the
    // byte-preservation claim is scoped to everything *outside* it: the other
    // three keys, their order, their exact spelling, and the whole body.
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn a_nested_edit_whose_top_level_key_is_missing_creates_the_whole_structure() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("brand.new.leaf", Some(PatchValue::String("v".into())))],
    )
    .expect("processFrontMatter parity: the intermediate mappings are created");
    assert!(
        patched.contains("    leaf: old\nbrand:\n  new:\n    leaf: v\n---\n"),
        "{patched}"
    );
    assert_eq!(
        outside_property(&patched, "brand"),
        outside_property(DOCUMENT, "brand"),
        "creating a new key moves no existing one"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_key_takes_its_trailing_line_terminator_with_it() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("count", None)]).expect("delete a scalar key");
    assert!(!patched.contains("count"), "{patched}");
    assert!(
        patched.contains("title: Original\ntags:\n"),
        "no blank line may be left behind: {patched}"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_block_sequence_removes_every_one_of_its_lines() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("tags", None)]).expect("delete a block sequence");
    assert!(!patched.contains("- one"), "{patched}");
    assert!(!patched.contains("- two"), "{patched}");
    assert!(patched.contains("count: 3\nnested:\n"), "{patched}");
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_key_that_is_not_there_is_byte_identical() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("absent", None)]).expect("delete a missing key");
    assert_eq!(patched, DOCUMENT);
}

#[test]
fn adding_a_key_appends_it_before_the_closing_fence() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("status", Some(PatchValue::String("open".into())))],
    )
    .expect("add a key");
    assert!(
        patched.contains("    leaf: old\nstatus: open\n---\n"),
        "{patched}"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn adding_a_key_to_a_document_with_no_frontmatter_creates_the_block() {
    let plain = "# Body\n\nprose\n";
    let patched = patch_source(
        &path(),
        plain,
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("create frontmatter");
    assert_eq!(patched, "---\ntitle: New\n---\n# Body\n\nprose\n");
}

#[test]
fn the_addition_dialect_is_pinned_byte_for_byte() {
    let plain = "body\n";
    let patched = patch_source(
        &path(),
        plain,
        &[
            edit("flag", Some(PatchValue::Boolean(true))),
            edit("count", Some(PatchValue::Integer(-2))),
            edit("ratio", Some(PatchValue::Float(1.5))),
            edit("plain", Some(PatchValue::String("no quotes needed".into()))),
            edit("quoted", Some(PatchValue::String("yes".into()))),
            edit("colon", Some(PatchValue::String("a: b".into()))),
            edit("empty", Some(PatchValue::String(String::new()))),
            edit(
                "list",
                Some(PatchValue::Sequence(vec![
                    PatchValue::String("one".into()),
                    PatchValue::Integer(2),
                ])),
            ),
            edit(
                "map",
                Some(PatchValue::Mapping(vec![(
                    "inner".to_string(),
                    PatchValue::String("value".into()),
                )])),
            ),
        ],
    )
    .expect("serialize every shape");
    assert_eq!(
        patched,
        "---\nflag: true\ncount: -2\nratio: 1.5\nplain: no quotes needed\nquoted: \"yes\"\ncolon: \"a: b\"\nempty: \"\"\nlist:\n  - one\n  - 2\nmap:\n  inner: value\n---\nbody\n"
    );
}

/// A flow collection ends a token at a comma, so a string holding one is
/// quoted there — while the same string on a block `- ` line stays bare,
/// because there it means itself. Without the flow-context rule `[["a, b"]]`
/// is written `[[a, b]]` and reads back as two items.
#[test]
fn a_comma_is_quoted_inside_a_flow_collection_and_left_bare_on_a_block_line() {
    let patched = patch_source(
        &path(),
        "body\n",
        &[
            edit(
                "block",
                Some(PatchValue::Sequence(vec![PatchValue::String(
                    "a, b".into(),
                )])),
            ),
            edit(
                "nested",
                Some(PatchValue::Sequence(vec![PatchValue::Sequence(vec![
                    PatchValue::String("a, b".into()),
                ])])),
            ),
        ],
    )
    .expect("serialize a comma in both contexts");
    assert_eq!(
        patched,
        "---\nblock:\n  - a, b\nnested:\n  - [\"a, b\"]\n---\nbody\n"
    );
}

/// A literal newline inside double quotes folds to a space on the way back,
/// so a multi-line string is written with the `\n` escape instead.
#[test]
fn a_newline_in_a_string_is_escaped_rather_than_left_to_fold() {
    let patched = patch_source(
        &path(),
        "body\n",
        &[edit("note", Some(PatchValue::String("one\ntwo".into())))],
    )
    .expect("serialize a multi-line string");
    assert_eq!(patched, "---\nnote: \"one\\ntwo\"\n---\nbody\n");
}

/// A key path segment is whatever the caller sent, so a key that spells a
/// bool reaches the serializer. Bare, YAML reads it back as `true` — and a
/// non-string key is a shape the parser refuses outright.
#[test]
fn a_mapping_key_that_yaml_would_read_as_a_bool_is_quoted() {
    let patched = patch_source(
        &path(),
        "body\n",
        &[edit("meta.on", Some(PatchValue::String("x".into())))],
    )
    .expect("a key that spells a bool");
    assert_eq!(patched, "---\nmeta:\n  \"on\": x\n---\nbody\n");
}

#[test]
fn many_additions_to_a_document_with_no_frontmatter_share_one_fence() {
    // The failure this pins: planning each addition independently makes every
    // one of them wrap itself, and a document with no frontmatter ends up with
    // N stacked `---` blocks of which only the first is frontmatter at all.
    // The fence is synthesized once, after every addition is collected.
    let patched = patch_source(
        &path(),
        "# Body\n",
        &[
            edit("one", Some(PatchValue::String("a".into()))),
            edit("two", Some(PatchValue::String("b".into()))),
            edit("three", Some(PatchValue::String("c".into()))),
        ],
    )
    .expect("three additions to a bare document");
    assert_eq!(patched, "---\none: a\ntwo: b\nthree: c\n---\n# Body\n");
    assert_eq!(
        patched.matches("---\n").count(),
        2,
        "exactly one fence pair, however many keys were added: {patched}"
    );
}

#[test]
fn an_unterminated_frontmatter_fence_is_refused_rather_than_given_a_second_one() {
    let error = patch_source(
        &path(),
        "---\ntitle: Original\n# no closing fence\n",
        &[edit("added", Some(PatchValue::String("x".into())))],
    )
    .expect_err("prepending a second fence would bury the first");
    assert!(
        matches!(error, MutationError::MalformedFrontmatter { .. }),
        "expected malformed_frontmatter, got {error:?}"
    );
}

#[test]
fn replacing_a_scalar_with_a_block_sequence_drops_the_dangling_space() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "title",
            Some(PatchValue::Sequence(vec![PatchValue::String("a".into())])),
        )],
    )
    .expect("replace a scalar with a block sequence");
    assert!(patched.contains("title:\n  - a\ncount: 3\n"), "{patched}");
}

#[test]
fn adding_a_nested_key_inside_an_existing_mapping_indents_it() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "nested.inner.added",
            Some(PatchValue::String("x".into())),
        )],
    )
    .expect("add a nested key");
    assert!(
        patched.contains("    leaf: old\n    added: x\n"),
        "{patched}"
    );
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn descending_into_a_sequence_edits_the_element_and_reserializes_its_property() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("tags.0", Some(PatchValue::String("x".into())))],
    )
    .expect("a numeric segment indexes the sequence");
    assert!(patched.contains("tags:\n  - x\n  - two\n"), "{patched}");
    assert_eq!(
        outside_property(&patched, "tags"),
        outside_property(DOCUMENT, "tags"),
        "only the addressed property is re-serialized"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn descending_into_a_scalar_is_the_one_thing_still_refused() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title.sub", Some(PatchValue::String("x".into())))],
    )
    .expect_err("a string has no member to set, and inventing one would discard the string");
    match error {
        MutationError::UnaddressablePatch { key_path } => assert_eq!(key_path, "title.sub"),
        other => panic!("expected unaddressable_patch, got {other:?}"),
    }
}

#[test]
fn indexing_a_sequence_past_its_end_is_refused_but_deleting_there_is_a_no_op() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[edit("tags.9", Some(PatchValue::String("x".into())))],
    )
    .expect_err("there is no ninth tag to replace");
    assert!(
        matches!(error, MutationError::UnaddressablePatch { .. }),
        "expected unaddressable_patch, got {error:?}"
    );
    assert_eq!(
        patch_source(&path(), DOCUMENT, &[edit("tags.9", None)])
            .expect("deleting what is not there is a no-op at every depth"),
        DOCUMENT
    );
}

#[test]
fn deleting_a_nested_leaf_reserializes_its_property_without_it() {
    let patched = patch_source(&path(), DOCUMENT, &[edit("nested.inner.leaf", None)])
        .expect("delete a nested leaf");
    assert!(!patched.contains("leaf"), "{patched}");
    assert!(patched.contains("nested:\n  inner: {}\n"), "{patched}");
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
}

/// One edit whose segments are given literally rather than dot-split — the
/// wire's array `key_path` form, which is the only way to address a key whose
/// own name carries a `.`.
fn segments(key_path: &[&str], value: Option<PatchValue>) -> FrontmatterEdit {
    FrontmatterEdit {
        key_path: key_path
            .iter()
            .map(|segment| (*segment).to_string())
            .collect(),
        value,
    }
}

const DOTTED_KEY_DOCUMENT: &str =
    "---\ntitle: Original\nmy.key: old\ncount: 3\n---\n# Body\n\nProse.\n";

/// Task 1e (a): a literal dot in a key name is addressable by segment, and a
/// set, a create, and a delete each touch that key alone.
#[test]
fn a_literal_dot_segment_edits_creates_and_deletes_that_key() {
    let set = patch_source(
        &path(),
        DOTTED_KEY_DOCUMENT,
        &[segments(
            &["my.key"],
            Some(PatchValue::String("new".into())),
        )],
    )
    .expect("set a key whose name holds a dot");
    assert_eq!(
        set, "---\ntitle: Original\nmy.key: new\ncount: 3\n---\n# Body\n\nProse.\n",
        "every other byte survives"
    );

    let created = patch_source(
        &path(),
        DOTTED_KEY_DOCUMENT,
        &[segments(
            &["other.key"],
            Some(PatchValue::String("fresh".into())),
        )],
    )
    .expect("create a key whose name holds a dot");
    assert_eq!(
        created,
        "---\ntitle: Original\nmy.key: old\ncount: 3\nother.key: fresh\n---\n# Body\n\nProse.\n"
    );

    let deleted = patch_source(&path(), DOTTED_KEY_DOCUMENT, &[segments(&["my.key"], None)])
        .expect("delete a key whose name holds a dot");
    assert_eq!(
        deleted,
        "---\ntitle: Original\ncount: 3\n---\n# Body\n\nProse.\n"
    );
}

/// With no dot in play, the two forms address the same key: one segment
/// spelled literally is the dot-path of the same name.
#[test]
fn a_single_segment_and_a_dot_free_dot_path_address_the_same_key() {
    let by_segment = patch_source(
        &path(),
        DOCUMENT,
        &[segments(
            &["title"],
            Some(PatchValue::String("Same".into())),
        )],
    )
    .expect("segment form");
    let by_dot_path = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title", Some(PatchValue::String("Same".into())))],
    )
    .expect("dot-path form");
    assert_eq!(by_segment, by_dot_path);

    let nested_by_segment = patch_source(
        &path(),
        DOCUMENT,
        &[segments(
            &["nested", "inner", "leaf"],
            Some(PatchValue::String("same".into())),
        )],
    )
    .expect("nested segment form");
    let nested_by_dot_path = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "nested.inner.leaf",
            Some(PatchValue::String("same".into())),
        )],
    )
    .expect("nested dot-path form");
    assert_eq!(nested_by_segment, nested_by_dot_path);
}

/// Task 1e (b): [`PatchValue::Null`] writes a YAML null rather than deleting
/// the key — the `fm.key = null` case `processFrontMatter` writes as
/// `key: null`. Deletion keeps its own spelling (`value: None`).
#[test]
fn an_explicit_null_writes_a_yaml_null_rather_than_deleting_the_key() {
    let overwritten = patch_source(&path(), DOCUMENT, &[edit("title", Some(PatchValue::Null))])
        .expect("overwrite a scalar with a null");
    assert!(overwritten.contains("title: null\n"), "{overwritten}");
    assert_eq!(read_back(&overwritten, "title"), PropertyValue::Null);
    assert_eq!(
        outside_property(&overwritten, "title"),
        outside_property(DOCUMENT, "title"),
        "only the addressed key's line changed"
    );
    assert_eq!(body(&overwritten), body(DOCUMENT));

    let created = patch_source(
        &path(),
        DOCUMENT,
        &[edit("reviewed", Some(PatchValue::Null))],
    )
    .expect("create a key holding a null");
    assert!(created.contains("reviewed: null\n"), "{created}");
    assert_eq!(read_back(&created, "reviewed"), PropertyValue::Null);
    assert_eq!(body(&created), body(DOCUMENT));

    let deleted =
        patch_source(&path(), DOCUMENT, &[edit("title", None)]).expect("deletion still deletes");
    assert!(!deleted.contains("title"), "{deleted}");
}

const LIST_OF_MAPS: &str = "---\ntitle: Original\nitems:\n  - name: a\n    value: 9\n  - name: b\n    value: 10\nouter:\n  desc: |\n    line one\n    line two\n  other: kept\n---\n# Body\n";

/// Task 1e (c): a scalar leaf has a span of its own, so setting one splices
/// that scalar and leaves the item's block layout alone. Before this, the
/// whole `items` property was re-emitted and each map item collapsed into
/// `- {name: a, value: 9}`.
#[test]
fn patching_a_leaf_inside_a_block_list_of_maps_keeps_the_item_layout() {
    let patched = patch_source(
        &path(),
        LIST_OF_MAPS,
        &[segments(
            &["items", "0", "value"],
            Some(PatchValue::Integer(99)),
        )],
    )
    .expect("patch one leaf inside a list of maps");
    assert_eq!(
        patched,
        LIST_OF_MAPS.replace("    value: 9\n", "    value: 99\n"),
        "only the addressed scalar's own bytes moved"
    );
}

/// The same narrowing for a multi-line block scalar: it is a scalar, so a
/// plain scalar replaces exactly its span — the `|` and its indented lines —
/// and the sibling key below keeps its bytes. The block form is gone because
/// the caller replaced the value, not because the property was reflowed.
#[test]
fn replacing_a_block_scalar_leaf_with_a_plain_scalar_leaves_its_sibling_alone() {
    let patched = patch_source(
        &path(),
        LIST_OF_MAPS,
        &[segments(
            &["outer", "desc"],
            Some(PatchValue::String("short".into())),
        )],
    )
    .expect("replace a nested block scalar");
    assert_eq!(
        patched,
        LIST_OF_MAPS.replace("  desc: |\n    line one\n    line two\n", "  desc: short\n"),
        "the block scalar's own span, and nothing else"
    );
}

/// The boundary the narrowing deliberately stops at, pinned so a later change
/// to it is a decision rather than a surprise: a **non-scalar** new value
/// still re-serializes the whole enclosing top-level property, and the block
/// items reflow into flow style. `VAULTD-COMPATIBILITY.md` records this.
#[test]
fn a_non_scalar_value_still_reserializes_the_enclosing_property() {
    let patched = patch_source(
        &path(),
        LIST_OF_MAPS,
        &[segments(
            &["items", "0", "value"],
            Some(PatchValue::Sequence(vec![PatchValue::Integer(9)])),
        )],
    )
    .expect("set a nested leaf to a sequence");
    assert!(
        patched.contains("items:\n  - {name: a, value: [9]}\n  - {name: b, value: 10}\n"),
        "{patched}"
    );
    assert!(patched.contains("title: Original\n"), "{patched}");
    assert!(patched.contains("  other: kept\n"), "{patched}");
}

/// The value `key` holds once `vault-core` has read `document` back. This is
/// the only honest test of the serializer: what matters is not what bytes it
/// emitted but what the parser makes of them.
fn read_back(document: &str, key: &str) -> PropertyValue {
    let note = parse_note(SourceDocument::new(path(), document.to_string()));
    let structural: Vec<_> = note
        .diagnostics
        .iter()
        .filter(|diagnostic| {
            matches!(
                diagnostic.code,
                DiagnosticCode::MalformedFrontmatter
                    | DiagnosticCode::UnsupportedPropertyShape
                    | DiagnosticCode::UnterminatedFrontmatter
            )
        })
        .collect();
    assert!(
        structural.is_empty(),
        "re-reading {document:?} produced {structural:?}"
    );
    note.properties
        .iter()
        .find(|property| property.key.value == key)
        .unwrap_or_else(|| panic!("no property {key} in {document:?}"))
        .value
        .value
        .clone()
}

/// A sequence's items as plain strings, so an expectation does not have to
/// invent the spans `PropertyValue` carries.
fn sequence_strings(value: &PropertyValue) -> Vec<String> {
    let PropertyValue::Sequence(items) = value else {
        panic!("not a sequence: {value:?}");
    };
    items
        .iter()
        .map(|item| match &item.value {
            PropertyValue::String(text) => text.clone(),
            other => panic!("not a string item: {other:?}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The shapes a real vault holds that the brief's fixture document does not.
// Every test below was written from a reviewer's reproduced failure, not from
// the brief: an empty value, a block scalar, unreadable frontmatter, a YAML
// anchor, CRLF, and YAML's number grammar.
// ---------------------------------------------------------------------------

/// `title:` — the linter's own empty-property spelling, and the commonest
/// shape in the reference vault after a plain scalar. `vault-core` gives it a
/// zero-width `Null` span sitting *at* the colon, so a splice built from it
/// naively runs backwards and `replace_range` panics. Nothing above the
/// engine installs a `catch_unwind`, so that panic takes the coordinator down.
#[test]
fn setting_a_key_whose_value_is_empty_does_not_panic() {
    let source = "---\ntitle:\ncount: 3\n---\n# Body\n";
    let patched = patch_source(
        &path(),
        source,
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("an empty value is a value to replace, not a panic");
    assert_eq!(patched, "---\ntitle: New\ncount: 3\n---\n# Body\n");
}

/// The same shape with the trailing space a hand-edit leaves behind. The
/// space belongs to the value, so the replacement takes it rather than
/// leaving `title:  New`.
#[test]
fn setting_a_key_whose_empty_value_has_a_trailing_space_leaves_one_space() {
    let patched = patch_source(
        &path(),
        "---\ntitle: \ncount: 3\n---\n# Body\n",
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("a padded empty value is still a value");
    assert_eq!(patched, "---\ntitle: New\ncount: 3\n---\n# Body\n");
}

#[test]
fn deleting_a_key_whose_value_is_empty_removes_exactly_its_line() {
    let patched = patch_source(
        &path(),
        "---\ntitle:\ncount: 3\n---\n# Body\n",
        &[edit("title", None)],
    )
    .expect("delete an empty-valued key");
    assert_eq!(patched, "---\ncount: 3\n---\n# Body\n");
}

/// A null holds no value, so descending into it creates the structure rather
/// than refusing — the `fm.a = fm.a ?? {}` parity that makes a missing
/// top-level key create its whole path. A *scalar* is still refused, because
/// that one would discard something the caller never mentioned.
#[test]
fn a_nested_create_under_an_empty_valued_key_builds_the_structure() {
    let patched = patch_source(
        &path(),
        "---\nmeta:\ncount: 3\n---\n# Body\n",
        &[edit(
            "meta.inner.leaf",
            Some(PatchValue::String("v".into())),
        )],
    )
    .expect("a null discards nothing, so the path is created");
    assert_eq!(
        patched,
        "---\nmeta:\n  inner:\n    leaf: v\ncount: 3\n---\n# Body\n"
    );
}

/// A block scalar's stored value span ends at the first byte of the **next
/// key**, not at its own last byte — the one value type whose span overshoots
/// its property. A splice built from it swallows the neighbour, and the
/// engine commits the wreckage as `Ok`.
#[test]
fn setting_a_block_scalar_leaves_the_next_property_byte_identical() {
    for indicator in ["|", ">", "|-", ">+"] {
        let source = format!(
            "---\ntitle: Original\ndesc: {indicator}\n  first line\n  second line\ntail: end\n---\n# Body\n"
        );
        let patched = patch_source(
            &path(),
            &source,
            &[edit("desc", Some(PatchValue::String("short".into())))],
        )
        .unwrap_or_else(|error| panic!("set a {indicator} block scalar: {error}"));
        assert_eq!(
            patched, "---\ntitle: Original\ndesc: short\ntail: end\n---\n# Body\n",
            "indicator {indicator}"
        );
        assert_eq!(
            outside_property(&patched, "desc"),
            outside_property(&source, "desc"),
            "indicator {indicator}: only desc may move"
        );
    }
}

/// The same overrun with nothing after it to swallow but the closing fence —
/// the note loses its frontmatter entirely.
#[test]
fn setting_a_block_scalar_that_is_the_last_property_leaves_the_fence() {
    for indicator in ["|", ">", "|-", ">+"] {
        let source =
            format!("---\ntitle: Original\ndesc: {indicator}\n  first line\n---\n# Body\n");
        let patched = patch_source(
            &path(),
            &source,
            &[edit("desc", Some(PatchValue::String("short".into())))],
        )
        .unwrap_or_else(|error| panic!("set a trailing {indicator} block scalar: {error}"));
        assert_eq!(
            patched, "---\ntitle: Original\ndesc: short\n---\n# Body\n",
            "indicator {indicator}"
        );
        assert_eq!(body(&patched), body(&source), "indicator {indicator}");
    }
}

#[test]
fn deleting_a_block_scalar_removes_only_its_own_lines() {
    for indicator in ["|", ">", "|-", ">+"] {
        let source = format!(
            "---\ntitle: Original\ndesc: {indicator}\n  first line\n  second line\ntail: end\n---\n# Body\n"
        );
        let patched = patch_source(&path(), &source, &[edit("desc", None)])
            .unwrap_or_else(|error| panic!("delete a {indicator} block scalar: {error}"));
        assert_eq!(
            patched, "---\ntitle: Original\ntail: end\n---\n# Body\n",
            "indicator {indicator}"
        );
    }
}

/// Frontmatter the parser turned into no properties at all is the state in
/// which every key looks absent, so a set appends a **duplicate** into a
/// document nobody can read and reports success. Refuse instead.
#[test]
fn frontmatter_that_parsed_into_no_properties_is_refused_rather_than_appended_to() {
    for source in [
        // Unparseable YAML.
        "---\ntitle: [unclosed\ncount: 3\n---\n# Body\n",
        // Valid YAML, but not a mapping.
        "---\n- a\n- b\n---\n# Body\n",
        // A null document.
        "---\nnull\n---\n# Body\n",
        // An empty flow mapping: appending a block key after it does not parse.
        "---\n{}\n---\n# Body\n",
    ] {
        let error = patch_source(
            &path(),
            source,
            &[edit("added", Some(PatchValue::String("x".into())))],
        )
        .expect_err("appending into frontmatter nobody can read is not success");
        assert!(
            matches!(error, MutationError::MalformedFrontmatter { .. }),
            "expected malformed_frontmatter for {source:?}, got {error:?}"
        );
    }
}

/// The refusal above must not be over-broad. A comment-only or empty
/// frontmatter block has no properties either, and appending to it is
/// well-defined and right.
#[test]
fn a_comment_only_or_empty_frontmatter_still_accepts_an_addition() {
    for (source, expected) in [
        (
            "---\n# just a comment\n---\n# Body\n",
            "---\n# just a comment\nadded: x\n---\n# Body\n",
        ),
        ("---\n---\n# Body\n", "---\nadded: x\n---\n# Body\n"),
        ("---\n\n---\n# Body\n", "---\n\nadded: x\n---\n# Body\n"),
    ] {
        assert_eq!(
            patch_source(
                &path(),
                source,
                &[edit("added", Some(PatchValue::String("x".into())))]
            )
            .unwrap_or_else(|error| panic!("{source:?}: {error}")),
            expected
        );
    }
}

/// And it must key off "no properties", not off a diagnostic code:
/// `UnsupportedPropertyShape` is also raised for a malformed `aliases:`
/// **value** in a block whose properties all parsed fine.
#[test]
fn a_malformed_aliases_value_does_not_block_an_unrelated_patch() {
    let patched = patch_source(
        &path(),
        "---\ntitle: Original\naliases:\n  - nested:\n      bad: shape\n---\n# Body\n",
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("the properties parsed; only the alias projection complained");
    assert!(patched.contains("title: New\n"), "{patched}");
}

/// The gate on unreadable frontmatter validates the **input**. This is the
/// separate claim that the **result** parses, and the two are not the same
/// check: `---\na: 1\n...\n---` is perfectly readable — one document, one
/// property — and a key added after the `...` document-end marker starts a
/// *second* YAML document. The frontmatter then re-parses with zero
/// properties, so the index loses every one of them while the caller is told
/// the write succeeded.
#[test]
fn a_patch_whose_result_stops_parsing_is_refused_even_though_the_input_parsed() {
    let source = "---\na: 1\n...\n---\n# Body\n";

    // The input really is readable, so the input gate cannot be what refuses:
    // an ordinary edit to the same document succeeds.
    assert_eq!(
        read_back(source, "a"),
        PropertyValue::Integer(1),
        "the fixture's own premise"
    );
    assert!(
        patch_source(&path(), source, &[edit("a", Some(PatchValue::Integer(2)))]).is_ok(),
        "an edit that keeps one document is fine"
    );

    let error = patch_source(
        &path(),
        source,
        &[edit("added", Some(PatchValue::String("x".into())))],
    )
    .expect_err("the result would re-parse with no properties at all");
    assert!(
        matches!(error, MutationError::MalformedFrontmatter { .. }),
        "expected malformed_frontmatter, got {error:?}"
    );
}

/// Result validation must change nothing for an ordinary patch. The whole
/// rest of this file is that assertion; these pin the two shapes a
/// result check is most likely to mistake for damage.
#[test]
fn result_validation_leaves_ordinary_patches_alone() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title", Some(PatchValue::String("Replaced".into())))],
    )
    .expect("an ordinary patch still succeeds");
    assert!(patched.contains("title: Replaced\n"), "{patched}");
    assert_eq!(read_back(&patched, "count"), PropertyValue::Integer(3));

    // Deleting the last key empties the block rather than breaking it. A
    // result check keyed on "it had properties and now has none" would refuse
    // this; one keyed on "content the parser turned into nothing" does not.
    assert_eq!(
        patch_source(
            &path(),
            "---\ntitle: x\n---\n# Body\n",
            &[edit("title", None)]
        )
        .expect("delete the only key"),
        "---\n---\n# Body\n"
    );
}

/// `vault-core` resolves a YAML alias before this module sees it, so
/// re-emitting or deleting the anchored property leaves `*anchor` pointing at
/// nothing and the **whole** frontmatter stops parsing. That is damage
/// outside the edited property, which correction #9 forbids absolutely.
#[test]
fn editing_a_property_whose_anchor_another_property_aliases_is_refused() {
    let source = "---\nbase: &shared\n  a: 1\nuser: *shared\n---\n# Body\n";
    for patch in [
        vec![edit("base.a", Some(PatchValue::Integer(2)))],
        vec![edit("base", None)],
        vec![edit("base", Some(PatchValue::String("x".into())))],
    ] {
        let error = patch_source(&path(), source, &patch)
            .expect_err("orphaning the alias would break a sibling property");
        match error {
            MutationError::AnchoredProperty { anchor, .. } => assert_eq!(anchor, "shared"),
            other => panic!("expected anchored_property, got {other:?}"),
        }
    }
}

#[test]
fn an_anchor_that_nothing_aliases_does_not_block_the_patch() {
    let patched = patch_source(
        &path(),
        "---\nbase: &unused\n  a: 1\nother: plain\n---\n# Body\n",
        &[edit("base.a", Some(PatchValue::Integer(2)))],
    )
    .expect("an unused anchor orphans nothing");
    assert!(patched.contains("a: 2"), "{patched}");
}

/// `R&D` is not an anchor and `*emphasis*` in the body is not an alias. The
/// scan counts a sigil only where a YAML token could start, so neither is
/// mistaken for one.
#[test]
fn an_ampersand_inside_a_value_is_not_mistaken_for_an_anchor() {
    let patched = patch_source(
        &path(),
        "---\nteam: R&D\nnested:\n  leaf: old\n---\n*emphasis* and a * star\n",
        &[edit("nested.leaf", Some(PatchValue::String("new".into())))],
    )
    .expect("no anchor is declared anywhere");
    assert!(patched.contains("leaf: new"), "{patched}");
}

/// An emitted line takes the document's own terminator. Mixing them parses
/// fine and churns every diff, which is the opposite of what this module is
/// for.
#[test]
fn an_edit_to_a_crlf_document_emits_crlf() {
    let source = "---\r\ntitle: Original\r\ntags:\r\n  - one\r\n---\r\n# Body\r\n";
    let patched = patch_source(
        &path(),
        source,
        &[
            edit(
                "tags",
                Some(PatchValue::Sequence(vec![PatchValue::String("z".into())])),
            ),
            edit("added", Some(PatchValue::String("x".into()))),
        ],
    )
    .expect("patch a CRLF document");
    assert_eq!(
        patched,
        "---\r\ntitle: Original\r\ntags:\r\n  - z\r\nadded: x\r\n---\r\n# Body\r\n"
    );
    assert!(
        !patched.contains("\n\n")
            && patched.matches('\n').count() == patched.matches("\r\n").count(),
        "no bare LF may be introduced: {patched:?}"
    );
}

#[test]
fn an_edit_to_an_lf_document_still_emits_lf() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("added", Some(PatchValue::String("x".into())))],
    )
    .expect("patch an LF document");
    assert!(!patched.contains('\r'), "{patched:?}");
}

/// Every spelling here must come back out of `vault-core` as the **string**
/// it went in as. The first eight are YAML's number grammar, which is not
/// Rust's: `parse::<f64>()` rejects `.inf`, `.nan`, `0x1A`, and `0o17`, and
/// YAML reads all four as numbers.
#[test]
fn hostile_scalars_round_trip_as_strings_in_every_position() {
    const HOSTILE: [&str; 32] = [
        ".inf",
        "-.inf",
        "+.inf",
        ".INF",
        ".nan",
        ".NaN",
        "0x1A",
        "0o17",
        "on",
        "off",
        "yes",
        "no",
        "true",
        "false",
        "null",
        "~",
        "12",
        "1.5",
        "1e3",
        "007",
        "+1",
        "-3",
        " padded ",
        "",
        "a, b",
        "a: b",
        "# hash",
        "---",
        "...",
        "one\ntwo",
        "back\\slash",
        "[[wiki, link]]",
    ];

    for sent in HOSTILE {
        // Top-level scalar.
        let document = patch_source(
            &path(),
            "body\n",
            &[edit("v", Some(PatchValue::String(sent.into())))],
        )
        .unwrap_or_else(|error| panic!("{sent:?}: {error}"));
        assert_eq!(
            read_back(&document, "v"),
            PropertyValue::String(sent.to_string()),
            "top-level scalar {sent:?} emitted as {document:?}"
        );

        // Block sequence item, then a flow item nested one level deeper.
        let document = patch_source(
            &path(),
            "body\n",
            &[
                edit(
                    "block",
                    Some(PatchValue::Sequence(vec![PatchValue::String(sent.into())])),
                ),
                edit(
                    "flow",
                    Some(PatchValue::Sequence(vec![PatchValue::Sequence(vec![
                        PatchValue::String(sent.into()),
                    ])])),
                ),
            ],
        )
        .unwrap_or_else(|error| panic!("{sent:?}: {error}"));
        assert_eq!(
            sequence_strings(&read_back(&document, "block")),
            vec![sent.to_string()],
            "block item {sent:?} emitted as {document:?}"
        );
        let PropertyValue::Sequence(outer) = read_back(&document, "flow") else {
            panic!("flow item {sent:?}: not a sequence in {document:?}");
        };
        assert_eq!(outer.len(), 1, "flow item {sent:?} in {document:?}");
        assert_eq!(
            sequence_strings(&outer[0].value),
            vec![sent.to_string()],
            "flow item {sent:?} emitted as {document:?}"
        );
    }

    // Mapping-key position, for every spelling that is a legal path segment.
    for sent in HOSTILE {
        if sent.is_empty() || sent.contains('.') || sent.contains('\n') {
            continue;
        }
        let document = patch_source(
            &path(),
            "body\n",
            &[edit(
                &format!("outer.{sent}"),
                Some(PatchValue::String("v".into())),
            )],
        )
        .unwrap_or_else(|error| panic!("key {sent:?}: {error}"));
        let PropertyValue::Mapping(entries) = read_back(&document, "outer") else {
            panic!("key {sent:?}: outer is not a mapping in {document:?}");
        };
        assert_eq!(
            entries
                .iter()
                .map(|(key, _)| key.value.clone())
                .collect::<Vec<_>>(),
            vec![sent.to_string()],
            "mapping key {sent:?} emitted as {document:?}"
        );
    }
}

#[test]
fn two_edits_to_the_same_key_are_refused_rather_than_silently_ordered() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[
            edit("title", Some(PatchValue::String("first".into()))),
            edit("title", Some(PatchValue::String("second".into()))),
        ],
    )
    .expect_err("two edits to one span have no defined result");
    assert_eq!(error, MutationError::OverlappingPatch);
}

#[test]
fn an_empty_patch_is_byte_identical() {
    assert_eq!(
        patch_source(&path(), DOCUMENT, &[]).expect("no edits"),
        DOCUMENT
    );
}

use proptest::prelude::*;

/// A title the serializer will spell exactly the way the document does.
///
/// `[a-z]{1,8}` alone draws `on`, `no`, `yes`, `off`, `y`, `n`, `true`,
/// `false`, `null`, `inf`, `nan`, and `infinity` — every one of which YAML
/// reads as something other than a string, so `scalar()` rightly quotes it
/// and `title: on` becomes `title: "on"`. That made
/// `re_setting_an_identical_scalar_is_byte_identical` fail on roughly one
/// draw in forty: the *serializer* was right and the property's expectation
/// was wrong. Ending every title in `x` excludes the whole class without a
/// hand-maintained word list that could drift out of step with the quoting
/// rules. The excluded case is not lost: it is pinned deterministically by
/// `a_title_yaml_would_read_as_a_bool_is_re_quoted`, and covered generally
/// by `re_applying_the_same_edit_is_byte_identical`, which needs no
/// restriction at all.
fn plain_title() -> impl Strategy<Value = String> {
    "[a-z]{0,7}x"
}

/// A document whose frontmatter holds the four keys the strategy edits, plus
/// arbitrary body prose. The body is the property's whole subject: no
/// frontmatter edit may move one of its bytes.
fn document() -> impl Strategy<Value = String> {
    (
        plain_title(),
        0i64..1000,
        prop::collection::vec("[a-z]{1,6}", 0..4),
        "(?s)[a-zA-Z0-9 \n#\\[\\]-]{0,200}",
    )
        .prop_map(|(title, count, tags, body)| {
            let mut text = String::from("---\n");
            text.push_str(&format!("title: {title}\n"));
            text.push_str(&format!("count: {count}\n"));
            if tags.is_empty() {
                text.push_str("tags: []\n");
            } else {
                text.push_str("tags:\n");
                for tag in &tags {
                    text.push_str(&format!("  - {tag}\n"));
                }
            }
            text.push_str("nested:\n  leaf: value\n");
            text.push_str("---\n");
            text.push_str(&body);
            text
        })
}

fn any_edit() -> impl Strategy<Value = FrontmatterEdit> {
    prop_oneof![
        "[a-z]{1,8}".prop_map(|value| edit("title", Some(PatchValue::String(value)))),
        (0i64..1000).prop_map(|value| edit("count", Some(PatchValue::Integer(value)))),
        Just(edit("count", None)),
        Just(edit("tags", None)),
        "[a-z]{1,6}".prop_map(|value| edit("nested.leaf", Some(PatchValue::String(value)))),
        Just(edit("nested.leaf", None)),
        "[a-z]{1,6}".prop_map(|value| edit("added", Some(PatchValue::String(value)))),
        Just(edit("absent", None)),
    ]
}

/// 256 cases by default, and `PROPTEST_CASES` honoured when it is set —
/// which is **exactly what `ProptestConfig::with_cases(256)` already does**.
///
/// This helper is equivalent, not a fix. An earlier revision of this comment
/// claimed `with_cases` swallowed the environment variable; a reviewer
/// disproved that against proptest 1.11.0's own source and was right.
/// `sugar.rs` passes *any* config expression through
/// `test_runner::contextualize_config` (`config.rs:20`), which re-applies
/// `PROPTEST_CASES` on top of whatever it is given, so the variable survives
/// either spelling. The observation that suggested otherwise was a
/// measurement error: both runs being compared had the variable set to the
/// same value, so there was no 256-case baseline in the comparison at all.
/// Measured after the correction, both spellings scale identically — 0.19 s
/// at 256 against ~12 s at 20000.
///
/// Kept only because it states the default at the call site and costs
/// nothing. The other five proptest suites in this workspace deliberately
/// keep `with_cases`; there is nothing to migrate.
fn cases() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 256;
    }
    config
}

proptest! {
    #![proptest_config(cases())]

    /// The body survives every patch, byte for byte.
    #[test]
    fn a_patch_never_moves_a_byte_of_the_body(
        original in document(),
        patch in any_edit(),
    ) {
        let patched = patch_source(&path(), &original, &[patch])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        prop_assert_eq!(body(&patched), body(&original));
    }

    /// The keys a patch does not address keep their exact source lines, in
    /// their exact order.
    ///
    /// A line *vector* comparison, not `patched.contains(line)`: containment
    /// is satisfied by a reordered or duplicated line and is vacuously true
    /// for the empty lines the body strategy generates, so it was weaker than
    /// the test's own name. `title` is a top-level key and takes the span
    /// surgery path, so every other line must survive byte for byte.
    #[test]
    fn a_patch_never_moves_an_unaddressed_key(
        original in document(),
        value in "[a-z]{1,8}",
    ) {
        let patched = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(value)))])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        let without_title = |text: &str| {
            text.lines()
                .filter(|line| !line.starts_with("title:"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        prop_assert_eq!(without_title(&patched), without_title(&original));
    }

    /// Re-applying the value a key already holds is byte-identical, so a
    /// no-op patch never manufactures a generation. The title strategy is
    /// restricted to spellings the serializer does not re-quote — see
    /// `plain_title` for why that is the property's honesty and not its
    /// weakening.
    #[test]
    fn re_setting_an_identical_scalar_is_byte_identical(original in document()) {
        let current = original
            .lines()
            .find_map(|line| line.strip_prefix("title: "))
            .expect("the fixture always has a title")
            .to_string();
        let patched = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(current)))])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        prop_assert_eq!(patched, original);
    }

    /// Patching is idempotent: whatever the serializer chose the first time,
    /// applying the same edit again changes nothing. This is the no-op claim
    /// in the form that holds for **every** value, including the bool-ish
    /// spellings the property above excludes — it compares the serializer
    /// against itself rather than against the author's spelling.
    #[test]
    fn re_applying_the_same_edit_is_byte_identical(
        original in document(),
        value in "[a-z]{1,8}",
    ) {
        let once = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(value.clone())))])
            .map_err(|error| TestCaseError::fail(format!("first patch failed: {error}")))?;
        let twice = patch_source(&path(), &once, &[edit("title", Some(PatchValue::String(value)))])
            .map_err(|error| TestCaseError::fail(format!("second patch failed: {error}")))?;
        prop_assert_eq!(twice, once);
    }
}

/// The case `plain_title` excludes, pinned deterministically: the document
/// spells it bare, YAML reads that as a boolean, so re-setting it as a string
/// *must* change the bytes. The serializer is right and a byte-identity
/// expectation would be wrong.
#[test]
fn a_title_yaml_would_read_as_a_bool_is_re_quoted() {
    let patched = patch_source(
        &path(),
        "---\ntitle: on\n---\n# Body\n",
        &[edit("title", Some(PatchValue::String("on".into())))],
    )
    .expect("re-set a bool-ish title");
    assert_eq!(patched, "---\ntitle: \"on\"\n---\n# Body\n");
    assert_eq!(
        read_back(&patched, "title"),
        PropertyValue::String("on".into()),
        "and now it reads back as the string it was set to"
    );
}

// ---------------------------------------------------------------------------
// The engine operation. `patch_source` above is pure; everything below drives
// `Mutation::PatchFrontmatter` through `MutationEngine`, whose job is to reach
// that function only for a target a note write may legally reach, and to write
// the result atomically. Every refusal here must leave the vault
// byte-identical, which is what each test asserts alongside the error.
// ---------------------------------------------------------------------------

use std::path::PathBuf;

use tempfile::TempDir;
use vault_index::{Mutation, MutationEngine, Precondition, revision_of};

const NOTE: &str = "---\ntitle: Original\ncount: 3\n---\n# Body\n";

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), NOTE).expect("write One");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn at(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

fn patch(spelling: &str, edits: Vec<FrontmatterEdit>, expected: Precondition) -> Mutation {
    Mutation::PatchFrontmatter {
        path: at(spelling),
        patch: edits,
        expected,
    }
}

#[test]
fn a_patch_writes_the_edited_document_and_reports_its_revision() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("Replaced".into())))],
            Precondition::Revision(revision_of(NOTE.as_bytes())),
        ))
        .expect("patch under a matching revision");

    let written = std::fs::read_to_string(fixture.root.join("One.md")).expect("read back");
    assert_eq!(written, "---\ntitle: Replaced\ncount: 3\n---\n# Body\n");
    assert_eq!(outcome.revision, Some(revision_of(written.as_bytes())));
    assert_eq!(
        outcome.changed_paths.iter().collect::<Vec<_>>(),
        vec![&at("One.md")]
    );
    assert!(outcome.semantic, "a note's frontmatter is indexed");
}

/// `semantic` states what half of the index this operation is over, not
/// whether this call moved a byte — so it stays `true` even here, while
/// `changed_paths` is what goes empty. Delete the byte-identity branch and the
/// file's mtime moves, which is what this asserts.
#[test]
fn a_byte_identical_patch_names_no_path_and_never_touches_the_file() {
    let fixture = fixture();
    let target = fixture.root.join("One.md");
    let before = std::fs::metadata(&target)
        .expect("stat before")
        .modified()
        .expect("mtime before");

    let outcome = fixture
        .engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("Original".into())))],
            Precondition::Any,
        ))
        .expect("re-set the value the key already holds");

    assert!(outcome.changed_paths.is_empty(), "no generation is due");
    assert_eq!(outcome.revision, Some(revision_of(NOTE.as_bytes())));
    assert!(outcome.semantic, "still a semantic operation");
    assert_eq!(
        std::fs::read_to_string(&target).expect("read back"),
        NOTE,
        "byte-identical"
    );
    assert_eq!(
        std::fs::metadata(&target)
            .expect("stat after")
            .modified()
            .expect("mtime after"),
        before,
        "an unchanged document is not rewritten"
    );
}

/// Delete the configuration-zone guard and a patch starts editing a file the
/// index will never hold, so the revision it reports names no generation.
#[test]
fn a_patch_inside_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(fixture.root.join(".obsidian/x.md"), NOTE).expect("write into the zone");

    let error = fixture
        .engine
        .apply(&patch(
            ".obsidian/x.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("nothing in the zone is ever indexed");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(".obsidian/x.md")).expect("read back"),
        NOTE
    );
}

/// The witness for the *second* zone check, the one on the resolved path.
/// Every dot-spelled path is refused before `resolve` runs, so a symlink whose
/// resolved parent is hidden is the only input that reaches it.
#[cfg(unix)]
#[test]
fn a_patch_through_a_symlink_into_a_hidden_folder_is_refused_after_resolution() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".secret")).expect("create the hidden folder");
    std::fs::write(fixture.root.join(".secret/x.md"), NOTE).expect("write into it");
    std::os::unix::fs::symlink(fixture.root.join(".secret"), fixture.root.join("Alias"))
        .expect("link an innocuous name at a hidden folder");

    let error = fixture
        .engine
        .apply(&patch(
            "Alias/x.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("the link resolves into a folder the scan never lists");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(".secret/x.md")).expect("read back"),
        NOTE
    );
}

/// Frontmatter is a Markdown notion. A patch of an attachment would parse
/// arbitrary bytes as YAML and rewrite them.
#[test]
fn a_patch_of_a_non_markdown_path_is_refused() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("data.json"), b"{}\n").expect("write an attachment");

    let error = fixture
        .engine
        .apply(&patch(
            "data.json",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("only a note has frontmatter");
    assert!(
        matches!(error, MutationError::NotANote { .. }),
        "expected not_a_note, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("data.json")).expect("read back"),
        b"{}\n"
    );
}

/// A patch edits a document that must already be there, so `absent` names a
/// state no successful patch could ever leave behind.
#[test]
fn an_absent_precondition_is_refused_as_invalid_rather_than_evaluated() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Absent,
        ))
        .expect_err("absent is not a precondition a patch can carry");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("One.md")).expect("read back"),
        NOTE
    );
}

#[test]
fn patching_an_absent_note_unconditionally_is_not_found_rather_than_a_create() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&patch(
            "Missing.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("a patch edits, it never creates");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
    assert!(!fixture.root.join("Missing.md").exists());
}

#[test]
fn a_stale_revision_refuses_and_leaves_the_note_alone() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Revision(revision_of(b"something else")),
        ))
        .expect_err("the note does not hold that revision");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current, Some(revision_of(NOTE.as_bytes())));
        }
        other => panic!("expected revision_conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("One.md")).expect("read back"),
        NOTE
    );
}

/// Delete the case guard and, on a case-insensitive filesystem, this patch
/// reads and rewrites the stored `One.md` — a file the caller never addressed
/// — while reporting the spelling it was asked about.
#[test]
fn a_case_variant_spelling_is_refused_rather_than_folded_onto_the_stored_note() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&patch(
            "one.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("one.md is not the stored spelling");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "One.md"),
        other => panic!("expected case_collision, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("One.md")).expect("read back"),
        NOTE
    );
}

/// A directory at the target name is "something else occupies this name", not
/// a note to parse — and reading it would answer `EISDIR`, which reaches a
/// client as a claim the daemon is broken.
#[test]
fn a_directory_at_the_target_name_is_refused_as_an_occupied_name() {
    let fixture = fixture();
    std::fs::create_dir(fixture.root.join("Folder.md"))
        .expect("create a directory named like a note");

    let error = fixture
        .engine
        .apply(&patch(
            "Folder.md",
            vec![edit("title", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("a directory has no frontmatter");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("Folder.md").is_dir());
}

/// The *result* of a patch is deliberately uncapped, so an already-oversized
/// note stays patchable. The **edits** are a payload the client hands the
/// daemon, and the cap's own rule applies to those — otherwise a client that
/// cannot `write_note` a huge note can patch one key to a huge string and get
/// the same file.
#[test]
fn an_oversized_edit_payload_is_refused_before_anything_is_read() {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), NOTE).expect("write One");
    let engine = MutationEngine::new(&root).with_max_file_bytes(64);

    let error = engine
        .apply(&patch(
            "One.md",
            vec![edit(
                "title",
                Some(PatchValue::String("x".repeat(65).to_string())),
            )],
            Precondition::Any,
        ))
        .expect_err("the edits exceed the payload cap");
    match error {
        MutationError::TooLarge { limit, actual } => {
            assert_eq!(limit, 64);
            assert!(actual > 64, "actual {actual}");
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(root.join("One.md")).expect("read back"),
        NOTE
    );
}

/// An oversized *note* stays patchable by a small edit — the ruling the cap
/// above must not quietly overturn.
#[test]
fn a_note_larger_than_the_cap_is_still_patchable_by_a_small_edit() {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    let big = format!("---\ntitle: Original\n---\n{}\n", "padding ".repeat(64));
    std::fs::write(root.join("One.md"), &big).expect("write One");
    let engine = MutationEngine::new(&root).with_max_file_bytes(64);

    engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("New".into())))],
            Precondition::Any,
        ))
        .expect("a small edit to an over-cap note is exactly what the ruling protects");
    assert!(
        std::fs::read_to_string(root.join("One.md"))
            .expect("read back")
            .contains("title: New\n")
    );
}

/// The patcher's own refusals reach the caller unchanged, and nothing is
/// written on the way.
#[test]
fn an_unaddressable_key_path_refuses_before_anything_is_written() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&patch(
            "One.md",
            vec![edit("title.sub", Some(PatchValue::String("x".into())))],
            Precondition::Any,
        ))
        .expect_err("title is a string with no member to set");
    assert!(
        matches!(error, MutationError::UnaddressablePatch { .. }),
        "expected unaddressable_patch, got {error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("One.md")).expect("read back"),
        NOTE
    );
}

// ---------------------------------------------------------------------------
// The note body is not the patch path's business, and must not be able to
// stop it. markdown 1.0.0 panics on some legal bodies, and the patch path was
// running the full parse — so an ordinary `Set` on `title` aborted the whole
// process over content the patch never even looks at.
// ---------------------------------------------------------------------------

/// The minimal body from the reviewer's shrunken proptest case. Every draw of
/// the body strategy could produce it; over 200 000 draws none did, so it is
/// pinned deterministically here rather than left to seed luck.
const PANICKING_BODY_NOTE: &str = "---\ntitle: x\ncount: 0\n---\na\n-\n--\nA\n-\n";

#[test]
fn a_body_that_panics_the_markdown_parser_does_not_reach_the_patch_path() {
    let patched = patch_source(
        &path(),
        PANICKING_BODY_NOTE,
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("the body is not the patch path's business");
    assert_eq!(
        patched, "---\ntitle: New\ncount: 0\n---\na\n-\n--\nA\n-\n",
        "and the body is preserved byte for byte, as for any other patch"
    );
}

/// The same content through the engine, which is the route a wire request
/// takes: `apply_mutation` → `MutationEngine::apply` → here.
#[test]
fn the_engine_patches_a_note_whose_body_panics_the_markdown_parser() {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), PANICKING_BODY_NOTE).expect("write One");
    let engine = MutationEngine::new(&root);

    let outcome = engine
        .apply(&patch(
            "One.md",
            vec![edit("title", Some(PatchValue::String("New".into())))],
            Precondition::Any,
        ))
        .expect("an ordinary request against ordinary vault content");
    assert!(outcome.semantic);
    assert_eq!(
        std::fs::read_to_string(root.join("One.md")).expect("read back"),
        "---\ntitle: New\ncount: 0\n---\na\n-\n--\nA\n-\n"
    );
}

/// `write_note` never parses — it writes the bytes it is given — so the same
/// content through the write path is a control, not a second exposure.
#[test]
fn write_note_is_unaffected_by_a_body_that_panics_the_markdown_parser() {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    let engine = MutationEngine::new(&root);

    engine
        .apply(&Mutation::WriteNote {
            path: at("Poison.md"),
            content: PANICKING_BODY_NOTE.into(),
            expected: Precondition::Absent,
        })
        .expect("write_note passes bytes through without parsing them");
    assert_eq!(
        std::fs::read_to_string(root.join("Poison.md")).expect("read back"),
        PANICKING_BODY_NOTE
    );
}
