//! `patch_frontmatter`: every byte outside an addressed span survives.

use vault_core::VaultPath;
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

/// A document whose frontmatter holds the four keys the strategy edits, plus
/// arbitrary body prose. The body is the property's whole subject: no
/// frontmatter edit may move one of its bytes.
fn document() -> impl Strategy<Value = String> {
    (
        "[a-z]{1,8}",
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

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

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

    /// The keys a patch does not address keep their exact source lines.
    #[test]
    fn a_patch_never_moves_an_unaddressed_key(
        original in document(),
        value in "[a-z]{1,8}",
    ) {
        let patched = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(value)))])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        for line in original.lines() {
            if line.starts_with("title:") {
                continue;
            }
            prop_assert!(
                patched.contains(line),
                "line {line:?} vanished from {patched:?}"
            );
        }
    }

    /// Re-applying the value a key already holds is byte-identical, so a
    /// no-op patch never manufactures a generation.
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
