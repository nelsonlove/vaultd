//! `read_dir`: the immediate entries of one directory, hidden and
//! configuration-zone folders included.
//!
//! This is the one read that reaches where the index deliberately does not.
//! `get_tree_entries` and every snapshot pager answer out of the tree index,
//! which excludes hidden paths by design, and `read_file` reads only regular
//! files — so before this operation no client could learn that
//! `.obsidian-headless/plugins/example/` exists, let alone what is in it. A
//! plugin host that must enumerate installed plugins needs exactly that.
//!
//! The guards and the test that is the witness for each — delete a guard and
//! exactly one row goes red:
//!
//! | guard | witness |
//! | --- | --- |
//! | a hidden directory is listed rather than hidden | `a_hidden_plugin_directory_lists_its_entries_in_byte_order` |
//! | entries are sorted by name in byte order | same test |
//! | `size` is present for files and absent for folders | same test |
//! | the vault root lists its dotfolders | `the_vault_root_lists_its_configuration_folders` |
//! | a file is not a directory | `a_file_path_is_refused_as_target_exists` |
//! | an absent name is absence, not a listing | `a_missing_directory_is_refused_as_not_found` |
//! | traversal never escapes the vault | `a_traversal_is_refused_before_anything_is_read` |
//! | a symlink is reported, never followed | `a_symlink_entry_is_reported_as_a_symlink_and_never_followed` |
//! | a read is not a write | `a_read_only_daemon_still_lists_a_directory` |

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, ResponseEnvelope, ResponseOutcome};

/// The exact line the daemon's answer serializes back to. Re-encoding the
/// decoded envelope pins both halves — the spelling the server wrote and the
/// spelling this build's own decoder round-trips — which a hand-compared
/// field-by-field assertion cannot.
fn wire(envelope: &ResponseEnvelope) -> String {
    serde_json::to_string(envelope).expect("re-encode the answer")
}

fn read_dir(daemon: &mut Daemon, path: &str) -> ResponseEnvelope {
    daemon.call(&format!(
        r#"{{"version":1,"id":"d","request":{{"method":"read_dir","params":{{"path":"{path}"}}}}}}"#
    ))
}

fn refusal(envelope: &ResponseEnvelope) -> ErrorCode {
    match &envelope.outcome {
        ResponseOutcome::Err(error) => error.code,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// A vault carrying both configuration zones, one ordinary folder, one note,
/// and a plugin directory deep inside the headless zone.
fn vault_with_a_headless_plugin() -> TempDir {
    let vault = TempDir::new().expect("vault tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::create_dir_all(vault.path().join(".obsidian-headless/plugins/example/data"))
        .expect("create the headless plugin directory");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create an ordinary folder");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(
        vault
            .path()
            .join(".obsidian-headless/plugins/example/main.js"),
        "exports.x=1\n",
    )
    .expect("write main.js");
    std::fs::write(
        vault
            .path()
            .join(".obsidian-headless/plugins/example/manifest.json"),
        r#"{"id":"example"}"#,
    )
    .expect("write manifest.json");
    vault
}

/// The operation's reason for existing: a directory the tree index will never
/// list, read straight off the filesystem, with the names in byte order and a
/// size on the files only.
#[test]
fn a_hidden_plugin_directory_lists_its_entries_in_byte_order() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let listed = read_dir(&mut daemon, ".obsidian-headless/plugins/example");

    assert_eq!(
        wire(&listed),
        r#"{"version":1,"id":"d","outcome":{"status":"ok","value":{"type":"read_dir","value":{"path":".obsidian-headless/plugins/example","entries":[{"name":"data","kind":"folder"},{"name":"main.js","kind":"file","size":12},{"name":"manifest.json","kind":"file","size":16}]}}}}"#,
        "a plugin directory must list in byte order, with a size on the files only"
    );
}

/// The root has no `VaultPath` spelling — `VaultPath::new(\"\")` is an error —
/// so the empty string is the wire's name for it, and listing it is how a host
/// discovers that a configuration zone is there at all.
#[test]
fn the_vault_root_lists_its_configuration_folders() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let listed = read_dir(&mut daemon, "");

    assert_eq!(
        wire(&listed),
        r#"{"version":1,"id":"d","outcome":{"status":"ok","value":{"type":"read_dir","value":{"path":"","entries":[{"name":".obsidian","kind":"folder"},{"name":".obsidian-headless","kind":"folder"},{"name":"Folder","kind":"folder"},{"name":"One.md","kind":"file","size":6}]}}}}"#,
        "the root listing must include the dotfolders the tree index excludes"
    );
}

/// `read_file`'s mirror image, and deliberately its code: a name occupied by
/// something this operation cannot serve is `target_exists`, phrased for the
/// write path and understood here as "this name is not a directory".
#[test]
fn a_file_path_is_refused_as_target_exists() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let refused = read_dir(&mut daemon, "One.md");

    assert_eq!(refusal(&refused), ErrorCode::TargetExists);
}

#[test]
fn a_missing_directory_is_refused_as_not_found() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let refused = read_dir(&mut daemon, "Gone");

    assert_eq!(refusal(&refused), ErrorCode::NotFound);
}

/// Containment is the engine's, unchanged: a traversal is not a path this
/// daemon has, so it is refused at the parse boundary before anything is
/// opened.
#[test]
fn a_traversal_is_refused_before_anything_is_read() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let refused = read_dir(&mut daemon, "../..");

    assert_eq!(refusal(&refused), ErrorCode::InvalidPath);
}

/// A symlink is a *kind*, never a door. Reporting it as `symlink` rather than
/// as the folder it points at is what keeps a host from walking out of the
/// vault through a listing, and listing the link itself is still refused by
/// the same containment `read_file` takes.
#[test]
fn a_symlink_entry_is_reported_as_a_symlink_and_never_followed() {
    let outside = TempDir::new().expect("a directory outside the vault");
    std::fs::write(outside.path().join("secret.txt"), "not yours\n").expect("write outside");
    let vault = TempDir::new().expect("vault tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::os::unix::fs::symlink(outside.path(), vault.path().join("Link")).expect("plant the link");
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::for_vault(&vault, &index);

    let listed = read_dir(&mut daemon, "");

    assert_eq!(
        wire(&listed),
        r#"{"version":1,"id":"d","outcome":{"status":"ok","value":{"type":"read_dir","value":{"path":"","entries":[{"name":".obsidian","kind":"folder"},{"name":"Link","kind":"symlink"}]}}}}"#,
        "a symlink must be reported as a symlink, with no size and no target"
    );

    let refused = read_dir(&mut daemon, "Link");
    assert_eq!(
        refusal(&refused),
        ErrorCode::ZoneViolation,
        "listing through a link that leaves the vault must be refused"
    );
}

/// `--read-only` governs writes. A listing writes nothing, so the flag is not
/// in its path at all — the same rule `read_file` already follows.
#[test]
fn a_read_only_daemon_still_lists_a_directory() {
    let vault = vault_with_a_headless_plugin();
    let index = TempDir::new().expect("index tempdir");
    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index
            .path()
            .join("index.sqlite3")
            .to_str()
            .expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
        "--read-only",
    ]);

    let listed = read_dir(&mut daemon, ".obsidian-headless/plugins");

    assert_eq!(
        wire(&listed),
        r#"{"version":1,"id":"d","outcome":{"status":"ok","value":{"type":"read_dir","value":{"path":".obsidian-headless/plugins","entries":[{"name":"example","kind":"folder"}]}}}}"#,
        "a read is unaffected by --read-only"
    );
}
