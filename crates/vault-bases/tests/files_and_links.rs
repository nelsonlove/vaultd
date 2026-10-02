use vault_bases::eval::{EvalContext, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE, capture_vault, check_family};
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
    assert_eq!(on_row(image, "file.tags"), Value::List(vec![]));
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
fn this_is_the_base_itself_when_nothing_embeds_it() {
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
            while let Value::List(mut items) = value {
                assert_eq!(items.len(), 1);
                value = items.pop().unwrap();
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
