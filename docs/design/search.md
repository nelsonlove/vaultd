# vaultd Search Design

## Status

Draft for the owner's review, phase 9, the phase following Bases evaluation. The owner's decisions (2026-10-17) are recorded in the Rulings section at the end, which wins over the body; every other decision below is a recommendation, with what it costs if it is wrong, and becomes a ruling only when the owner accepts it. The three questions of the first draft were ruled (Rulings 4 to 6), so none is open. The implementation plan's pre-flight review (2026-10-17) corrected four statements here so the design and the plan agree: the per-file match cap is 100, performance requirement 2 bounds a cached page with `context: none`, `IndexReader::search` returns `IndexError`, and `compile` takes the case toggle (a `Features` argument is deferred).

## Summary

This phase teaches `vaultd` to answer Obsidian's core Search. A client sends a query string in Obsidian's own search syntax, and the daemon answers the files that match, each with its match spans, computed at the current generation from the index the daemon already keeps. The target is feature parity with Obsidian's Search plugin; the first cut is a minimum viable product small enough to land for the next demo, and the phase ends with a parity harness that runs the same queries through a running Obsidian and through `vaultd` and compares the answers.

The design is "parse once, scan exactly, cache per generation". A new pure crate, `vault-search`, owns the query grammar, its syntax tree and a matcher that decides, for one file, whether it matches and where; it does no I/O. `vault-index` feeds it the files of one pinned generation: the note text it already stores, the file tree, tags, and later the structural rows and properties. `vault-server` adds one request, `search`, with paging, a per-generation result cache and two error codes. No index is added for the first cut: every answer is an exact scan, correct by construction, and an FTS5 trigram prefilter is designed as a later, measurement-gated upgrade that changes no answer and no protocol.

## Evidence and motivation

- The owner, 2026-10-17: "yeah. definitely we want search", and later: "final step after our mvp (which could land in the next demo) would be testing against obsidian's native search with vault-mcp or the obsidian CLI against the vaultd results so we know our search is consistent with obsidian's. we want of course feature parity with obsidian here".
- `docs/protocol.md` has reserved the name `search` since phase 2 (**Reserved operation families**), and the semantic read-path design listed search beside Bases as a deferred semantic capability. Bases landed in phase 8; search is the remaining one.
- The headless plugin host reports `global-search` as present-but-absent (`host/packages/host/src/shim/internal-plugins.ts`, `VIEW_ONLY`), with `instance: null`. A golden plugin in the host's corpus, tag-wrangler, calls `app.internalPlugins.getPluginById("global-search").instance.getGlobalSearchQuery()` and `.openGlobalSearch("tag:#" + tag)` from its tag menu (`host/fixtures/golden/tag-wrangler/plugin/main.js`), so its three search menu items do nothing headless today.
- The index already stores what a search reads. `notes.source_bytes` holds every note's exact text (schema v5, `crates/vault-index/src/schema_v5.sql`); `tree_entries` lists every non-hidden file with its size and times; `tags` holds body and frontmatter tags with their spans and a folded comparison key; `headings`, `sections` (Obsidian's `CachedMetadata.sections`) and `list_items` (with the raw task character) hold the structure; `properties` holds every frontmatter property with its value as JSON. So the first cut needs no schema change, and the parity operators read rows that exist.
- The HTMX client spike renders notes and live Bases views from the socket; a search box and Obsidian's embedded ```` ```query ```` blocks are the visible half of this phase for a demo.
- Neither existing route to Obsidian's search is a source of truth on its own. The `obsidian` CLI has `search`, `search:context` and `search:open` (see **What the Obsidian CLI and vault-mcp offer**), which run Obsidian's real search. The vault-mcp server's `obsidian_search_notes` tool does not: it lowercases the query and scans each Markdown file line by line for it as one literal substring, with no operators, no regex and no word splitting. A parity harness therefore captures through the CLI, never through that vault-mcp tool.

## What Obsidian's Search does

Sources, all fetched 2026-10-17:

- [S1] The Search help page, `https://obsidian.md/help/plugins/search`, read as its raw Markdown source at `https://publish-01.obsidian.md/access/f786db9fac45774fa4f0d8112e232d67/Plugins/Search.md`.
- [S2] The public API typings, `https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts` (`prepareSimpleSearch`, `prepareFuzzySearch`, `SearchResult`, `SearchMatches`, `SearchMatchPart`, `renderResults`, `sortSearchResults`).
- [S3] The Obsidian 0.10.3 changelog, `https://obsidian.md/changelog/2020-12-29-desktop-v0.10.3/`, which introduced `line:`, `block:` and `section:` with sub-queries.
- [S4] The forum thread "API endpoint for searching file content", `https://forum.obsidian.md/t/api-endpoint-for-searching-file-content/11482`, which shows the internal route `app.internalPlugins.plugins["global-search"].instance.openGlobalSearch(query)` and reading results from the `search` view's `dom.resultDomLookup`.
- [S5] The installed `obsidian` CLI's own `help search`, `help search:context` and `help search:open`.
- [S6] tag-wrangler's bundle in this repository's host corpus (`host/fixtures/golden/tag-wrangler/plugin/main.js`), for the two internal methods it calls.

What the sources state:

- **What is searched.** "Obsidian only searches the contents of notes and canvases" [S1]. "By default, you can only search the paths and filenames of notes and canvases. To search for a path or filename of any file in the vault, use the `path` or `file` operator" [S1]. Files matching the **Excluded files** setting do not appear in results [S1].
- **Terms.** "Each word in the search term is matched independently within each file" [S1]. A phrase is quoted (`"star wars"`), and a quote inside a phrase is escaped with a backslash (`"they said \"hello\" to each other"`) [S1].
- **AND, OR, grouping.** Juxtaposition is AND (`meeting work`); `OR` is either (`meeting OR work`); `meeting work OR meetup personal` "returns files for work meetings and personal meetups", which fixes the precedence: AND binds tighter than OR. Parentheses group: `meeting (work OR meetup) personal` [S1].
- **Negation.** A leading hyphen negates a word (`meeting -work`), several words (`meeting -work -meetup`) and a group (`meeting -(work meetup)`, "not both") [S1]; `-line:` negates an operator ("files where no line matches") [S1].
- **Comparison.** `<` and `>` inside square brackets or quotes: `meeting [duration:<5]`, `[duration:>5]` [S1].
- **Operators.** `file:` (text in the file name, any file in the vault, `file:.jpg`), `path:` (text in the path, any file, `path:"Daily notes/2022-07"`), `content:` (text in the content), `match-case:` (case-sensitive), `ignore-case:` (case-insensitive), `tag:` (a tag; `tag:#work` does not return `#myjob/work`; ignores code blocks and non-Markdown content), `line:` (at least one line matches; `line:(mix flour)`), `block:` (matches in the same block; parses every file, slower), `section:` (matches in the same section, the text between two headings), `task:`, `task-todo:`, `task-done:` (matches in a task, uncompleted task and completed task, "on a block-by-block basis") [S1]. "Some operators even allow you to add a nested search term within parentheses, for example: `task:(call OR email)`" [S1]; `line:`, `block:` and `section:` take sub-queries [S3].
- **Properties.** `[property]` (files with that property), `[property:value]` (files whose property has that value), `[property:null]` (the property exists with no value; works for `aliases: ` but not for `""` or `[]`); "Both property and value allow sub-queries, such as parentheses for grouping, the `OR` operator, double-quotes for exact matching, and regex": `[status:Draft OR Published]` [S1].
- **Regular expressions.** Surrounded by slashes, `/\d{4}-\d{2}-\d{2}/`; combinable with operators, `path:/\d{4}-\d{2}-\d{2}/`; "Obsidian uses JavaScript-flavored regular expressions" [S1].
- **Case.** Not case-sensitive by default; a **Match case** toggle makes the whole search case-sensitive [S1]; `match-case:` and `ignore-case:` override it per term [S1]; the CLI's `case` flag is the same toggle [S5].
- **Sort orders.** File name (A to Z), the default; File name (Z to A); Modified time (new to old); Modified time (old to new); Created time (new to old); Created time (old to new) [S1]. There is no relevance order.
- **Results and settings.** Results are per file with context; the settings are **Explain search term** (a plain-text breakdown of the query), **Collapse results** and **Show more context**; **Copy search results** copies them [S1]. An empty query lists recent search terms [S1].
- **Embedded results.** A fenced code block with the info string `query` embeds live results in a note [S1].
- **Match spans in the API.** `SearchResult { score, matches }`, where `matches` is a list of `[start, end]` pairs [S2]; positions in Obsidian's own APIs count JavaScript string (UTF-16) units, which is also what the host's position index converts to (`host/packages/host/src/mirror/positions.ts`).
- **Programmatic access.** There is no public API for vault-wide search [S2]; the search view's plugin instance has `openGlobalSearch(query)` [S4, S6] and `getGlobalSearchQuery()` [S6].

**UNVERIFIED, to be settled by the parity harness.** Each of these is implemented as a provisional rule, named `P1` to `P23`, and listed in `VAULTD-COMPATIBILITY.md` until a capture settles it:

- P1. Plain terms match by substring, not by whole word (the help says "matched independently", never "whole word").
- P2. A plain term or phrase matches a note's path as well as its content (the help's tip implies the paths and file names of notes and canvases are searched by default), and whether that is the whole path or the file name.
- P3. Case folding is JavaScript's `toLowerCase` on both sides (not Unicode case folding), including the final-sigma rule.
- P4. Diacritics are not folded (`cafe` does not match `café`), and Unicode text is not normalized (NFC and NFD spellings differ).
- P5. Frontmatter text is part of the content a plain term matches.
- P6. `OR` is recognized only in upper case; `or` is a plain term.
- P7. A word whose prefix before `:` is not a known operator (`foo:bar`) is a plain term.
- P8. A malformed query (an unbalanced parenthesis or quote, a dangling `-`, an empty `()`, a regex that does not compile) is refused rather than read leniently.
- P9. `tag:work` and `tag:#work` are the same; a tag matches itself and its descendants (`#work/meeting`) but not a tag that only ends in it (`#myjob/work`, which [S1] states); tag comparison ignores case.
- P10. Which files a query with a negation can return: non-note files are candidates only when a positive `file:` or `path:` term could match them, so `-foo` does not list every attachment.
- P11. A regex follows the Match case toggle, and the JavaScript features the `regex` crate lacks (look-around, back-references) are refused by name.
- P12. `task-done:` means any task whose box holds a character other than a space, and `task-todo:` a space.
- P13. `block:` units are Obsidian's `sections` (the top-level blocks `vaultd` already stores), `task:` units are list items with a task box, `section:` units run from one heading to the next heading of any level.
- P14. `[prop:value]` matches by substring of the value's text, case-insensitively, any element of a list property, and the comparisons `<` and `>` compare numbers.
- P15. The File name sort compares base names with `localeCompare` (numeric, locale `en`), the order `vault_bases::collate` already implements, ties broken by path.
- P16. Canvas content means the `text` of text nodes (and whether file and link node labels count).
- P17. Excluded files are the `userIgnoreFilters` of `.obsidian/app.json`, matched as path prefixes or as `/regex/`.
- P18. What a match span is for a plain term in a path, and whether a file name match is reported separately from content matches. The capture must also test a match that comes after an `İ`, a `ẞ` and a Kelvin sign `K` (characters whose lowercase form has a different length), to learn whether Obsidian's offsets point into the lowercased text or the original; vaultd's point into the original.

Provisional parse rules. The parser (Task 1) follows the lexical rules of the plan where [S1] is silent; these edges follow from those rules, Obsidian's behaviour on them is unverified, and the parity harness settles them:

- P19. An empty phrase `""` and an empty regex `//` parse as terms; what an empty needle matches is decided by the matcher and the evaluator (Tasks 2 and 3), never by a search that loops or reports a span at every position. The matcher (Task 2) rules that an empty text needle matches nothing: `Needle::find_all` answers no spans and `is_match` answers false, whatever the case mode (pinned by `an_empty_needle_matches_nothing`); the empty regex is Task 11's.
- P20. A slash term whose last segment is only JavaScript flag letters reads as a regex: `/tmp/my` is the regex `tmp` with the flags `my`, while `/usr/local` is a word.
- P21. Repeated flag letters parse (`/a/gg`); whether they are refused is left to the regex compiler.
- P22. A regex can span whitespace: in `a / b / c` the middle term is the regex ` b `.
- P23. A `"` inside a word is part of the word (`a"b` is one word), not the start of a phrase.

## What the Obsidian CLI and vault-mcp offer

The `obsidian` CLI [S5]: `search query=<text> [path=<folder>] [limit=<n>] [total] [case] [format=text|json]` ("Search vault for text"; `limit` counts files; `total` returns a match count), `search:context` (the same, "with matching line context"), and `search:open query=<text>` (opens the search view). The help does not say whether `query=` takes the full operator grammar, nor what the JSON carries; the first capture task records both. The CLI also has `eval code=<javascript>`, which follows the working directory rather than `vault=` (a fact the Bases captures established), and is the route to the search view's own result lookup for spans and order [S4].

vault-mcp: `obsidian_search_notes` takes `query`, `limit` (hits, at most 500) and `mode` (`one_per_note` or `all`), and answers `{path, line, snippet}` per hit from a homemade case-insensitive literal substring scan of Markdown files; `obsidian_omnisearch` calls the third-party Omnisearch plugin. Neither runs Obsidian's search, so neither is a parity source. vault-mcp is a consumer of `search` instead: once this phase lands, its search tool can be answered by `vaultd` with the full grammar (a change in that repository, tracked there, not in this plan).

## Goals

1. One additive request, `search`, that takes a query in Obsidian's syntax and answers the matching files with match spans in Obsidian-compatible positions, paged, at one generation.
2. A first cut (the MVP) small enough for the next demo: plain terms, quoted phrases, implicit AND, `OR`, parentheses, `-` negation, `file:`, `path:`, `content:`, `tag:`, `match-case:`, `ignore-case:`, the Match case toggle, and all six sort orders.
3. Then feature parity: regular expressions, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:` with sub-queries, property search with `null` and comparisons, canvas content (out of this phase by Ruling 4, issue #3), excluded files, and a structured explanation of a query.
4. The plugin host serves a real `global-search` instance, so a plugin can open a search headless and a host client can see it and its results.
5. A parity harness that runs one query set through a running Obsidian and through `vaultd` on the same generated vault and compares file sets, match spans and order; every difference becomes a ruled exception or a bug.
6. Performance: see **Performance requirements**; reconciliation unchanged.

## Non-goals (deferred, not refused)

Fuzzy or relevance-ranked search (Obsidian has none; Omnisearch is a plugin); search inside attachments (PDF text, images); live search subscriptions (see **Freshness**); the Explain setting's prose wording (the daemon explains structurally); recent-search history; Copy search results formatting; rendering of any kind; a search index inside the vault; Obsidian's own query parser from `app.asar`, which the repository's standing rule forbids.

## Architecture

### The `vault-search` crate

A new crate, pure Rust, no I/O, no SQLite, no protocol types, on the model of `vault-bases`: it takes a query string and a source of documents and produces hits. It depends on `vault-core` (paths, spans) and on `vault-bases` for two things that crate already pins against Obsidian captures, its text collation (`vault_bases::collate`, `localeCompare` numeric with locale `en`) for the File name sort, and its JavaScript-regex compiler for regex terms (made public in the parity phase). Three parts:

**The grammar and the tree.** A lexer and a recursive-descent parser over the grammar below produce a `Query` tree. Positions in errors are character offsets into the query string, because a query is something a person typed.

```text
query    := or_expr?
or_expr  := and_expr ( "OR" and_expr )*
and_expr := unary+                         -- juxtaposition is AND
unary    := "-" unary | primary
primary  := "(" or_expr ")"
          | OPERATOR ":" operand            -- file: path: content: tag: line: block: section:
          |                                 -- task: task-todo: task-done: match-case: ignore-case:
          | "[" name ( ":" value )? "]"     -- property search
          | PHRASE | REGEX | WORD
operand  := "(" or_expr ")" | PHRASE | REGEX | WORD
```

`OR` binds looser than juxtaposition, as [S1]'s `meeting work OR meetup personal` shows. A `WORD` runs to whitespace or a parenthesis; a hyphen negates only at the start of a unary. The tree:

```rust
pub enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Term(Term),                                  // a word, phrase or regex, in the default scope
    Scoped { scope: Scope, query: Box<Node>, at: Range<usize> },   // file: path: content: tag: line: block: section: task*:
    Case { sensitive: bool, query: Box<Node>, at: Range<usize> },  // match-case: ignore-case:
    Property { name: Box<Node>, value: Option<PropertyValueQuery>, at: Range<usize> },
}
pub enum Pattern { Text(String), Regex { source: String, flags: String } }
pub struct Term { pub pattern: Pattern, pub phrase: bool, pub at: Range<usize> }
pub enum Scope { File, Path, Content, Tag, Line, Block, Section, Task, TaskTodo, TaskDone }
```

The parser accepts the whole grammar from the first task, so a query that names a parity operator in the MVP is refused with a precise `unsupported_operator`, never misread as text.

**The matcher.** One `Needle` per term, compiled with its case mode (the request's toggle, overridden by the nearest `match-case:` or `ignore-case:`). A text needle folds by JavaScript's `toLowerCase` semantics (P3) and finds every non-overlapping occurrence in a haystack, answering byte spans into the original text, never into a folded copy. The reference implementation folds both sides into a buffer with a byte-offset map; an ASCII fast path is allowed only because a property test pins it against the reference on generated Unicode text. A regex needle compiles once through `vault-bases`' JavaScript-flavoured compiler.

**Compile and evaluate.** `compile(&Query, match_case: bool) -> Result<CompiledQuery, CompileError>` checks every node against what this build supports (a run-time `Features` argument is deferred until a build needs one), and computes `needs()`: which facets of a document the query reads (path, text, tags, structure, properties), so the index loads only those. A positive `tag:` term needs the text as well as the tags, because a tag match is a content match whose `Loc`s come from the text. `evaluate(&CompiledQuery, &dyn SearchDocument) -> Option<FileHit>` decides one document: a boolean walk of the tree, and, for a match, the spans of every positive term that matched (Obsidian highlights each matched term; a term under a `Not` contributes no span). A `SearchDocument` gives its path, kind (`note`, `canvas`, `file`), and the facets `needs()` asked for. `MemoryDocument` is the in-memory source the crate's tests use. Sorting is part of the crate (`sort_hits(&mut [FileHit], SortOrder, &dyn Fn(&VaultPath) -> Times)`), so every consumer sorts identically.

Scope semantics: `content:` evaluates its operand against the text; `file:` against the file name (the last path segment, extension included, as `file:.jpg` implies); `path:` against the whole vault path; `tag:` against each tag (P9); `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:` evaluate the whole sub-query against each unit and match when one unit satisfies it (P13); a property node against the note's properties (P14). A plain term evaluates against the content, and against the path (P2), and the universe of candidate files follows P10.

### Where the text comes from: the index, scanned exactly

`vault-index` gains `IndexReader::search(&SearchQuery) -> Result<SearchAnswer, IndexError>`, which runs on the pinned evaluation read that Bases evaluation built (`reader.rs`, the eighth read shape): under the publication guard it pins a private pooled connection to the published generation, then releases the guard and scans. A long search therefore never holds up a publication and never blocks another connection; it delays only its own connection's next request, exactly as `evaluate_base` does, and a pin that meets moving state is retried with the same backoff and budget.

The scan is planned in two steps. First, the positive conjuncts at the top of the tree that need no text (`file:`, `path:`, `tag:` and, in the parity phase, property presence) narrow the candidate set before any text is read, in this phase through a metadata prefilter over the `tree_entries`, `tags` and (with property search) `properties` rows the scan reads, with indexed SQL left for a measurement to ask for; like the Bases prefilters, each narrowing selects a superset of the files its conjunct accepts, and the conjunct still runs per file, pinned by a property test. Second, the candidates stream through one prepared statement in path order, reading `notes.source_bytes` as a borrowed blob (no copy, no retention) together with whatever other facets `needs()` named, and each is evaluated. Non-note files carry no text; they are evaluated on their path alone.

Recommendation: **exact scan over the stored note text, no new index, for the MVP and the parity phase.** The reasons:

1. Obsidian's semantics are substring and regex matching (P1, [S1]). A token index (FTS5 with its default tokenizers) answers words, not substrings, so it would have to be a prefilter whose every candidate is verified against the text anyway; the verification is the scan.
2. The scan costs nothing on the write path. The index, reconciliation, the cold build and the warm-start contract of zero note-body reads (`docs/performance/persistent-index-baseline.md`) are untouched, so the phase-8 rule that reconciliation stays within 5 percent holds by construction.
3. It is correct by construction at a generation: it reads exactly the rows of the pinned generation, with no second structure to keep in step through the live-incremental runtime's dirty paths and publication barrier.
4. The cost is linear in the text. On the 10,000-note synthetic fixture (short notes) it is well inside the target; on a prose-sized vault it is measured, not assumed (a 10,000-note fixture of about 3 KB per note is part of the baseline), and the 100,000-note number decides the follow-on below.

**The follow-on, designed and not built: an FTS5 trigram prefilter.** The bundled SQLite is 3.46.0 with FTS5 enabled (`libsqlite3-sys` 0.30.1 builds with `SQLITE_ENABLE_FTS5`), which has the trigram tokenizer and its `remove_diacritics` option (3.45). A contentless table (`content=''`, `contentless_delete=1`) keyed by a `search_documents(id INTEGER PRIMARY KEY, path TEXT UNIQUE)` table, with `case_sensitive 0 remove_diacritics 1`, answers a superset for any literal of three or more characters whatever P3 and P4 settle to (both folds only widen the candidate set), and every candidate is still verified by the same matcher, so adopting it changes no answer. Terms shorter than three characters, and regexes with no extractable literal of three, fall back to the scan. Its costs are real: an index commonly several times the size of the text, and a write on every note change and in the cold build, which the 5-percent reconciliation rule would have to absorb. It is adopted only if the scan misses the 100,000-note target, on a measurement, by a ruling. An in-memory text cache was considered and rejected: it would hold every note body in the daemon's memory (the live graph deliberately holds none, `live_graph.rs`), and SQLite's page cache already keeps hot text in memory without a second copy.

Cost if wrong: if the scan is too slow at 100,000 notes, the trigram prefilter slots in behind `IndexReader::search` with a schema bump (an obsolete cache is rebuilt, never migrated), and no protocol or client changes.

### Canvas content (parity phase)

`vaultd` indexes `.md` and `.base` files; a `.canvas` is an attachment whose bytes it does not keep. Obsidian searches canvas content by default [S1], so parity needs canvas text in the index: schema v6 adds a `canvases` table (path, revision, source bytes, observed size and time, and the search text: the `text` of its text nodes in node order, joined by a blank line, P16), reconciled in the same generation as any other change on both routes, exactly as `bases` was. The extraction lives in `vault-search` as a pure function. A canvas is then a document of kind `canvas` whose text is its search text; its content spans and `Loc`s point into that search text, not into the file's JSON bytes, because a JSON string's escapes make byte positions in the file meaningless to a reader of the text. Ruled out of this phase (Ruling 4, issue #3); this section is where issue #3 starts. Until then a canvas is a `file` document, reached only by `file:` and `path:`. Cost if wrong: if skipped, any vault with canvases fails parity on every content query that a canvas would match; if done, every canvas change costs one row write, as a base does.

### Excluded files (parity phase)

Obsidian hides files matching the **Excluded files** setting from results [S1]; the setting is `userIgnoreFilters` in `.obsidian/app.json` (P17). The daemon reads it through the configuration zone when a search is computed (as Bases reads `.obsidian/types.json`), keeps an exclusion epoch bumped by a change to that file, keys the result cache by it, and the watcher passes exactly `.obsidian/app.json` beside `.obsidian/types.json`, raising `config_changed` for an external edit. A request may pass `include_excluded: true` to see everything.

### The operation

`search` takes:

- `query` (string, required): Obsidian syntax. An empty or all-whitespace query answers no files and is not an error (Obsidian shows recent searches there).
- `match_case` (boolean, default `false`): the Match case toggle.
- `sort` (default `file_name_asc`): `file_name_asc`, `file_name_desc`, `modified_desc`, `modified_asc`, `created_desc`, `created_asc`, the six orders of [S1]; ties by path.
- `context` (default `line`): `none`, or `line`, which adds each match's line text.
- `include_excluded` (boolean, default `false`, parity phase).
- `explain` (boolean, default `false`, parity phase): adds the parsed query as a tree.
- `cursor`, `limit` (files per page; default 100, from 1 to 1000), the protocol's collection rule.

It answers `generation`; `total_files` and `total_matches` over the whole answer; `items`, one per file, each with `path`, `kind` (`note`, `canvas` or `file`; `canvas` is reserved and never produced until issue #3), `path_matches` (spans in the path, in UTF-16 units of the path string, for terms that matched the file name or path), `content_matches`, and `matches_truncated` when a file had more matches than the per-file cap (100, so a default page of 100 files with line text stays near 7 MB, inside the protocol's 16 MiB payload cap, where 1000 would put it near 66 MB; the file still counts as matched, and `total_matches` counts every match); and `next_cursor`. A content match carries `span` (half-open UTF-8 byte offsets into the exact source, the protocol's rule for every span) and `start` and `end` as Obsidian `Loc`s (`line` zero-based, `col` and `offset` in UTF-16 units), so a plugin, vault-mcp or a web client can use the position without re-reading the note or rebuilding a position index; with `context: line` it also carries `line_text` (the line holding the match start, cut to at most 512 bytes around the match on character boundaries) and `line_text_start` (that cut's byte offset in the source). When canvas content lands (issue #3), for a canvas `span`, the `Loc`s and `line_text` refer to the canvas's search text (see **Canvas content**), not to the file's JSON bytes.

```json
{"version":1,"id":"q","request":{"method":"search","params":{"query":"meeting -work tag:#project","limit":1}}}
```

```json
{"version":1,"id":"q","outcome":{"status":"ok","value":{"type":"search","value":{"generation":12,"total_files":3,"total_matches":5,"items":[{"path":"Notes/Kickoff.md","kind":"note","path_matches":[],"content_matches":[{"span":{"start":21,"end":28},"start":{"line":2,"col":4,"offset":21},"end":{"line":2,"col":11,"offset":28},"line_text":"The meeting ran long.","line_text_start":17},{"span":{"start":40,"end":48},"start":{"line":3,"col":0,"offset":40},"end":{"line":3,"col":8,"offset":48},"line_text":"#project","line_text_start":40}],"matches_truncated":false}],"next_cursor":"eyJn…"}}}}
```

**One computation per query and generation.** A result is computed once per (normalized query, `match_case`, `sort`, generation, exclusion epoch) and every page is cut from it; it is kept in a bounded least-recently-used store (`--search-cache-entries`, default 16, from 1 to 1024), and every entry of an older generation is dropped on the first request at a newer one, as the Bases cache does. `context` changes only what a page renders, so it is not in the key. The cursor binds the generation, the normalized query, `match_case`, `sort`, `include_excluded` and the file position; a cursor presented with different parameters is `invalid_cursor`, and one from an older generation is `generation_mismatch` with `current_generation`. A page whose result has left the store is computed again at the cursor's generation only if that generation is still current; otherwise it is `generation_mismatch`.

Recommendation: these shapes. Cost if wrong: every field is additive, so a later field costs nothing; a wrong *meaning* (for example UTF-16 versus byte positions) would cost a protocol break, which is why both units are carried and named.

### Freshness

The MVP has no search event. A search answer names its generation; a client that holds one re-asks when a `generation_committed` it receives is newer, which is what the HTMX spike does for embedded query blocks. Unlike a Bases view, a search over one file depends on nothing but that file, so a later live search can be exact rather than coarse: re-evaluate the query on the changed paths alone and emit the files that entered, left or changed their matches. That subscription is designed here and deferred (Ruling 5, issue #1). Cost if wrong: a client re-asking on every commit pays one search per commit; at the MVP's cached-hit cost this is acceptable for a demo, and the subscription is additive.

### Errors

Two new codes, each naming what it refused:

- `query_invalid`: the query does not parse (P8) or a regex does not compile; the message names the problem, and the error carries `position`, the character offset in the query where it was found.
- `unsupported_operator`: the query uses an operator or construct Obsidian has and this build does not implement yet; the message names it. After the parity phase only regex constructs the `regex` crate cannot express remain under it (P11).

Otherwise the existing codes: `invalid_cursor` for a bad cursor or a `limit` out of range, `generation_mismatch`, `index_unavailable` in health-only mode, `invalid_request` for an unknown `sort` or `context` value (a value from a closed set, per the Evolution rule), `storage_failure` when a pin cannot be taken within the budget. A per-file failure does not exist: a file either matches or not.

### Consumers

**The plugin host.** `global-search` leaves `VIEW_ONLY` and gets a real instance, `GlobalSearchInstance`, with the two methods the corpus calls [S6]: `openGlobalSearch(query)` records the query as the host's current search, runs `search` on the engine, keeps the first page, and raises the host event `host.search_opened` to host subscribers; `getGlobalSearchQuery()` returns the current query (`""` when none). Headless, "open search" means exactly that: the search becomes the host's current search state, visible to any host client, because there is no pane to show it in. Two host operations serve it: `host.search` (run a query for a host client, a pass-through to the engine's `search`) and `host.search_state` (the current query and its last answer). The instance is present only when `core-plugins.json` enables `global-search`, as Obsidian's is. tag-wrangler's "Search for #tag", "Require #tag in search" and "Exclude #tag from search" then work headless. Cost if wrong: an instance that claims more than these two methods would be a claim the host cannot back, so nothing else is added.

**vault-mcp.** Out of this repository: its search tool can call `search` over the socket and gain the full grammar and real positions. Noted here so the protocol serves it: `{path, line, snippet}` is derivable from `start.line` and `line_text`.

**The HTMX spike.** A search box that renders hits with highlighted `line_text`, and ```` ```query ```` blocks rendered from `search` and refreshed on `generation_committed`, on the spike's own branch, as a smoke test and the demo.

### MVP versus parity

The MVP, for the next demo: plain words, phrases with escaped quotes, implicit AND, `OR`, parentheses, `-` on terms, groups and operators, `file:`, `path:`, `content:`, `tag:`, `match-case:`, `ignore-case:`, the Match case toggle, all six sorts, paging, the result cache, the two error codes, the host's `global-search` instance, and the HTMX search box. Why these: they are the operators that read only facets every note already has (text, path, tags), they cover the help page's whole first half and the one plugin call in the corpus (`tag:#x`), and each is a few lines over the matcher, so the demo shows the grammar rather than a substring box. `content:` and the two case operators are included because once the scope and case machinery exists they cost nothing; the six sorts because they read only `tree_entries`.

The parity phase, in order: regular expressions; the structural scopes (`line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`) with sub-queries; property search; canvas content (out of this phase by Ruling 4, issue #3); excluded files; `explain`; embedded query blocks in the spike. Then the parity harness.

Cost if wrong: an operator moved from parity into the MVP costs one task earlier; one moved out is refused by name (`unsupported_operator`), never misread, so a demo query can never silently answer the wrong files.

### The parity harness

**Corpus.** A generated parity vault, never the owner's real vault in any committed fixture. A generator (`host/scripts/search-parity.js generate`) writes it under `target/tmp/search-parity/` from a committed manifest (`crates/vault-server/tests/fixtures/search-parity/corpus.json`: every file's path, bytes and mtime and ctime), so the replay can rebuild the same vault byte for byte. It exercises every operator and every provisional rule: ASCII and Unicode text (accents in NFC and NFD, CJK, emoji, a Greek final sigma, a Turkish dotted I, the Kelvin sign), punctuation and hyphenated words, phrases with quotes, frontmatter that holds a searched word, tags in the body, in frontmatter and inside a code block, nested tags, every task state (`[ ]`, `[x]`, `[X]`, `[-]`, `[>]`), headings of mixed levels for sections, list items, blocks, properties of every kind (text, number, list, empty, `""`, `[]`), canvases with text, file and link nodes, attachments with interesting names, a folder excluded by `.obsidian/app.json`, and names that sort differently under `localeCompare` and code-point order.

**Query set.** `crates/vault-server/tests/fixtures/search-parity/queries.jsonl`, committed, one query per line with an id, the query string, `match_case`, `sort` and the provisional rule or operator it probes; every operator, every sort, both case modes, each `P` rule, negation of every scope, nesting inside scopes, and malformed queries.

**Capture.** The owner opens the generated vault in Obsidian once (the CLI needs the vault open), and `host/scripts/search-parity.js capture` drives the `obsidian` CLI with the corpus as its working directory, checking before every call that the vault the CLI answers for is the corpus path and exiting 3 otherwise, as the Bases capture does. Per query it records: the file set and counts from `search format=json` and lines from `search:context format=json` (the documented routes; `total` for the match count; `case` for the toggle), and, through `eval`, the search view's own answer after `openGlobalSearch(query)`, read from the view's result lookup once the search reports done: per file the match spans in UTF-16 units and the rendered order under each sort [S4]. The `eval` route is undocumented and best effort; where it fails, the capture keeps the CLI's file set and lines and marks spans and order as not captured. Captures of the generated vault are committed under `crates/vault-server/tests/fixtures/search-captures/` with a `meta.json` (Obsidian version, date, CLI version).

**The optional real-vault run.** A copy script (`host/scripts/search-parity.js copy`), run by the owner by hand, copies a real vault's Markdown and canvas files into `target/tmp/search-corpus/`, never descending into the guarded private folder that `VAULTD_CORPUS_GUARDED` names and refusing to run without it, and copying from the settings only `.obsidian/app.json`. Its queries are the committed query set plus the owner's saved searches (the `search` items of `.obsidian/bookmarks.json`). The run is deferred (Ruling 6, issue #2). Its captures go to `$XDG_DATA_HOME/vaultd/search-captures/corpus/` (`.local/share` under the home directory when unset), outside the repository, as the Bases corpus captures did (ruled 2026-10-08); the replay reads them through `VAULTD_SEARCH_CORPUS_CAPTURES` and skips, saying why, when they are absent.

**Comparison.** `crates/vault-server/tests/search_replay.rs` rebuilds the vault from the manifest, runs every captured query through `search` over the daemon, and compares, in this order: the file set (hard: any difference fails); per file the content match spans, converted to UTF-16 offsets (hard where captured); the order of files under the query's sort (hard where captured); `total_files` and `total_matches`. A difference fails the suite unless `crates/vault-server/tests/fixtures/search-captures/deviations.json` names it with a ruling (`S<n>: <the owner's words>`), the way the Bases replay lists R2 deviations. Each provisional rule is settled in the last task: a capture that agrees flips it to captured; one that disagrees changes the code to Obsidian's behaviour (a bug), unless the owner rules an exception, which is then recorded in `deviations.json` and in `VAULTD-COMPATIBILITY.md`.

## Performance requirements

Measured with the socket harness extended by a `--search` case, warm, on the 10,000-note synthetic fixture unless stated:

1. A two-word plain query, first page of 100 files, uncached: under 50 ms p50.
2. A cached page with `context: none`: under 1 ms p50. With `context: line` a page also reads its notes' lines from SQLite at the answer's generation, cached or not, so that series is measured and reported beside it without a bound.
3. A metadata-only query (`tag:#group-3`, `file:Note-0001`): under 10 ms p50.
4. A publication during a whole-vault search: under 2 ms (the search holds no guard while it scans).
5. Reconciliation (cold build, one-note `write_note`, 100-note burst) within 5 percent of phase 8, which holds by construction and is measured anyway.
6. Observational, deciding the trigram follow-on: the same two-word query on a 10,000-note prose fixture (about 3 KB per note) and on the 100,000-note synthetic fixture; a 100,000-note p50 over 500 ms is reported as the trigger for that decision.

Every miss is reported as a miss with its mechanism, in `docs/performance/search-baseline.md`.

## Testing

- **Parser.** Every query printed on [S1] parses into the tree the prose describes; precedence (`a b OR c d` is `(a b) OR (c d)`); negation of words, groups and operators; escaped quotes; operators with words, phrases, regexes and sub-queries; property forms; every malformed shape refused with a position; a property test that printing a tree and parsing it again gives the same tree.
- **Matcher.** Folding and finding on ASCII and Unicode, spans always on character boundaries of the original, no overlap; the ASCII fast path equal to the reference on generated text (property test); `Loc` conversion against hand-computed UTF-16 positions, including astral characters and CRLF line breaks.
- **Evaluate.** Each scope on in-memory documents; negation over the P10 universe; spans only from positive terms; every sort order including ties.
- **Index.** `IndexReader::search` over a real index: generation pinning, a publication landing mid-search, the narrowing superset property over SQLite, attachments by `file:`, no body read outside the candidates.
- **Protocol and server.** The operation in the conformance fixture set over both transports; paging; `invalid_cursor`, `generation_mismatch`, `query_invalid` with its position, `unsupported_operator`; the cache hit at one generation and miss at the next.
- **Host.** The `global-search` instance through the shim harness and against a real daemon; `openGlobalSearch`, called as tag-wrangler calls it, opens a search whose state and event a host client reads; an overlapping older search never overwrites a newer one.
- **Parity.** The replay above; the committed captures are the acceptance test.
- **Gates.** Every gate reports its process exit code; MSRV 1.85; clippy clean; `TMPDIR` under `target/tmp`; nothing points at a real vault.

## Documentation

`docs/protocol.md`: the `search` operation, a **Search** section (the grammar as implemented, the scopes, the positions, the cache and cursor, freshness), the two error codes, and `search` removed from **Reserved operation families**. `README.md`: what the daemon does with a query, the new flag. `VAULTD-COMPATIBILITY.md`: a **Search parity** section, with the provisional rules and, after the harness, what was captured. `docs/performance/search-baseline.md`. `docs/protocol-host.md`: the two host operations and the event. `docs/design/semantic-read-path.md`: one line noting search landed here.

## Open questions for the owner

None open. The three questions of the first draft were ruled on 2026-10-17; see Rulings 4 to 6.

## Rulings

1. Search lives in `vaultd`: "yeah. definitely we want search" (the owner, 2026-10-17); the lead drafts the design and the plan for the owner's review ("A", 2026-10-17).
2. Feature parity with Obsidian's core Search is the target, an MVP that can land for the next demo comes first, and the final step is testing against Obsidian's native search through the `obsidian` CLI or vault-mcp so the results are known to be consistent (the owner, 2026-10-17).
3. Standing from earlier phases and unchanged: no process, test or fixture reads the owner's real vault except the owner-run copy script; parity comes from runtime captures and published documents, never from `app.asar`; captures of a real vault never enter the repository (2026-10-08); the spec lives repo-local in `docs/design/`.

4. Canvas: no canvas search until vaultd supports canvas files ("idk how our handling of canvas files is at this point -- no need to build search for it until we support them, which might be a pain, idk"). The canvas task is out of this phase; tracked as issue #3 (canvas support first, then canvas text in search). Parity is documented as excluding canvas content until then.
5. Live search subscriptions: later ("later is fine as long as we actually mean later and not maybe/never -- track it"). Clients re-ask on `generation_committed` meanwhile; tracked as issue #1, picked up once the parity harness is green.
6. The real-vault capture run: yes, but not now ("yes but not right now. again it's crucial to track so we actually circle back"). Tracked as issue #2, picked up once the parity harness is green on the generated corpus.

## Deferred follow-on

The FTS5 trigram prefilter (on a measurement); live search subscriptions; search over snapshot sessions; attachment text (PDF); an Obsidian-compatible Explain wording; vault-mcp's switch to `search` (in that repository).
