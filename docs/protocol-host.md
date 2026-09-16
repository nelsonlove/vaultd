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

A response echoes the request `id` — a string as a string, a number as a number, and `""` for a request that carried neither. An event carries a `subscription_id` and no `id`. Exactly one writer owns each connection's output stream, so an event line can never be interleaved with a response line.

**Responses are paired by `id`, not by order.** A client that pipelines two requests may see the second answered first: `host.hello` reads the plugin set through the daemon while a version refusal is answered inline, and the host does not hold a fast answer back behind a slow one.

**`version` is validated before the method is dispatched**, which is `docs/protocol.md`'s rule and the reason version numbers exist: a `version` that is not `1`, or absent, is `incompatible_version` carrying `supported_version`, whatever method the request named. On an authenticated connection the refusal is answered and the connection kept; before authentication the connection goes with it, because a request carrying the wrong version is not a well-formed `host.hello`.

**A line that is not a JSON object is a fatal input error**: `null`, `5`, `"x"`, `[]` and anything that does not parse are all input with no usable envelope, so there is no `id` to echo and no way to say which line the refusal was about. The connection is closed with no reply. A single line is capped at 17 MB **of UTF-8**, one megabyte above `write_file`'s payload cap so the largest legitimate forwarded request still fits; past the cap the connection is closed rather than served.

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

Two further rules follow from it.

**Before authentication, anything that is not a well-formed `host.hello` carrying the nonce is `not_owner`, and the connection is destroyed.** Not only a wrong nonce: a missing `request`, a method that is not a string, params that are not an object, a different method entirely. There is nothing to guess — the nonce is 32 random bytes — so a peer that got it wrong is either a bug or a probe, and neither is owed a retry on that connection. One refusal is the most an unauthenticated peer is ever told, and a line with no usable envelope (above) is told nothing at all.

**A second `host.hello` on a connection that has already said it is `invalid_request`** — the gate is a state, not a re-authentication, and that connection is kept.

### The manual cross-UID procedure

The mode assertions above say what the host *wrote*. Whether another user can reach the socket is a question only a second uid can answer, and that cannot run unattended. `host/packages/host/test/server-uid.manual.test.ts` is the other half: it is skipped unless `VAULTD_HOST_UID_TEST` is set, and it runs a client as `nobody` against a live socket.

```bash
sudo -v                                                      # authenticate first
VAULTD_HOST_UID_TEST=1 npm --prefix host test -- server-uid.manual
```

**The case runs `sudo -n`, which never prompts**, and the two lines are why there are two: a test runner's child has no terminal to prompt on, so a prompting `sudo` would hang until the runner's timeout rather than ask anybody anything. `sudo -v` in your own shell caches the credential for a few minutes and makes the `-n` run succeed; a passwordless rule for this user works too. On a machine with neither, the case fails with sudo's own refusal rather than passing quietly.

The child only tries to connect. The expected result is `EACCES` (or `ENOENT`) from the **directory** walk — which is the assertion, since the directory is the layer doing the work. A `CONNECTED` there would mean the `0700` is not doing what this document says it does.

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
| `host.get_plugin_config` | `{ id, reveal_secrets?: bool }` | `{ id, values, schema: { source, items }, redacted_keys: Path[], state_keys }` | **wired in 20b** |
| `host.set_plugin_config` | `{ id, patch: Record<string, unknown> }` | `{ id, applied: string[], refused: { key, reason, path?: Path }[] }` | **wired in 20b** |
| `host.compat_report` | `{ plugin_id?: string }` | `{ report: CompatReport }` | **wired in 20b** |
| `host.attach_interaction` | `{}` | `{ attached: bool }` | 18 |
| `host.detach_interaction` | `{}` | `{ attached: bool }` | 18 |
| `host.respond_interaction` | `{ prompt_id, choice_index?: number, value?: string, cancelled?: bool }` | `{ prompt_id }` | 18 |

`host.invoke_command`'s `selection` is a range — `{ from: { line, ch }, to: { line, ch } }`, both fields zero-based — rather than a string. **This is a ratified deviation from the phase brief's pinned table**, which spells the row `selection?: string`: an `editorCallback` is handed an `Editor`, whose `setSelection` takes two positions, so a string would have to be *searched* for in the note — a different operation, with a different failure mode (no match, several matches) and a different answer for each. The controller ratified the range in Task 16a's fix round and the brief's table is amended to match. A client that sends a string is told so by name rather than having it silently ignored. The shape is pinned as `SelectionWire` in `host/packages/host/src/server/wire.ts`.

### Interaction, and the one-holder rule

**One client holds the interaction channel at a time, and holding it is what makes prompts reachable.** A plugin that opens a `SuggestModal` or a `FuzzySuggestModal`, or calls `FileManager.promptForDeletion`, raises a question the host has no window to ask — so the host asks whoever attached. `host.attach_interaction` takes the channel; while it is held, a second client asking is refused `interaction_unavailable` naming the connection that holds it, rather than silently taking prompts away from the client a human is looking at. `host.detach_interaction` releases it, and a client that disconnects releases it implicitly.

**Attaching opens a subscription if the connection holds none, and detaching closes exactly that one.** An event reaches a client through its subscriptions and nowhere else, so a client that attached without subscribing would have asked for prompts down a channel it never opened. The host takes the channel **first** and opens the subscription only once the attach succeeded, so a refused attach leaves nothing behind. A client that already subscribed keeps the subscriptions it has, is given no second one, and keeps every one of them through a detach — the host only ever closes the subscription it opened itself, because detaching means "stop sending me prompts", not "stop sending me events". A disconnect releases both. The `host.interaction_request` events arrive on that subscription like every other event, and go to the attached connection alone — never to other clients, however many are subscribed.

**A prompt that could not be delivered fails immediately.** An ordinary event a lagging subscriber missed is recovered by re-reading, which is what the `resync_required` it was given instead is for; a prompt is not recoverable that way, because it is a question with a plugin waiting on the answer. So a `host.interaction_request` whose delivery was collapsed fails that prompt with `interaction_unavailable` at once, rather than leaving the plugin to run down the full `prompt_timeout_ms`.

**Every way a prompt can fail is typed, and none of them waits forever.** No client attached: the plugin's call rejects `interaction_unavailable` immediately, rather than hanging on a human who is not there. The holder detaches or disconnects: every prompt it had not answered fails `interaction_unavailable` at once, rather than running down its timeout against a socket that is gone. Nobody answers within `prompt_timeout_ms` (120 000): `interaction_timeout`. The plugin sees each as a rejected promise on its own error path; a prompt that fails with nobody awaiting it is attributed to the plugin in the host's error log and **never counts toward a quarantine**, because a human who closed their laptop is not evidence that a plugin is broken.

**Answering.** `choice_index` is an index into the `items` the request carried, and `cancelled: true` closes the prompt with no choice at all — the plugin's `onClose` runs and no choice handler is called. A `choice_index` outside the range of that prompt's `items` is `invalid_request`, and the prompt **stays pending** so the client can answer it properly; a `prompt_id` that names nothing still waiting — already answered, or timed out — is `interaction_unavailable`. For a `confirm` prompt the items are `["confirm", "cancel"]`: index 0 is yes and anything else, cancellation included, is no.

**`Modal.open()` on a bespoke modal is `headless_unsupported`, and is not brokered.** The suggester family is interceptable because the base class owns the rendering and the subclass supplies only `getItems`/`getItemText`/`getSuggestions`/`onChoose…` — a list of strings and an index, which is exactly what fits down a socket. A modal that builds its own UI in `onOpen()` has no such seam: it can be *constructed* (building the `contentEl` is ordinary work that must not throw) and opening it refuses, naming the actual subclass so the report says which plugin's which modal.

The plugin-config rows carry **two ratified amendments** from Task 17's fix rounds, both settled before 20b wires the handlers so the shape is frozen rather than discovered.

**A fourth refusal reason, `redacted_value`.** The brief pins three — `state_key`, `unknown_key`, `type_mismatch`. The fourth refuses the literal string `[redacted]` written back into a key the host would redact, at any depth, and it exists because the most ordinary client there is reads a config, changes one field and writes the whole thing back: without it, that saves the placeholder over the user's real token, on a file with no history. The refusal is per key like the other three, the rest of the patch still lands, and a client that really means to store `[redacted]` in an ordinary key still can.

**`redacted_keys` and a refusal's `path` are `Path = (string | number)[]`** — one segment per hop, a number for an array index (`["accounts", 0, "refreshToken"]`, `["apiAuthToken"]` for a top-level key) — rather than dotted strings. This is the daemon's own `patch_frontmatter` `key_path` grammar, chosen for the reason that grammar exists: a key name may contain a dot, so `{"a.b": {...}}` and `{"a": {"b": {...}}}` are two different documents that dot-joining spells the same way, and a client acting on a path cannot recover from the ambiguity. `refused[].key` stays the **top-level** patch key — what the caller sent, and what it would re-send — with `path` beside it naming where the reason actually is; only `redacted_value` carries one. The shapes are pinned as `ConfigPath` and `ConfigRefusal` in `host/packages/host/src/settings/plugin-config.ts`.

**Two failures in this pair are errors rather than refusal rows**, and 20b maps both to error responses: `payload_too_large` when the merged document exceeds the host's write cap, and `plugin_data_too_deep` when a document or a patch is nested deeper than 64 levels — the depth this host inspects. Neither writes anything. The second fails closed on purpose: a redactor that cannot read a document to the bottom must not serve the half it inspected.

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

**`host.enable_plugin` requires the plugin to be installed; `host.disable_plugin` does not**, and the asymmetry is deliberate: disabling something this host is still running but which is no longer in the config directory is a real need, and refusing it would leave the plugin running with no way to stop it. The cost is that a typo'd id answers `{ id, state: "disabled" }` rather than `plugin_not_found`. It broadcasts nothing, though — an id neither loaded, enabled, failed nor quarantined is a no-op, and a no-op does not announce a state change for a plugin that never existed.

The installed set is read from the config directory and cached between requests, so `host.info` on a hundred-plugin vault is not a hundred round trips. An enable, a disable, and `host.info { refresh: true }` each drop the cache; a plugin installed on disk under a running host is therefore seen at the next refresh.

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
- **Past `snapshot_session_cap` concurrent sessions, `too_many_snapshots`** — the same code the daemon answers for the same condition, so a client's retry logic is identical through either door. The cap is **per connection**, not host-wide: a host-wide one would let a single leaking client lock every peer out of hydration until it disconnected.

`limit` is **clamped** into `1..=snapshot_page_size_max` rather than refused, including `0`, which becomes `1`. That is the daemon's rule for snapshot pages and it is copied here: a hydration loop that asks for too much should page more times, not fail half way through a vault.

The cursor is opaque: a client stores it and hands it back. It carries the session it belongs to, so a cursor from one session handed to another is `invalid_cursor` rather than a page of somebody else's walk, and so is a forged one that points outside the walk.

A client disconnect closes every session that client held.

## Events

A subscription is per connection. One client may hold several; each gets its own `subscription_id` and its own copy of every event. A disconnect drops the client's subscriptions and its open snapshots.

Host events:

| Event | Value |
|---|---|
| `host.plugin_state_changed` | `{ id, state, reason }` |
| `host.notice` | `{ plugin_id, message, at_unix_ms }` |
| `host.overlap_changed` | `{ overlap, gui_enabled }` |
| `host.interaction_request` | `{ prompt_id, plugin_id, kind, prompt, items, timeout_ms }` — to the **attached** client only |

Daemon-shaped events carry their `vaultd` payloads **unchanged**: `generation_committed`, `runtime_state_changed`, `resync_required` and `config_changed`. Nothing is recomputed here, so a client correlating this door with a direct daemon subscription sees the same numbers.

```json
{"version":1,"subscription_id":"host-sub-1","event":{"type":"generation_committed","value":{"previous_generation":40,"generation":41,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["Z.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":9}}}
```

**`generation_committed` is held until this host's mirror has caught up to it.** A client of this host reads this host's view — `host.open_snapshot` serves from the mirror — so an event announcing generation N before the mirror holds N would invite a client to page a view that does not have it. The payload is the daemon's; the moment is the mirror's, and the release condition is `appliedThrough >= value.generation`. A batch that lands the mirror several generations forward releases every held commit at once, in generation order.

The delay is bounded by how long the mirror takes to apply a change it has already been told about, and it is the only reordering this door does: a client that sees `generation_committed` for N can immediately open a snapshot at N.

**A `resync_required` voids every held commit at or below the generation it names.** The resync itself is never held — it is a statement about the engine rather than about this host's view — and a subscriber told "your view is void, re-read at generation N" must not then receive a change set for generation 2: a client that applied it would move its own state *backwards*, which is the one thing the resync told it not to do. The rule holds for a relayed daemon resync and for the host's own `subscriber_lag` collapse alike. It is the same discipline the subscriber queue follows: **one message, not a prefix of the truth.**

**The held set is bounded, like every other buffer on this door.** Its bound is `subscriber_queue_limit`, the same number the subscriber queue uses, and overflow takes the same road: the held set is dropped whole and the subscriber is owed one `resync_required { reason: "subscriber_lag" }`. The condition is a mirror that has fallen a long way behind a committing daemon — a slow re-hydration, a stalled engine connection, a vault import — and a mirror that far behind is going to re-hydrate anyway, so a client being told to re-read needs none of the detail that was being held for it.

Two things about that particular collapse are worth knowing, because a client author meets them without an obvious explanation.

**It is announced once per episode, not once per overflow.** While the mirror stands still the held set fills again every `subscriber_queue_limit` commits, and saying it each time would tell a client the same true thing hundreds of times. The host says it once and stays quiet until the mirror has actually released something.

**It reaches every subscriber, including one that is reading promptly and whose own queue is empty**, and it says `subscriber_lag` — a reason that names the subscriber. The reason is accurate about who lagged, just not about which subscriber: the thing that fell behind is **this host's own view of the vault**, and the host is the daemon's lagging subscriber. Every client reads that view, so every client is told. Nothing in `vaultd`'s `ResyncReasonDto` says it more precisely, and inventing a host-only reason would give a client a code it has no handler for.

`config_changed` comes from the mirror's own seam rather than from the relay, so a raw write into the config zone is announced once rather than twice — the mirror's seam is also the one that invalidates this host's cached config, so the announcement and the invalidation cannot disagree. `runtime_state_changed` and `resync_required` pass through untouched and unheld: both are statements about the engine rather than about this host's view.

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

**A burst yields between events once a subscriber is behind.** A client reading as fast as it can still cannot drain a socket inside the turn that filled it, so a thousand events emitted in one synchronous loop would collapse a perfectly healthy reader if the host delivered them without pause. It does not: a broadcast that finds a subscriber behind hands the event loop a turn before the next event, which is what lets the socket flush and makes "behind" go away. A subscriber that is genuinely stalled stays behind however many turns it is given, so the collapse still happens for the client the bound exists for. Events are delivered in order either way.

## Dry-run

`host.hello` answers `dry_run: true` when the host was started with `--dry-run`. What that changes is an explicit list, because a mitigation nobody can enumerate is not a mitigation. It is the detector's runtime-harness backend and an evaluation tool. **It is not a sandbox**, it does not claim to be one, and a plugin determined to reach the file system through a route not on the list below will succeed — plugins run with the host's Node privileges, exactly as they do under Electron.

**Intercepted — mutations.** Nine operations — `write_note`, `write_file`, `patch_frontmatter`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note` and `delete_folder` — are recorded and **not** forwarded to the daemon, and the caller receives a synthetic success of the shape the daemon would have sent, carrying the mirror's current generation and the path's current revision. The `semantic` flag, and whether the answer carries a `generation` at all, follow the daemon's own indexability rule: a path with a dot segment anywhere in it — the `.obsidian` zone, the host's own config directory, `.trash/`, any hidden folder — answers `semantic: false` with no generation, exactly as `docs/protocol.md`'s `write_file` and `create_folder` describe. The five verbs the daemon refuses on such a path — `delete_note`, `delete_folder`, `rename_note`, `rename_folder` and `copy_file` — are refused here with `zone_violation` rather than answered, checking both ends source-first as the daemon does, and nothing is recorded for them: a recorded write means the daemon would have performed it, and it would not have. (`write_note` and `patch_frontmatter` are refused there too, but nothing in this host can address a hidden path with either — the adapter routes such a write to `write_file` and the frontmatter path takes a file the index owns.) A write into the host's config directory is recorded as `plugin_config` and everything else as `vault`, which covers both writers of a plugin's `data.json` — the plugin's own `saveData` and `host.set_plugin_config` — and the enabled set a late enable persists.

**Intercepted — a client's own requests.** A non-`host.` method you send to this host is proxied to the daemon, and that proxy goes through the same gate: under `--dry-run` your `write_note` is recorded and never lands, while your reads forward untouched. A client that wants to write for real should talk to the daemon's own socket.

**Intercepted — refusals.** `requestUrl` and `request` are refused with `dry_run_refused` (`surface: "network"`) unless the host was also started with `--dry-run-allow-network`, in which case the ordinary `--allow-network` policy governs. `electron.shell.openPath`, `showItemInFolder` and `openExternal` are refused with `surface: "os_bridge"`. A plugin bundle's `require` of thirteen node builtins is refused with `surface: "node_builtin"` — **each in both its bare and its `node:`-prefixed spelling**, since the two are one module: `fs`, `fs/promises`, `child_process`, `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`, `worker_threads`, `vm` and `inspector`. **That last surface is not yet armed in any shipped configuration:** the module patch that performs it has no production caller until the host binary passes `allowNodeBuiltins: !config.dryRun`, so today only the host's own `module-intercept` test wires it. Treat `node_builtin` as specified and tested, not as currently enforced.

Notices are recorded, but in **every** mode — `host.invoke_command` reports them whether or not the host is pretending.

**Not intercepted, by design.** Every read path, every timer, and CPU. A dry run reads the real vault and the real settings, because the question it answers is what a plugin would do to the files that are actually there — and a change somebody else makes still reaches this host's mirror, so dry-run is not read isolation either. `localStorage` is **not** intercepted: the host persists it into its own data directory rather than into the vault, and a dry run writes it for real, which matters because plugins commonly keep state there. And any route to the file system that is not on the intercepted list — a bundle running with this host's Node privileges can still reach the disk, exactly as it can under Electron.

**What a dry run pretends instead — the overlay.** Nothing is written, so the mirror does not move; the host keeps a second, smaller structure beside it so that a run composes. Every recorded mutation lands there: `write_note`, `write_file` and the two adapter writes record the bytes; `create_folder` and `mkdir` record a folder; `copy_file` and the two renames add the destination (and, for a folder, everything under it) with the source's bytes; `delete_note`, `delete_folder`, `remove` and both trashes record a removal that covers the whole subtree. A plugin that creates, copies or renames a path and then uses the `TFile` or `TFolder` that call answered with gets a real one, in the tree, visible to `getAbstractFileByPath`, `getFiles`, `getMarkdownFiles` and its parent's `children`; a plugin that writes and then reads gets its own bytes, so several writes to one path compose; and the synthetic revision an answer carried is the one the next write to that path states as its precondition. `Plugin.loadData` after a dry-run `saveData` returns what was saved.

**Its precedence is one rule: removed, then overlay bytes, then the mirror.** A path this run removed reads as gone — `not_found`, the daemon's own code and message — however solidly it sits on disk, and so does everything under it; its node also leaves its parent's `children` and every listing, so no surface still offers a file the others deny. The **one exception** to the rule is a collision: if the daemon really produces a row at a path this run only *invented* — the user's own Obsidian creating today's note while a periodic-notes plugin is being evaluated — the pretend file gives way to the real one everywhere at once, so `getAbstractFileByPath`, `getFiles`, the parent's `children`, `adapter.exists`, `adapter.stat` and `read` all describe the daemon's file. A path the run merely *modified* is not a collision and keeps answering the run's own bytes; that is read-your-writes.

**What consults the overlay, and what does not.** `app.vault`'s reads and its file tree, `vault.adapter`'s `read`, `readBinary`, `append`, `exists`, `stat` and `list`, `Plugin.loadData`, and the host's own read of a plugin's `data.json` — so `host.get_plugin_config` sees a plugin's dry-run `saveData`, and `host.set_plugin_config`'s read-modify-write merges over that save rather than erasing it. Four things the overlay deliberately does *not* do. **Nothing is written into the mirror**, so a row the daemon never produced cannot reach the metadata cache, link resolution or your snapshots, and cannot fight the next resync. **Metadata stays the mirror's**: `getFileCache` of an overlay-only file is `null` and of a modified one is the daemon's cached metadata, stale by design, because a dry run does not re-parse its own bytes (a synthetic node's `stat` carries the recorded byte length and zero times for the same reason). **No vault events fire for synthetic writes** — `create`, `modify`, `rename` and `delete` come from a mirror batch, and the mirror does not move. And **`patch_frontmatter` records no bytes**, because the host sends key-path patches rather than a serialized note, so a read after a dry-run frontmatter patch is the pre-patch text. One smaller gap, named rather than papered over: the host enumerates installed plugins with `read_dir`, which is the daemon's own listing, so a plugin folder a dry run "created" is not an installed plugin. The overlay is cleared with the rest of the run's records.

## Errors

The host's codes, **additive to `vaultd`'s** — a forwarded operation's refusal is the daemon's, unchanged:

`host_not_ready`, `plugin_not_found`, `plugin_not_installed`, `plugin_quarantined`, `command_not_found`, `menu_item_not_found`, `protocol_handler_not_found`, `headless_unsupported`, `overlap_refused`, `config_key_refused`, `interaction_unavailable`, `interaction_timeout`, `dry_run_refused`, `not_owner`, `snapshot_not_found`.

Daemon codes the host also answers on its own behalf: `incompatible_version` (a `version` that is not `1`, carrying `supported_version`), `invalid_request` (a malformed request on an authenticated connection, or a `host.` method this build does not have), `invalid_cursor` (a snapshot cursor this host did not issue, or one from another session), `generation_mismatch` and `too_many_snapshots` (snapshot sessions, above), `subscription_not_found` (`host.unsubscribe` for an id this connection does not hold), `not_found` (a path that names nothing), and `internal` (a plugin's own code threw — the message names the command and the failure is counted against that plugin's quarantine).

Input with no usable envelope is a fatal input error: there is no `id` to echo, so there is no way to say which request it was about, and the connection is closed. See *Envelope* above for exactly which lines those are.

A refusal never takes the host down. Every request line is handled behind its own catch, so a bug in the dispatcher becomes a refusal on that connection rather than a rejected promise; and a process-level guard catches an unhandled rejection from anywhere else, reports it through the host's error seam under the host's own id, and keeps the host serving. Node's default is to terminate the process for one stray promise, which for this host means every loaded plugin, every subscription and every other client.

**That guard is process-wide, and a process embedding this host inherits it**: Node suppresses its default exit as soon as *any* `unhandledRejection` listener exists, so while a host is open the embedding process no longer exits on an unhandled rejection — including one raised by code that has nothing to do with the host, which reaches the host's error seam attributed to the host rather than to any plugin. The guard is refcounted and removes only its own listener, so closing the last host restores whatever policy the process had before.
