//! Print snapshot-page JSON for markdown fed on stdin, one request per line.
//!
//! Everything is in [`vault_server::fixture_row`], because the DTO mapping this
//! must not reimplement is `pub(crate)` in that crate and a `src/bin/*.rs` file
//! is a crate of its own.

//!
//! With `--base-views`, it instead reads one `.base` document on stdin and
//! prints its view names as a JSON array (`[]` when it does not parse), so
//! Task 13's capture script asks Obsidian about exactly the views vaultd
//! evaluates.

use std::io::Read;

fn main() -> std::io::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--base-views") {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        let names = vault_bases::parse_base(&text)
            .map(|base| base.view_names())
            .unwrap_or_default();
        println!("{}", serde_json::to_string(&names)?);
        return Ok(());
    }
    vault_server::fixture_row::main()
}
