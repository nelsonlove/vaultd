//! `PatchValueDto::Mapping` exists precisely so a frontmatter patch's nested
//! keys survive in the order a client wrote them. This pins that guarantee
//! end to end, through a spawned `vaultd`: one JSON line in, and the bytes
//! the daemon left on disk out.
//!
//! End to end rather than at the decode boundary on purpose. The hazard is a
//! `serde_json::Value` hop anywhere between stdin and the frontmatter
//! serializer — `serde_json::Map` is a `BTreeMap` in this build, so any such
//! hop silently alphabetizes every JSON object — and a test that re-implements
//! the transport's own two decode lines can only prove those two lines, never
//! that no later stage reintroduces the hop.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome};

#[test]
fn a_nested_mapping_patch_keeps_its_key_order_all_the_way_to_disk() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "---\ntitle: One\n---\n# One\n")
        .expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let patched = daemon.call(
        r#"{"version":1,"id":"p","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a","value":{"zebra":1,"apple":2,"mango":3}}],"expected":{"any":true}}}}"#,
    );
    let revision = match patched.outcome {
        ResponseOutcome::Ok(Response::PatchFrontmatter(response)) => response.revision,
        other => panic!("patch_frontmatter did not reach the engine: {other:?}"),
    };

    let written = std::fs::read_to_string(vault.path().join("One.md")).expect("read One back");
    assert_eq!(
        revision,
        vault_index::revision_of(written.as_bytes()),
        "the reported revision must be the revision on disk"
    );
    let zebra = written.find("zebra").expect("zebra was written");
    let apple = written.find("apple").expect("apple was written");
    let mango = written.find("mango").expect("mango was written");
    assert!(
        zebra < apple && apple < mango,
        "the mapping's key order must survive from the wire to the file, \
         not be alphabetized by an intermediate serde_json::Value: {written:?}"
    );
}
