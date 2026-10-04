use vault_bases::eval::{EvalContext, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::fixtures::{
    FIXTURE_NOW_MS, FIXTURE_ZONE, capture_vault, check_family, render_text,
};
use vault_bases::{Clock, MemoryFile, MemorySource, Value, no_span};
use vault_core::{PropertyValue, VaultPath};

fn assert_family(family: &str) {
    let failures = check_family(family);
    assert!(
        failures.is_empty(),
        "{} {family} rows disagree:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn file_fields_and_methods() {
    assert_family("file");
}

#[test]
fn link_functions() {
    assert_family("link");
}

fn on(source: &MemorySource, row: &str, this: &str, expression: &str) -> Value {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let row = VaultPath::new(row).unwrap();
    let base = VaultPath::new("Captures.base").unwrap();
    let this = VaultPath::new(this).unwrap();
    let ctx = EvalContext::new(source, &clock, &base, &this);
    evaluate(
        &parse_expression(expression).unwrap(),
        &ctx,
        &Scope::row(&row),
    )
    .unwrap()
}

fn on_row(row: &str, expression: &str) -> Value {
    on(&capture_vault(&[]), row, "Capture.md", expression)
}

#[test]
fn in_folder_means_the_folder_or_a_subfolder_and_nothing_that_only_shares_a_prefix() {
    let inner = "Folder/Deep/Inner.md";
    assert_eq!(
        on_row(inner, r#"file.inFolder("Folder")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(inner, r#"file.inFolder("Folder/Deep")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(inner, r#"file.inFolder("Folder/Deep/")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(inner, r#"file.inFolder("Fold")"#),
        Value::Boolean(false)
    );
    assert_eq!(
        on_row(inner, "file.folder"),
        Value::String("Folder/Deep".into())
    );
}

#[test]
fn in_folder_does_not_match_a_sibling_folder_with_the_same_prefix() {
    let source = MemorySource::new()
        .with("Notes/a.md", MemoryFile::note())
        .with("Notes/Sub/b.md", MemoryFile::note())
        .with("Notes2/c.md", MemoryFile::note());
    let in_notes = r#"file.inFolder("Notes")"#;
    assert_eq!(
        on(&source, "Notes/a.md", "Notes/a.md", in_notes),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, "Notes/Sub/b.md", "Notes/a.md", in_notes),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, "Notes2/c.md", "Notes/a.md", in_notes),
        Value::Boolean(false)
    );
    assert_eq!(
        on(
            &source,
            "Notes2/c.md",
            "Notes/a.md",
            r#"file.inFolder("Notes2")"#
        ),
        Value::Boolean(true)
    );
}

#[test]
fn an_attachment_is_a_row_with_file_facts_and_no_note_facts() {
    let image = "Folder/image.png";
    assert_eq!(on_row(image, "file.ext"), Value::String("png".into()));
    assert_eq!(on_row(image, "file.size"), Value::Number(1000.0));
    assert_eq!(
        on_row(image, "file.properties.isEmpty()"),
        Value::Boolean(true)
    );
    assert_eq!(on_row(image, "file.tags"), Value::list(vec![]));
    assert_eq!(on_row(image, "file.backlinks.length"), Value::Number(1.0));
    assert_eq!(
        on_row(image, r#"file.hasTag("book")"#),
        Value::Boolean(false)
    );
}

#[test]
fn every_file_field_reads_the_row_files_own_facts() {
    let row = "Folder/Deep/Inner.md";
    assert_eq!(on_row(row, "file.name"), Value::String("Inner.md".into()));
    assert_eq!(on_row(row, "file.basename"), Value::String("Inner".into()));
    assert_eq!(on_row(row, "file.path"), Value::String(row.into()));
    assert_eq!(on_row(row, "file.ext"), Value::String("md".into()));
    assert_eq!(on_row(row, "file.file.path"), Value::String(row.into()));
    let capture = "Capture.md";
    assert_eq!(
        on_row(capture, r#"file.ctime.format("YYYY-MM-DD HH:mm")"#),
        Value::String("2026-01-14 10:30".into())
    );
    assert_eq!(
        on_row(capture, r#"file.mtime.format("YYYY-MM-DD HH:mm")"#),
        Value::String("2026-01-15 09:30".into())
    );
    assert_eq!(on_row(capture, "file.size"), Value::Number(42.0));
    assert_eq!(
        on_row("Other.md", "file.links[0].asFile().path"),
        Value::String(capture.into())
    );
    assert_eq!(on_row("Other.md", "file.embeds.length"), Value::Number(0.0));
    assert_eq!(
        on_row("Other.md", "file.backlinks[0].path"),
        Value::String(capture.into())
    );
    assert_eq!(on_row(capture, "file.links[1].asFile()"), Value::Null);
    assert_eq!(
        on_row(capture, "file.embeds[0].asFile().path"),
        Value::String("Folder/image.png".into())
    );
    assert_eq!(
        on_row("Other.md", "file.properties.status"),
        Value::String("done".into())
    );
    assert_eq!(
        on_row("Other.md", r#"file.hasProperty("status")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(capture, r#"file.hasProperty("status")"#),
        Value::Boolean(false)
    );
}

#[test]
fn has_link_takes_a_file_a_link_or_a_string_and_reads_only_the_rows_links() {
    let other = "Other.md";
    assert_eq!(on_row(other, "file.hasLink(this)"), Value::Boolean(true));
    assert_eq!(
        on_row(other, "file.hasLink(this.file)"),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(other, r#"file.hasLink("Capture")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(other, r#"file.hasLink(link("Capture.md"))"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(other, r#"file.hasLink(file("Folder/Deep/Inner.md"))"#),
        Value::Boolean(false)
    );
    assert_eq!(
        on_row(other, r#"file.hasLink("Missing")"#),
        Value::Boolean(false)
    );
    assert_eq!(
        on_row("Capture.md", r#"file.hasLink(file("Other.md"))"#),
        Value::Boolean(true)
    );
}

#[test]
fn links_to_reads_the_linked_files_links_not_the_other_way_round() {
    // Inner links to Other; Other does not link to Inner.
    let source = capture_vault(&[]).with("Folder/Deep/Inner.md", MemoryFile::note().link("Other"));
    let row = "Capture.md";
    assert_eq!(
        on(
            &source,
            row,
            row,
            r#"link("Inner").linksTo(file("Other.md"))"#
        ),
        Value::Boolean(true)
    );
    assert_eq!(
        on(
            &source,
            row,
            row,
            r#"link("Other").linksTo(file("Folder/Deep/Inner.md"))"#
        ),
        Value::Boolean(false)
    );
    assert_eq!(
        on(
            &source,
            row,
            row,
            r#"link("Missing").linksTo(file("Other.md"))"#
        ),
        Value::Boolean(false)
    );
}

#[test]
fn this_is_the_embedding_file_when_one_is_given() {
    let source = capture_vault(&[]);
    let row = "Folder/Deep/Inner.md";
    assert_eq!(
        on(&source, row, "Other.md", "this.file.name"),
        Value::String("Other.md".into())
    );
    assert_eq!(
        on(&source, row, "Other.md", "this.file.properties.status"),
        Value::String("done".into())
    );
    assert_eq!(
        on(&source, row, "Other.md", "file.hasLink(this)"),
        Value::Boolean(false)
    );
    assert_eq!(
        on(&source, "Capture.md", "Other.md", "file.hasLink(this)"),
        Value::Boolean(true)
    );
}

#[test]
fn this_given_as_the_base_reads_the_base_file() {
    // The default (no embedding note, so `this` is the base) is applied by
    // the caller of `evaluate_view` (Task 11); here the base is given.
    let source = capture_vault(&[]).with("Captures.base", MemoryFile::attachment(7));
    let row = "Capture.md";
    let base = "Captures.base";
    assert_eq!(
        on(&source, row, base, "this.file.name"),
        Value::String(base.into())
    );
    assert_eq!(
        on(&source, row, base, "this.file.ext"),
        Value::String("base".into())
    );
    assert_eq!(on(&source, row, base, "this.file.size"), Value::Number(7.0));
    assert_eq!(
        on(&source, row, base, "file.hasLink(this)"),
        Value::Boolean(false)
    );
}

#[test]
fn frontmatter_wikilinks_become_links_resolved_from_the_note_that_wrote_them() {
    let props = [
        ("up".to_string(), PropertyValue::String("[[Other]]".into())),
        ("plain".to_string(), PropertyValue::String("Other".into())),
    ];
    let source = capture_vault(&props);
    let row = "Capture.md";
    assert_eq!(
        on(&source, row, row, "up.asFile().path"),
        Value::String("Other.md".into())
    );
    assert_eq!(
        on(&source, row, row, r#"up == file("Other.md")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, row, row, r#"note.up.isType("link")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, row, row, r#"note["up"].isType("link")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, row, row, r#"file.properties.up.isType("link")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, row, row, r#"plain.isType("string")"#),
        Value::Boolean(true)
    );
}

/// The frontmatter-link walk recurses once per list level. A wikilink 64
/// lists deep still becomes a link, on a 1 MiB stack.
#[test]
fn a_deeply_nested_frontmatter_list_fits_a_one_mebibyte_stack() {
    let mut value = PropertyValue::String("[[Other]]".into());
    for _ in 0..64 {
        value = PropertyValue::Sequence(vec![no_span(value)]);
    }
    let source = capture_vault(&[("deep".to_string(), value)]);
    let bottom = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            let mut value = on(&source, "Capture.md", "Capture.md", "deep");
            let mut depth = 0;
            while let Value::List(items) = value {
                assert_eq!(items.len(), 1);
                value = items[0].clone();
                depth += 1;
            }
            (depth, value)
        })
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(bottom.0, 64);
    assert!(
        matches!(&bottom.1, Value::Link(link) if link.resolved.as_ref().map(VaultPath::as_str) == Some("Other.md")),
        "{:?}",
        bottom.1
    );
}

/// A vault where relative links only resolve from the right folder:
/// `./Sib` and `./B` exist under `Sub/`, not at the root, where the base is.
fn relative_vault() -> MemorySource {
    capture_vault(&[])
        .with(
            "Sub/Row.md",
            MemoryFile::note().property("up", PropertyValue::String("[[./Sib]]".into())),
        )
        .with("Sub/Sib.md", MemoryFile::note())
        .with("Sub/A.md", MemoryFile::note().link("./B"))
        .with("Sub/B.md", MemoryFile::note())
}

#[test]
fn a_frontmatter_link_resolves_from_the_note_that_wrote_it_not_the_base() {
    let source = relative_vault();
    let row = "Sub/Row.md";
    assert_eq!(
        on(&source, row, row, "up.asFile().path"),
        Value::String("Sub/Sib.md".into())
    );
    assert_eq!(
        on(&source, row, row, "note.up.asFile().path"),
        Value::String("Sub/Sib.md".into())
    );
    assert_eq!(
        on(&source, row, row, "file.properties.up.asFile().path"),
        Value::String("Sub/Sib.md".into())
    );
    // `this.up` resolves from `this`, the note that wrote it.
    assert_eq!(
        on(&source, "Capture.md", row, "this.up.asFile().path"),
        Value::String("Sub/Sib.md".into())
    );
}

#[test]
fn links_to_resolves_a_string_from_the_linked_file_and_has_link_from_the_row() {
    let source = relative_vault();
    let row = "Capture.md";
    assert_eq!(
        on(&source, row, row, r#"link("Sub/A").linksTo("./B")"#),
        Value::Boolean(true)
    );
    // Two `B` files, one beside `Sub/A.md` and one at the root, where the
    // base is: `[[./B]]` names `Sub/B.md` only when it is read from the
    // linked file, so ignoring `from` (or reading it from the base) gives
    // the root `B.md`, which `Sub/A.md` does not link to.
    let two_bs = relative_vault().with("B.md", MemoryFile::note());
    assert_eq!(
        on(&two_bs, row, row, r#"link("Sub/A").linksTo("[[./B]]")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&two_bs, row, row, r#"link("Sub/A").linksTo("[[B]]")"#),
        Value::Boolean(false),
        "a bare `B` is the root file, which Sub/A.md does not link to"
    );
    assert_eq!(
        on(&source, "Sub/A.md", row, r#"file.hasLink("./B")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on(&source, "Sub/A.md", row, "file.links[0].asFile().path"),
        Value::String("Sub/B.md".into())
    );
    assert_eq!(
        on(&source, "Sub/B.md", row, "file.backlinks[0].path"),
        Value::String("Sub/A.md".into())
    );
    // From the root, `./B` names nothing.
    assert_eq!(
        on(&source, row, row, r#"link("./B").asFile()"#),
        Value::Null
    );
    // Climbing above the root names nothing.
    assert_eq!(
        on(&source, row, row, r#"link("Sub/A").linksTo("../../B")"#),
        Value::Boolean(false)
    );
}

#[test]
fn a_same_file_link_is_the_note_that_wrote_it() {
    let source = capture_vault(&[]).with("Self.md", MemoryFile::note().link("#Heading"));
    assert_eq!(
        on(&source, "Self.md", "Self.md", "file.links[0].asFile().path"),
        Value::String("Self.md".into())
    );
}

#[test]
fn in_folder_reads_the_folder_as_the_prefilter_does() {
    let inner = "Folder/Deep/Inner.md";
    // The vault root holds every file.
    assert_eq!(on_row(inner, r#"file.inFolder("")"#), Value::Boolean(true));
    assert_eq!(on_row(inner, r#"file.inFolder("/")"#), Value::Boolean(true));
    assert_eq!(
        on_row("Capture.md", r#"file.inFolder("")"#),
        Value::Boolean(true)
    );
    // A leading slash names the same folder.
    assert_eq!(
        on_row(inner, r#"file.inFolder("/Folder")"#),
        Value::Boolean(true)
    );
    assert_eq!(
        on_row(inner, r#"file.inFolder("/Folder/Deep/")"#),
        Value::Boolean(true)
    );
}

#[test]
fn this_carries_the_embedding_files_properties_and_file() {
    let source = capture_vault(&[]);
    let row = "Folder/Deep/Inner.md";
    assert_eq!(
        on(&source, row, "Other.md", "this.status"),
        Value::String("done".into())
    );
    assert_eq!(
        on(&source, row, "Other.md", r#"this["status"]"#),
        Value::String("done".into())
    );
    assert_eq!(on(&source, row, "Other.md", "this.missing"), Value::Null);
    assert_eq!(
        on(&source, row, "Other.md", "this.file"),
        Value::File(VaultPath::new("Other.md").unwrap())
    );
    // The row's own `status` is not `this`'s.
    assert_eq!(
        on(&source, "Other.md", "Capture.md", "this.status"),
        Value::Null
    );
    assert_eq!(
        on(&source, "Other.md", "Capture.md", "status"),
        Value::String("done".into())
    );
    // With no embedding note, `this` is the base, which has no properties.
    let with_base = source.with("Captures.base", MemoryFile::attachment(7));
    assert_eq!(
        on(&with_base, row, "Captures.base", "this.status"),
        Value::Null
    );
    assert_eq!(
        on(&with_base, row, "Captures.base", "this.file.name"),
        Value::String("Captures.base".into())
    );
}

#[test]
fn as_link_shows_the_files_basename() {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let link = on_row("Folder/Deep/Inner.md", "file.asLink()");
    // Off the vault root, the link's own text is the basename: not the path
    // (its target), not the name with its extension.
    let Value::Link(parts) = &link else {
        panic!("a link, not {link:?}")
    };
    assert_eq!(
        parts.display.as_deref(),
        Some(&Value::String("Inner".into()))
    );
    assert_eq!(parts.target, "Folder/Deep/Inner.md");
    assert_eq!(render_text(&link, &clock), "Inner");
    assert_eq!(
        on_row(
            "Folder/Deep/Inner.md",
            r#"file.asLink() == file("Folder/Deep/Inner.md")"#
        ),
        Value::Boolean(true)
    );
    let named = on_row("Folder/Deep/Inner.md", r#"file.asLink("Named")"#);
    assert_eq!(render_text(&named, &clock), "Named");
}

#[test]
fn text_holding_more_than_one_wikilink_or_an_empty_one_stays_text() {
    let props = [
        (
            "two".to_string(),
            PropertyValue::String("[[Other]] and [[Capture]]".into()),
        ),
        ("empty".to_string(), PropertyValue::String("[[]]".into())),
        ("bar".to_string(), PropertyValue::String("[[|x]]".into())),
    ];
    let source = capture_vault(&props);
    let row = "Capture.md";
    for key in ["two", "empty", "bar"] {
        assert_eq!(
            on(&source, row, row, &format!(r#"{key}.isType("string")"#)),
            Value::Boolean(true),
            "{key}"
        );
    }
}
