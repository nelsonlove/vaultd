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

Three further rules follow from it.

**Before authentication, anything that is not a well-formed `host.hello` carrying the nonce is `not_owner`, and the connection is destroyed.** Not only a wrong nonce: a missing `request`, a method that is not a string, params that are not an object, a different method entirely. There is nothing to guess — the nonce is 32 random bytes — so a peer that got it wrong is either a bug or a probe, and neither is owed a retry on that connection. One refusal is the most an unauthenticated peer is ever told, and a line with no usable envelope (above) is told nothing at all.

**A peer that says nothing is closed too: a handshake deadline and an accept cap.** The rule above answers a peer that speaks. A peer that connects and then holds the socket open in silence was reached by none of it, and it costs a connection slot, a read buffer and a connection object for as long as it cares to — one of each per socket, for a peer opening them in a loop. So a connection that has not presented a well-formed `host.hello` within `handshakeTimeoutMs` (5 s) is closed, **with no reply**: the peer sent no request, and a host that wrote something back would be telling a silent peer the socket is there. And no more than `maxPreAuthConnections` (16) connections may sit unauthenticated at once — past the cap the **newest** is closed the moment it is accepted, because an older pre-auth connection may be a real client mid-handshake while the newest is the marginal socket of whoever is flooding. Both closes are counted in one server diagnostic: which bound caught the peer changes nothing about what it was. Both timers are on the host's injected clock, like every other duration here (`test/server-security.test.ts`).

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

Every field below is `snake_case`. The **Task** column says which task implements the row.

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
| `host.get_plugin_config` | `{ id, reveal_secrets?: bool }` | `{ id, values, schema: { source, items }, redacted_keys: Path[], state_keys }` | 20b |
| `host.set_plugin_config` | `{ id, patch: Record<string, unknown> }` | `{ id, applied: string[], refused: { key, reason, path?: Path }[] }` | 20b |
| `host.compat_report` | `{ plugin_id?: string }` | `{ report: CompatReport }` | 20b |
| `host.attach_interaction` | `{}` | `{ attached: bool }` | 18 |
| `host.detach_interaction` | `{}` | `{ attached: bool }` | 18 |
| `host.respond_interaction` | `{ prompt_id, choice_index?: number, value?: string, cancelled?: bool }` | `{ prompt_id }` | 18 |
| `host.list_interactions` | `{}` | `{ pending: InteractionRequest[] }` | 20b |

The last seven rows need a service the server is handed rather than one it builds: the interaction broker, the plugin config service and the compatibility detector. Until the host has been given the one an operation needs, that operation answers `host_not_ready` **naming that service** — a typed, documented state rather than a missing method. The services themselves are Tasks 18, 17 and 20; 20b is where they reach the socket.

`host.invoke_command`'s `selection` is a range — `{ from: { line, ch }, to: { line, ch } }`, both fields zero-based — rather than a string. **This is a ratified deviation from the phase brief's pinned table**, which spells the row `selection?: string`: an `editorCallback` is handed an `Editor`, whose `setSelection` takes two positions, so a string would have to be *searched* for in the note — a different operation, with a different failure mode (no match, several matches) and a different answer for each. The controller ratified the range in Task 16a's fix round and the brief's table is amended to match. A client that sends a string is told so by name rather than having it silently ignored. The shape is pinned as `SelectionWire` in `host/packages/host/src/server/wire.ts`.

### Interaction, and the one-holder rule

**One client holds the interaction channel at a time, and holding it is what makes prompts reachable.** A plugin that opens a `SuggestModal` or a `FuzzySuggestModal`, or calls `FileManager.promptForDeletion`, raises a question the host has no window to ask — so the host asks whoever attached. `host.attach_interaction` takes the channel; while it is held, a second client asking is refused `interaction_unavailable` naming the connection that holds it, rather than silently taking prompts away from the client a human is looking at. `host.detach_interaction` releases it, and a client that disconnects releases it implicitly.

**Attaching opens a subscription if the connection holds none, and detaching closes exactly that one.** An event reaches a client through its subscriptions and nowhere else, so a client that attached without subscribing would have asked for prompts down a channel it never opened. The host takes the channel **first** and opens the subscription only once the attach succeeded, so a refused attach leaves nothing behind. A client that already subscribed keeps the subscriptions it has, is given no second one, and keeps every one of them through a detach — the host only ever closes the subscription it opened itself, because detaching means "stop sending me prompts", not "stop sending me events". A disconnect releases both. The `host.interaction_request` events arrive on that subscription like every other event, and go to the attached connection alone — never to other clients, however many are subscribed.

**A prompt that could not be delivered fails immediately.** An ordinary event a lagging subscriber missed is recovered by re-reading, which is what the `resync_required` it was given instead is for; a prompt is not recoverable that way, because it is a question with a plugin waiting on the answer. So a `host.interaction_request` whose delivery was collapsed fails that prompt with `interaction_unavailable` at once, rather than leaving the plugin to run down the full `prompt_timeout_ms`.

**A client treats `resync_required` as "re-ask what is pending".** The collapse drops the queue whole, so a prompt event may be among what went with it — and the prompt it announced is not necessarily gone: the one that was in flight when the queue collapsed was failed, but a prompt raised after the collapse and before the client caught up is still waiting for an answer. `host.list_interactions` answers what the broker is still holding, in the same shape the event carries, and it is what an attached client should call after any `resync_required` rather than waiting for an event that has already been sent. It reads rather than answers, so any authenticated session may call it; only the holder can answer a prompt.

**Every way a prompt can fail is typed, and none of them waits forever.** No client attached: the plugin's call rejects `interaction_unavailable` immediately, rather than hanging on a human who is not there. The holder detaches or disconnects: every prompt it had not answered fails `interaction_unavailable` at once, rather than running down its timeout against a socket that is gone. Nobody answers within `prompt_timeout_ms` (120 000): `interaction_timeout`. The plugin sees each as a rejected promise on its own error path; a prompt that fails with nobody awaiting it is attributed to the plugin in the host's error log and **never counts toward a quarantine**, because a human who closed their laptop is not evidence that a plugin is broken.

**Answering.** `choice_index` is an index into the `items` the request carried, and `cancelled: true` closes the prompt with no choice at all — the plugin's `onClose` runs and no choice handler is called. A `choice_index` outside the range of that prompt's `items` is `invalid_request`, and the prompt **stays pending** so the client can answer it properly; a `prompt_id` that names nothing still waiting — already answered, or timed out — is `interaction_unavailable`. For a `confirm` prompt the items are `["confirm", "cancel"]`: index 0 is yes and anything else, cancellation included, is no.

**`Modal.open()` on a bespoke modal is `headless_unsupported`, and is not brokered.** The suggester family is interceptable because the base class owns the rendering and the subclass supplies only `getItems`/`getItemText`/`getSuggestions`/`onChoose…` — a list of strings and an index, which is exactly what fits down a socket. A modal that builds its own UI in `onOpen()` has no such seam: it can be *constructed* (building the `contentEl` is ordinary work that must not throw) and opening it refuses, naming the actual subclass so the report says which plugin's which modal.

### Plugin configuration

**`reveal_secrets: true` needs an authenticated session, which every session on this socket is.** The nonce gate authenticates a connection before its first operation is dispatched, over a socket in a `0700` directory this user owns, so the requirement is a statement of fact about this door rather than a second check the host performs. What the flag changes is only the rendering: the credential comes back in plaintext and `redacted_keys` still names it, because a caller holding plaintext is exactly the one that needs to know which of the values it is holding are credentials.

**`schema.source` is the enum, never a sentence.** `none` crosses as `none`, and it means **not yet described** — the ladder was never climbed for this plugin, or the plugin is installed and not loaded — and never "this plugin has no settings", which is a different fact this host cannot see. A source of `none` also refuses nothing: with no schema to contradict, `unknown_key` is not raised, because a host that knows nothing must not pretend a key is invented merely because it could not read the schema.

**An id that is not installed at all is `plugin_not_installed`**, on all three of `host.get_plugin_config`, `host.set_plugin_config` and `host.compat_report { plugin_id }`. Installed is the test — the plugin is a folder with a `manifest.json` under the config directory — and *loaded* is a separate question the next paragraph answers. This is what tells a client a typo apart from a plugin that is switched off: without it, every string answered a plausible-looking empty configuration, and a `set` on a misspelled id **created** `plugins/<id>/data.json` for it — a stray file in the config zone that nothing would ever read.

**A plugin that is installed but not loaded cannot be configured beyond that.** The schema is keyed by the plugin's version, and the only version this host can read today comes from `app.plugins` — which knows the plugins it is running. So a disabled plugin serves `source: "none"` with no items, every write to it is type-checked against nothing, and the state keys the registry names are still refused. Closing that gap is a `manifest.json` read through the daemon, and it belongs to the task that assembles the real host rather than to the socket wiring.

The plugin-config rows carry **two ratified amendments** from Task 17's fix rounds, both settled before 20b wired the handlers so the shape is frozen rather than discovered.

**A fourth refusal reason, `redacted_value`.** The brief pins three — `state_key`, `unknown_key`, `type_mismatch`. The fourth refuses the literal string `[redacted]` written back into a key the host would redact, at any depth, and it exists because the most ordinary client there is reads a config, changes one field and writes the whole thing back: without it, that saves the placeholder over the user's real token, on a file with no history. The refusal is per key like the other three, the rest of the patch still lands, and a client that really means to store `[redacted]` in an ordinary key still can.

**`redacted_keys` and a refusal's `path` are `Path = (string | number)[]`** — one segment per hop, a number for an array index (`["accounts", 0, "refreshToken"]`, `["apiAuthToken"]` for a top-level key) — rather than dotted strings. This is the daemon's own `patch_frontmatter` `key_path` grammar, chosen for the reason that grammar exists: a key name may contain a dot, so `{"a.b": {...}}` and `{"a": {"b": {...}}}` are two different documents that dot-joining spells the same way, and a client acting on a path cannot recover from the ambiguity. `refused[].key` stays the **top-level** patch key — what the caller sent, and what it would re-send — with `path` beside it naming where the reason actually is; only `redacted_value` carries one. The shapes are pinned as `ConfigPath` and `ConfigRefusal` in `host/packages/host/src/settings/plugin-config.ts`.

**`host.set_plugin_config` answers when the file is written, not when the plugin has been told.** Afterwards the host calls the plugin's `onExternalSettingsChange` if it defines one, through the dispatch queue like every other plugin entry point — and the queue is strict FIFO, so a plugin that is already busy makes that call wait. The write is the contract and it is durable before the answer is sent; telling the plugin is the host's errand, and a handler that throws is reported as that plugin's failure rather than as a failed write. A client that needs to know the plugin has re-read has to ask the plugin, not this operation.

**Two failures in this pair are errors rather than refusal rows**: `plugin_data_too_large` when the merged document exceeds the host's write cap, and `plugin_data_too_deep` when a document or a patch is nested deeper than 64 levels — the depth this host inspects. Neither is attributable to one key, which is what a refusal row is for: the first is a fact about the whole file and the second is a walk that did not finish. Neither writes anything, so the file on disk is still the one the plugin last saved. The second fails closed on purpose: a redactor that cannot read a document to the bottom must not serve the half it inspected, so `host.get_plugin_config` raises it too. Both carry `plugin_id`, and `plugin_data_too_deep` carries the `path` the walk gave up at.

### The compatibility report

`host.compat_report` is thin over the detector and scrubbed on the way out. **No `tab`** — a harvested setting tab carries the plugin's live `PluginSettingTab`, and nothing in this report reaches one — **no live object of any kind**, and **no configuration values**: the report says which rung of the ladder described a plugin's settings and never what those settings are. A compatibility report is a description of a plugin, never a copy of its settings; `host.get_plugin_config` is where a caller asks for those, by name.

**`verdict` is one of `runs`, `degrades`, `fails`, `unknown`, and it is never asserted** — `scan.tier_reasons` and the harness's own rows are what a reader argues with. `fails` is "it did not load"; `degrades` is "it loaded, and something it reached for is not here or cannot be reached headlessly"; `runs` is the rest. `unknown` is the narrowest: a harness was **attempted and refused** — the plugin is quarantined, or the probe itself failed — and the row says why in `notes`.

**`harness_attempted` sits beside it because `harness: null` means two different things.** `false` is "this host is not in dry-run, so nothing was tried", and the verdict is then the tier estimate mapped rather than invented: tiers 1 and 2 read `runs`, 3 and 4 read `degrades`, and never `fails`, because nothing was run. `true` with a null harness is "the attempt was refused", which is `unknown`. Without the discriminator a client cannot tell the two apart, and a quarantined plugin would read green.

**`harness.harness_limits` is what the run could not see, and `harness.refusals` is what the dry run declined.** They are separate facts and both are needed: a run against an already-loaded plugin records nothing it did at load time and says so in the limits — its `calls`, `throws` and `writes` are empty for that reason and not because the plugin touched nothing — while a refusal is a network call or an OS bridge this run would not perform, which means a plugin whose one job is to fetch has not really been exercised. A refusal never moves a verdict: the same call succeeds on the same host with the flag off.

**A recorded write carries no bytes.** `harness.writes` says *that* the plugin wrote, with the verb and whether it landed in the vault or in the config zone; the body is the dry-run log's and does not cross this door, because a report carrying it would be the copy of the settings this report exists not to make.

**A `network` refusal's `detail` crosses as origin plus path.** It is the address the plugin asked for, and a plugin that hands a stored token to `requestUrl` puts that token in the query string — so the query, the fragment and any userinfo are dropped, and `https://api.example/v1/sync?key=…` crosses as `https://api.example/v1/sync`. That is the reading a report is for: *which host did this plugin want, and for what*. Other surfaces — a node builtin's name, an OS bridge's channel — cross unchanged, as does a detail this host cannot parse as a URL. Note the limit of the promise this makes: `load_error` and `calls[].threw` are **plugin-authored message strings**, and a plugin that puts a credential in an exception message puts it on this report. This host redacts what it reads out of a plugin's settings; it cannot redact what a plugin writes into its own prose.

**A probe the host refused reads `unknown`, never `fails`.** A plugin the host would not start — quarantined, or asked about before the lifecycle was steady — was declined before its code ran, so the row carries the refusal as a note and no verdict about running it. `fails` means the plugin's own `onload` did not work.

A `plugin_id` reports one plugin; omitting it reports every installed one. **One plugin's refusal is one row's, never the report's** — a host holding a quarantined plugin is exactly the host an operator wants a report from, so the refusal becomes a sentence in that row's `notes` and the walk goes on.

### Readiness

`host.hello`, `host.info`, `host.list_plugins` and `host.subscribe` answer from the moment the socket is up: a client that has just connected needs to be able to ask what is going on *because* something is wrong. Every operation that needs a loaded plugin set — the command, menu, protocol and plugin operations — answers `host_not_ready` until the lifecycle sequencer reports `steady`. The snapshot operations do not wait, because the mirror is hydrated before the host starts.

**`host.compat_report` and `host.set_plugin_config` need `steady` too, and `host.get_plugin_config` does not.** A report before `steady` describes nothing: the detector cannot load a plugin to probe it, so every row under `--dry-run` read `fails` about plugins in perfect health. A write before `steady` races the startup beside it — one that lands before a plugin's own `loadData` silently changes what that plugin loads with, and the `onExternalSettingsChange` that follows queues behind the plugin's in-flight `onload`. Reading a settings document, by contrast, is well defined at every phase: it is a file, and `host.get_plugin_config` answers it whenever it is asked.

`host.attach_interaction`, `host.detach_interaction`, `host.respond_interaction` and `host.list_interactions` do not wait either — a client attaches before anything can prompt it, which is the point of attaching.

`host_not_ready` is a typed, documented state rather than a crash or a missing method.

### Shapes

```ts
PluginState { id, name, version, state: "loaded"|"disabled"|"failed"|"quarantined", load_ms: number|null, failure_count: number, reason: string|null }
Command     { plugin_id, id, local_id, name, icon: string|null, kind, hotkeys: { modifiers: string[], key: string }[] }
MenuItem    { hook_id, plugin_id, id, title, icon: string|null, section: string|null, checked: boolean|null }
Overlap     { host_enabled: string[], gui_enabled: string[], overlap: string[], forced: string[], gui_readable: bool, checked_at_ms, overlap_poll_ms }
Timer       { plugin_id, interval_ms: number|null, created_at: number }
PolicyUse   { symbol, policy: "implemented"|"harvested"|"safe_stub"|"absent"|"absent_field", plugin_id: string|null, hits: number }
Counters    { generation: number, applied_through: number, resync_count: number,
              resyncs_by_reason: { [reason]: number }, resyncing: bool,
              last_resync_reason: string|null, notices: number, quarantined: string[],
              snapshot_sessions: number, pending_batches: number }

Path        (string | number)[]
SchemaItem  { key, control, name?, description?, default_value?, options?: { value, label }[] }
InteractionRequest { prompt_id, plugin_id, kind, prompt, items: string[], timeout_ms }

CompatReport { generated_at_unix_ms, plugins: CompatRow[] }
CompatRow    { id, version, scan: Scan, harness: Harness|null, schema_source, verdict: "runs"|"degrades"|"fails"|"unknown", harness_attempted: bool, notes: string[] }
Scan         { plugin_id, minified, bytes, api_symbols: Tally[], generic_symbols: Tally[],
               lifecycle_gates: { on_layout_ready, layout_ready_read, metadata_resolved, metadata_resolve },
               registrations: Tally[], command_ids: string[], event_names: string[], frameworks: string[],
               cross_plugin: string[], internal_plugins: string[], requires_electron: bool,
               requires_node: string[], tier_estimate: 1|2|3|4, tier_reasons: string[] }
Tally        { symbol, hits }
Harness      { plugin_id, loaded, load_error: string|null, calls: Call[], throws: Call[],
               writes: { kind: "vault"|"plugin_config", method, plugin_id, at_unix_ms }[],
               refusals: { surface, detail }[],
               harvest: { commands, menu_hooks, protocol_handlers, unreachable },
               harness_limits: string[] }
Call         { symbol, plugin_id, policy: "implemented"|"harvested"|"safe_stub"|"absent"|"absent_field", threw: string|null, at_unix_ms }
```

**The scan's tallies are rows, not objects keyed by symbol name.** `api_symbols`, `generic_symbols` and `registrations` count Obsidian's own members — `getFileCache`, `onLayoutReady` — and an object keyed by those names would put `camelCase` *keys* on a socket whose one rule is that it has none. As `{ symbol, hits }` rows the symbol is a value, which is what it is: the plugin's evidence, not this host's field name. The rows keep the order the scanner found them in.

`values` in `host.get_plugin_config` is the **plugin's own document**, so its keys are the plugin author's spelling (`taskTag`, `myApiKey`) and are never converted — renaming them would rename a user's settings. The `snake_case` rule governs the fields this host names.

`version` is the empty string for a plugin whose manifest this host cannot read — unknown rather than invented, because a version nobody verified should not be printed as though it were `0.0.0`.

**`host.info`'s other three substructures, field by field.** They are the host's own instrumentation rather than a plugin's evidence, and a client reads them to answer "is this host healthy and what is it carrying".

`timers` is one `Timer` row per interval a plugin registered through `Plugin.registerInterval`, in registration order. A plugin's rows go when the plugin does: unloading or quarantining it drops everything it registered, so the list is what the plugins loaded right now have armed — the idle-cost census of a running host. `plugin_id` is the registering plugin. `interval_ms` is the cadence, and is `null` — never `0` — when the timer was armed outside the shim's own `window.setInterval` and there is no cadence to read back; `0` would read as a timer firing as fast as the loop allows, which is the one shape a census must not invent. `created_at` is the host clock's reading when the registration happened, which is `Date.now()` under the real clock.

`unsupported` is one `PolicyUse` row per `(symbol, plugin)` pair whose policy is `absent` — the policy recorder's tally, filtered. It is what plugins **reached for and were refused**, so a symbol nobody touched is not in it however absent it is, and `hits` is the number of times that plugin hit that symbol. `plugin_id` is `null` for a hit made outside any plugin's window. `absent_field` rows never appear here: a field read has no call site to record from, and counting one as a refusal is exactly what the fifth policy kind exists to prevent.

`counters` is a flat object of host state, every field a plain number, boolean, string or array:

- `generation` — the highest daemon generation any row in the mirror was fetched at.
- `applied_through` — the highest generation whose change set has been applied. Never above `generation`, and often below it while a fetch is in flight.
- `resync_count` — how many re-hydrations this mirror has actually run, for any reason. Two requests folded into one run count once, and a run that found the vault exactly as the mirror already held it still counts.
- `resyncs_by_reason` — the same total split by reason, as an object keyed by the reason name (`subscriber_lag`, `oversized_change_set`, `runtime_recovered`, `watcher_overflow`, `root_invalidated`, and the mirror's own `apply_failed`, `generation_gap`, `refetch_oversized`). A reason that has never fired is absent rather than `0`. The keys are reason names, which are values the daemon and the mirror both spell in `snake_case`, so the no-`camelCase` rule is unaffected.
- `resyncing` — whether a resync is marked or running right now. It goes true the moment one is asked for and false when the last one finishes with none queued behind it.
- `last_resync_reason` — the reason of the most recent run, or `null` if there has never been one. Overwritten by the next run, which is why the split above exists.
- `notices` — how many entries the notice log holds (`new Notice(...)` from any plugin).
- `quarantined` — the ids of plugins the quarantine is holding, as an array.
- `snapshot_sessions` — open snapshot sessions across every client, not only the asking one.
- `pending_batches` — mirror batches buffered because the host has not reached `steady` yet. It drains to `0` at `steady`; a number that keeps climbing on a started host is the signal that something never finished starting.

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

**`host.enable_plugin` requires the plugin to be installed; `host.disable_plugin` does not**, and the asymmetry is deliberate: disabling something this host is still running but which is no longer in the config directory is a real need, and refusing it would leave the plugin running with no way to stop it. The cost is that a typo'd id answers `{ id, state: "disabled" }` rather than the `plugin_not_installed` an enable would give it. It broadcasts nothing, though — an id neither loaded, enabled, failed nor quarantined is a no-op, and a no-op does not announce a state change for a plugin that never existed.

The installed set is read from the config directory and cached between requests, so `host.info` on a hundred-plugin vault is not a hundred round trips. An enable, a disable, and `host.info { refresh: true }` each drop the cache; a plugin installed on disk under a running host is therefore seen at the next refresh.

`host.subscribe` (`test/server-subscriptions.test.ts`):

```json
{"version":1,"id":"8","request":{"method":"host.subscribe","params":{}}}
{"version":1,"id":"8","outcome":{"status":"ok","value":{"type":"host.subscribe","value":{"subscription_id":"host-sub-1","generation":1}}}}
```

`host.get_plugin_config` (`test/server-wiring.test.ts`), against a plugin whose `data.json` holds `{"taskTag":"task","myApiKey":"s3cret"}`:

```json
{"version":1,"id":"9","request":{"method":"host.get_plugin_config","params":{"id":"demo"}}}
{"version":1,"id":"9","outcome":{"status":"ok","value":{"type":"host.get_plugin_config","value":{"id":"demo","values":{"taskTag":"task","myApiKey":"[redacted]"},"schema":{"source":"none","items":[]},"redacted_keys":[["myApiKey"]],"state_keys":[]}}}}
```

`myApiKey` is withheld by the **name-shaped fallback** rather than by the key registry — the registry is the first authority and the name test is the second, and the second only ever *adds* redaction, because the failure of a hand-maintained list is always the key nobody added to it. With `"reveal_secrets": true` the same request answers `"myApiKey":"s3cret"` and `redacted_keys` is unchanged.

`host.set_plugin_config` (`test/server-wiring.test.ts`) — the placeholder written back is refused with the path it was found at, and the rest of the patch still lands:

```json
{"version":1,"id":"10","request":{"method":"host.set_plugin_config","params":{"id":"demo","patch":{"taskTag":"todo","myApiKey":"[redacted]"}}}}
{"version":1,"id":"10","outcome":{"status":"ok","value":{"type":"host.set_plugin_config","value":{"id":"demo","applied":["taskTag"],"refused":[{"key":"myApiKey","reason":"redacted_value","path":["myApiKey"]}]}}}}
```

A patch nested past 64 levels, or one whose merged document is over the write cap, is an error rather than a row — and writes nothing:

```json
{"version":1,"id":"11","outcome":{"status":"err","value":{"plugin_id":"demo","path":["nest","down","down"],"code":"plugin_data_too_deep","message":"this settings document is nested deeper than 64 levels, …"}}}
```

`host.compat_report` (`test/server-wiring.test.ts`), on a host that is **not** in dry-run — so nothing was attempted, `harness` is `null`, and the verdict is the tier estimate mapped:

```json
{"version":1,"id":"12","request":{"method":"host.compat_report","params":{"plugin_id":"demo"}}}
{"version":1,"id":"12","outcome":{"status":"ok","value":{"type":"host.compat_report","value":{"report":{"generated_at_unix_ms":1700000000000,"plugins":[{"id":"demo","version":"0.0.0","scan":{"plugin_id":"demo","minified":false,"bytes":0,"api_symbols":[],"generic_symbols":[],"lifecycle_gates":{"on_layout_ready":0,"layout_ready_read":0,"metadata_resolved":0,"metadata_resolve":0},"registrations":[],"command_ids":[],"event_names":[],"frameworks":[],"cross_plugin":[],"internal_plugins":[],"requires_electron":false,"requires_node":[],"tier_estimate":1,"tier_reasons":["no bundle source to scan (not_found: .obsidian-headless/plugins/demo/main.js does not exist): the tier is a default, not a finding"]},"harness":null,"schema_source":"none","verdict":"runs","harness_attempted":false,"notes":["harness not run: this host is not in dry-run"]}]}}}}}
```

`host.list_interactions` (`test/server-wiring.test.ts`), while one prompt is waiting — the rows are the `host.interaction_request` shape exactly, so a client that lost the event needs no second decoder:

```json
{"version":1,"id":"13","request":{"method":"host.list_interactions","params":{}}}
{"version":1,"id":"13","outcome":{"status":"ok","value":{"type":"host.list_interactions","value":{"pending":[{"prompt_id":"prompt-1","plugin_id":"picker","kind":"fuzzy_suggest","prompt":"Picker","items":["Alpha","Beta"],"timeout_ms":120000}]}}}}
```

Once the prompt is answered it is gone: `{"pending":[]}`.

`host.attach_interaction` and `host.detach_interaction` (`test/server-wiring.test.ts`) — the second client is refused by name while the first holds the channel:

```json
{"version":1,"id":"14","request":{"method":"host.attach_interaction","params":{}}}
{"version":1,"id":"14","outcome":{"status":"ok","value":{"type":"host.attach_interaction","value":{"attached":true}}}}
{"version":1,"id":"15","outcome":{"status":"err","value":{"code":"interaction_unavailable","message":"host-conn-1 already holds the interaction channel; it has to detach (or disconnect) before another client can answer prompts"}}}
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

## The binary

`vaultd-host --vault <path>` brings a host up and binds the socket this document describes. Its flags are `--config-dir`, `--socket`, `--vaultd`, `--dry-run`, `--dry-run-allow-network`, `--force-shared <id>` (repeatable) and `-h`/`--help`; `--vault` is resolved to an absolute path, because it is both the daemon's argument and the key the default socket path's digest comes from. One machine-readable line goes to stdout when the host is ready — `{"ready":true,"socket":…,"vault":…,"dry_run":…,"loaded":[…],"failed":[…]}` — so whatever started the host knows where to knock without recomputing that digest.

**Exit codes are a contract.** `0` a clean shutdown on `SIGINT` or `SIGTERM`; `2` a usage error; `3` the daemon was unreachable (it did not start, or never reached `watching`); `4` the config directory was refused — either `--config-dir .obsidian`, which is the GUI's own and is never shared, or a startup where the GUI has every enabled plugin open too and there was nothing left to run. The overlap case is decided from the coexistence monitor's typed report, never from the text of a failure message.

**Shutdown is ordered, and the order is a correctness property.** The globals this host installs are process-wide and a plugin's in-flight work reads them, so: plugins unloaded → the dispatch queue drained → the socket closed → the mirror stopped → the watchdog joined → and only then the globals restored, which disarms every timer this host's `window` handed out. A plugin parked on a timer therefore never wakes into a process that no longer has a `window`.

**One residue, documented rather than guarded.** The drain is bounded (5 s). Work that outlives it — a plugin holding a promise of its own, on a scheduler this host does not own — runs on after the globals are back, and by then neither the server's own process-wide rejection guard nor the binary's shutdown-window reporter is still armed. Such a rejection can turn an otherwise clean shutdown into exit `1`. A blanket swallow would hide the same class of failure during the run, where it is a real defect, so the limit is stated instead of hidden.

**Creating a folder at the vault root while the watcher is live can cost you the engine, and the host's own config directory is such a folder.** A host started against a vault that has no `.obsidian-headless/` yet makes one, at the root, under a daemon that is already watching. The daemon answers that with `resync_required { watcher_overflow }` — a root-level create is exactly the event its watcher cannot describe as a per-path delta — and the resync occasionally ends with the supervisor replacing the engine, at which point any call in flight fails with `no engine is running`. The same happens for any other root-level folder a plugin creates early, `Journal/` among them. **This is daemon behaviour and nothing here changes it:** the host does not special-case the create, and the resync road it takes is the correct one. What the host's own tests do instead is pre-create the directory before the daemon starts, which is the mitigation available to an operator too — make the config directory (or run the host once and let it fail) before the run that matters. Closing this properly means the host half of a root-level-create engine replacement becoming a typed resync road under the supervisor's contract rather than a bare `no engine is running`, which is named as a finding and not done here.

## Dry-run

`host.hello` answers `dry_run: true` when the host was started with `--dry-run`. What that changes is an explicit list, because a mitigation nobody can enumerate is not a mitigation. It is the detector's runtime-harness backend and an evaluation tool. **It is not a sandbox**, it does not claim to be one, and a plugin determined to reach the file system through a route not on the list below will succeed — plugins run with the host's Node privileges, exactly as they do under Electron.

**Intercepted — mutations.** Nine operations — `write_note`, `write_file`, `patch_frontmatter`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note` and `delete_folder` — are recorded and **not** forwarded to the daemon, and the caller receives a synthetic success of the shape the daemon would have sent, carrying the mirror's current generation and the path's current revision. The `semantic` flag, and whether the answer carries a `generation` at all, follow the daemon's own indexability rule: a path with a dot segment anywhere in it — the `.obsidian` zone, the host's own config directory, `.trash/`, any hidden folder — answers `semantic: false` with no generation, exactly as `docs/protocol.md`'s `write_file` and `create_folder` describe. The five verbs the daemon refuses on such a path — `delete_note`, `delete_folder`, `rename_note`, `rename_folder` and `copy_file` — are refused here with `zone_violation` rather than answered, checking both ends source-first as the daemon does, and nothing is recorded for them: a recorded write means the daemon would have performed it, and it would not have. (`write_note` and `patch_frontmatter` are refused there too, but nothing in this host can address a hidden path with either — the adapter routes such a write to `write_file` and the frontmatter path takes a file the index owns.) A write into the host's config directory is recorded as `plugin_config` and everything else as `vault`, which covers both writers of a plugin's `data.json` — the plugin's own `saveData` and `host.set_plugin_config` — and the enabled set a late enable persists.

**Intercepted — a client's own requests.** A non-`host.` method you send to this host is proxied to the daemon, and that proxy goes through the same gate: under `--dry-run` your `write_note` is recorded and never lands, while your reads forward untouched. A client that wants to write for real should talk to the daemon's own socket.

**Intercepted — refusals.** `requestUrl` and `request` are refused with `dry_run_refused` (`surface: "network"`) unless the host was also started with `--dry-run-allow-network`, in which case the ordinary `--allow-network` policy governs. `electron.shell.openPath`, `showItemInFolder` and `openExternal` are refused with `surface: "os_bridge"`. A plugin bundle's `require` of thirteen node builtins is refused with `surface: "node_builtin"` — **each in both its bare and its `node:`-prefixed spelling**, since the two are one module: `fs`, `fs/promises`, `child_process`, `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`, `worker_threads`, `vm` and `inspector`. **Armed since Task 22:** the host builder (`src/host.ts`, which both the `vaultd-host` binary and the live-host harness drive) installs the module interception with `allowNodeBuiltins: !config.dryRun`, so a shipped `--dry-run` really does refuse those thirteen to a plugin bundle. Pinned by `test/host-wiring-real-daemon.test.ts`, which loads one bundle twice: refused under `--dry-run`, loaded without it.

Notices are recorded, but in **every** mode — `host.invoke_command` reports them whether or not the host is pretending.

**Not intercepted, by design.** Every read path, every timer, and CPU. A dry run reads the real vault and the real settings, because the question it answers is what a plugin would do to the files that are actually there — and a change somebody else makes still reaches this host's mirror, so dry-run is not read isolation either. `localStorage` is **not** intercepted: the host persists it into its own data directory rather than into the vault, and a dry run writes it for real, which matters because plugins commonly keep state there. And any route to the file system that is not on the intercepted list — a bundle running with this host's Node privileges can still reach the disk, exactly as it can under Electron.

**What a dry run pretends instead — the overlay.** Nothing is written, so the mirror does not move; the host keeps a second, smaller structure beside it so that a run composes. Every recorded mutation lands there: `write_note`, `write_file` and the two adapter writes record the bytes; `create_folder` and `mkdir` record a folder; `copy_file` and the two renames add the destination (and, for a folder, everything under it) with the source's bytes; `delete_note`, `delete_folder`, `remove` and both trashes record a removal that covers the whole subtree. A plugin that creates, copies or renames a path and then uses the `TFile` or `TFolder` that call answered with gets a real one, in the tree, visible to `getAbstractFileByPath`, `getFiles`, `getMarkdownFiles` and its parent's `children`; a plugin that writes and then reads gets its own bytes, so several writes to one path compose; and the synthetic revision an answer carried is the one the next write to that path states as its precondition. `Plugin.loadData` after a dry-run `saveData` returns what was saved.

**Its precedence is one rule: removed, then overlay bytes, then the mirror.** A path this run removed reads as gone — `not_found`, the daemon's own code and message — however solidly it sits on disk, and so does everything under it; its node also leaves its parent's `children` and every listing, so no surface still offers a file the others deny. The **one exception** to the rule is a collision: if the daemon really produces a row at a path this run only *invented* — the user's own Obsidian creating today's note while a periodic-notes plugin is being evaluated — the pretend file gives way to the real one everywhere at once, so `getAbstractFileByPath`, `getFiles`, the parent's `children`, `adapter.exists`, `adapter.stat` and `read` all describe the daemon's file. A path the run merely *modified* is not a collision and keeps answering the run's own bytes; that is read-your-writes.

**What consults the overlay, and what does not.** `app.vault`'s reads and its file tree, `vault.adapter`'s `read`, `readBinary`, `append`, `exists`, `stat` and `list`, `Plugin.loadData`, and the host's own read of a plugin's `data.json` — so `host.get_plugin_config` sees a plugin's dry-run `saveData`, and `host.set_plugin_config`'s read-modify-write merges over that save rather than erasing it. Four things the overlay deliberately does *not* do. **Nothing is written into the mirror**, so a row the daemon never produced cannot reach the metadata cache, link resolution or your snapshots, and cannot fight the next resync. **Metadata stays the mirror's**: `getFileCache` of an overlay-only file is `null` and of a modified one is the daemon's cached metadata, stale by design, because a dry run does not re-parse its own bytes (a synthetic node's `stat` carries the recorded byte length and zero times for the same reason). **No vault events fire for synthetic writes** — `create`, `modify`, `rename` and `delete` come from a mirror batch, and the mirror does not move. And **`patch_frontmatter` records no bytes**, because the host sends key-path patches rather than a serialized note, so a read after a dry-run frontmatter patch is the pre-patch text. One smaller gap, named rather than papered over: the host enumerates installed plugins with `read_dir`, which is the daemon's own listing, so a plugin folder a dry run "created" is not an installed plugin. The overlay is cleared with the rest of the run's records.

## Errors

The host's codes, **additive to `vaultd`'s** — a forwarded operation's refusal is the daemon's, unchanged:

`host_not_ready`, `plugin_not_installed`, `plugin_quarantined`, `command_not_found`, `menu_item_not_found`, `protocol_handler_not_found`, `headless_unsupported`, `overlap_refused`, `plugin_data_too_large`, `plugin_data_too_deep`, `interaction_unavailable`, `interaction_timeout`, `dry_run_refused`, `detector_requires_dry_run`, `not_owner`, `snapshot_not_found`.

**Sixteen, not eighteen.** `plugin_not_found` and `config_key_refused` were listed here and in the wire union until the final review found that nothing in the host ever threw either. Both are gone rather than wired, because each already has a shipped answer that says the same thing better: an id this host does not have is `plugin_not_installed` on every operation that asks — and `host.disable_plugin` deliberately accepts an id it has never heard of, for the reason the **Plugins** section gives — and a `set_plugin_config` key this host will not take is a **row** in `refused[]` carrying its own reason and path, which is an answer rather than a refusal of the whole request.

`plugin_data_too_large` and `plugin_data_too_deep` are the plugin-config pair's two non-refusals, described under **Plugin configuration** above: neither can be attributed to one key, and neither writes anything.

`detector_requires_dry_run` is the compatibility detector's own refusal (Task 20). Its scan half reads the shipped bundle and is always available; its harness half **loads the plugin for real**, so the host performs it only under `--dry-run`, where every write the plugin makes is recorded instead of performed. A `host.compat_report` against a host that is not in dry-run therefore answers with `harness: null` per plugin rather than refusing — the refusal is for a harness run asked for by name.

**A compat report always completes.** One plugin the host cannot probe — a quarantined one, or one whose probe refused or broke for any other reason — is one row with `harness: null` and a sentence in that row's `notes`, never a refusal for the whole report. A host holding a quarantined plugin is exactly the host an operator wants a report from.

**`verdict` is one of `runs`, `degrades`, `fails`, `unknown`, and `harness_attempted` says which kind of null a null harness is.** `harness_attempted: false` means this host is not in dry-run and nothing was tried, so the verdict comes from the static scan's tier estimate. `harness_attempted: true` with `harness: null` means the attempt was refused or failed — the row's `notes` say which — and the verdict is `unknown`: a host that will not run a plugin has no verdict about running it, and a client rendering the verdict alone must not be shown green for one.

**A probe never advances a plugin toward quarantine.** A harness run loads the plugin for real, so a plugin whose `onload` throws fails under a probe exactly as it would under a real enable, and that failure is visible afterwards — `host.list_plugins` still reports it and the host still knows why. What it does **not** do is count toward the rolling failure window: five `host.compat_report` calls in a minute would otherwise quarantine a plugin no user action had touched. The quarantine is a judgement about what the host has been asked to do, and asking for a report is not asking to run the plugin.

Each row's `harness`, when it is not null, carries what the load did: `calls` (every shim symbol the plugin touched, in order, each with its `policy` and `threw`), `throws` (the subset that refused), `writes` (what a dry run recorded instead of performing, this plugin's only), **`refusals`** (what the dry run would not do at all — the network calls, OS bridges and node builtins, each with its `surface`), `harvest` (the four registration counts), and `harness_limits` (what the run could not see: a plugin that was already loaded, an overlay that still holds the probe's bytes). A refusal is a fact about the *run* and never moves the verdict, which is why it sits beside `throws` rather than among them.

Daemon codes the host also answers on its own behalf: `incompatible_version` (a `version` that is not `1`, carrying `supported_version`), `invalid_request` (a malformed request on an authenticated connection, or a `host.` method this build does not have), `invalid_cursor` (a snapshot cursor this host did not issue, or one from another session), `generation_mismatch` and `too_many_snapshots` (snapshot sessions, above), `subscription_not_found` (`host.unsubscribe` for an id this connection does not hold), `not_found` (a path that names nothing), and `internal` (a plugin's own code threw — the message names the command and the failure is counted against that plugin's quarantine).

Input with no usable envelope is a fatal input error: there is no `id` to echo, so there is no way to say which request it was about, and the connection is closed. See *Envelope* above for exactly which lines those are.

A refusal never takes the host down. Every request line is handled behind its own catch, so a bug in the dispatcher becomes a refusal on that connection rather than a rejected promise; and a process-level guard catches an unhandled rejection from anywhere else, reports it through the host's error seam under the host's own id, and keeps the host serving. Node's default is to terminate the process for one stray promise, which for this host means every loaded plugin, every subscription and every other client.

**That guard is process-wide, and a process embedding this host inherits it**: Node suppresses its default exit as soon as *any* `unhandledRejection` listener exists, so while a host is open the embedding process no longer exits on an unhandled rejection — including one raised by code that has nothing to do with the host, which reaches the host's error seam attributed to the host rather than to any plugin. The guard is refcounted and removes only its own listener, so closing the last host restores whatever policy the process had before.
