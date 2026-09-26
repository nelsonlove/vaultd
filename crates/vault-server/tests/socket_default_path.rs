//! `--listen` with no value: the daemon works out where to listen.
//!
//! The path rule itself is `listener.rs`'s and is tested there. What is only
//! testable from outside is that the flag with **no value** reaches it at all,
//! and reaches it with the root the daemon is actually serving — every other
//! test here hands the daemon an explicit socket path, so this branch of
//! `main` would otherwise be proven by nothing.

mod socket;

use std::path::PathBuf;

use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_index::IndexConfig;
use vault_protocol::{Response, ResponseOutcome};
use vault_server::listener::socket_digest;

#[test]
fn a_daemon_given_listen_with_no_value_binds_the_path_the_rule_names() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    // `XDG_RUNTIME_DIR` at a short, deterministic subdirectory of this
    // crate's own `target/tmp` — never `std::env::temp_dir()`, which reads
    // `$TMPDIR` and would otherwise bind this test's socket under the real
    // OS temp directory whenever a bare `cargo test` leaves that variable
    // unset. See `socket::short_runtime_dir` for why the subdirectory is one
    // base-36 digit rather than a `TempDir`'s `.tmpXXXXXX`: that random
    // suffix is what pushes the default path over the 103-byte
    // `sockaddr_un` limit on a checkout this deep. Two runs cannot collide
    // on the socket file itself even if they land in the same subdirectory —
    // the digest is of the vault root, and every run's vault is a fresh
    // tempdir.
    let runtime_dir = socket::short_runtime_dir();
    // The same root the daemon computes, from the same call it makes.
    let configured = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("an explicit config");
    let expected: PathBuf = runtime_dir.join("vaultd").join(format!(
        "{}.sock",
        socket_digest(&configured.canonical_vault_root)
    ));
    // Pin the constraint rather than assume it: the runtime dir must stay
    // inside this crate's own `target/tmp`, never the OS temp directory, and
    // the resulting path must still fit a `sockaddr_un`.
    assert!(
        expected.starts_with(socket::tmp_root()),
        "the runtime dir must stay inside target/tmp, not the OS temp dir: {}",
        expected.display()
    );
    assert!(
        expected.as_os_str().len() <= 103,
        "this scratch directory is too deep for a Unix socket address: {} bytes at {}",
        expected.as_os_str().len(),
        expected.display()
    );

    let daemon = ListeningDaemon::start_on_its_default_socket(
        &vault,
        &index,
        &runtime_dir,
        expected.clone(),
    );

    // `start_on_its_default_socket` only returns once `health` has been
    // answered at `expected`, so arriving here is most of the assertion.
    assert_eq!(
        daemon.socket_path(),
        expected,
        "the daemon bound the path the rule names"
    );
    let mut client = daemon.connect();
    let answer = client.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#);
    assert!(
        matches!(answer.outcome, ResponseOutcome::Ok(Response::Health(_))),
        "and it is a working daemon on the other end: {answer:?}"
    );
}
