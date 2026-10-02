# vaultd Bases Evaluation Design

## Status

Approved direction for phase 8, the phase following the socket transport (merged to main as `b391820`). Approach and sections approved on 2026-10-01 and 2026-10-02; the decisions are in the Rulings section at the end.

## Summary

This phase teaches `vaultd` to evaluate Obsidian Bases. A `.base` file is YAML that declares filters, formulas, property display settings, summaries and views over the files of a vault; Obsidian evaluates it inside the app, and nothing outside the app can today. After this phase the daemon parses every `.base` in the vault as an indexed file kind, resolves links to bases and to their views, and answers one new request, `evaluate_base`, with a view's rows as paths plus typed cells, computed at the current generation from the live graph and the index. The daemon never renders: a client turns typed cells into a table, cards, a list or a board. Results are cached per generation, and a new event tells subscribers which views may have changed, so a web client can keep an embedded view live by re-asking.

The design is "evaluate on request, cache per generation, coarse invalidation" (approach C). It fits the daemon's existing shape: every answer is computed at a generation and is correct by construction; freshness comes from the generation stream the daemon already publishes; and incremental materialization (approach B) remains an upgrade that changes no protocol.

## Evidence and motivation

- The maintainer's own vault holds 51 `.base` files. They use most of the published language: `if`, `date().format()`, `today()`, `number()`, `isEmpty()`, `list()`, `map`/`filter`/`reduce`, `containsAny`, `file.hasTag`, `file.inFolder`, `linksTo`, `this.file`; formulas in 19 files, `groupBy` in 14, summaries in 2, and one plugin-provided view type, `fileclass-table`. The corpus is the acceptance test.
- The HTMX client spike on the phase 7 socket (branch `spike/htmx-client`) rendered notes in half a millisecond but could not resolve `![[Views.base#Table]]`: the daemon's resolver resolves links to notes only, so the embed stayed unresolved, and the view name arrived as a heading subpath. Both are fixed here.
- The semantic read-path design listed Bases evaluation as a deferred semantic capability beside search. The index already stores every property as JSON per note (`properties.key_text`, `value_json`), tags, references, resolutions, and per-file size and times in the tree entries, so the raw material exists and only the evaluator and a property index are new.
- Obsidian publishes the Bases syntax, functions and views (`obsidian.md/help/bases/…`), so parity is reachable from the documents and runtime captures without touching `app.asar`, which the repository's standing rule forbids.

## Goals

1. Parse every `.base` file into an indexed record with its views and parse diagnostics; re-parse on change in the same generation as any other file.
2. Implement the whole published Bases language: every type, operator and function on the reference, `this`, formulas, summaries, and the view declarations (table, cards, list, kanban, map) as row data plus declared options.
3. One additive request, `evaluate_base`, answering rows with typed cells at a generation; one additive request, `list_bases`; one additive event, `views_invalidated`.
4. Links to `.base` files resolve; `![[X.base#View]]` resolves to the named view; a missing view is `missing_subpath`.
5. Parity with Obsidian on that vault's 51 bases, proved by runtime captures on a scratch vault.
6. Performance: a filtered, sorted 100-row table under 20 ms p50 warm on the 10k fixture; the unfiltered whole-vault view under 100 ms; a cache hit under 1 ms; reconciliation cost within 5 percent of today.

## Non-goals (deferred, not refused)

Rendering of any kind; editing or writing `.base` files beyond what `write_file` already does; incremental materialized views (approach B); the `fileclass-table` view's semantics (a plugin's; passed through as declared); Map's geodata and tiles; `random()` determinism across clients; search.

## Architecture

### The `vault-bases` crate

A new crate, pure Rust, no I/O, no SQLite, no protocol types: it takes a `.base` document and a row source and produces rows. It has three parts.

**The file model.** `BaseFile { filters, formulas, properties, summaries, views }` parsed from YAML with `saphyr` (already in the workspace; its span markers index in characters, and the crate converts to byte offsets as `vault-core` does). `filters` is a recursive tree of `and` / `or` / `not` over expression strings; `formulas` is a map from name to expression; `properties` carries per-property display settings (`displayName` and whatever else the file declares, kept as an open map); `summaries` is a map from name to expression over `values`; `views` is an ordered list, each with `type`, `name`, its own `filters`, `order`, `sort` (property and direction), `groupBy` (property and direction), `limit`, `summaries`, and every other key kept as an open map so a plugin's options survive the round trip. An unknown view `type` is kept as declared; the daemon neither refuses nor interprets it.

**The expression language.** A tokenizer and a Pratt parser produce an expression tree: literals (string, number, boolean), property references (`note.x`, `file.x`, `formula.x`, and the bare `x` form Obsidian accepts for note properties), member access and method calls, the operators `+ - * / %`, `== != < <= > >=`, `! && ||`, and the global functions on the reference. The evaluator is a tree walker over a typed value model: `Null`, `String`, `Number` (f64), `Boolean`, `Date` (instant plus a has-time flag), `Duration`, `List`, `Object`, `Link` (target text, display, resolved path), `File` (a handle into the row source), `Regexp`, and the render-only `Image`, `Icon`, `Html`, which carry their arguments and are passed to the client as declared. Every function on the published reference is implemented (the global functions; the `any`, `date`, `string`, `number`, `list`, `link`, `file`, `object` and `regexp` methods; the `date` and `list` fields). Coercion, equality across types, mixed-type sort order, truthiness, `format()` strings (Moment.js syntax, implemented for the tokens the captures exercise, with an `unsupported_format_token` diagnostic for the rest), and `relative()` wording come from runtime captures (Testing), never from guesses; where a capture is missing the behaviour is a typed diagnostic rather than an invention.

**The row source.** A trait the daemon implements: enumerate candidate files, read a file's properties, tags, links, backlinks, embeds, folder, name, extension, size, ctime and mtime, resolve a link, and look a file up by path. The crate never touches SQLite or the live graph directly, so it can be unit-tested over an in-memory source and could later run inside a plugin.

### The base as an indexed file

The index gains a `bases` table (path, parse status, declared view names in order, and parse diagnostics as JSON) populated by the reconciler whenever a `.base` file is created, changed or removed, in the same generation as any other change. `.base` is added to the parsed kinds beside `.md`; attachments stay bytes. The live graph holds the parsed `BaseFile` per path so evaluation does not re-read the file.

The link resolver gains non-note targets: a reference whose `file_target` resolves to a `.base` tree entry is `resolved` with that path; a subpath on a base is a view name, so `SubpathDto` gains a `view` kind, and `![[X.base#Table]]` resolves to `{ target: "X.base", subpath: { kind: "view", value: "Table" } }` when the view exists and `missing_subpath` when it does not. This is the first non-note resolution in the protocol and it is additive: the resolution kinds do not change, only the targets they can name.

### Rows and prefilters

A view's candidate set is every file in the tree, notes and attachments alike, because a base without filters shows all files. The compiler extracts prefilters from the top of the filter tree: conjuncts of the forms `file.inFolder("…")`, `file.hasTag("…")`, `file.ext == "…"`, and scalar property equality `x == literal`, each served by an index, narrow the set before any expression runs; everything else runs per row. A new `property_scalars` table (note path, key, kind, string value, number value) indexes string, number, boolean and date scalars per note and key, maintained by the reconciler beside `properties`; lists and objects are not indexed and are evaluated per row.

Evaluation order per view: prefilters, then the global filters and the view's filters as one conjunction, then formulas (memoized per row), then `sort` (stable, by the declared keys and directions, with the captured mixed-type order), then `groupBy`, then `limit` (applied after sort and before grouping, as Obsidian does; the captures settle it), then summaries over the surviving rows per column.

### The operations

`evaluate_base` takes `path` (the base), `view` (a name; absent means the first declared view), `this_path` (the embedding note, absent means the base itself), `cursor` and `limit` (default 100, maximum 1000, the protocol's rule for every collection operation). It answers `generation`, `view` (its declared `type`, `name` and open options), `columns` (the `order` list with each property's display name and the property's declared settings), `rows` (each a `path`, a `kind` of `note` or `file`, the `group` key when grouped, and `cells` as a list aligned with `columns`), `summaries` (name to typed value), `total_rows`, and `next_cursor`. A cell is a typed JSON value: `{"kind":"string","value":…}`, `number`, `boolean`, `date` (ISO 8601 plus `has_time`), `duration` (milliseconds), `list` (of cells), `object`, `link` (`target`, `display`, `resolved` path or null), `file` (path), `image`, `icon`, `html` (their arguments), `null`, and `error` (message). The cursor encodes the generation, the base, the view, `this_path` and the row position; a stale generation is `generation_mismatch` as everywhere else.

`list_bases` pages the bases with their view names and parse status.

Both operations are requests like any other: they run on the dispatcher, read the live graph and the index at the current generation, and share the coordinator with nothing (reads take no lease). A long evaluation therefore blocks that connection's other requests, as every read does; it never blocks another connection or reconciliation.

### Freshness: the cache and `views_invalidated`

Results are cached per (base, view, `this_path`, generation) in a bounded LRU (default 64 entries, a config knob), so repeated reads at one generation cost under a millisecond. The cache is dropped per key when the generation advances.

After each committed generation the daemon marks views as possibly stale by a coarse rule, cheap enough to run on every commit: a view is stale when its base changed, when a changed path is in the view's last row set, when a changed path matches the view's prefilters, or when the view reads formulas, links or backlinks and any note changed. For each stale view the daemon emits one `views_invalidated` event naming `base`, `view` and the new `generation`, through the same registry and bounds as every event (so it is subject to the 64-event per-subscription bound and the lag marker, and never blocks the coordinator). A client re-asks and gets the new generation's rows. False positives are accepted; false negatives are a defect. The rule is a documented approximation, and approach B replaces it later without a protocol change.

### `this`

`this` is the embedding note when `this_path` is given, the base's own path otherwise. `this.file` is a `File` for that path, so `file.hasLink(this.file)` and `value.link.linksTo(this.file)` evaluate against the row source. The cache key includes `this_path` because two embeddings of one view differ.

## Error handling

- A `.base` that does not parse: the index row carries `parse_failed` with the YAML position; `evaluate_base` answers `base_invalid` with the same; `list_bases` shows it; a diagnostic appears in `get_diagnostics` under the base's path.
- A view name that does not exist: `view_not_found`, naming the declared views.
- An expression that fails to compile (syntax, unknown function or method): the base still indexes; the view answers `expression_invalid` naming the expression and position; an unknown function is `unsupported_function` naming it.
- An expression that fails on one row (a type error, a division by zero, a missing property in a method call): the cell is `{"kind":"error","message":…}` and the row stays, as Obsidian renders an error cell rather than dropping the row (confirmed by capture).
- A `this_path` that is not a note or does not exist: `invalid_request`.
- A `limit` of 0 or above 1000: `invalid_cursor`, as for every collection operation.
- Health-only mode (no vault): `index_unavailable`, as for every indexed read.

## Performance requirements

Measured on the 10k-note fixture, warm, with the phase 7 harness extended by a `--base` case over a committed fixture base: a filtered, sorted table of 100 rows under 20 ms p50; the unfiltered whole-vault table page under 100 ms p50; a cache hit under 1 ms p50; a `.base` change reconciled in the same time as a note change within 5 percent; the per-commit staleness rule under 1 ms with 50 bases indexed. Reconciliation of notes with no base in the vault is unchanged within 5 percent. Every miss is reported as a miss with its mechanism.

## Testing

- **Parity corpus.** The real vault's 51 `.base` files, plus the notes their filters and formulas need, copied into a scratch vault under `target/tmp` by a script that lists what it copied; the vault's owner opens that scratch vault once in Obsidian; a capture script drives the `obsidian` CLI to open each view and record its rows and cell texts per view; the captures are committed as fixtures. The suite evaluates every view through `evaluate_base` and diffs rows and rendered cell text against the capture. The live vault is never read by the daemon or the tests; only the copy script reads it, once, run by the vault's owner.
- **Function captures.** One capture note per function family exercises each function on edge inputs (null, empty, mixed types, dates without time, lists of lists); the unit tests pin the captured results.
- **Unit tests** in `vault-bases` over an in-memory row source: parsing every example on the published pages; every function; coercion and comparison tables; sort order; `groupBy`; `limit`; summaries.
- **Property tests**: comparison is antisymmetric and transitive within the captured order; `sort` is stable; `list` round-trips.
- **Index tests**: a `.base` create, change and delete each move the generation and the `bases` table; parse diagnostics appear and clear; `property_scalars` matches `properties` after every mutation (an oracle over the fuzz the mirror already runs).
- **Resolver tests**: `[[X.base]]`, `![[X.base#View]]`, a missing view, a renamed base (link repair follows).
- **Protocol tests**: both operations and the event in the conformance fixture set over both transports; paging and `generation_mismatch`; every error code.
- **Freshness tests**: a note change that enters, leaves and reorders a view's rows fires `views_invalidated` exactly for that view; a change unrelated to any view fires nothing; the cache hits at one generation and misses at the next.
- **Client**: the HTMX spike gains an embedded view that re-renders on `views_invalidated`, as a smoke test and a demonstration, on its own branch.
- **Gates**: every gate reports its process exit code; MSRV 1.85; clippy clean; `TMPDIR` under `target/tmp`; nothing points at the live vault.

## Documentation

`docs/protocol.md`: the two operations, the event, the cell model, the resolver's base targets and the `view` subpath, the staleness rule and its false positives. `docs/design/semantic-read-path.md`: one line noting Bases evaluation landed here. `README.md`: what the daemon does with a base. `docs/performance/bases-evaluation-baseline.md`: the measurements. `VAULTD-COMPATIBILITY.md`: what parity means for Bases and what is captured versus assumed.

## Rulings (2026-10-01 and 2026-10-02)

1. Bases evaluation lives in `vaultd` as a protocol operation, not in a client (the daemon over a JavaScript evaluator in the web client).
2. The first cut is the whole published language, verified by runtime captures on a scratch vault, with the real vault's 51 bases as the acceptance corpus (over the subset those bases use).
3. Approach C: evaluate on request, cache per generation, coarse invalidation with a `views_invalidated` event (over on-request-only and materialized views).
4. The eight design sections as presented.
5. Standing from earlier phases and unchanged: the live vault is never read by a daemon, test or fixture; parity comes from runtime captures and published documents, never from `app.asar`; the spec lives repo-local in `docs/design/`.

## Deferred follow-on

Incremental materialized views with per-expression dependency tracking (approach B); a `fileclass-table` view adapter; Map geodata; search; a client-side renderer package for the cell model; Bases over snapshot sessions for hydration.
