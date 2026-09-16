# vaultd host protocol

Protocol version: `1` — the same number `vaultd` speaks, because this is the same envelope.

The headless plugin host serves its own operations over a Unix stream socket: one JSON object per line, UTF-8. A client that already speaks `vaultd` needs no second grammar and, for everything the daemon owns, no second connection.

## Envelope

Requests, responses and events are `vaultd`'s three shapes exactly.

```json
{"version":1,"id":"1","request":{"method":"host.hello","params":{"nonce":"…"}}}
{"version":1,"id":"1","outcome":{"status":"ok","value":{"type":"host.hello","value":{}}}}
{"version":1,"id":"1","outcome":{"status":"err","value":{"code":"not_owner","message":"…"}}}
{"version":1,"subscription_id":"host-sub-1","event":{"type":"generation_committed","value":{}}}
```

A response echoes the request `id`; an event carries a `subscription_id` and no `id`. Exactly one writer owns each connection's output stream, so an event line can never be interleaved with a response line.

**Every field name is `snake_case`, without exception.** The host's internal shapes are `camelCase` and `host/packages/host/src/server/wire.ts` is the one place the conversion happens; `test/server-wire.test.ts` asserts, for every shape that crosses the socket, that no key at any depth matches `/[a-z][A-Z]/`.

## The multiplexing rule

**A method that does not begin with `host.` is forwarded to `vaultd` verbatim and its outcome relayed unchanged.** `get_note`, `write_note`, `list_notes` and every operation a future daemon adds work through this socket with no host-side maintenance, and a daemon refusal reaches the client exactly as the daemon wrote it — `current_revision` and every other tail included — so a retry loop behaves the same through either door.

A `host.`-prefixed method the host does not know is `invalid_request`. The host is the authority on its own namespace, and forwarding an unknown `host.` method to a daemon that never heard of it would turn a typo into a confusing refusal from the wrong process.

**The four snapshot operations are the exception**: they are answered from the host's mirror rather than forwarded (Ruling 5), so a client hydrating through the host needs one connection rather than two. See *Snapshots, served from the mirror* below.

## Socket security, in the order the layers hold the door

**The directory mode is the enforcement layer.** The socket lives inside a directory the host creates with `mkdir(0700)`; at startup the host `stat`s it and refuses to listen unless the mode is exactly `0700` and the owner is the host's own uid. A `0700` directory is what actually stops another user reaching the socket at all, on every Unix, because traversal requires execute permission on the directory. This is the layer the trust model rests on. A directory that is already there is **not** widened back to `0700` — the refusal is the point, and a `chmod` would paper over a fact the operator needs to be told.

**The socket mode is defense in depth.** Immediately after `listen`, the socket file is `chmod`ed to `0600` and `stat`ed to confirm. It is worth doing and it is worth asserting, but it is not what is holding the door: **Darwin (and the BSDs) historically ignore permission bits on `AF_UNIX` sockets at `connect()` time**, so a `0600` socket in a world-traversable directory is not, by itself, access control on macOS — which is the platform this host is developed on.

**The nonce is the application-level gate, and it is a substitute, not a supplement.** Node exposes no portable `SO_PEERCRED`/`LOCAL_PEERCRED` accessor without a native addon, so a peer-UID check is not available. Instead, the first line on any accepted connection must be `host.hello` carrying the host's ownership nonce — a 32-byte random value written to `<dataDir>/nonce` with mode `0600` at startup. Only a process that can read a `0600` file owned by this user can produce it, which admits the same process set a UID check would, root excepted (and a root peer is already past every boundary the host has). Anything else is refused with `not_owner` and the connection is destroyed.

The honest summary: **directory `0700` enforces, socket `0600` is defense in depth and may be advisory on Darwin, the nonce is the portable stand-in for the peer-UID check Node cannot make.**

Two further rules follow from it. A second `host.hello` on a connection that has already said it is `invalid_request` — the gate is a state, not a re-authentication. And a refused connection is destroyed rather than left open for another attempt: there is nothing to guess, so a peer that got it wrong is either a bug or a probe and neither is owed a retry.

### The manual cross-UID procedure

The mode assertions above say what the host *wrote*. Whether another user can reach the socket is a question only a second uid can answer, and that cannot run unattended. `host/packages/host/test/server-uid.manual.test.ts` is the other half: it is skipped unless `VAULTD_HOST_UID_TEST` is set, and it runs a client as `nobody` against a live socket.

```bash
VAULTD_HOST_UID_TEST=1 npm --prefix host test -- server-uid.manual
```

`sudo` prompts; the child only tries to connect. The expected result is `EACCES` (or `ENOENT`) from the **directory** walk — which is the assertion, since the directory is the layer doing the work. A `CONNECTED` there would mean the `0700` is not doing what this document says it does.

## Operations

Every field below is `snake_case`. The **Task** column says which task implements the row; the six marked **20b** are present in the dispatch table today and answer `host_not_ready` with a message naming that task until it lands.

| Method | Params | Result | Task |
|---|---|---|---:|
| `host.hello` | `{ nonce }` | `{ host_version, protocol_version, vault_root, config_dir, phase, generation, live_state, dry_run, plugins: PluginState[] }` | 16a |
| `host.info` | `{ refresh?: bool }` | `{ plugins, timers, overlap, counters, unsupported }` | 16a |
| `host.list_plugins` | `{}` | `{ plugins: PluginState[] }` | 16a |
| `host.enable_plugin` | `{ id, force_shared?: bool }` | `{ id, state }` | 16a |
| `host.disable_plugin` | `{ id }` | `{ id, state }` | 16a |
| `host.list_commands` | `{ plugin_id?: string }` | `{ commands: Command[] }` | 16a |
| `host.invoke_command` | `{ command_id, active_file?: string, selection?: Range }` | `{ command_id, ran: bool, generation, notices: string[] }` | 16a |
| `host.list_menu_items` | `{ context: "file-menu" \| "editor-menu", path }` | `{ items: MenuItem[] }` | 16a |
| `host.invoke_menu_item` | `{ item_id, path }` | `{ item_id, generation, notices: string[] }` | 16a |
| `host.list_protocol_handlers` | `{}` | `{ handlers: { plugin_id, action }[] }` | 16a |
| `host.invoke_protocol` | `{ action, params: Record<string,string> }` | `{ action, generation, notices: string[] }` | 16a |
| `host.subscribe` | `{}` | `{ subscription_id, generation }` | 16a |
| `host.unsubscribe` | `{ subscription_id }` | `{ subscription_id }` | 16a |
| `host.open_snapshot` | `{}` | `{ snapshot_id, generation, note_count, entry_count }` | 16a |
| `host.snapshot_tree` | `{ snapshot_id, cursor, limit? }` | `{ snapshot_id, generation, entries, next_cursor }` | 16a |
| `host.snapshot_notes` | `{ snapshot_id, cursor, limit?, include? }` | `{ snapshot_id, generation, notes, next_cursor }` | 16a |
| `host.close_snapshot` | `{ snapshot_id }` | `{ snapshot_id }` | 16a |
| `host.get_plugin_config` | `{ id, reveal_secrets?: bool }` | `{ id, values, schema: { source, items }, redacted_keys, state_keys }` | **wired in 20b** |
| `host.set_plugin_config` | `{ id, patch: Record<string, unknown> }` | `{ id, applied: string[], refused: { key, reason }[] }` | **wired in 20b** |
| `host.compat_report` | `{ plugin_id?: string }` | `{ report: CompatReport }` | **wired in 20b** |
| `host.attach_interaction` | `{}` | `{ attached: bool }` | **wired in 20b** |
| `host.detach_interaction` | `{}` | `{ attached: bool }` | **wired in 20b** |
| `host.respond_interaction` | `{ prompt_id, choice_index?: number, value?: string, cancelled?: bool }` | `{ prompt_id }` | **wired in 20b** |

`host.invoke_command`'s `selection` is a range — `{ from: { line, ch }, to: { line, ch } }` — rather than a string. A string would have to be searched for in the note, which is a different operation with a different failure mode; a client that sends one is told so rather than having it silently ignored.

### Readiness

`host.hello`, `host.info`, `host.list_plugins` and `host.subscribe` answer from the moment the socket is up: a client that has just connected needs to be able to ask what is going on *because* something is wrong. Every operation that needs a loaded plugin set — the command, menu, protocol and plugin operations — answers `host_not_ready` until the lifecycle sequencer reports `steady`. The snapshot operations do not wait, because the mirror is hydrated before the host starts.

`host_not_ready` is a typed, documented state rather than a crash or a missing method.

### Shapes

```ts
PluginState { id, name, version, state: "loaded"|"disabled"|"failed"|"quarantined", load_ms: number|null, failure_count: number, reason: string|null }
Command     { plugin_id, id, local_id, name, icon: string|null, kind, hotkeys: { modifiers: string[], key: string }[] }
MenuItem    { hook_id, plugin_id, id, title, icon: string|null, section: string|null, checked: boolean|null }
Overlap     { host_enabled: string[], gui_enabled: string[], overlap: string[], forced: string[], gui_readable: bool, checked_at_ms, overlap_poll_ms }
```

`version` is the empty string for a plugin whose manifest this host cannot read — unknown rather than invented, because a version nobody verified should not be printed as though it were `0.0.0`.

`Overlap` is `null` before the first coexistence reading. `overlap_poll_ms` rides beside the reading rather than inside it: it is the **width of the window in which this host can be wrong** about what the GUI has enabled. There is no event for "the user enabled a plugin in Obsidian" — a GUI writing `.obsidian/community-plugins.json` through its own writer raises nothing — so the host polls, and the period is part of the answer rather than a fact only the source knows. `host.info` with `refresh: true` takes a fresh reading first.

### Examples

Each of these is exercised by a test; the file is named beside it.

`host.hello` — the first line on every connection (`test/server-security.test.ts`):

```json
{"version":1,"id":"1","request":{"method":"host.hello","params":{"nonce":"9f86d081884c7d65…"}}}
{"version":1,"id":"1","outcome":{"status":"ok","value":{"type":"host.hello","value":{"host_version":"0.0.0","protocol_version":1,"vault_root":"/vault","config_dir":".obsidian-headless","phase":"steady","generation":1,"live_state":null,"dry_run":false,"plugins":[]}}}}
```

`host.list_commands` and `host.invoke_command` (`test/server-ops.test.ts`):

```json
{"version":1,"id":"2","request":{"method":"host.list_commands","params":{}}}
{"version":1,"id":"2","outcome":{"status":"ok","value":{"type":"host.list_commands","value":{"commands":[{"plugin_id":"demo","id":"demo:shout","local_id":"shout","name":"Shout","icon":"megaphone","kind":"callback","hotkeys":[]}]}}}}
```

```json
{"version":1,"id":"3","request":{"method":"host.invoke_command","params":{"command_id":"demo:shout"}}}
{"version":1,"id":"3","outcome":{"status":"ok","value":{"type":"host.invoke_command","value":{"command_id":"demo:shout","ran":true,"generation":1,"notices":["shouted"]}}}}
```

`notices` is the messages one command produced — a window of the host's notice log taken across the dispatch, not the whole log. An editor command needs `active_file`, because there is no focused editor in a headless host:

```json
{"version":1,"id":"4","request":{"method":"host.invoke_command","params":{"command_id":"demo:edit","active_file":"A.md"}}}
```

Without it the answer is `invalid_request`; with a path that names no file, `not_found`; for a plugin the host has quarantined, `plugin_quarantined` — which is answered **before** the command is looked up, since quarantining a plugin drops its whole harvest and a lookup-first host would say `command_not_found` about a command that exists.

`host.list_menu_items` and `host.invoke_menu_item` (`test/server-ops.test.ts`):

```json
{"version":1,"id":"5","request":{"method":"host.list_menu_items","params":{"context":"file-menu","path":"A.md"}}}
{"version":1,"id":"5","outcome":{"status":"ok","value":{"type":"host.list_menu_items","value":{"items":[{"hook_id":"demo:file-menu:0","plugin_id":"demo","id":"demo:file-menu:0:0","title":"Bless A.md","icon":"sparkle","section":null,"checked":null}]}}}}
```

A menu is **rebuilt** for every listing and for every invocation, because a plugin's item text and its `onClick` closure both close over the file the menu was opened for. An item id is `<plugin_id>:<context>:<hook_ordinal>:<item_ordinal>`.

`host.invoke_protocol` hands the plugin `{ action, ...params }`, which is the shape Obsidian hands a protocol handler — the action is *in* the params, and plugins read it from there:

```json
{"version":1,"id":"6","request":{"method":"host.invoke_protocol","params":{"action":"bless","params":{"note":"A.md"}}}}
{"version":1,"id":"6","outcome":{"status":"ok","value":{"type":"host.invoke_protocol","value":{"action":"bless","generation":1,"notices":[]}}}}
```

`host.enable_plugin` (`test/server-ops.test.ts`):

```json
{"version":1,"id":"7","request":{"method":"host.enable_plugin","params":{"id":"demo"}}}
{"version":1,"id":"7","outcome":{"status":"ok","value":{"type":"host.enable_plugin","value":{"id":"demo","state":"loaded"}}}}
```

The enabled set is written **before** the load, which is the order that fails safely: a plugin persisted and then failing to load is retried at the next start, where one that loaded and then failed to persist would run now and vanish later with nothing to say why. A plugin Obsidian is already running is refused with `overlap_refused`; `force_shared: true` admits it for that one call, and is the per-request twin of the `--force-shared` flag rather than a mutation of the host's configuration.

`host.subscribe` (`test/server-subscriptions.test.ts`):

```json
{"version":1,"id":"8","request":{"method":"host.subscribe","params":{}}}
{"version":1,"id":"8","outcome":{"status":"ok","value":{"type":"host.subscribe","value":{"subscription_id":"host-sub-1","generation":1}}}}
```

## Snapshots, served from the mirror

**A host snapshot pins nothing daemon-side.** No `open_snapshot` reaches the daemon, no read transaction is held, no WAL frame is kept alive. What a session freezes is the tree rows and the note paths as the host's mirror held them at the generation the session opened at.

**The page field names are the daemon's**: `entries` and `notes`, matching `SnapshotTreeResponse` and `SnapshotNotesResponse`. The point of Ruling 5 is that a client pages the host exactly as it would page the daemon, and renaming either field would force every client to branch on which door its page came through.

```json
{"version":1,"id":"9","request":{"method":"host.open_snapshot","params":{}}}
{"version":1,"id":"9","outcome":{"status":"ok","value":{"type":"host.open_snapshot","value":{"snapshot_id":"host-snap-1","generation":1,"note_count":2,"entry_count":3}}}}
```

```json
{"version":1,"id":"10","request":{"method":"host.snapshot_tree","params":{"snapshot_id":"host-snap-1","cursor":null,"limit":2}}}
{"version":1,"id":"10","outcome":{"status":"ok","value":{"type":"host.snapshot_tree","value":{"snapshot_id":"host-snap-1","generation":1,"entries":[{"path":"A.md","kind":"note","size":5,"ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000,"revision":"blake3:…"},{"path":"Folder","kind":"folder","ctime_unix_ms":1756100000000,"mtime_unix_ms":1756100000000}],"next_cursor":"eyJzIjoi…"}}}}
```

A folder carries neither `size` nor `revision`, and a non-note file carries `size` but no `revision`; absent is spelled by leaving the key off rather than by sending `null`, which is the daemon's own shape.

```json
{"version":1,"id":"11","request":{"method":"host.snapshot_notes","params":{"snapshot_id":"host-snap-1","cursor":null,"limit":10,"include":["metadata","sections"]}}}
```

`include` names the facets to serve: `metadata`, `references`, `resolutions`, `backlinks`, `sections`, `list_items`. A facet a client does not ask for is **absent**, never empty, so "I did not ask" and "there are none" stay distinguishable. `sections` and `list_items` are **top-level facets, siblings of `metadata` rather than nested inside it**. An unknown value inside `include` is `invalid_request` — ignoring a misspelled facet would serve a page silently missing what the client asked for.

Three refusals are worth stating:

- **A moved generation is `generation_mismatch`**, carrying `current_generation`, exactly as the daemon answers for a stale cursor or a lost pin. The client reopens. The session could serve its frozen arrays forever, but a client that asked for a coherent view of one generation and silently got a stale one would have no way to know.
- **An unknown, closed, or another client's session is `snapshot_not_found`.** Another client's id is not distinguished: saying "that one is somebody else's" would confirm the existence of a session this client cannot address.
- **Past `snapshot_session_cap` concurrent sessions, `too_many_snapshots`** — the same code the daemon answers for the same condition, so a client's retry logic is identical through either door.

`limit` is **clamped** into `1..=snapshot_page_size_max` rather than refused, including `0`, which becomes `1`. That is the daemon's rule for snapshot pages and it is copied here: a hydration loop that asks for too much should page more times, not fail half way through a vault. The cursor is opaque; a client stores it and hands it back.

A client disconnect closes every session that client held.

## Events

A subscription is per connection. One client may hold several; each gets its own `subscription_id` and its own copy of every event. A disconnect drops the client's subscriptions and its open snapshots.

Host events:

| Event | Value |
|---|---|
| `host.plugin_state_changed` | `{ id, state, reason }` |
| `host.notice` | `{ plugin_id, message, at_unix_ms }` |
| `host.overlap_changed` | `{ overlap, gui_enabled }` |
| `host.interaction_request` | `{ prompt_id, plugin_id, kind, prompt, items, timeout_ms }` — **emitted by 20b** |

Daemon-shaped events carry their `vaultd` payloads: `generation_committed`, `runtime_state_changed`, `resync_required` and `config_changed`.

```json
{"version":1,"subscription_id":"host-sub-1","event":{"type":"generation_committed","value":{"previous_generation":1,"generation":2,"cause":"mutation","changes":{"kind":"detailed","created":[],"modified":["A.md"],"deleted":[]},"affected_note_count":1,"synthetic":false}}}
```

**`generation_committed` is emitted when the host's mirror applies a batch, not relayed from the daemon's subscription, and the difference is deliberate.** A client of this host reads this host's view — `host.open_snapshot` serves from the mirror — so an event announcing a generation the mirror has not applied yet would invite a client to page a view that does not hold it. Emitting at apply time makes the event mean *the host's view is now at N*, which is the only claim this door can honestly make. Two consequences follow: `previous_generation` is where **this host** was, which after a re-hydration may be several generations back rather than the daemon's own previous; and `affected_reference_count` is **absent** rather than reported as zero, because the mirror's batch does not carry it and a client that needs it is asking a question only the daemon can answer. `changes` is always the `detailed` shape — a generation the mirror could not describe path by path took the resync road inside the mirror, and a `resync_required` is what a subscriber hears instead.

`config_changed` likewise comes from the mirror's own seam, so a raw write into the config zone is announced once rather than twice. `runtime_state_changed` and `resync_required` pass through from the daemon untouched: both are statements about the engine rather than about this host's view.

### A subscriber that stops reading

**The host never blocks on a slow subscriber, and never grows without bound for one.** Each subscription has a queue capped at `subscriber_queue_limit`. Past the cap the queue is dropped **whole** and the subscription owes exactly one collapse:

```json
{"version":1,"subscription_id":"host-sub-1","event":{"type":"resync_required","value":{"current_generation":371,"reason":"subscriber_lag"}}}
```

This is the same discipline and the same shape `vaultd`'s own subscriber registry uses, so a client that already knows what to do with a daemon's `subscriber_lag` needs no second code path for the host's. Three properties are pinned by test:

- **One message, not a prefix of the truth.** A queue that kept its first N events and dropped the rest would hand the client a partial account to apply before telling it to re-read. Everything queued at the moment of the drop goes with the drop.
- **`current_generation` is read when the collapse is written**, not when the drop happened: the client is about to re-read, and what it needs is where the host is when the message reaches it.
- **Nothing older follows it.** One writer owns the socket, so the collapse is ordered behind everything already sent and ahead of everything after.

At most one line is ever in flight on a connection: the write's own callback is what says the socket has caught up. That is what keeps the bounded queue the host's *only* buffer — a stream's own `write()` answers `false` only after it has buffered 16 KB of its own, so a host that waited for that signal would build a second, unbounded queue inside the socket underneath the bounded one, and slow to a crawl doing it.

## Errors

The host's codes, **additive to `vaultd`'s** — a forwarded operation's refusal is the daemon's, unchanged:

`host_not_ready`, `plugin_not_found`, `plugin_not_installed`, `plugin_quarantined`, `command_not_found`, `menu_item_not_found`, `protocol_handler_not_found`, `headless_unsupported`, `overlap_refused`, `config_key_refused`, `interaction_unavailable`, `interaction_timeout`, `dry_run_refused`, `not_owner`, `snapshot_not_found`.

Daemon codes the host also answers on its own behalf: `invalid_request` (a malformed request, or a `host.` method this build does not have), `invalid_cursor` (a snapshot cursor this host did not issue, or one from another session), `generation_mismatch` and `too_many_snapshots` (snapshot sessions, above), `subscription_not_found` (`host.unsubscribe` for an id this connection does not hold), `not_found` (a path that names nothing), and `internal` (a plugin's own code threw — the message names the command and the failure is counted against that plugin's quarantine).

Input with no usable envelope is a fatal input error: there is no `id` to echo, so there is no way to say which request it was about, and the connection is closed.
