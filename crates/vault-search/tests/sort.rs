use vault_core::VaultPath;
use vault_search::{DocumentKind, FileHit, SortOrder, Times, sort_hits};

fn hit(path: &str) -> FileHit {
    FileHit {
        path: VaultPath::new(path).unwrap(),
        kind: DocumentKind::Note,
        path_matches: vec![],
        content_matches: vec![],
        total_matches: 0,
        matches_truncated: false,
    }
}
fn sorted(paths: &[&str], order: SortOrder, times: &[(&str, i64, i64)]) -> Vec<String> {
    let mut hits: Vec<FileHit> = paths.iter().map(|p| hit(p)).collect();
    let lookup = |path: &VaultPath| {
        let (_, mtime_ms, ctime_ms) = times
            .iter()
            .find(|(p, _, _)| *p == path.as_str())
            .copied()
            .unwrap_or(("", 0, 0));
        Times { mtime_ms, ctime_ms }
    };
    sort_hits(&mut hits, order, &lookup);
    hits.into_iter()
        .map(|h| h.path.as_str().to_string())
        .collect()
}

const NAMES: &[&str] = &[
    "a/Zed.md",
    "Note 10.md",
    "b/zed.md",
    "note 1.md",
    "Note 2.md",
];

#[test]
fn file_name_order_is_locale_compare_numeric_then_path() {
    // P15: vault_bases' localeCompare order, numeric, locale en.
    assert_eq!(
        sorted(NAMES, SortOrder::FileNameAsc, &[]),
        [
            "note 1.md",
            "Note 2.md",
            "Note 10.md",
            "b/zed.md",
            "a/Zed.md"
        ]
    );
    assert_eq!(
        sorted(NAMES, SortOrder::FileNameDesc, &[]),
        [
            "a/Zed.md",
            "b/zed.md",
            "Note 10.md",
            "Note 2.md",
            "note 1.md"
        ]
    );
}

#[test]
fn equal_names_tie_by_path_in_both_directions() {
    let paths = ["y/same.md", "x/same.md"];
    assert_eq!(
        sorted(&paths, SortOrder::FileNameAsc, &[]),
        ["x/same.md", "y/same.md"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::FileNameDesc, &[]),
        ["x/same.md", "y/same.md"]
    );
}

#[test]
fn name_orders_compare_the_base_name_then_the_extension() {
    // P15: the base name without its extension first, so `Note` sorts
    // before `Note 2` although a space sorts before `.`.
    let paths = ["Note 2.md", "Note.md"];
    assert_eq!(
        sorted(&paths, SortOrder::FileNameAsc, &[]),
        ["Note.md", "Note 2.md"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::FileNameDesc, &[]),
        ["Note 2.md", "Note.md"]
    );
    let paths = ["a.png", "a.md"];
    assert_eq!(
        sorted(&paths, SortOrder::FileNameAsc, &[]),
        ["a.md", "a.png"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::FileNameDesc, &[]),
        ["a.png", "a.md"]
    );
}

#[test]
fn time_orders_tie_by_path() {
    let paths = ["p3.md", "p1.md", "p2.md"];
    let times = [("p1.md", 3, 10), ("p2.md", 1, 30), ("p3.md", 3, 20)];
    assert_eq!(
        sorted(&paths, SortOrder::ModifiedDesc, &times),
        ["p1.md", "p3.md", "p2.md"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::ModifiedAsc, &times),
        ["p2.md", "p1.md", "p3.md"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::CreatedDesc, &times),
        ["p2.md", "p3.md", "p1.md"]
    );
    assert_eq!(
        sorted(&paths, SortOrder::CreatedAsc, &times),
        ["p1.md", "p3.md", "p2.md"]
    );
}
