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

use std::collections::BTreeSet;
use std::io::Write as _;
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

impl Precondition {
    /// How this precondition is named to a client.
    ///
    /// A refusal's message reaches a client verbatim through `to_string`, and
    /// a Rust `Debug` form (`Revision("blake3:…")`) is both Rust syntax and a
    /// needless echo of the caller's own revision string.
    fn label(&self) -> &'static str {
        match self {
            Precondition::Revision(_) => "a revision precondition",
            Precondition::Absent => "an absent precondition",
            Precondition::Any => "an unconditional precondition",
        }
    }
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
    #[error("{} is not valid for this operation", expected.label())]
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
    /// must not become an out-of-vault write. A link that cannot be resolved
    /// at all, because it dangles or loops, is refused rather than treated as
    /// an absent target: the name is occupied by something this check cannot
    /// vouch for.
    pub fn resolve(&self, path: &VaultPath) -> Result<PathBuf, MutationError> {
        // A NUL byte never reaches the filesystem — std refuses the C-string
        // conversion — and *which* component holds it decides which syscall
        // fails first, so classifying by the resulting `io::Error` answers
        // two different ways for one malformed input (and `Ok` for one of
        // them, since the final `canonicalize` failing is indistinguishable
        // from an absent target). Refused once, here, for every spelling.
        // `VaultPath::new` is string-level and does not reject it; tightening
        // that constructor is a `vault-core` change this task does not own.
        if path.as_str().contains('\0') {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
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
            Err(_) => {
                // Two very different situations reach here. Either nothing is
                // at the name — the ordinary create case, bounded by the
                // parent check above, with nothing written — or something *is*
                // at the name and still cannot be resolved: a symlink that
                // dangles or loops. The second is not absence. Its target is
                // outside anything this check can vouch for, and a caller that
                // opened the returned path with `O_CREAT` rather than renaming
                // over it would create a file wherever the link points, which
                // is how a dangling link becomes an out-of-vault write.
                // `symlink_metadata` does not follow the link, so it is the
                // one call that can tell the two apart.
                if std::fs::symlink_metadata(&resolved).is_ok() {
                    return Err(MutationError::ZoneViolation { path: path.clone() });
                }
                Ok(resolved)
            }
        }
    }

    /// Read `resolved`'s bytes when a regular file is there, reporting an
    /// absent target as `None`.
    ///
    /// Anything that is not a regular file — a directory, a fifo, a socket,
    /// a device — is refused as [`MutationError::TargetExists`], the
    /// taxonomy's "something else already occupies this name", which is
    /// exactly the situation. Reading first would answer `EISDIR` instead,
    /// and that reaches a client as `storage_failure`: a claim the daemon is
    /// broken, and an invitation to retry a request that can never succeed.
    /// Refusing before the read also means a fifo at a target name can never
    /// block the daemon on an open that waits for a writer.
    fn read_regular_file(
        &self,
        path: &VaultPath,
        resolved: &Path,
    ) -> Result<Option<Vec<u8>>, MutationError> {
        match std::fs::metadata(resolved) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(MutationError::TargetExists { path: path.clone() });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        }
        match std::fs::read(resolved) {
            Ok(bytes) => Ok(Some(bytes)),
            // Removed between the stat and the read: still absence, and the
            // caller's precondition is what decides whether that is allowed.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    /// `path`'s current on-disk revision, or `None` when it does not exist.
    pub fn current_revision(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        Ok(self
            .read_regular_file(path, &resolved)?
            .map(|bytes| revision_of(&bytes)))
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
        let current = self.read_regular_file(path, &resolved)?;
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
    ///
    /// Applied unconditionally, including on a case-sensitive filesystem
    /// where both spellings could legally coexist. That refuses a create
    /// which would have worked there, and deliberately: a vault relying on it
    /// would lose a file the moment it was opened or synced onto a default
    /// macOS filesystem.
    ///
    /// **Unicode normalization variants are not collisions here.** `Café.md`
    /// (NFC) and `Café.md` (NFD) address the same file on APFS, and this
    /// comparison — codepoint lowercasing of the stored bytes — does not see
    /// that equivalence, so it reports `None`. The reason to leave it there
    /// rather than normalize is that folding is the platform's own write
    /// semantics: the caller's spelling reaches the same file, the bytes are
    /// preserved, and a precondition still guards it (`check` against an NFD
    /// spelling reads the NFC file's bytes and refuses on `Absent`). Only a
    /// variant that `read_dir` reveals as a *distinct stored name* is a
    /// collision, which is what this returns.
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

/// One mutation, as the coordinator receives it. Later variants are added by
/// their own tasks; every variant is a single-file operation except the
/// folder ones and rename-with-repair, which are still one coordinator
/// command and one generation.
#[derive(Clone, Debug)]
pub enum Mutation {
    WriteNote {
        path: VaultPath,
        content: String,
        expected: Precondition,
    },
}

/// One referencing note a rename could not rewrite, and why. Populated only
/// by rename link repair; every other mutation leaves it empty.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkRewriteFailure {
    pub path: VaultPath,
    pub reason: String,
}

/// What one applied mutation did on disk.
#[derive(Clone, Debug, Default)]
pub struct MutationOutcome {
    /// **Every** filesystem path whose state moved — notes, attachments, and
    /// folders alike, not only the Markdown ones.
    ///
    /// This is what the coordinator hands to `refresh_paths`, and since the
    /// tree pre-task the index tracks folders and non-Markdown files too: a
    /// path appearing, disappearing, or changing stat is generational whatever
    /// its extension. A folder or attachment left unnamed here is a tree row
    /// that is never written, so `snapshot_tree` would serve a tree missing the
    /// daemon's own writes. Over-naming is free — conservative invalidation
    /// re-observes a path and finds nothing changed — while under-naming is a
    /// missing generation.
    pub changed_paths: BTreeSet<VaultPath>,
    /// The revision written, for the operations that write content. `None`
    /// for folder operations and deletes: a deleted file has no revision.
    pub revision: Option<String>,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailure>,
    /// Whether this mutation **changed anything the semantic layer indexes**,
    /// which is to say the Markdown half of the index: notes, their
    /// frontmatter, their links.
    ///
    /// An independent fact each constructor states deliberately, *not* one
    /// derived from `changed_paths`. The two answer different questions and
    /// come apart in both directions: `delete_note` of an attachment names the
    /// deleted path (the tree moved) while nothing semantic did, and a
    /// byte-identical `patch_frontmatter` names no path at all while still
    /// being a semantic operation that succeeded. Read off per operation:
    ///
    /// | operation | `semantic` |
    /// | --- | --- |
    /// | `write_note` | `true` — the target is a note by construction |
    /// | `create_folder` | `false` — a folder holds no indexed semantics |
    /// | `delete_note` of a note | `true` |
    /// | `delete_note` of an attachment | `false` |
    /// | `delete_folder` | `true` iff it removed at least one note |
    /// | `copy_file` | `true` iff the **destination** is Markdown |
    /// | `rename_note` / `rename_folder` | `true` iff any Markdown path moved |
    /// | `patch_frontmatter` | `true` |
    /// | `write_file` | **always `false`** — the zone is not indexed, an
    ///   attachment is not indexed, and a `.md` path is refused with
    ///   [`MutationError::IsANote`] rather than written raw |
    ///
    /// It is deliberately **not** the same question as "does this write live
    /// inside the indexed vault", which is what the wire's
    /// `WriteFileResponse::semantic` answers. That one is `!in_config_zone`,
    /// the server computes it from the path, and conflating the two is what
    /// made an attachment write claim to be semantic in the first draft.
    pub semantic: bool,
}

/// Whether `path` is inside the configuration zone, which every semantic
/// operation refuses and only the raw pair may touch.
pub fn in_config_zone(path: &VaultPath) -> bool {
    let text = path.as_str();
    text == CONFIG_ZONE
        || text
            .strip_prefix(CONFIG_ZONE)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn is_markdown(path: &VaultPath) -> bool {
    Path::new(path.as_str())
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

/// Carry a replaced file's permission bits onto its replacement.
///
/// A replace is a rename over the target, so the surviving inode is the
/// temporary file's, created `0600` by `tempfile` — every note the daemon
/// touched would quietly lose whatever mode it had. Copying the old mode over
/// keeps a write a *content* change and nothing else. A create has no old mode
/// to copy and keeps the private one: widening it would need the process
/// umask, which cannot be read without setting it, and a note the caller can
/// still read and write is the safe end of that trade.
#[cfg(unix)]
fn adopt_permissions(target: &Path, replacement: &std::fs::File) -> Result<(), MutationError> {
    use std::os::unix::fs::PermissionsExt as _;

    let mode = match std::fs::metadata(target) {
        Ok(metadata) => metadata.permissions().mode(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io(error)),
    };
    replacement
        .set_permissions(std::fs::Permissions::from_mode(mode & 0o7777))
        .map_err(io)
}

#[cfg(not(unix))]
fn adopt_permissions(_target: &Path, _replacement: &std::fs::File) -> Result<(), MutationError> {
    Ok(())
}

/// Write `bytes` to `target` atomically: a temporary file in the target's own
/// directory (so the rename is same-filesystem and therefore atomic),
/// flushed to disk, then renamed over the target.
///
/// A crash leaves the old bytes or the new bytes, never a mixture, and never a
/// half-written file under the target's name. Whether the *rename itself*
/// survives a power loss is the filesystem's own ordering guarantee — this
/// does not fsync the directory, because the invariant clients depend on is
/// that a note is never torn, not that an acknowledged write outlives an
/// unclean shutdown.
///
/// The temporary name is `.vaultd-*` with **no** extension, deliberately:
/// `FileSystemVaultSource::markdown_paths` only enumerates `*.md`, so the
/// temporary is never mistaken for a note even in the microseconds it exists,
/// and never produces a spurious create-then-delete generation pair.
pub(crate) fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    let directory = target.parent().ok_or_else(|| MutationError::Io {
        message: format!("{} has no parent directory", target.display()),
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".vaultd-")
        .tempfile_in(directory)
        .map_err(io)?;
    temporary.write_all(bytes).map_err(io)?;
    adopt_permissions(target, temporary.as_file())?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary
        .persist(target)
        .map_err(|error| MutationError::Io {
            message: error.error.to_string(),
        })?;
    Ok(())
}

impl MutationEngine {
    /// Apply one mutation. Every refusal happens before anything is written,
    /// so an `Err` means the vault is byte-identical to what it was.
    pub fn apply(&self, mutation: &Mutation) -> Result<MutationOutcome, MutationError> {
        if self.read_only {
            return Err(MutationError::ReadOnly);
        }
        match mutation {
            Mutation::WriteNote {
                path,
                content,
                expected,
            } => self.write_note(path, content, expected),
        }
    }

    fn write_note(
        &self,
        path: &VaultPath,
        content: &str,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if !is_markdown(path) {
            return Err(MutationError::NotANote { path: path.clone() });
        }
        let bytes = content.as_bytes();
        // Invalid UTF-8 is structurally impossible here: `content` arrived as
        // a JSON string and is a `&str`. Asserted by the type, not validated.
        let actual = bytes.len() as u64;
        if actual > self.max_file_bytes {
            return Err(MutationError::TooLarge {
                limit: self.max_file_bytes,
                actual,
            });
        }
        let resolved = self.resolve(path)?;
        // The case check comes before the precondition, and unconditionally.
        // On a case-insensitive filesystem `check` folds the spelling: asked
        // about `one.md` it reads `One.md`'s bytes, so an `absent`
        // precondition reports a revision conflict for a name that has no
        // file, and a `revision` precondition naming those bytes *passes* and
        // lets the write land on a file the caller never addressed. Neither
        // answer is true of the path as spelled; the collision is.
        if let Some(existing) = self.case_variant(path)? {
            return Err(MutationError::CaseCollision {
                path: path.clone(),
                existing,
            });
        }
        self.check(path, expected)?;
        write_atomically(&resolved, bytes)?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([path.clone()]),
            revision: Some(revision_of(bytes)),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        })
    }
}
