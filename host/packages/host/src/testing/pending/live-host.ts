/**
 * A **real** `vaultd` child and a **real** host over a real vault on disk: the
 * harness Task 22 drives.
 *
 * **Not yet activated.** Written for `src/testing/live-host.ts`, with its
 * imports spelled for that home. Task 22's Step 1 moves it:
 *
 * ```
 * git mv src/testing/pending/live-host.ts src/testing/live-host.ts
 * ```
 *
 * Everything else in the harness family fakes the daemon, and that is right for
 * a test about the host's own behaviour: a fake answers instantly, in an order
 * the test chose, and never flakes. This one fakes nothing, and that is right
 * for the last task's question, which is not "does the host behave" but "do the
 * two halves actually fit". The two kinds of test are complementary and neither
 * substitutes for the other.
 *
 * It writes only inside the vault root it is given — a temporary directory the
 * caller made and removes — plus the host's own data directory, which is
 * redirected into that same root so a live test can never touch the developer's
 * real `$XDG_STATE_HOME`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

import { assembleShim } from "./assemble";
import { workspaceRoot } from "./fixture-vault";
import { fs } from "../runtime/fs-access";
import { VaultdClient } from "../client/client";
import { Mirror } from "../mirror/mirror";
import { defaultHostConfig, systemClock } from "../config";
import { HostServer } from "../server/server";
import { QuarantineTracker } from "../runtime/quarantine";
import type { HostConfig } from "../config";
import type { App } from "../shim/app";
import type { Harvest } from "../shim/harvest";

export interface LiveHostSpec {
  vaultRoot: string;
  installPlugin?: { id: string; from: string };
  data?: Record<string, unknown>;
  config?: Partial<HostConfig>;
}

export class LiveHost {
  private constructor(
    private readonly engine: ChildProcess,
    private readonly client: VaultdClient,
    private readonly mirror: Mirror,
    private readonly server: HostServer,
    private readonly assembly: ReturnType<typeof assembleShim>,
    private readonly quarantineTracker: QuarantineTracker,
  ) {}

  static async start(spec: LiveHostSpec): Promise<LiveHost> {
    const config: HostConfig = {
      ...defaultHostConfig(spec.vaultRoot),
      // Both of the host's writable places move inside the fixture vault, so a
      // live test cannot reach the developer's own state directory.
      dataDir: join(spec.vaultRoot, ".vaultd-host-state"),
      socketPath: join(spec.vaultRoot, ".vaultd-host-state", "host.sock"),
      vaultdBinary: liveBinary(),
      clock: systemClock(),
      ...spec.config,
    };
    fs.mkdirSync(config.dataDir, { recursive: true });

    if (spec.installPlugin !== undefined) {
      installPlugin(config, spec.installPlugin.id, spec.installPlugin.from);
    }
    if (spec.data !== undefined && spec.installPlugin !== undefined) {
      const dir = join(config.dataDir, "plugins", spec.installPlugin.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, "data.json"), JSON.stringify(spec.data), "utf8");
    }

    const engine = spawn(config.vaultdBinary, [...config.vaultdArgs], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...config.env },
    });
    if (engine.stdin === null || engine.stdout === null) {
      throw new Error("the engine was spawned without pipes");
    }
    // Declared before the client because the client's event callback feeds the
    // mirror, and the mirror cannot be opened without a client. The callback
    // does not run until both exist.
    let mirror: Mirror | null = null;
    const client = new VaultdClient({
      stdout: engine.stdin,
      stdin: engine.stdout,
      onEvent: (event) => {
        void mirror?.applyEvent(event);
      },
      onFatal: () => {},
      onHandlerError: () => {},
    });
    mirror = await Mirror.open(() => client, config);

    const assembly = assembleShim({ config, client, mirror, clock: config.clock });
    const quarantine = new QuarantineTracker({ config, clock: config.clock });
    const server = new HostServer({ config, clock: config.clock, broker: assembly.api.broker });
    await server.start({ wireLateOps: true });
    return new LiveHost(engine, client, mirror, server, assembly, quarantine);
  }

  /**
   * A live host with one plugin written straight into the config zone.
   *
   * The golden plugins are small on purpose: a compatibility claim proved by a
   * plugin this repository wrote is weaker than one proved by a plugin it did
   * not, so these exist to prove the *mechanism* and the real-plugin corpus
   * proves the claim.
   */
  static async startWithGoldenPlugin(
    id: string,
    files: Record<string, string>,
  ): Promise<LiveHost> {
    const temporary = join(workspaceRoot(), "target", "tmp");
    fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(join(temporary, "live-host-"));
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      fs.mkdirSync(dirnameOf(full), { recursive: true });
      fs.writeFileSync(full, contents, "utf8");
    }
    return LiveHost.start({ vaultRoot: root, installPlugin: { id, from: root } });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }

  /**
   * Resolve when the mirror has applied everything in flight.
   *
   * The daemon publishes a generation before the host has applied it, so a live
   * test that asserted right after a write would be asserting on the moment
   * between the two. This waits for the host's own queue to drain rather than
   * for a duration — there are no sleeps in this file.
   *
   * **`Mirror.settled()` does not exist yet.** Task 6's mirror serialises every
   * application through one private FIFO and exposes no way to await it, so
   * Task 22 either adds that one method or drains the queue by enqueueing a
   * no-op behind whatever is in flight. Naming it here rather than sleeping is
   * deliberate: a sleep would pass on this machine and flake on a slower one.
   */
  async quiesce(): Promise<void> {
    await this.mirror.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  app(): App {
    return this.assembly.app;
  }

  harvest(): Harvest {
    return this.assembly.harvest;
  }

  quarantine(): QuarantineTracker {
    return this.quarantineTracker;
  }

  /** Every unsupported-API symbol a plugin touched, with who touched it. */
  unsupportedHits(): readonly { symbol: string; pluginId: string | null }[] {
    return this.assembly.policyRecorder.unsupportedHits();
  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.client.close();
    this.engine.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.engine.once("exit", () => {
        resolve();
      });
    });
  }
}

/**
 * The release binary beside the workspace.
 *
 * Named rather than resolved through `PATH`: a live test must exercise *this*
 * build, and a `vaultd` that happened to be installed elsewhere would make a
 * green run mean nothing.
 *
 * Anchored on {@link workspaceRoot}, never `process.cwd()`. Under vitest the
 * working directory is `host/`, so `process.cwd()` would name
 * `host/target/release/vaultd` — a path that does not exist, which is the worst
 * available failure for a file whose whole point is running *this* build.
 */
function liveBinary(): string {
  return join(workspaceRoot(), "target", "release", "vaultd");
}

function installPlugin(config: HostConfig, id: string, from: string): void {
  const target = join(config.vaultRoot, config.configDirName, "plugins", id);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(join(from, entry.name), join(target, entry.name));
  }
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}
