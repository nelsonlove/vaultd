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

    // `XDG_RUNTIME_DIR` straight at the scratch root rather than a tempdir
    // inside it: the default path spends 29 bytes after this directory
    // (`/vaultd/` + 16 hex + `.sock`) against a 103-byte limit, and a
    // `.tmpXXXXXX` component would push it over on a checkout at this depth.
    // Two runs cannot collide — the digest is of the vault root, and every
    // run's vault is a fresh tempdir.
    let runtime_dir = std::env::temp_dir();
    // The same root the daemon computes, from the same call it makes.
    let configured = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("an explicit config");
    let expected: PathBuf = runtime_dir.join("vaultd").join(format!(
        "{}.sock",
        socket_digest(&configured.canonical_vault_root)
    ));
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
