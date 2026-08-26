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
        reject_if_inside_vault(&index_path, &canonical_vault_root)?;
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path,
            location: IndexLocation::Derived,
        })
    }

    /// Configure an explicit cache path. The path is resolved to an absolute,
    /// lexically-normalized form and rejected if that form sits inside the
    /// vault — but nothing is created here, and nothing on disk is touched:
    /// a path that only *resolves* into the vault through a not-yet-existing
    /// symlink cannot be caught lexically. `prepare_storage` catches that
    /// case once the path can actually be canonicalized.
    pub fn explicit(
        vault_root: impl AsRef<Path>,
        index_path: impl AsRef<Path>,
    ) -> Result<Self, IndexError> {
        let canonical_vault_root = canonical_root(vault_root.as_ref())?;
        let vault_identity = identity_for(&canonical_vault_root);
        let absolute_index_path = lexically_absolute(index_path.as_ref())?;
        reject_if_inside_vault(&absolute_index_path, &canonical_vault_root)?;
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path: absolute_index_path,
            location: IndexLocation::Explicit,
        })
    }

    /// Create the cache's parent directory if needed, then re-validate it
    /// against the vault root after canonicalizing — catching a parent that
    /// resolves into the vault through a symlink the lexical check in
    /// `explicit`/`derived` could not see (because it didn't exist yet). On
    /// success, `index_path` is replaced with `canonical_parent.join(file_name)`,
    /// so every later open works from a fully resolved path.
    ///
    /// Idempotent: calling this again on an already-prepared config
    /// canonicalizes the same directory to itself.
    pub fn prepare_storage(&mut self) -> Result<(), IndexError> {
        let parent = self.index_path.parent().ok_or_else(|| {
            IndexError::InvalidIndexPath("index path has no parent directory".into())
        })?;
        let file_name = self
            .index_path
            .file_name()
            .ok_or_else(|| IndexError::InvalidIndexPath("index path has no file name".into()))?;
        std::fs::create_dir_all(parent)?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| IndexError::Storage(format!("{}: {error}", parent.display())))?;
        reject_if_inside_vault(&canonical_parent, &self.canonical_vault_root)?;
        self.index_path = canonical_parent.join(file_name);
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
