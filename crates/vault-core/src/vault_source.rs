use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{Diagnostic, DiagnosticCode, Severity, SourceDocument, SourceError, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultListing {
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
}

impl VaultSource for FileSystemVaultSource {
    fn markdown_paths(&self) -> Result<VaultListing, ScanError> {
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

            let file_type = entry.file_type();
            if file_type.is_dir() {
                continue;
            }
            let has_md_extension = entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
            if !has_md_extension {
                continue;
            }
            let Some(vault_path) = self.vault_path_for(entry.path()) else {
                diagnostics.push(Diagnostic::new(
                    DiagnosticCode::UnreadableFile,
                    Severity::Error,
                    format!("{} is not a valid vault path", entry.path().display()),
                ));
                continue;
            };

            if file_type.is_symlink() {
                match self.contained_target(entry.path()) {
                    Ok(Some(target)) if target.is_file() => paths.push(vault_path),
                    Ok(Some(_)) => {}
                    Ok(None) => diagnostics.push(
                        Diagnostic::new(
                            DiagnosticCode::SymlinkOutsideVault,
                            Severity::Warning,
                            format!("{} escapes the vault root", vault_path.as_str()),
                        )
                        .with_path(vault_path),
                    ),
                    Err(error) => diagnostics.push(
                        Diagnostic::new(
                            DiagnosticCode::UnreadableFile,
                            Severity::Error,
                            format!("cannot resolve symlink: {error}"),
                        )
                        .with_path(vault_path),
                    ),
                }
            } else if file_type.is_file() {
                paths.push(vault_path);
            }
        }

        paths.sort();
        paths.dedup();
        Ok(VaultListing { paths, diagnostics })
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
