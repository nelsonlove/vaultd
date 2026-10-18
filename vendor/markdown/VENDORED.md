# Vendored: markdown-rs 1.0.0

This folder is the `markdown` crate, version 1.0.0, from crates.io (upstream: <https://github.com/wooorm/markdown-rs>, tag `1.0.0`, MIT, see `license`). The workspace `Cargo.toml` points at it with `[patch.crates-io] markdown = { path = "vendor/markdown" }`.

## What changed

Only `src/util/edit_map.rs`. Everything else is the crate as published. `Cargo.toml` is the published (normalized) manifest with its `[dev-dependencies]` and `readme` key removed: the published crate has no tests or readme to go with them, and the dev-dependencies (`swc_core`, `criterion`) would otherwise enter vaultd's lockfile.

- `EditMap::add` and `EditMap::add_before` used to scan every pending edit to find one at the same place. That is quadratic in the number of edits, and on a 2 MB note it was about 80% of the parse time (`add_impl` in the profile). Now an edit is appended in O(1). `consume` sorts the edits with a stable sort, so edits at the same place stay in call order, and merges them with the same rules as before (`add` appends, `add_before` prepends). The output is the same, edit for edit.
- New tests in the same file: the merge order at one place, a randomized comparison against a copy of the 1.0.0 `EditMap` (with linked events), reuse after `consume`, and a timing test that fails on 1.0.0 (100,000 edits added in reverse order took 38.7 s in a debug build).

## Why

A cold first index of large vaults spent most of its parse time here. One 2 MB note took 1.1 to 1.7 s to parse; with this change it takes about 0.25 s. The numbers are in `.superpowers/sdd/markdown-patch-report.md` (not committed).

## Upstream

Upstream already has an open pull request with the same approach: <https://github.com/wooorm/markdown-rs/pull/233> ("Improve performance of the edit map", opened 2026-09-28, not merged as of 2026-10-17). It also makes many `add_before` calls at one place linear, which this copy does not (that case was not in vaultd's profile). Related: issue #218, and the older pull requests #197 (a `BTreeMap`) and #217. vaultd has sent nothing upstream; a comment with vaultd's numbers for #233 is drafted, not posted. When a release contains #233 or an equal fix, drop this copy (below).

## How to drop the patch

When a markdown-rs release contains the fix (or an equal one):

1. Delete the `[patch.crates-io]` section from the workspace `Cargo.toml`.
2. Delete `vendor/markdown/`.
3. Raise `markdown` in `[workspace.dependencies]` to that release, and run `cargo update -p markdown`.
4. Run the workspace tests.

To check that this copy still matches upstream except for the patch: `diff -r vendor/markdown/src ~/.cargo/registry/src/*/markdown-1.0.0/src` must show only `util/edit_map.rs`.
