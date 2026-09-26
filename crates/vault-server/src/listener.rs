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
//! fatal.** A live daemon answering `health` there means this process must not
//! start, because the writer lease will refuse it anyway and a confusing
//! `index_in_use` much later is worse than a clear refusal now. A socket file
//! nothing answers on is what a crashed daemon leaves, and is unlinked. A path
//! that is not a socket is refused untouched, because unlinking a file a
//! daemon did not create is not a daemon's business. Nothing there at all is
//! the ordinary case.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The listen backlog: the depth of the kernel's queue of connections that
/// have completed their handshake and not yet been accepted. Sixteen, because
/// the accept loop does nothing but hand each one to a thread, so the queue is
/// a burst absorber rather than a work queue.
pub const LISTEN_BACKLOG: i32 = 16;

/// How long the liveness probe waits for a `health` answer before calling the
/// file stale. Generous enough for a loaded machine, short enough that a
/// daemon start is not held up by a socket nobody owns.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("another vaultd is listening at {0}")]
    AlreadyListening(PathBuf),
    #[error("{0} exists and is not a socket")]
    NotASocket(PathBuf),
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
}

/// The first 16 hex characters of the SHA-256 of the canonical vault root.
///
/// Sixteen and not more because a Unix domain socket address is capped at
/// about 104 bytes on Darwin and the run directory is already most of that;
/// sixteen and not fewer because 64 bits of a cryptographic hash is far past
/// any collision a single machine's vault list can produce.
pub fn socket_digest(canonical_vault_root: &Path) -> String {
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

/// A bound listener that unlinks its own path when dropped.
// `Debug` because the refusal tests read `SocketListener::bind(…).expect_err`,
// which needs the success side printable.
#[derive(Debug)]
pub struct SocketListener {
    listener: UnixListener,
    path: PathBuf,
}

impl SocketListener {
    /// Prepare the directory, decide what to do about anything already at
    /// `path`, and bind.
    pub fn bind(path: &Path) -> Result<Self, ListenError> {
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
                if answers_health(path) {
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
        Ok(Self {
            listener,
            path: path.to_path_buf(),
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
    pub fn wake(&self) {
        if let Ok(stream) = UnixStream::connect(&self.path) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Drop for SocketListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
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
/// pathname address — and the path length is checked before the copy, because
/// the kernel's `sun_path` is a fixed array and overrunning it silently
/// truncates the address into a different socket.
fn bind_with_backlog(path: &Path) -> Result<UnixListener, ListenError> {
    use std::os::unix::ffi::OsStrExt;

    let fail = |source: std::io::Error| ListenError::Bind {
        path: path.to_path_buf(),
        source,
    };
    let bytes = path.as_os_str().as_bytes();
    // SAFETY-adjacent, and checked rather than assumed: `sun_path` holds a
    // NUL-terminated path, so the usable length is one less than the array.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= std::mem::size_of_val(&address.sun_path) {
        return Err(fail(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "the socket path is {} bytes; this platform allows {}",
                bytes.len(),
                std::mem::size_of_val(&address.sun_path) - 1
            ),
        )));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes.iter()) {
        *slot = *byte as libc::c_char;
    }

    // SAFETY: every call below is a plain libc socket call on a descriptor
    // this function owns; the address is fully initialized above and its
    // length is the size of the struct, which is what the kernel expects for a
    // pathname address.
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
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
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

/// Does something answer `health` at `path`?
///
/// One connection, one request line, one read with a deadline. Anything other
/// than a well-formed `ok` answer — a refused connection, a timeout, a closed
/// stream, a line that is not a response — means nothing is serving there, and
/// the file is stale.
fn answers_health(path: &Path) -> bool {
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
    let request = r#"{"version":1,"id":"vaultd-probe","request":{"method":"health"}}"#;
    if writeln!(writer, "{request}").is_err() || writer.flush().is_err() {
        return false;
    }
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => {
            value
                .get("outcome")
                .and_then(|outcome| outcome.get("status"))
                .and_then(serde_json::Value::as_str)
                == Some("ok")
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
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
}
