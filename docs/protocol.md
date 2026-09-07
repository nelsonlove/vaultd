# vaultd Protocol

Protocol version: `1`

The protocol is transport-neutral. The daemon's newline-delimited JSON stdio loop is a proof transport, not a production transport commitment.

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
```

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
{"version":1,"id":"v","outcome":{"status":"ok","value":{"type":"get_vault_info","value":{"generation":3,"canonical_root":"/vaults/example","vault_identity":"2f9a…","state":{"state":"ready"},"note_count":128,"refreshed_at_unix_ms":1756100000000,"live_state":"watching"}}}}
```

### `list_notes`

Compact note summaries ordered by vault path. A summary's `title` is the string `title` property when present, otherwise the first heading.

```json
{"version":1,"id":"l","request":{"method":"list_notes","params":{"cursor":null,"limit":2}}}
```

```json
{"version":1,"id":"l","outcome":{"status":"ok","value":{"type":"list_notes","value":{"generation":3,"items":[{"path":"A.md","revision":"blake3:…","title":"A"}],"next_cursor":"eyJn…"}}}}
```

### `get_note`

Exact source, content revision, properties, aliases, headings, blocks, tags, the note's diagnostics, and outgoing references with their resolutions. Spans are half-open UTF-8 byte offsets into the exact source.

```json
{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Folder/Note.md"}}}
```

```json
{"version":1,"id":"n","outcome":{"status":"ok","value":{"type":"get_note","value":{"generation":3,"note":{"path":"Folder/Note.md","revision":"blake3:…","source":"# Note\n[[Other]]\n","properties":[],"aliases":[],"headings":[{"level":1,"text":"Note","span":{"start":0,"end":6}}],"blocks":[],"tags":[],"diagnostics":[],"outgoing":[{"source_path":"Folder/Note.md","kind":"wikilink","origin":"body","raw_target":"Other","file_target":"Other","subpath":null,"display":null,"span":{"start":7,"end":16},"target_span":{"start":9,"end":14},"resolution":{"kind":"resolved","target":"Other.md","subpath":null}}]}}}}}
```

### `resolve_link`

Applies the same resolution rules used during reconciliation to a destination string from a given source note.

```json
{"version":1,"id":"r","request":{"method":"resolve_link","params":{"source_path":"Folder/Note.md","destination":"Other#Heading"}}}
```

```json
{"version":1,"id":"r","outcome":{"status":"ok","value":{"type":"resolve_link","value":{"generation":3,"resolution":{"kind":"missing_subpath","target":"Other.md","subpath":{"kind":"heading","value":"Heading"}}}}}}
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

### Bounds

Every queue is bounded and every overflow degrades into a marker, never into silence. Which bound you meet depends on how events are being delivered.

**What a slow stdio client actually meets is backpressure.** The dispatcher drains queued events immediately after every notice, so no subscription queue holds more than one notice's worth. A client that stops reading its stdout instead backs up the output queue, which blocks the dispatcher's shared drain, which fills the input queue, at which point the coordinator's non-blocking notice send starts failing. Those drops are latched and announced, once there is a generation to name, as `resync_required { runtime_recovered }`. So the symptom of a slow stdio client is a `runtime_recovered` resync — not `subscriber_lag`.

**The registry enforces two bounds** regardless of transport. They bind any embedder driving it directly — batching notices, or draining on a schedule — and only the second is reachable through the stdio dispatcher:

- **Per subscription: 64 events.** A subscription whose queue fills has its queued generation detail replaced by one `resync_required { subscriber_lag }` naming the newest generation; the newest `runtime_state_changed` survives, because state is a level rather than an edge. Detail resumes once that marker drains. Not reachable through the stdio dispatcher, for the reason above.
- **Per generation: 1024 paths of detail.** Larger change sets are reported as counts plus `resync_required { oversized_change_set }`. Reachable over stdio, because it depends on the size of one generation rather than on how fast anyone drains.

**Reconciliation is never stalled by a client.** The coordinator offers notices without ever waiting and drops what will not fit, so no client — however slow, however dead — can slow indexing or cause a lost change. Only a gap, and the gap is announced.

**Delivery between peers is not independent on one connection.** Subscriptions have private queues, so neither can displace the other's events. But they share a dispatcher and a writer, so a client that stops reading delays every other subscription on that same connection until it resumes or disconnects. Private queues bound memory, not latency.

While no generation has ever been committed, `resync_required` is withheld: there would be nothing to re-read at. The first resync that does name a generation — after a cold build, the runtime's own `runtime_recovered` at generation 1 — supersedes every withheld predecessor.

## Errors

Stable version 1 codes and when each occurs:

- `incompatible_version` — the envelope version is unsupported; carries `supported_version`.
- `invalid_request` — a supported version whose request cannot be decoded.
- `invalid_path` — a parameter is not a valid vault-relative path.
- `invalid_cursor` — a malformed cursor, a cursor for a different operation or filters, or an out-of-range limit.
- `note_not_found` — an exact-path lookup found no note.
- `index_unavailable` — no vault is configured, or no complete generation exists yet.
- `generation_mismatch` — a cursor's generation is no longer current; carries `current_generation`.

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
{"version":1,"id":"w","outcome":{"status":"err","value":{"code":"storage_failure","message":"index storage failed","current_revision":"blake3:8dd1ae6e…"}}}
```

- `internal` — an unexpected server failure.
- `index_in_use` — another process holds the exclusive writer lease on this index. Nothing is damaged and nothing this process does will release it.
- `runtime_not_ready` — the operation needs the live runtime and there is none: health-only mode, or a runtime that has stopped.
- `runtime_overloaded` — the runtime's command mailbox was saturated, so this request was dropped. The change it would have covered is escalated to a complete reconciliation; retry for the report.
- `subscription_not_found` — an identifier this process never issued, or already released.
- `watch_unavailable` — reserved for a future operation that requires a filesystem watcher. A runtime that cannot watch reports the reason through `live_state: polling_fallback` and `runtime_state_changed` instead of failing requests.

Errors never contain raw SQL, internal cache paths, or backtraces.

## Reserved operation families

These names document intended boundaries and are not accepted by the version 1 request enum:

- `query`
- `search`
- `apply_mutation`
- `begin_transaction`
- `commit_transaction`
- `abort_transaction`

The reserved `subscribe` family is no longer reserved: it landed as `subscribe_events` and `unsubscribe`, documented above.

## Evolution

Adding optional fields is backward-compatible. Adding operations is backward-compatible for servers and clients that reject unknown tagged variants cleanly. Renaming fields, changing meanings, or removing variants requires a new protocol version.

**Unknown variants are tolerated, not fatal.** Clients MUST treat an unrecognized value of an event's `type`, a `generation_committed` `cause`, a `resync_required` `reason`, a `live_state`, an error `code`, or a tree entry's `kind` as *unknown* rather than as a protocol error: parse the surrounding envelope, keep every field the client does recognize, and ignore the payload it does not. `vaultd`'s own DTOs implement this — each of those enums carries an `Unknown` catch-all, and an unknown event type discards its `value` — so adding an event kind, a cause, a reason, or an error code never breaks a subscriber built against an earlier version. This tolerance is for variants a client has never heard of; a *known* variant whose payload is malformed is still an error. One narrowing rides along: an event object's `type` key must now precede its `value` key — `vaultd` has always written them in that order, but the previous decoder also accepted the reverse. Mutation request parameters are the deliberate exception to field-tolerance: they reject unknown keys, because a misspelled precondition must fail loudly rather than silently downgrade a conditional write. Additivity still holds in the direction that matters — a server may add optional fields that older clients simply omit — but a client must not send fields the server it talks to has not declared.
