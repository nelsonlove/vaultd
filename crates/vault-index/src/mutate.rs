//! The write path: the one place in `vaultd` that writes into the vault.
//!
//! Three invariants hold for every operation in this module:
//!
//! 1. **Containment.** A target is resolved by canonicalizing its parent
//!    directory (which resolves every symlink in it) and requiring the result
//!    to stay inside the canonical vault root. `VaultPath`'s constructor is
//!    string-level and rejects `..`, absolute paths, and backslashes; that is
//!    necessary and not sufficient, because a symlink is invisible to it.
//! 2. **Preconditions.** A content-bearing mutation compares the caller's
//!    expected revision against the bytes *on disk*, not against the index.
//!    The index can lag the filesystem by a debounce window, and a
//!    compare-and-swap validated against a lagging index would admit exactly
//!    the lost update it exists to prevent.
//! 3. **Atomicity per file.** Every write goes to a temporary file in the
//!    target's own directory, is flushed, and is renamed over the target. A
//!    crash leaves the old bytes or the new bytes, never a torn file.
//!
//! Nothing here knows about protocol types, the coordinator, or generations.

use std::path::{Path, PathBuf};

use vault_core::VaultPath;

/// The largest single raw payload a mutation accepts, in bytes.
///
/// 16 MiB, revised down from the design's 64 MiB draft: base64 over JSON
/// inflates by roughly a third, so 64 MiB of bytes is an ~85 MB single JSON
/// line, which strains a line-delimited reader for no measured benefit. This
/// covers every attachment class in the reference vault. Chunked transfer for
/// larger files is deferred follow-on, and the refusal names it.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// The configuration zone. Raw reads and writes are allowed here; every
/// semantic operation refuses, and nothing in it is ever indexed.
pub const CONFIG_ZONE: &str = ".obsidian";

/// The vault-local trash directory. A dot-directory, and therefore already
/// excluded from scanning and watching by the existing hidden-directory rule
/// in `FileSystemVaultSource::markdown_paths` — stated here rather than
/// assumed, because `trash_local` depends on it.
pub const LOCAL_TRASH: &str = ".trash";

/// The precondition a content-bearing mutation carries.
///
/// The wire's `expected` is `Option<ExpectedDto>` and splits three ways:
/// omitted is unconditional, a present-but-empty object is `invalid_request`,
/// and a one-field object names one of these variants. Only the third shape
/// reaches this type, so the omitted/empty split lives in the protocol
/// conversion and never here — `Any` means "the caller asked for
/// unconditional", however it spelled it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Precondition {
    /// The target must currently hold this revision.
    Revision(String),
    /// The target must not exist.
    Absent,
    /// Unconditional. Allowed, discouraged, and exists for append-style flows
    /// that genuinely do not care.
    Any,
}

/// Why a mutation was refused. Every variant means *nothing changed*.
///
/// The messages spell a `VaultPath` through `as_str`, not through `{path}`:
/// `VaultPath` has no `Display` impl, and its `Debug` spelling
/// (`VaultPath("One.md")`) would reach clients verbatim, because the protocol
/// layer renders these errors with `to_string`.
#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
pub enum MutationError {
    #[error("{} does not hold the expected revision", path.as_str())]
    RevisionConflict {
        path: VaultPath,
        /// The revision the target actually holds, or `None` when it does not
        /// exist. The caller's retry loop needs it, and re-reading to find it
        /// would race the next writer.
        current: Option<String>,
    },
    #[error("{} does not exist", path.as_str())]
    NotFound { path: VaultPath },
    #[error("the parent folder of {} does not exist", path.as_str())]
    ParentNotFound { path: VaultPath },
    #[error("{} already exists", path.as_str())]
    TargetExists { path: VaultPath },
    #[error(
        "{} collides with the existing {existing} on a case-insensitive filesystem",
        path.as_str()
    )]
    CaseCollision { path: VaultPath, existing: String },
    #[error(
        "{} is outside the vault, or is not a valid target for this operation",
        path.as_str()
    )]
    ZoneViolation { path: VaultPath },
    #[error("{} is not a Markdown note", path.as_str())]
    NotANote { path: VaultPath },
    /// The inverse of [`MutationError::NotANote`], and the reason it exists:
    /// `write_file` at a `.md` path outside the configuration zone is refused
    /// so raw writes can never bypass the generation model. `write_note`
    /// serves that path, publishes it, and gives the caller read-your-writes;
    /// a raw write would land bytes the caller then could not read back at any
    /// generation it was told about.
    #[error(
        "{} is a Markdown note; write it with write_note so it joins a generation",
        path.as_str()
    )]
    IsANote { path: VaultPath },
    #[error("{} is not empty; pass recursive to delete it anyway", path.as_str())]
    FolderNotEmpty { path: VaultPath },
    #[error("{expected:?} is not a valid precondition for this operation")]
    InvalidPrecondition { expected: Precondition },
    #[error(
        "{actual} bytes exceeds the {limit}-byte cap; chunked transfer for larger files is not implemented"
    )]
    TooLarge { limit: u64, actual: u64 },
    #[error("the daemon is running read-only")]
    ReadOnly,
    /// A frontmatter key path reached somewhere there is no value to address:
    /// it descended into a scalar, indexed a sequence with a non-numeric
    /// segment, or indexed one past its end.
    ///
    /// Narrow on purpose. The design's correction #9 supersedes the earlier,
    /// much broader reading of this variant: an edit *below* a stored span's
    /// granularity is **served** by re-serializing its enclosing top-level
    /// property, not refused. What is left here is the genuinely
    /// unrepresentable — `a.b` where `a` is the string `"x"` has no `b` to
    /// set, and inventing one would silently discard the caller's `a`.
    #[error("{key_path} does not address a value in this frontmatter")]
    UnaddressablePatch { key_path: String },
    #[error("two patch entries edit overlapping spans")]
    OverlappingPatch,
    /// The document opens a frontmatter fence it never closes. A patch that
    /// added a key would have to prepend a second fence, burying the first, so
    /// it refuses instead and the caller fixes the document.
    #[error("{} opens a frontmatter block it never closes", path.as_str())]
    MalformedFrontmatter { path: VaultPath },
    #[error("filesystem failure: {message}")]
    Io { message: String },
}

/// The content revision of `bytes`, in the same `blake3:<hex>` spelling
/// `SourceDocument::new` stores — the full stored format, prefix included, so
/// a client can compare a `get_note` revision against a `write_note` one
/// without reformatting either.
pub fn revision_of(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes))
}

fn io(error: std::io::Error) -> MutationError {
    MutationError::Io {
        message: error.to_string(),
    }
}

/// The one writer into the vault.
#[derive(Clone, Debug)]
pub struct MutationEngine {
    canonical_root: PathBuf,
    read_only: bool,
    max_file_bytes: u64,
}

impl MutationEngine {
    /// `canonical_root` must already be canonical — `IndexConfig`'s
    /// `canonical_vault_root` is, which is where every production caller
    /// gets it. A non-canonical root would make every containment check
    /// compare a resolved path against an unresolved prefix and refuse
    /// everything.
    pub fn new(canonical_root: impl AsRef<Path>) -> Self {
        Self {
            canonical_root: canonical_root.as_ref().to_path_buf(),
            read_only: false,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }

    pub fn with_read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    pub fn with_max_file_bytes(mut self, max_file_bytes: u64) -> Self {
        self.max_file_bytes = max_file_bytes;
        self
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn max_file_bytes(&self) -> u64 {
        self.max_file_bytes
    }

    /// Resolve `path` to an absolute filesystem location that provably stays
    /// inside the vault.
    ///
    /// The parent is canonicalized, so every symlink on the way to the target
    /// is resolved before the containment check; the final component is then
    /// appended unresolved, because a mutation target need not exist yet.
    /// When the final component *does* exist and is itself a symlink, its own
    /// canonical target is checked too — a link planted at the target name
    /// must not become an out-of-vault write.
    pub fn resolve(&self, path: &VaultPath) -> Result<PathBuf, MutationError> {
        let absolute = self.canonical_root.join(path.as_str());
        let parent = absolute
            .parent()
            .ok_or_else(|| MutationError::ZoneViolation { path: path.clone() })?;
        let canonical_parent = match parent.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::ParentNotFound { path: path.clone() });
            }
            Err(error) => return Err(io(error)),
        };
        if !canonical_parent.starts_with(&self.canonical_root) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        let name = absolute
            .file_name()
            .ok_or_else(|| MutationError::ZoneViolation { path: path.clone() })?;
        let resolved = canonical_parent.join(name);
        match resolved.canonicalize() {
            Ok(canonical) => {
                if canonical.starts_with(&self.canonical_root) {
                    Ok(resolved)
                } else {
                    Err(MutationError::ZoneViolation { path: path.clone() })
                }
            }
            // The target does not exist yet, or is a link whose own target
            // does not exist. Either way the parent check above is what
            // bounds it, and nothing has been written.
            Err(_) => Ok(resolved),
        }
    }

    /// `path`'s current on-disk revision, or `None` when it does not exist.
    pub fn current_revision(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        match std::fs::read(&resolved) {
            Ok(bytes) => Ok(Some(revision_of(&bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    /// Evaluate `expected` against what is on disk right now, handing back
    /// the target's current bytes when it exists. Reading the bytes rather
    /// than only hashing them is deliberate: `patch_frontmatter` and
    /// `copy_file` need them anyway, and re-reading after the check would
    /// open a window between the comparison and the use.
    pub fn check(
        &self,
        path: &VaultPath,
        expected: &Precondition,
    ) -> Result<Option<Vec<u8>>, MutationError> {
        let resolved = self.resolve(path)?;
        let current = match std::fs::read(&resolved) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io(error)),
        };
        match (expected, &current) {
            (Precondition::Any, _) => Ok(current),
            (Precondition::Absent, None) => Ok(None),
            (Precondition::Absent, Some(bytes)) => Err(MutationError::RevisionConflict {
                path: path.clone(),
                current: Some(revision_of(bytes)),
            }),
            (Precondition::Revision(_), None) => {
                Err(MutationError::NotFound { path: path.clone() })
            }
            (Precondition::Revision(wanted), Some(bytes)) => {
                let actual = revision_of(bytes);
                if &actual == wanted {
                    Ok(current)
                } else {
                    Err(MutationError::RevisionConflict {
                        path: path.clone(),
                        current: Some(actual),
                    })
                }
            }
        }
    }

    /// The existing entry whose name differs from `path`'s only by case, if
    /// there is one. APFS is case-insensitive by default, so creating
    /// `one.md` beside an existing `One.md` silently overwrites it; the
    /// callers refuse instead. Stricter than Obsidian, which mishandles this
    /// — data safety wins over bug-compatibility.
    ///
    /// The answer comes from the *names* the parent directory holds, never
    /// from asking the filesystem whether the target exists: on a
    /// case-insensitive filesystem an existence probe for `one.md` succeeds
    /// against `One.md` and the collision becomes invisible. A caller runs
    /// this check before any existence or compare-and-swap check for the same
    /// reason.
    pub fn case_variant(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        let Some(parent) = resolved.parent() else {
            return Ok(None);
        };
        let Some(name) = resolved.file_name().and_then(|name| name.to_str()) else {
            return Ok(None);
        };
        let wanted = name.to_lowercase();
        for entry in std::fs::read_dir(parent).map_err(io)? {
            let entry = entry.map_err(io)?;
            let existing = entry.file_name().to_string_lossy().into_owned();
            if existing != name && existing.to_lowercase() == wanted {
                return Ok(Some(existing));
            }
        }
        Ok(None)
    }
}
