/**
 * The whole `camelCase` → `snake_case` conversion surface, in one module.
 *
 * **Every field name on the host socket is `snake_case`, without exception.**
 * The host's internal shapes are `camelCase` — `HarvestedCommand.pluginId`,
 * `OverlapReport.checkedAtMs`, `MirrorEntry.mtimeMs` — because they are
 * TypeScript objects that never leave the process, and the wire is the daemon's
 * spelling because a client that already speaks `vaultd` must not have to learn
 * a second grammar half way through a session.
 *
 * Both facts are only true if the conversion happens in exactly one place. A
 * second converter somewhere else is a second chance for a field to reach the
 * socket spelled `pluginId`, and a client cannot tell a typo from a new field.
 * So every shape that crosses the socket is built here, and
 * `test/server-wire.test.ts` asserts, for each of them, that the key set is the
 * expected one and that **no key anywhere in the output matches `/[a-z][A-Z]/`**
 * — including one case that walks a live `host.info` response recursively,
 * which is the assertion that catches a field somebody adds later and forgets to
 * convert.
 *
 * Nothing here reaches into a live object: a `HarvestedSettingTab` carries the
 * plugin's actual `PluginSettingTab` instance, and the wire shape for it is
 * `{ plugin_id, has_setting_definitions }` precisely so that a live object never
 * leaves the process.
 */

import type { ErrorCode, ProtocolErrorBody } from "../client/protocol";
import type { HarvestedCommand } from "../shim/harvest";
import type {
  HarvestedMenuItem,
  HarvestedProtocolHandler,
  HarvestedSettingTab,
  HarvestedTimer,
  HarvestedUnreachable,
} from "../shim/harvest";
import type { MirrorEntry } from "../mirror/types";
import type { PluginRunState } from "../runtime/lifecycle";
import type { NoticeEntry } from "../shim/notice";
import type { OverlapReport } from "../pluginset/coexistence";
import type { PromptKind, PromptRequest } from "../interaction/broker";
import type { TreeEntryDto } from "../client/protocol";
import type { ApiPolicy, RecordedApiCall } from "../shim/policy";
import type { CachedSchema, SchemaControl, SchemaItem, SchemaSource } from "../settings/ladder";
import type { CompatReport, CompatReportRow, Verdict } from "../detector/report";
import type { ConfigPath, PluginConfigView, PluginConfigWrite } from "../settings/plugin-config";
import type { FrameworkName, ScanResult, Tier } from "../detector/scanner";
import type { HarnessResult } from "../detector/harness";
import type { RecordedRefusal, RecordedWrite } from "../dryrun/dry-run";

/**
 * The host's own error codes, **additive to `vaultd`'s**.
 *
 * Additive rather than replacing: a method that is not a `host.` method is
 * forwarded to the daemon and its refusal relayed unchanged, so a client sees
 * `note_not_found` through this socket exactly as it would through the daemon's.
 * These are the refusals only a host can make.
 */
/*
 * **Two codes were removed rather than wired**, and the reasoning is the same
 * for both: a code in this union is a promise the socket makes, and nothing in
 * `src/` ever threw either of them.
 *
 * - `plugin_not_found` had no case left to take. An id that is not installed is
 *   `plugin_not_installed`, on every operation that asks; and `host.disable_plugin`
 *   deliberately accepts an id it has never heard of, which
 *   `docs/protocol-host.md`'s Plugins section states and gives the reason for.
 *   Two codes for one question is how a client comes to branch on the one the
 *   host does not send.
 * - `config_key_refused` is a different shape from what actually happens.
 *   `host.set_plugin_config` refuses **per key**, and a refusal is a row in
 *   `refused[]` carrying its own reason and path — an answer, not an error. The
 *   two whole-document failures that really do throw are
 *   `plugin_data_too_large` and `plugin_data_too_deep`, both below.
 */
export type HostErrorCode =
  | "host_not_ready"
  | "plugin_not_installed"
  | "plugin_quarantined"
  | "command_not_found"
  | "menu_item_not_found"
  | "protocol_handler_not_found"
  | "headless_unsupported"
  | "overlap_refused"
  // The two failures of the plugin-config pair that are **not** per-key
  // refusal rows: the service throws for both, because neither can be answered
  // about one key. A document merged past the host's write cap is
  // `plugin_data_too_large`, and one nested past the depth this host inspects
  // is `plugin_data_too_deep` — which fails closed, because a redactor that
  // cannot read a document to the bottom must not serve the half it inspected.
  | "plugin_data_too_large"
  | "plugin_data_too_deep"
  | "interaction_unavailable"
  | "interaction_timeout"
  | "dry_run_refused"
  // A harness run loads the plugin for real, so the detector does it only
  // under `--dry-run` (Task 20). The scan half has no such condition.
  | "detector_requires_dry_run"
  | "not_owner"
  | "snapshot_not_found";

/** Every code this socket can answer with: the daemon's set plus the host's. */
export type AnyErrorCode = ErrorCode | HostErrorCode;

/**
 * A refusal, thrown where it happens and caught at the socket.
 *
 * It carries the wire body rather than only a message, because the whole point
 * of a typed refusal is that a client branches on `code` and never on prose.
 * The three optional tails are the daemon's own (`current_generation`,
 * `current_revision`, `supported_version`), so a `generation_mismatch` from the
 * host's mirror-served snapshots carries the same field a daemon-served one
 * would and a client's retry loop does not have to know which door it came
 * through.
 */
export class HostError extends Error {
  readonly code: AnyErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: AnyErrorCode, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.detail = detail;
  }

  /**
   * The wire body. **`detail` is spread first**, so a detail key called `code`
   * or `message` cannot overwrite the two fields a client branches on. Every
   * detail in this build is host-supplied, but "the code is the code" is the
   * kind of invariant that should not depend on nobody ever passing the wrong
   * key.
   */
  body(): ProtocolErrorBody {
    return { ...this.detail, code: this.code, message: this.message };
  }
}

/**
 * What a plugin is doing, as far as this host is concerned.
 *
 * Re-exported rather than re-declared: the sequencer is what moves a plugin
 * between the four states, so the declaration lives beside the transitions and
 * the socket's spelling cannot drift from the host's.
 */
export type { PluginRunState };

/** Internal. Converted to {@link PluginStateWire} at the socket. */
export interface PluginState {
  id: string;
  name: string;
  version: string;
  state: PluginRunState;
  loadMs: number | null;
  failureCount: number;
  reason: string | null;
}

/** On the wire. Every key `snake_case`; nothing mixed. */
export interface PluginStateWire {
  id: string;
  name: string;
  version: string;
  state: PluginRunState;
  load_ms: number | null;
  failure_count: number;
  reason: string | null;
}

export interface HarvestedCommandWire {
  plugin_id: string;
  id: string;
  local_id: string;
  name: string;
  icon: string | null;
  kind: string;
  hotkeys: Array<{ modifiers: string[]; key: string }>;
}

export interface HarvestedMenuItemWire {
  hook_id: string;
  plugin_id: string;
  id: string;
  title: string;
  icon: string | null;
  section: string | null;
  checked: boolean | null;
}

export interface OverlapWire {
  host_enabled: string[];
  gui_enabled: string[];
  overlap: string[];
  forced: string[];
  gui_readable: boolean;
  checked_at_ms: number;
}

/** One caret position, as `host.invoke_command` takes it. Zero-based, both. */
export interface PositionWire {
  line: number;
  ch: number;
}

/**
 * `host.invoke_command`'s `selection`, pinned. **Ratified deviation.**
 *
 * The phase brief's table spells this `selection?: string`, and that row cannot
 * be implemented as written: an `editorCallback` is handed an `Editor`, whose
 * `setSelection` takes two positions, so a string would have to be *searched*
 * for in the note — a different operation, with a different failure mode (no
 * match, several matches) and a different answer for each. The controller
 * ratified the range in Task 16a's fix round; the brief's table is amended to
 * match, and a client that sends a string is told so by name rather than having
 * it silently ignored.
 *
 * Both fields are zero-based, which is Obsidian's own convention for
 * `EditorPosition` and therefore what a plugin's own code already expects.
 */
export interface SelectionWire {
  from: PositionWire;
  to: PositionWire;
}

export interface ProtocolHandlerWire {
  plugin_id: string;
  action: string;
}

export interface TimerWire {
  plugin_id: string;
  interval_ms: number | null;
  created_at: number;
}

export interface UnreachableWire {
  plugin_id: string;
  kind: string;
  detail: string;
}

export interface SettingTabWire {
  plugin_id: string;
  has_setting_definitions: boolean;
}

export interface NoticeWire {
  plugin_id: string | null;
  message: string;
  at_unix_ms: number;
}

export interface PolicyUseWire {
  symbol: string;
  policy: ApiPolicy;
  plugin_id: string | null;
  hits: number;
}

/**
 * The `host.interaction_request` event's value.
 *
 * `items` is copied rather than passed through: the broker holds the array for
 * the life of the prompt and a client-shaped object handed a live reference
 * would let anything that mutated it change a question already asked.
 */
export interface InteractionRequestWire {
  prompt_id: string;
  plugin_id: string;
  kind: PromptKind;
  prompt: string;
  items: string[];
  timeout_ms: number;
}

export function toWirePluginState(state: PluginState): PluginStateWire {
  return {
    id: state.id,
    name: state.name,
    version: state.version,
    state: state.state,
    load_ms: state.loadMs,
    failure_count: state.failureCount,
    reason: state.reason,
  };
}

export function toWireCommand(command: HarvestedCommand): HarvestedCommandWire {
  return {
    plugin_id: command.pluginId,
    id: command.id,
    local_id: command.localId,
    name: command.name,
    icon: command.icon,
    kind: command.kind,
    // Copied rather than referenced: the harvest's rows are `readonly` and this
    // object is about to be serialized, so the copy costs nothing and keeps a
    // client's decoded array from aliasing host state in any future transport
    // that does not go through JSON.
    hotkeys: command.hotkeys.map((hotkey) => ({ modifiers: [...hotkey.modifiers], key: hotkey.key })),
  };
}

export function toWireMenuItem(item: HarvestedMenuItem): HarvestedMenuItemWire {
  return {
    hook_id: item.hookId,
    plugin_id: item.pluginId,
    id: item.id,
    title: item.title,
    icon: item.icon,
    section: item.section,
    checked: item.checked,
  };
}

export function toWireOverlap(report: OverlapReport): OverlapWire {
  return {
    host_enabled: [...report.hostEnabled],
    gui_enabled: [...report.guiEnabled],
    overlap: [...report.overlap],
    forced: [...report.forced],
    gui_readable: report.guiReadable,
    checked_at_ms: report.checkedAtMs,
  };
}

export function toWireProtocolHandler(handler: HarvestedProtocolHandler): ProtocolHandlerWire {
  return { plugin_id: handler.pluginId, action: handler.action };
}

export function toWireTimer(timer: HarvestedTimer): TimerWire {
  return {
    plugin_id: timer.pluginId,
    interval_ms: timer.intervalMs,
    created_at: timer.createdAt,
  };
}

export function toWireUnreachable(row: HarvestedUnreachable): UnreachableWire {
  return { plugin_id: row.pluginId, kind: row.kind, detail: row.detail };
}

export function toWireSettingTab(tab: HarvestedSettingTab): SettingTabWire {
  return { plugin_id: tab.pluginId, has_setting_definitions: tab.hasSettingDefinitions };
}

export function toWireNotice(entry: NoticeEntry): NoticeWire {
  return { plugin_id: entry.pluginId, message: entry.message, at_unix_ms: entry.atUnixMs };
}

export function toWirePolicyUse(use: {
  symbol: string;
  policy: ApiPolicy;
  pluginId: string | null;
  hits: number;
}): PolicyUseWire {
  return { symbol: use.symbol, policy: use.policy, plugin_id: use.pluginId, hits: use.hits };
}

export function toWireInteractionRequest(request: PromptRequest): InteractionRequestWire {
  return {
    prompt_id: request.promptId,
    plugin_id: request.pluginId,
    kind: request.kind,
    prompt: request.prompt,
    items: [...request.items],
    timeout_ms: request.timeoutMs,
  };
}

/**
 * One mirrored tree row, as `vaultd`'s own `TreeEntryDto`.
 *
 * **The same shape the daemon serves**, because Ruling 5's point is that a
 * client pages the host exactly as it would page the daemon: `size` is absent
 * for a folder and `revision` for a folder and for every non-note file, and
 * "absent" is spelled by leaving the key off rather than by sending `null`. The
 * mirror carries both as `null`, which is how a TypeScript field says absent;
 * the wire says it by omission, which is what the daemon does and what a client
 * decoding into a strict Rust struct expects.
 */
// --- Plugin configuration (Task 17, wired here) -------------------------------

/**
 * One schema row. **Absent is spelled by omission**, as `toWireTreeEntry` does
 * it and as the daemon does it: a key that is not there says "this rung of the
 * ladder described no name for this setting", where `null` would be a name the
 * plugin had declared as nothing.
 */
export interface SchemaItemWire {
  key: string;
  control: SchemaControl;
  name?: string;
  description?: string;
  default_value?: unknown;
  options?: Array<{ value: string; label: string }>;
}

/**
 * `host.get_plugin_config`'s answer.
 *
 * `schema` carries the **source enum and the items, and nothing else**: the
 * cache's `pluginId`, `pluginVersion` and `capturedAtUnixMs` are bookkeeping
 * about the host's own cache rather than a description of the plugin, and the
 * row the protocol document pins is `{ source, items }`. The enum crosses
 * as itself — `"none"` stays `"none"` — because prose is a rendering and a
 * client that branched on a sentence would break the first time one was
 * reworded. What `"none"` means (**not yet described**, never "no settings") is
 * the protocol document's to say.
 */
export interface PluginConfigWire {
  id: string;
  values: Record<string, unknown>;
  schema: { source: SchemaSource; items: SchemaItemWire[] };
  redacted_keys: ConfigPath[];
  state_keys: string[];
}

export interface ConfigRefusalWire {
  key: string;
  reason: string;
  path?: ConfigPath;
}

export interface PluginConfigWriteWire {
  id: string;
  applied: string[];
  refused: ConfigRefusalWire[];
}

function toWireSchemaItem(item: SchemaItem): SchemaItemWire {
  return {
    key: item.key,
    control: item.control,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.defaultValue === undefined ? {} : { default_value: item.defaultValue }),
    ...(item.options === undefined
      ? {}
      : { options: item.options.map((option) => ({ value: option.value, label: option.label })) }),
  };
}

function toWireSchema(schema: CachedSchema): { source: SchemaSource; items: SchemaItemWire[] } {
  return { source: schema.source, items: schema.items.map(toWireSchemaItem) };
}

/**
 * **`values` crosses as it stands.** It is the plugin's own document, whose
 * keys are the plugin author's spelling — `taskTag`, `myApiKey` — and
 * converting them would rename a client's settings. The `snake_case` rule is
 * about the fields *this host* names; a plugin's key is data, and the
 * redaction has already happened one layer down.
 */
export function toWirePluginConfig(id: string, view: PluginConfigView): PluginConfigWire {
  return {
    id,
    values: view.values,
    schema: toWireSchema(view.schema),
    redacted_keys: view.redacted_keys.map((path) => [...path]),
    state_keys: [...view.state_keys],
  };
}

export function toWirePluginConfigWrite(
  id: string,
  write: PluginConfigWrite,
): PluginConfigWriteWire {
  return {
    id,
    applied: [...write.applied],
    refused: write.refused.map((refusal) => ({
      key: refusal.key,
      reason: refusal.reason,
      ...(refusal.path === undefined ? {} : { path: [...refusal.path] }),
    })),
  };
}

// --- The compatibility report (Task 20, wired here) ---------------------------

/**
 * One tallied symbol, as a **row** rather than as a key.
 *
 * The scan's tallies are `Record<symbolName, hits>` inside the host, and the
 * symbol names are Obsidian's own: `getFileCache`, `onLayoutReady`,
 * `registerEvent`. Serialized as an object they would put `camelCase` *keys* on
 * a socket whose one rule is that it has none — and the rule is worth more than
 * the shape, because it is what lets a client (and `server-wire.test.ts`) check
 * a whole response mechanically instead of maintaining a list of fields that are
 * allowed to be exempt. As rows, the symbol is a value, where it belongs: it is
 * the plugin's evidence, not this host's field name. Insertion order is
 * preserved, so the rows read in the order the scanner found them.
 */
export interface SymbolTallyWire {
  symbol: string;
  hits: number;
}

export interface ScanResultWire {
  plugin_id: string;
  minified: boolean;
  bytes: number;
  api_symbols: SymbolTallyWire[];
  generic_symbols: SymbolTallyWire[];
  lifecycle_gates: {
    on_layout_ready: number;
    layout_ready_read: number;
    metadata_resolved: number;
    metadata_resolve: number;
  };
  registrations: SymbolTallyWire[];
  command_ids: string[];
  event_names: string[];
  frameworks: FrameworkName[];
  cross_plugin: string[];
  internal_plugins: string[];
  requires_electron: boolean;
  requires_node: string[];
  tier_estimate: Tier;
  tier_reasons: string[];
}

export interface RecordedApiCallWire {
  symbol: string;
  plugin_id: string | null;
  policy: ApiPolicy;
  threw: string | null;
  at_unix_ms: number;
}

/**
 * One recorded write, **without its params**.
 *
 * `RecordedWrite.params` is the body of the write — a note's text, or the whole
 * of a plugin's `data.json` on its way to disk — and a compatibility report
 * that carried it would be a copy of the settings this report exists not to
 * copy. What a reader needs from a dry run is *that* the plugin wrote, what
 * verb it used and whether it landed in the vault or in the config zone; the
 * bytes are the dry-run log's, and the dry-run log is not this door.
 */
export interface RecordedWriteWire {
  kind: "vault" | "plugin_config";
  method: string;
  plugin_id: string | null;
  at_unix_ms: number;
}

export interface RecordedRefusalWire {
  surface: string;
  detail: string;
}

export interface HarnessResultWire {
  plugin_id: string;
  loaded: boolean;
  load_error: string | null;
  calls: RecordedApiCallWire[];
  throws: RecordedApiCallWire[];
  writes: RecordedWriteWire[];
  refusals: RecordedRefusalWire[];
  harvest: {
    commands: number;
    menu_hooks: number;
    protocol_handlers: number;
    unreachable: number;
  };
  harness_limits: string[];
}

export interface CompatReportRowWire {
  id: string;
  version: string;
  scan: ScanResultWire;
  harness: HarnessResultWire | null;
  schema_source: SchemaSource;
  verdict: Verdict;
  /**
   * Whether this host tried to run the plugin, whatever came of it.
   *
   * The discriminator between the two ways `harness` is `null`. Without it a
   * client cannot tell "this host is not in dry-run, so nothing was attempted"
   * from "the attempt was refused" — and only the second one means the verdict
   * is `unknown` rather than the tier's estimate.
   */
  harness_attempted: boolean;
  notes: string[];
}

export interface CompatReportWire {
  generated_at_unix_ms: number;
  plugins: CompatReportRowWire[];
}

function toWireTally(tally: Readonly<Record<string, number>>): SymbolTallyWire[] {
  return Object.entries(tally).map(([symbol, hits]) => ({ symbol, hits }));
}

function toWireApiCall(call: RecordedApiCall): RecordedApiCallWire {
  return {
    symbol: call.symbol,
    plugin_id: call.pluginId,
    policy: call.policy,
    threw: call.threw,
    at_unix_ms: call.atUnixMs,
  };
}

function toWireRecordedWrite(write: RecordedWrite): RecordedWriteWire {
  return {
    kind: write.kind,
    method: write.method,
    plugin_id: write.pluginId,
    at_unix_ms: write.atUnixMs,
  };
}

/**
 * A dry run's refusal, with a network address cut back to origin and path.
 *
 * **The one plugin-controlled string in this report that routinely holds a
 * credential.** A `network` refusal's detail is the address the plugin asked
 * for, verbatim — and a plugin that hands a stored token to `requestUrl` puts
 * that token in the query string: `https://api.example/v1/sync?key=SECRET`
 * crossed this socket in full, on a report the protocol document describes as
 * carrying no configuration values. Nothing was read out of `data.json` to put
 * it there, which is why every leak probe passed; it arrived through the
 * plugin's own argument.
 *
 * So a detail that parses as a URL crosses as **origin plus path**: userinfo
 * is not in `origin`, and the query and the fragment are dropped. That is
 * enough for the reading a report is for — *which host did this plugin want,
 * and for what* — and it is the half that carries secrets that goes.
 *
 * Every other surface crosses unchanged: a node builtin's name and an OS
 * bridge's channel are short, host-authored strings with nowhere to hide a
 * credential, and truncating them would cost a reader the whole fact. A detail
 * that is not a URL crosses unchanged too, because guessing at the shape of a
 * string this host did not write is how a report starts lying.
 *
 * **The in-process {@link RecordedRefusal} keeps the raw detail**: the dry-run
 * log is an operator's own record on their own machine, and it is not this
 * door. Only the socket copy is cut.
 */
function toWireRefusal(refusal: RecordedRefusal): RecordedRefusalWire {
  return { surface: refusal.surface, detail: scrubRefusalDetail(refusal) };
}

function scrubRefusalDetail(refusal: RecordedRefusal): string {
  if (refusal.surface !== NETWORK_SURFACE) return refusal.detail;
  let url: URL;
  try {
    url = new URL(refusal.detail);
  } catch {
    // Not an address this host can parse — a relative URL, a template a plugin
    // never filled in. Unchanged, because the alternative is inventing a
    // structure for it.
    return refusal.detail;
  }
  return `${url.origin}${url.pathname}`;
}

/**
 * The dry-run gate's grouping for the two HTTP helpers.
 *
 * Spelled here rather than imported from `shim/helpers.ts`, which does not
 * export it, and duplicated deliberately: a rename there that missed this
 * would stop the scrub silently, so `server-wiring.test.ts` asserts the
 * scrubbing happens through a real refusal rather than against this constant.
 */
const NETWORK_SURFACE = "network";

export function toWireScanResult(scan: ScanResult): ScanResultWire {
  return {
    plugin_id: scan.pluginId,
    minified: scan.minified,
    bytes: scan.bytes,
    api_symbols: toWireTally(scan.apiSymbols),
    generic_symbols: toWireTally(scan.genericSymbols),
    lifecycle_gates: {
      on_layout_ready: scan.lifecycleGates.onLayoutReady,
      layout_ready_read: scan.lifecycleGates.layoutReadyRead,
      metadata_resolved: scan.lifecycleGates.metadataResolved,
      metadata_resolve: scan.lifecycleGates.metadataResolve,
    },
    registrations: toWireTally(scan.registrations),
    command_ids: [...scan.commandIds],
    event_names: [...scan.eventNames],
    frameworks: [...scan.frameworks],
    cross_plugin: [...scan.crossPlugin],
    internal_plugins: [...scan.internalPlugins],
    requires_electron: scan.requiresElectron,
    requires_node: [...scan.requiresNode],
    tier_estimate: scan.tierEstimate,
    tier_reasons: [...scan.tierReasons],
  };
}

export function toWireHarnessResult(harness: HarnessResult): HarnessResultWire {
  return {
    plugin_id: harness.pluginId,
    loaded: harness.loaded,
    load_error: harness.loadError,
    calls: harness.calls.map(toWireApiCall),
    throws: harness.throws.map(toWireApiCall),
    writes: harness.writes.map(toWireRecordedWrite),
    refusals: harness.refusals.map(toWireRefusal),
    harvest: {
      commands: harness.harvest.commands,
      menu_hooks: harness.harvest.menuHooks,
      protocol_handlers: harness.harvest.protocolHandlers,
      unreachable: harness.harvest.unreachable,
    },
    harness_limits: [...harness.harnessLimits],
  };
}

export function toWireCompatReportRow(row: CompatReportRow): CompatReportRowWire {
  return {
    id: row.id,
    version: row.version,
    scan: toWireScanResult(row.scan),
    harness: row.harness === null ? null : toWireHarnessResult(row.harness),
    schema_source: row.schemaSource,
    verdict: row.verdict,
    harness_attempted: row.harnessAttempted,
    notes: [...row.notes],
  };
}

/**
 * The whole report, scrubbed.
 *
 * **What does not cross, and why.** No `tab`: a `HarvestedSettingTab` carries
 * the plugin's live `PluginSettingTab`, and nothing in this report reaches one.
 * No plugin instance and no live object of any kind — every field below is a
 * string, a number, a boolean or an array of those. And **no configuration
 * values**: the report says which rung of the ladder described a plugin's
 * settings ({@link CompatReportRowWire.schema_source}) and never what those
 * settings are. A compatibility report is a description of a plugin, never a
 * copy of its settings — that is what `host.get_plugin_config` is for, where a
 * caller has to ask for the plaintext by name.
 */
export function toWireCompatReport(report: CompatReport): CompatReportWire {
  return {
    generated_at_unix_ms: report.generatedAtUnixMs,
    plugins: report.plugins.map(toWireCompatReportRow),
  };
}

export function toWireTreeEntry(entry: MirrorEntry): TreeEntryDto {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.size === null ? {} : { size: entry.size }),
    ctime_unix_ms: entry.ctimeMs,
    mtime_unix_ms: entry.mtimeMs,
    ...(entry.revision === null ? {} : { revision: entry.revision }),
  };
}
