use std::collections::BTreeSet;
use std::fs;

mod common;

use tempfile::TempDir;
use vault_core::{Resolution, Subpath, VaultPath};
use vault_index::{ChangeCause, IndexConfig, IndexService, Mutation, Precondition};

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

/// A base in a folder, linked by filename only, keeps its `view` subpath
/// resolving at the new path after a rename: the link is repaired in the
/// spelling it was written in, and the view still names a view of the moved
/// base, never a heading.
#[test]
fn a_folder_base_renamed_keeps_its_filename_links_and_its_view_subpath() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (path, text) in [
        (
            "Folder/Views.base",
            "views:\n  - type: table\n    name: Table\n",
        ),
        ("Home.md", "![[Views.base#Table]]\n"),
    ] {
        let full = vault.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let root = vault.path().canonicalize().unwrap();
    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();

    let outcome = service
        .apply_mutation(&Mutation::RenameNote {
            from: vp("Folder/Views.base"),
            to: vp("Folder/Renamed.base"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .unwrap();
    let changed: BTreeSet<VaultPath> = outcome.changed_paths;
    service
        .refresh_paths(changed, ChangeCause::Mutation)
        .unwrap();

    assert_eq!(
        fs::read_to_string(root.join("Home.md")).unwrap(),
        "![[Renamed.base#Table]]\n",
        "the link keeps its filename-only spelling and its view subpath"
    );
    let outgoing: Vec<Resolution> = service
        .reader()
        .unwrap()
        .get_note(&vp("Home.md"))
        .unwrap()
        .outgoing
        .into_iter()
        .map(|r| r.resolution)
        .collect();
    assert_eq!(
        outgoing,
        vec![Resolution::Resolved {
            target: vp("Folder/Renamed.base"),
            subpath: Some(Subpath::View("Table".into())),
        }],
        "the view resolves at the new path"
    );
}
