# vaultd Protocol

Protocol version: `1`

The protocol is transport-neutral. The daemon's newline-delimited JSON stdio loop is a proof transport, not a production transport commitment.

## Daemon configuration

```text
vaultd --vault /path/to/vault                       # derived XDG cache index
vaultd --vault /path/to/vault --index /path/to.db   # explicit index path
vaultd                                              # health-only mode
```

One process serves at most one explicitly configured vault. Without `--vault`, only `health` succeeds and every indexed operation returns `index_unavailable`. With `--vault`, startup opens or creates the index and attempts one normal reconciliation; a startup refresh failure with an older complete generation serves that generation as `stale`, and a failure with no generation leaves indexed operations `index_unavailable` while `health` keeps working.

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

Returns the canonical vault root, vault identity, index state (`ready`, `stale` with the last refresh error, or `unavailable`), current generation, note count, and the last successful refresh time.

```json
{"version":1,"id":"v","request":{"method":"get_vault_info"}}
```

```json
{"version":1,"id":"v","outcome":{"status":"ok","value":{"type":"get_vault_info","value":{"generation":3,"canonical_root":"/vaults/example","vault_identity":"2f9a…","state":{"state":"ready"},"note_count":128,"refreshed_at_unix_ms":1756100000000}}}}
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
- `storage_failure` — an index storage or filesystem failure not representable as a note diagnostic.
- `internal` — an unexpected server failure.

Errors never contain raw SQL, internal cache paths, or backtraces.

## Reserved operation families

These names document intended boundaries and are not accepted by the version 1 request enum:

- `query`
- `search`
- `apply_mutation`
- `begin_transaction`
- `commit_transaction`
- `abort_transaction`
- `subscribe`

## Evolution

Adding optional fields is backward-compatible. Adding operations is backward-compatible for servers and clients that reject unknown tagged variants cleanly. Renaming fields, changing meanings, or removing variants requires a new protocol version.
