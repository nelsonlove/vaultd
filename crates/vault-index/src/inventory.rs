use std::collections::BTreeMap;
use std::path::Path;

use vault_core::{
    Diagnostic, DiagnosticCode, FileSystemVaultSource, ScanError, Severity, TreeEntry, VaultPath,
    VaultSource as _,
};

use crate::error::IndexError;
use crate::model::FileFingerprint;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventoryEntry {
    pub path: VaultPath,
    pub fingerprint: FileFingerprint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventorySnapshot {
    pub entries: BTreeMap<VaultPath, FileFingerprint>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `Send`, because the writer that owns a source is moved onto the runtime's
/// own thread while readers answer from another.
pub trait ReconcileSource: Send {
    fn canonical_root(&self) -> &Path;
    fn inventory(&self) -> Result<InventorySnapshot, IndexError>;
    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError>;
    /// One path's fingerprint, without enumerating anything. `Ok(None)` means
    /// the path is absent — and *only* that. Every other metadata failure is
    /// an error, which the incremental engine turns into the same
    /// `UnreadableFile` diagnostic the complete path produces, rather than
    /// silently mistaking an unreadable file for a deleted one.
    ///
    /// Deliberately has no default implementation: a source that forgot to
    /// implement it would answer "absent" for every path, and the incremental
    /// engine would delete the whole vault from the cache.
    fn fingerprint(&self, path: &VaultPath) -> Result<Option<FileFingerprint>, IndexError>;

    /// Whether this source observes the vault's file tree at all.
    ///
    /// Defaults to `false`, and every tree write is gated on it, so a source
    /// that models only note content (the test doubles) leaves `tree_entries`
    /// exactly as it found it rather than reporting an empty vault and having
    /// the tree deleted underneath it.
    fn observes_tree(&self) -> bool {
        false
    }

    /// One walk producing both products: the note inventory and the file tree
    /// the same walk saw. The default runs the inventory alone and reports no
    /// tree, which is what `observes_tree` already says about such a source.
    ///
    /// A single method rather than two because they are one walk: taking the
    /// tree separately would double a cold build's directory traversal.
    fn inventory_and_tree(&self) -> Result<(InventorySnapshot, Vec<TreeEntry>), IndexError> {
        Ok((self.inventory()?, Vec::new()))
    }

    /// One path's tree entry as it stands right now, without enumerating
    /// anything. `Ok(None)` means absent or excluded; a source that observes
    /// no tree always answers `None` and is never asked.
    fn tree_entry(&self, _path: &VaultPath) -> Result<Option<TreeEntry>, IndexError> {
        Ok(None)
    }
}

pub struct FileSystemIndexSource {
    source: FileSystemVaultSource,
}

impl FileSystemIndexSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, IndexError> {
        let source = FileSystemVaultSource::new(root).map_err(|error| match error {
            ScanError::InaccessibleRoot { message } => IndexError::InvalidVaultRoot(message),
            ScanError::UnreadableFile { path, message } => {
                IndexError::InvalidVaultRoot(format!("{}: {message}", path.as_str()))
            }
        })?;
        Ok(Self { source })
    }
}

impl ReconcileSource for FileSystemIndexSource {
    fn canonical_root(&self) -> &Path {
        self.source.canonical_root()
    }

    /// List Markdown paths through the core source (so the hidden-directory
    /// and symlink policy stays single-sourced) and record only lightweight
    /// path/size/mtime fingerprints. Never reads a note body, and never
    /// collects tree metadata — see `inventory_and_tree` for the walk that
    /// does both.
    fn inventory(&self) -> Result<InventorySnapshot, IndexError> {
        let listing = self.source.markdown_paths().map_err(|error| match error {
            ScanError::InaccessibleRoot { message } => IndexError::InvalidVaultRoot(message),
            other => IndexError::Storage(other.to_string()),
        })?;
        self.fingerprint_listing(listing.paths, listing.diagnostics)
    }

    fn observes_tree(&self) -> bool {
        true
    }

    fn inventory_and_tree(&self) -> Result<(InventorySnapshot, Vec<TreeEntry>), IndexError> {
        let scan = self.source.scan().map_err(|error| match error {
            ScanError::InaccessibleRoot { message } => IndexError::InvalidVaultRoot(message),
            other => IndexError::Storage(other.to_string()),
        })?;
        let snapshot = self.fingerprint_listing(scan.paths, scan.diagnostics)?;
        Ok((snapshot, scan.entries))
    }

    fn tree_entry(&self, path: &VaultPath) -> Result<Option<TreeEntry>, IndexError> {
        self.source.tree_entry(path).map_err(|error| match error {
            ScanError::InaccessibleRoot { message } => IndexError::InvalidVaultRoot(message),
            ScanError::UnreadableFile { path, message } => IndexError::Storage(format!(
                "cannot read metadata for {}: {message}",
                path.as_str()
            )),
        })
    }

    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError> {
        self.source.read_bytes(path)
    }

    fn fingerprint(&self, path: &VaultPath) -> Result<Option<FileFingerprint>, IndexError> {
        match std::fs::metadata(self.source.root().join(path.as_str())) {
            Ok(metadata) => {
                let modified = filetime::FileTime::from_last_modification_time(&metadata);
                Ok(Some(FileFingerprint {
                    size: metadata.len(),
                    modified_seconds: modified.unix_seconds(),
                    modified_nanos: modified.nanoseconds(),
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(IndexError::Storage(format!(
                "cannot read metadata for {}: {error}",
                path.as_str()
            ))),
        }
    }
}

impl FileSystemIndexSource {
    /// Fingerprint exactly the Markdown paths a walk reported. Its own
    /// `metadata` call per note, deliberately separate from the tree's: the
    /// fingerprint is the semantic pipeline's change detector and keeps the
    /// exact shape and failure diagnostics it always had.
    fn fingerprint_listing(
        &self,
        paths: Vec<VaultPath>,
        diagnostics: Vec<Diagnostic>,
    ) -> Result<InventorySnapshot, IndexError> {
        let mut entries = BTreeMap::new();
        let mut diagnostics = diagnostics;
        for path in paths {
            match std::fs::metadata(self.source.root().join(path.as_str())) {
                Ok(metadata) => {
                    let modified = filetime::FileTime::from_last_modification_time(&metadata);
                    entries.insert(
                        path,
                        FileFingerprint {
                            size: metadata.len(),
                            modified_seconds: modified.unix_seconds(),
                            modified_nanos: modified.nanoseconds(),
                        },
                    );
                }
                Err(error) => diagnostics.push(
                    Diagnostic::new(
                        DiagnosticCode::UnreadableFile,
                        Severity::Error,
                        format!("cannot read metadata: {error}"),
                    )
                    .with_path(path),
                ),
            }
        }
        diagnostics.sort_by(|a, b| {
            (&a.path, a.span, a.code, &a.message).cmp(&(&b.path, b.span, b.code, &b.message))
        });
        Ok(InventorySnapshot {
            entries,
            diagnostics,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    use super::{InventorySnapshot, ReconcileSource};
    use vault_core::{ScanError, VaultPath};

    struct CountingSource {
        root: PathBuf,
        inventories: Cell<u64>,
        body_reads: Cell<u64>,
    }

    impl ReconcileSource for CountingSource {
        fn canonical_root(&self) -> &Path {
            &self.root
        }

        fn inventory(&self) -> Result<InventorySnapshot, crate::IndexError> {
            self.inventories.set(self.inventories.get() + 1);
            Ok(InventorySnapshot {
                entries: Default::default(),
                diagnostics: Vec::new(),
            })
        }

        fn read_bytes(&self, _path: &VaultPath) -> Result<Vec<u8>, ScanError> {
            self.body_reads.set(self.body_reads.get() + 1);
            Ok(Vec::new())
        }

        fn fingerprint(
            &self,
            _path: &VaultPath,
        ) -> Result<Option<crate::model::FileFingerprint>, crate::IndexError> {
            Ok(None)
        }
    }

    #[test]
    fn taking_inventories_never_reads_note_bodies() {
        let source = CountingSource {
            root: PathBuf::from("/"),
            inventories: Cell::new(0),
            body_reads: Cell::new(0),
        };

        source.inventory().expect("first inventory");
        source.inventory().expect("second inventory");

        assert_eq!(source.inventories.get(), 2);
        assert_eq!(source.body_reads.get(), 0);
    }
}
