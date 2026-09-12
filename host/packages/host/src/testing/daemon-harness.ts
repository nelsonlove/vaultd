/**
 * A `VaultdClient` wired to a {@link FakeDaemon}, plus the request/response
 * helpers every later harness inherits.
 *
 * This is Task 6b's `daemon-harness.ts`, built here because Task 6's mirror
 * tests are its first consumer. The shape is the one Task 6b specifies, so that
 * task finds it present rather than writing a second one beside it.
 *
 * Two things it is careful about, because both are how a harness quietly makes
 * a suite lie:
 *
 * - **Nothing sleeps.** `nextRequest()` resolves the moment the subject's line
 *   has been parsed, through {@link FakeDaemon.onRequest}. {@link quiesce}
 *   drains the event loop's immediate queue rather than waiting a chosen number
 *   of milliseconds.
 * - **A request answered by a `serve` hook is never handed out.** A test that
 *   asks for the next request gets the next one its *subject* decided to send
 *   and nobody else has already dealt with.
 */

import { VaultdClient } from "../client/client";
import { FakeDaemon } from "./fake-daemon";
import { defaultHostConfig } from "../config";
import { testClock } from "./clock";
import type { HostConfig } from "../config";
import type { TestClock } from "./clock";
import type { ProtocolErrorBody, RequestEnvelope, RuntimeEventDto } from "../client/protocol";

/** Answer a request, or decline it by returning false. */
export type RequestServer = (request: RequestEnvelope) => boolean;

export class DaemonHarness {
  readonly client: VaultdClient;
  readonly daemon: FakeDaemon;
  readonly config: HostConfig;
  readonly clock: TestClock;

  private readonly queued: RequestEnvelope[] = [];
  private readonly waiters: Array<(request: RequestEnvelope) => void> = [];
  private readonly methods: string[] = [];
  private readonly answered = new Set<string>();
  private readonly servers: RequestServer[] = [];
  private files: Record<string, string> = {};
  /** Paths that must answer `not_found` — see {@link unserveFile}. */
  private readonly absent = new Set<string>();
  private serving = false;
  private stopped = false;

  protected constructor(overrides: Partial<HostConfig> = {}) {
    this.clock = testClock();
    this.config = { ...defaultHostConfig("/vault"), clock: this.clock, ...overrides };
    this.daemon = new FakeDaemon();
    this.daemon.onRequest = (request): void => {
      this.take(request);
    };
    this.client = new VaultdClient({
      stdout: this.daemon.stdout,
      stdin: this.daemon.stdin,
      onEvent: () => {},
      onFatal: () => {},
      // Always passed: without it a throw out of an event handler is reported
      // as a fatal transport error, and a test's own assertion failure inside a
      // listener would look like the daemon died.
      onHandlerError: () => {},
    });
  }

  static create(overrides: Partial<HostConfig> = {}): DaemonHarness {
    return new DaemonHarness(overrides);
  }

  /** The next request the subject sent, awaited. Consumes it. */
  nextRequest(): Promise<RequestEnvelope> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise<RequestEnvelope>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * The next request, insisting on its method.
   *
   * A harness that answers the wrong request produces a hang whose message
   * names nothing. This turns that into a sentence.
   */
  async expectRequest(method: string): Promise<RequestEnvelope> {
    const request = await this.nextRequest();
    if (request.request.method !== method) {
      throw new Error(
        `expected the subject to send ${method}, and it sent ${request.request.method} ` +
          `(params ${JSON.stringify(request.request.params)}). Methods so far: ` +
          `${this.methods.join(", ")}`,
      );
    }
    return request;
  }

  /** Every request sent so far and not yet answered. Does not consume. */
  pendingRequests(): readonly RequestEnvelope[] {
    return this.queued.filter((request) => !this.answered.has(request.id));
  }

  /** Every method name the subject has sent, in order. */
  methodsSeen(): readonly string[] {
    return [...this.methods];
  }

  clearMethodLog(): void {
    this.methods.length = 0;
  }

  respondOk(id: string, type: string, value: unknown): void {
    this.answered.add(id);
    this.daemon.respondOk(id, type, value);
  }

  respondErr(id: string, body: ProtocolErrorBody): void {
    this.answered.add(id);
    this.daemon.respondErr(id, body);
  }

  /** `ReadFileResponse`'s real shape, so the base64 lives in exactly one place. */
  respondReadFile(id: string, content: string, revision: string): void {
    this.respondOk(id, "read_file", {
      content_base64: Buffer.from(content, "utf8").toString("base64"),
      revision,
    });
  }

  emit(subscriptionId: string, event: RuntimeEventDto): void {
    this.daemon.emit(subscriptionId, event);
  }

  /** Answer every `read_file` for a known fixture path automatically. */
  autoServeFiles(files: Record<string, string>): void {
    this.files = { ...this.files, ...files };
    for (const path of Object.keys(files)) this.absent.delete(path);
    this.installFileServer();
  }

  /**
   * Stop serving `path`, and answer `not_found` for it from now on.
   *
   * The counterpart {@link autoServeFiles} cannot be: that method **merges**, so
   * once a path has been served there is no argument to it that un-serves one.
   * And "absent" is a state a config-zone test genuinely needs — Obsidian
   * having no `community-plugins.json` at all is not the same claim as Obsidian
   * having one that enables nothing, and Task 14's coexistence cases turn on
   * exactly that difference.
   *
   * It answers rather than falls silent on purpose. A path simply forgotten
   * would drop through to the request queue, where nothing would answer it and
   * the subject would wait forever; the daemon's own answer for a file that is
   * not there is a `not_found` error, so that is what this gives.
   */
  unserveFile(path: string): void {
    const remaining = { ...this.files };
    delete remaining[path];
    this.files = remaining;
    this.absent.add(path);
    this.installFileServer();
  }

  /**
   * Install the `read_file` hook, once.
   *
   * Guarded by a flag rather than by "is the file map empty", which was wrong in
   * two directions: a first call that passed no files left the flag unset, so
   * the second call installed a second hook, and {@link unserveFile} emptying
   * the map would have done the same.
   */
  private installFileServer(): void {
    if (this.serving) return;
    this.serving = true;
    this.serve((request) => {
      if (request.request.method !== "read_file") return false;
      const path = (request.request.params as { path?: string } | undefined)?.path;
      if (path === undefined) return false;
      if (this.absent.has(path)) {
        this.respondErr(request.id, { code: "not_found", message: `${path} does not exist` });
        return true;
      }
      const content = this.files[path];
      if (content === undefined) return false;
      this.respondReadFile(request.id, content, revisionOfSource(content));
      return true;
    });
  }

  /** Register a hook that may answer a request before it is handed out. */
  serve(server: RequestServer): void {
    this.servers.push(server);
  }

  /**
   * Let everything already in flight settle.
   *
   * Three turns of the immediate queue, not a sleep: a request written by the
   * subject reaches {@link FakeDaemon} through a `PassThrough`, which delivers
   * on the next turn, and an assertion that "nothing was sent" needs that turn
   * to have happened or it proves nothing.
   */
  async quiesce(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.daemon.onRequest = null;
    this.client.close();
    this.daemon.endStdout();
    return Promise.resolve();
  }

  private take(request: RequestEnvelope): void {
    this.methods.push(request.request.method);
    for (const server of this.servers) {
      if (server(request)) return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(request);
    else this.queued.push(request);
  }
}

/** A stable stand-in revision for fixture bytes. Never a real blake3. */
export function revisionOfSource(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `blake3:fixture-${hash.toString(16).padStart(8, "0")}`;
}
