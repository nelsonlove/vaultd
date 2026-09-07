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

pub mod frontmatter;

use std::collections::BTreeSet;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use vault_core::VaultPath;

pub use frontmatter::{FrontmatterEdit, PatchValue, patch_source};

/// The largest single raw payload a mutation accepts, in bytes.
///
/// 16 MiB, revised down from the design's 64 MiB draft: base64 over JSON
/// inflates by roughly a third, so 64 MiB of bytes is an ~85 MB single JSON
/// line, which strains a line-delimited reader for no measured benefit. This
/// covers every attachment class in the reference vault. Chunked transfer for
/// larger files is deferred follow-on, and the refusal names it.
///
/// **The cap governs payloads a client hands the daemon, never bytes the
/// engine reads to verify a precondition.** A delete carries no payload, so
/// capping the compare-and-swap read would make a 400 MB attachment
/// permanently undeletable through vaultd — a refusal with no remedy, since
/// the caller cannot make the file smaller through an interface that will not
/// touch it. So a delete under a `revision` precondition reads and hashes the
/// target whatever its size, and a delete under `any` reads nothing at all:
/// it stats the target instead, because existence is the only fact that
/// precondition asks for. That keeps the ordinary large-attachment delete at
/// one `stat` rather than one full read into memory.
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
    /// The addressed property declares a YAML anchor that another property in
    /// the same frontmatter aliases.
    ///
    /// `vault-core` resolves an alias before the patcher ever sees the value,
    /// so re-serializing or deleting the anchored property emits a document
    /// in which `*anchor` points at nothing — and then the *whole*
    /// frontmatter stops parsing, including the properties the caller never
    /// touched. Damage outside the edited property is the one thing
    /// correction #9 forbids absolutely, so this refuses rather than
    /// half-succeeding.
    #[error(
        "{} anchors &{anchor}, which another property aliases; editing it would orphan that alias",
        path.as_str()
    )]
    AnchoredProperty { path: VaultPath, anchor: String },
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

/// The engine's NUL gate, in one place because every verb must answer it the
/// same way.
///
/// A NUL byte never reaches the filesystem — std refuses the C-string
/// conversion — and *which* component holds it decides which syscall fails
/// first, so classifying by the resulting `io::Error` answers two different
/// ways for one malformed input (and `Ok` for one of them, since a final
/// `canonicalize` failing is indistinguishable from an absent target). Left to
/// the io mapping it reaches a client as `storage_failure`: a claim the daemon
/// is broken and that a write was attempted, when neither is true, and an
/// invitation to retry a request that can never succeed.
///
/// [`MutationEngine::resolve`] calls this for every verb that resolves a
/// target. `create_folder` walks its own segments — a folder chain need not
/// have an existing parent, so it cannot resolve — and therefore calls it
/// directly rather than inheriting the gate. That is the whole reason this is
/// a function and not four lines inside `resolve`.
///
/// `VaultPath::new` is string-level and does not reject a NUL; tightening that
/// constructor is a `vault-core` change this crate does not own.
fn refuse_nul(path: &VaultPath) -> Result<(), MutationError> {
    if path.as_str().contains('\0') {
        return Err(MutationError::ZoneViolation { path: path.clone() });
    }
    Ok(())
}

/// The one writer into the vault.
#[derive(Clone)]
pub struct MutationEngine {
    canonical_root: PathBuf,
    read_only: bool,
    max_file_bytes: u64,
    /// Test-only rendezvous. Production leaves it empty and pays one
    /// `Option` check per write.
    hook: Option<std::sync::Arc<dyn crate::TestHook>>,
}

/// Written by hand rather than derived: `dyn TestHook` carries no `Debug`
/// bound — a hook is a test's closure, and requiring it to be printable would
/// buy nothing — so the slot is reported as present or absent and nothing
/// else.
impl std::fmt::Debug for MutationEngine {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MutationEngine")
            .field("canonical_root", &self.canonical_root)
            .field("read_only", &self.read_only)
            .field("max_file_bytes", &self.max_file_bytes)
            .field("hook", &self.hook.is_some())
            .finish()
    }
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
            hook: None,
        }
    }

    pub fn with_read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    #[doc(hidden)]
    pub fn with_test_hook(mut self, hook: std::sync::Arc<dyn crate::TestHook>) -> Self {
        self.hook = Some(hook);
        self
    }

    fn reach(&self, point: crate::HookPoint) {
        if let Some(hook) = &self.hook {
            hook.reach(point);
        }
    }

    /// Re-read the target and require the precondition to still hold.
    ///
    /// The first check happens before any work; this one happens immediately
    /// before the write, so a writer that lost the race in between refuses
    /// rather than clobbering. Both checks are cheap — one read of a file
    /// already in the page cache — and the second is what makes
    /// "never a lost update" true rather than likely.
    ///
    /// It narrows the window; it does not close it. Nothing here holds a lock
    /// across the check and the rename, so an external writer that lands
    /// between them still wins, and the atomic rename bounds the damage to
    /// last-writer-wins over whole files rather than a blend of two. Inside
    /// the daemon the window is closed by construction — one mutation is in
    /// flight at a time — and this re-check is what covers the writer the
    /// daemon does not own: Obsidian, a sync client, a shell.
    fn recheck(&self, path: &VaultPath, expected: &Precondition) -> Result<(), MutationError> {
        self.reach(crate::HookPoint::AfterMutationPrecondition);
        self.check(path, expected)?;
        Ok(())
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
        refuse_nul(path)?;
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

    /// Whether a regular file is at `resolved` right now.
    ///
    /// Anything that is not a regular file — a directory, a fifo, a socket,
    /// a device — is refused as [`MutationError::TargetExists`], the
    /// taxonomy's "something else already occupies this name", which is
    /// exactly the situation. Reading first would answer `EISDIR` instead,
    /// and that reaches a client as `storage_failure`: a claim the daemon is
    /// broken, and an invitation to retry a request that can never succeed.
    /// Refusing before the read also means a fifo at a target name can never
    /// block the daemon on an open that waits for a writer.
    ///
    /// Split out from [`MutationEngine::read_regular_file`] because a delete
    /// under an unconditional precondition needs exactly this fact and none of
    /// the bytes: see [`DEFAULT_MAX_FILE_BYTES`] on why a delete never reads a
    /// payload it has no use for.
    fn regular_file_exists(
        &self,
        path: &VaultPath,
        resolved: &Path,
    ) -> Result<bool, MutationError> {
        match std::fs::metadata(resolved) {
            Ok(metadata) if !metadata.is_file() => {
                Err(MutationError::TargetExists { path: path.clone() })
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io(error)),
        }
    }

    /// Read `resolved`'s bytes when a regular file is there, reporting an
    /// absent target as `None`. Non-regular occupants are refused by
    /// [`MutationEngine::regular_file_exists`] before anything is read.
    fn read_regular_file(
        &self,
        path: &VaultPath,
        resolved: &Path,
    ) -> Result<Option<Vec<u8>>, MutationError> {
        if !self.regular_file_exists(path, resolved)? {
            return Ok(None);
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
        self.check_resolved(path, &resolved, expected)
    }

    /// [`MutationEngine::check`] against an already-resolved target, for a
    /// caller that resolved once and is threading the answer through its own
    /// checks. Resolving again would be three canonicalize chains for one
    /// write, and three chances for them to disagree under a racing rename.
    fn check_resolved(
        &self,
        path: &VaultPath,
        resolved: &Path,
        expected: &Precondition,
    ) -> Result<Option<Vec<u8>>, MutationError> {
        let current = self.read_regular_file(path, resolved)?;
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
        Ok(self.case_scan(&resolved)?.variant)
    }

    /// The case collision a mutation refuses: a differently-cased stored name
    /// **and no file stored under the caller's own spelling**.
    ///
    /// The qualifier is what separates the hazard from a legal state. On a
    /// case-insensitive filesystem the two can never both be stored, so
    /// `one.md` beside a stored `One.md` is always the hazard and is always
    /// refused. On a case-sensitive one they can, and then the caller's
    /// spelling names its own file unambiguously: the write goes exactly where
    /// it says, nothing folds, and refusing would lock every such file out of
    /// vaultd permanently rather than protecting anything. Both the spec's
    /// Ruling 4 ("`create` with `expected.absent` where a case-variant
    /// exists") and the controller's ordering ruling ("a case-insensitive
    /// match … *with no exact match*") carry it.
    ///
    /// A *create* on a case-sensitive filesystem still refuses, which is
    /// Ruling 4's deliberate strictness: the new file would coexist locally
    /// and destroy its twin the moment the vault reached a default macOS
    /// volume.
    pub fn case_collision(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        self.case_collision_at(&resolved)
    }

    /// [`MutationEngine::case_collision`] against an already-resolved target.
    fn case_collision_at(&self, resolved: &Path) -> Result<Option<String>, MutationError> {
        Ok(collision(self.case_scan(resolved)?))
    }

    /// Read the target's parent directory once and classify its stored names
    /// against the target's own.
    fn case_scan(&self, resolved: &Path) -> Result<CaseScan, MutationError> {
        let (Some(parent), Some(name)) = (
            resolved.parent(),
            resolved.file_name().and_then(|name| name.to_str()),
        ) else {
            return Ok(CaseScan::default());
        };
        let mut names = Vec::new();
        for entry in std::fs::read_dir(parent).map_err(io)? {
            names.push(
                entry
                    .map_err(io)?
                    .file_name()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        Ok(classify_names(names, name))
    }
}

/// What a parent directory's stored names say about one target name.
#[derive(Debug, Default, Eq, PartialEq)]
struct CaseScan {
    /// The target's own spelling is one of the stored names.
    exact: bool,
    /// A stored name that folds to the target's but is spelled differently.
    /// The first such name in directory order when there is more than one.
    variant: Option<String>,
}

/// Split out from the `read_dir` so the rule can be tested against listings a
/// case-insensitive filesystem cannot physically produce — an exact name and a
/// case variant side by side is exactly the state the qualifier exists for,
/// and it cannot be created on the machine this is developed on.
/// The refusal decision itself, separated from the `read_dir` that feeds it so
/// both arms can be asserted: the exact-match arm cannot be reached through
/// the filesystem on a case-insensitive machine, because the listing it needs
/// — a name and its case variant, both stored — is one such a filesystem
/// cannot hold.
fn collision(scan: CaseScan) -> Option<String> {
    if scan.exact { None } else { scan.variant }
}

fn classify_names(names: impl IntoIterator<Item = String>, name: &str) -> CaseScan {
    let wanted = name.to_lowercase();
    let mut scan = CaseScan::default();
    for existing in names {
        if existing == name {
            scan.exact = true;
        } else if scan.variant.is_none() && existing.to_lowercase() == wanted {
            scan.variant = Some(existing);
        }
    }
    scan
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
    CreateFolder {
        path: VaultPath,
    },
    DeleteNote {
        path: VaultPath,
        /// `None` takes the vault's own `trashOption` default. A plugin shim
        /// always passes the plugin's explicit choice; only a direct client
        /// leaves this open.
        mode: Option<DeleteMode>,
        expected: Precondition,
    },
    DeleteFolder {
        path: VaultPath,
        mode: Option<DeleteMode>,
        recursive: bool,
    },
    CopyFile {
        from: VaultPath,
        to: VaultPath,
        expected_source: Precondition,
        if_exists: CopyConflict,
    },
    RenameNote {
        from: VaultPath,
        to: VaultPath,
        expected: Precondition,
        /// Consumed by `IndexService::apply_mutation`, which owns the link
        /// repair burst; the engine below only ever moves the file.
        rewrite_links: bool,
    },
    RenameFolder {
        from: VaultPath,
        to: VaultPath,
        rewrite_links: bool,
    },
    PatchFrontmatter {
        path: VaultPath,
        patch: Vec<FrontmatterEdit>,
        expected: Precondition,
    },
}

/// What `copy_file` does when its destination already exists.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CopyConflict {
    #[default]
    Error,
    /// Obsidian's auto-numbering behaviour, for `getAvailablePath` parity.
    Suffix,
}

/// How a delete disposes of its target.
///
/// Obsidian's API is `vault.trash(file, system: boolean)` and the plugin
/// chooses per call; `trashOption` governs Obsidian's own UI deletions only.
/// So a shim maps `trash(f, true)` to `TrashSystem`, `trash(f, false)` to
/// `TrashLocal`, and `delete(f)` to `Permanent`, consulting no config at all.
/// The `trashOption` default below applies only when a client deletes with no
/// plugin involved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteMode {
    TrashSystem,
    TrashLocal,
    Permanent,
}

/// The slice of `.obsidian/app.json` a delete consults. Every other key in
/// that file is Obsidian's business, so the struct names one and ignores the
/// rest rather than modelling a settings file the daemon does not own.
#[derive(serde::Deserialize)]
struct AppJson {
    #[serde(rename = "trashOption")]
    trash_option: Option<String>,
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
    /// folders alike, not only the Markdown ones — each spelled the way the
    /// filesystem stores it, never the way the caller spelled it.
    ///
    /// The stored spelling is what the scanner emits and therefore what the
    /// index is keyed by. On a case-insensitive filesystem a caller naming
    /// `folder/New.md` writes into a stored `Folder/`, and reporting its
    /// spelling would key a row no complete reconciliation can ever match: the
    /// client would miss its own write at the generation it was handed, and
    /// the row would survive until the next full scan deleted it.
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
///
/// The comparison is exact-case, so it answers about a *stored* spelling.
/// Callers pass the path as the filesystem holds it — a caller's `.OBSIDIAN`
/// reaches the real zone on a case-insensitive filesystem and names a
/// different, ordinary folder on a case-sensitive one, and only the resolved
/// path tells the two apart. Case-insensitive matching here would get the
/// second case wrong for every vault.
pub fn in_config_zone(path: &VaultPath) -> bool {
    let text = path.as_str();
    text == CONFIG_ZONE
        || text
            .strip_prefix(CONFIG_ZONE)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Whether the semantic layer would ever read a note at `path` — the union of
/// the configuration zone and every hidden folder.
///
/// One predicate rather than two checks because the two refusals have one
/// reason: `refresh_paths` skips `is_hidden` paths and the scan never lists
/// them, so a semantic write into either would report a revision at a
/// generation that will never contain it. That is the same read-your-writes
/// break that makes a non-`.md` path a typed refusal instead of a raw write.
/// [`VaultPath::is_hidden`] is the index's own predicate, used here so the two
/// cannot drift; it subsumes `.trash`, `.git`, and every nested spelling of
/// the zone, and `in_config_zone` catches the zone folder named by itself.
fn is_unindexable(path: &VaultPath) -> bool {
    in_config_zone(path) || path.is_hidden()
}

/// [`is_unindexable`] for a path a **folder** operation addresses, which adds
/// the half [`VaultPath::is_hidden`] deliberately leaves to its caller.
///
/// `is_hidden` never judges the last component, because nothing lexical can
/// tell a hidden *file* (`.hidden-note.md`, which the scan does index) from a
/// hidden *directory* (which it does not). A folder operation is exactly the
/// caller that doc means: it knows its target is a directory, so it applies
/// the directory half itself and refuses a final component that starts with a
/// dot.
///
/// Without it, `delete_folder { ".trash", recursive: true }` empties the
/// recovery surface `trash_local` exists to provide, and
/// `delete_folder { ".git" }` destroys a repository the daemon does not own
/// and cannot restore. Both are one call, both are irreversible under
/// `permanent`, and neither path is one the daemon can even read back.
///
/// Applied to the caller's spelling *and* to the stored one, for the reason
/// Task 5's Ruling B1 gives: `in_config_zone` is exact-case on purpose, so a
/// caller's `.OBSIDIAN` is not the zone as a string while resolving to it as a
/// path on any case-folding filesystem. The pre-resolve check is not redundant
/// with the post-resolve one — a target that does not exist has no stored
/// spelling to check, and `.git/hooks` must be refused as a zone violation
/// rather than reported as merely absent.
fn is_unindexable_folder(path: &VaultPath) -> bool {
    is_unindexable(path) || path.name().starts_with('.')
}

/// Give the replacement file the mode the result should have: the replaced
/// file's own, or — when there is nothing to replace — the one the containing
/// folder implies.
///
/// A write is a rename over the target, so the surviving inode is the
/// temporary file's, created `0600` by `tempfile`. Left alone, that makes
/// every note the daemon touched drop to owner-only while every note Obsidian
/// writes stays `0644`, and a vault worked on by both grows two classes of
/// note permission — one of which a publisher, backup, or container mount
/// running as another user silently cannot read.
///
/// A replace takes the old file's mode, so a write changes *content* and
/// nothing else. A create takes `folder_mode & 0o666`: a `0755` folder implies
/// `0644` files, which is where every other tool writing into the vault lands,
/// and the `& 0o666` drops the folder's execute and any setuid/setgid/sticky
/// bits. The alternative — reading the process umask — is not portable to do
/// without also setting it, and this answer needs no syscall that is not made
/// anyway.
#[cfg(unix)]
fn adopt_permissions(target: &Path, replacement: &std::fs::File) -> Result<(), MutationError> {
    use std::os::unix::fs::PermissionsExt as _;

    let mode = match std::fs::metadata(target) {
        Ok(metadata) => metadata.permissions().mode() & 0o7777,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let folder = target.parent().ok_or_else(|| MutationError::Io {
                message: format!("{} has no parent directory", target.display()),
            })?;
            std::fs::metadata(folder).map_err(io)?.permissions().mode() & 0o666
        }
        Err(error) => return Err(io(error)),
    };
    replacement
        .set_permissions(std::fs::Permissions::from_mode(mode))
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
/// The rename replaces the *name*, never what a link under that name points
/// at: a target that was a symlink into the vault becomes a regular file
/// holding the new bytes, and the link's old target keeps the bytes it had.
/// That is what every temp-and-rename writer does, and it is the safe end of
/// the trade — writing through the link would put note bytes at a path the
/// caller never named.
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
            Mutation::CreateFolder { path } => self.create_folder(path),
            Mutation::DeleteNote {
                path,
                mode,
                expected,
            } => self.delete_note(path, *mode, expected),
            Mutation::DeleteFolder {
                path,
                mode,
                recursive,
            } => self.delete_folder(path, *mode, *recursive),
            Mutation::CopyFile {
                from,
                to,
                expected_source,
                if_exists,
            } => self.copy_file(from, to, expected_source, *if_exists),
            Mutation::RenameNote {
                from,
                to,
                expected,
                rewrite_links: _,
            } => self.rename_note(from, to, expected),
            Mutation::RenameFolder {
                from,
                to,
                rewrite_links: _,
            } => self.rename_folder(from, to),
            Mutation::PatchFrontmatter {
                path,
                patch,
                expected,
            } => self.patch_frontmatter(path, patch, expected),
        }
    }

    /// The vault-relative path a resolved target is stored under: the parent's
    /// spelling as the filesystem holds it, plus the name the write will
    /// create.
    ///
    /// This, not the caller's spelling, is what an outcome reports. `resolve`
    /// canonicalizes the parent, so on a case-insensitive filesystem a caller
    /// naming `folder/New.md` writes into a stored `Folder/`; reporting the
    /// caller's spelling would key an index row under a name the scanner never
    /// emits, and the client would then miss its own write at the generation
    /// it was handed.
    fn stored_path(&self, path: &VaultPath, resolved: &Path) -> Result<VaultPath, MutationError> {
        let relative = resolved
            .strip_prefix(&self.canonical_root)
            .map_err(|_| MutationError::ZoneViolation { path: path.clone() })?;
        let mut spelling = String::new();
        for component in relative.components() {
            let std::path::Component::Normal(part) = component else {
                return Err(MutationError::ZoneViolation { path: path.clone() });
            };
            let part = part
                .to_str()
                .ok_or_else(|| MutationError::ZoneViolation { path: path.clone() })?;
            if !spelling.is_empty() {
                spelling.push('/');
            }
            spelling.push_str(part);
        }
        VaultPath::new(spelling).map_err(|_| MutationError::ZoneViolation { path: path.clone() })
    }

    /// The vault-relative path a completed write actually landed on, for the
    /// outcome to report.
    ///
    /// Taken after the write, from a full `canonicalize` of the target rather
    /// than from `resolve`'s parent-only one. `resolve` leaves the final
    /// component exactly as the caller spelled it, and one class of mismatch
    /// there survives every check before the write: a Unicode normalization
    /// difference. `Cafe\u{301}.md` (NFD) and `Café.md` (NFC) are the same file
    /// on APFS and are *deliberately* allowed to fold — they are visually one
    /// name and refusing would hurt real callers — but they are two different
    /// strings, so the collision scan reports neither an exact match nor a
    /// variant, and the caller's spelling reaches the outcome. That is the
    /// phantom-row hazard again: a hint keyed to a name the scanner never
    /// emits. `canonicalize` resolves normalization as well as case and
    /// symlinks, so one call after the write settles every spelling question
    /// at once.
    ///
    /// `fallback` is the pre-write spelling, used when the canonicalize cannot
    /// answer — the file was removed or replaced by another writer in the
    /// instant after ours landed. A write that succeeded must never be
    /// reported as a failure, and the two spellings differ only in
    /// normalization anyway.
    fn written_path(&self, path: &VaultPath, resolved: &Path, fallback: VaultPath) -> VaultPath {
        std::fs::canonicalize(resolved)
            .ok()
            .and_then(|written| self.stored_path(path, &written).ok())
            .unwrap_or(fallback)
    }

    /// The stored spelling of a target a mutation is about to **remove**,
    /// captured while it still exists.
    ///
    /// The mirror image of [`MutationEngine::written_path`], and it exists
    /// because that one cannot serve here: it canonicalizes *after* the
    /// mutation, and a canonicalize of a path that is now gone fails and falls
    /// back to the caller's own spelling. For a delete that is the phantom-key
    /// hazard in its purest form — a reconciliation hint keyed to a name the
    /// scanner never emitted, so the index row for the file that really went
    /// away outlives it. Every removing operation therefore captures its
    /// spelling first and reports what it captured.
    ///
    /// A symlink at the target is deliberately *not* followed. A delete
    /// unlinks the name, not what the name points at, so the link's own
    /// spelling is what disappeared; canonicalizing would report the link's
    /// target instead — a path that still exists and is not gone at all.
    fn captured_path(&self, path: &VaultPath, resolved: &Path) -> Result<VaultPath, MutationError> {
        let is_symlink = std::fs::symlink_metadata(resolved)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false);
        if !is_symlink {
            if let Ok(canonical) = std::fs::canonicalize(resolved) {
                return self.stored_path(path, &canonical);
            }
        }
        self.stored_path(path, resolved)
    }

    fn write_note(
        &self,
        path: &VaultPath,
        content: &str,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        // Once on the caller's spelling, so a path this obviously refuses is
        // refused even when its parent does not exist and `resolve` would
        // answer `parent_not_found` instead.
        if is_unindexable(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if !path.is_markdown() {
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
        // And again on the path the write would actually reach. A
        // case-insensitive filesystem folds `.OBSIDIAN` onto the real zone,
        // and a symlink whose own name is innocuous can have a hidden parent
        // once resolved; neither is visible in the spelling the caller sent.
        let stored = self.stored_path(path, &resolved)?;
        if is_unindexable(&stored) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // The case check comes before the precondition. On a case-insensitive
        // filesystem `check` folds the spelling: asked about `one.md` it reads
        // `One.md`'s bytes, so an `absent` precondition reports a revision
        // conflict for a name that has no file, and a `revision` precondition
        // naming those bytes *passes* and lets the write land on a file the
        // caller never addressed. Neither answer is true of the path as
        // spelled; the collision is.
        if let Some(existing) = self.case_collision_at(&resolved)? {
            return Err(MutationError::CaseCollision {
                path: path.clone(),
                existing,
            });
        }
        self.check_resolved(path, &resolved, expected)?;
        self.recheck(path, expected)?;
        write_atomically(&resolved, bytes)?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([self.written_path(path, &resolved, stored)]),
            revision: Some(revision_of(bytes)),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        })
    }

    /// Edit a note's frontmatter in place, changing only the addressed keys'
    /// bytes.
    ///
    /// The guards are `write_note`'s, for `write_note`'s reasons: this writes
    /// a note through the same atomic rename, so the same paths must be
    /// unreachable.
    ///
    /// The size cap applies to the **edits**, never to the result. The cap
    /// governs a payload a client hands the daemon, and a patch's payload is
    /// its edits, not a file; capping the *result* would make a note that is
    /// already over the cap permanently unpatchable — a refusal with no
    /// remedy, since the only interface that could shrink it is the one
    /// refusing. That is the same reasoning [`DEFAULT_MAX_FILE_BYTES`] gives
    /// for an uncapped delete. But leaving the *input* uncapped too would
    /// make this operation a hole in the payload rule: a client that cannot
    /// `write_note` a 100 MB note could patch one key to a 100 MB string and
    /// get the same file. So the edits are weighed, and weighed first — a
    /// refusal here reads nothing and touches nothing.
    fn patch_frontmatter(
        &self,
        path: &VaultPath,
        edits: &[FrontmatterEdit],
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        // Once on the caller's spelling, so an obviously refused path is
        // refused even when its parent does not exist and `resolve` would
        // answer `parent_not_found` instead.
        if is_unindexable(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if !path.is_markdown() {
            return Err(MutationError::NotANote { path: path.clone() });
        }
        // A patch edits a document that must already be there, so `absent`
        // cannot be satisfied by anything this operation could then do.
        if expected == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected.clone(),
            });
        }
        let weight = frontmatter::patch_weight(edits);
        if weight > self.max_file_bytes {
            return Err(MutationError::TooLarge {
                limit: self.max_file_bytes,
                actual: weight,
            });
        }
        let resolved = self.resolve(path)?;
        // And again on the path the write would actually reach: a
        // case-insensitive filesystem folds `.OBSIDIAN` onto the real zone,
        // and a symlink with an innocuous name can have a hidden parent once
        // resolved.
        let stored = self.stored_path(path, &resolved)?;
        if is_unindexable(&stored) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // Case before the precondition, for `write_note`'s reason: on a
        // case-insensitive filesystem `check` folds the spelling, so a patch
        // of `one.md` would read and then rewrite the stored `One.md` — a
        // file the caller never addressed.
        if let Some(existing) = self.case_collision_at(&resolved)? {
            return Err(MutationError::CaseCollision {
                path: path.clone(),
                existing,
            });
        }
        // `check_resolved` refuses a non-regular occupant as `TargetExists`
        // before reading, and answers `None` only for a genuinely absent
        // target under an unconditional precondition.
        let Some(bytes) = self.check_resolved(path, &resolved, expected)? else {
            return Err(MutationError::NotFound { path: path.clone() });
        };
        let text = String::from_utf8(bytes).map_err(|_| MutationError::Io {
            message: format!("{} is not valid UTF-8", path.as_str()),
        })?;
        let patched = frontmatter::patch_source(path, &text, edits)?;
        if patched == text {
            // Byte-identical: do not rewrite the file, do not move its mtime,
            // and name no changed path — a no-op patch must not manufacture a
            // generation. `semantic` stays `true` regardless: it states
            // whether this is an operation over the indexed Markdown half,
            // not whether this call happened to move a byte.
            return Ok(MutationOutcome {
                changed_paths: BTreeSet::new(),
                revision: Some(revision_of(text.as_bytes())),
                links_rewritten: 0,
                link_rewrite_failures: Vec::new(),
                semantic: true,
            });
        }
        self.recheck(path, expected)?;
        write_atomically(&resolved, patched.as_bytes())?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([self.written_path(path, &resolved, stored)]),
            revision: Some(revision_of(patched.as_bytes())),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        })
    }

    /// The vault's own configured disposition for a delete a client did not
    /// qualify. Any failure to read or parse `app.json` falls back to the
    /// system trash, which is Obsidian's own default: a delete must never
    /// fail because a configuration file is unreadable, and the safest
    /// fallback is the recoverable one.
    pub fn configured_delete_mode(&self) -> DeleteMode {
        let path = self.canonical_root.join(CONFIG_ZONE).join("app.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return DeleteMode::TrashSystem;
        };
        let Ok(parsed) = serde_json::from_str::<AppJson>(&text) else {
            return DeleteMode::TrashSystem;
        };
        match parsed.trash_option.as_deref() {
            Some("local") => DeleteMode::TrashLocal,
            Some("none") => DeleteMode::Permanent,
            _ => DeleteMode::TrashSystem,
        }
    }

    /// `mkdir -p`, bounded by the vault.
    ///
    /// An existing folder is success, not a conflict: the postcondition a
    /// caller wants is "a folder is there", and Obsidian's own
    /// `createFolder` is the only thing that would tell them otherwise.
    ///
    /// The outcome names **every folder segment this call actually created**,
    /// and nothing else. Per `MutationOutcome::changed_paths`: since the tree
    /// pre-task the index holds a row per folder, so a created directory the
    /// outcome does not name is a `tree_entries` row that never lands, and
    /// `snapshot_tree` at the generation this call published would serve a
    /// tree missing the daemon's own write. A segment that was already there
    /// is named by no one, because nothing about it moved.
    fn create_folder(&self, path: &VaultPath) -> Result<MutationOutcome, MutationError> {
        if is_unindexable_folder(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // Called here rather than inherited from `resolve`, which this verb
        // never reaches: see [`refuse_nul`].
        refuse_nul(path)?;
        // `resolve` requires an existing parent, which a folder chain need
        // not have. Walk the segments instead, checking containment at every
        // level that already exists, and creating the rest.
        let mut created = BTreeSet::new();
        let mut current = self.canonical_root.clone();
        let segments: Vec<&str> = path.as_str().split('/').collect();
        let last = segments.len() - 1;
        for (index, segment) in segments.into_iter().enumerate() {
            current = current.join(segment);
            // The final segment is this call's target, and it gets the guard
            // every other verb applies to its own: a stored name that differs
            // only in case, with no file stored under the caller's spelling.
            // On a case-folding volume the create would otherwise be a silent
            // success on a folder the caller did not name; on a case-sensitive
            // one it creates the twin directory that folds into its sibling —
            // and whose contents then collide — the moment the vault reaches a
            // default macOS filesystem, which is Ruling 4's strictness applied
            // to the verb that makes the twin.
            //
            // Ancestors are deliberately exempt, per the ancestor-fold
            // doctrine the phase already ratified: a folded ancestor names a
            // folder that exists, the platform reaches it, and every other
            // verb serves it the same way.
            if index == last {
                if let Some(existing) = self.case_collision_at(&current)? {
                    return Err(MutationError::CaseCollision {
                        path: path.clone(),
                        existing,
                    });
                }
            }
            match current.canonicalize() {
                Ok(canonical) => {
                    if !canonical.starts_with(&self.canonical_root) {
                        return Err(MutationError::ZoneViolation { path: path.clone() });
                    }
                    if canonical.is_file() {
                        return Err(MutationError::TargetExists { path: path.clone() });
                    }
                    // The stored half of the guard, and the only one that can
                    // see a segment which *resolves* somewhere the caller's
                    // spelling never mentions: a symlink named `Link` pointing
                    // at `.obsidian` carries no dot and names no zone.
                    let stored = self.stored_path(path, &canonical)?;
                    if is_unindexable_folder(&stored) {
                        return Err(MutationError::ZoneViolation { path: path.clone() });
                    }
                    current = canonical;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&current).map_err(io)?;
                    // Canonicalized after creating it, so the segment is named
                    // the way the filesystem stores it — the same phantom-key
                    // reasoning as every other reported path.
                    let canonical = current.canonicalize().map_err(io)?;
                    created.insert(self.stored_path(path, &canonical)?);
                    current = canonical;
                }
                Err(error) => return Err(io(error)),
            }
        }
        Ok(MutationOutcome {
            changed_paths: created,
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            // A folder holds no frontmatter, no links, and no text: nothing
            // the semantic half of the index reads.
            semantic: false,
        })
    }

    /// Delete one file — a note or an attachment — under a precondition.
    ///
    /// The unindexable refusal is the same one `write_note` carries, applied
    /// to the caller's spelling before the resolve and to the stored spelling
    /// after it: a path the scan never lists is a path this operation cannot
    /// address, in either direction. Deleting inside `.trash` or the
    /// configuration zone is refused rather than served, so the addressable
    /// surface is one set of paths and not two.
    fn delete_note(
        &self,
        path: &VaultPath,
        mode: Option<DeleteMode>,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if is_unindexable(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // An `absent` precondition on a delete is a contradiction, not a
        // guard: it asks for nothing to be there, and the operation's whole
        // purpose is to remove what is. Refused as an invalid request rather
        // than silently read as "delete if present", which is the meaning a
        // caller would then rely on.
        if expected == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected.clone(),
            });
        }
        let resolved = self.resolve(path)?;
        // Captured *before* the delete: afterwards there is nothing left to
        // canonicalize, and the caller's own spelling would reach the index
        // as a key the scanner never emits.
        let stored = self.captured_path(path, &resolved)?;
        if is_unindexable(&stored) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // The same guard `write_note` carries, in the same position: before
        // the precondition, because on a case-folding filesystem the
        // precondition itself folds and answers about a file the caller did
        // not name. The destructive verb must not be the permissive one — a
        // folded `one.md` beside a stored `One.md` is a name this vault does
        // not hold, which is the caller's model being wrong in exactly the way
        // the `not_found` refusal below exists to report. The refusal names
        // the stored spelling, so the caller's remedy is immediate.
        if let Some(existing) = self.case_collision_at(&resolved)? {
            return Err(MutationError::CaseCollision {
                path: path.clone(),
                existing,
            });
        }
        // Deletion is never idempotent-silent: a caller deleting something
        // that is already gone had a wrong model of the vault and should
        // hear so.
        self.require_regular_file(path, &resolved, expected)?;
        self.dispose(
            &resolved,
            mode.unwrap_or_else(|| self.configured_delete_mode()),
        )?;
        Ok(MutationOutcome {
            // The stored spelling, per `MutationOutcome::changed_paths`: the
            // index is keyed by what the scanner emits, so a delete hint keyed
            // any other way leaves the real row behind.
            changed_paths: BTreeSet::from([stored.clone()]),
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: stored.is_markdown(),
        })
    }

    /// Remove a folder, and — with `recursive` — everything under it.
    ///
    /// The most destructive verb the daemon has, and guarded like it: the
    /// unindexable refusal runs on the caller's spelling and again on the
    /// stored one, a symlink is never treated as the folder it points at, and
    /// a folded spelling is refused rather than served.
    fn delete_folder(
        &self,
        path: &VaultPath,
        mode: Option<DeleteMode>,
        recursive: bool,
    ) -> Result<MutationOutcome, MutationError> {
        if is_unindexable_folder(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        let resolved = self.resolve(path)?;
        // `symlink_metadata` rather than `is_dir`, because the two disagree on
        // exactly the case that matters. A symlink to a directory *is* a
        // directory to `is_dir`, but `remove_dir_all` removes the link and not
        // its contents while `WalkDir` walks the contents — so the outcome
        // would name the target's notes as deleted while they are all still
        // there. Refusing keeps the two from ever disagreeing, and it is the
        // honest answer besides: the caller addressed a folder, and a link is
        // not one.
        match std::fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MutationError::TargetExists { path: path.clone() });
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(MutationError::NotFound { path: path.clone() });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::NotFound { path: path.clone() });
            }
            Err(error) => return Err(io(error)),
        }
        // The folder's own stored spelling, captured while it still exists, so
        // the enumeration below walks the vault as the filesystem spells it
        // rather than as the caller did — every path it yields is then a key
        // the scanner would emit.
        let stored = self.captured_path(path, &resolved)?;
        if is_unindexable_folder(&stored) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // Before the emptiness question, because it is the prior one: a folded
        // spelling names a folder this vault does not store, and answering
        // "not empty" about a different folder than the one addressed would be
        // the wrong refusal even though it refuses.
        if let Some(existing) = self.case_collision_at(&resolved)? {
            return Err(MutationError::CaseCollision {
                path: path.clone(),
                existing,
            });
        }
        let empty = std::fs::read_dir(&resolved).map_err(io)?.next().is_none();
        if !empty && !recursive {
            return Err(MutationError::FolderNotEmpty { path: path.clone() });
        }
        // Enumerated *before* the delete: every path that disappears has to
        // reach reconciliation, or its rows outlive the file.
        let removed = paths_under(&self.canonical_root, &stored)?;
        self.dispose(
            &resolved,
            mode.unwrap_or_else(|| self.configured_delete_mode()),
        )?;
        // Read off the Markdown subset, not off `changed_paths`, per the
        // `MutationOutcome::semantic` table: a folder of attachments moves
        // every tree row under it and no semantic row at all.
        let semantic = removed.iter().any(VaultPath::is_markdown);
        let mut changed_paths: BTreeSet<VaultPath> = removed.into_iter().collect();
        // The folder itself is a tree row too, and an empty folder's delete
        // moves nothing else.
        changed_paths.insert(stored);
        Ok(MutationOutcome {
            semantic,
            changed_paths,
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
        })
    }

    /// Require a regular file at `resolved` that satisfies `expected`, reading
    /// no more of it than the precondition actually asks for.
    ///
    /// Shared by the two operations that *move or remove* an existing file —
    /// `delete_note` and `rename_note` — because they ask the filesystem the
    /// same three questions in the same order, and a second copy of this would
    /// be a second place for the M3 reasoning to drift. A `revision`
    /// precondition is hashed in bounded chunks rather than read whole (see
    /// [`DEFAULT_MAX_FILE_BYTES`]); an `any` precondition is answered with a
    /// stat, because existence is the only fact it asks for; and `absent` is a
    /// contradiction its callers refuse before they get here, answered rather
    /// than panicked on so a future variant reaching it cannot take the daemon
    /// down.
    ///
    /// An absent target is never a silent success: a caller moving or deleting
    /// something that is already gone had a wrong model of the vault and should
    /// hear so.
    fn require_regular_file(
        &self,
        path: &VaultPath,
        resolved: &Path,
        expected: &Precondition,
    ) -> Result<(), MutationError> {
        let present = match expected {
            Precondition::Revision(wanted) => match self.streamed_revision(path, resolved)? {
                None => return Err(MutationError::NotFound { path: path.clone() }),
                Some(actual) if &actual == wanted => true,
                Some(actual) => {
                    return Err(MutationError::RevisionConflict {
                        path: path.clone(),
                        current: Some(actual),
                    });
                }
            },
            Precondition::Any => self.regular_file_exists(path, resolved)?,
            Precondition::Absent => {
                return Err(MutationError::InvalidPrecondition {
                    expected: expected.clone(),
                });
            }
        };
        if !present {
            return Err(MutationError::NotFound { path: path.clone() });
        }
        Ok(())
    }

    /// The on-disk revision of a regular file at `resolved`, hashed in bounded
    /// chunks, or `None` when nothing is there.
    ///
    /// [`MutationEngine::check_resolved`] hands back the bytes it read because
    /// `patch_frontmatter` and `copy_file` need them; a delete never does, and
    /// reading a 4 GB attachment into the daemon's address space to compare one
    /// revision string would turn the M3 decision — "the payload cap does not
    /// govern a delete" — into "a delete is unbounded in memory". Streaming
    /// keeps both halves: nothing is refused for its size, and nothing larger
    /// than the buffer is held.
    ///
    /// The refusals are the same ones the reading path makes: a non-regular
    /// occupant is [`MutationError::TargetExists`], and a file that vanishes
    /// between the stat and the open is an absence the caller's precondition
    /// judges.
    fn streamed_revision(
        &self,
        path: &VaultPath,
        resolved: &Path,
    ) -> Result<Option<String>, MutationError> {
        if !self.regular_file_exists(path, resolved)? {
            return Ok(None);
        }
        let mut file = match std::fs::File::open(resolved) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(io)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        // The same spelling `revision_of` produces, so a streamed revision and
        // a buffered one are comparable strings.
        Ok(Some(format!("blake3:{}", hasher.finalize())))
    }

    /// Dispose of one already-resolved path. `TrashLocal` moves it into the
    /// vault's own `.trash/`, numbering the name on collision the way
    /// Obsidian does; `TrashSystem` hands it to the platform trash;
    /// `Permanent` unlinks it.
    fn dispose(&self, resolved: &Path, mode: DeleteMode) -> Result<(), MutationError> {
        match mode {
            DeleteMode::Permanent => {
                if resolved.is_dir() {
                    std::fs::remove_dir_all(resolved).map_err(io)
                } else {
                    std::fs::remove_file(resolved).map_err(io)
                }
            }
            DeleteMode::TrashSystem => trash::delete(resolved).map_err(|error| MutationError::Io {
                message: error.to_string(),
            }),
            DeleteMode::TrashLocal => {
                let trash = self.canonical_root.join(LOCAL_TRASH);
                std::fs::create_dir_all(&trash).map_err(io)?;
                let name = resolved
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| MutationError::Io {
                        message: format!("{} has no usable file name", resolved.display()),
                    })?;
                let (stem, extension) = match name.rsplit_once('.') {
                    Some((stem, extension)) => (stem, format!(".{extension}")),
                    None => (name, String::new()),
                };
                let mut candidate = trash.join(name);
                let mut suffix = 1u32;
                while candidate.exists() {
                    candidate = trash.join(format!("{stem} {suffix}{extension}"));
                    suffix += 1;
                }
                std::fs::rename(resolved, &candidate).map_err(io)
            }
        }
    }

    /// Whether anything the filesystem would reach under this name is already
    /// there — the name itself, or a stored name that folds onto it.
    ///
    /// Both halves are needed and neither subsumes the other. `exists` answers
    /// through the platform's own folding, so on APFS it already reports
    /// `Two.md` when asked about `two.md`; the case scan answers from the
    /// parent's *stored names*, which is the only thing that sees the collision
    /// on a case-sensitive volume where both spellings could legally coexist.
    /// Used by the suffix policy, where a folded name is not a refusal but
    /// simply not free.
    fn is_occupied(&self, resolved: &Path) -> Result<bool, MutationError> {
        if resolved.exists() {
            return Ok(true);
        }
        Ok(self.case_scan(resolved)?.variant.is_some())
    }

    /// Copy one vault file — a note or an attachment — to a new path.
    ///
    /// Never overwrites. `CopyConflict::Error` refuses an occupied
    /// destination; `CopyConflict::Suffix` numbers past it the way Obsidian's
    /// `getAvailablePath` does.
    ///
    /// **The payload cap does not govern a copy**, for the reason it does not
    /// govern a delete (see [`DEFAULT_MAX_FILE_BYTES`]): none of these bytes
    /// cross the wire, so there is no line-delimited reader to strain, and a
    /// cap here would make an attachment larger than it permanently uncopyable
    /// through vaultd — a refusal with no remedy. The bytes are streamed
    /// through a bounded buffer instead, so nothing is refused for its size and
    /// nothing larger than the buffer is ever held.
    fn copy_file(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        expected_source: &Precondition,
        if_exists: CopyConflict,
    ) -> Result<MutationOutcome, MutationError> {
        // Both ends, on the caller's own spelling, before the filesystem is
        // touched: a path the scan never lists is a path this operation cannot
        // address in either direction, and `.trash/Gone.md` must be refused as
        // a zone violation rather than reported as merely absent.
        if is_unindexable(from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if is_unindexable(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        // An `absent` precondition on the *source* of a copy is a
        // contradiction: it asks for nothing to be there, and there would then
        // be nothing to copy. The spec's validity table says the same —
        // `copy_file` (source) accepts `revision` or `any`, never `absent`.
        if expected_source == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected_source.clone(),
            });
        }
        let source = self.resolve(from)?;
        // A symlink is not the file it points at, and here that is a
        // containment hole rather than a philosophical point. `resolve`
        // canonicalizes only the *parent* and appends the caller's final
        // component unresolved, because a mutation target need not exist yet —
        // so a link planted at the final component keeps its own innocent name
        // through `stored_path`, and the stored-spelling zone check below sees
        // `Bait.md` rather than the `.obsidian/plugins/…/data.json` it points
        // at, while `metadata` and `File::open` follow it happily. A copy
        // through such a link lands unindexable bytes at an indexed path and
        // reports them as semantic. Only `symlink_metadata`, which does not
        // follow, can tell the two apart.
        //
        // The refusal is total rather than conditional on where the link goes,
        // which also settles what a symlinked source means for this verb:
        // `rename_paths` refuses one, so `copy_file` refuses one, and the two
        // movement verbs cannot disagree. Copying *through* a link to an
        // ordinary indexed file would be a defensible answer on its own, but it
        // is not worth a second rule about links, and a caller who wants the
        // target's bytes can name the target.
        match std::fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MutationError::TargetExists { path: from.clone() });
            }
            Ok(_) => {}
            // Absent is the ordinary `not_found` below, and every other error
            // is the filesystem's own.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io(error)),
        }
        let stored_from = self.stored_path(from, &source)?;
        if is_unindexable(&stored_from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        // The same guard the other verbs carry, in the same position: on a
        // case-folding filesystem a folded source spelling reads a file the
        // caller never named, and the copy would then reproduce *that* file
        // under a name the caller chose for a different one.
        if let Some(existing) = self.case_collision_at(&source)? {
            return Err(MutationError::CaseCollision {
                path: from.clone(),
                existing,
            });
        }
        // A directory is refused here as `TargetExists` — "something else
        // occupies this name" — rather than reaching an `EISDIR` from the read,
        // which would tell a client the daemon is broken and invite a retry
        // that can never succeed.
        if !self.regular_file_exists(from, &source)? {
            return Err(MutationError::NotFound { path: from.clone() });
        }

        let mut destination_path = to.clone();
        let mut destination = self.resolve(&destination_path)?;
        match if_exists {
            CopyConflict::Error => {
                // The case check comes before the existence check, and the
                // order is load-bearing. On a case-folding filesystem
                // `two.md` "exists" because `Two.md` does, so `target_exists`
                // would name a path this vault does not store while the real
                // hazard — a write landing on `Two.md` — went unnamed.
                if let Some(existing) = self.case_collision_at(&destination)? {
                    return Err(MutationError::CaseCollision {
                        path: to.clone(),
                        existing,
                    });
                }
                if destination.exists() {
                    return Err(MutationError::TargetExists { path: to.clone() });
                }
            }
            CopyConflict::Suffix => {
                if self.is_occupied(&destination)? {
                    destination_path = available_sibling(to, |candidate| {
                        let resolved = self.resolve(candidate)?;
                        self.is_occupied(&resolved)
                    })?;
                    destination = self.resolve(&destination_path)?;
                }
            }
        }
        // And the stored half of the destination guard, which nothing lexical
        // can stand in for: a symlink named `Link` pointing at `.obsidian`
        // carries no dot and names no zone until it is resolved.
        let stored_to = self.stored_path(&destination_path, &destination)?;
        if is_unindexable(&stored_to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }

        // The same window `recheck` opens for the two note writers, opened
        // here by hand — and *only* the rendezvous, not a second `check`.
        // `stream_copy` already re-verifies: it hashes exactly the bytes it
        // read and refuses before persisting, so a source rewritten from this
        // point is caught with no extra read. Calling `recheck` would instead
        // pull the whole source into memory, which is precisely the guarantee
        // this verb documents it does not break — an attachment larger than
        // the buffer is streamed, never held.
        self.reach(crate::HookPoint::AfterMutationPrecondition);
        let revision = self.stream_copy(&source, &destination, expected_source, from)?;
        let written = self.written_path(&destination_path, &destination, stored_to);
        let semantic = written.is_markdown();
        Ok(MutationOutcome {
            // Ruling B4: the destination is a new tree row whatever its
            // extension, and a created path the outcome does not name is a row
            // that never lands. `semantic` is the independent fact — read off
            // the destination, per the `MutationOutcome::semantic` table.
            changed_paths: BTreeSet::from([written]),
            revision: Some(revision),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic,
        })
    }

    /// Stream `source`'s bytes into a temporary beside `destination`, hashing
    /// them on the way, and rename it over `destination` once the precondition
    /// has been checked against what was actually read.
    ///
    /// One pass, not two, and the reason is correctness rather than speed: a
    /// separate verify-then-copy would hash bytes the copy did not necessarily
    /// carry, so the revision handed back could describe a file that changed in
    /// between. Here the revision returned is the hash of exactly the bytes
    /// that landed.
    ///
    /// A failed precondition drops the temporary unpersisted, so the refusal
    /// leaves the vault byte-identical: the temporary is never the destination
    /// until `persist` makes it so, which is the same atomicity
    /// [`write_atomically`] provides, and it carries the same `.vaultd-` prefix
    /// with no extension so the scanner can never mistake it for a note.
    ///
    /// The price of the single pass, stated rather than discovered: a copy that
    /// is going to be refused still writes the source's size to disk first, in
    /// the destination's own directory, and reclaims it immediately. On a
    /// nearly-full volume a large copy that would have ended in
    /// `revision_conflict` can therefore surface as an `Io` ENOSPC instead.
    /// That is the better of the two failures — a wrong revision is a token the
    /// client would go on to trust, and a full disk is a fact it can act on.
    fn stream_copy(
        &self,
        source: &Path,
        destination: &Path,
        expected: &Precondition,
        from: &VaultPath,
    ) -> Result<String, MutationError> {
        let directory = destination.parent().ok_or_else(|| MutationError::Io {
            message: format!("{} has no parent directory", destination.display()),
        })?;
        let mut reader = match std::fs::File::open(source) {
            Ok(file) => file,
            // Removed between the stat above and this open: still absence, and
            // the caller hears the same `not_found` either way.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::NotFound { path: from.clone() });
            }
            Err(error) => return Err(io(error)),
        };
        let mut temporary = tempfile::Builder::new()
            .prefix(".vaultd-")
            .tempfile_in(directory)
            .map_err(io)?;
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer).map_err(io)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            temporary.write_all(&buffer[..read]).map_err(io)?;
        }
        // The same spelling `revision_of` produces, so a streamed revision and
        // a buffered one are comparable strings.
        let revision = format!("blake3:{}", hasher.finalize());
        match expected {
            Precondition::Revision(wanted) if wanted != &revision => {
                return Err(MutationError::RevisionConflict {
                    path: from.clone(),
                    current: Some(revision),
                });
            }
            _ => {}
        }
        // The destination does not exist — every branch above refused an
        // occupied one — so this takes the containing folder's implied mode
        // rather than `tempfile`'s owner-only default.
        adopt_permissions(destination, temporary.as_file())?;
        temporary.as_file().sync_all().map_err(io)?;
        temporary
            .persist(destination)
            .map_err(|error| MutationError::Io {
                message: error.error.to_string(),
            })?;
        Ok(revision)
    }

    /// Move one file — a note or an attachment — under a precondition.
    ///
    /// The engine half of `rename_note`: it moves bytes and reports what moved.
    /// Link repair is the coordinator's, and `rewrite_links` never reaches
    /// here.
    fn rename_note(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if is_unindexable(from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if is_unindexable(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        // Per the spec's validity table: `rename_note` accepts `revision` or
        // `any`, never `absent` — a precondition asking for the source not to
        // exist cannot guard a move of it.
        if expected == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected.clone(),
            });
        }
        let resolved = self.resolve(from)?;
        // Before the precondition, because on a case-folding filesystem the
        // precondition itself folds: a `revision` naming `One.md`'s bytes would
        // *pass* for a caller who spelled `one.md`, and the move would then
        // take a file the caller never addressed.
        self.guard_source_case(from, to, &resolved)?;
        // `regular_file_exists` inside refuses a directory as `TargetExists`,
        // which is what keeps the note verb off a folder: the same
        // `std::fs::rename` would happily move one, and the outcome would then
        // report a revision for something that has no bytes.
        self.require_regular_file(from, &resolved, expected)?;

        let changed_paths = self.rename_paths(from, to)?;
        let semantic = changed_paths.iter().any(VaultPath::is_markdown);
        // Read after the move, from the file that is now there. Any failure is
        // swallowed rather than propagated, for `written_path`'s reason: the
        // move already landed, and a mutation that succeeded must never be
        // reported to the caller as a failure. The revision is informational;
        // the move is the operation.
        let revision = self
            .resolve(to)
            .and_then(|destination| self.streamed_revision(to, &destination))
            .ok()
            .flatten();
        Ok(MutationOutcome {
            changed_paths,
            revision,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic,
        })
    }

    /// Move a folder and everything under it.
    ///
    /// Guarded like `delete_folder`, and for the same reason turned around:
    /// without the folder-shaped guard a rename becomes the way to *create*
    /// and to *reach* exactly what `create_folder` and `delete_folder` refuse
    /// — `.git`, `.trash`, the configuration zone.
    fn rename_folder(
        &self,
        from: &VaultPath,
        to: &VaultPath,
    ) -> Result<MutationOutcome, MutationError> {
        if is_unindexable_folder(from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if is_unindexable_folder(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        let resolved = self.resolve(from)?;
        // The same three-way answer `delete_folder` gives, for the same
        // reasons: a symlink is not the folder it points at, and a file is not
        // a folder at all.
        match std::fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MutationError::TargetExists { path: from.clone() });
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(MutationError::NotFound { path: from.clone() });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::NotFound { path: from.clone() });
            }
            Err(error) => return Err(io(error)),
        }
        let changed_paths = self.rename_paths(from, to)?;
        Ok(MutationOutcome {
            // Read off the Markdown subset, not off `changed_paths`, per the
            // `MutationOutcome::semantic` table: a folder of attachments moves
            // every tree row under it and no semantic row at all.
            semantic: changed_paths.iter().any(VaultPath::is_markdown),
            changed_paths,
            // A folder has no bytes to hash, so it reports no revision — never
            // an empty string. The wire's `RenameResponse.revision` is optional
            // for exactly this.
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
        })
    }

    /// The case guard a rename applies to its **source**, with the one
    /// exemption a case-only rename needs.
    ///
    /// Ordinarily a folded source spelling is refused exactly as it is for a
    /// delete: `one.md` beside a stored `One.md` names a file this vault does
    /// not hold, and moving the stored one instead would move a file the caller
    /// never addressed. A case-only rename is the deliberate exception. There
    /// the fold *is* the operation — the caller is asking for `One.md` to
    /// become `ONE.md`, and on a case-insensitive filesystem the source and the
    /// destination are the same file — so refusing the fold would refuse the
    /// only spelling in which the request can be made.
    fn guard_source_case(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        resolved: &Path,
    ) -> Result<(), MutationError> {
        if is_case_only_rename(from, to) {
            return Ok(());
        }
        match self.case_collision_at(resolved)? {
            Some(existing) => Err(MutationError::CaseCollision {
                path: from.clone(),
                existing,
            }),
            None => Ok(()),
        }
    }

    /// Move `from` to `to` and report **every** path whose state moved: the
    /// vacated spellings and the occupied ones, of every kind. Works for a file
    /// or a folder — the only difference is how many paths come back.
    ///
    /// This is the movement primitive Task 12 calls after it has rewritten the
    /// referrers, so it carries its own guards rather than trusting the arm
    /// above it: a direct caller gets the same refusals. Nothing here knows
    /// about links.
    ///
    /// Refuses an existing destination outright: there is no
    /// overwrite-on-rename, and a mover who means replace must delete first,
    /// visibly. A case-only rename (`One.md` to `ONE.md`) is the one exception,
    /// and goes through a temporary name because on a case-insensitive
    /// filesystem the source and destination are the same file.
    ///
    /// Every path it reports is spelled the way the filesystem stores it, per
    /// `MutationOutcome::changed_paths`. The source side is captured *before*
    /// the move, because afterwards there is nothing left to canonicalize and
    /// the caller's own spelling would reach the index as a key the scanner
    /// never emits.
    pub fn rename_paths(
        &self,
        from: &VaultPath,
        to: &VaultPath,
    ) -> Result<BTreeSet<VaultPath>, MutationError> {
        if self.read_only {
            return Err(MutationError::ReadOnly);
        }
        if is_unindexable(from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if is_unindexable(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        let source = self.resolve(from)?;
        // A symlink is not the thing it points at. `std::fs::rename` moves the
        // link while `paths_under` walks the link's *target*, so a rename
        // through one would report the target's notes as moved while every one
        // of them stayed exactly where it was — a hint that lies in the most
        // expensive direction. Refused, so the caller says what it means.
        let metadata = match std::fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MutationError::TargetExists { path: from.clone() });
            }
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::NotFound { path: from.clone() });
            }
            Err(error) => return Err(io(error)),
        };
        let source_is_dir = metadata.is_dir();
        // The folder-shaped half of the guard, which `is_unindexable` cannot
        // give: `VaultPath::is_hidden` never judges the last component, because
        // nothing lexical tells a hidden *file* from a hidden *directory*. A
        // rename that knows its target is a directory applies it itself, or a
        // rename becomes the way to create `.git` and to move `.trash` out into
        // the open.
        if source_is_dir && is_unindexable_folder(from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if source_is_dir && is_unindexable_folder(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }

        let case_only = is_case_only_rename(from, to);
        if !case_only {
            if let Some(existing) = self.case_collision_at(&source)? {
                return Err(MutationError::CaseCollision {
                    path: from.clone(),
                    existing,
                });
            }
        }
        // The case-only exemption is the one place in the engine where a folded
        // caller spelling gets this far, so it is worth stating why that is
        // safe: `captured_path` canonicalizes, `canonicalize` is `realpath(3)`,
        // and on APFS that returns the *stored* case of every component. A
        // caller who spelled `one.md` therefore still has `One.md` reported as
        // the vacated path, which is the spelling the scanner emits.
        let stored_from = self.captured_path(from, &source)?;
        if is_unindexable(&stored_from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }
        if source_is_dir && is_unindexable_folder(&stored_from) {
            return Err(MutationError::ZoneViolation { path: from.clone() });
        }

        let destination = self.resolve(to)?;
        let stored_to = self.stored_path(to, &destination)?;
        if is_unindexable(&stored_to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        if source_is_dir && is_unindexable_folder(&stored_to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        // A folder cannot become its own descendant. The kernel refuses that
        // rename with `EINVAL`, which would reach a client as
        // `storage_failure` — a claim the daemon is broken and an invitation to
        // retry a request that can never succeed. Refused before the syscall
        // instead.
        //
        // `ZoneViolation` is the least-wrong code, not a right one, and is
        // recorded as a compromise: no zone is involved here. Its message
        // already reads "is outside the vault, **or is not a valid target for
        // this operation**", which is the half that applies, but the wire code
        // it maps to is `zone_violation` where `invalid_request` — where
        // `InvalidPrecondition` and `OverlappingPatch` land — is the truer
        // answer. `MutationError` carries no "invalid target" variant, and
        // adding one costs a `convert.rs` row and a protocol conversation this
        // task does not own. Revisit if a second such refusal appears.
        if stored_to
            .as_str()
            .starts_with(&format!("{}/", stored_from.as_str()))
        {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        if !case_only {
            // Case before existence, for the reason `copy_file` gives: on a
            // case-folding filesystem `two.md` "exists" because `Two.md` does,
            // and `target_exists` would name a path this vault does not store.
            if let Some(existing) = self.case_collision_at(&destination)? {
                return Err(MutationError::CaseCollision {
                    path: to.clone(),
                    existing,
                });
            }
            if destination.exists() {
                return Err(MutationError::TargetExists { path: to.clone() });
            }
        }

        // Enumerated *before* the move, under the stored spelling, per Ruling
        // B4: every path that leaves its old location has to reach
        // reconciliation, or its rows describe a path that is no longer there.
        // Attachments and subfolders included — the index has held a row per
        // tree entry since the tree pre-task.
        let mut changed: BTreeSet<VaultPath> = BTreeSet::new();
        if source_is_dir {
            changed.extend(paths_under(&self.canonical_root, &stored_from)?);
        }
        changed.insert(stored_from);

        if case_only {
            staged_rename(&source, &destination, |from, to| std::fs::rename(from, to))?;
        } else {
            std::fs::rename(&source, &destination).map_err(io)?;
        }

        // And the occupied side, canonicalized *after* the move for the reason
        // `written_path` gives: a Unicode normalization difference survives
        // every check before the write, and only a full canonicalize settles
        // it.
        let written_to = self.written_path(to, &destination, stored_to);
        if source_is_dir {
            changed.extend(paths_under(&self.canonical_root, &written_to)?);
        }
        changed.insert(written_to);
        Ok(changed)
    }
}

/// Whether these two spellings differ only in case, which is the one rename a
/// case-insensitive filesystem cannot serve directly.
fn is_case_only_rename(from: &VaultPath, to: &VaultPath) -> bool {
    from.as_str() != to.as_str() && from.as_str().to_lowercase() == to.as_str().to_lowercase()
}

/// Move `source` to `destination` via an intermediate name, for the case-only
/// rename a case-insensitive filesystem cannot serve directly: there the two
/// paths address the same file, so a direct rename is either a no-op or a
/// refusal.
///
/// **The intermediate is a sibling *name*, never a container.** An earlier
/// draft staged into a `tempfile::TempDir`, whose `Drop` runs `remove_dir_all`
/// — so a failing second rename took the `?`, dropped the directory, and
/// deleted the only copy of the file, and a crash between the two renames left
/// the note inside a dot-prefixed directory the scanner never enumerates and
/// nothing sweeps. A sibling name has neither property. The worst case here is
/// that the file sits in its own directory under a `.vaultd-` name: visible to
/// anyone looking, trivially renamed back by hand, and never destroyed.
///
/// The failure ladder, in order:
///
/// 1. The first rename fails — nothing has moved, the placeholder is removed,
///    and the vault is untouched.
/// 2. The second rename fails — the file is renamed **back** to `source`, and
///    the caller gets the second rename's error. The vault is untouched.
/// 3. The restore also fails — the file stays under the staging name and the
///    error says so, naming the path, because that is the one thing a caller
///    cannot work out for themselves.
///
/// The name carries the `.vaultd-` prefix and no extension for the reason
/// [`write_atomically`]'s temporary does: `FileSystemVaultSource` enumerates
/// only `*.md`, so the intermediate is never mistaken for a note even in the
/// microseconds it exists, and never produces a spurious generation pair.
///
/// `rename` is injected so the second-rename failure — which no case-folding
/// filesystem will produce on demand — can be exercised as a unit test, the
/// same treatment `collision()` gets for the listing APFS cannot hold.
fn staged_rename(
    source: &Path,
    destination: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), MutationError> {
    let directory = source.parent().ok_or_else(|| MutationError::Io {
        message: format!("{} has no parent directory", source.display()),
    })?;
    // Reserved by creating it, so a concurrent writer cannot pick the same
    // name — and reserved *as the same kind as the source*, because POSIX
    // `rename` will not put a directory over a regular file (`ENOTDIR`) or a
    // regular file over a directory (`EISDIR`). An empty directory is a legal
    // destination for a directory rename, and a regular file for a file one, so
    // matching the kind keeps the reservation without costing a syscall.
    //
    // `keep` then disarms `tempfile`'s own delete-on-drop in both cases. That
    // is the whole point: after the first rename that path holds the caller's
    // file, and `TempDir`'s drop in particular is `remove_dir_all` — the
    // deletion this function exists to prevent.
    let source_is_dir = std::fs::symlink_metadata(source).map_err(io)?.is_dir();
    let mut builder = tempfile::Builder::new();
    let builder = builder.prefix(".vaultd-");
    let staged = if source_is_dir {
        builder.tempdir_in(directory).map_err(io)?.keep()
    } else {
        builder
            .tempfile_in(directory)
            .map_err(io)?
            .into_temp_path()
            .keep()
            .map_err(|error| MutationError::Io {
                message: error.error.to_string(),
            })?
    };
    if let Err(error) = rename(source, &staged) {
        // Still the untouched placeholder, so exactly one of these applies.
        let _ = std::fs::remove_file(&staged).or_else(|_| std::fs::remove_dir(&staged));
        return Err(io(error));
    }
    if let Err(error) = rename(&staged, destination) {
        return match rename(&staged, source) {
            Ok(()) => Err(io(error)),
            Err(_) => Err(MutationError::Io {
                message: format!(
                    "{error}; {} could not be restored and is left at {}",
                    source.display(),
                    staged.display()
                ),
            }),
        };
    }
    Ok(())
}

/// The first `name N.ext` spelling beside `path` that `occupied` says is free,
/// matching Obsidian's `getAvailablePath` numbering.
///
/// The number goes on the **file name**, never on the path: a dot in a folder
/// segment (`v1.0/Note`) is not an extension separator, and splitting the whole
/// string on its last dot would produce `v1 1.0/Note`. A leading dot is not one
/// either — `.env` numbers as `.env 1`, not as ` 1.env`.
fn available_sibling(
    path: &VaultPath,
    occupied: impl Fn(&VaultPath) -> Result<bool, MutationError>,
) -> Result<VaultPath, MutationError> {
    let text = path.as_str();
    let (folder, name) = match text.rsplit_once('/') {
        Some((folder, name)) => (format!("{folder}/"), name),
        None => (String::new(), text),
    };
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for suffix in 1u32..10_000 {
        let candidate = VaultPath::new(format!("{folder}{stem} {suffix}{extension}"))
            .map_err(|_| MutationError::ZoneViolation { path: path.clone() })?;
        if !occupied(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(MutationError::TargetExists { path: path.clone() })
}

/// Every path under `folder`, of every kind — notes, attachments, and the
/// subfolders holding them — vault-relative, not including `folder` itself.
///
/// The extension is not filtered, per Ruling B4: the index has held a row per
/// tree entry since the tree pre-task, so an attachment or a subfolder a
/// folder delete removes without naming is a row that outlives the file it
/// describes. A caller that wants only the notes filters on
/// [`VaultPath::is_markdown`] — which is what `delete_folder` does to decide
/// whether the delete was semantic.
///
/// The scanner's hidden-directory rule is mirrored, so a `.trash` or `.git`
/// nested inside a deleted folder contributes no paths: the scan never emitted
/// rows for them, and `refresh_paths` skips them, so naming them would be
/// noise rather than a hint.
///
/// `folder` must be the spelling the filesystem stores, not the one a caller
/// sent: the walk starts at `root.join(folder)` and every path it yields keeps
/// that prefix verbatim, so a caller's `folder/` against a stored `Folder/`
/// would key every removed path under a name no scan emits.
pub(crate) fn paths_under(
    root: &Path,
    folder: &VaultPath,
) -> Result<Vec<VaultPath>, MutationError> {
    let mut found = Vec::new();
    let base = root.join(folder.as_str());
    let walker = walkdir::WalkDir::new(&base)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                return true;
            }
            !entry.file_name().to_string_lossy().starts_with('.')
        });
    for entry in walker {
        let entry = entry.map_err(|error| MutationError::Io {
            message: error.to_string(),
        })?;
        // Depth 0 is `folder` itself, which its caller names.
        if entry.depth() == 0 {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let mut parts = Vec::new();
        for component in relative.components() {
            match component.as_os_str().to_str() {
                Some(text) => parts.push(text.to_string()),
                // A component this platform lets exist and `VaultPath` cannot
                // spell. The whole entry is skipped, not truncated to the
                // prefix collected so far: reporting `Folder` for a file at
                // `Folder/<non-utf8>` would name a path that was not removed.
                None => {
                    parts.clear();
                    break;
                }
            }
        }
        if parts.is_empty() {
            continue;
        }
        if let Ok(path) = VaultPath::new(parts.join("/")) {
            found.push(path);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(listing: &[&str]) -> Vec<String> {
        listing.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn a_differently_cased_stored_name_is_a_variant() {
        let scan = classify_names(names(&["One.md", "Two.md"]), "one.md");
        assert!(!scan.exact);
        assert_eq!(scan.variant.as_deref(), Some("One.md"));
    }

    /// The state only a case-sensitive filesystem can hold, and the reason
    /// `case_collision` carries the qualifier: the caller's spelling names its
    /// own stored file, so nothing folds and nothing is at risk. Refusing here
    /// would lock both files out of vaultd permanently.
    #[test]
    fn an_exact_stored_name_beside_a_variant_is_not_a_collision() {
        let scan = classify_names(names(&["One.md", "one.md"]), "one.md");
        assert!(scan.exact);
        assert_eq!(scan.variant.as_deref(), Some("One.md"));
    }

    /// The classification tests above pin what the listing *says*; these pin
    /// what the engine *decides* from it. The exact-match arm is the whole of
    /// finding I1 — without it, a case-sensitive volume holding both spellings
    /// locks each of them out of vaultd permanently — and no test on a
    /// case-insensitive machine can reach it through the filesystem.
    #[test]
    fn a_variant_with_no_exact_match_is_the_collision() {
        assert_eq!(
            collision(CaseScan {
                exact: false,
                variant: Some("One.md".to_string()),
            })
            .as_deref(),
            Some("One.md")
        );
    }

    #[test]
    fn a_variant_beside_the_callers_own_stored_name_is_not_a_collision() {
        assert_eq!(
            collision(CaseScan {
                exact: true,
                variant: Some("One.md".to_string()),
            }),
            None,
            "the caller's spelling names its own file; nothing folds"
        );
    }

    #[test]
    fn no_variant_is_never_a_collision() {
        assert_eq!(
            collision(CaseScan {
                exact: true,
                variant: None,
            }),
            None
        );
        assert_eq!(collision(CaseScan::default()), None);
    }

    #[test]
    fn unrelated_names_are_neither() {
        assert_eq!(
            classify_names(names(&["Two.md", "Three.md"]), "one.md"),
            CaseScan::default()
        );
    }

    /// Documented Task 4 semantics, restated as a test now that two callers
    /// read the same scan: normalization variants are the same file on APFS,
    /// so they are deliberately not reported as distinct stored names.
    #[test]
    fn a_normalization_variant_is_not_a_case_variant() {
        let scan = classify_names(names(&["Cafe\u{301}.md"]), "Caf\u{e9}.md");
        assert_eq!(scan, CaseScan::default());
    }

    fn vault_path(spelling: &str) -> VaultPath {
        VaultPath::new(spelling).expect("valid vault path")
    }

    /// The same treatment `collision()` gets, and for the same reason: the
    /// decision is pinned here even where the filesystem cannot be made to
    /// exercise it. On a case-folding volume no outcome-level assertion can
    /// tell a two-step rename from a direct one, so what this function *decides*
    /// is the only thing a test can hold.
    #[test]
    fn only_a_difference_of_case_is_a_case_only_rename() {
        for (from, to) in [
            ("One.md", "ONE.md"),
            ("ONE.md", "One.md"),
            ("one.md", "ONE.md"),
            ("Folder/Three.md", "folder/Three.md"),
            ("Folder", "FOLDER"),
        ] {
            assert!(
                is_case_only_rename(&vault_path(from), &vault_path(to)),
                "{from} -> {to} differs only in case"
            );
        }
        for (from, to) in [
            // Identical is not a *rename*, and must not take the exemption:
            // taking it would skip the destination checks and let a rename onto
            // itself through unexamined.
            ("One.md", "One.md"),
            ("One.md", "Two.md"),
            ("One.md", "ONE.markdown"),
            ("Folder/One.md", "Folder/ONE.mdx"),
            // A move that also changes case is not case-only: the destination
            // is a genuinely different name and must face every check.
            ("Folder/One.md", "Deep/ONE.md"),
        ] {
            assert!(
                !is_case_only_rename(&vault_path(from), &vault_path(to)),
                "{from} -> {to} is not a case-only rename"
            );
        }
    }

    /// The numbering rule, pinned as a function so the shapes that matter can
    /// be asserted without staging a file for each: the number goes on the
    /// file name, a dot in a folder segment is not an extension separator, and
    /// a leading dot is not one either.
    #[test]
    fn the_suffix_numbering_names_the_file_and_not_the_path() {
        let free = |_: &VaultPath| Ok(false);
        for (path, expected) in [
            ("Two.md", "Two 1.md"),
            ("Plain", "Plain 1"),
            ("a.b.md", "a.b 1.md"),
            (".env", ".env 1"),
            ("Folder/One.md", "Folder/One 1.md"),
            // The dot belongs to the folder; splitting the whole string on its
            // last dot would answer `v1 1.0/Note`.
            ("v1.0/Note", "v1.0/Note 1"),
            ("v1.0/Note.md", "v1.0/Note 1.md"),
        ] {
            assert_eq!(
                available_sibling(&vault_path(path), free)
                    .expect("a free name")
                    .as_str(),
                expected
            );
        }
    }

    #[test]
    fn the_suffix_numbering_counts_past_every_occupied_name() {
        let taken = |candidate: &VaultPath| {
            Ok(["Two 1.md", "Two 2.md", "Two 3.md"].contains(&candidate.as_str()))
        };
        assert_eq!(
            available_sibling(&vault_path("Two.md"), taken)
                .expect("a free name")
                .as_str(),
            "Two 4.md"
        );
        // And it gives up rather than looping forever when nothing is free.
        assert!(matches!(
            available_sibling(&vault_path("Two.md"), |_| Ok(true)).expect_err("nothing is free"),
            MutationError::TargetExists { .. }
        ));
    }

    /// The failure ladder `staged_rename`'s doc describes, exercised through
    /// the injected rename because no case-folding filesystem will fail a
    /// second rename on demand. The first case is the one that used to destroy
    /// the file: staging into a `TempDir` whose `Drop` is `remove_dir_all`
    /// meant a failing second rename deleted the only copy.
    #[test]
    fn a_failing_second_rename_restores_the_original_name() {
        let directory = tempfile::TempDir::new().expect("tempdir");
        let source = directory.path().join("One.md");
        let destination = directory.path().join("ONE.md");
        std::fs::write(&source, "# One\n").expect("write One");

        let mut calls = std::cell::Cell::new(0u32);
        let error = staged_rename(&source, &destination, |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                return Err(std::io::Error::other("the second rename fails"));
            }
            std::fs::rename(from, to)
        })
        .expect_err("the second rename failed");
        assert!(matches!(error, MutationError::Io { .. }), "{error:?}");
        assert_eq!(
            calls.get_mut(),
            &mut 3,
            "first, failed second, then restore"
        );
        assert_eq!(
            std::fs::read(&source).expect("the file is back under its own name"),
            b"# One\n",
            "a failing second rename must never destroy the file"
        );
        let staged: Vec<String> = std::fs::read_dir(directory.path())
            .expect("read the directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".vaultd-"))
            .collect();
        assert!(
            staged.is_empty(),
            "no staging name is left behind: {staged:?}"
        );
    }

    /// The bottom rung: even when the restore fails too, the file is still a
    /// visible entry in its own directory under the staging name — never
    /// inside a container that deletes itself — and the error says where.
    #[test]
    fn a_failing_restore_leaves_the_file_visible_and_says_where() {
        let directory = tempfile::TempDir::new().expect("tempdir");
        let source = directory.path().join("One.md");
        let destination = directory.path().join("ONE.md");
        std::fs::write(&source, "# One\n").expect("write One");

        let calls = std::cell::Cell::new(0u32);
        let error = staged_rename(&source, &destination, |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() >= 2 {
                return Err(std::io::Error::other("every later rename fails"));
            }
            std::fs::rename(from, to)
        })
        .expect_err("the second rename and the restore both failed");
        let MutationError::Io { message } = &error else {
            panic!("expected an io refusal, got {error:?}");
        };
        assert!(
            message.contains(".vaultd-"),
            "the refusal must name where the file was left: {message}"
        );
        let staged: Vec<String> = std::fs::read_dir(directory.path())
            .expect("read the directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".vaultd-"))
            .collect();
        assert_eq!(staged.len(), 1, "the file is still there: {staged:?}");
        assert_eq!(
            std::fs::read(directory.path().join(&staged[0])).expect("read the staged file"),
            b"# One\n"
        );
    }

    /// And the ordinary path: the file arrives, and nothing is left over.
    #[test]
    fn a_staged_rename_leaves_no_intermediate_behind() {
        let directory = tempfile::TempDir::new().expect("tempdir");
        let source = directory.path().join("One.md");
        let destination = directory.path().join("Renamed.md");
        std::fs::write(&source, "# One\n").expect("write One");
        staged_rename(&source, &destination, |from, to| std::fs::rename(from, to))
            .expect("a staged rename");
        let names: Vec<String> = std::fs::read_dir(directory.path())
            .expect("read the directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["Renamed.md".to_string()], "{names:?}");
    }

    #[test]
    fn the_configuration_zone_is_unindexable_and_so_is_every_hidden_folder() {
        let unindexable = [
            ".obsidian",
            ".obsidian/app.json",
            ".trash/Gone.md",
            "a/.b/c.md",
            // Not the zone — `in_config_zone` requires the whole first
            // segment — but hidden, which the scan excludes just the same.
            ".obsidianish/Note.md",
        ];
        for spelling in unindexable {
            let path = VaultPath::new(spelling).expect("valid vault path");
            assert!(is_unindexable(&path), "{spelling} must be refused");
        }
        // A hidden *file* name is not excluded: only directories are, which is
        // why `VaultPath::is_hidden` deliberately ignores the last component.
        let indexable = ["obsidian/Note.md", "Folder/.hidden.md", "One.md"];
        for spelling in indexable {
            let path = VaultPath::new(spelling).expect("valid vault path");
            assert!(!is_unindexable(&path), "{spelling} is indexed by the scan");
        }
    }
}
