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
 * **Redaction goes all the way down.** A secret-named key is withheld wherever
 * it appears — inside a nested object, inside an array of objects — and
 * `redacted_keys` names it by its **dotted path** (`nested.deep.apiToken`,
 * `accounts.0.refreshToken`); a top-level key's path is its own name, so the
 * shallow shape is a subset of this one. A fallback that only looked at depth
 * zero would offer a floor that is not there: the audited corpus's four
 * credentials are all top-level, but the fallback exists precisely for the
 * plugins nobody has audited, and `{"providers":{"openai":{"apiKey":"sk-…"}}}`
 * is an ordinary shape for one of them. A registry-listed or name-shaped key
 * withholds its **whole subtree**, so a token bag is withheld as a bag rather
 * than key by key.
 *
 * **Writing is guarded by four refusals**, each answered per key with a reason
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
 * - `type_mismatch` — a string for a toggle, or a value of `undefined`. Checked
 *   against the control the schema declares, and a control of `unknown` checks
 *   nothing, because a type nobody stated is a type nothing can contradict.
 * - `redacted_value` — the literal `[redacted]` written back into a key this
 *   service would redact. The most natural client there is reads a config,
 *   changes one field and writes the whole thing back — which is what a settings
 *   form does — and without this refusal that saves the string `[redacted]` over
 *   the user's real token, with no history and no way back. The refusal names
 *   the dotted path, and the rest of the patch still lands.
 *
 * **The write is one `write_file` of the whole document**, merged over what is
 * on disk, so every key the patch did not mention survives — the file is the
 * unit the format has. The promise is key-and-value preservation **under JSON
 * semantics**, not byte preservation: the document is parsed and re-serialized,
 * so indentation is normalized to two spaces, a trailing newline is added,
 * `1.0` and `1e3` come back as `1` and `1000`, and an integer past 2^53 is
 * rounded by the parse it cannot survive. Same values, sometimes different
 * bytes, and the normalization happens once — the same document written twice
 * is byte-identical. Afterwards the loaded plugin's `onExternalSettingsChange`
 * is called if it defines one: that is Obsidian's own signal for "your
 * `data.json` changed underneath you", and it goes through the
 * {@link DispatchQueue} because it is a plugin entry point like any other.
 *
 * **The read-merge-write holds the file's path lock** — the same
 * `DispatchQueue.runExclusivePath` lock `Plugin.saveData` takes, so the host's
 * own write and the plugin's own save serialize against each other instead of
 * losing an update while both report success.
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
 *
 * **A deep-frozen copy of the JSON module, never the module object itself.**
 * A module object is one shared instance for the whole process, and this one is
 * exported publicly: a caller that pushed an id onto `state_keys` — to try
 * something, or by mistake — would be editing the seed every other component
 * reads, for the life of the host. Frozen, that attempt throws in strict mode
 * instead of silently succeeding.
 */
export const DEFAULT_KEY_REGISTRY: KeyRegistry = deepFreeze(
  structuredClone(seed) as KeyRegistry,
);

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

/**
 * Key names no patch may carry, whatever the schema says.
 *
 * None of them can reach here over the wire — `JSON.parse` makes `__proto__` an
 * own property and the spread that builds the merged document drops it, so
 * nothing is polluted today — but an in-process caller (the Detector) can hand
 * over a plain object literal, and a key that is reported `applied` and then
 * does not appear in the file is the service lying about what it wrote. They
 * are refused by name rather than trusted to be harmless.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type RefusalReason = "state_key" | "unknown_key" | "type_mismatch" | "redacted_value";

export interface PluginConfigView {
  values: Record<string, unknown>;
  schema: CachedSchema;
  /**
   * The **dotted paths** this answer treats as secret, in document order.
   *
   * A top-level key is its own name; a nested one is `nested.deep.apiToken`, and
   * an array element carries its index (`accounts.0.refreshToken`). Named for
   * what it does in the guarded answer, and reported in the revealed one too: a
   * caller that asked for the plaintext still needs to know which of the values
   * it is now holding are credentials.
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
    const paths: string[] = [];
    const values = redactDocument(stored, this.secretTest(id), revealSecrets, paths);
    return {
      values,
      schema: this.schemaFor(id),
      redacted_keys: paths,
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
   *
   * What lands is preserved **under JSON semantics** rather than byte for byte;
   * see the module header for what that normalizes.
   */
  async set(id: string, patch: Record<string, unknown>): Promise<PluginConfigWrite> {
    const schema = this.schemaFor(id);
    const entry = this.registry[id];
    const state = new Set(entry?.state_keys ?? []);
    const isSecret = this.secretTest(id);
    const declared = new Map(schema.items.map((item) => [item.key, item.control] as const));
    const applied: string[] = [];
    const refused: PluginConfigWrite["refused"] = [];
    const accepted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (FORBIDDEN_KEYS.has(key)) {
        refused.push({ key, reason: "unknown_key" });
        continue;
      }
      if (state.has(key)) {
        refused.push({ key, reason: "state_key" });
        continue;
      }
      // `undefined` is not a JSON value: `JSON.stringify` drops the key, so a
      // patch carrying one would *delete* a setting while this call reported it
      // applied. It cannot arrive over the wire; an in-process caller can send
      // one by accident, and silence is the wrong answer to it.
      if (value === undefined) {
        refused.push({ key, reason: "type_mismatch" });
        continue;
      }
      // **Before the control check, on purpose.** With a known schema the
      // literal `[redacted]` is an ordinary string and would pass `fits` for
      // every string-ish control; with `source: "none"` it would pass
      // unexamined. Either way the user's token would be gone.
      const redactedAt = redactedValuePath(key, value, isSecret);
      if (redactedAt !== null) {
        refused.push({ key: redactedAt, reason: "redacted_value" });
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
    await this.locked(id, async () => {
      const current = (await this.dir.readPluginData(id)) ?? {};
      const merged = { ...current, ...accepted };
      const bytes = Buffer.byteLength(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
      if (bytes > this.config.writeFileCapBytes) {
        throw new PluginDataTooLarge(id, bytes, this.config.writeFileCapBytes);
      }
      await this.dir.writePluginData(id, merged);
    });
    // **Outside the lock.** `onExternalSettingsChange` is a plugin entry point,
    // and a plugin's natural response to "your file changed" is to re-read and
    // sometimes to save: called while this call still held the path lock, that
    // save would wait on a lock nothing will release.
    await this.notify(id);
    return { applied, refused };
  }

  /**
   * Hold `data.json`'s path lock for the read-modify-write, when there is one.
   *
   * The lock is `DispatchQueue.runExclusivePath`, keyed by the same path string
   * `Plugin.saveData` locks, so the host's write and the plugin's own save
   * serialize against each other rather than interleaving two reads and two
   * writes and losing one of them — while both callers were told they
   * succeeded. The daemon cannot help here: `write_file` is whole-file, so the
   * damage is a lost update rather than a torn document, and nothing downstream
   * would notice.
   *
   * **With no queue in `deps` the write is unlocked**, which is the price of
   * the brief's four-argument constructor: a service built that way still
   * guards every key, and two concurrent `set` calls on it can still lose an
   * update. Pass the host's queue — `assembleShim` has one — for the guarantee.
   */
  private locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const queue = this.deps.queue;
    if (queue === undefined) return task();
    return queue.runExclusivePath(this.dir.dataPath(id), task);
  }

  /** Is this key name a secret, for this plugin? Registry first, then name-shaped. */
  private secretTest(id: string): (key: string) => boolean {
    const secrets = new Set(this.registry[id]?.secret_keys ?? []);
    return (key: string): boolean => secrets.has(key) || SECRET_SHAPED.test(key);
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
 * The document with every secret-named key's subtree withheld, at any depth.
 *
 * `paths` is filled in document order with the dotted path of each key that was
 * treated as a secret — whether or not `reveal` handed the value back, because
 * "which of these are credentials" is the question a caller holding plaintext
 * most needs answered.
 *
 * The walk does not descend into a key it has already withheld: the subtree is
 * the unit, so `googleCalendarSyncTokens` is one path rather than one per token
 * inside it, and a caller cannot reconstruct the bag's shape from the paths.
 */
function redactDocument(
  document: Record<string, unknown>,
  isSecret: (key: string) => boolean,
  reveal: boolean,
  paths: string[],
): Record<string, unknown> {
  const walkObject = (
    node: Record<string, unknown>,
    prefix: string,
    ancestors: Set<unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (isSecret(key)) {
        paths.push(path);
        out[key] = reveal ? value : REDACTED;
        continue;
      }
      out[key] = walkValue(value, path, ancestors);
    }
    return out;
  };
  const walkValue = (value: unknown, path: string, ancestors: Set<unknown>): unknown => {
    // A JSON document has no cycles, and both callers hand over one — but `set`
    // is also reachable in-process with an object literal, and a stack overflow
    // is a worse answer to a cyclic one than leaving it for `JSON.stringify` to
    // refuse by name.
    if (typeof value === "object" && value !== null) {
      if (ancestors.has(value)) return value;
      const inner = new Set(ancestors).add(value);
      if (Array.isArray(value)) {
        return value.map((entry, index) => walkValue(entry, `${path}.${String(index)}`, inner));
      }
      return walkObject(value as Record<string, unknown>, path, inner);
    }
    return value;
  };
  return walkObject(document, "", new Set([document]));
}

/**
 * The dotted path at which this patch value writes the literal `[redacted]`
 * into a key that would be withheld, or `null` when it does not.
 *
 * The first hit in document order, because one is enough to refuse the key and
 * a caller fixing it will re-read anyway.
 */
function redactedValuePath(
  key: string,
  value: unknown,
  isSecret: (key: string) => boolean,
): string | null {
  const walk = (name: string, node: unknown, path: string, ancestors: Set<unknown>): string | null => {
    if (isSecret(name) && node === REDACTED) return path;
    if (typeof node !== "object" || node === null || ancestors.has(node)) return null;
    const inner = new Set(ancestors).add(node);
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) {
        // An array index is not a key name, so the element itself is never a
        // secret by name — only the keys inside it can be.
        const hit = walk("", entry, `${path}.${String(index)}`, inner);
        if (hit !== null) return hit;
      }
      return null;
    }
    for (const [childKey, childValue] of Object.entries(node as Record<string, unknown>)) {
      const hit = walk(childKey, childValue, `${path}.${childKey}`, inner);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(key, value, key, new Set());
}

/** Freeze an object and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
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
