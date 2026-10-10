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

**The expression language.** A tokenizer and a Pratt parser produce an expression tree: literals (string, number, boolean), property references (`note.x`, `file.x`, `formula.x`, and the bare `x` form Obsidian accepts for note properties), member access and method calls, the operators `+ - * / %`, `== != < <= > >=`, `! && ||`, and the global functions on the reference. The evaluator is a tree walker over a typed value model: `Null`, `String`, `Number` (f64), `Boolean`, `Date` (instant plus a has-time flag), `Duration`, `List`, `Object`, `Link` (target text, display, resolved path), `File` (a handle into the row source), `Regexp`, and the render-only `Image`, `Icon`, `Html`, which carry their arguments and are passed to the client as declared. Every function on the published reference is implemented (the global functions; the `any`, `date`, `string`, `number`, `list`, `link`, `file`, `object` and `regexp` methods; the `date` and `list` fields). Coercion, equality across types, mixed-type sort order, truthiness, `format()` strings (Moment.js syntax, implemented for the tokens the captures exercise, with an `unsupported_format_token` diagnostic for the rest), and `relative()` wording come from runtime captures (Testing), never from guesses; where a capture is missing the behaviour is a typed diagnostic rather than an invention. (Fact, after the Task 13 captures, 2026-10-09: `format()` reads Moment's tokens and treats an unknown letter as a literal, as Obsidian does, so `unsupported_format_token` remains only for a Moment token this build does not implement; a behaviour no capture could reach answers a provisional rule listed for re-capture in `VAULTD-COMPATIBILITY.md`, and only `keys()` and `values()` of an object holding an integer-like key beside others still answer a typed "uncaptured" error. The published sentences the captures contradicted are listed under "Facts the captures corrected" below. A regular expression value goes on the wire as a `string` cell `/source/flags`.)

**The row source.** A trait the daemon implements: enumerate candidate files, read a file's properties, tags, links, backlinks, embeds, folder, name, extension, size, ctime and mtime, resolve a link, and look a file up by path. The crate never touches SQLite or the live graph directly, so it can be unit-tested over an in-memory source and could later run inside a plugin.

### The base as an indexed file

The index gains a `bases` table (path, parse status, declared view names in order, and parse diagnostics as JSON; as shipped it also keeps the content revision, the source bytes, which hydration re-parses into the live graph, and the observed size and modification time) populated by the reconciler whenever a `.base` file is created, changed or removed, in the same generation as any other change. `.base` is added to the parsed kinds beside `.md`; attachments stay bytes. The live graph holds the parsed `BaseFile` per path so evaluation does not re-read the file.

The link resolver gains non-note targets: a reference whose `file_target` resolves to a `.base` tree entry is `resolved` with that path; a subpath on a base is a view name, so `SubpathDto` gains a `view` kind, and `![[X.base#Table]]` resolves to `{ target: "X.base", subpath: { kind: "view", value: "Table" } }` when the view exists and `missing_subpath` when it does not. This is the first non-note resolution in the protocol and it is additive: the resolution kinds do not change, only the targets they can name. (Fact, after the final review's M1: the resolution kinds are unchanged, but the subpath kinds are not; a decoder built before phase 8 refuses a `view` subpath, so a client on it cannot decode a response holding one. The protocol version stays `1` by the repository's evolution rule, and `docs/protocol.md` records the break under **Evolution**.)

### Rows and prefilters

A view's candidate set is every file in the tree, notes and attachments alike, because a base without filters shows all files. The compiler extracts prefilters from the top of the filter tree: conjuncts of the forms `file.inFolder("…")`, `file.hasTag("…")`, `file.ext == "…"`, and scalar property equality `x == literal`, each served by an index, narrow the set before any expression runs; everything else runs per row. Scalar columns on `properties` (folded key, kind, string value, number value) index string, number, boolean and date scalars per note and key, written by the reconciler with each property row; lists and objects are not indexed and are evaluated per row. (Schema v4 kept them in a separate `property_scalars` table; schema v5 folded them into `properties` after Task 14 measured the second row per property at +7 to +12 percent on a cold build.)

Evaluation order per view: prefilters, then the global filters and the view's filters as one conjunction, then formulas (memoized per row), then `sort` (stable, by the declared keys and directions, with the captured mixed-type order), then `groupBy`, then `limit` (applied after sort and before grouping, as Obsidian does; the captures settle it), then summaries over the surviving rows per column. (Fact, as shipped: the order of the steps is prefilters, filters, formulas, sort, limit, groupBy, summaries — `limit` counts sorted rows before grouping, captured by Task 13 — and the mixed-type order is the total order of ruling 8, not Obsidian's comparator.)

### The operations

`evaluate_base` takes `path` (the base), `view` (a name; absent means the first declared view), `this_path` (the embedding note, absent means the base itself), `cursor` and `limit` (default 100, maximum 1000, the protocol's rule for every collection operation). It answers `generation`, `view` (its declared `type`, `name` and open options), `columns` (the `order` list with each property's display name and the property's declared settings), `rows` (each a `path`, a `kind` of `note` or `file`, the `group` key when grouped, and `cells` as a list aligned with `columns`), `summaries` (name to typed value), `total_rows`, and `next_cursor`. A cell is a typed JSON value: `{"kind":"string","value":…}`, `number`, `boolean`, `date` (ISO 8601 plus `has_time`), `duration` (milliseconds, plus `months`, the calendar months kept apart from them — fact correction: the published duration units include months, which have no fixed length in milliseconds), `list` (of cells), `object` (an ordered list of `{key, value}` entries — fact correction, 2026-10-02: the protocol already represents a mapping that way, as `PropertyMappingEntryDto`), `link` (`target`, `display`, `resolved` path or null), `file` (path), `image`, `icon`, `html` (their arguments), `null`, and `error` (message). The cursor encodes the generation, the base, the view, `this_path` and the row position; a stale generation is `generation_mismatch` as everywhere else. (Facts, as shipped: the cursor also carries the instant the result was computed at, so a page whose result left the cache is recomputed with the same `now()` and the same `random()` sequence; `summaries` is keyed by the property the view's own `summaries` map declares the summary under; the view's open options and a column's settings are ordered lists of `{key, value}` entries in the property DTO's value shape, not JSON objects; a non-finite number travels as a `string` cell holding JavaScript's text; a cell nests at most 32 levels, the value at the cap becoming an error cell.)

`list_bases` pages the bases with their view names and parse status.

Both operations are requests like any other: they run on the dispatcher, read the live graph and the index at the current generation, and share the coordinator with nothing (reads take no lease). A long evaluation therefore blocks that connection's other requests, as every read does; it never blocks another connection or reconciliation. (Fact, as shipped after the Task 11 review: an evaluation pins its generation under the publication guard on a private pooled read connection and evaluates with the guard released, so a publication during a whole-vault evaluation took 0.87 to 0.98 ms instead of 354 to 360 ms; a pin that meets moving live state is retried with backoff for up to two seconds before `storage_failure`.)

### Freshness: the cache and `views_invalidated`

Results are cached per (base, view, `this_path`, generation) in a bounded LRU (default 64 entries, a config knob), so repeated reads at one generation cost under a millisecond. The cache is dropped per key when the generation advances. (Facts, as shipped: the knob is `--bases-cache-entries`, from 1 to 4096; every entry of an older generation is dropped on the first request at a newer one; the key also carries a types epoch, bumped by each change to `.obsidian/types.json`, the source of declared property types, so an answer computed under older types is never served again; after the final review's M2, a view that reads `today()` is keyed by the local day as well, a view that reads `now()` or `relative()` is never cached, and a page recomputed at its cursor's instant is never stored under a newer generation; no event marks the day turning over.)

After each committed generation the daemon marks views as possibly stale by a coarse rule, cheap enough to run on every commit: a view is stale when its base changed, when a changed path is in the view's last row set, when a changed path matches the view's prefilters, or when the view reads formulas, links or backlinks and any note changed. For each stale view the daemon emits one `views_invalidated` event naming `base`, `view` and the new `generation`, through the same registry and bounds as every event (so it is subject to the 64-event per-subscription bound and the lag marker, and never blocks the coordinator). A client re-asks and gets the new generation's rows. False positives are accepted; false negatives are a defect. The rule is a documented approximation, and approach B replaces it later without a protocol change. (Facts, as shipped: clause 4 reads "any changed file" for a view that reads links or `this` (ruling 6); the rule gained two clauses, accepted on the plan's rulings of 2026-10-02 because they only add events — a view that reads `this` is stale when any file changed, and a note whose references re-resolved to a different answer counts as changed; the rule runs on every committed generation whether or not anyone subscribes, memoized per generation; a `config_changed` for `.obsidian/types.json` names every known view; and the client contract adds "re-ask an answer whose generation is older than the newest `generation_committed` you have seen", because an evaluation on one connection can be recorded after another connection's dispatcher decided a newer generation. `docs/protocol.md` carries the six clauses and the known false positives. The events are not subject to the lag marker in practice: one generation can stale more views than a subscriber queue holds, so they are queued half a queue at a time and drained in between, with the same backpressure every notice meets, rather than collapsing onto `subscriber_lag`.)

### `this`

`this` is the embedding note when `this_path` is given, the base's own path otherwise. `this.file` is a `File` for that path, so `file.hasLink(this.file)` and `value.link.linksTo(this.file)` evaluate against the row source. The cache key includes `this_path` because two embeddings of one view differ. (Fact, from the Task 13 captures: the `obsidian` CLI's `base:query` treats `this` as null, so the 61 corpus views that read `this` could not be captured through it and are skipped by the replay; synthetic probe views captured from an opened base show `this` is the base there.)

## Error handling

- A `.base` that does not parse: the index row carries `parse_failed` with the YAML position; `evaluate_base` answers `base_invalid` with the same; `list_bases` shows it; a diagnostic appears in `get_diagnostics` under the base's path.
- A view name that does not exist: `view_not_found`, naming the declared views.
- A filter that fails to compile (syntax, unknown function or method): the base still indexes; the view answers `expression_invalid` naming the expression and position; an unknown function is `unsupported_function` naming it. A formula or a base summary that fails to compile does not refuse the view: its column is an error cell in every row, and the summary an error, naming the parse or lookup failure (ruling 7).
- An expression that fails on one row (a type error, a division by zero, a missing property in a method call): the cell is `{"kind":"error","message":…}` and the row stays, as Obsidian renders an error cell rather than dropping the row (confirmed by capture).
- A `this_path` that is not a note or does not exist: `invalid_request`.
- A `limit` of 0 or above 1000: `invalid_cursor`, as for every collection operation.
- Health-only mode (no vault): `index_unavailable`, as for every indexed read.

## Performance requirements

Measured on the 10k-note fixture, warm, with the phase 7 harness extended by a `--base` case over a committed fixture base: a filtered, sorted table of 100 rows under 20 ms p50; the unfiltered whole-vault table page under 100 ms p50; a cache hit under 1 ms p50; a `.base` change reconciled in the same time as a note change within 5 percent; the per-commit staleness rule under 1 ms with 50 bases indexed. Reconciliation of notes with no base in the vault is unchanged within 5 percent. Every miss is reported as a miss with its mechanism. The measurements are in `docs/performance/bases-evaluation-baseline.md`: all six numbers were met after Task 14's fix round (the no-base cold build first missed at +7.4 to +11.8 percent from the second scalar row per property, and met at -0.1 to +3.1 percent once schema v5 folded those columns into `properties`).

## Testing

- **Parity corpus.** The real vault's 51 `.base` files, plus the notes their filters and formulas need, copied into a scratch vault under `target/tmp` by a script that lists what it copied; the vault's owner opens that scratch vault once in Obsidian; a capture script drives the `obsidian` CLI to open each view and record its rows and cell texts per view; the captures are committed as fixtures. (Facts, as run on 2026-10-09: the copy took 163 bases and 2,356 files and never entered the guarded private folder; Obsidian was 1.13.7; only the 857 synthetic captures of generated bases are committed, and the 339 captures of the real vault's views stay local, outside the repository, by the ruling of 2026-10-08 that real-corpus captures do not belong in the repository.) The suite evaluates every view through `evaluate_base` and diffs rows and rendered cell text against the capture. The live vault is never read by the daemon or the tests; only the copy script reads it, once, run by the vault's owner.
- **Function captures.** One capture note per function family exercises each function on edge inputs (null, empty, mixed types, dates without time, lists of lists); the unit tests pin the captured results.
- **Unit tests** in `vault-bases` over an in-memory row source: parsing every example on the published pages; every function; coercion and comparison tables; sort order; `groupBy`; `limit`; summaries.
- **Property tests**: comparison is antisymmetric and transitive within the captured order; `sort` is stable; `list` round-trips.
- **Index tests**: a `.base` create, change and delete each move the generation and the `bases` table; parse diagnostics appear and clear; every property row's scalar columns classify its value after every mutation (an oracle over the fuzz the mirror already runs).
- **Resolver tests**: `[[X.base]]`, `![[X.base#View]]`, a missing view, a renamed base (link repair follows).
- **Protocol tests**: both operations and the event in the conformance fixture set over both transports; paging and `generation_mismatch`; every error code.
- **Freshness tests**: a note change that enters, leaves and reorders a view's rows fires `views_invalidated` exactly for that view; a change unrelated to any view fires nothing; the cache hits at one generation and misses at the next.
- **Client**: the HTMX spike gains an embedded view that re-renders on `views_invalidated`, as a smoke test and a demonstration, on its own branch.
- **Gates**: every gate reports its process exit code; MSRV 1.85; clippy clean; `TMPDIR` under `target/tmp`; nothing points at the live vault.

## Documentation

`docs/protocol.md`: the two operations, the event, the cell model, the resolver's base targets and the `view` subpath, the staleness rule and its false positives. `docs/design/semantic-read-path.md`: one line noting Bases evaluation landed here. `README.md`: what the daemon does with a base. `docs/performance/bases-evaluation-baseline.md`: the measurements. `VAULTD-COMPATIBILITY.md`: what parity means for Bases and what is captured versus assumed.

## Facts the captures corrected

Task 13 captured Obsidian 1.13.7 on 2026-10-09, and these published sentences, which earlier tasks had implemented, did not hold; each is a fact correction, not a change to a ruling, and the full table is in `VAULTD-COMPATIBILITY.md` under **Bases parity**:

- `date - date` is a duration (`a day`, its `milliseconds` field 86400000), not a number of milliseconds; the Task 5 decision to follow the page's "millisecond difference" no longer holds. `duration * number` is a duration too.
- "Exactly 24 hours": whole days added to a date keep the wall-clock time across a daylight-saving change, and so does `"24h"`; `"25h"` is one day plus an exact hour; a span written in hours gives a date-only value a time.
- `1 / 0` is `Infinity` and `1 % 0` is `NaN`, not errors; an empty list or object is falsy.
- `date("bad")`, `duration("soon")` and a method on a missing value are empty, not errors; `asFile()` of a URL link is an error, not empty.
- `format("W")` is the ISO week, and an unknown letter is a literal, not an unsupported-token error.
- `escapeHTML` keeps `'`; `image(url)` shows `![](url)`; a list's `toString` joins with `", "`.
- List `contains` uses loose `==`; `mean()` is the numbers' total over every item's count; `containsAll()` with no argument is true.
- `file.name` drops `.md` for a note; `file.links` holds the embeds; a backlink is a link (with no `name`); `link()` and `asLink()` show `[[target]]` or `[[target|display]]`.

## Rulings (2026-10-01 and 2026-10-02)

1. Bases evaluation lives in `vaultd` as a protocol operation, not in a client (the daemon over a JavaScript evaluator in the web client).
2. The first cut is the whole published language, verified by runtime captures on a scratch vault, with the real vault's 51 bases as the acceptance corpus (over the subset those bases use).
3. Approach C: evaluate on request, cache per generation, coarse invalidation with a `views_invalidated` event (over on-request-only and materialized views).
4. The eight design sections as presented.
5. Standing from earlier phases and unchanged: the live vault is never read by a daemon, test or fixture; parity comes from runtime captures and published documents, never from `app.asar`; the spec lives repo-local in `docs/design/`.
6. Clause 4 of the staleness rule: any changed file, not any changed note, for a view that reads links or `this` (`file()`, `link()` and `asFile()` reach attachments); the published rule left a false negative (Task 12 review finding M1, ruled in its fix round on 2026-10-08).
7. R1, formula errors (2026-10-09; the project picked Obsidian's behaviour): a formula that cannot be parsed, or a call to an unknown function or method, no longer refuses the request; the view answers and that formula's column carries an error cell in every row with the parse or lookup message as its text, while a base whose filters cannot be parsed still answers `base_invalid` / `expression_invalid` at request level, because there are no rows to show. The parser follows Obsidian too (the controller, 2026-10-09, after the re-review): exponent literals, a method on a bare number literal, object literals, a regular expression literal JavaScript refuses, and a raw line or paragraph separator inside a string are parse errors, so a formula holding one is an error cell and a filter holding one a request-level error.
8. R2, sort order (2026-10-09; the project picked a total order): a view's sort is a transitive total order over every cell kind (booleans, then numbers, then dates, then text by collation, empty values last), not Obsidian's comparator, which ties a boolean with every truthy value and orders a number against text by its text; views that mix kinds where Obsidian's order differs are listed in the replay's `deviations.json` as "R2: total order by ruling".

## Deferred follow-on

Incremental materialized views with per-expression dependency tracking (approach B); a `fileclass-table` view adapter; Map geodata; search; a client-side renderer package for the cell model; Bases over snapshot sessions for hydration.

Left open when phase 8 closed (facts, not rulings):

- Attachment resolution in the vault-core resolver. Today the vault-index row source resolves the attachments a link reaches (for `links()` and `backlinks()` alike), cached per evaluation, because the resolver is built from the live graph, which holds notes and bases only; moving it means the live graph tracks attachments and changes `resolve_link` answers and diagnostics for every client (Task 13 review finding M5).
- The re-captures listed under **Bases parity** in `VAULTD-COMPATIBILITY.md`: a sort key no column shows, the case rule of text `contains` (and `startsWith`, list `contains`), `view:case` through a rendered embed, a non-finite float inside a view option, and the corpus views that read `this`. They need the scratch vault opened in Obsidian again.
- The phase 6 plugin-host captures that still need a live Obsidian, queued from that phase.
- Phase C of the resolver timing: a client resolving after every publication adds about 0.1 ms through cache effects while the writer does no work, measured but unexplained (Task 14).
- The look-behind detection: a look-behind is told apart from a bad pattern by the `regex` crate's "not supported" error text, which a test pins but a crate upgrade could change.
- The `vault-watch` `filesystem_smoke` flake (`create_modify_delete_a_markdown_file_eventually_surfaces_a_paths_hint`), which misses its deadline in a loaded workspace run and passes alone; `README.md` lists it with the other known flaky tests.
- The amplification of `ViewTracker::record` under a write burst (final review L4): an evaluation that races a commit voids newer decisions, so each void generation names every view and every client re-asks every view, which can race the next commit. Only false positives, as accepted, but not measured; the measurement is N clients against a publish every 7 ms in the baseline, or a cap on the conservative answer at the views some subscriber was answered.
- An event for the day turning over. A fresh request is answered for its own clock (fact, after the final review's M2: a view reading `today()` is cached per local day, and one reading `now()` or `relative()` is never cached), but a client holding an answer is not told that a new day began.
