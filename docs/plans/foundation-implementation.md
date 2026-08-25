# vaultd Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal compilable Rust semantic-runtime workspace with a versioned protocol, a health-capable daemon skeleton, tests, and the requested architectural contracts.

**Architecture:** Keep authoritative data in an ordinary Obsidian-compatible filesystem while separating semantic types (`vault-core`), transport-neutral wire contracts (`vault-protocol`), and process composition (`vault-server`). The initial binary speaks newline-delimited JSON over standard input/output solely to prove end-to-end protocol composition; production transports and vault behavior remain deferred.

**Tech Stack:** Rust 1.85 or newer, edition 2024, Cargo resolver 3, `serde`, `serde_json`, and `thiserror`.

## Global Constraints

- Read `docs/design/foundation.md` in full before editing.
- Use the `superpowers:using-git-worktrees` skill and perform implementation in an isolated worktree; do not implement directly on `main`.
- Follow strict red-green-refactor: add each behavioral test first, run it and confirm the expected failure, then write the minimum production code.
- The ordinary Obsidian vault filesystem remains authoritative persistence; no database or proprietary canonical store may be introduced.
- Keep storage format, semantic model, protocol, plugin API, UI runtime, and synchronization as separate boundaries.
- `vault-core` must not depend on `vault-protocol`, HTTP, JSON-RPC, MCP, Obsidian plugin classes, UI libraries, or Sync wire behavior.
- Only the health operation is executable in this milestone. Other operations are documented contract shapes, not Rust request variants.
- Do not implement Markdown parsing, indexing, filesystem watching, mutation, journaling, network transports, MCP, CLI/URI adapters, Obsidian plugins, JavaScript execution, UI, Sync, FFI, mobile, or e-ink behavior.
- Do not add a GitHub remote, push, or open a pull request without the maintainer's authorization.
- Leave the pre-existing untracked `.permission-check` file untouched and uncommitted.
- Use scoped commits with exactly the commit messages specified below.

## Planned File Map

```text
Cargo.toml                              Rust workspace and shared dependency versions
Cargo.lock                              Reproducible dependency resolution for the daemon workspace
.gitignore                              Cargo build output and macOS metadata only
README.md                               North star, boundaries, workspace map, and milestone scope
VAULTD-COMPATIBILITY.md                 Tiered Obsidian compatibility contract
docs/design/foundation.md               Approved design; read-only during execution
docs/adr/0001-core-language.md          Accepted Rust-versus-Go language decision
docs/protocol.md                        Version 1 transport-neutral schema and reserved operations
crates/vault-core/Cargo.toml             Semantic-core package manifest
crates/vault-core/src/lib.rs             Public core exports
crates/vault-core/src/domain.rs          Paths, identities, revisions, spans, and validation errors
crates/vault-core/tests/domain_types.rs  Core boundary tests
crates/vault-protocol/Cargo.toml         Protocol package manifest
crates/vault-protocol/src/lib.rs         Versioned envelopes, health messages, and protocol errors
crates/vault-protocol/tests/schema.rs    Serialization and version-validation tests
crates/vault-server/Cargo.toml           Server library and `vaultd` binary manifest
crates/vault-server/src/lib.rs           In-process request dispatcher
crates/vault-server/src/main.rs          Newline-delimited JSON stdio process skeleton
crates/vault-server/tests/health.rs      In-process health dispatch tests
crates/vault-server/tests/stdio.rs       End-to-end process protocol test
crates/vault-server/tests/docs.rs        Required-document contract test
```

---

### Task 1: Semantic core types

**Files:**

- Create: `Cargo.toml`
- Create: `.gitignore`
- Create: `crates/vault-core/Cargo.toml`
- Create: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/src/domain.rs`
- Create: `crates/vault-core/tests/domain_types.rs`
- Create through Cargo: `Cargo.lock`

**Interfaces:**

- Consumes: no production interfaces; this establishes the workspace.
- Produces: `VaultPath::new`, `VaultPath::as_str`, `NoteId::new`, `NoteId::as_str`, `Revision::new`, `Revision::as_str`, `SourceSpan::new`, `SourceSpan::start`, `SourceSpan::end`, `NoteRef`, and `DomainError` from `vault_core`.

- [ ] **Step 1: Create the workspace manifests and empty library surface**

Create `Cargo.toml`:

```toml
[workspace]
members = ["crates/vault-core"]
resolver = "3"

[workspace.package]
version = "0.1.0"
edition = "2024"
rust-version = "1.85"

[workspace.dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "2.0"
```

Create `.gitignore`:

```gitignore
/target/
.DS_Store
```

Create `crates/vault-core/Cargo.toml`:

```toml
[package]
name = "vault-core"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[dependencies]
thiserror.workspace = true
```

Create an empty `crates/vault-core/src/lib.rs`. Do not define domain behavior yet.

- [ ] **Step 2: Write the failing core-domain tests**

Create `crates/vault-core/tests/domain_types.rs`:

```rust
use vault_core::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};

#[test]
fn vault_path_accepts_normalized_relative_paths() {
    let path = VaultPath::new("Projects/vaultd.md").expect("valid vault path");
    assert_eq!(path.as_str(), "Projects/vaultd.md");
}

#[test]
fn vault_path_rejects_paths_that_escape_the_vault() {
    assert_eq!(
        VaultPath::new("../outside.md"),
        Err(DomainError::InvalidVaultPath("../outside.md".into()))
    );
    assert_eq!(
        VaultPath::new("/absolute.md"),
        Err(DomainError::InvalidVaultPath("/absolute.md".into()))
    );
}

#[test]
fn identities_and_revisions_remain_opaque() {
    let id = NoteId::new("runtime:42").expect("non-empty note id");
    let revision = Revision::new("sha256:abc123").expect("non-empty revision");
    let note = NoteRef::new(
        Some(id.clone()),
        VaultPath::new("Notes/Example.md").expect("valid path"),
        Some("019fd012-e2ad-732d-aa86-df9768d8d961".into()),
    );

    assert_eq!(id.as_str(), "runtime:42");
    assert_eq!(revision.as_str(), "sha256:abc123");
    assert_eq!(note.runtime_id(), Some(&id));
    assert_eq!(note.semantic_id(), Some("019fd012-e2ad-732d-aa86-df9768d8d961"));
}

#[test]
fn source_span_rejects_an_inverted_range() {
    assert_eq!(
        SourceSpan::new(9, 4),
        Err(DomainError::InvalidSourceSpan { start: 9, end: 4 })
    );
    let span = SourceSpan::new(4, 9).expect("ordered span");
    assert_eq!((span.start(), span.end()), (4, 9));
}
```

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
cargo test -p vault-core --test domain_types
```

Expected: compilation fails because `DomainError`, `NoteId`, `NoteRef`, `Revision`, `SourceSpan`, and `VaultPath` are not exported by `vault_core`.

- [ ] **Step 4: Implement the minimum semantic domain model**

Create `crates/vault-core/src/domain.rs`:

```rust
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        let invalid = value.is_empty()
            || value.starts_with('/')
            || value.contains('\\')
            || value.split('/').any(|part| part.is_empty() || part == ".." || part == ".");
        if invalid {
            return Err(DomainError::InvalidVaultPath(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteId(String);

impl NoteId {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.is_empty() {
            return Err(DomainError::EmptyNoteId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Revision(String);

impl Revision {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.is_empty() {
            return Err(DomainError::EmptyRevision);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    start: usize,
    end: usize,
}

impl SourceSpan {
    pub fn new(start: usize, end: usize) -> Result<Self, DomainError> {
        if start > end {
            return Err(DomainError::InvalidSourceSpan { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn start(&self) -> usize {
        self.start
    }

    pub fn end(&self) -> usize {
        self.end
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteRef {
    runtime_id: Option<NoteId>,
    path: VaultPath,
    semantic_id: Option<String>,
}

impl NoteRef {
    pub fn new(
        runtime_id: Option<NoteId>,
        path: VaultPath,
        semantic_id: Option<String>,
    ) -> Self {
        Self { runtime_id, path, semantic_id }
    }

    pub fn runtime_id(&self) -> Option<&NoteId> {
        self.runtime_id.as_ref()
    }

    pub fn path(&self) -> &VaultPath {
        &self.path
    }

    pub fn semantic_id(&self) -> Option<&str> {
        self.semantic_id.as_deref()
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum DomainError {
    #[error("invalid vault-relative path: {0}")]
    InvalidVaultPath(String),
    #[error("note id cannot be empty")]
    EmptyNoteId,
    #[error("revision cannot be empty")]
    EmptyRevision,
    #[error("source span start {start} exceeds end {end}")]
    InvalidSourceSpan { start: usize, end: usize },
}
```

Replace `crates/vault-core/src/lib.rs` with:

```rust
mod domain;

pub use domain::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};
```

- [ ] **Step 5: Verify the green state and format the workspace**

Run:

```bash
cargo fmt --all
cargo test -p vault-core --test domain_types
cargo clippy -p vault-core --all-targets -- -D warnings
```

Expected: four tests pass; Clippy exits with no warnings.

- [ ] **Step 6: Commit the semantic core**

```bash
git add Cargo.toml Cargo.lock .gitignore crates/vault-core
git commit -m "feat(core): add semantic identity types"
```

---

### Task 2: Versioned protocol schema

**Files:**

- Modify: `Cargo.toml`
- Create: `crates/vault-protocol/Cargo.toml`
- Create: `crates/vault-protocol/src/lib.rs`
- Create: `crates/vault-protocol/tests/schema.rs`
- Modify through Cargo: `Cargo.lock`

**Interfaces:**

- Consumes: no `vault-core` types; wire DTOs intentionally remain independent.
- Produces: `PROTOCOL_VERSION`, `RequestEnvelope`, `Request::Health`, `ResponseEnvelope`, `ResponseOutcome`, `Response::Health`, `HealthResponse`, `ProtocolError`, `ErrorCode`, and `validate_version` from `vault_protocol`.

- [ ] **Step 1: Add the protocol crate manifest and workspace member**

Change the workspace member list in root `Cargo.toml` to:

```toml
members = ["crates/vault-core", "crates/vault-protocol"]
```

Create `crates/vault-protocol/Cargo.toml`:

```toml
[package]
name = "vault-protocol"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[dependencies]
serde.workspace = true

[dev-dependencies]
serde_json.workspace = true
```

Create an empty `crates/vault-protocol/src/lib.rs`.

- [ ] **Step 2: Write the failing protocol tests**

Create `crates/vault-protocol/tests/schema.rs`:

```rust
use vault_protocol::{
    ErrorCode, Request, RequestEnvelope, Response, ResponseEnvelope, ResponseOutcome,
    PROTOCOL_VERSION, validate_version,
};

#[test]
fn health_request_round_trips_as_versioned_json() {
    let request = RequestEnvelope::new("req-1", Request::Health);
    let json = serde_json::to_string(&request).expect("serialize request");
    assert!(json.contains("\"version\":1"));
    assert!(json.contains("\"method\":\"health\""));

    let decoded: RequestEnvelope = serde_json::from_str(&json).expect("deserialize request");
    assert_eq!(decoded, request);
}

#[test]
fn incompatible_version_has_a_stable_error_code() {
    let error = validate_version(PROTOCOL_VERSION + 1).expect_err("version must be rejected");
    assert_eq!(error.code, ErrorCode::IncompatibleVersion);
    assert_eq!(error.supported_version, Some(PROTOCOL_VERSION));
}

#[test]
fn health_response_round_trips_without_core_types() {
    let response = ResponseEnvelope::success(
        "req-1",
        Response::health("vaultd"),
    );
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: ResponseEnvelope = serde_json::from_str(&json).expect("deserialize response");

    assert_eq!(decoded, response);
    assert!(matches!(decoded.outcome, ResponseOutcome::Ok(Response::Health(_))));
}
```

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
cargo test -p vault-protocol --test schema
```

Expected: compilation fails because the protocol types and `validate_version` do not exist.

- [ ] **Step 4: Implement the version 1 wire contract**

Replace `crates/vault-protocol/src/lib.rs` with:

```rust
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RequestEnvelope {
    pub version: u16,
    pub id: String,
    pub request: Request,
}

impl RequestEnvelope {
    pub fn new(id: impl Into<String>, request: Request) -> Self {
        Self { version: PROTOCOL_VERSION, id: id.into(), request }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    Health,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResponseEnvelope {
    pub version: u16,
    pub id: String,
    pub outcome: ResponseOutcome,
}

impl ResponseEnvelope {
    pub fn success(id: impl Into<String>, response: Response) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            outcome: ResponseOutcome::Ok(response),
        }
    }

    pub fn error(id: impl Into<String>, error: ProtocolError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            outcome: ResponseOutcome::Err(error),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum ResponseOutcome {
    Ok(Response),
    Err(ProtocolError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Response {
    Health(HealthResponse),
}

impl Response {
    pub fn health(service: impl Into<String>) -> Self {
        Self::Health(HealthResponse { service: service.into(), status: "ok".into() })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HealthResponse {
    pub service: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub supported_version: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    IncompatibleVersion,
    InvalidRequest,
    Internal,
}

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(ProtocolError {
        code: ErrorCode::IncompatibleVersion,
        message: format!("unsupported protocol version {version}"),
        supported_version: Some(PROTOCOL_VERSION),
    })
}
```

- [ ] **Step 5: Verify the green state and serialization shape**

Run:

```bash
cargo fmt --all
cargo test -p vault-protocol --test schema
cargo clippy -p vault-protocol --all-targets -- -D warnings
```

Expected: three tests pass; Clippy exits with no warnings.

- [ ] **Step 6: Commit the protocol schema**

```bash
git add Cargo.toml Cargo.lock crates/vault-protocol
git commit -m "feat(protocol): define versioned health schema"
```

---

### Task 3: In-process daemon dispatch

**Files:**

- Modify: `Cargo.toml`
- Create: `crates/vault-server/Cargo.toml`
- Create: `crates/vault-server/src/lib.rs`
- Create: `crates/vault-server/tests/health.rs`
- Modify through Cargo: `Cargo.lock`

**Interfaces:**

- Consumes: `RequestEnvelope`, `Request::Health`, `Response`, `ResponseEnvelope`, and `validate_version` from `vault_protocol`.
- Produces: `vault_server::Server::default` and `vault_server::Server::handle(RequestEnvelope) -> ResponseEnvelope`.

- [ ] **Step 1: Add the server crate manifest and workspace member**

Change the workspace member list in root `Cargo.toml` to:

```toml
members = ["crates/vault-core", "crates/vault-protocol", "crates/vault-server"]
```

Create `crates/vault-server/Cargo.toml`:

```toml
[package]
name = "vault-server"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[dependencies]
serde_json.workspace = true
vault-protocol = { path = "../vault-protocol" }
```

Create an empty `crates/vault-server/src/lib.rs`.

- [ ] **Step 2: Write the failing health-dispatch tests**

Create `crates/vault-server/tests/health.rs`:

```rust
use vault_protocol::{
    ErrorCode, Request, RequestEnvelope, Response, ResponseOutcome, PROTOCOL_VERSION,
};
use vault_server::Server;

#[test]
fn server_dispatches_health_requests() {
    let response = Server::default().handle(RequestEnvelope::new("health-1", Request::Health));

    assert_eq!(response.id, "health-1");
    match response.outcome {
        ResponseOutcome::Ok(Response::Health(health)) => {
            assert_eq!(health.service, "vaultd");
            assert_eq!(health.status, "ok");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[test]
fn server_rejects_incompatible_versions_before_dispatch() {
    let mut request = RequestEnvelope::new("health-2", Request::Health);
    request.version = PROTOCOL_VERSION + 1;

    let response = Server::default().handle(request);
    match response.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::IncompatibleVersion);
            assert_eq!(error.supported_version, Some(PROTOCOL_VERSION));
        }
        other => panic!("unexpected response: {other:?}"),
    }
}
```

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
cargo test -p vault-server --test health
```

Expected: compilation fails because `vault_server::Server` does not exist.

- [ ] **Step 4: Implement the minimum dispatcher**

Replace `crates/vault-server/src/lib.rs` with:

```rust
use vault_protocol::{
    Request, RequestEnvelope, Response, ResponseEnvelope, validate_version,
};

#[derive(Clone, Debug, Default)]
pub struct Server;

impl Server {
    pub fn handle(&self, request: RequestEnvelope) -> ResponseEnvelope {
        let id = request.id;
        if let Err(error) = validate_version(request.version) {
            return ResponseEnvelope::error(id, error);
        }

        match request.request {
            Request::Health => ResponseEnvelope::success(id, Response::health("vaultd")),
        }
    }
}
```

- [ ] **Step 5: Verify the green state**

Run:

```bash
cargo fmt --all
cargo test -p vault-server --test health
cargo clippy -p vault-server --all-targets -- -D warnings
```

Expected: two tests pass; Clippy exits with no warnings.

- [ ] **Step 6: Commit daemon dispatch**

```bash
git add Cargo.toml Cargo.lock crates/vault-server
git commit -m "feat(server): dispatch protocol health requests"
```

---

### Task 4: Newline-delimited JSON daemon process

**Files:**

- Create: `crates/vault-server/src/main.rs`
- Create: `crates/vault-server/tests/stdio.rs`

**Interfaces:**

- Consumes: `Server::handle`, `RequestEnvelope`, and `ResponseEnvelope`.
- Produces: the `vaultd` executable, which reads one JSON `RequestEnvelope` per non-empty stdin line and writes one JSON `ResponseEnvelope` per line.

- [ ] **Step 1: Write the failing process-level test**

Create `crates/vault-server/tests/stdio.rs`:

```rust
use std::io::Write;
use std::process::{Command, Stdio};

use vault_protocol::{Request, RequestEnvelope, Response, ResponseEnvelope, ResponseOutcome};

#[test]
fn vaultd_serves_a_health_request_over_stdio() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start vaultd");

    let request = RequestEnvelope::new("process-1", Request::Health);
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(stdin, "{}", serde_json::to_string(&request).expect("serialize request"))
            .expect("write request");
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for vaultd");
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));

    let response: ResponseEnvelope =
        serde_json::from_slice(&output.stdout).expect("deserialize response");
    assert_eq!(response.id, "process-1");
    assert!(matches!(response.outcome, ResponseOutcome::Ok(Response::Health(_))));
}
```

- [ ] **Step 2: Run the process test and confirm the red state**

Run:

```bash
cargo test -p vault-server --test stdio
```

Expected: compilation fails because Cargo has no `vaultd` binary target and therefore does not define `CARGO_BIN_EXE_vaultd`.

- [ ] **Step 3: Implement the stdio process skeleton**

Create `crates/vault-server/src/main.rs`:

```rust
use std::error::Error;
use std::io::{self, BufRead, Write};

use vault_protocol::RequestEnvelope;
use vault_server::Server;

fn main() {
    if let Err(error) = run() {
        eprintln!("vaultd: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let server = Server;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: RequestEnvelope = serde_json::from_str(&line)?;
        let response = server.handle(request);
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
```

- [ ] **Step 4: Verify the green state and malformed-input failure mode**

Run:

```bash
cargo fmt --all
cargo test -p vault-server --test stdio
printf '%s\n' '{"not":"a request"}' | cargo run -q -p vault-server; test $? -eq 2
cargo clippy -p vault-server --all-targets -- -D warnings
```

Expected: the process test passes; malformed input prints a `vaultd:` error to stderr and exits 2; Clippy exits with no warnings.

- [ ] **Step 5: Commit the executable skeleton**

```bash
git add crates/vault-server/src/main.rs crates/vault-server/tests/stdio.rs
git commit -m "feat(server): add stdio daemon skeleton"
```

---

### Task 5: Architecture and compatibility contracts

**Files:**

- Create: `README.md`
- Create: `VAULTD-COMPATIBILITY.md`
- Create: `docs/adr/0001-core-language.md`
- Create: `docs/protocol.md`
- Create: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Consumes: protocol version `1`, implemented `health` operation, and the six boundaries in `docs/design/foundation.md`.
- Produces: the public north-star README, tiered compatibility contract, accepted language ADR, version 1 protocol document, and a test that prevents required documents or key contract declarations from disappearing.

- [ ] **Step 1: Write the failing documentation-contract test**

Create `crates/vault-server/tests/docs.rs`:

```rust
use std::fs;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn assert_document_contains(relative: &str, required: &[&str]) {
    let path = repository_root().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    for phrase in required {
        assert!(text.contains(phrase), "{} must contain {phrase:?}", path.display());
    }
}

#[test]
fn required_foundation_documents_declare_their_contracts() {
    assert_document_contains(
        "README.md",
        &["semantic runtime for Obsidian-compatible vaults", "Filesystem persistence", "Non-goals"],
    );
    assert_document_contains(
        "VAULTD-COMPATIBILITY.md",
        &["Tier 0 — Storage compatibility", "Tier 1 — Semantic compatibility", "Undocumented Obsidian internals"],
    );
    assert_document_contains(
        "docs/adr/0001-core-language.md",
        &["Status: Accepted", "Decision: Rust", "Go"],
    );
    assert_document_contains(
        "docs/protocol.md",
        &["Protocol version: `1`", "health", "apply_mutation", "subscribe"],
    );
}
```

- [ ] **Step 2: Run the documentation test and confirm the red state**

Run:

```bash
cargo test -p vault-server --test docs
```

Expected: the test fails because `README.md` does not exist.

- [ ] **Step 3: Write the concise north-star README**

Create `README.md` with these sections and exact claims:

```markdown
# vaultd

`vaultd` is an open, high-performance semantic runtime for Obsidian-compatible vaults. Obsidian is one client.

## North star

The vault's ordinary files are authoritative. `vaultd` adds semantics, safe coordination, queries, and events without converting Markdown into a proprietary database.

## Boundaries

### Filesystem persistence
Markdown, YAML properties, attachments, Canvas, Bases, and `.obsidian` remain Obsidian-compatible files.

### Semantic runtime
`vault-core` will own lossless document semantics, identities, revisions, resolution, and mutation rules.

### Protocol
`vault-protocol` exposes versioned transport-neutral requests, responses, events, and errors.

### Client runtimes
MCP, CLI, URI handling, Obsidian acceleration, the Node API shim, Swift, Elisp, Sync adapters, mobile, and e-ink clients remain consumers of the runtime.

## Workspace

- `vault-core`: semantic types and runtime ports
- `vault-protocol`: stable external contract
- `vault-server`: daemon composition and stdio proof transport

## Current milestone

The foundation implements semantic identity primitives, protocol versioning, and health dispatch. See `VAULTD-COMPATIBILITY.md`, `docs/protocol.md`, and `docs/adr/0001-core-language.md`.

## Non-goals

This milestone does not parse or mutate vault files, build an index, run plugins, render UI, or implement Sync.

## Development

Run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`.
```

- [ ] **Step 4: Write the compatibility-tier contract**

Create `VAULTD-COMPATIBILITY.md` with:

```markdown
# vaultd Obsidian Compatibility Contract

Compatibility is tiered. A higher tier never weakens the filesystem guarantees below it.

## Tier 0 — Storage compatibility

**Contract:** An unmodified stock Obsidian installation can open the vault directory. `vaultd` preserves Markdown, YAML properties, attachments, `.canvas`, `.base`, and `.obsidian` content it does not own. The filesystem is authoritative; indexes and journals are rebuildable support data.

The foundation defines this contract but performs no vault writes.

## Tier 1 — Semantic compatibility

**Target contract:** Match documented Obsidian behavior for wikilinks, Markdown links, aliases, headings, blocks, embeds, tags, properties, backlinks, unresolved links, and path/link resolution. Compatibility claims require fixture tests against observed Obsidian behavior.

The foundation supplies only identity, revision, and source-span primitives.

## Tier 2 — Behavioral and interface compatibility

**Target contract:** Provide documented operations for note lookup, search, resolution, backlinks, compare-and-swap mutation, recoverable transactions, events, CLI commands, and `obsidian://` URI handling. Protocol support is declared per operation and version.

Only `health` is executable in protocol version 1 of this milestone.

## Tier 3 — Headless Obsidian plugin API compatibility

**Research contract:** A separate Node runtime may implement documented non-UI portions of `App`, `Vault`, `MetadataCache`, and `FileManager` against `vaultd`. Plugin compatibility will be measured per plugin and API surface.

Undocumented Obsidian internals are best-effort and never part of the stable core contract.

## Tier 4 — UI runtime compatibility

**Out of scope for the semantic runtime:** Workspace layout, editor behavior, CodeMirror, DOM views, Electron behavior, themes, and CSS belong to client runtimes.

## Synchronization compatibility

Sync is orthogonal to the tiers. Adapters exchange generic blobs, revisions, conflicts, and tombstones. Obsidian Sync, Git, WebDAV, or another provider must not change core semantics or filesystem authority.

## Consumer matrix

| Consumer | Foundation status | Intended boundary |
| --- | --- | --- |
| MCP | Documented consumer | Protocol adapter |
| CLI and URI handling | Documented consumers | Protocol adapters |
| Obsidian accelerator | Documented consumer | Protocol client plugin |
| Node Obsidian API shim | Research target | Plugin API facade |
| Swift clients | Documented consumers | Protocol or future FFI |
| GNU Emacs/Elisp host | Documented consumer | Protocol client |
| Sync adapters | Documented consumers | Generic sync boundary |
| Mobile and e-ink clients | Documented consumers | Cached protocol clients or future embedded core |
```

- [ ] **Step 5: Record the core-language ADR**

Create `docs/adr/0001-core-language.md`:

```markdown
# ADR 0001: Core implementation language

Status: Accepted

## Context

`vaultd` begins as a daemon but is intended to support native clients, Node bindings, Swift/mobile embedding, FFI, and high-performance lossless parsing. The external protocol must remain independent of implementation language.

## Decision: Rust

Use Rust for `vault-core`, `vault-protocol`, and `vault-server`.

Rust provides explicit ownership across concurrent mutation paths, a small native deployment artifact, predictable C-compatible FFI options, WebAssembly and mobile targets, and a practical path to sharing one semantic implementation across daemon and embedded clients.

## Alternatives considered

### Go

Go offers simpler early daemon development, strong standard networking support, and straightforward concurrency. Its garbage-collected runtime and C interoperation are a poorer fit for embedding the same core inside Swift, mobile, Node, or other native processes.

### Split-language core from the outset

A Go daemon plus a separate native library would optimize the first server milestone but create two semantic implementations before compatibility behavior is stable.

## Consequences

- Contributors must preserve a protocol boundary that does not expose Rust-specific types.
- The first milestone accepts modest Rust scaffolding cost for future embedding flexibility.
- Parser, storage, and index modules remain inside `vault-core` until independent dependency or release boundaries justify new crates.
- The decision is reversible at the daemon layer because clients depend on the versioned protocol.
```

- [ ] **Step 6: Write the initial protocol design**

Create `docs/protocol.md`:

````markdown
# vaultd Protocol

Protocol version: `1`

The protocol is transport-neutral. The foundation's newline-delimited JSON stdio loop is a proof transport, not a production transport commitment.

## Envelope rules

Every request carries `version`, client-chosen `id`, and one tagged request. Every response echoes `id`, reports the server protocol `version`, and contains either an `ok` response or an `err` protocol error. Unknown or unsupported versions fail before operation dispatch.

```json
{"version":1,"id":"req-1","request":{"method":"health"}}
```

```json
{"version":1,"id":"req-1","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}
```

## Implemented operation

### `health`

Returns the service name and `ok` status. It performs no filesystem access.

## Reserved operation families

These names document intended boundaries and are not accepted by the version 1 Rust request enum in this milestone:

- `get_vault_info`
- `get_note`
- `resolve_link`
- `get_backlinks`
- `query`
- `search`
- `apply_mutation`
- `begin_transaction`
- `commit_transaction`
- `abort_transaction`
- `subscribe`

Mutation operations will carry expected revisions. Transaction and subscription identifiers will be opaque strings. Concrete payloads enter the protocol only with executable behavior and compatibility tests.

## Errors

Stable version 1 codes are `incompatible_version`, `invalid_request`, and `internal`. Domain errors such as missing notes and revision conflicts will receive protocol codes when their operations are introduced.

## Evolution

Adding optional fields is backward-compatible. Adding operations is backward-compatible for servers and clients that reject unknown tagged variants cleanly. Renaming fields, changing meanings, or removing variants requires a new protocol version.
````

- [ ] **Step 7: Run the documentation test and full verification suite**

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
printf '%s\n' '{"version":1,"id":"manual-health","request":{"method":"health"}}' | cargo run -q -p vault-server
git diff --check
```

Expected:

- all core, protocol, server, process, and documentation tests pass;
- Clippy exits with no warnings;
- documentation builds;
- the manual command prints one JSON response with ID `manual-health`, service `vaultd`, and status `ok`;
- `git diff --check` exits cleanly.

- [ ] **Step 8: Commit the public contracts**

```bash
git add README.md VAULTD-COMPATIBILITY.md docs/adr/0001-core-language.md docs/protocol.md crates/vault-server/tests/docs.rs
git commit -m "docs: define compatibility and protocol contracts"
```

---

## Completion Gate

Before reporting completion, re-read `docs/design/foundation.md` and verify every success criterion against fresh output from:

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
git status --short --branch
git log --oneline --decorate -6
```

The implementation is ready for independent review only when all commands succeed, the five scoped implementation commits exist, `.permission-check` remains untracked and unchanged, and no excluded subsystem has been introduced.

## Claude Code Handoff

Open `~/repos/system/vaultd/docs/design/foundation.md` and this plan in full. Create an isolated worktree using `superpowers:using-git-worktrees`, then execute Tasks 1–5 in order with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Stop after the completion gate and independent review; do not add a remote, push, merge, or broaden scope without the maintainer's authorization.
