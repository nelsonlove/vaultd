//! Pure, filesystem-free path normalization and inclusion filtering.
//!
//! Mirrors `vault_core::FileSystemVaultSource`'s inclusion rules (skip
//! `.obsidian` and other hidden directories) but works lexically on event
//! paths that may no longer exist on disk (the file may already have been
//! deleted by the time the hint is processed).
//!
//! Two views of one rule, exactly as the scan has two views of one walk:
//! [`normalize_included_path`] admits every included entry — folders,
//! attachments, notes — because the file tree indexes all of them, and
//! [`normalize_included_markdown`] is that same answer filtered to `.md`,
//! because the semantic index indexes only those. The hidden-directory,
//! outside-the-root, and `..` rules are shared by construction: the Markdown
//! view is a filter over the general one, not a second copy of it.

use std::path::{Component, Path, PathBuf};

use vault_core::VaultPath;

use crate::WatchError;

/// Normalize a raw watcher event path into an included [`VaultPath`], or
/// `Ok(None)` if the path is outside the vault, hidden, or not a `.md` file.
///
/// Operates purely on the two paths given — no filesystem access, no
/// `canonicalize`, so it works for paths that have already been deleted.
pub fn normalize_included_markdown(
    canonical_root: &Path,
    event_path: &Path,
) -> Result<Option<VaultPath>, WatchError> {
    match normalize_included_path(canonical_root, event_path)? {
        Some(vault_path) if vault_path.is_markdown() => Ok(Some(vault_path)),
        _ => Ok(None),
    }
}

/// Normalize a raw watcher event path into an included [`VaultPath`] of any
/// kind — a folder, an attachment, or a note — or `Ok(None)` if the path is
/// outside the vault or under a hidden directory.
///
/// The tree counterpart of [`normalize_included_markdown`]: same root, hidden,
/// and `..` rules, no extension filter. A directory and a file are
/// indistinguishable here by design — the path may already be gone from disk,
/// so nothing may be asked of the filesystem — and the consumer that stats it
/// is what learns which it was.
pub fn normalize_included_path(
    canonical_root: &Path,
    event_path: &Path,
) -> Result<Option<VaultPath>, WatchError> {
    let normalized_root = lexically_normalize(canonical_root);
    let normalized_event = lexically_normalize(event_path);

    let relative = match normalized_event.strip_prefix(&normalized_root) {
        Ok(relative) => relative,
        Err(_) => return Ok(None),
    };

    let mut parts: Vec<String> = Vec::new();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(part) = component else {
            // Any remaining `.`/`..`/root component here means the lexical
            // normalization above didn't fully resolve inside the root —
            // treat conservatively as "not included" rather than guess.
            return Ok(None);
        };
        let Some(text) = part.to_str() else {
            return Err(WatchError::InvalidPath(event_path.display().to_string()));
        };
        let is_last = components.peek().is_none();
        if !is_last && text.starts_with('.') {
            // Hidden directory component, e.g. `.obsidian` or `.git`.
            return Ok(None);
        }
        parts.push(text.to_string());
    }

    match VaultPath::new(parts.join("/")) {
        Ok(vault_path) => Ok(Some(vault_path)),
        Err(_) => Ok(None),
    }
}

/// Classifies whether an event path is confined entirely under a hidden
/// directory (e.g. `.obsidian/...`) relative to the vault root — the same
/// rule [`normalize_included_markdown`] uses to exclude it, but exposed on
/// its own so a caller can tell "excluded because hidden" apart from
/// "excluded for some other reason" (wrong extension, outside the root,
/// unclassifiable).
///
/// This matters for structural events (folder create/remove/rename) that
/// carry no included `.md` path: churn confined to both sides of a hidden
/// directory can never move content into or out of the indexed view, but
/// churn touching even one path outside hidden territory might.
///
/// Conservatively returns `false` ("not hidden") for anything it can't
/// positively classify as hidden: paths outside the root, and paths whose
/// components can't be read as UTF-8. A caller relying on this to skip a
/// reconcile should treat `false` as "can't rule it out."
pub(crate) fn is_under_hidden_dir(canonical_root: &Path, event_path: &Path) -> bool {
    let normalized_root = lexically_normalize(canonical_root);
    let normalized_event = lexically_normalize(event_path);

    let Ok(relative) = normalized_event.strip_prefix(&normalized_root) else {
        return false;
    };

    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(part) = component else {
            return false;
        };
        let Some(text) = part.to_str() else {
            return false;
        };
        let is_last = components.peek().is_none();
        if !is_last && text.starts_with('.') {
            return true;
        }
    }
    false
}

/// Resolve `.` and `..` components lexically, without touching the
/// filesystem, so it works for paths whose target no longer exists.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(stack.last(), Some(Component::Normal(_))) {
                    stack.pop();
                } else {
                    stack.push(component);
                }
            }
            other => stack.push(other),
        }
    }
    stack.into_iter().collect()
}
