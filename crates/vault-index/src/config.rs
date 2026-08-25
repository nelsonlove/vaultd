use std::path::{Path, PathBuf};

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
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path,
            location: IndexLocation::Derived,
        })
    }

    pub fn explicit(
        vault_root: impl AsRef<Path>,
        index_path: impl AsRef<Path>,
    ) -> Result<Self, IndexError> {
        let canonical_vault_root = canonical_root(vault_root.as_ref())?;
        let vault_identity = identity_for(&canonical_vault_root);
        Ok(Self {
            canonical_vault_root,
            vault_identity,
            index_path: index_path.as_ref().to_path_buf(),
            location: IndexLocation::Explicit,
        })
    }
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
