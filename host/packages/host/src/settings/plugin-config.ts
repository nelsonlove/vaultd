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
 * `redacted_keys` names it by a **{@link ConfigPath}**: one segment per hop,
 * with a number for an array index (`["nested","deep","apiToken"]`,
 * `["accounts",0,"refreshToken"]`, `["apiAuthToken"]` for a top-level key). A
 * path is an array rather than a dotted string because a key name may contain a
 * dot: `{"a.b":{apiToken}}` and `{"a":{"b":{apiToken}}}` are two documents one
 * string spells one way, and a client highlighting the field a refusal names
 * cannot recover from that. It is the daemon's own `key_path` grammar.
 *
 * A fallback that only looked at depth zero would offer a floor that is not
 * there: the audited corpus's four
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
 *   the user's real token, with no history and no way back. The row carries the
 *   top-level `key` and a `path` to where the placeholder actually is, and the
 *   rest of the patch still lands.
 *
 * A **fifth** failure is not a refusal row at all: a document or a patch nested
 * deeper than {@link MAX_CONFIG_DEPTH} throws {@link PluginDataTooDeep} from
 * either call, because neither walk can answer for a document it did not finish
 * reading. See that class for why failing closed is the only safe direction.
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

/**
 * Where a value sits in a settings document: one segment per hop, a **number**
 * for an array index.
 *
 * The daemon's own `patch_frontmatter` `key_path` grammar (Task 1e), for the
 * reason that grammar exists: it is injective, and a dotted string is not. A
 * plugin may name a key `"a.b"` — path-keyed maps, `"folder/note.md"`, a
 * `"section.field"` setting — and `{"a.b":{apiToken}}` and
 * `{"a":{"b":{apiToken}}}` are two different documents that dot-joining spells
 * the same way. A client acting on a path (highlighting the field a refusal
 * names) cannot recover from that ambiguity, and escaping the separator only
 * moves it.
 */
export type ConfigPath = Array<string | number>;

/** How deep a settings document or a patch may be. See {@link PluginDataTooDeep}. */
export const MAX_CONFIG_DEPTH = 64;

export type RefusalReason = "state_key" | "unknown_key" | "type_mismatch" | "redacted_value";

export interface PluginConfigView {
  values: Record<string, unknown>;
  schema: CachedSchema;
  /**
   * The {@link ConfigPath} of everything this answer treats as secret, in
   * document order.
   *
   * A top-level key is a one-segment path (`["apiAuthToken"]`); a nested one
   * carries every hop (`["nested","deep","apiToken"]`), and an array element
   * carries its index as a **number** (`["accounts",0,"refreshToken"]`). Named
   * for what it does in the guarded answer, and reported in the revealed one
   * too: a caller that asked for the plaintext still needs to know which of the
   * values it is now holding are credentials.
   */
  redacted_keys: ConfigPath[];
  /** The keys `set` will refuse, from the registry. */
  state_keys: string[];
}

export interface ConfigRefusal {
  /** Always the **top-level** patch key, whatever depth the reason was found at. */
  key: string;
  reason: RefusalReason;
  /**
   * Where the reason actually is, when it is not the key itself.
   *
   * Carried by `redacted_value`, whose cause can be a leaf several hops down;
   * the other three reasons are properties of the top-level key and carry
   * nothing. `key` stays the addressable thing — it is what the caller sent and
   * what it would re-send — and the path is the detail beside it, so a client
   * that ignores `path` still has a well-formed answer.
   */
  path?: ConfigPath;
}

export interface PluginConfigWrite {
  applied: string[];
  refused: ConfigRefusal[];
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

/**
 * A settings document or a patch nested deeper than {@link MAX_CONFIG_DEPTH}.
 *
 * **A throw, in the same family as {@link PluginDataTooLarge}, and not a
 * per-key refusal**: the two walks that meet this are the redactor and the
 * `[redacted]` scan, and neither can answer for a document it did not finish
 * reading. Failing closed is the only safe direction for a redactor — serving
 * the half it inspected with the other half attached is how a credential
 * reaches a socket — and `set` refuses before the lock and before any write, so
 * the file on disk is untouched.
 *
 * The budget exists at all because the walks would otherwise outrun the stack
 * long before `JSON.parse` complains: a plugin's own `saveData` will serialize a
 * 200,000-deep document quite happily, and the daemon stores bytes. Without a
 * budget, `get` would answer `RangeError: Maximum call stack size exceeded` for
 * ever on a file the plugin considers ordinary — the same failure the literal
 * `null` used to produce, one layer up.
 *
 * 64 because no settings document in the corpus comes close: the deepest is
 * quickadd at 11, and folder-notes and tasknotes sit at 3–4.
 */
export class PluginDataTooDeep extends Error {
  readonly code = "plugin_data_too_deep";
  /** Where the walk gave up, as far as it had got. */
  readonly path: ConfigPath;

  constructor(path: ConfigPath) {
    super(
      `this settings document is nested deeper than ${String(MAX_CONFIG_DEPTH)} levels, which is ` +
        "as far as this host inspects one. Nothing was read out and nothing was written, because " +
        `a document that cannot be inspected to the bottom cannot be redacted. Gave up at ` +
        `${path.map((segment) => String(segment)).join(" → ")}.`,
    );
    this.name = "PluginDataTooDeep";
    this.path = path;
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
    const paths: ConfigPath[] = [];
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
        refused.push({ key, reason: "redacted_value", path: redactedAt });
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
    // sometimes to save — which takes this same path lock. See `locked` for
    // what exactly deadlocks and what merely resolves late.
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
   *
   * **`runExclusivePath` is not re-entrant** (Task 7's design: it is a promise
   * chain per path, and a second acquire waits on the first). Two things follow
   * and both are deliberate. Nothing inside this task may take the lock again —
   * the task here reads and writes through `HeadlessConfigDir`, which does not.
   * And `onExternalSettingsChange` is called **after** this returns, outside the
   * lock, because a plugin's natural answer to "your file changed" is to re-read
   * and save, and a `saveData` from inside the handler takes this same lock.
   *
   * Stated precisely, because the margin is narrower than it looks: today
   * {@link PluginConfigService.notify} does not await what the handler returns,
   * so a handler that saves would resolve late rather than hang even if the
   * notify ran inside the window. What deadlocks — for ever, not late — is any
   * holder of this path's lock that **awaits** a `saveData` inside it. Calling
   * the handler outside the lock is what keeps this service from becoming one
   * the day someone decides an `async onExternalSettingsChange` deserves to be
   * awaited, which is a change that should not have to re-derive this.
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
 * `paths` is filled in document order with the {@link ConfigPath} of each key
 * that was treated as a secret — whether or not `reveal` handed the value back,
 * because "which of these are credentials" is the question a caller holding
 * plaintext most needs answered.
 *
 * The walk does not descend into a key it has already withheld: the subtree is
 * the unit, so `googleCalendarSyncTokens` is one path rather than one per token
 * inside it, and a caller cannot reconstruct the bag's shape from the paths.
 *
 * **Throws {@link PluginDataTooDeep} past {@link MAX_CONFIG_DEPTH}, rather than
 * serving what it did not inspect.** A redactor that cannot see to the bottom of
 * a document must not answer it: the one thing worse than refusing a settings
 * file is handing back the half of it that was checked with the other half
 * attached. The budget is also what makes the recursion bounded — see the
 * constant.
 */
function redactDocument(
  document: Record<string, unknown>,
  isSecret: (key: string) => boolean,
  reveal: boolean,
  paths: ConfigPath[],
): Record<string, unknown> {
  // **One mutable stack, pushed and popped**, rather than a fresh `Set` per
  // level: copying the ancestors at every object node made the walk quadratic
  // in depth for a guard that only ever asks "is this node on the path I am
  // standing on".
  const ancestors = new Set<unknown>([document]);
  const path: Array<string | number> = [];
  const walkObject = (node: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      path.push(key);
      if (isSecret(key)) {
        paths.push([...path]);
        out[key] = reveal ? value : REDACTED;
      } else {
        out[key] = walkValue(value);
      }
      path.pop();
    }
    return out;
  };
  const walkValue = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    // A JSON document has no cycles, and `get`'s always is one — but `set` is
    // also reachable in-process with an object literal, and a stack overflow is
    // a worse answer to a cyclic one than leaving it for `JSON.stringify` to
    // refuse by name.
    if (ancestors.has(value)) return value;
    if (path.length >= MAX_CONFIG_DEPTH) throw new PluginDataTooDeep([...path]);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) => {
          path.push(index);
          try {
            return walkValue(entry);
          } finally {
            path.pop();
          }
        });
      }
      return walkObject(value as Record<string, unknown>);
    } finally {
      ancestors.delete(value);
    }
  };
  return walkObject(document);
}

/**
 * The {@link ConfigPath} at which this patch value writes the literal
 * `[redacted]` into a key that would be withheld, or `null` when it does not.
 *
 * The first hit in document order, because one is enough to refuse the key and
 * a caller fixing it will re-read anyway.
 *
 * **Under a secret-named key the whole subtree is suspect**, not just the node
 * the name sits on. `get` withholds that subtree as one scalar, so a client
 * round-tripping a read sends a string and is caught by the first test — but a
 * client that reconstructs the shape by hand (`{apiTokens: ["[redacted]",
 * "[redacted]"]}`) is writing the placeholder into the same credential, and the
 * guard exists for the value rather than for the shape it arrives in.
 *
 * Throws {@link PluginDataTooDeep} past the budget, like its sibling: a patch
 * this walk cannot finish is one `set` must not apply.
 */
function redactedValuePath(
  key: string,
  value: unknown,
  isSecret: (key: string) => boolean,
): ConfigPath | null {
  const ancestors = new Set<unknown>();
  const path: Array<string | number> = [];
  /** The children of an object or array, or `null` for a leaf or a cycle. */
  const childrenOf = (node: unknown): Array<[string | number, unknown]> | null => {
    if (typeof node !== "object" || node === null || ancestors.has(node)) return null;
    return Array.isArray(node)
      ? node.map((entry, index): [string | number, unknown] => [index, entry])
      : Object.entries(node as Record<string, unknown>);
  };
  /** Visit every child in order, with its segment pushed. */
  const each = (
    node: unknown,
    entries: Array<[string | number, unknown]>,
    visit: (segment: string | number, child: unknown) => ConfigPath | null,
  ): ConfigPath | null => {
    if (path.length >= MAX_CONFIG_DEPTH) throw new PluginDataTooDeep([...path]);
    ancestors.add(node);
    try {
      for (const [segment, child] of entries) {
        path.push(segment);
        try {
          const hit = visit(segment, child);
          if (hit !== null) return hit;
        } finally {
          path.pop();
        }
      }
      return null;
    } finally {
      ancestors.delete(node);
    }
  };
  /** Anywhere at or under a node that is already known to be a secret's value. */
  const findRedacted = (node: unknown): ConfigPath | null => {
    if (node === REDACTED) return [...path];
    const entries = childrenOf(node);
    if (entries === null) return null;
    return each(node, entries, (_segment, child) => findRedacted(child));
  };
  /** Looking for a secret-named key. An array index is never one. */
  const scan = (name: string | number, node: unknown): ConfigPath | null => {
    if (typeof name === "string" && isSecret(name)) return findRedacted(node);
    const entries = childrenOf(node);
    if (entries === null) return null;
    return each(node, entries, scan);
  };
  path.push(key);
  return scan(key, value);
}

/**
 * Freeze an object and everything reachable from it.
 *
 * Iterative, with its own stack: nothing under `settings/` walks a structure by
 * unbounded recursion, and "it only ever sees a checked-in file three levels
 * deep" is an argument that stops being true the day someone points it at
 * something else.
 */
function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null || Object.isFrozen(node)) continue;
    Object.freeze(node);
    // The frozen check above is also the cycle guard: a node already frozen is
    // never pushed a second time.
    for (const entry of Object.values(node as Record<string, unknown>)) pending.push(entry);
  }
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
