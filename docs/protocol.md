# vaultd Protocol

Protocol version: `1`

The protocol is transport-neutral and is carried over two transports today: the process's own stdio, and a Unix domain socket. The bytes are identical over either, and which one a client came in by is invisible in every request, response, event and error it sees. See **Transports** below.

## Daemon configuration

```text
vaultd --vault /path/to/vault                       # derived XDG cache index
vaultd --vault /path/to/vault --index /path/to.db   # explicit index path
vaultd                                              # health-only mode
```

Runtime tuning. Each of these requires `--vault`, exactly as `--index` does, and is refused without it rather than silently ignored:

```text
--no-watch                          # reconcile on demand and on the tick only
--watch-debounce-ms <10..=5000>     # event coalescing window, default 100
--reconcile-interval-seconds <N>    # periodic complete reconciliation, default 60; 0 disables it
--read-only                         # refuse every operation that writes into the vault
--bases-cache-entries <1..=4096>    # evaluated Bases views kept per generation, default 64
--search-cache-entries <1..=1024>   # search answers kept per generation, default 16
```

`--bases-cache-entries` bounds the least-recently-used store of evaluated views that `evaluate_base` pages are cut from (see **Bases** below). Every entry of an older generation is dropped on the first request at a newer one, so the bound applies to one generation's worth of views.

`--search-cache-entries` bounds the least-recently-used store of computed search answers that `search` pages are cut from (see `search` below), in the same way: one generation's worth of answers, every older generation's dropped on the first request at a newer one. An answer whose hits, content matches and path matches together number more than 200,000 is never stored, whatever the bound; each of its pages is computed again.

`--read-only` refuses every mutating operation — the eight note and folder verbs, the raw `write_file`, and a rename's link repair — with `read_only`, before any path is touched. Reads, snapshot sessions, reconciliation, and the watcher are unaffected: the daemon still indexes what other writers do, it simply never writes itself. The `.obsidian` zone is included; a read-only daemon writes nothing anywhere in the vault. The flag is fixed at startup and there is no operation that changes it.

One process serves at most one explicitly configured vault. Without `--vault`, only `health` succeeds, every indexed operation returns `index_unavailable`, `subscribe_events` returns `runtime_not_ready`, and no runtime — no watcher, no writer lease, no live graph, no timer — is started at all.

With `--vault`, startup takes the exclusive writer lease, opens or creates the index, and returns as soon as reads can be answered from the last committed generation. The startup catch-up runs behind that on the runtime's coordinator thread, so an early read may answer from an older generation, or return `index_unavailable` when no generation has ever been committed. A refresh failure with an older complete generation serves that generation as `stale`.

Exactly one process may hold a given index. A second `vaultd` over the same index fails to start, and an operation that meets the lease held elsewhere returns `index_in_use`.

## Envelope rules

Every request carries `version`, client-chosen `id`, and one tagged request. Every response echoes `id`, reports the server protocol `version`, and contains either an `ok` response or an `err` protocol error. Unknown or unsupported versions fail before operation dispatch.

Version validation precedes method dispatch. The server first reads only the envelope (`version`, `id`, and the undecoded request), so an unsupported version receives `incompatible_version` even when the request names a method this server does not know. A supported version whose method is unknown receives `invalid_request`. Both refusals echo the request `id` and leave the server running; only input without a usable envelope is a fatal input error.

## Generations, pages, and cursors

Every successful indexed response carries the `generation` of the database snapshot that produced it. Collection operations accept an optional opaque `cursor` and a `limit` (default 100, maximum 1000; 0 or a larger value is `invalid_cursor`). A cursor binds the generation, the operation and its filters, and the final stable sort key; when the generation has moved on, the request fails with `generation_mismatch` carrying `current_generation`, and the client restarts the listing rather than mixing pages from different snapshots.

## Operations

### `health`

Returns the service name and `ok` status. It performs no filesystem access.

```json
{"version":1,"id":"h","request":{"method":"health"}}
```

```json
{"version":1,"id":"h","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}
```

### `get_vault_info`

Returns the canonical vault root, vault identity, index state (`ready`, `stale` with the last refresh error, or `unavailable`), current generation, note count, and the last successful refresh time. With a configured vault it also carries `live_state`, the runtime's observational status: `starting`, `catching_up`, `watching`, `polling_fallback`, or `stopped`. The field is absent in health-only mode, where there is no runtime to describe.

```json
{"version":1,"id":"v","request":{"method":"get_vault_info"}}
```

```json
{"version":1,"id":"v","outcome":{"status":"ok","value":{"type":"get_vault_info","value":{"generation":3,"canonical_root":"/vaults/example","vault_identity":"2f9a…","state":{"state":"ready"},"note_count":128,"refreshed_at_unix_ms":1756100000000,"live_state":"watching","socket_path":"/run/user/501/vaultd/9f2c1b7a4e5d6083.sock"}}}}
```

`socket_path` is present only when the daemon was started with `--listen`, and names the path it actually bound. It is how a client that reached the daemon one way tells another client where to knock; the path can also be computed from the vault root alone, by the rule in **Transports** below.

### `list_notes`

Compact note summaries ordered by vault path. A summary's `title` is the string `title` property when present, otherwise the first heading.

```json
{"version":1,"id":"l","request":{"method":"list_notes","params":{"cursor":null,"limit":2}}}
```

```json
{"version":1,"id":"l","outcome":{"status":"ok","value":{"type":"list_notes","value":{"generation":3,"items":[{"path":"A.md","revision":"blake3:…","title":"A"}],"next_cursor":"eyJn…"}}}}
```

### `get_note`

Exact source, content revision, properties, aliases, headings, blocks, tags, the note's diagnostics, and outgoing references with their resolutions. Spans are half-open UTF-8 byte offsets into the exact source. `diagnostics` is every diagnostic attributed to the note — parsing diagnostics and reference-resolution diagnostics alike, so a `[[wikilink]]` the note carries to a note that does not exist appears here as `unresolved_reference` — and it is the same set `snapshot_notes`' `metadata` facet reports for the note at the same generation.

```json
{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Folder/Note.md"}}}
```

```json
{"version":1,"id":"n","outcome":{"status":"ok","value":{"type":"get_note","value":{"generation":3,"note":{"path":"Folder/Note.md","revision":"blake3:…","source":"# Note\n[[Other]]\n","properties":[],"aliases":[],"headings":[{"level":1,"text":"Note","span":{"start":0,"end":6}}],"blocks":[],"tags":[],"diagnostics":[],"outgoing":[{"source_path":"Folder/Note.md","kind":"wikilink","origin":"body","raw_target":"Other","file_target":"Other","subpath":null,"display":null,"span":{"start":7,"end":16},"target_span":{"start":9,"end":14},"resolution":{"kind":"resolved","target":"Other.md","subpath":null}}]}}}}}
```

`include` optionally names the note's **structural** row-sets: `sections` and `list_items`, spelled exactly as `snapshot_notes` spells them and carrying exactly the same rows. They are the two facets `get_note` does not already return, and asking for one of the four it does — `metadata`, `references`, `resolutions`, `backlinks` — is `invalid_request`, as is a facet name the server does not know. Omitting `include` asks for nothing, and the answer is byte-identical to what this operation has always returned.

A requested facet is present and an unrequested one is **absent**, never an empty list, so "I did not ask" and "there are none" stay distinguishable — the same rule `snapshot_notes` follows. This is how a client refetches one note's structure after an edit without paging the whole vault.

```json
{"version":1,"id":"ns","request":{"method":"get_note","params":{"path":"Folder/Note.md","include":["sections","list_items"]}}}
```

```json
{"version":1,"id":"ns","outcome":{"status":"ok","value":{"type":"get_note","value":{"generation":3,"note":{"path":"Folder/Note.md","revision":"blake3:…","source":"# Note\n- [ ] task\n","properties":[],"aliases":[],"headings":[{"level":1,"text":"Note","span":{"start":0,"end":6}}],"blocks":[],"tags":[],"diagnostics":[],"outgoing":[],"sections":[{"kind":"heading","span":{"start":0,"end":6}},{"kind":"list","span":{"start":7,"end":17}}],"list_items":[{"span":{"start":7,"end":17},"list_start_line":1,"task":" "}]}}}}}
```

### `get_tree_entries`

Tree rows for exactly the paths a client names, at one generation. The answer a mirror needs after an edit: a change set names a handful of paths, and this returns their `kind`, `size`, `ctime_unix_ms`, `mtime_unix_ms`, and — for a note — `revision`, the same fields `snapshot_tree` pages out and from the same rows.

`entries` comes back in request order with the absentees left out; `absent` names those, spelled the way the request spelled them. **A path with no row is not an error.** The index lists neither the `.obsidian` zone nor any hidden folder, and a path may simply have gone, so "there is nothing there at this generation" is an answer rather than a failure. A path that is not a valid vault path is still `invalid_path`, and more than 1024 paths is `invalid_request` — the same per-generation detail limit under "Bounds", because a change set larger than it is reported as counts rather than paths and a client holding more has no detailed change set to be working from.

It is a read: it takes no lease, publishes nothing, and works on a `--read-only` daemon.

```json
{"version":1,"id":"te","request":{"method":"get_tree_entries","params":{"paths":["Attachments/a.png","Folder","gone.txt"]}}}
```

```json
{"version":1,"id":"te","outcome":{"status":"ok","value":{"type":"get_tree_entries","value":{"generation":12,"entries":[{"path":"Attachments/a.png","kind":"file","size":3,"ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000},{"path":"Folder","kind":"folder","ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000}],"absent":["gone.txt"]}}}}
```

### `resolve_link`

Applies the same resolution rules used during reconciliation to a destination string from a given source note.

```json
{"version":1,"id":"r","request":{"method":"resolve_link","params":{"source_path":"Folder/Note.md","destination":"Other#Heading"}}}
```

```json
{"version":1,"id":"r","outcome":{"status":"ok","value":{"type":"resolve_link","value":{"generation":3,"resolution":{"kind":"missing_subpath","target":"Other.md","subpath":{"kind":"heading","value":"Heading"}}}}}}
```

A destination that reaches a `.base` file resolves to it, and a subpath on a base is a view name matched exactly: `Views.base#Table` resolves to `{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}` when the base declares a view named `Table`, and to `missing_subpath` with the same `view` subpath when it does not. **Bases** below has the whole rule.

```json
{"version":1,"id":"rv","request":{"method":"resolve_link","params":{"source_path":"Home.md","destination":"Views.base#Table"}}}
```

```json
{"version":1,"id":"rv","outcome":{"status":"ok","value":{"type":"resolve_link","value":{"generation":3,"resolution":{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}}}}}
```

### `get_backlinks`

Source references ordered by source path and span. References whose file resolves but whose heading or block is missing remain backlinks to the resolved file.

```json
{"version":1,"id":"b","request":{"method":"get_backlinks","params":{"path":"Other.md","cursor":null,"limit":100}}}
```

```json
{"version":1,"id":"b","outcome":{"status":"ok","value":{"type":"get_backlinks","value":{"generation":3,"items":[],"next_cursor":null}}}}
```

### `list_references`

Vault references with an optional source path and an optional `resolved`, `unresolved`, or `ambiguous` status filter. The `resolved` filter includes missing-subpath references; non-vault external targets are never returned.

```json
{"version":1,"id":"f","request":{"method":"list_references","params":{"source_path":null,"status":"unresolved","cursor":null,"limit":100}}}
```

```json
{"version":1,"id":"f","outcome":{"status":"ok","value":{"type":"list_references","value":{"generation":3,"items":[],"next_cursor":null}}}}
```

### `get_diagnostics`

File and graph-wide diagnostics with optional path and severity filters, in stable path/span/code/message order.

```json
{"version":1,"id":"d","request":{"method":"get_diagnostics","params":{"path":"Folder/Note.md","severity":"warning","cursor":null,"limit":100}}}
```

```json
{"version":1,"id":"d","outcome":{"status":"ok","value":{"type":"get_diagnostics","value":{"generation":3,"items":[{"code":"unresolved_reference","severity":"warning","message":"\"Missing\" does not resolve to any note","path":"Folder/Note.md","span":{"start":7,"end":16}}],"next_cursor":null}}}}
```

### `refresh_index`

Reconciles the vault into a new generation. A normal refresh (`verify: false`, the default) trusts path/size/modified-time fingerprints and reads only added or changed bodies. A verified refresh (`verify: true`) reads and hashes every included Markdown file but still reparses only changed content revisions. An unchanged refresh returns the existing generation.

```json
{"version":1,"id":"x","request":{"method":"refresh_index","params":{"verify":true}}}
```

```json
{"version":1,"id":"x","outcome":{"status":"ok","value":{"type":"refresh_index","value":{"previous_generation":3,"generation":4,"added":1,"changed":2,"deleted":0,"unchanged":125,"reparsed":3,"verified":true}}}}
```

### `subscribe_events`

Opens a stream of post-commit events and answers with the subscription's opaque identifier, the generation it starts from, and the runtime's `live_state`. The identifier is a process-scoped name, not a security token, and is never reused within a process.

`generation` is a strict start point, not a hint: no `generation_committed` naming that generation or an earlier one is ever delivered to this subscription. A client may therefore treat the `previous_generation` chain as continuous from its own start point, and `null` means the subscription opened before anything had been committed.

```json
{"version":1,"id":"s","request":{"method":"subscribe_events","params":{}}}
```

```json
{"version":1,"id":"s","outcome":{"status":"ok","value":{"type":"subscribe_events","value":{"subscription_id":"sub-1","generation":3,"live_state":"watching"}}}}
```

### `unsubscribe`

Ends a subscription. Events already queued for it reach the client *before* this response; nothing bearing that identifier follows it. An identifier this process never issued, or already released, is `subscription_not_found`.

```json
{"version":1,"id":"u","request":{"method":"unsubscribe","params":{"subscription_id":"sub-1"}}}
```

```json
{"version":1,"id":"u","outcome":{"status":"ok","value":{"type":"unsubscribe","value":{"subscription_id":"sub-1"}}}}
```

### `evaluate_base`

Evaluates one view of a `.base` file at the current generation and answers its rows. `path` names the base; `view` names a view (absent means the first declared view, as Obsidian opens a base); `this_path` names the note that embeds the base (absent means the base itself — what `this` is); `cursor` and `limit` page the rows like every collection operation (default 100, from 1 to 1000; 0 or more than 1000 is `invalid_cursor`).

The answer carries the `generation`; the `view` as declared (`type`, `name`, and in `options` every other key the view declares, in declared order); the `columns` (the view's `order`, each with its `property`, the `display_name` its `properties` entry declares or `null`, and that entry's other `settings` in declared order); the page of `rows` (each a `path`, a `kind` of `note` or `file`, a `group` cell present exactly when the view groups, and `cells`, one per column in column order); the `summaries`, an object from name to typed cell, where the name is the key the view's own `summaries` map declares it under, so `summaries: {note.price: Average}` answers `"note.price": <cell>`; `total_rows`, the number of rows in the whole answer; and `next_cursor`.

`options` and `settings` are **ordered lists of `{key, value}` entries**, not JSON objects, so neither declared order nor a repeated key is lost; each `value` has the shape a property value has in `get_note` (`{"kind":"string","value":"medium"}`, `{"kind":"integer","value":120}`, a `sequence`, a `mapping`). A non-finite float in an option travels as a `float` whose text is `nan`, `infinity` or `-infinity`, as it does in a property.

The daemon renders nothing: a client turns cells into a table, cards, a list or a board. Every view type — `table`, `cards`, `list`, `kanban`, `map`, and a plugin's own — evaluates to the same row data; an unknown type is passed through as declared. The cells are described under **The cell model** below.

```json
{"version":1,"id":"e","request":{"method":"evaluate_base","params":{"path":"Books.base","view":"Table","this_path":"Home.md","limit":2}}}
```

```json
{"version":1,"id":"e","outcome":{"status":"ok","value":{"type":"evaluate_base","value":{"generation":7,"view":{"type":"table","name":"Table","options":[{"key":"rowHeight","value":{"kind":"string","value":"medium"}}]},"columns":[{"property":"file.name","display_name":null,"settings":[]},{"property":"note.price","display_name":"Price","settings":[{"key":"width","value":{"kind":"integer","value":120}}]}],"rows":[{"path":"Books/Ulysses.md","kind":"note","cells":[{"kind":"string","value":"Ulysses"},{"kind":"number","value":30}]},{"path":"Books/Dune.md","kind":"note","cells":[{"kind":"string","value":"Dune"},{"kind":"number","value":10}]}],"summaries":{"note.price":{"kind":"number","value":14.333333333333334}},"total_rows":3,"next_cursor":"eyJnZW5lcmF0aW9uIjo3fQ"}}}}
```

**One computation per view and generation.** A result is computed once per (base, view, `this_path`, generation, declared property types, and for a view that reads `today()` the local day) and every page is cut from that one computation, so `now()`, `today()` and `random()` cannot move between pages. The computation is kept in a bounded least-recently-used store (`--bases-cache-entries`, default 64); every entry of an older generation is dropped on the first request at a newer one, and an entry computed under older property types is never served again (see **Property types** below).

**The cursor** binds the generation, the base, the view, `this_path`, the row position, and the instant the result was computed at. A cursor presented with another base, view or `this_path` is `invalid_cursor`; a cursor from an older generation is `generation_mismatch` with `current_generation`. A page whose result has left the store is computed again at the cursor's instant, so it sees the same `now()` and the same `random()` sequence (which is seeded from the instant) as the pages before it.

**A view that reads the clock is answered for the clock it reads.** A view whose filters, formulas or summaries read `today()` (and not `now()`) is stored under the local day it was computed on, so a request on a later day, at the same generation, computes it again. A view that reads `now()` or `relative()` is never stored: every request without a cursor computes it at that request's instant, and each page with a cursor at the cursor's instant. No event marks the clock or the day turning over, so a client holding an answer learns of a new day only by asking again.

**A metadata-only touch is not a generation.** A note whose modification time moved while its bytes did not publishes no generation, so a view that reads that note's `file.mtime` or `file.ctime` keeps its answer until the next generation.

**An evaluation blocks only its own connection.** It runs on the requesting connection's dispatcher and takes no lease. It pins a generation under the publication guard on a private read connection from the reader's pool, then evaluates with the guard released: a publication is never held up by an evaluation, and other reads on the same reader still answer. A long evaluation delays that connection's next request, never another connection and never reconciliation. When the live state moves while the pin is being taken, the pin is retried with backoff for up to two seconds; past that the request answers `storage_failure`.

**Re-ask an answer older than the newest `generation_committed` you have seen.** A client that evaluates on one connection and subscribes on another can receive a newer generation's `views_invalidated` events before its own evaluation is recorded, and those events were decided without its rows. Comparing the answer's `generation` with the newest `generation_committed` it has seen closes that gap.

Refusals: a `path` with no indexed base is `not_found`; a base that does not parse is `base_invalid`; an undeclared view is `view_not_found`; a filter that does not parse is `expression_invalid`, and one that calls a function or method this build does not implement is `unsupported_function`; a `this_path` that is not an existing note is `invalid_request`; health-only mode is `index_unavailable`. A formula or a base summary that does not compile does **not** refuse the view: its column is an error cell in every row, and the summary an error cell.

### `list_bases`

Pages every `.base` file the index holds, in path order, with its declared view names and its parse status: `parsed`, or `parse_failed` with the YAML parser's `message` and the `span` it points at. A base that does not parse is still listed, with no views. Paging follows the collection rule above.

```json
{"version":1,"id":"lb","request":{"method":"list_bases","params":{"cursor":null,"limit":100}}}
```

```json
{"version":1,"id":"lb","outcome":{"status":"ok","value":{"type":"list_bases","value":{"generation":7,"items":[{"path":"Books.base","status":{"state":"parsed"},"views":["Table","Cards"]},{"path":"Broken.base","status":{"state":"parse_failed","message":"did not find expected ',' or ']'","span":{"start":7,"end":7}},"views":[]}],"next_cursor":null}}}}
```

### `search`

Answers Obsidian's core Search at the current generation: a query in Obsidian's own search syntax, and the files that match, each with its match spans. The grammar, the scopes, the file universe, how spans are chosen, case folding and freshness are under **Search** below.

The parameters:

- `query` (string, required): the query. An empty or all-whitespace query answers no files and is not an error.
- `match_case` (boolean, default `false`): Obsidian's **Match case** toggle, for the whole query. `match-case:` and `ignore-case:` override it for their operand.
- `sort` (default `file_name_asc`): one of `file_name_asc`, `file_name_desc`, `modified_desc`, `modified_asc`, `created_desc`, `created_asc`, Obsidian's six orders. Ties are broken by path, ascending, in every order.
- `context` (default `line`): `none`, or `line`, which adds each content match's line text.
- `cursor` and `limit`: the collection rule above (files per page, default 100, from 1 to 1000; 0 or more than 1000 is `invalid_cursor`).

The answer carries the `generation`; `total_files` and `total_matches`, counted over the whole answer, not the page; the page of `items`, one per file; and `next_cursor`. Each item has:

- `path` and `kind`: `note` for a Markdown note, `file` for every other file (an attachment, a `.base`, a `.canvas`). The value `canvas` is reserved and never produced in this phase: canvas content is not searched yet (design Ruling 4, issue #3), so a canvas is a `file`.
- `path_matches`: half-open spans in the path string, in **UTF-16 units**, for the terms that matched the path or the file name.
- `content_matches`: the spans in the note's text, in source order. Each has `span`, half-open **UTF-8 byte** offsets into the exact source (the same bytes `get_note` answers as `source`, the protocol's rule for every span), and `start` and `end` as Obsidian `Loc`s: `line` zero-based, `col` and `offset` in **UTF-16 units**, so a plugin or a web client can use a position without re-reading the note. With `context: line` each also carries `line_text`, the line that holds the match's start without its line break, and `line_text_start`, that text's byte offset in the source; a line longer than 512 bytes is cut to a window of at most 512 bytes around the match, on character boundaries. With `context: none` both keys are absent.
- `matches_truncated`: `true` when the file had more than 100 content matches. Only the first 100 are listed; the file still counts as matched, and `total_matches` still counts every match, content and path alike.

```json
{"version":1,"id":"q","request":{"method":"search","params":{"query":"meeting -work tag:#project"}}}
```

```json
{"version":1,"id":"q","outcome":{"status":"ok","value":{"type":"search","value":{"generation":12,"total_files":1,"total_matches":2,"items":[{"path":"Notes/Kickoff.md","kind":"note","path_matches":[],"content_matches":[{"span":{"start":20,"end":27},"start":{"line":3,"col":4,"offset":20},"end":{"line":3,"col":11,"offset":27},"line_text":"The meeting ran long.","line_text_start":16},{"span":{"start":38,"end":46},"start":{"line":4,"col":0,"offset":38},"end":{"line":4,"col":8,"offset":46},"line_text":"#project","line_text_start":38}],"matches_truncated":false}],"next_cursor":null}}}}
```

Here `Notes/Kickoff.md` holds `---\nkind: x\n---\nThe meeting ran long.\n#project\n`: `meeting` is on line 3, which starts at byte 16 after the three frontmatter lines, and the tag match covers the whole tag, `#` included. A note that holds `work`, or no `#project`, is not listed, and `-work` adds no span.

**One computation per query and generation.** An answer is computed once per (query, `match_case`, `sort`, generation) and every page is cut from it, where the query is the parsed query printed in its canonical spelling, so two spellings of one query share an answer. The answer is kept in a bounded least-recently-used store (`--search-cache-entries`, default 16), and every entry of an older generation is dropped on the first request at a newer one. `context` changes only what a page renders, so it is not part of the key.

**The cursor** binds the generation, the canonical query, `match_case`, `sort`, and the position of the next file. A cursor presented with another query, toggle or sort is `invalid_cursor`, and so is one whose position is past the end of the answer; a cursor from an older generation is `generation_mismatch` with `current_generation`. A page whose answer has left the store is computed again at the current generation, which a valid cursor's generation is. A request without a cursor that meets a publication between its answer and its line text is tried at most three times in all before it is refused with `generation_mismatch`.

**A search blocks only its own connection.** It runs on the requesting connection's dispatcher on the pinned evaluation read `evaluate_base` uses: it pins a generation under the publication guard on a private read connection, then scans with the guard released, so a publication is never held up by a search. The scan is exact, over the note text the index stores; there is no search index.

**The page size and the payload cap.** The per-file cap of 100 matches keeps a default page (100 files with line text) near 7 MB, inside the 16 MiB payload cap. A `limit` above 100 with `context: line` is not bounded by that cap: 1000 files of 100 matches each with line text is near 66 MB, and the daemon writes the line rather than answering `payload_too_large`. This is a documented limit, as `read_dir`'s is; a client that pages large answers with line text keeps `limit` at 100 or below, or asks with `context: none`.

Refusals: a query that does not parse is `query_invalid`, and a query that uses an operator or construct this build does not evaluate is `unsupported_operator`, both carrying `position` (see **Errors**); a bad cursor or a `limit` out of range is `invalid_cursor`; a cursor from an older generation is `generation_mismatch`; an unknown `sort` or `context` value, or a missing `query`, is `invalid_request`; health-only mode is `index_unavailable`; a pin that cannot be taken within its two-second budget is `storage_failure`.

## Mutations

Eight operations write notes and folders, `write_file` writes raw bytes to everything that is not an indexable note, and `read_file` and `read_dir` are the raw read half of that family — eleven operations, nine of which write. The filesystem stays authoritative throughout: every write lands as ordinary files through a temporary file and an atomic rename, and the index follows.

**A mutation response is sent only after its own reconciliation has published**, so a client that completes a write can immediately read its result at the returned `generation`. The matching `generation_committed` event carries `cause: "mutation"` and is a confirmation rather than a barrier — a client must not wait for it, and must not assume it arrives before or after the response line.

**Every refusal changes nothing.** Each error below is decided before anything is written, so a refused mutation leaves the vault byte-identical. The single exception is documented at `storage_failure`: bytes that reached disk whose generation then failed to publish.

**Preconditions.** A content-bearing mutation may carry `expected`, in exactly one of three shapes:

- `{"revision": "blake3:…"}` — the target must currently hold this content revision.
- `{"absent": true}` — nothing may exist at the path.
- `{"any": true}` — unconditional, said out loud.

Omitting `expected` altogether is also unconditional. An `expected` object that is *present* must name exactly one of the three: an empty object is a typo-shaped client bug and a two-field object has no meaning, and both are `invalid_request`. Mutation parameters reject unknown keys for the same reason — a misspelled `expected` must fail loudly rather than silently downgrade a conditional write to an unconditional one.

A precondition is checked against **the bytes on disk at mutation time**, not against the index. The index lags the filesystem by a debounce window, so an index-based comparison would be blind to an external edit that has not reconciled yet — and would overwrite it, which is the lost update the mechanism exists to prevent. A failed precondition is `revision_conflict`, carrying `current_revision` (the revision the target actually holds) so a retry loop does not have to re-read and race the next writer.

Which operations take one: `write_note`, `patch_frontmatter`, `delete_note`, `rename_note`, and `write_file` take `expected`; `copy_file` takes `expected_source`, which is about the source it reads. `create_folder`, `delete_folder`, and `rename_folder` take none — a folder has no bytes and therefore no revision — and they reject the field itself with `invalid_request` rather than ignoring it.

**Not every shape is valid on every operation, and the server enforces it.** `{"absent": true}` is accepted only by `write_note` and `write_file`, the two verbs that can create a path that was not there. `patch_frontmatter`, `rename_note`, `delete_note`, and `copy_file`'s `expected_source` accept `{"revision": …}` or `{"any": true}` and refuse `absent` with `invalid_request`: each of them needs its subject to already exist, so "the target must not exist" is a precondition they could only ever fail.

**Parent folders are never created implicitly by a file operation.** Every operation that resolves a *file* path — `write_note`, `write_file`, `copy_file`, the renames' destination — answers `parent_not_found` when the folder above it does not exist. `create_folder` is the deliberate exception: it is the verb whose job is to make folders, and it makes the whole chain.

**Payloads are capped at 16 MiB** (`payload_too_large`). Chunked transfer is the deferred alternative and does not exist in version 1. The cap is not symmetric between the two raw verbs, and the difference is worth knowing before a client sizes its buffers: `read_file` bounds the file by its size on disk *before* materializing anything, so an oversized read costs one `stat`; `write_file` can only weigh what it was handed, so the full `content_base64` line has already been read off the transport and decoded by the time the cap refuses it. A client that must not pay that cost checks its own payload size first. A `patch_frontmatter` weighs its *edits*, never the resulting file — capping the result would make a note that is already over the cap permanently unpatchable — and a delete under `{"any": true}` stats its target instead of reading it, so a file that is already over the cap can still be removed — a refusal with no remedy would be worse than no cap at all, since the only interface that could shrink it is the one refusing.

**Case collisions are refused, not resolved.** On a case-insensitive filesystem a path that differs from an existing one only by case is `case_collision`, and nothing is written. This is a deliberate divergence from Obsidian, which mishandles the same situation; `VAULTD-COMPATIBILITY.md` records it.

### `write_note`

Writes a Markdown note's exact bytes. The path must be an indexable `.md` path: a non-note path is `invalid_request`, because such a file would never be indexed and read-your-writes would silently break for it.

```json
{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Folder/Note.md","content":"# Note\n[[Other]]\n","expected":{"revision":"blake3:8dd1ae6e…"}}}}
```

```json
{"version":1,"id":"w","outcome":{"status":"ok","value":{"type":"write_note","value":{"generation":4,"revision":"blake3:0f2c91aa…"}}}}
```

### `create_folder`

Creates a folder, and every missing folder above it. **A folder that already exists is success, not a conflict** — the postcondition a caller wants is "a folder is there", which is Obsidian's own `createFolder` behaviour. A *file* already sitting at the name is `target_exists`, and a name that differs only by case from an existing folder is `case_collision`. The generation names only the segments this call actually created; a segment that was already there moved nothing and is named by nobody.

```json
{"version":1,"id":"cf","request":{"method":"create_folder","params":{"path":"Folder/Nested"}}}
```

```json
{"version":1,"id":"cf","outcome":{"status":"ok","value":{"type":"create_folder","value":{"generation":5}}}}
```

**`create_folder` is the one folder operation that serves the `.obsidian` zone and hidden folders**, because a plugin host has to make `.obsidian/plugins/<id>/` and its own configuration directory, and `write_file` never creates parents. `delete_folder` and `rename_folder` still refuse both with `zone_violation`: a directory that was made can be removed again, while an emptied `.trash/` or a removed `.git/` cannot be put back.

Such a create is a **raw** folder create. It joins no generation — nothing there is indexed, so the `generation` key is **absent** rather than `0` — and the daemon announces it with a `config_changed` event when the folder landed inside `.obsidian/`, exactly as a zone `write_file` does.

**`generation` answers about the path you asked for, not about every folder the call made.** A chain can straddle the boundary: `create_folder` on `Visible/.hidden` creates `Visible` too, and `Visible` *is* indexed — so a generation containing it is published (and a `generation_committed` names it) while the response still omits `generation`, because the folder the request named will never be in one. A client that needs to know about the segments above its target reads them back with `get_tree_entries` rather than inferring them from this answer. A folder that was already there announces itself too: the notice means "re-read this path", not "a delta happened". Every other refusal stands unchanged, and one in particular: a request naming an ordinary folder that *lands* on an unindexable one — through a symlink, or a case-folded spelling — is still `zone_violation`. The permission is granted to a caller that said out loud where it was writing, never to a spelling that hides it.

```json
{"version":1,"id":"cz","request":{"method":"create_folder","params":{"path":".obsidian/plugins/example"}}}
```

```json
{"version":1,"id":"cz","outcome":{"status":"ok","value":{"type":"create_folder","value":{}}}}
```

### `rename_note`

Moves a note and, with `rewrite_links` (default `true`), repairs every inbound reference to it. The move and every successful rewrite land in **one** generation. `links_rewritten` counts the references retargeted; `link_rewrite_failures` names each one that was not, with a stable `reason` from the closed set under "Link repair failure reasons" below. An empty list means every inbound reference now points at the new path.

Spelling is preserved: a reference that was shortest-form stays shortest-form while it stays unambiguous, and a reference the rename would make ambiguous is upgraded to the explicit path form. Over-specifying is safe; silently retargeting is not.

```json
{"version":1,"id":"rn","request":{"method":"rename_note","params":{"from":"Folder/Note.md","to":"Folder/Renamed.md","expected":{"any":true},"rewrite_links":true}}}
```

```json
{"version":1,"id":"rn","outcome":{"status":"ok","value":{"type":"rename_note","value":{"generation":6,"revision":"blake3:0f2c91aa…","links_rewritten":3,"link_rewrite_failures":[]}}}}
```

### `rename_folder`

Moves a folder and every path under it, repairing inbound references to each contained note when `rewrite_links` is true. It reports **no** `revision`: a folder has no bytes to hash, and a thing with no content revision reports no `revision` key at all rather than an empty string. An existing destination — including an empty directory already sitting there — is `target_exists`.

```json
{"version":1,"id":"rf","request":{"method":"rename_folder","params":{"from":"Folder","to":"Renamed","rewrite_links":true}}}
```

```json
{"version":1,"id":"rf","outcome":{"status":"ok","value":{"type":"rename_folder","value":{"generation":7,"links_rewritten":12,"link_rewrite_failures":[{"path":"Other.md","reason":"revision_conflict"}]}}}}
```

### `copy_file`

Byte-copies any vault file, note or attachment. `if_exists` is `"error"` (the default, answering `target_exists`) or `"suffix"`, which appends Obsidian's auto-numbering suffix and is what `getAvailablePath` parity needs. `expected_source` is a precondition on the **source**.

```json
{"version":1,"id":"cp","request":{"method":"copy_file","params":{"from":"Folder/Note.md","to":"Folder/Copy.md","expected_source":{"any":true},"if_exists":"suffix"}}}
```

```json
{"version":1,"id":"cp","outcome":{"status":"ok","value":{"type":"copy_file","value":{"generation":8,"revision":"blake3:0f2c91aa…"}}}}
```

### `delete_note`

Deletes one note. `mode` is `"trash_system"` (the platform trash), `"trash_local"` (the vault's own `.trash/`, which is a dot-directory and therefore never scanned, watched, or indexed), or `"permanent"`. Omitting `mode` takes the vault's `.obsidian/app.json` `trashOption`, falling back to `"trash_system"` — Obsidian's own default — when that file is missing or unparsable, because a delete must not fail on an unreadable configuration file. The response carries no revision: a deleted file has none.

```json
{"version":1,"id":"dn","request":{"method":"delete_note","params":{"path":"Folder/Note.md","mode":"trash_local","expected":{"revision":"blake3:0f2c91aa…"}}}}
```

```json
{"version":1,"id":"dn","outcome":{"status":"ok","value":{"type":"delete_note","value":{"generation":9}}}}
```

### `delete_folder`

Deletes a folder. A non-empty folder without `recursive: true` is `target_exists` — something is still in there.

```json
{"version":1,"id":"df","request":{"method":"delete_folder","params":{"path":"Folder","mode":"permanent","recursive":true}}}
```

```json
{"version":1,"id":"df","outcome":{"status":"ok","value":{"type":"delete_folder","value":{"generation":10}}}}
```

### `patch_frontmatter`

Edits addressed frontmatter keys in place. `patch` is a list of `{ key_path, value }` entries; `key_path` addresses the key, and an explicit JSON `value: null` deletes it. A missing `value` key is a decode error rather than a deletion, so "forgot to set a value" never becomes "delete this key".

**`key_path` has two spellings, and they address differently.** A **string** is a dot-path: every `.` starts a new segment, so `"a.b.c"` means `c` inside `b` inside `a`. An **array of strings** is the segments themselves, each one a literal key — `["my.key","sub"]` addresses `sub` inside the single key named `my.key`. The array form is the only way to reach a key whose own name contains a dot; sending `"my.key"` for such a key addresses a *different* place and grows a nested `my` mapping beside it. Neither form is rewritten into the other in transit, an empty array is `invalid_request`, and a path with an empty segment is `invalid_request` in either form.

**`set_null: true`, carried instead of `value`, writes a YAML null** for the addressed key, creating the key when it is absent. It is the third action, and it exists because the other two cannot express it: a JSON `value: null` deletes, so without this a plugin's `fm.key = null` — which Obsidian's `processFrontMatter` writes as `key: null` — would have removed the key instead. An entry carrying both `set_null` and `value` says two contradictory things about one key and is refused with `invalid_request`, the explicit `value: null` spelling included; `set_null: false` says nothing, so an omitted `value` beside it is still a decode error.

Bytes outside the addressed spans are preserved exactly, and the span is as narrow as the parse allows. An edit at or above a stored key's granularity rewrites only that key's value span. An edit *below* it — into a nested object, which the index stores no span for — rewrites only the addressed **scalar's** own span when it is setting a scalar that is already there, so the layout around it (the `- ` item it sits in, that item's sibling keys, the indentation) does not move. In every other case below the stored granularity — a deletion, a new value that is a sequence or a mapping, a target that is itself a sequence or a mapping, a target that does not exist yet, a leaf addressed as a sequence element such as `tags.0`, or a leaf anywhere inside a **flow** collection (`{a: 1, b: 2}`, `[{a: 1}]`, and the same written across several lines), where a `,` or a bracket ends the token — the smallest enclosing stored value span is re-serialized, which re-emits that one property in the document's addition dialect and touches nothing outside it. Key order, comments outside the re-emitted property, whitespace, and the body survive every case.

```json
{"version":1,"id":"pf","request":{"method":"patch_frontmatter","params":{"path":"Folder/Note.md","patch":[{"key_path":"title","value":"Renamed"},{"key_path":["my.key","sub"],"value":7},{"key_path":"reviewed","set_null":true},{"key_path":"draft","value":null}],"expected":{"any":true}}}}
```

```json
{"version":1,"id":"pf","outcome":{"status":"ok","value":{"type":"patch_frontmatter","value":{"generation":11,"revision":"blake3:44b0c7de…"}}}}
```

### `write_file`

Raw bytes to any vault file that is **not** an indexable note: an attachment, a `.base` file, a hidden path, or the `.obsidian` zone. `content_base64` is base64 in the standard alphabet with padding (RFC 4648 §4, not the URL-safe variant); anything else is `invalid_request`. `read_file` answers in the same encoding.

`semantic` answers "did these bytes land inside the indexed universe", and `generation` is present exactly when `semantic` is true. A write into the configuration zone, or into any hidden folder, answers `semantic: false` with no `generation` — nothing there is indexed, so no generation will ever contain it — and emits a `config_changed` event when it was in the zone. An attachment inside the vault answers `semantic: true` with a real generation: no semantic rows moved, but the file tree did. A `.base` file inside the vault answers `semantic: true` with a real generation too, and there semantic rows did move: a base is an indexed file kind, parsed and reconciled in the same generation as the write.

Both fields answer about **where the bytes landed**, not about the path the request carried. A symlink or a case-folded spelling can resolve across the boundary in either direction, and answering from the request would name a generation that will never contain the write.

A `.md` path outside the zone is refused with `invalid_request`: a note must go through `write_note` to join a generation. `read_file` has no such rule and reads any path, notes included.

```json
{"version":1,"id":"wf","request":{"method":"write_file","params":{"path":".obsidian/plugins/example/data.json","content_base64":"eyJrZXkiOiJ2YWx1ZSJ9","expected":{"any":true}}}}
```

```json
{"version":1,"id":"wf","outcome":{"status":"ok","value":{"type":"write_file","value":{"revision":"blake3:9c1f0b21…","semantic":false}}}}
```

### `read_file`

Raw bytes out of any vault file, including notes (byte-identical to `get_note`'s `source`, without the semantics) and the `.obsidian` zone. It is a read: it takes no lease, publishes nothing, joins no generation, and works on a `--read-only` daemon.

A path that exists but is not a regular file — a directory, a fifo, a socket, a device — is refused with `target_exists`. The code is the mutation taxonomy's "something else already occupies this name", and its message is phrased for the write path; on a read, understand it as "this name is not a regular file".

```json
{"version":1,"id":"rd","request":{"method":"read_file","params":{"path":".obsidian/app.json"}}}
```

```json
{"version":1,"id":"rd","outcome":{"status":"ok","value":{"type":"read_file","value":{"content_base64":"eyJrZXkiOiJ2YWx1ZSJ9","revision":"blake3:9c1f0b21…"}}}}
```

### `read_dir`

The immediate entries of **one** directory, hidden folders and the `.obsidian` zone included. Like `read_file` it is a read — no lease, no publication, no generation, unaffected by `--read-only` — and like `read_file` it answers off the filesystem rather than out of the index.

That is the whole reason it exists. The tree index excludes every hidden **directory** by design — a hidden *file* such as `.gitignore` is an ordinary tree row — so `get_tree_entries` and both snapshot pagers can never report `.obsidian/plugins/` or `.obsidian-headless/plugins/`, and `read_file` reads only regular files. Before this operation, a client that had not been told a plugin's folder name had no way to find one. It does not recurse: a host walks the tree by asking again, one directory at a time, which keeps the answer's size bounded by the directory rather than by the vault.

**The empty path names the vault root**, and listing the root is how a client discovers that the configuration folders are there at all — the answer includes the dotfolders the tree index leaves out. Every other operation still refuses an empty path; `read_dir` is the one place the spelling means something.

`entries` is sorted by `name` in **byte order**, because a directory yields in whatever order the filesystem stored and a client diffing two listings needs one. `name` is the entry's own name and never a path — the request already fixed where the directory is. `kind` is `file`, `folder`, `symlink`, or `other` (a fifo, a socket, a device), and a client must treat an unrecognized kind as unknown rather than as an error. `size` is present for a regular file and absent for everything else: a folder has no size worth reporting, and a symlink's is the length of its target string rather than of anything a client could read. An entry whose name is not valid UTF-8 is **omitted**, because no path in this protocol could name it afterwards — and omitted silently, with no count and no marker, so a listing cannot distinguish "the directory holds nothing else" from "the directory holds something this protocol cannot spell".

**A symlink is reported, never followed.** Each entry is classified from its own `lstat`, so a link to a directory is `symlink` and not `folder`. A client that wants what is behind the link asks for the link's own path and meets the same containment `read_file` takes — which refuses a link that leaves the vault with `zone_violation`.

`path` echoes the spelling the request used — the parsed vault path, or `""` for the root — so a client pairing answers to asks never has to re-derive it. It is never the canonicalized filesystem path, and it is never re-spelled to match the filesystem's own casing: a request for `folder` on a case-insensitive filesystem lists `Folder`'s entries and still answers `"path":"folder"`. This is deliberately **not** the "stored spelling" a mutation's `changed_paths` reports, which is the way the filesystem holds a name rather than the way a caller spelled it; a client that needs the on-disk spelling of an entry reads it from the listing's `name`, which is the filesystem's own.

There is no `generation`: nothing a listing reports is indexed, so there is no generation the answer could be true at, and naming one would invite a client to treat a listing as a delta.

A path that exists but is not a directory is refused with `target_exists`, exactly as `read_file` refuses a path that is not a regular file and for the same reason; a path that is not there at all is `not_found`, and a path whose parent folder does not exist is `parent_not_found`, as everywhere else.

**The 16 MiB payload cap does not govern a listing.** `read_file` weighs the file before it reads and `write_file` weighs what it was handed, but `read_dir` consults the cap nowhere, so a directory large enough writes an oversized line rather than meeting `payload_too_large`. That is survivable in version 1 because the operation does not recurse — the answer is bounded by the directory a client chose to ask about, and a real vault root or `plugins/` directory is hundreds of entries — but it is a stated gap, not an oversight: a page or a cap is the follow-up, and this response already has the shape for one, since adding a cursor key later is additive. A listing also runs on the dispatcher thread, so every other request waits behind it; the cost is proportional to the directory's entry count.

```json
{"version":1,"id":"ls","request":{"method":"read_dir","params":{"path":".obsidian/plugins"}}}
```

```json
{"version":1,"id":"ls","outcome":{"status":"ok","value":{"type":"read_dir","value":{"path":".obsidian/plugins","entries":[{"name":"dataview","kind":"folder"},{"name":"obsidian-git","kind":"folder"},{"name":"stale.json","kind":"file","size":42}]}}}}
```

### The `.obsidian` zone

`read_file`, `read_dir`, `write_file`, and `create_folder` accept paths under `.obsidian/`. **Every other operation refuses them** with `zone_violation` — `write_note`, `patch_frontmatter`, the renames, the copies, the deletes, and the two destructive folder verbs alike. Nothing in the zone is indexed, so a zone write joins no generation and answers `semantic: false`, and the daemon announces it with a `config_changed` event instead of a `generation_committed`.

The mirror rule holds on the other side: `write_file` refuses an indexable `.md` path outside the zone with `invalid_request`, so the two write verbs partition the vault exactly. Whether a path is in the zone is decided by where it *lands* after symlinks and case folding, never by how the request spelled it.

**A client makes zone folders with `create_folder`, and only that way.** `write_file` still never creates parents, so a write into `.obsidian/plugins/new-plugin/data.json` answers `parent_not_found` until that folder exists — the client creates it explicitly first. The create reports no `generation` and emits `config_changed`; the write into it then behaves exactly as the `write_file` example above. The same rule covers every hidden folder, `.obsidian-headless/` and `.trash/` included, except that only a path inside `.obsidian/` raises `config_changed`. This closes the gap earlier versions of this document named as the follow-up "Create folders inside the `.obsidian` zone".

## Read-modify-write

There is **no server-side `process` operation**. A read-modify-write is a client loop over the operations above:

1. `get_note` (or `read_file`) and keep the `revision` it returned;
2. compute the new content locally;
3. `write_note` with `expected: {"revision": "<that revision>"}`;
4. on `revision_conflict`, take `current_revision` from the error, re-read, and try again.

The loop is a compare-and-swap, and the server holds no state between its steps: there is no lock to leak, no transaction to abandon, and a client that dies mid-loop leaves nothing behind. `patch_frontmatter` is the exception a client should reach for when it only wants a property — it does the read-modify-write inside one serialized mutation and preserves the bytes it did not address, which a naive read-modify-write of the whole file cannot promise.

Multi-file transactions, conflict merging, journaling, and undo are deliberately absent; the reserved operation families below name them.

## Snapshot sessions

Hydrating a whole vault through `list_notes` and `get_note` costs one round trip per note and tears across generations while it runs. A snapshot session replaces both problems: one pinned read transaction, paged through with ordinary requests.

**An entire session is coherent at one generation** — tree entries and semantic rows alike — because both come from the same pinned read transaction. A write may land at any time; this session never sees it. The generation is reported at `open_snapshot` and echoed on every page.

Three numbers are **daemon configuration rather than protocol**. The values below are the defaults; a client must not hard-code them, and only the page size is directly observable (from how many rows a page returns) — the other two announce themselves through their refusals:

- **idle timeout, 60 s since the last page.** An open session pins WAL frames and defers checkpoint truncation, so a session nobody is reading is reclaimed. The sweep rides on traffic the daemon is already handling — any request or runtime notice — rather than on a timer, so residency is bounded by one idle timeout after the last input of any kind. A page against a reclaimed session is `snapshot_not_found`.
- **concurrency cap, 4 sessions.** Opening a fifth is `too_many_snapshots`.
- **page size, 500 by default and 2000 at most.** A snapshot `limit` is *clamped* into `1..=2000` rather than refused — including `0`, which becomes 1. This differs from the collection operations above, where an out-of-range `limit` is `invalid_cursor`: a hydration loop that asks for too much should page more times, not fail halfway through a vault.

A client disconnect releases every session that client held, so a crashed host cannot pin the WAL forever.

**Pin loss is reported, never served stale.** If a session's transaction is no longer the one it was pinned at, both pagers refuse on sight with `generation_mismatch` carrying `current_generation`; the client reopens. This is the second cause of that code — the first is an ordinary cursor whose generation has moved on.

Unknown *fields* in these read parameters are tolerated, as everywhere outside the mutation family. An unknown *value* inside `include` is not: a misspelled facet name is `invalid_request`, because ignoring it would serve a page silently missing the facet the client asked for.

### `open_snapshot`

Opens the session and reports what it will serve: `note_count` semantic rows and `entry_count` tree entries, the latter always at least the former.

```json
{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}
```

```json
{"version":1,"id":"o","outcome":{"status":"ok","value":{"type":"open_snapshot","value":{"snapshot_id":"snap-1","generation":12,"note_count":2,"entry_count":5}}}}
```

### `snapshot_tree`

One page of the vault tree in path order: folders, notes, and non-Markdown files. Each entry carries `ctime_unix_ms`, `mtime_unix_ms`, and `size` — which is what a host serves `TFile.stat` from, and why they are stored per entry rather than restated from the filesystem at read time. A folder carries neither `size` nor `revision`; a non-note file carries `size` but no `revision`, because the index stores no content revision for attachments. `kind` is `folder`, `note`, or `file`, and a client must treat an unrecognized kind as unknown rather than as an error.

```json
{"version":1,"id":"t","request":{"method":"snapshot_tree","params":{"snapshot_id":"snap-1","cursor":null,"limit":500}}}
```

```json
{"version":1,"id":"t","outcome":{"status":"ok","value":{"type":"snapshot_tree","value":{"snapshot_id":"snap-1","generation":12,"entries":[{"path":"Folder","kind":"folder","ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000},{"path":"Folder/Note.md","kind":"note","size":24,"ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000,"revision":"blake3:0f2c91aa…"}],"next_cursor":"eyJn…"}}}}
```

### `snapshot_notes`

One page of per-note semantic row-sets, in path order. `include` names the facets to serve: `metadata`, `references`, `resolutions`, `backlinks`, `sections`, and `list_items`. A facet a client does not ask for is not read, not serialized, and absent from the response — absent, never empty, so "I did not ask" and "there are none" stay distinguishable.

The `metadata` facet's `diagnostics` is the same set `get_note` reports for that note at that generation — parsing diagnostics and reference-resolution diagnostics alike, `unresolved_reference` included. A client that hydrates from a snapshot and later refreshes one note through `get_note` sees the same diagnostics either way.

`sections` and `list_items` are **top-level facets, siblings of `metadata` rather than nested inside it**. A section carries its `kind`, its span, and the `block_id` that owns it when it has one. A list item carries its span, its raw `task` character when it is a task, and exactly one of `list_start_line` (a top-level item, naming the start line of the list containing it) or `parent_start_line` (a nested item, naming its parent item's own start line). Both are line numbers, never array indexes and never sentinels; a host reconstructing Obsidian's single `parent` number negates `list_start_line` and passes `parent_start_line` through.

Bodies are not a facet: row-sets come from here and bodies from `get_note`.

```json
{"version":1,"id":"sn","request":{"method":"snapshot_notes","params":{"snapshot_id":"snap-1","cursor":null,"limit":500,"include":["metadata","references"]}}}
```

```json
{"version":1,"id":"sn","outcome":{"status":"ok","value":{"type":"snapshot_notes","value":{"snapshot_id":"snap-1","generation":12,"notes":[{"path":"Folder/Note.md","revision":"blake3:0f2c91aa…","metadata":{"properties":[],"aliases":[],"headings":[{"level":1,"text":"Note","span":{"start":0,"end":6}}],"blocks":[],"tags":[],"diagnostics":[]},"references":[{"source_path":"Folder/Note.md","kind":"wikilink","origin":"body","raw_target":"Other","file_target":"Other","subpath":null,"display":null,"span":{"start":7,"end":16},"target_span":{"start":9,"end":14},"resolution":{"kind":"resolved","target":"Other.md","subpath":null}}]}],"next_cursor":null}}}}
```

### `close_snapshot`

Releases the session and its pinned transaction. A session identifier this process never issued, or already released or reclaimed, is `snapshot_not_found`.

```json
{"version":1,"id":"c","request":{"method":"close_snapshot","params":{"snapshot_id":"snap-1"}}}
```

```json
{"version":1,"id":"c","outcome":{"status":"ok","value":{"type":"close_snapshot","value":{"snapshot_id":"snap-1"}}}}
```

## Bases

`vaultd` evaluates Obsidian Bases: `evaluate_base` and `list_bases` above, and the `views_invalidated` event under **Events**. The design and its rulings are in `docs/design/bases-evaluation.md`; the measurements are in `docs/performance/bases-evaluation-baseline.md`; what parity with Obsidian means, and what was captured, is in `VAULTD-COMPATIBILITY.md`.

### How a base is indexed

A `.base` file is an indexed file kind beside `.md`. It is parsed and reconciled in the same generation as any other change, on the watcher route and on a complete reconciliation alike, and a write, rename, copy or delete of a `.base` through this daemon answers `semantic: true` with the generation that holds it. A base that does not parse is still indexed and still resolves: `list_bases` lists it as `parse_failed` with the YAML position, `evaluate_base` answers `base_invalid`, and `get_diagnostics` reports a `malformed_base` diagnostic under its path. Renaming a base repairs the links to it, as renaming a note does.

### Base targets and the view subpath

A link whose target reaches a `.base` file resolves to that file. A subpath on a base is a view name, matched exactly: `![[Books.base#Table]]` resolves with subpath `{"kind":"view","value":"Table"}` when the base declares that view. An undeclared view is `missing_subpath` with the `view` subpath and a `missing_view` diagnostic; a block subpath on a base (`#^id`) is `missing_subpath`. A reference keeps its *parsed* subpath as `heading`, because the parser cannot know what the target is — only the *resolution* names a view. When a note and a base share a stem, `![[stem]]` resolves to `stem.md`, as Obsidian does. The `view` subpath kind is new with Bases, and a client built before it cannot decode it: see **Evolution**.

### The cell model

A cell is a typed JSON object tagged by `kind`. The fourteen kinds the server emits, and the one it never does:

- `null` — no value (a missing property, an empty result).
- `string` — `value` is text.
- `number` — `value` is a finite JSON number; a whole number below 2^53 is written as an integer (`60`, not `60.0`). A non-finite number has no JSON number, so it travels as a `string` cell holding JavaScript's text: `NaN`, `Infinity`, `-Infinity`.
- `boolean` — `value` is `true` or `false`.
- `date` — `value` is ISO 8601 in the daemon's zone, `YYYY-MM-DD` without a time and `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` with one; `has_time` says which.
- `duration` — `value` is milliseconds and `months` the calendar months kept apart from them (a month has no fixed length in milliseconds).
- `list` — `value` is a list of cells.
- `object` — `value` is an ordered list of `{key, value}` entries, each `value` a cell, the way a property mapping is carried.
- `link` — `target` is the link's target text, `display` a cell or `null`, and `resolved` the vault path it resolves to or `null`.
- `file` — `path` is a vault path.
- `image`, `icon`, `html` — `value` is the argument the expression passed; the client renders it.
- `error` — `message` says why. The expression failed on this row (a type error, a missing method), or the formula the column reads does not compile; the row stays, as Obsidian shows an error cell rather than dropping the row.
- `unknown` — the client-side catch-all for a kind this build has not heard of. The server never emits it.

A regular expression value has no cell kind of its own; it travels as a `string` cell `/source/flags`. A cell nests at most 32 levels deep: the value at the cap becomes an `error` cell and the levels above it are kept, so every answer stays inside the 128-level reading limit of common JSON decoders.

A view's sort is a transitive total order over every cell kind: booleans (false before true), then numbers, then dates, then text by collation, with empty values and error cells last in both directions; in a key whose every non-empty value is a boolean, an empty value sorts as `false`. This is ruling 8 of the design, and it differs from Obsidian's own comparator only where a key mixes kinds (`VAULTD-COMPATIBILITY.md` names the cases).

### Property types

The types a property is declared with come from the vault's `.obsidian/types.json`, read through the configuration zone when a view is computed (not on a store hit). Keys match without case. A missing or unreadable file means no declared types. A change to that file is not a generation, but it retypes cells, so the daemon keeps a types epoch: a change through this daemon's `write_file`, or an external edit the watcher names, bumps it before the `config_changed` event is sent, every stored answer computed under the old epoch is never served again, and every view the daemon knows gets a `views_invalidated` right behind the `config_changed`.

### The language

The whole published Bases reference is implemented: every type, operator, global function, method and field on Obsidian's pages, `this`, formulas, base and view summaries, and the view declarations. A view is evaluated in this order: the prefilters an index serves (`file.inFolder`, `file.hasTag`, `file.ext ==` and scalar property equality at the top of the filter tree), then the base's and the view's filters as one conjunction, then formulas (memoized per row), then `sort` (stable), then `limit`, then `groupBy`, then summaries over the surviving rows. `this` is the note `this_path` names, or the base itself when it is absent.

Where the published pages and a runtime capture of Obsidian disagree, the capture wins; where neither fixes a behaviour, a provisional rule answers and is listed for re-capture in `VAULTD-COMPATIBILITY.md`, and in the one case no rule was chosen (`keys()` and `values()` of an object holding an integer-like key beside others) the answer is an error cell naming the case. A formula that does not parse, or calls an unknown function or method, is an error cell in its column (ruling 7); a filter that does is a request-level `expression_invalid` or `unsupported_function`, because there are no rows to show. The parser refuses what Obsidian cannot parse: exponent literals, a method on a bare number literal, object literals, a regular-expression literal JavaScript refuses, and a raw line or paragraph separator inside a string. Regular expressions are limited to what the Rust `regex` crate expresses: a look-behind parses and is an error when evaluated.

## Search

`vaultd` answers Obsidian's core Search: the `search` operation above, and the two error codes `query_invalid` and `unsupported_operator` under **Errors**. The design and its rulings are in `docs/design/search.md`; the measurements are in `docs/performance/search-baseline.md`; what parity with Obsidian means, and the provisional rules that stand in for behaviour no capture has settled yet, are in the **Search parity** section of `VAULTD-COMPATIBILITY.md`. This build is the first cut (the MVP); the parity operators are refused by name until they land.

### The grammar

The parser reads the whole of Obsidian's published grammar, so a construct this build does not evaluate is refused by name rather than searched as text:

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

- **AND binds tighter than OR.** `meeting work OR meetup personal` is `(meeting work) OR (meetup personal)`. `OR` is recognized only in upper case and only as a word of its own; `or` is a plain term.
- **A word** runs to whitespace or a parenthesis. A word whose prefix before `:` is not an operator name (`foo:bar`) is a plain word, and a `"` inside a word is part of it.
- **A phrase** is quoted, `"star wars"`, and matches its text as one needle, spaces included. Inside it `\"` is a quote and `\\` a backslash.
- **Negation.** A leading `-` negates a word, a phrase, a group or an operator: `meeting -work`, `meeting -(work meetup)`, `-tag:#draft`.
- **A regular expression** is `/source/flags`, where the flags are JavaScript's flag letters and end the word; `/usr/local` is a plain word.
- **A property search** is `[name]`, `[name:value]`, `[name:null]`, `[name:<5]` or `[name:>5]`.
- **Nesting** is bounded at 64 levels.

What this build evaluates: words, phrases, AND, `OR`, groups, `-`, and the operators `file:`, `path:`, `content:`, `tag:`, `match-case:` and `ignore-case:`, each with a word, a phrase or a group as its operand, with the `match_case` toggle and all six sorts. What it refuses with `unsupported_operator`, naming the construct, with `position` at its first character: regular expressions, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, and property search. What it refuses with `query_invalid`, with `position` at the problem: an unbalanced parenthesis, bracket or quote, an empty `()` or `[]`, a `-` with no term after it, an `OR` with no term before or after it, an operator with no operand, a property value missing after `:`, a comparison whose operand is not a finite number, and nesting deeper than 64. A malformed query is refused, never read leniently.

### What each scope reads

- **A plain word or phrase** matches a note's text, frontmatter included, and the note's whole vault path (P2, P5). On a non-note file it matches nothing.
- **`content:`** matches a note's text only.
- **`file:`** matches the file name, the last path segment with its extension (`file:.png`), of any file.
- **`path:`** matches the whole vault path of any file (`path:"Daily notes/2022-07"`).
- **`tag:`** matches a note's tags, body and frontmatter alike: the tag itself or a descendant (`tag:work` matches `#work` and `#work/meeting`, never `#myjob/work`), with or without the `#`, and always without case, under `match-case:` too (P9). An empty tag term matches nothing.
- **`match-case:` and `ignore-case:`** set the case mode of their operand, overriding the toggle.

Every term matches by substring, never by whole word (P1). An empty phrase matches nothing.

### The file universe

A Markdown note is always a candidate. Any other file is a candidate only when a positive `file:` or `path:` term (one under an even number of negations) holds for that file (P10). So `-foo` lists notes only, never every attachment; `file:(-x)` admits the attachments whose name lacks `x`; `-file:x` admits no attachment at all; and `-file:.png` still lists notes. Nothing under `.obsidian/` or any hidden folder is searched, because nothing there is indexed. The vault's **Excluded files** setting is not honoured yet: every indexed file is a candidate.

### Spans

A matching file reports the spans of every **positive** term in the branch that makes it match: under an `OR`, only the alternatives that hold contribute, and a term under a `-` contributes none. Each needle reports every non-overlapping occurrence, and spans that overlap are merged into one. A plain term reports its matches in the text as content spans and its matches in the path as path spans; a `file:` term's spans are placed in the whole path string; a `tag:` match is the whole tag, `#` included, as a content span.

### Case folding

Without `match_case`, both sides are lowercased the way JavaScript's `toLowerCase` lowercases them (P3): Unicode default lowercasing, Greek final sigma included, with no folding of diacritics and no normalization, so `cafe` does not match `café` and an NFC spelling does not match an NFD one (P4). The spans always point into the original text, never into a lowercased copy, even where lowercasing changes a character's length (`İ`, the Kelvin sign).

### Positions

A content `span` is UTF-8 bytes into the exact source; `start` and `end` are UTF-16 units, the unit of Obsidian's own positions; `path_matches` are UTF-16 units of the path string. A line ends at `\n`; a `\r` before it is not part of `line_text`. An error's `position` is different again: a character offset (a count of Unicode scalar values) into the query string, because a query is something a person typed.

### Sorting

The File name orders compare the base name (the file name without its extension) and then the extension, each with the collation the Bases evaluator uses (`localeCompare`, numeric, locale `en`; P15), so `Note.md` sorts before `Note 2.md`. The time orders read the file tree's modification and creation times. Every order breaks ties by path, ascending.

### Canvas content

Canvas content is not searched in this phase (design Ruling 4, issue #3): `vaultd` does not keep a canvas's bytes. A `.canvas` file is a `file`, reached only by `file:` and `path:`, never by a plain term or `content:`.

### Freshness

There is no search event. An answer names its `generation`; a client that holds one re-asks when a `generation_committed` it receives is newer. Live search subscriptions, which would re-evaluate a query on the changed paths alone, are designed and deferred (design Ruling 5, issue #1).

## Transports

The daemon serves the same newline-delimited JSON over two doors.

**stdio** is always served while standard input is open, and is what a parent process that spawned the daemon uses. Without `--listen`, end of file on standard input ends the daemon, which is how a supervising parent owns its whole life.

**A Unix domain socket** is served when the daemon is started with `--listen`. With no value it binds `<run dir>/<digest>.sock`, where the digest is the first sixteen hexadecimal characters of the SHA-256 of the canonical vault root and the run directory is `$XDG_RUNTIME_DIR/vaultd` when that variable is set and non-empty, else `<XDG cache dir>/vaultd/run`. With a value it binds that path. The run directory is created with mode `0700` and the socket with mode `0600`: the socket file's mode is the whole of the access control, and there is no authentication beyond it. The listen backlog is 16, and there is no cap on connections — the operating system's file-descriptor limit is the cap, and reaching it is reported on stderr and does not stop the daemon.

With `--listen`, end of file on standard input ends **stdio alone** and the daemon carries on serving the socket, which is what lets it be started with standard input closed and outlive whatever started it. It is then ended by `SIGTERM` or `SIGINT`.

**Readiness is the socket file existing and `health` answering.** The daemon prints nothing new to standard output when it binds, because standard output is stdio's protocol stream and a non-protocol line would break its client.

**A path that is already occupied is decided rather than guessed.** If a daemon answers `health` there, this one refuses to start, exits 2, and names the path on stderr. If nothing answers, the file is treated as the remains of a crashed daemon and unlinked. A path that exists and is not a socket is refused with exit 2 and left untouched. A daemon that is alive but too starved to answer the 500 ms probe in time can therefore lose its socket file to a newcomer that unlinks and rebinds it; the index writer lease is the real exclusion, so this never produces two writers over one index, but the wedged daemon is left without a door until it is restarted.

**Subscriptions and snapshot sessions are connection-scoped.** Identifiers are issued from each connection's own counter, so two connections may each hold `sub-1` and each hold `snap-1`, and neither can name the other's: a `snapshot_id` from another connection is `snapshot_not_found`, and a `subscription_id` from another connection is `subscription_not_found`. Ending a connection drops every subscription it held and closes every session it opened, releasing the write-ahead-log frames those pinned. The other connections are not told.

**Writes still serialize.** Every mutation goes through the runtime's single coordinator whichever connection asked for it, so two clients cannot interleave one, and read-your-writes holds per connection exactly as it always did. The exclusive writer lease is unchanged: there is one daemon per index, and the socket is a second door to it, never a second writer. `--read-only` applies to every connection.

**A connection's errors are its own.** An unsupported version and an oversized line get the same refusals as ever, on that connection, which stays open. A line that is not JSON has no request id to answer under, so it ends that connection with no response line, exactly as stdio always did. Only end of input, a write failure, or shutdown closes a connection otherwise, and a write failure ends that connection alone — one line on stderr, every other connection still served.

**Shutdown drains in two bounded budgets.** On `SIGTERM` or `SIGINT` the daemon stops accepting, sends every live connection a `runtime_state_changed` with `live_state: "stopped"`, closes each writer once its queue has drained, stops the runtime, and unlinks the socket file. The first budget is bounded at five seconds, after which writers are closed hard; a second budget of five seconds more then waits for every forwarder to finish, so a stop never exceeds ten seconds and never hangs. A clean shutdown exits 0.

**A silent connection is never timed out.** Idle snapshot sessions are swept on every input on their own connection, so a connection that opens a session and then sends nothing pins write-ahead-log frames until it closes. This is a documented limit, unchanged from stdio, and the socket file's mode is the guard against strangers reaching it. Sweeping sessions across connections is deferred.

**Measured against the design's four performance targets** (`docs/performance/vaultd-socket-transport-baseline.md`): connection setup was 0.139 ms median against a target under 5 ms p50 — met. A warm `get_note` round trip over the socket was 0.981× the same round trip over stdio (medians 0.119 ms against 0.121 ms) against a target within 10 percent — met; the first measurement of this phase missed it at 2.16×, the mechanism was that `connection::write_output` wrote straight to an unbuffered socket instead of a buffered one, and the fix — wrapping that sink in a `BufWriter` for every transport — landed in the same phase. A `write_note` round trip was 0.987× stdio — met. A `get_note` beside a peer that has stopped reading was 1.003× the same read with no stalled peer (median of three run ratios) — met. And a connection costs exactly the four threads a stdio connection already costs, on both transports — met, with no new thread per connection.

Reaching the daemon from another machine is done by forwarding the socket over SSH (for example `ssh -N -L <local socket>:<remote socket> <host>`).

## Events

The stdio transport carries a second top-level envelope shape alongside responses: one JSON object per line, with `version`, `subscription_id`, and `event`, and no `id` or `outcome`. Exactly one writer owns the output stream, so an event line can never split a response line, and a client that never subscribed sees byte-identical output to protocol version 1 without events.

Ordering is definite in both directions. A `subscribe_events` response is written before its subscription can receive anything, so no event precedes it. An `unsubscribe` response is written after that subscription's queue is flushed, so no event follows it.

Every event is **post-commit**: the generation it names is already committed to SQLite and installed as live state, so a read issued after the event sees at least that generation.

The converse also holds, and matters for a client tracking continuity. Publication moves before the event describing it is emitted, so a subscription can open at a generation whose event has not been dispatched yet. Those events are dropped rather than delivered: a `generation_committed` at or below a subscription's start point never reaches it. `resync_required` and `runtime_state_changed` are not filtered this way — an old generation is still news when the message is "re-read" or "the runtime's state changed".

### `generation_committed`

One committed generation's change, across both axes the cache indexes: a note whose semantic rows moved, and a file or folder whose file-tree row moved. A path in `changes` is therefore not necessarily a note — a client that only wants notes filters by extension, exactly as it must already do for the vault itself — while `affected_note_count` counts notes alone, so a generation that only moved the file tree reports zero affected notes with its paths still spelled out.

**A deleted folder implies its subtree.** A folder in `deleted` means the folder and everything that was under it is gone; the descendants are not spelled out individually, because the event that named the folder never named them. This matches Obsidian's own vault-event semantics, where deleting a folder raises one `delete` for the folder. It also means the two reconciliation routes report the same physical event at different resolutions: a watcher-driven delete names the folder alone, while a complete reconciliation — which enumerated the vault and so knows each path — names the folder and its descendants. Both are correct, and a client that applies the subtree rule gets the same state from either.

**Apply `deleted` before `created`.** One path may appear in both lists in the same generation, and that pairing has exactly one meaning: the thing at that path was removed and a different thing was created there — a folder replaced by a file of the same name is the case that produces it. Applying `deleted` first gets that right, and takes the removed folder's subtree with it; applying `created` first drops the new entry again.

`changes` is `detailed` with explicit path lists while the change set holds at most 1024 paths, and `counts_only` beyond that — in which case a `resync_required { oversized_change_set }` follows it immediately. `cause` is one of `watcher`, `startup`, `periodic`, `manual`, `verified`, or `mutation` — `mutation` being a generation this daemon's own write path produced, which a client may already have read its own write at. A client must not depend on the order of a mutation's own response line and the `generation_committed` event for that mutation: they are written by different producers, and the response already carries a generation the write is readable at, so the event is a confirmation rather than a barrier.

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"generation_committed","value":{"previous_generation":3,"generation":4,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["Folder/Note.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":7}}}
```

### `runtime_state_changed`

The runtime's observational status moved. `message` carries the reason when there is one; `error_code` is reserved for a future typed code and is always absent today.

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"runtime_state_changed","value":{"generation":4,"live_state":"polling_fallback","message":"watcher installation was refused"}}}
```

### `resync_required`

The generation moved in a way no per-path change set describes: an incremental client must re-read current state rather than apply a delta. `current_generation` names the generation to re-read at, and `reason` is one of:

- `runtime_recovered` — the startup catch-up, a periodic tick, a manual refresh, or a watcher-failure recovery.
- `watcher_overflow` — the watcher lost events (kernel overflow, storming, or a structural change it could not name).
- `root_invalidated` — the vault root itself was removed or renamed.
- `subscriber_lag` — this subscription stopped draining, so its queued detail was collapsed onto this one marker.
- `oversized_change_set` — the preceding generation's change set exceeded the detail limit and was reported as counts.

`current_generation` is nullable in the type but is never null in protocol version 1: an event that cannot name a generation to re-read at would tell a client nothing, so it is withheld rather than emitted (see the note at the end of this section). A client may treat the field as present. It stays nullable so a later version can carry the case explicitly without widening the shape again.

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":4,"reason":"watcher_overflow"}}}
```

### `config_changed`

This daemon's own `write_file` or `create_folder` landed inside `.obsidian/`. It carries **no generation**: nothing in the zone is indexed, so no generation contains it, and a client re-reads the named path with `read_file` (or lists it again) rather than applying a delta. `path` is the path the write *landed on*, not the one the request spelled, so a host can match the notice to the file or folder it knows even when a symlink or a case-folded name reached the zone. A `create_folder` of a zone folder that was already there announces itself too — the notice means "re-read this path", not "a delta happened".

The zone is not watched — it is a dot-directory, and the scanner and the watcher skip it — so an edit made by anything other than this daemon raises no event at all, with one exception: the watcher passes exactly `.obsidian/types.json`, the declared property types Bases evaluation reads, and an external edit of it raises `config_changed` like a write through this daemon. That exception holds only when a watcher event names the file: a watcher overflow or a complete reconciliation does not announce it, and neither does a delete or a move of `types.json` through this daemon. A host that shares the zone with other writers polls or watches it itself.

A `config_changed` for `.obsidian/types.json` retypes every view, so every view the daemon knows is named by a `views_invalidated` right behind it (see **Bases**, **Property types**).

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"config_changed","value":{"path":".obsidian/app.json"}}}
```

### `views_invalidated`

A view may have changed at `generation`; re-ask `evaluate_base` for it. One event per (base, view), whatever embeddings (`this_path`) a client holds, queued right behind the `generation_committed` it follows (or behind a `config_changed` for `.obsidian/types.json`), through the same per-subscription queues and bounds as every event. Every connection computes the rule for every committed generation, subscribed or not, so it never misses a base created while no client listened; the answer is memoized per generation, so many connections pay for it once, and it runs on the dispatcher, never on the coordinator. One generation can stale more views than a subscriber queue holds, so the events are queued half a queue at a time and drained in between rather than collapsing onto a `subscriber_lag` marker.

The rule is coarse and cheap enough to run on every commit. A view is stale at generation G when

1. its base's path is in G's change set (a deleted folder counts for every base under it); or
2. a changed path is among the rows the view last answered, for any `this_path` (a deleted folder counts for every row under it); or
3. a changed path that exists at G passes every one of the view's prefilters (a view with none passes every path); or
4. the view reads formulas or backlinks and any note changed, or it reads links (`file()`, `link()`, `asFile()`, `file.links`) and any file changed, because links reach attachments; or
5. the view reads `this` and any file changed; or
6. a note whose references re-resolved to a different answer at G counts as changed for clauses 2 to 5.

A deleted path that is not a note may have been a folder holding notes, so it counts as a changed note for clauses 4 and 5. False positives are accepted; false negatives are a defect. Known false positives: a change that passes a view's prefilters or touches one of its rows without changing its result, a formula-reading view and a note it never reads, a dispatcher so far behind that the memo no longer holds its generation (it then names every view it knows, every view any client was answered, and every view a newer decision named), and the second epoch bump when the watcher sees this daemon's own `types.json` write again.

No `views_invalidated` accompanies a `resync_required`, which carries no change set: a client re-reads everything then, views included. A generation whose change set exceeds the 1024-path detail limit is followed by `resync_required { oversized_change_set }` and no `views_invalidated` for the same reason. The rule does not cover the clock: see `now()` and `today()` under `evaluate_base`.

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"views_invalidated","value":{"base":"Books.base","view":"Table","generation":8}}}
```

### Bounds

Every queue is bounded and every overflow degrades into a marker, never into silence. Which bound you meet depends on how events are being delivered.

**What a slow stdio client actually meets is backpressure.** The dispatcher drains queued events immediately after every notice, so no subscription queue holds more than one notice's worth. A client that stops reading its stdout instead backs up the output queue, which blocks the dispatcher's shared drain, which fills the input queue, at which point the coordinator's non-blocking notice send starts failing. Those drops are latched and announced, once there is a generation to name, as `resync_required { runtime_recovered }`. So the symptom of a slow stdio client is a `runtime_recovered` resync — not `subscriber_lag`.

**On the socket the same thing happens one hop further out.** One broadcaster thread clones each runtime notice into every connection's own bounded inbox, 256 deep, with a non-blocking send. A connection whose inbox is full has that notice dropped and its gap latched, and the next notice it can be given is preceded by `resync_required { runtime_recovered }` naming the newest generation, which is then followed by the notice itself. So the symptom of a slow socket client is the same `runtime_recovered` resync a slow stdio client meets, it costs that connection alone, and the broadcaster never blocks — which is what keeps "reconciliation is never stalled by a client" true however many clients there are.

**The registry enforces two bounds** regardless of transport. They bind any embedder driving it directly — batching notices, or draining on a schedule — and only the second is reachable through the stdio dispatcher:

- **Per subscription: 64 events.** A subscription whose queue fills has its queued generation detail replaced by one `resync_required { subscriber_lag }` naming the newest generation; the newest `runtime_state_changed` survives, because state is a level rather than an edge. Detail resumes once that marker drains. Not reachable through the stdio dispatcher, for the reason above.
- **Per generation: 1024 paths of detail.** Larger change sets are reported as counts plus `resync_required { oversized_change_set }`. Reachable over stdio, because it depends on the size of one generation rather than on how fast anyone drains.

**Reconciliation is never stalled by a client.** The coordinator offers notices without ever waiting and drops what will not fit, so no client — however slow, however dead — can slow indexing or cause a lost change. Only a gap, and the gap is announced.

**Delivery between peers is not independent on one connection.** Subscriptions have private queues, so neither can displace the other's events. Private queues bound memory, not latency, and the boundary is the connection: two subscriptions on one connection share a dispatcher and a writer, so a client that stops reading delays its own other subscriptions until it resumes or disconnects — and delays nothing on any other connection.

While no generation has ever been committed, `resync_required` is withheld: there would be nothing to re-read at. The first resync that does name a generation — after a cold build, the runtime's own `runtime_recovered` at generation 1 — supersedes every withheld predecessor.

## Errors

Stable version 1 codes and when each occurs:

- `incompatible_version` — the envelope version is unsupported; carries `supported_version`.
- `invalid_request` — a supported version whose request cannot be decoded.
- `invalid_path` — a parameter is not a valid vault-relative path. A NUL byte anywhere in a path is refused with this code by every operation, reads and mutations alike (the `parse_path` door); it never reaches the engine, so it is never reported as a zone or containment refusal.
- `invalid_cursor` — a malformed cursor, a cursor for a different operation or filters, or an out-of-range limit.
- `note_not_found` — an exact-path lookup found no note.
- `index_unavailable` — no vault is configured, or no complete generation exists yet.
- `generation_mismatch` — the generation a request was bound to is no longer the one being served; carries `current_generation`. Two causes: a **cursor** whose generation has moved on (restart the listing), and a **snapshot session whose pin was lost** (reopen the session and hydrate again). The message says which.

```json
{"version":1,"id":"l","outcome":{"status":"err","value":{"code":"generation_mismatch","message":"cursor generation 2 does not match current generation 3","current_generation":3}}}
```

- `vault_changed_during_refresh` — the vault changed between a refresh's two inventories; nothing was published.

```json
{"version":1,"id":"x","outcome":{"status":"err","value":{"code":"vault_changed_during_refresh","message":"the vault changed while refreshing; retry"}}}
```

- `incompatible_index` — the index belongs to another vault or an incompatible version that cannot be rebuilt safely.
- `storage_failure` — an index storage or filesystem failure not representable as a note diagnostic. A mutation whose write reached disk and whose generation then failed to publish reports this same code, whatever the reconciliation itself failed with. For the operations that carry a content revision (`write_note`, `copy_file`, `patch_frontmatter`), `current_revision` is what tells the two apart, and a client must branch on it rather than retry blindly: **present** means the bytes landed and only the index is behind — it catches up at the next reconciliation, and an immediate retry may now meet `target_exists` or `revision_conflict`; **absent** means nothing was written and a retry is safe. The operations with no content revision of their own — the folder operations and the deletes — carry no `current_revision` in either case, so for them a client must re-read rather than infer.

```json
{"version":1,"id":"w","outcome":{"status":"err","value":{"code":"storage_failure","message":"the write reached the vault but its generation was not published","current_revision":"blake3:8dd1ae6e…"}}}
```

- `internal` — an unexpected server failure.
- `index_in_use` — another process holds the exclusive writer lease on this index. Nothing is damaged and nothing this process does will release it.
- `runtime_not_ready` — the operation needs the live runtime and there is none: health-only mode, or a runtime that has stopped.
- `runtime_overloaded` — the runtime's command mailbox was saturated, so this request was dropped. The change it would have covered is escalated to a complete reconciliation; retry for the report.
- `subscription_not_found` — an identifier this process never issued, or already released.
- `watch_unavailable` — reserved for a future operation that requires a filesystem watcher. A runtime that cannot watch reports the reason through `live_state: polling_fallback` and `runtime_state_changed` instead of failing requests.

The write path and the snapshot sessions add ten more. Every one of them means **nothing changed**:

- `revision_conflict` — an `expected` precondition did not match the bytes on disk; carries `current_revision`, the revision the target actually holds, so a retry loop does not have to re-read and race the next writer. It carries no `current_generation`: the conflict is with the filesystem, and the index's generation is not what the retry compares against.
- `not_found` — the operation's subject does not exist.
- `parent_not_found` — the parent folder of a path does not exist. Parents are never created implicitly; create it and retry.
- `target_exists` — something already occupies the destination. Also a non-empty folder deleted without `recursive`, a folder-rename destination that already exists, a `read_file` whose path is not a regular file, and a `read_dir` whose path is not a directory.
- `case_collision` — the path differs only by case from one that already exists on a case-insensitive filesystem. `vaultd` refuses; Obsidian does not.
- `zone_violation` — a semantic operation named a path under `.obsidian/`. Use `read_file`/`write_file` there.
- `payload_too_large` — the payload exceeds 16 MiB. Chunked transfer is the deferred alternative and is not in version 1.
- `read_only` — the daemon was started with `--read-only` and refuses every vault write.
- `snapshot_not_found` — a session identifier this process never issued, or one already closed or reclaimed after its idle timeout.
- `too_many_snapshots` — the concurrency cap (4) is reached; close a session and retry.

Bases evaluation adds four, each naming what it refused:

- `base_invalid` — the base does not parse; the message carries the YAML position.
- `view_not_found` — the base declares no view by that name; the message lists the declared views.
- `expression_invalid` — a filter the view reads does not parse; the message names the expression and the position.
- `unsupported_function` — a filter the view reads calls a function or method this build does not implement; the message names it.

A failure inside one row's cell is not an error at all — it is an error cell, and the row stays. A formula or a base summary that does not parse, or calls an unknown function, is an error cell in every row too, not `expression_invalid` or `unsupported_function`: only a filter refuses the request, because a filter that cannot run leaves no rows to show. `evaluate_base` also answers `not_found` for a path with no indexed base and `invalid_request` for a `this_path` that names no note.

Search adds two, each naming what it refused, and both carry `position`, the character offset (a count of Unicode scalar values) in the query where the refused construct or the problem is:

- `query_invalid` — the query does not parse: an unbalanced parenthesis, bracket or quote, an empty group, a dangling `-` or `OR`, an operator with no operand, or nesting deeper than 64 levels. The message names the problem.
- `unsupported_operator` — the query uses an operator or construct Obsidian's Search has and this build does not evaluate yet (in this build: regular expressions, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:` and property search). The message names it.

```json
{"version":1,"id":"q","outcome":{"status":"err","value":{"code":"query_invalid","message":"unmatched `)`","position":3}}}
```

That is the answer to the query `a b)`: the stray `)` is the fourth character.

`unknown` is reserved as a client-side catch-all for a code this build has not heard of. The server never emits it.

Errors never contain raw SQL, internal cache paths, or backtraces.

## Link repair failure reasons

`rename_note` and `rename_folder` repair inbound references when `rewrite_links` is true (the default). A rename that moves the file but cannot retarget some reference still succeeds: it reports `links_rewritten` and, separately, one `link_rewrite_failures` entry **per unrepaired reference**. Silence means nothing was declined, so a client may treat an empty list as an affirmative "every inbound reference now points at the new path".

Each entry is `{ "path": ..., "reason": ... }`. `path` is *the path the failure is about* — the referring note for every per-reference reason, and the rename's own subject for the one burst-scoped reason. A client must read `reason` before it reads `path`.

`reason` is a closed set of stable codes:

- `revision_conflict` — the referring note's bytes moved between the plan and the write. Its content is intact and the reference was not retargeted; re-read it and retry.
- `source_absent` — the referring note was deleted before its rewrite landed. Deliberately not recreated.
- `not_indexed` — the referring note has no indexed row, so there were no spans to rewrite against. The index is behind the vault for that path; a refresh and a retry will repair it.
- `reference_missing` — the reference has no stored row under its ordinal. An index invariant is broken; a complete reconciliation repairs it.
- `span_mismatch` — the stored target span and the stored bytes disagree, so splicing would rewrite the wrong bytes.
- `unwritable_spelling` — no link syntax available at that reference can spell the destination's name. A wikilink's file target cannot carry a `#` (it starts the subpath) or a `|` (it starts the display text), and cannot contain the `]]` that would close the link early; a frontmatter reference carries wikilinks and nothing else, so it has no other syntax to fall back to. Rename the destination, or edit the reference by hand.
- `context_conflict` — the replacement is a valid link on its own and changes how the *surrounding document* parses, so writing it would destroy or redirect a reference. The referring note is left exactly as it was. Edit that reference by hand.
- `ambiguous_target` — the reference was already ambiguous: its spelling matched more than one note before the rename, so there is no single target to preserve, and the rename changes which note it lands on. Spell that reference explicitly and retry.
- `write_failed` — the rewrite was planned and validated and the filesystem write failed.
- `index_unavailable` — **burst-scoped**, not per-reference: no generation has ever been published, so there was no graph to ask which references point at the moved path. `path` names the rename's own subject. The move happened; nothing was repaired. Refresh the index and rename back and forth, or fix the references by hand.

A reference that resolved **nowhere** before the rename is not reported at all: it was already broken, the rename did not break it, and listing it would bury the real failures under links the rename never touched.

Per the evolution rule below, a client MUST treat a `reason` it does not recognise as unknown rather than as a protocol error.

## Reserved operation families

These names document intended boundaries and are not accepted by the version 1 request enum:

- `query`
- `begin_transaction`
- `commit_transaction`
- `abort_transaction`

The reserved `subscribe` family is no longer reserved: it landed as `subscribe_events` and `unsubscribe`, documented above. The reserved `apply_mutation` family is no longer reserved either: it landed as the named operations under "Mutations" above — `write_note`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`, `patch_frontmatter`, `write_file`, `read_file`, and `read_dir` — rather than as one omnibus verb, because a typed refusal per operation says more than a shared one could. The reserved `search` family is no longer reserved: it landed as the `search` operation, documented above.

## Evolution

Adding optional fields is backward-compatible. Adding operations is backward-compatible for servers and clients that reject unknown tagged variants cleanly. Renaming fields, changing meanings, or removing variants requires a new protocol version.

**Unknown variants are tolerated, not fatal.** Clients MUST treat an unrecognized value of an event's `type`, a `generation_committed` `cause`, a `resync_required` `reason`, a `live_state`, an error `code`, a tree entry's `kind`, a `read_dir` entry's `kind`, a subpath's `kind`, a cell's `kind`, a row's `kind`, a base's status `state`, or a search hit's `kind` as *unknown* rather than as a protocol error: parse the surrounding envelope, keep every field the client does recognize, and ignore the payload it does not. `vaultd`'s own DTOs implement this — each of those enums carries an `Unknown` catch-all, and an unknown event type discards its `value` — so adding an event kind, a cause, a reason, or an error code never breaks a subscriber built against an earlier version. This tolerance is for variants a client has never heard of; a *known* variant whose payload is malformed is still an error. One asymmetry: a subpath of an unknown kind decodes as `Unknown` with its value discarded, and that `Unknown` is **not serialised again** — re-encoding a decoded response that holds one is an error, where every other `Unknown` above re-encodes as `"unknown"`. One narrowing rides along: an event object's `type` key must now precede its `value` key — `vaultd` has always written them in that order, but the previous decoder also accepted the reverse. Mutation request parameters are the deliberate exception to field-tolerance: they reject unknown keys, because a misspelled precondition must fail loudly rather than silently downgrade a conditional write. **The two raw path reads documented beside them, `read_file` and `read_dir`, reject unknown keys too** — the exception is the whole family under "Mutations" above, not the writes within it, so that a client cannot send one spelling to `write_file` and a quietly different one to `read_file`. Each takes a single `path` and has no optional key to be tolerant about; loosening this later would be additive, which is why the strict side is the safe one to start on. Every other read's parameters keep the tolerance, and the carve-out splits on **field versus value**: an unknown *field* in one of those reads' params is ignored, so a server may add optional ones; an unknown *value* in a closed set a client chose from — an `include` facet name on `snapshot_notes`, a `status` filter on `list_references`, a `severity` on `get_diagnostics`, a `sort` or a `context` on `search` — is `invalid_request`, because a request that names something the server does not serve must not be answered as though it named nothing. Additivity still holds in the direction that matters — a server may add optional fields that older clients simply omit — but a client must not send fields the server it talks to has not declared.

**The `view` subpath kind is a break the version number does not mark.** It is new with Bases (phase 8). Before it, a subpath's `kind` was not on the tolerated list above, and `vaultd`'s own decoder of that time refuses a subpath kind it does not know, so a client built against it cannot decode a `get_note`, `resolve_link`, `list_references` or `snapshot_notes` response that holds a resolution to `X.base#View`: the whole response fails, not one field. The rule at the top of this section asks for a new protocol version only for renamed fields, changed meanings and removed variants, so the protocol version stays `1`; the server accepts exactly one version, so a bump would also refuse every request from every existing client. From this version on, a subpath's `kind` is on the tolerated list, so a client MUST treat a subpath kind it does not know as unknown, and a later kind breaks no conforming client. The TypeScript host's `SubpathDto` names `view`, and no part of it switches on the kind.
