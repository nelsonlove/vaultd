/**
 * **The screen host**: the second host profile (docs/design/web-plugins.md,
 * section 2, "Where the server apply runs"; owner decision 1).
 *
 * Its own process beside the web server, never inside the headless host: the
 * headless host keeps its inert stub document on purpose. This one assembles
 * the same shim with happy-dom behind `document`, connects to `vaultd` the way
 * the headless host does, and loads **only the screen plugins** — today Style
 * Settings, and only when the vault's own `.obsidian/community-plugins.json`
 * enables it. It reads the vault's `.obsidian` (the GUI's directory) and never
 * writes there: the plugin's saves go to the `viewer` store, outside the vault.
 *
 * It answers one request, `screen.apply` (`apply-service.ts`), over its own
 * socket (`screen-server.ts`).
 *
 * **Its own clock for the plugin.** The assembly's timers run on a driven
 * clock that only the apply service moves, so the plugin's 100 ms debounce
 * costs no real wait and an apply is never cut by a timer firing half way.
 * The engine supervisor keeps the real clock.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BundleLoader } from "../runtime/loader";
import { DataDir } from "../datadir";
import { DaemonUnreachable } from "../host";
import { Mirror } from "../mirror/mirror";
import { OBSIDIAN_CONFIG_DIR } from "../pluginset/config-dir";
import { ScreenError, ScreenServer } from "./screen-server";
import { Supervisor } from "../supervisor";
import { VaultdError } from "../client/errors";
import { assembleShim } from "../testing/assemble";
import { createApplyService } from "./apply-service";
import { happyDomProvider } from "../shim/dom-providers/happy-dom";
import { installModuleInterception } from "../runtime/intercept";
import { drivenClock } from "../runtime/driven-clock";
import type { ApplyRequest, ApplyService } from "./apply-service";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";
import type { ReadFileResponse } from "../client/protocol";
import type { ServiceDocument } from "./apply-service";
import type { VaultdClient } from "../client/client";

/** The plugins this profile runs. Everything else in the vault is the headless host's. */
export const SCREEN_PLUGIN_IDS: readonly string[] = ["obsidian-style-settings"];

/** One `screen.apply` line can carry a whole theme; 64 MB is far past any real set. */
export const SCREEN_LINE_CAP_BYTES = 64 * 1024 * 1024;

/** `$XDG_STATE_HOME/vaultd-screen-host`: this host's own state, apart from the headless host's. */
export function screenDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-screen-host");
}

/** `<dataDir>/run/<vault digest>/screen.sock`. */
export function screenSocketPathFor(dataDir: string, vaultRoot: string): string {
  const digest = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 16);
  return join(dataDir, "run", digest, "screen.sock");
}

export interface ScreenHostOptions {
  /** The `viewer` store's state root. Default `$XDG_STATE_HOME/vaultd-web/plugin-data`. */
  readonly stateRoot?: string;
  readonly cacheLimit?: number;
  /** Bind the socket. Default `true`. */
  readonly listen?: boolean;
}

export interface RunningScreenHost {
  readonly config: HostConfig;
  readonly socketPath: string;
  /** The screen plugins that are loaded-on-demand, by id. Empty when none is enabled. */
  readonly plugins: readonly string[];
  /** The apply service, or `null` when no screen plugin is enabled. */
  readonly service: ApplyService | null;
  apply(request: ApplyRequest): Promise<{ classes: readonly string[]; style: string }>;
  stop(): Promise<void>;
}

/** Start a screen host over `config` (the headless host's config shape). */
export async function startScreenHost(config: HostConfig, options: ScreenHostOptions = {}): Promise<RunningScreenHost> {
  new DataDir(config.dataDir).ensureSecureDir(".");
  const supervisor = new Supervisor(config, {
    onClientReady: () => {},
    onEngineLost: () => {},
    onStateChange: () => {},
  });
  try {
    await supervisor.start();
    await supervisor.whenWatching();
  } catch (error) {
    await supervisor.stop();
    throw new DaemonUnreachable(error);
  }
  const clientOf = (): VaultdClient => supervisor.client();
  const mirror = await Mirror.open(clientOf, config);
  await supervisor.subscribe((event) => {
    void mirror.applyEvent(event).catch(() => undefined);
  });

  const clock = drivenClock(Date.now());
  const assembly = assembleShim({ config, client: clientOf, mirror, clock, dom: happyDomProvider() });
  const modulePaths = [resolve(__dirname, "..", "..", "..", "..", "node_modules")];
  const interception = installModuleInterception({
    hostModulePaths: modulePaths,
    allowNodeBuiltins: true,
    harvest: assembly.harvest,
  });
  const loader = new BundleLoader({
    app: assembly.app,
    queue: assembly.queue,
    events: assembly.events,
    harvest: assembly.harvest,
    errors: assembly.errors,
  });
  assembly.app.plugins.setLoader(loader);

  const read = async (path: string): Promise<string | null> => {
    try {
      const response = await clientOf().request<ReadFileResponse>("read_file", { path });
      return Buffer.from(response.content_base64, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof VaultdError && (error.code === "not_found" || error.code === "parent_not_found")) return null;
      throw error;
    }
  };

  const enabled = parseIds(await read(`${OBSIDIAN_CONFIG_DIR}/community-plugins.json`));
  const id = SCREEN_PLUGIN_IDS.find((candidate) => enabled.includes(candidate)) ?? null;
  let service: ApplyService | null = null;
  if (id !== null && assembly.globals.dom !== null) {
    const dir = `${OBSIDIAN_CONFIG_DIR}/plugins/${id}`;
    const manifestText = await read(`${dir}/manifest.json`);
    const source = await read(`${dir}/main.js`);
    if (manifestText !== null && source !== null) {
      const manifest = { ...(JSON.parse(manifestText) as PluginManifest), dir };
      service = createApplyService({
        app: assembly.app,
        loader,
        queue: assembly.queue,
        document: assembly.globals.dom.document as unknown as ServiceDocument,
        clock,
        bundle: {
          manifest,
          request: {
            pluginId: id,
            filename: join(config.vaultRoot, dir, "main.js"),
            source,
            hostModulePaths: modulePaths,
          },
        },
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        ...(options.cacheLimit === undefined ? {} : { cacheLimit: options.cacheLimit }),
      });
    }
  }
  const plugins = service === null || id === null ? [] : [id];

  const apply = async (request: ApplyRequest): Promise<{ classes: readonly string[]; style: string }> => {
    if (service === null) return { classes: [], style: "" };
    return service.apply(request);
  };

  const server = new ScreenServer({
    socketPath: config.socketPath,
    dataDir: config.dataDir,
    clock: config.clock,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    maxPreAuthConnections: config.maxPreAuthConnections,
    lineCapBytes: SCREEN_LINE_CAP_BYTES,
    hello: () => ({ protocol_version: 1, profile: "screen", vault_root: config.vaultRoot, plugins }),
    dispatch: async (method, params) => {
      switch (method) {
        case "screen.apply": {
          try {
            const result = await apply(params as ApplyRequest);
            return { classes: [...result.classes], style: result.style };
          } catch (error) {
            if (error instanceof TypeError) throw new ScreenError("invalid_request", error.message);
            throw error;
          }
        }
        case "screen.stats":
          return service?.stats() ?? { loads: 0, unloads: 0, hits: 0, misses: 0, size: 0 };
        default:
          throw new ScreenError("invalid_request", `the screen host has no method ${JSON.stringify(method)}`);
      }
    },
  });
  const socketPath = options.listen === false ? config.socketPath : await server.listen();

  let stopped = false;
  return {
    config,
    socketPath,
    plugins,
    service,
    apply,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // The order is the headless host's: the plugin first, then the socket,
      // the mirror, the process-wide state, and the engine last.
      await service?.close();
      await server.close();
      mirror.stop();
      interception.restore();
      await assembly.teardown();
      await supervisor.stop();
    },
  };
}

function parseIds(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
