//! `--read-only`: every mutating operation refuses with a dedicated code;
//! every read, and every snapshot, is unaffected.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

/// `Daemon::for_vault`'s arguments plus the flag under test. Spelled out
/// rather than derived from it, because the flag's position in the list is
/// part of what this test exercises: `--read-only` carries `requires =
/// "vault"`, so a daemon started without `--vault` must reject it outright —
/// verified directly: `vaultd --read-only` alone exits 2 with "the following
/// required arguments were not provided". Not re-asserted as a test of its
/// own here, because every daemon this suite starts already has a vault; the
/// argument's position in this list is what stands in for that check.
fn read_only_daemon(vault: &TempDir, index: &TempDir) -> Daemon {
    Daemon::start(&[
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
    ])
}

#[test]
fn every_mutating_operation_is_refused_with_the_read_only_code() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join(".obsidian/app.json"), "{}").expect("write app.json");

    let mut daemon = read_only_daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let attempts = [
        r#"{"version":1,"id":"1","request":{"method":"write_note","params":{"path":"New.md","content":"x\n","expected":{"absent":true}}}}"#,
        r#"{"version":1,"id":"2","request":{"method":"create_folder","params":{"path":"Folder"}}}"#,
        r#"{"version":1,"id":"3","request":{"method":"rename_note","params":{"from":"One.md","to":"Two.md","expected":{"any":true},"rewrite_links":true}}}"#,
        r#"{"version":1,"id":"4","request":{"method":"rename_folder","params":{"from":"A","to":"B","rewrite_links":true}}}"#,
        r#"{"version":1,"id":"5","request":{"method":"copy_file","params":{"from":"One.md","to":"Copy.md","expected_source":{"any":true},"if_exists":"error"}}}"#,
        r#"{"version":1,"id":"6","request":{"method":"delete_note","params":{"path":"One.md","mode":"permanent","expected":{"any":true}}}}"#,
        r#"{"version":1,"id":"7","request":{"method":"delete_folder","params":{"path":"A","mode":"permanent","recursive":true}}}"#,
        r#"{"version":1,"id":"8","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a","value":"b"}],"expected":{"any":true}}}}"#,
        r#"{"version":1,"id":"9","request":{"method":"write_file","params":{"path":"raw.bin","content_base64":"AAEC","expected":{"absent":true}}}}"#,
        r#"{"version":1,"id":"10","request":{"method":"write_file","params":{"path":".obsidian/app.json","content_base64":"e30=","expected":{"any":true}}}}"#,
        // The two trash delete modes, not just `permanent`: a local trash is
        // a move *inside* the vault rather than a write to a caller-named
        // path, so it is the one shape a filesystem-boundary-only guard could
        // miss. Both refuse above the mode `match` in `MutationEngine::apply`
        // (mode selection is never reached), but that structural fact is
        // worth a witness here too, not just at the engine layer.
        r#"{"version":1,"id":"11","request":{"method":"delete_note","params":{"path":"One.md","mode":"trash_local","expected":{"any":true}}}}"#,
        r#"{"version":1,"id":"12","request":{"method":"delete_note","params":{"path":"One.md","mode":"trash_system","expected":{"any":true}}}}"#,
    ];
    for attempt in attempts {
        let response = daemon.call(attempt);
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::ReadOnly,
                "wrong code for {attempt}: {error:?}"
            ),
            other => panic!("{attempt} was not refused: {other:?}"),
        }
    }

    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert!(!vault.path().join("New.md").exists());
    assert!(!vault.path().join("Folder").exists());
    assert_eq!(
        std::fs::read(vault.path().join(".obsidian/app.json")).expect("read back"),
        b"{}",
        "a zone write is a mutating operation too"
    );
    assert!(
        !vault.path().join(".trash").exists(),
        "a trash move is a mutating operation too"
    );
}

#[test]
fn reads_and_snapshots_are_unaffected_by_read_only() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = read_only_daemon(&vault, &index);
    let refreshed =
        daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    assert!(
        matches!(refreshed.outcome, ResponseOutcome::Ok(_)),
        "reconciliation is a read-only daemon's job: {refreshed:?}"
    );

    let note = daemon.call(
        r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"One.md"}}}"#,
    );
    assert!(matches!(note.outcome, ResponseOutcome::Ok(_)));

    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed under --read-only: {other:?}"),
    };
    let page = daemon.call(&format!(
        r#"{{"version":1,"id":"t","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    assert!(matches!(page.outcome, ResponseOutcome::Ok(_)));

    let read = daemon.call(
        r#"{"version":1,"id":"f","request":{"method":"read_file","params":{"path":"One.md"}}}"#,
    );
    assert!(
        matches!(read.outcome, ResponseOutcome::Ok(_)),
        "read_file is a read"
    );
}
