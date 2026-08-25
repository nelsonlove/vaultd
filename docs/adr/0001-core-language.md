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
