//! Where the socket lives, and what to do when something is already there.
//!
//! **The path rule is shared with the host and is the reason this module uses
//! SHA-256 rather than the `blake3` the index identity uses.** A client that
//! knows only the vault root must be able to compute the same path the daemon
//! bound, in Rust or in TypeScript, or "the daemon is found by them from the
//! vault path alone" is not true. The host's `vaultdSocketPathFor` is the
//! other half; `crates/vault-server/tests/socket_lifecycle.rs` and the host's
//! `supervisor-engine-mode-real-daemon.test.ts` pin them equal across the two
//! languages.
//!
//! **A file already at the path has four meanings and only one of them is
//! fatal.** A daemon that *answers there at all* means this process must not
//! start, because the writer lease will refuse it anyway and a confusing
//! `index_in_use` much later is worse than a clear refusal now. Answering is
//! the test, not answering *well*: a daemon one protocol version ahead replies
//! `incompatible_version` and is every bit as alive as one replying `ok`, and
//! stealing its socket would take a working daemon's door away. A socket file
//! nothing answers on is what a crashed daemon leaves, and is unlinked. A path
//! that is not a socket is refused untouched, because unlinking a file a
//! daemon did not create is not a daemon's business — and neither is
//! chmodding one, which is why the run directory is refused too when something
//! other than a directory is sitting at its name. Nothing there at all is the
//! ordinary case.
//!
//! **A path is a name, not an identity.** Between this process binding and
//! this process exiting, the directory entry it created can be removed and
//! replaced by somebody else's socket — by a racing daemon, a cleaner, or an
//! operator. So the listener records the `(device, inode)` it bound and
//! compares it before it unlinks or connects: it removes only its own socket,
//! and [`SocketListener::wake`] wakes only its own accept loop. Without that,
//! an ordinary late exit deletes a running daemon's door and leaves no error
//! anywhere.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The listen backlog: the depth of the kernel's queue of connections that
/// have completed their handshake and not yet been accepted. Sixteen, because
/// the accept loop does nothing but hand each one to a thread, so the queue is
/// a burst absorber rather than a work queue.
pub const LISTEN_BACKLOG: i32 = 16;

/// How long the liveness probe waits for an answer before calling the file
/// stale. Generous enough for a loaded machine, short enough that a daemon
/// start is not held up by a socket nobody owns.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// The `id` the probe sends, and one of the two ways an answer is recognised
/// as a response envelope rather than noise.
const PROBE_ID: &str = "vaultd-probe";

/// The longest socket path this platform's `sockaddr_un` holds, its NUL
/// terminator excluded: 103 bytes on Darwin, 107 on Linux. Read from the
/// struct rather than written as a literal, because the two differ and only
/// the header knows which one this build is.
const MAX_SOCKET_PATH_LEN: usize = std::mem::size_of::<libc::sockaddr_un>()
    - std::mem::offset_of!(libc::sockaddr_un, sun_path)
    - 1;

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("another vaultd is listening at {0}")]
    AlreadyListening(PathBuf),
    #[error("{0} exists and is not a socket")]
    NotASocket(PathBuf),
    #[error("the socket path is longer than this platform's {max} bytes: {path}")]
    PathTooLong { path: PathBuf, max: usize },
    #[error("cannot determine a run directory for the socket: {0}")]
    NoRunDir(String),
    #[error("cannot prepare {path}: {source}")]
    RunDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot bind {path}: {source}")]
    Bind {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// A stdio-only daemon failed. Nothing was bound and there is no path, so
    /// the message is carried through unchanged: an operator running without
    /// `--listen` sees exactly what that daemon has always printed.
    #[error("{0}")]
    Stdio(String),
}

/// The first 16 hex characters of the SHA-256 of the canonical vault root.
///
/// Sixteen and not more because a Unix domain socket address is capped at
/// about 104 bytes on Darwin and the run directory is already most of that;
/// sixteen and not fewer because 64 bits of a cryptographic hash is far past
/// any collision a single machine's vault list can produce.
///
/// **Contract: `canonical_vault_root` must be valid UTF-8.** Every caller's is
/// — `vault_index::canonical_root` refuses anything else — but this is a `pub
/// fn` over a bare `&Path`, so the guarantee belongs to today's caller and not
/// to the function. A non-UTF-8 path would be hashed as its replacement
/// characters and produce a socket name the host's `vaultdSocketPathFor` can
/// never reproduce, which is exactly the drift this module exists to prevent.
/// The `debug_assert!` makes that a test failure rather than a silent one.
pub fn socket_digest(canonical_vault_root: &Path) -> String {
    debug_assert!(
        canonical_vault_root.to_str().is_some(),
        "the vault root must be valid UTF-8 or the host cannot reproduce this digest: {}",
        canonical_vault_root.display()
    );
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical_vault_root.to_string_lossy().as_bytes());
    let full = format!("{:x}", hasher.finalize());
    full[..16].to_string()
}

/// The rule, with its two inputs passed in, so a test can exercise it without
/// mutating the process environment.
fn run_dir_from(runtime_dir: Option<&str>, cache_home: Option<&str>) -> PathBuf {
    match runtime_dir {
        Some(directory) if !directory.is_empty() => Path::new(directory).join("vaultd"),
        _ => Path::new(cache_home.unwrap_or(""))
            .join("vaultd")
            .join("run"),
    }
}

/// `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else
/// `<XDG cache dir>/vaultd/run`, beside the derived index.
pub fn run_dir() -> Result<PathBuf, ListenError> {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").ok();
    let runtime_dir = runtime_dir.as_deref().filter(|value| !value.is_empty());
    if let Some(directory) = runtime_dir {
        return Ok(run_dir_from(Some(directory), None));
    }
    let cache_home = xdg::BaseDirectories::new()
        .get_cache_home()
        .ok_or_else(|| ListenError::NoRunDir("no XDG cache directory".into()))?;
    let cache_home = cache_home
        .to_str()
        .ok_or_else(|| ListenError::NoRunDir("the XDG cache directory is not UTF-8".into()))?;
    Ok(run_dir_from(None, Some(cache_home)))
}

/// `<run dir>/<digest>.sock` — the path `--listen` with no value binds and
/// `get_vault_info` reports.
pub fn default_socket_path(canonical_vault_root: &Path) -> Result<PathBuf, ListenError> {
    Ok(run_dir()?.join(format!("{}.sock", socket_digest(canonical_vault_root))))
}

/// A bound listener that unlinks its own path when dropped — its own, and
/// nothing else's. See the `A path is a name, not an identity` paragraph at
/// the top of this module.
// `Debug` because the refusal tests read `SocketListener::bind(…).expect_err`,
// which needs the success side printable.
#[derive(Debug)]
pub struct SocketListener {
    listener: UnixListener,
    path: PathBuf,
    /// The `(device, inode)` of the socket file this listener created. A
    /// replacement bound at the same name cannot share it, so this is what
    /// tells "my socket" from "somebody else's socket with my name".
    identity: (u64, u64),
}

impl SocketListener {
    /// Prepare the directory, decide what to do about anything already at
    /// `path`, and bind.
    pub fn bind(path: &Path) -> Result<Self, ListenError> {
        // Before `prepare_parent`, not after: a run directory created and
        // chmodded for a path that can never bind is litter, and the operator
        // deserves to be told which of the two things went wrong.
        check_path_length(path)?;
        prepare_parent(path)?;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ListenError::Bind {
                    path: path.to_path_buf(),
                    source: error,
                });
            }
            Ok(metadata) => {
                if !metadata.file_type().is_socket() {
                    return Err(ListenError::NotASocket(path.to_path_buf()));
                }
                if something_answers(path) {
                    return Err(ListenError::AlreadyListening(path.to_path_buf()));
                }
                std::fs::remove_file(path).map_err(|source| ListenError::Bind {
                    path: path.to_path_buf(),
                    source,
                })?;
            }
        }
        let listener = bind_with_backlog(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |source| ListenError::Bind {
                path: path.to_path_buf(),
                source,
            },
        )?;
        let identity = std::fs::symlink_metadata(path)
            .map(|metadata| (metadata.dev(), metadata.ino()))
            .map_err(|source| ListenError::Bind {
                path: path.to_path_buf(),
                source,
            })?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            identity,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn accept(&self) -> std::io::Result<UnixStream> {
        self.listener.accept().map(|(stream, _address)| stream)
    }

    /// Wake a thread blocked in [`SocketListener::accept`] by connecting once
    /// and closing. Unlinking the path does **not** wake an `accept`, and
    /// there is no portable interrupt for one, so the shutdown path connects
    /// to itself and lets the accept loop notice the flag it set first.
    ///
    /// **It does nothing when the file at the path is no longer this
    /// listener's socket** — connecting then would wake somebody else's accept
    /// loop and leave this one blocked. Task 5's `stop` must therefore not
    /// treat `wake` as a guarantee that `accept` returns: it holds the `Arc`
    /// and sets `stopping` first, which keeps the ordinary path sound, and the
    /// join it does afterwards is the thing that would hang if the socket had
    /// already been replaced. That is a pre-existing hazard this makes visible
    /// rather than one it introduces.
    pub fn wake(&self) {
        if !self.still_ours() {
            return;
        }
        if let Ok(stream) = UnixStream::connect(&self.path) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    /// Is the file at `self.path` still the socket this listener bound?
    ///
    /// Compared by `(device, inode)`. A missing file, a replacement, or
    /// anything that cannot be stat'ed all answer no — the only yes is the
    /// same file this process created.
    fn still_ours(&self) -> bool {
        match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => (metadata.dev(), metadata.ino()) == self.identity,
            Err(_) => false,
        }
    }
}

impl Drop for SocketListener {
    fn drop(&mut self) {
        // Only its own. A daemon that exits after another has taken the path
        // would otherwise delete the newcomer's socket and leave a running
        // daemon with no door and no error anywhere.
        if self.still_ours() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Refuse a path the kernel cannot hold, before anything is created for it.
///
/// `sun_path` is a fixed array — `[c_char; 104]` on Darwin, `[c_char; 108]` on
/// Linux — holding a NUL-terminated path, so the usable length is one less
/// than the array. Overrunning it does not fail loudly; it truncates the
/// address into a *different* socket, so the refusal is named rather than left
/// to surface as an obscure `bind` error.
fn check_path_length(path: &Path) -> Result<(), ListenError> {
    use std::os::unix::ffi::OsStrExt;

    if path.as_os_str().as_bytes().len() > MAX_SOCKET_PATH_LEN {
        return Err(ListenError::PathTooLong {
            path: path.to_path_buf(),
            max: MAX_SOCKET_PATH_LEN,
        });
    }
    Ok(())
}

/// Create the run directory with mode 0700, and tighten it if it already
/// exists with a looser mode.
///
/// The parents are created with the process umask and only the final component
/// is forced to 0700: `~/.cache` is not this daemon's to make private, and a
/// recursive `mode(0o700)` would do exactly that to whichever ancestors
/// happened not to exist yet.
fn prepare_parent(path: &Path) -> Result<(), ListenError> {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return Ok(()),
    };
    let fail = |source: std::io::Error| ListenError::RunDir {
        path: parent.to_path_buf(),
        source,
    };
    if let Some(grandparent) = parent.parent() {
        std::fs::create_dir_all(grandparent).map_err(fail)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(parent) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // `mkdir(2)` says `EEXIST` for an ordinary file and for a symlink
            // too, not only for a directory. Chmodding either of those is the
            // same overreach as unlinking a file this daemon did not create —
            // and through a symlink it would land on the target, somewhere
            // else entirely. So look without following, and refuse.
            let existing = std::fs::symlink_metadata(parent).map_err(fail)?;
            if !existing.file_type().is_dir() {
                return Err(fail(std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    "the run directory's name is taken by something that is not a directory",
                )));
            }
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(fail)
        }
        Err(error) => Err(fail(error)),
    }
}

/// Bind with an explicit backlog.
///
/// `UnixListener::bind` uses the standard library's own backlog (128), and the
/// design names 16, so the socket is made by hand: `socket`, `bind`, `listen`.
/// The address is built by `UnixListener::bind` semantics — an `AF_UNIX`
/// pathname address. [`check_path_length`] has already refused anything the
/// kernel cannot hold, which is what lets the copy below leave room for the
/// terminator.
fn bind_with_backlog(path: &Path) -> Result<UnixListener, ListenError> {
    use std::os::unix::ffi::OsStrExt;

    let fail = |source: std::io::Error| ListenError::Bind {
        path: path.to_path_buf(),
        source,
    };
    let bytes = path.as_os_str().as_bytes();
    debug_assert!(
        bytes.len() <= MAX_SOCKET_PATH_LEN,
        "`SocketListener::bind` checks the length before it gets here"
    );
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    // `zip` stops at the shorter of the two, so the copy cannot overrun
    // `sun_path`; clamping the length the same way keeps the NUL terminator
    // inside the struct even on the path where the check above was skipped.
    let stored = bytes.len().min(MAX_SOCKET_PATH_LEN);
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }
    // The exact length std itself passes: the offset of `sun_path`, the bytes
    // of the name, and its NUL. Passing the whole struct instead makes the
    // kernel store the trailing zeros as part of the name, and everything that
    // later reads the address back — `getsockname`, a log line, a readiness
    // probe — sees a NUL-padded path that is not the one on disk.
    let address_length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + stored + 1) as libc::socklen_t;

    // SAFETY: every call below is a plain libc socket call on a descriptor
    // this function owns; the address is fully initialized above and the
    // length passed covers exactly the bytes written into it, which is what
    // the kernel expects for a pathname address.
    let descriptor = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if descriptor < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    // Owned from here, so every early return closes it.
    let owned = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let bound = unsafe {
        libc::bind(
            owned.as_raw_fd(),
            std::ptr::addr_of!(address).cast::<libc::sockaddr>(),
            address_length,
        )
    };
    if bound < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    if unsafe { libc::listen(owned.as_raw_fd(), LISTEN_BACKLOG) } < 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    Ok(unsafe { UnixListener::from_raw_fd(owned.into_raw_fd()) })
}

/// Does something answer at `path`?
///
/// One connection, one request line, one read with a deadline. **Answering is
/// the test, not answering well.** A daemon one protocol version ahead replies
/// an `incompatible_version` error and is exactly as alive as one replying
/// `ok`; the design document says "if a daemon *answers*, this one exits with
/// code 2", and requiring `ok` would hand a working daemon's socket to
/// whichever process probed it the day `PROTOCOL_VERSION` moves. So any line
/// that parses as a response envelope counts.
///
/// Only three things mean stale, and all three are silence: the connection is
/// refused (nothing is there), the read times out (nothing answers), or the
/// stream ends at once (nothing spoke). Anything that is not a response
/// envelope — a greeting banner, a stray line from some unrelated program that
/// happens to hold this path — is not a vaultd and is treated as stale, which
/// is the same judgement `NotASocket` makes one step earlier.
fn something_answers(path: &Path) -> bool {
    let stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream.set_read_timeout(Some(PROBE_TIMEOUT)).is_err() {
        return false;
    }
    if stream.set_write_timeout(Some(PROBE_TIMEOUT)).is_err() {
        return false;
    }
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return false,
    };
    let request = format!(r#"{{"version":1,"id":"{PROBE_ID}","request":{{"method":"health"}}}}"#);
    if writeln!(writer, "{request}").is_err() || writer.flush().is_err() {
        return false;
    }
    let mut line = String::new();
    match BufReader::new(stream).read_line(&mut line) {
        // A closed stream and a timed-out read are both silence.
        Ok(0) | Err(_) => false,
        Ok(_) => is_response_envelope(&line),
    }
}

/// Is this line a vaultd response envelope?
///
/// Two ways to tell, either of which is enough: it carries an `outcome`
/// object, which every response has whether the outcome is `ok` or `err`, or
/// it echoes the `id` the probe sent, which is how a caller pairs an answer
/// with its request. Two rather than one because a future envelope may rename
/// or nest the outcome, and the correlation id is the part the protocol can
/// least afford to change.
fn is_response_envelope(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object
        .get("outcome")
        .is_some_and(serde_json::Value::is_object)
        || object.get("id").and_then(serde_json::Value::as_str) == Some(PROBE_ID)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    use super::*;

    /// The digest rule is shared with the host and cannot drift silently, so
    /// it is pinned against a value computed here from a fixed string rather
    /// than against itself. The same vector appears in the host's
    /// `test/engine-probe.test.ts`.
    #[test]
    fn the_digest_is_sixteen_hex_characters_of_sha256_of_the_root() {
        let digest = socket_digest(Path::new("/vaults/example"));
        assert_eq!(digest.len(), 16, "sixteen characters, not thirty-two bytes");
        assert!(
            digest
                .chars()
                .all(|character| character.is_ascii_hexdigit()),
            "lowercase hex only: {digest}"
        );
        // sha256("/vaults/example") — recompute with:
        //   printf '%s' /vaults/example | shasum -a 256
        assert_eq!(digest, sha2_first_sixteen("/vaults/example"));
    }

    /// The reference implementation of the rule, spelled out separately so the
    /// assertion above compares two independent expressions of it.
    fn sha2_first_sixteen(value: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    }

    #[test]
    fn the_run_directory_prefers_xdg_runtime_dir() {
        // Exercised through the helper rather than by mutating the process
        // environment, which no test may do: `cargo test` runs them in
        // threads and one `set_var` would reach every other case.
        assert_eq!(
            run_dir_from(Some("/run/user/501"), Some("/home/x/.cache")),
            Path::new("/run/user/501/vaultd")
        );
        assert_eq!(
            run_dir_from(None, Some("/home/x/.cache")),
            Path::new("/home/x/.cache/vaultd/run")
        );
        assert_eq!(
            run_dir_from(Some(""), Some("/home/x/.cache")),
            Path::new("/home/x/.cache/vaultd/run"),
            "an empty variable is not a directory"
        );
    }

    fn scratch() -> tempfile::TempDir {
        tempfile::TempDir::new().expect("a scratch directory under TMPDIR")
    }

    #[test]
    fn a_bound_socket_has_mode_0600_inside_a_directory_with_mode_0700() {
        let scratch = scratch();
        let path = scratch.path().join("run").join("abc.sock");
        let listener = SocketListener::bind(&path).expect("bind");
        let socket_mode = std::fs::metadata(&path)
            .expect("stat the socket")
            .permissions()
            .mode()
            & 0o777;
        let dir_mode = std::fs::metadata(path.parent().expect("a parent"))
            .expect("stat the run directory")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(socket_mode, 0o600, "the socket is the owner's alone");
        assert_eq!(dir_mode, 0o700, "and so is the directory holding it");
        drop(listener);
        assert!(
            !path.exists(),
            "the socket file is unlinked when the listener goes"
        );
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let scratch = scratch();
        let path = scratch.path().join("stale.sock");
        // A real socket file that nothing is listening on: bind one, then let
        // it go without unlinking, which is what a crashed daemon leaves.
        {
            let listener =
                std::os::unix::net::UnixListener::bind(&path).expect("bind the stale one");
            std::mem::forget(listener);
        }
        assert!(path.exists(), "the stale file is there to begin with");
        let listener = SocketListener::bind(&path).expect("a stale file is replaced, not refused");
        assert_eq!(listener.path(), path);
    }

    /// Answer exactly one `health` request on `stream`, the way a daemon does.
    fn answer_one_health(stream: UnixStream) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone the probe stream"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("read the probe");
        let mut writer = stream;
        writeln!(
            writer,
            r#"{{"version":1,"id":"vaultd-probe","outcome":{{"status":"ok","value":{{"type":"health","value":{{"service":"vaultd","status":"ok"}}}}}}}}"#
        )
        .expect("answer the probe");
        writer.flush().expect("flush the answer");
    }

    #[test]
    fn a_live_socket_is_refused_and_the_error_names_the_path() {
        let scratch = scratch();
        let path = scratch.path().join("live.sock");
        let first = SocketListener::bind(&path).expect("the first listener binds");
        // Something must actually answer `health`, or the probe calls the file
        // stale and unlinks it. The listener moves into the answering thread so
        // it lives exactly as long as the one connection it serves.
        let answering = std::thread::spawn(move || {
            let stream = first.accept().expect("accept the probe");
            answer_one_health(stream);
            drop(first);
        });
        let refused = SocketListener::bind(&path).expect_err("a live daemon refuses the second");
        match &refused {
            ListenError::AlreadyListening(named) => assert_eq!(named, &path),
            other => panic!("the wrong refusal: {other}"),
        }
        assert_eq!(
            refused.to_string(),
            format!("another vaultd is listening at {}", path.display()),
            "the operator is told what is there"
        );
        answering.join().expect("the answering thread");
    }

    #[test]
    fn a_path_that_is_not_a_socket_is_refused() {
        let scratch = scratch();
        let path = scratch.path().join("ordinary-file");
        std::fs::write(&path, b"not a socket").expect("write the file");
        match SocketListener::bind(&path).expect_err("an ordinary file is refused") {
            ListenError::NotASocket(named) => assert_eq!(named, path),
            other => panic!("the wrong refusal: {other}"),
        }
        assert!(path.exists(), "and it is left exactly where it was");
        let _ = UnixStream::connect(&path).expect_err("nothing is listening there either");
    }

    // The cases below were added in fix round 1, against the review's findings
    // 1-8. Each one pins behaviour that was correct-but-unheld or, for the
    // first two, behaviour that was wrong.

    /// Answer exactly one request on `stream` with an `incompatible_version`
    /// error envelope: a daemon that is alive, well, and one protocol version
    /// ahead of the process probing it.
    fn answer_one_incompatible_version(stream: UnixStream) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone the probe stream"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("read the probe");
        let mut writer = stream;
        writeln!(
            writer,
            r#"{{"version":2,"id":"vaultd-probe","outcome":{{"status":"err","value":{{"code":"incompatible_version","message":"this daemon speaks version 2"}}}}}}"#
        )
        .expect("answer the probe");
        writer.flush().expect("flush the answer");
    }

    /// Finding 1, and the review's M8 verbatim. A daemon replying an error is
    /// answering, and its socket is not for the taking.
    #[test]
    fn a_daemon_that_answers_with_an_error_is_alive_and_refuses_the_second() {
        let scratch = scratch();
        let path = scratch.path().join("skewed.sock");
        let first = SocketListener::bind(&path).expect("the first listener binds");
        let answering = std::thread::spawn(move || {
            let stream = first.accept().expect("accept the probe");
            answer_one_incompatible_version(stream);
            drop(first);
        });
        let refused = SocketListener::bind(&path)
            .expect_err("a daemon that answers at all refuses the second");
        match &refused {
            ListenError::AlreadyListening(named) => assert_eq!(named, &path),
            other => panic!("the wrong refusal: {other}"),
        }
        answering.join().expect("the answering thread");
    }

    /// Finding 2. A listener whose file has been replaced must not delete the
    /// replacement — the late-drop case, reached without any race.
    #[test]
    fn a_listener_never_unlinks_the_socket_that_replaced_its_own() {
        let scratch = scratch();
        let path = scratch.path().join("succeeded.sock");
        let first = SocketListener::bind(&path).expect("the first listener binds");
        // What an operator, a cleaner, or a racing daemon does: the directory
        // entry goes, and somebody else binds a new socket at the same name.
        std::fs::remove_file(&path).expect("remove the first listener's file");
        let second = SocketListener::bind(&path).expect("the second binds at the same name");
        drop(first);
        assert!(
            path.exists(),
            "the first listener must not delete the second's socket"
        );
        assert_eq!(
            std::fs::symlink_metadata(&path)
                .expect("stat the survivor")
                .ino(),
            second.identity.1,
            "and what survives is the second's own socket, not some other file"
        );
        drop(second);
        assert!(!path.exists(), "the second still cleans up after itself");
    }

    /// Finding 4. With the exact `socklen_t`, the kernel stores the name and
    /// nothing else; with the whole struct it stores the trailing zeros too.
    #[test]
    fn the_bound_address_is_the_path_with_no_nul_padding() {
        use std::os::unix::ffi::OsStrExt;

        let scratch = scratch();
        let path = scratch.path().join("exact.sock");
        let listener = SocketListener::bind(&path).expect("bind");
        let address = listener.listener.local_addr().expect("the bound address");
        let named = address.as_pathname().expect("a pathname address");
        assert!(
            !named.as_os_str().as_bytes().contains(&0),
            "the kernel stored padding as part of the name: {named:?}"
        );
        assert_eq!(named, path, "and what it stored is the path we asked for");
    }

    /// Finding 5, with a path one byte past what this platform can hold. The
    /// run directory must not exist afterwards: the check runs before anything
    /// is created for a path that can never bind.
    #[test]
    fn a_path_longer_than_the_platform_allows_is_refused_by_name() {
        use std::os::unix::ffi::OsStrExt;

        let scratch = scratch();
        let parent = scratch.path().join("run");
        let prefix = parent.as_os_str().as_bytes().len() + 1;
        assert!(
            prefix < MAX_SOCKET_PATH_LEN,
            "the scratch directory itself must leave room for a filename"
        );
        let path = parent.join("n".repeat(MAX_SOCKET_PATH_LEN + 1 - prefix));
        assert_eq!(
            path.as_os_str().as_bytes().len(),
            MAX_SOCKET_PATH_LEN + 1,
            "one byte past the limit, which is 104 on Darwin and 108 on Linux"
        );
        match SocketListener::bind(&path).expect_err("a path this long cannot be bound") {
            ListenError::PathTooLong { path: named, max } => {
                assert_eq!(named, path);
                assert_eq!(max, MAX_SOCKET_PATH_LEN);
            }
            other => panic!("the wrong refusal: {other}"),
        }
        assert!(
            !parent.exists(),
            "and no run directory was created for a path that can never bind"
        );
    }

    /// Finding 7, the review's surviving M5. An existing run directory is
    /// tightened, not accepted as found.
    #[test]
    fn an_existing_run_directory_is_tightened_to_0700() {
        let scratch = scratch();
        let parent = scratch.path().join("loose");
        std::fs::create_dir(&parent).expect("create the run directory");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755))
            .expect("loosen it the way a careless umask would");
        let _listener = SocketListener::bind(&parent.join("tight.sock")).expect("bind");
        let mode = std::fs::metadata(&parent)
            .expect("stat the run directory")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "0700 is enforced, not only set on creation");
    }

    /// Finding 8, the review's surviving M6. A symlink at the socket path is
    /// not a socket, whatever it points at, and is left where it was.
    #[test]
    fn a_symlink_at_the_socket_path_is_refused_and_survives() {
        let scratch = scratch();
        let target = scratch.path().join("target.sock");
        let path = scratch.path().join("link.sock");
        // Pointed at a real socket, so following the link would find one and
        // either bind through it or unlink what it points at.
        let target_listener = SocketListener::bind(&target).expect("bind the target");
        std::os::unix::fs::symlink(&target, &path).expect("plant the symlink");
        match SocketListener::bind(&path).expect_err("a symlink is refused") {
            ListenError::NotASocket(named) => assert_eq!(named, path),
            other => panic!("the wrong refusal: {other}"),
        }
        assert!(
            std::fs::symlink_metadata(&path)
                .expect("stat the link")
                .file_type()
                .is_symlink(),
            "the link is left exactly where it was"
        );
        assert!(target.exists(), "and so is what it pointed at");
        drop(target_listener);
    }

    /// Finding 3, first half. An ordinary file where the run directory belongs
    /// is refused, not chmodded.
    #[test]
    fn an_ordinary_file_where_the_run_directory_belongs_is_refused() {
        let scratch = scratch();
        // Short names throughout: the scratch directory is already 73 of the
        // 103 bytes a Darwin socket path may hold.
        let parent = scratch.path().join("taken");
        std::fs::write(&parent, b"an operator's file").expect("write the file");
        let before = std::fs::metadata(&parent)
            .expect("stat the file")
            .permissions()
            .mode()
            & 0o777;
        match SocketListener::bind(&parent.join("s.sock"))
            .expect_err("a file where the run directory belongs is refused")
        {
            ListenError::RunDir { path: named, .. } => assert_eq!(named, parent),
            other => panic!("the wrong refusal: {other}"),
        }
        assert_eq!(
            std::fs::read(&parent).expect("read it back"),
            b"an operator's file",
            "and it is left exactly as it was"
        );
        assert_eq!(
            std::fs::metadata(&parent)
                .expect("stat it again")
                .permissions()
                .mode()
                & 0o777,
            before,
            "including its mode"
        );
    }

    /// Finding 3, second half. A symlinked run directory is refused rather
    /// than chmodded through to whatever it points at.
    #[test]
    fn a_symlinked_run_directory_is_refused_rather_than_chmodded_through() {
        let scratch = scratch();
        let elsewhere = scratch.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).expect("create the real directory");
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o755))
            .expect("give it a mode a chmod-through would change");
        let parent = scratch.path().join("linked");
        std::os::unix::fs::symlink(&elsewhere, &parent).expect("plant the symlink");
        match SocketListener::bind(&parent.join("s.sock"))
            .expect_err("a symlinked run directory is refused")
        {
            ListenError::RunDir { path: named, .. } => assert_eq!(named, parent),
            other => panic!("the wrong refusal: {other}"),
        }
        let mode = std::fs::metadata(&elsewhere)
            .expect("stat the target")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o755,
            "the link's target is not chmodded through the link"
        );
    }
}
