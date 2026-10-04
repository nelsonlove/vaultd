use std::collections::BTreeSet;
use std::fs;

mod common;

use tempfile::TempDir;
use vault_core::{Resolution, Subpath, VaultPath};
use vault_index::{ChangeCause, IndexConfig, IndexService, Mutation, Precondition};

const VIEWS: &str = "views:\n  - type: table\n    name: Table\n  - type: cards\n    name: Cards\n";

struct Fixture {
    service: IndexService,
    root: std::path::PathBuf,
    index: TempDir,
    _vault: TempDir,
}

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn fixture(files: &[(&str, &str)]) -> Fixture {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (path, text) in files {
        let full = vault.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let root = vault.path().canonicalize().unwrap();
    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    Fixture {
        service,
        root,
        index,
        _vault: vault,
    }
}

impl Fixture {
    fn write(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }

    fn touch(&mut self, paths: &[&str]) -> u64 {
        let set: BTreeSet<VaultPath> = paths.iter().map(|p| vp(p)).collect();
        self.service
            .refresh_paths(set, ChangeCause::Watcher)
            .unwrap()
            .generation
            .get()
    }

    fn generation(&self) -> u64 {
        self.service.current_generation().unwrap().unwrap().get()
    }

    fn base_row(&self, path: &str) -> Option<(String, String)> {
        self.service
            .connection_for_test()
            .query_row(
                "SELECT parse_status, view_names_json FROM bases WHERE path = ?1",
                [path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    }

    fn resolution(&self, source: &str, destination: &str) -> Resolution {
        self.service
            .reader()
            .unwrap()
            .resolve_link(&vp(source), destination)
            .unwrap()
            .1
    }

    fn outgoing(&self, path: &str) -> Vec<Resolution> {
        let reader = self.service.reader().unwrap();
        reader
            .get_note(&vp(path))
            .unwrap()
            .outgoing
            .into_iter()
            .map(|r| r.resolution)
            .collect()
    }

    fn published_graph(&self) -> std::sync::Arc<vault_index::LiveGraph> {
        self.service
            .reader()
            .unwrap()
            .published_state()
            .unwrap()
            .graph
            .expect("a published graph")
    }

    /// The drift oracle, extended to bases: whatever route brought this
    /// index here, its stored base catalog, its published live graph and a
    /// fresh hydration all equal what a cold build of the same vault holds,
    /// and every note's outgoing answers agree with that cold build.
    fn assert_matches_a_cold_build(&self, after: &str) {
        let index = TempDir::new_in(common::scratch_root()).unwrap();
        let config = IndexConfig::explicit(&self.root, index.path().join("cold.sqlite3")).unwrap();
        let mut cold = IndexService::open(config).unwrap();
        cold.refresh(false).unwrap();

        let rows = common::base_catalog(self.service.connection_for_test());
        let cold_rows = common::base_catalog(cold.connection_for_test());
        assert_eq!(rows, cold_rows, "stored base catalog drifted after {after}");

        let published = self.published_graph();
        let cold_graph = cold
            .reader()
            .unwrap()
            .published_state()
            .unwrap()
            .graph
            .expect("a cold graph");
        common::assert_base_graphs_equal(&published, &cold_graph);
        common::assert_base_graph_matches_rows(&published, &rows);

        let hydrated = self.service.hydrate_live_graph().unwrap();
        common::assert_base_graphs_equal(&hydrated, &published);

        let reader = self.service.reader().unwrap();
        let cold_reader = cold.reader().unwrap();
        for path in published.note_paths() {
            let ours: Vec<Resolution> = reader
                .get_note(&path)
                .unwrap()
                .outgoing
                .into_iter()
                .map(|r| r.resolution)
                .collect();
            let theirs: Vec<Resolution> = cold_reader
                .get_note(&path)
                .unwrap()
                .outgoing
                .into_iter()
                .map(|r| r.resolution)
                .collect();
            assert_eq!(ours, theirs, "outgoing of {path:?} drifted after {after}");
        }
        self.service.snapshot_for_test().unwrap_or_else(|error| {
            panic!("stored rows disagree with a rebuild after {after}: {error}")
        });
    }
}

fn resolved(path: &str) -> Resolution {
    Resolution::Resolved {
        target: vp(path),
        subpath: None,
    }
}

fn view(path: &str, name: &str) -> Resolution {
    Resolution::Resolved {
        target: vp(path),
        subpath: Some(Subpath::View(name.into())),
    }
}

#[test]
fn a_cold_build_indexes_bases_with_their_views() {
    let fixture = fixture(&[
        ("Views.base", VIEWS),
        ("Home.md", "![[Views.base#Table]]\n"),
    ]);
    assert_eq!(
        fixture.base_row("Views.base"),
        Some(("parsed".into(), r#"["Table","Cards"]"#.into()))
    );
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![view("Views.base", "Table")]
    );
    assert_eq!(
        fixture.resolution("Home.md", "Views.base"),
        resolved("Views.base")
    );
    fixture.assert_matches_a_cold_build("a cold build");
}

#[test]
fn a_base_create_change_and_delete_each_move_the_generation_on_the_targeted_route() {
    let mut fixture = fixture(&[("Home.md", "![[Views.base#Table]]\n")]);
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
    let start = fixture.generation();

    fixture.write("Views.base", VIEWS);
    assert_eq!(
        fixture.touch(&["Views.base"]),
        start + 1,
        "a created base publishes"
    );
    assert!(fixture.base_row("Views.base").is_some());
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![view("Views.base", "Table")],
        "the incoming reference re-resolved without its source changing"
    );
    fixture.assert_matches_a_cold_build("a targeted create");

    fixture.write("Views.base", "views:\n  - type: table\n    name: Other\n");
    assert_eq!(
        fixture.touch(&["Views.base"]),
        start + 2,
        "a changed base publishes"
    );
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![Resolution::MissingSubpath {
            target: vp("Views.base"),
            subpath: Subpath::View("Table".into())
        }],
        "a view leaving the list moves the answer"
    );
    fixture.assert_matches_a_cold_build("a targeted change");

    assert_eq!(
        fixture.touch(&["Views.base"]),
        start + 2,
        "an unchanged base publishes nothing"
    );

    fs::remove_file(fixture.root.join("Views.base")).unwrap();
    assert_eq!(
        fixture.touch(&["Views.base"]),
        start + 3,
        "a deleted base publishes"
    );
    assert!(fixture.base_row("Views.base").is_none());
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
    fixture.assert_matches_a_cold_build("a targeted delete");
}

#[test]
fn the_complete_route_reconciles_bases_too() {
    let mut fixture = fixture(&[("Views.base", VIEWS), ("Home.md", "[[Views.base]]\n")]);
    let start = fixture.generation();
    fixture.write("Views.base", "views:\n  - type: list\n    name: Only\n");
    let report = fixture.service.refresh(false).unwrap();
    assert_eq!(report.generation.get(), start + 1);
    assert_eq!(fixture.base_row("Views.base").unwrap().1, r#"["Only"]"#);
    fixture.assert_matches_a_cold_build("a dirty-route change");
    let unchanged = fixture.service.refresh(false).unwrap();
    assert_eq!(
        unchanged.generation.get(),
        start + 1,
        "an unchanged base publishes nothing"
    );

    fs::remove_file(fixture.root.join("Views.base")).unwrap();
    let report = fixture.service.refresh(false).unwrap();
    assert_eq!(
        report.generation.get(),
        start + 2,
        "a deleted base publishes"
    );
    assert!(fixture.base_row("Views.base").is_none());
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
    fixture.assert_matches_a_cold_build("a dirty-route delete");

    fixture.write("Views.base", VIEWS);
    let report = fixture.service.refresh(true).unwrap();
    assert_eq!(
        report.generation.get(),
        start + 3,
        "a verified refresh sees a new base"
    );
    assert_eq!(fixture.outgoing("Home.md"), vec![resolved("Views.base")]);
    fixture.assert_matches_a_cold_build("a verified create");
}

#[test]
fn the_warm_complete_route_reconciles_bases_too() {
    let mut fixture = fixture(&[
        ("Views.base", VIEWS),
        ("Gone.base", VIEWS),
        ("Home.md", "![[Views.base#Cards]]\n![[Gone.base#Table]]\n"),
    ]);
    let start = fixture.generation();
    fixture.write("Views.base", "views:\n  - type: list\n    name: Only\n");
    fs::remove_file(fixture.root.join("Gone.base")).unwrap();
    let report = fixture.service.refresh_complete_for_test(false).unwrap();
    assert_eq!(report.generation.get(), start + 1);
    assert_eq!(fixture.base_row("Views.base").unwrap().1, r#"["Only"]"#);
    assert!(fixture.base_row("Gone.base").is_none());
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![
            Resolution::MissingSubpath {
                target: vp("Views.base"),
                subpath: Subpath::View("Cards".into())
            },
            Resolution::Unresolved
        ]
    );
    fixture.assert_matches_a_cold_build("a warm complete refresh");
    let unchanged = fixture.service.refresh_complete_for_test(false).unwrap();
    assert_eq!(
        unchanged.generation.get(),
        start + 1,
        "nothing moved, nothing publishes"
    );
}

#[test]
fn parse_diagnostics_appear_and_clear() {
    let mut fixture = fixture(&[("Broken.base", "views: [unclosed\n")]);
    assert_eq!(fixture.base_row("Broken.base").unwrap().0, "parse_failed");
    let reader = fixture.service.reader().unwrap();
    let page = reader
        .get_diagnostics(Some(&vp("Broken.base")), None, None, None)
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0].code,
        vault_core::DiagnosticCode::MalformedBase
    );
    assert!(page.items[0].span.is_some(), "the YAML position travels");
    assert_eq!(
        fixture.resolution("Broken.base", "Broken.base"),
        resolved("Broken.base"),
        "a broken base still resolves"
    );
    fixture.assert_matches_a_cold_build("a malformed cold build");

    fixture.write("Broken.base", VIEWS);
    fixture.touch(&["Broken.base"]);
    let reader = fixture.service.reader().unwrap();
    assert!(
        reader
            .get_diagnostics(Some(&vp("Broken.base")), None, None, None)
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(fixture.base_row("Broken.base").unwrap().0, "parsed");
    fixture.assert_matches_a_cold_build("a fix");

    fixture.write("Broken.base", "views: [unclosed\n");
    fixture.touch(&["Broken.base"]);
    assert_eq!(fixture.base_row("Broken.base").unwrap().0, "parse_failed");
    fixture.assert_matches_a_cold_build("a breakage on the targeted route");
}

#[test]
fn hydration_restores_the_parsed_base_without_reading_the_vault() {
    let fixture = fixture(&[("Views.base", VIEWS)]);
    let root = fixture.root.clone();
    let index_path = fixture.index.path().join("index.sqlite3");
    let Fixture {
        service,
        index: _index,
        _vault,
        ..
    } = fixture;
    drop(service);
    // The vault copy of the base is replaced with garbage: a restart that
    // re-read it would index a parse failure; one that hydrates does not.
    fs::write(root.join("Views.base"), "garbage: [").unwrap();
    let config = IndexConfig::explicit(&root, &index_path).unwrap();
    let reopened = IndexService::open(config).unwrap();
    let state = reopened.reader().unwrap().published_state().unwrap();
    let graph = state.graph.expect("a hydrated graph");
    let record = graph
        .base(&vp("Views.base"))
        .expect("the base is in the graph");
    assert_eq!(record.views, vec!["Table".to_string(), "Cards".to_string()]);
    assert!(record.file.is_some());
}

#[test]
fn renaming_a_base_repairs_the_links_to_it() {
    let mut fixture = fixture(&[
        ("Views.base", VIEWS),
        ("Home.md", "![[Views.base#Table]]\n"),
    ]);
    let start = fixture.generation();
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: vp("Views.base"),
            to: vp("Renamed.base"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .unwrap();
    // The daemon's coordinator reconciles a mutation by handing its changed
    // paths to the targeted route; `apply_mutation` alone publishes nothing.
    let report = fixture
        .service
        .refresh_paths(outcome.changed_paths, ChangeCause::Mutation)
        .unwrap();
    assert_eq!(
        report.generation.get(),
        start + 1,
        "one rename, one generation"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("Home.md")).unwrap(),
        "![[Renamed.base#Table]]\n"
    );
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![view("Renamed.base", "Table")]
    );
    assert!(fixture.base_row("Views.base").is_none());
    assert!(fixture.base_row("Renamed.base").is_some());
    let graph = fixture.published_graph();
    assert!(graph.base(&vp("Views.base")).is_none());
    assert_eq!(
        graph.base(&vp("Renamed.base")).expect("moved base").views,
        vec!["Table".to_string(), "Cards".to_string()],
        "the moved base keeps its views in the live graph"
    );
    fixture.assert_matches_a_cold_build("a base rename");
}

#[test]
fn a_hidden_base_is_never_indexed() {
    let mut fixture = fixture(&[(".trash/Old.base", VIEWS)]);
    assert!(fixture.base_row(".trash/Old.base").is_none());
    let start = fixture.generation();
    fixture.write(
        ".trash/Old.base",
        "views:\n  - type: table\n    name: Other\n",
    );
    assert_eq!(
        fixture.touch(&[".trash/Old.base"]),
        start,
        "a hint naming a hidden base is refused"
    );
    assert!(fixture.base_row(".trash/Old.base").is_none());
}

/// The post-move catalog holds the vault's other bases: renaming a base onto
/// a name another base already carries must not leave its embed on a
/// spelling that the post-move vault reads as ambiguous.
#[test]
fn renaming_a_base_onto_a_shared_name_keeps_the_embed_on_the_moved_base() {
    let mut fixture = fixture(&[
        ("Views.base", VIEWS),
        ("Sub/Keep.md", ""),
        (
            "Archive/Renamed.base",
            "views:\n  - type: table\n    name: Old\n",
        ),
        ("Home.md", "![[Views.base#Table]]\n"),
    ]);
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: vp("Views.base"),
            to: vp("Sub/Renamed.base"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .unwrap();
    fixture
        .service
        .refresh_paths(outcome.changed_paths, ChangeCause::Mutation)
        .unwrap();
    let text = fs::read_to_string(fixture.root.join("Home.md")).unwrap();
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![view("Sub/Renamed.base", "Table")],
        "the rewritten embed {text:?} must reach the moved base and its view"
    );
    fixture.assert_matches_a_cold_build("a rename onto a shared base name");
}

/// A folder named like a base is a folder: the walk never lists it as a base,
/// so a hint naming it must not index one — and a stale row for a base that
/// became a folder of that name is removed.
#[test]
fn a_hinted_folder_named_like_a_base_is_never_indexed() {
    let mut fixture = fixture(&[
        ("Projects.base/Inside.md", "inside\n"),
        ("Views.base", VIEWS),
        ("Home.md", "[[Projects.base]]\n![[Views.base#Table]]\n"),
    ]);
    assert!(fixture.base_row("Projects.base").is_none());
    let start = fixture.generation();
    assert_eq!(
        fixture.touch(&["Projects.base", "Projects.base/Inside.md"]),
        start,
        "re-observing an unchanged folder publishes nothing"
    );
    assert!(fixture.base_row("Projects.base").is_none());
    fixture.assert_matches_a_cold_build("a hinted folder named like a base");

    fs::remove_file(fixture.root.join("Views.base")).unwrap();
    fs::create_dir(fixture.root.join("Views.base")).unwrap();
    fixture.write("Views.base/Note.md", "note\n");
    fixture.touch(&["Views.base", "Views.base/Note.md"]);
    assert!(
        fixture.base_row("Views.base").is_none(),
        "a base that became a folder leaves the bases table"
    );
    assert!(fixture.published_graph().base(&vp("Views.base")).is_none());
    fixture.assert_matches_a_cold_build("a base replaced by a folder of its name");
}

/// A symlink is excluded from the walk; one whose target leaves the vault
/// must not become a base through a hint either.
#[cfg(unix)]
#[test]
fn a_hinted_symlink_base_is_never_indexed() {
    let mut fixture = fixture(&[("Home.md", "![[Out.base#Table]]\n")]);
    let outside = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(outside.path().join("Target.base"), VIEWS).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("Target.base"),
        fixture.root.join("Out.base"),
    )
    .unwrap();
    fixture.touch(&["Out.base"]);
    assert!(fixture.base_row("Out.base").is_none());
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
    fixture.assert_matches_a_cold_build("a hinted symlink to a base outside the vault");
}

/// An unreadable base is stored with no bytes; its revision must still never
/// equal an empty base's, or a change between the two would never publish.
#[test]
fn an_unreadable_base_never_shares_the_empty_bases_revision() {
    let mut fixture = fixture(&[("Empty.base", "")]);
    assert_eq!(
        fixture.base_row("Empty.base"),
        Some(("parsed".into(), "[]".into()))
    );
    let start = fixture.generation();

    fs::write(fixture.root.join("Empty.base"), [0xff_u8, 0xfe, 0xfd]).unwrap();
    assert_eq!(
        fixture.touch(&["Empty.base"]),
        start + 1,
        "empty to non-UTF-8 publishes"
    );
    assert_eq!(fixture.base_row("Empty.base").unwrap().0, "parse_failed");
    fixture.assert_matches_a_cold_build("an empty base turned non-UTF-8");

    fixture.write("Empty.base", "");
    assert_eq!(
        fixture.touch(&["Empty.base"]),
        start + 2,
        "non-UTF-8 to empty publishes"
    );
    assert_eq!(fixture.base_row("Empty.base").unwrap().0, "parsed");
    fixture.assert_matches_a_cold_build("a non-UTF-8 base emptied");
}

/// A row written by another parser generation is answered by this parser on
/// hydration, whatever its stored status says, and re-read on the next
/// refresh so the row itself catches up.
#[test]
fn a_row_from_another_parser_generation_is_reparsed() {
    let fixture = fixture(&[
        ("Views.base", VIEWS),
        ("Home.md", "![[Views.base#Cards]]\n"),
    ]);
    fixture
        .service
        .connection_for_test()
        .execute(
            "UPDATE bases SET content_revision = 'vault-bases/0.0.0#0 blake3:old', \
             parse_status = 'parse_failed', view_names_json = '[]', \
             diagnostics_json = '[{\"code\":\"malformed_base\",\"severity\":\"warning\",\
             \"message\":\"base failed to parse: old parser\",\"span_start\":null,\"span_end\":null}]' \
             WHERE path = 'Views.base'",
            [],
        )
        .unwrap();
    let root = fixture.root.clone();
    let index_path = fixture.index.path().join("index.sqlite3");
    let Fixture {
        service,
        index,
        _vault,
        ..
    } = fixture;
    drop(service);

    let config = IndexConfig::explicit(&root, &index_path).unwrap();
    let mut reopened = IndexService::open(config).unwrap();
    let graph = reopened
        .reader()
        .unwrap()
        .published_state()
        .unwrap()
        .graph
        .expect("a hydrated graph");
    let record = graph.base(&vp("Views.base")).expect("hydrated base");
    assert!(
        record.error.is_none(),
        "the current parser answers the stale row"
    );
    assert_eq!(record.views, vec!["Table".to_string(), "Cards".to_string()]);
    drop(graph);

    let before = reopened.current_generation().unwrap().unwrap().get();
    let report = reopened.refresh(false).unwrap();
    assert_eq!(
        report.generation.get(),
        before + 1,
        "the stale row is re-read and rewritten"
    );
    let fixture = Fixture {
        service: reopened,
        root,
        index,
        _vault,
    };
    assert_eq!(
        fixture.base_row("Views.base"),
        Some(("parsed".into(), r#"["Table","Cards"]"#.into()))
    );
    fixture.assert_matches_a_cold_build("a stale parser generation re-read");
}

/// A writer that already published the same base change wins the
/// compare-and-swap; the retry must find nothing left to publish rather than
/// publish a generation that changes no row.
#[test]
fn a_lost_compare_and_swap_to_the_same_base_change_publishes_no_extra_generation() {
    let mut fixture = fixture(&[("Views.base", VIEWS), ("Home.md", "![[Views.base#Only]]\n")]);
    let start = fixture.generation();
    let index_path = fixture.index.path().join("index.sqlite3");
    // The foreign writer: a second service on the same cache, as another
    // process would be (no lease, so the compare-and-swap is what decides).
    let foreign = IndexService::open_unleased_for_cas_test(
        IndexConfig::explicit(&fixture.root, &index_path).unwrap(),
    )
    .unwrap();
    fixture.write("Views.base", "views:\n  - type: list\n    name: Only\n");

    // The changed file's tree row lands first, copied from a cold build of
    // the changed vault, so this cycle's own tree observation agrees with it
    // and the base delta is the only thing this cycle has left to move.
    let cold_dir = TempDir::new_in(common::scratch_root()).unwrap();
    let cold_path = cold_dir.path().join("cold.sqlite3");
    {
        let config = IndexConfig::explicit(&fixture.root, &cold_path).unwrap();
        let mut cold = IndexService::open(config).unwrap();
        cold.refresh(false).unwrap();
    }
    {
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute("ATTACH DATABASE ?1 AS cold", [cold_path.to_str().unwrap()])
            .unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO main.tree_entries SELECT * FROM cold.tree_entries \
                 WHERE path = 'Views.base'",
                [],
            )
            .unwrap();
    }

    let foreign = std::sync::Mutex::new(foreign);
    let thefts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&thefts);
    fixture.service.install_test_hook(common::once_at(
        vault_index::HookPoint::BeforeDeltaPublication,
        move || {
            let paths: BTreeSet<VaultPath> = [vp("Views.base")].into_iter().collect();
            foreign
                .lock()
                .unwrap()
                .refresh_paths(paths, ChangeCause::Watcher)
                .unwrap();
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        },
    ));

    let generation = fixture.touch(&["Views.base"]);
    assert_eq!(
        thefts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the race must have fired"
    );
    assert_eq!(
        generation,
        start + 1,
        "the foreign writer's generation is the only one: the retry had nothing left"
    );
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![view("Views.base", "Only")]
    );
    fixture.assert_matches_a_cold_build("a compare-and-swap lost to the same base change");
}

/// A base is something the index parses, so a mutation that moves one is
/// semantic; an attachment is not, and a base in a hidden folder is never
/// indexed.
#[test]
fn a_mutation_that_moves_a_base_is_semantic() {
    let mut fixture = fixture(&[
        ("Views.base", VIEWS),
        ("image.png", "png"),
        (".hidden/keep.txt", ""),
    ]);
    let written = fixture
        .service
        .apply_mutation(&Mutation::WriteFile {
            path: vp("New.base"),
            content: VIEWS.as_bytes().to_vec(),
            expected: Precondition::Absent,
        })
        .unwrap();
    assert!(written.semantic, "writing a base is semantic");
    let hidden = fixture
        .service
        .apply_mutation(&Mutation::WriteFile {
            path: vp(".hidden/Secret.base"),
            content: VIEWS.as_bytes().to_vec(),
            expected: Precondition::Absent,
        })
        .unwrap();
    assert!(!hidden.semantic, "a base the scan never lists is not");
    let renamed = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: vp("Views.base"),
            to: vp("Moved.base"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .unwrap();
    assert!(renamed.semantic, "renaming a base is semantic");
    let deleted = fixture
        .service
        .apply_mutation(&Mutation::DeleteNote {
            path: vp("Moved.base"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .unwrap();
    assert!(deleted.semantic, "deleting a base is semantic");
    let attachment = fixture
        .service
        .apply_mutation(&Mutation::DeleteNote {
            path: vp("image.png"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .unwrap();
    assert!(!attachment.semantic, "an attachment is still not semantic");
    let mut changed: BTreeSet<VaultPath> = written.changed_paths;
    changed.extend(renamed.changed_paths);
    changed.extend(deleted.changed_paths);
    changed.extend(attachment.changed_paths);
    fixture
        .service
        .refresh_paths(changed, ChangeCause::Mutation)
        .unwrap();
    fixture.assert_matches_a_cold_build("base mutations");
}
