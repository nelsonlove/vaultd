use std::path::{Component, Path, PathBuf};

use crate::error::IndexError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexLocation {
    Derived,
    Explicit,
}

#[derive(Clone, Debug)]
pub struct IndexConfig {
    pub canonical_vault_root: PathBuf,
    pub vault_identity: String,
    pub index_path: PathBuf,
    pub location: IndexLocation,
}

impl IndexConfig {
    pub fn derived(vault_root: impl AsRef<Path>) -> Result<Self, IndexError> {
        let canonical_vault_root = canonical_root(vault_root.as_ref())?;
        let vault_identity = identity_for(&canonical_vault_root);
        let xdg = xdg::BaseDirectories::with_prefix("vaultd");
        let index_path = xdg
            .get_cache_file(format!("vaults/{vault_identity}/semantic-v1.sqlite3"))
            .ok_or_else(|| {
                IndexError::Storage("cannot determine the XDG cache directory".into())
            })?;
        let resolved_index_path = resolve_against_existing_ancestor(&index_path)?;
        reject_if_inside_vault(&resolved_index_path, &canonical_vault_root)?;
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path: resolved_index_path,
            location: IndexLocation::Derived,
        })
    }

    /// Configure an explicit cache path. The path is resolved against its
    /// deepest *existing* ancestor — canonicalizing that ancestor, then
    /// reattaching whatever tail doesn't exist yet — and rejected if the
    /// result sits inside the vault. Comparing canonical-to-canonical this
    /// way (rather than a purely lexical comparison against the canonical
    /// vault root) is what catches a vault root reached through a symlinked
    /// ancestor, which is every macOS temp directory (`/tmp` ->
    /// `/private/tmp`): a lexical index path built from that same
    /// non-canonical prefix would otherwise never appear to start with the
    /// canonicalized vault root. Nothing is created here, and nothing on
    /// disk is touched — a symlink planted *after* this call, or a final
    /// component that is itself a not-yet-resolvable symlink, cannot be
    /// caught here; `prepare_storage` re-checks both once the path can
    /// actually be walked.
    pub fn explicit(
        vault_root: impl AsRef<Path>,
        index_path: impl AsRef<Path>,
    ) -> Result<Self, IndexError> {
        let canonical_vault_root = canonical_root(vault_root.as_ref())?;
        let vault_identity = identity_for(&canonical_vault_root);
        let resolved_index_path = resolve_against_existing_ancestor(index_path.as_ref())?;
        reject_if_inside_vault(&resolved_index_path, &canonical_vault_root)?;
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path: resolved_index_path,
            location: IndexLocation::Explicit,
        })
    }

    /// Create the cache's parent directory, validating before *and* after.
    ///
    /// The pre-check resolves the projected parent against its deepest
    /// existing ancestor (the same technique `explicit`/`derived` use) and
    /// refuses before `create_dir_all` runs — otherwise a symlink planted
    /// between construction and this call redirects that very call into
    /// creating directories inside the vault before anything notices. The
    /// post-check re-canonicalizes the now-created parent (catching any
    /// remaining race) and, finally, canonicalizes the full index path
    /// itself: the final component can be a symlink into the vault that
    /// only resolves once its target exists, which the parent-only checks
    /// above cannot see. A final component that still doesn't resolve (a
    /// symlink dangling because nothing has created its target yet) is left
    /// alone here — there is nothing to canonicalize yet — but it can never
    /// silently point past this into the vault: `IndexStore::open` performs
    /// no filesystem creation of its own beyond what `prepare_storage`
    /// already validated, so a dangling symlink here is refused the moment
    /// SQLite (or a repeat `prepare_storage`) makes it resolvable, before it
    /// is ever written through.
    ///
    /// Idempotent: calling this again on an already-prepared config
    /// canonicalizes the same directory (and file, if it now exists) to
    /// itself.
    pub fn prepare_storage(&mut self) -> Result<(), IndexError> {
        let file_name = self
            .index_path
            .file_name()
            .ok_or_else(|| IndexError::InvalidIndexPath("index path has no file name".into()))?
            .to_os_string();
        let parent = self
            .index_path
            .parent()
            .ok_or_else(|| {
                IndexError::InvalidIndexPath("index path has no parent directory".into())
            })?
            .to_path_buf();

        let projected_parent = resolve_against_existing_ancestor(&parent)?;
        reject_if_inside_vault(&projected_parent, &self.canonical_vault_root)?;

        std::fs::create_dir_all(&parent)?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| IndexError::Storage(format!("{}: {error}", parent.display())))?;
        reject_if_inside_vault(&canonical_parent, &self.canonical_vault_root)?;
        self.index_path = canonical_parent.join(&file_name);

        if let Ok(canonical_file) = self.index_path.canonicalize() {
            reject_if_inside_vault(&canonical_file, &self.canonical_vault_root)?;
        }

        Ok(())
    }

    /// The sibling lease file this cache's writer lock lives in:
    /// `index.sqlite3` becomes `index.sqlite3.lock`. Built with an `OsString`
    /// suffix append rather than `Path::with_extension`, which would replace
    /// `index.sqlite3`'s existing `.sqlite3` extension instead of appending.
    pub fn lease_path(&self) -> PathBuf {
        let mut file_name = self
            .index_path
            .file_name()
            .unwrap_or_default()
            .to_os_string();
        file_name.push(".lock");
        self.index_path.with_file_name(file_name)
    }
}

/// Reject an index path that sits inside the vault root, lexically or (once
/// canonicalized) via symlink. The vault filesystem is authoritative,
/// read-only production input; it is never a valid location for derived
/// storage.
fn reject_if_inside_vault(
    index_path: &Path,
    canonical_vault_root: &Path,
) -> Result<(), IndexError> {
    if index_path.starts_with(canonical_vault_root) {
        return Err(IndexError::InvalidIndexPath(format!(
            "{} is inside the vault root {}",
            index_path.display(),
            canonical_vault_root.display()
        )));
    }
    Ok(())
}

/// Resolve `path` to a canonical-as-far-as-possible absolute form: make it
/// lexically absolute (join-with-cwd plus `.`/`..` normalization, touching
/// no filesystem state), then walk upward to the deepest ancestor that
/// actually exists, canonicalize *that* (resolving every symlink in it,
/// including one the vault root itself traverses), and reattach whatever
/// tail doesn't exist yet, unchanged.
///
/// This is the one place a not-yet-fully-materialized index path gets
/// compared apples-to-apples against a canonical vault root: canonicalizing
/// only the vault root (as a lexical comparison against the index path
/// would) misses a shared symlinked ancestor entirely, because the index
/// path keeps the non-canonical prefix while the vault root does not.
fn resolve_against_existing_ancestor(path: &Path) -> Result<PathBuf, IndexError> {
    let absolute = lexically_absolute(path)?;
    let mut existing = absolute.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                existing.pop();
            }
            // Reached the filesystem root without finding anything that
            // exists — nothing left to pop. `canonicalize` below will
            // surface the underlying I/O error.
            None => break,
        }
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|error| IndexError::Storage(format!("{}: {error}", existing.display())))?;
    let mut resolved = canonical_existing;
    for component in tail.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

/// Make `path` absolute without touching the filesystem: join it to the
/// current directory if relative, then lexically normalize `.` and `..`
/// components. Deliberately does not call `canonicalize` — the final path
/// component (and possibly its parent) need not exist yet.
fn lexically_absolute(path: &Path) -> Result<PathBuf, IndexError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let cwd = std::env::current_dir().map_err(|error| {
            IndexError::Storage(format!("cannot resolve the current directory: {error}"))
        })?;
        cwd.join(path)
    };
    Ok(normalize_lexically(&absolute))
}

/// Collapse `.` and `..` components without consulting the filesystem. `..`
/// pops the previous `Normal` component when there is one; above the root
/// (or with no previous component to pop) it is dropped, since a lexically
/// absolute path can never legitimately go above its own root.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(result.components().next_back(), Some(Component::Normal(_))) {
                    result.pop();
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn canonical_root(root: &Path) -> Result<PathBuf, IndexError> {
    let canonical = root
        .canonicalize()
        .map_err(|error| IndexError::InvalidVaultRoot(format!("{}: {error}", root.display())))?;
    if !canonical.is_dir() {
        return Err(IndexError::InvalidVaultRoot(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    if canonical.to_str().is_none() {
        return Err(IndexError::InvalidVaultRoot(
            "vault root must be valid UTF-8".into(),
        ));
    }
    Ok(canonical)
}

fn identity_for(canonical: &Path) -> String {
    blake3::hash(canonical.to_string_lossy().as_bytes())
        .to_hex()
        .to_string()
}
