//! Print snapshot-page JSON for markdown fed on stdin, one request per line.
//!
//! Everything is in [`vault_server::fixture_row`], because the DTO mapping this
//! must not reimplement is `pub(crate)` in that crate and a `src/bin/*.rs` file
//! is a crate of its own.

fn main() -> std::io::Result<()> {
    vault_server::fixture_row::main()
}
