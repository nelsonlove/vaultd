//! The six orders of Obsidian's search results.

use std::cmp::Ordering;

use vault_bases::collate::collate_strictly;
use vault_core::VaultPath;

use crate::document::file_name;
use crate::evaluate::FileHit;

/// Obsidian's sort orders; File name (A to Z) is the default.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SortOrder {
    #[default]
    FileNameAsc,
    FileNameDesc,
    ModifiedDesc,
    ModifiedAsc,
    CreatedDesc,
    CreatedAsc,
}

/// A file's modified and created times, in milliseconds since the epoch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Times {
    pub mtime_ms: i64,
    pub ctime_ms: i64,
}

/// Sorts `hits` in `order`. The name orders compare the base name (the file
/// name without its extension), then the extension, each with the Bases
/// collation (`localeCompare`, numeric, locale `en`; P15); every order breaks
/// ties by path, ascending in both directions.
pub fn sort_hits(hits: &mut [FileHit], order: SortOrder, times: &dyn Fn(&VaultPath) -> Times) {
    let by_path = |a: &FileHit, b: &FileHit| a.path.as_str().cmp(b.path.as_str());
    let by_name = |a: &FileHit, b: &FileHit| {
        let (a_base, a_ext) = split_extension(file_name(&a.path));
        let (b_base, b_ext) = split_extension(file_name(&b.path));
        collate_strictly(a_base, b_base).then_with(|| collate_strictly(a_ext, b_ext))
    };
    let by_time = |a: &FileHit, b: &FileHit, key: fn(Times) -> i64| -> Ordering {
        key(times(&a.path)).cmp(&key(times(&b.path)))
    };
    let mtime: fn(Times) -> i64 = |t| t.mtime_ms;
    let ctime: fn(Times) -> i64 = |t| t.ctime_ms;
    match order {
        SortOrder::FileNameAsc => hits.sort_by(|a, b| by_name(a, b).then_with(|| by_path(a, b))),
        SortOrder::FileNameDesc => hits.sort_by(|a, b| by_name(b, a).then_with(|| by_path(a, b))),
        SortOrder::ModifiedDesc => {
            hits.sort_by(|a, b| by_time(b, a, mtime).then_with(|| by_path(a, b)))
        }
        SortOrder::ModifiedAsc => {
            hits.sort_by(|a, b| by_time(a, b, mtime).then_with(|| by_path(a, b)))
        }
        SortOrder::CreatedDesc => {
            hits.sort_by(|a, b| by_time(b, a, ctime).then_with(|| by_path(a, b)))
        }
        SortOrder::CreatedAsc => {
            hits.sort_by(|a, b| by_time(a, b, ctime).then_with(|| by_path(a, b)))
        }
    }
}

/// A file name's base name and extension, split at its last `.`; a name
/// whose only `.` is its first character (`.hidden`) is all base name.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at + 1..]),
        _ => (name, ""),
    }
}
