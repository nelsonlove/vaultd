use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::{Diagnostic, DiagnosticCode, Severity, SourceDocument, SourceError, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultListing {
    pub paths: Vec<VaultPath>,
    pub diagnostics: Vec<Diagnostic>,
}

/// What one entry in the vault's file tree is.
///
/// `Note` is exactly what [`VaultListing::paths`] contains — a Markdown file
/// the semantic pipeline parses — so the tree's `Note` rows and the semantic
/// index name the same set of paths by construction.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum TreeEntryKind {
    Folder,
    Note,
    File,
}

impl TreeEntryKind {
    /// The wire spelling the index stores and every consumer matches on.
    pub fn as_str(self) -> &'static str {
        match self {
            TreeEntryKind::Folder => "folder",
            TreeEntryKind::Note => "note",
            TreeEntryKind::File => "file",
        }
    }
}

/// One entry in the vault's file tree: a folder, a note, or any other file.
///
/// Timestamps are Unix milliseconds. `ctime_unix_ms` is the filesystem
/// birthtime where the platform provides one and the modification time as the
/// documented fallback where it does not — a host serving `TFile.stat` needs
/// *a* creation time, and an mtime is a truthful lower bound where no
/// birthtime exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeEntry {
    pub path: VaultPath,
    pub kind: TreeEntryKind,
    /// `None` for folders, whose byte size means nothing.
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
}

/// One walk of the vault, reporting both views it produces.
///
/// `entries` is every non-hidden entry the walk saw; `paths` is the
/// Markdown-only filtered view of exactly the same walk, and `diagnostics`
/// are the Markdown pipeline's own — a non-Markdown entry never contributes
/// a diagnostic, so folding the tree into this walk cannot move a single
/// semantic row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultScan {
    pub entries: Vec<TreeEntry>,
    pub paths: Vec<VaultPath>,
    pub diagnostics: Vec<Diagnostic>,
}

pub trait VaultSource {
    fn markdown_paths(&self) -> Result<VaultListing, ScanError>;
    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError>;
}

#[derive(Clone, Debug)]
pub struct FileSystemVaultSource {
    root: PathBuf,
    canonical_root: PathBuf,
}

impl FileSystemVaultSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ScanError> {
        let root = root.as_ref().to_path_buf();
        let canonical_root = root
            .canonicalize()
            .map_err(|error| ScanError::InaccessibleRoot {
                message: format!("{}: {error}", root.display()),
            })?;
        if !canonical_root.is_dir() {
            return Err(ScanError::InaccessibleRoot {
                message: format!("{} is not a directory", root.display()),
            });
        }
        Ok(Self {
            root,
            canonical_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    fn vault_path_for(&self, absolute: &Path) -> Option<VaultPath> {
        let relative = absolute.strip_prefix(&self.root).ok()?;
        let mut parts = Vec::new();
        for component in relative.components() {
            let text = component.as_os_str().to_str()?;
            parts.push(text);
        }
        VaultPath::new(parts.join("/")).ok()
    }

    /// Canonicalize a candidate file and require its target to stay inside
    /// the canonical vault root. Symlink checks repeat at read time so a
    /// swapped link cannot become an out-of-vault read.
    fn contained_target(&self, absolute: &Path) -> std::io::Result<Option<PathBuf>> {
        let canonical = absolute.canonicalize()?;
        if canonical.starts_with(&self.canonical_root) {
            Ok(Some(canonical))
        } else {
            Ok(None)
        }
    }

    /// Walk the vault once, reporting both the file tree and the
    /// Markdown-only view of the same walk.
    ///
    /// The Markdown half — which paths are included, which diagnostics are
    /// produced, and in what order — is exactly what
    /// [`VaultSource::markdown_paths`] has always produced: a non-Markdown
    /// entry can add a tree entry and nothing else, never a diagnostic and
    /// never a path. That is what makes the tree an addition rather than a
    /// change to the semantic pipeline.
    ///
    /// A tree entry needs `size`/`ctime`/`mtime`, so an entry whose metadata
    /// cannot be read is left out of `entries` — the Markdown view still
    /// includes its path, and the metadata failure surfaces where it always
    /// has, at the point a reader actually needs the file.
    pub fn scan(&self) -> Result<VaultScan, ScanError> {
        self.walk(true)
    }

    /// The shared walk. `collect_tree` decides only whether an entry's
    /// metadata is read and reported: the Markdown half of the result is
    /// identical either way, so a caller that wants only note paths pays
    /// exactly what it always did — no `stat` per entry.
    fn walk(&self, collect_tree: bool) -> Result<VaultScan, ScanError> {
        let mut entries = Vec::new();
        let mut paths = Vec::new();
        let mut diagnostics = Vec::new();

        let walker = walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 || !entry.file_type().is_dir() {
                    return true;
                }
                !entry.file_name().to_string_lossy().starts_with('.')
            });

        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    let error_path = error.path().map(Path::to_path_buf);
                    if error_path.as_deref() == Some(self.root.as_path()) {
                        return Err(ScanError::InaccessibleRoot {
                            message: error.to_string(),
                        });
                    }
                    let diagnostic = Diagnostic::new(
                        DiagnosticCode::UnreadableFile,
                        Severity::Error,
                        error.to_string(),
                    );
                    diagnostics.push(
                        match error_path.as_deref().and_then(|p| self.vault_path_for(p)) {
                            Some(path) => diagnostic.with_path(path),
                            None => diagnostic,
                        },
                    );
                    continue;
                }
            };

            // The root is the tree, not an entry in it: it has no vault path.
            if entry.depth() == 0 {
                continue;
            }

            let file_type = entry.file_type();
            if file_type.is_dir() {
                if collect_tree {
                    if let Some(vault_path) = self.vault_path_for(entry.path()) {
                        push_tree_entry(&mut entries, vault_path, entry.path());
                    }
                }
                continue;
            }

            let has_md_extension = entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
            let Some(vault_path) = self.vault_path_for(entry.path()) else {
                // Markdown-only, exactly as before: an unrepresentable
                // non-Markdown path is skipped in silence rather than
                // becoming a new scan diagnostic.
                if has_md_extension {
                    diagnostics.push(Diagnostic::new(
                        DiagnosticCode::UnreadableFile,
                        Severity::Error,
                        format!("{} is not a valid vault path", entry.path().display()),
                    ));
                }
                continue;
            };

            if file_type.is_symlink() {
                match self.contained_target(entry.path()) {
                    Ok(Some(target)) if target.is_file() => {
                        if has_md_extension {
                            paths.push(vault_path.clone());
                        }
                        if collect_tree {
                            push_tree_entry(&mut entries, vault_path, entry.path());
                        }
                    }
                    // A symlink to a directory inside the vault is not
                    // descended (`follow_links(false)`), so it is not listed
                    // either — a folder row whose contents never appear would
                    // describe a subtree the index does not have.
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        if has_md_extension {
                            diagnostics.push(
                                Diagnostic::new(
                                    DiagnosticCode::SymlinkOutsideVault,
                                    Severity::Warning,
                                    format!("{} escapes the vault root", vault_path.as_str()),
                                )
                                .with_path(vault_path),
                            );
                        }
                    }
                    Err(error) => {
                        if has_md_extension {
                            diagnostics.push(
                                Diagnostic::new(
                                    DiagnosticCode::UnreadableFile,
                                    Severity::Error,
                                    format!("cannot resolve symlink: {error}"),
                                )
                                .with_path(vault_path),
                            );
                        }
                    }
                }
            } else if file_type.is_file() {
                if has_md_extension {
                    paths.push(vault_path.clone());
                }
                if collect_tree {
                    push_tree_entry(&mut entries, vault_path, entry.path());
                }
            }
        }

        paths.sort();
        paths.dedup();
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        entries.dedup_by(|left, right| left.path == right.path);
        Ok(VaultScan {
            entries,
            paths,
            diagnostics,
        })
    }

    /// One path's tree entry as it stands right now, without enumerating
    /// anything: `Ok(None)` means the path is absent, excluded (under a
    /// hidden directory, or a symlink that leaves the vault), or is a
    /// symlinked directory — the same exclusions [`Self::scan`] applies.
    ///
    /// This is the incremental counterpart of `scan`: the targeted
    /// reconciliation path stats exactly the paths a watcher named instead of
    /// walking the vault.
    pub fn tree_entry(&self, path: &VaultPath) -> Result<Option<TreeEntry>, ScanError> {
        if path.is_hidden() {
            return Ok(None);
        }
        let absolute = self.root.join(path.as_str());
        let link_metadata = match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(ScanError::UnreadableFile {
                    path: path.clone(),
                    message: error.to_string(),
                });
            }
        };
        if link_metadata.file_type().is_symlink() {
            let target =
                self.contained_target(&absolute)
                    .map_err(|error| ScanError::UnreadableFile {
                        path: path.clone(),
                        message: error.to_string(),
                    })?;
            match target {
                Some(target) if target.is_file() => {}
                // Escapes the vault, or resolves to a directory the scan
                // never descends: excluded either way.
                _ => return Ok(None),
            }
        }
        let metadata = match std::fs::metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(ScanError::UnreadableFile {
                    path: path.clone(),
                    message: error.to_string(),
                });
            }
        };
        // The lexical half of the rule cannot decide the last component: a
        // hidden *file* is included, a hidden *directory* is not. Now that
        // the entry has been stat-ed, it can be.
        if metadata.is_dir() && path.name().starts_with('.') {
            return Ok(None);
        }
        Ok(tree_entry_from_metadata(path.clone(), &metadata))
    }
}

fn push_tree_entry(entries: &mut Vec<TreeEntry>, path: VaultPath, absolute: &Path) {
    // Follows a symlink deliberately: the size and timestamps a host reports
    // are the target's, and a link whose target escapes the vault has already
    // been excluded above.
    let Ok(metadata) = std::fs::metadata(absolute) else {
        return;
    };
    if let Some(entry) = tree_entry_from_metadata(path, &metadata) {
        entries.push(entry);
    }
}

fn tree_entry_from_metadata(path: VaultPath, metadata: &std::fs::Metadata) -> Option<TreeEntry> {
    let mtime_unix_ms = metadata.modified().ok().map(unix_millis)?;
    // Birthtime where the platform has one, mtime where it does not.
    let ctime_unix_ms = metadata.created().ok().map_or(mtime_unix_ms, unix_millis);
    let is_dir = metadata.is_dir();
    let kind = if is_dir {
        TreeEntryKind::Folder
    } else if path.is_markdown() {
        TreeEntryKind::Note
    } else {
        TreeEntryKind::File
    };
    Some(TreeEntry {
        path,
        kind,
        size: if is_dir { None } else { Some(metadata.len()) },
        ctime_unix_ms,
        mtime_unix_ms,
    })
}

/// Unix milliseconds, saturating rather than failing: a timestamp outside
/// `i64` milliseconds is a broken filesystem clock, not a reason to refuse to
/// index a file.
fn unix_millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(error) => i64::try_from(error.duration().as_millis())
            .map(|millis| -millis)
            .unwrap_or(i64::MIN),
    }
}

impl VaultSource for FileSystemVaultSource {
    /// The Markdown-only view of [`FileSystemVaultSource::scan`].
    fn markdown_paths(&self) -> Result<VaultListing, ScanError> {
        let scan = self.walk(false)?;
        Ok(VaultListing {
            paths: scan.paths,
            diagnostics: scan.diagnostics,
        })
    }

    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError> {
        let absolute = self.root.join(path.as_str());
        let contained =
            self.contained_target(&absolute)
                .map_err(|error| ScanError::UnreadableFile {
                    path: path.clone(),
                    message: error.to_string(),
                })?;
        let Some(target) = contained else {
            return Err(ScanError::UnreadableFile {
                path: path.clone(),
                message: "symlink target escapes the vault root".into(),
            });
        };
        std::fs::read(target).map_err(|error| ScanError::UnreadableFile {
            path: path.clone(),
            message: error.to_string(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct VaultDocuments {
    pub documents: Vec<SourceDocument>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn read_documents(source: &impl VaultSource) -> Result<VaultDocuments, ScanError> {
    let listing = source.markdown_paths()?;
    let mut documents = Vec::with_capacity(listing.paths.len());
    let mut diagnostics = listing.diagnostics;

    for path in listing.paths {
        let bytes = match source.read_bytes(&path) {
            Ok(bytes) => bytes,
            Err(ScanError::UnreadableFile { path, message }) => {
                diagnostics.push(
                    Diagnostic::new(DiagnosticCode::UnreadableFile, Severity::Error, message)
                        .with_path(path),
                );
                continue;
            }
            Err(error @ ScanError::InaccessibleRoot { .. }) => return Err(error),
        };
        match SourceDocument::from_utf8(path.clone(), bytes) {
            Ok(document) => documents.push(document),
            Err(SourceError::InvalidUtf8 { path, error }) => diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::InvalidUtf8,
                    Severity::Error,
                    error.to_string(),
                )
                .with_path(path),
            ),
        }
    }

    Ok(VaultDocuments {
        documents,
        diagnostics,
    })
}

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("vault root is inaccessible: {message}")]
    InaccessibleRoot { message: String },
    #[error("cannot read {path:?}: {message}")]
    UnreadableFile { path: VaultPath, message: String },
}
