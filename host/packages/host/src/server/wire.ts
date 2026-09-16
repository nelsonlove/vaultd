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
import type { ApiPolicy } from "../shim/policy";

/**
 * The host's own error codes, **additive to `vaultd`'s**.
 *
 * Additive rather than replacing: a method that is not a `host.` method is
 * forwarded to the daemon and its refusal relayed unchanged, so a client sees
 * `note_not_found` through this socket exactly as it would through the daemon's.
 * These are the refusals only a host can make.
 */
export type HostErrorCode =
  | "host_not_ready"
  | "plugin_not_found"
  | "plugin_not_installed"
  | "plugin_quarantined"
  | "command_not_found"
  | "menu_item_not_found"
  | "protocol_handler_not_found"
  | "headless_unsupported"
  | "overlap_refused"
  | "config_key_refused"
  | "interaction_unavailable"
  | "interaction_timeout"
  | "dry_run_refused"
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
