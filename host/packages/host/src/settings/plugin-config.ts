/**
 * Serving and changing a plugin's configuration, with the two guards that make
 * either safe to expose over a socket.
 *
 * **Reading is guarded by redaction.** Four keys in the corpus hold real
 * credentials — brat's `personalAccessToken`, tasknotes' `apiAuthToken` and its
 * two calendar token bags — and a `get_plugin_config` that answered them in
 * plain text would turn one read of a settings file into a credential leak. The
 * registry is the first authority and a name-shaped test is the second, and the
 * second only ever **adds** redaction: a registry entry cannot un-redact a key
 * that looks like a secret, because the failure of a hand-maintained list is
 * always the key nobody added to it.
 *
 * **Writing is guarded by three refusals**, each answered per key with a reason
 * rather than by failing the whole call:
 *
 * - `state_key` — twelve plugins keep runtime state in the same file as their
 *   settings (tasknotes' pomodoro clock and its calendar sync queue, recent
 *   files' whole cache, quickadd's migration flags). Writing one is not
 *   configuring a plugin, it is corrupting its bookkeeping, and the registry is
 *   what tells the two apart. A regex cannot: darlal-switcher-plus's
 *   `maxRecentCommands` and `shouldSearchRecentFiles` match every "recent"
 *   pattern anyone would write and are ordinary settings.
 * - `unknown_key` — only when the schema source is not `"none"`. A host that
 *   knows a plugin's keys should refuse a typo rather than persist it; a host
 *   that knows nothing must not pretend a key is invented merely because it
 *   could not read the schema, or every Tier-3 plugin becomes unconfigurable.
 * - `type_mismatch` — a string for a toggle. Checked against the control the
 *   schema declares, and a control of `unknown` checks nothing, because a type
 *   nobody stated is a type nothing can contradict.
 *
 * **The write is one `write_file` of the whole document**, merged over what is
 * on disk, so every key the patch did not mention survives — the file is the
 * unit the format has. Afterwards the loaded plugin's `onExternalSettingsChange`
 * is called if it defines one: that is Obsidian's own signal for "your
 * `data.json` changed underneath you", and it goes through the
 * {@link DispatchQueue} because it is a plugin entry point like any other.
 */

import seed from "./key-registry.json";
import type { CachedSchema, SchemaControl, SchemaLadder } from "./ladder";
import type { DispatchQueue } from "../runtime/queue";
import type { HeadlessConfigDir } from "../pluginset/config-dir";
import type { HostConfig } from "../config";
import type { PluginRegistry } from "../shim/plugin-registry";

export interface KeyRegistryEntry {
  state_keys: string[];
  secret_keys: string[];
}

export type KeyRegistry = Record<string, KeyRegistryEntry>;

/**
 * The seeded registry, from the research's config census.
 *
 * A JSON **data** file rather than a TypeScript module, and loaded through the
 * module system rather than read at runtime, for two reasons that pull the same
 * way: it is PR-able per plugin by someone who has audited one plugin's
 * `data.json` and knows nothing else about this host (Ruling 8), and it cannot
 * become a file-system read in a module that is not the host's one writing seam.
 *
 * **What is in it is what the census named.** forge, governor and brat are
 * listed in the census as keeping "one-shot flags, pin list" without naming the
 * keys, so their entries carry the keys that *were* named — brat's token — and
 * empty state lists. Empty is not an audit: it means nobody has written those
 * key names down yet, and until someone does, a write to one of those flags is
 * allowed through. That is the gap a per-plugin PR closes.
 */
export const DEFAULT_KEY_REGISTRY: KeyRegistry = seed;

/** What a redacted value renders as. Never the empty string: absent and withheld are different. */
export const REDACTED = "[redacted]";

/**
 * The name-shaped fallback. Adds redaction, never removes it.
 *
 * Deliberately broad — it fires on `myServiceApiKey` in a plugin nobody has
 * ever audited — because the cost of over-redacting is one `reveal_secrets`
 * away and the cost of under-redacting is a credential on a socket.
 */
const SECRET_SHAPED = /token|secret|password|apikey|api_key|credential/i;

export type RefusalReason = "state_key" | "unknown_key" | "type_mismatch";

export interface PluginConfigView {
  values: Record<string, unknown>;
  schema: CachedSchema;
  /**
   * The keys this answer treats as secret.
   *
   * Named for what it does in the guarded answer, and reported in the revealed
   * one too: a caller that asked for the plaintext still needs to know which of
   * the values it is now holding are credentials.
   */
  redacted_keys: string[];
  /** The keys `set` will refuse, from the registry. */
  state_keys: string[];
}

export interface PluginConfigWrite {
  applied: string[];
  refused: Array<{ key: string; reason: RefusalReason }>;
}

/**
 * The two wirings the brief's four-argument constructor does not carry, and
 * both are optional because a caller that has neither still gets the guards.
 *
 * `plugins` is `app.plugins` (Task 12): it answers which version of a plugin is
 * loaded — the key the schema cache is filed under — and which instance owns an
 * `onExternalSettingsChange`. With no registry the service serves a `"none"`
 * schema, which refuses nothing and redacts everything it should.
 */
export interface PluginConfigDeps {
  readonly plugins?: PluginRegistry;
  readonly queue?: DispatchQueue;
}

/** A `data.json` this host will not write because the daemon would refuse it. */
export class PluginDataTooLarge extends Error {
  readonly code = "payload_too_large";
  readonly pluginId: string;

  constructor(pluginId: string, bytes: number, cap: number) {
    super(
      `refusing to write ${pluginId}'s data.json: the merged document is ${String(bytes)} bytes, ` +
        `over this host's ${String(cap)}-byte write cap. Nothing was written, so the file on ` +
        "disk is still the one the plugin last saved.",
    );
    this.name = "PluginDataTooLarge";
    this.pluginId = pluginId;
  }
}

export class PluginConfigService {
  private readonly dir: HeadlessConfigDir;
  private readonly ladder: SchemaLadder;
  private readonly registry: KeyRegistry;
  private readonly config: HostConfig;
  private readonly deps: PluginConfigDeps;

  constructor(
    dir: HeadlessConfigDir,
    ladder: SchemaLadder,
    registry: KeyRegistry,
    config: HostConfig,
    deps: PluginConfigDeps = {},
  ) {
    this.dir = dir;
    this.ladder = ladder;
    this.registry = registry;
    this.config = config;
    this.deps = deps;
  }

  /**
   * One plugin's settings, guarded — or revealed, when the caller asked.
   *
   * A plugin with no `data.json` answers an empty document rather than a
   * failure: it has saved nothing yet, which is an ordinary state for half the
   * corpus and not an error to report.
   */
  async get(id: string, revealSecrets: boolean): Promise<PluginConfigView> {
    const stored = (await this.dir.readPluginData(id)) ?? {};
    const entry = this.registry[id];
    const secrets = new Set(entry?.secret_keys ?? []);
    const values: Record<string, unknown> = {};
    const redacted: string[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (secrets.has(key) || SECRET_SHAPED.test(key)) {
        redacted.push(key);
        values[key] = revealSecrets ? value : REDACTED;
        continue;
      }
      values[key] = value;
    }
    return {
      values,
      schema: this.schemaFor(id),
      redacted_keys: redacted,
      state_keys: [...(entry?.state_keys ?? [])],
    };
  }

  /**
   * Apply what is allowed, refuse what is not, and say which was which.
   *
   * **Every key is classified before anything is written.** A call that wrote
   * as it went would leave a half-applied patch behind the first refusal, and
   * the caller could not tell which half — so the refusals are collected first
   * and the surviving keys land in one write or not at all.
   */
  async set(id: string, patch: Record<string, unknown>): Promise<PluginConfigWrite> {
    const schema = this.schemaFor(id);
    const entry = this.registry[id];
    const state = new Set(entry?.state_keys ?? []);
    const declared = new Map(schema.items.map((item) => [item.key, item.control] as const));
    const applied: string[] = [];
    const refused: PluginConfigWrite["refused"] = [];
    const accepted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (state.has(key)) {
        refused.push({ key, reason: "state_key" });
        continue;
      }
      const control = declared.get(key);
      if (control === undefined) {
        // A schema this host could not read refuses nothing: see the header.
        if (schema.source !== "none") {
          refused.push({ key, reason: "unknown_key" });
          continue;
        }
      } else if (!fits(control, value)) {
        refused.push({ key, reason: "type_mismatch" });
        continue;
      }
      applied.push(key);
      accepted[key] = value;
    }
    if (applied.length === 0) return { applied, refused };
    const current = (await this.dir.readPluginData(id)) ?? {};
    const merged = { ...current, ...accepted };
    const bytes = Buffer.byteLength(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
    if (bytes > this.config.writeFileCapBytes) {
      throw new PluginDataTooLarge(id, bytes, this.config.writeFileCapBytes);
    }
    await this.dir.writePluginData(id, merged);
    await this.notify(id);
    return { applied, refused };
  }

  /**
   * The cached schema for the version that is **loaded**, or a `"none"` schema.
   *
   * The version comes from the plugin registry rather than from a manifest read
   * on purpose: the schema cache is keyed by version so that a plugin update is
   * a miss by construction, and the only version this host can answer questions
   * about is the one whose bundle is running. A plugin that is installed but not
   * loaded therefore serves `"none"` — which refuses no write and redacts every
   * secret, the right way round for the case where the host knows least.
   */
  private schemaFor(id: string): CachedSchema {
    const version = this.deps.plugins?.manifests[id]?.version;
    if (version !== undefined) {
      const cached = this.ladder.read(id, version);
      if (cached !== null) return cached;
    }
    return {
      pluginId: id,
      pluginVersion: version ?? "",
      source: "none",
      items: [],
      capturedAtUnixMs: 0,
    };
  }

  /**
   * Tell the plugin its file moved under it, if it asked to be told.
   *
   * Through the dispatch queue, because this is a plugin entry point and every
   * other one goes through it: a callback that ran outside the queue would run
   * while another plugin's work was in flight, and `currentPluginId()` would
   * name the wrong plugin for anything it touched.
   */
  private async notify(id: string): Promise<void> {
    const plugin = this.deps.plugins?.plugins[id];
    if (plugin === undefined || typeof plugin.onExternalSettingsChange !== "function") return;
    const call = (): void => {
      plugin.onExternalSettingsChange?.();
    };
    if (this.deps.queue === undefined) {
      call();
      return;
    }
    await this.deps.queue.run(id, `${id}:onExternalSettingsChange`, call);
  }
}

/**
 * Does this value contradict the control the schema declares?
 *
 * Shape, not validity: a dropdown's value must be a string, and whether it is
 * one of the declared options is the plugin's own business — options go stale
 * against a plugin that computes them, and a host refusing a value the plugin
 * would have accepted is a worse failure than one it stores.
 */
function fits(control: SchemaControl, value: unknown): boolean {
  switch (control) {
    case "toggle":
      return typeof value === "boolean";
    case "number":
    case "slider":
      return typeof value === "number" && Number.isFinite(value);
    case "text":
    case "textarea":
    case "dropdown":
    case "file":
    case "folder":
    case "color":
      return typeof value === "string";
    case "unknown":
      return true;
  }
}
