/**
 * The screen host's socket: the headless host's envelope and trust model, with
 * the screen host's few methods behind it (`docs/protocol-host.md`, "The screen
 * host").
 *
 * **Same envelope.** One JSON object per line, UTF-8:
 * `{ version, id, request: { method, params } }` in, and
 * `{ version, id, outcome: { status, value } }` out, with `ok` values carrying
 * `{ type, value }` as the headless host's do.
 *
 * **Same door.** The socket lives in a directory this host creates `0700` and
 * refuses to listen in if it is anything else or owned by another uid; the
 * socket file is `chmod`ed `0600` (advisory on Darwin); and the first line on a
 * connection must be `host.hello` carrying the nonce from `<dataDir>/nonce`,
 * else the peer is told `not_owner` and the connection goes. A peer that says
 * nothing is closed at the handshake deadline, and past the pre-auth cap the
 * newest connection is closed. See `server/server.ts` for why each layer is
 * there; this is a smaller copy of the same rules, not a second design.
 *
 * Nothing is forwarded to `vaultd`: the screen host answers its own methods
 * only, and anything else is `invalid_request`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { basename, dirname } from "node:path";
import type { Server, Socket } from "node:net";

import { DataDir } from "../datadir";
import type { Clock } from "../config";

export const SCREEN_PROTOCOL_VERSION = 1;
const NONCE_FILE = "nonce";

/** A refusal with the wire's `{ code, message }`. */
export class ScreenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScreenError";
  }
}

export interface ScreenServerDeps {
  readonly socketPath: string;
  /** Where the nonce file is written. */
  readonly dataDir: string;
  readonly clock: Clock;
  readonly handshakeTimeoutMs: number;
  readonly maxPreAuthConnections: number;
  /** One line's cap, in bytes of UTF-8. A stylesheet set can be large. */
  readonly lineCapBytes: number;
  /** The answer to a good `host.hello`. */
  hello(): unknown;
  /** Answer one authenticated method; throw a {@link ScreenError} to refuse. */
  dispatch(method: string, params: unknown): Promise<unknown>;
}

export class ScreenServer {
  private server: Server | null = null;
  private nonce: Buffer | null = null;
  private readonly connections = new Set<Socket>();
  private readonly preAuth = new Set<Socket>();
  private readonly dataDir: DataDir;
  private readonly socketDir: DataDir;
  /** Connections closed before they authenticated: silent, or past the cap. */
  preAuthClosed = 0;

  constructor(private readonly deps: ScreenServerDeps) {
    this.dataDir = new DataDir(deps.dataDir);
    this.socketDir = new DataDir(dirname(deps.socketPath));
  }

  async listen(): Promise<string> {
    const { socketPath } = this.deps;
    const file = basename(socketPath);
    this.socketDir.ensureSecureDir(".");
    const found = this.socketDir.ownership(".");
    if (found === null || found.mode !== 0o700) {
      throw new Error(
        `refusing to listen: the socket directory ${dirname(socketPath)} is mode ` +
          `${(found?.mode ?? 0).toString(8)} rather than 700`,
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && found.uid !== uid) {
      throw new Error(`refusing to listen: the socket directory is owned by uid ${String(found.uid)}`);
    }
    if (this.socketDir.exists(file)) this.socketDir.remove(file);

    const server = createServer((socket) => {
      this.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.socketDir.chmod(file, 0o600);
    this.dataDir.ensureSecureDir(".");
    this.nonce = randomBytes(32);
    this.dataDir.writeSecret(NONCE_FILE, this.nonce.toString("hex"));
    return socketPath;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.preAuth.clear();
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    if (this.nonce !== null) {
      this.nonce = null;
      this.dataDir.remove(NONCE_FILE);
    }
  }

  private accept(socket: Socket): void {
    if (this.preAuth.size >= this.deps.maxPreAuthConnections) {
      this.preAuthClosed += 1;
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    this.preAuth.add(socket);
    let authenticated = false;
    let buffered = "";
    let bufferedBytes = 0;

    const deadline = this.deps.clock.setTimeout(() => {
      if (authenticated) return;
      this.preAuthClosed += 1;
      socket.destroy();
    }, this.deps.handshakeTimeoutMs);

    const write = (body: Record<string, unknown>): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ version: SCREEN_PROTOCOL_VERSION, ...body })}\n`);
    };
    const ok = (id: unknown, type: string, value: unknown): void => {
      write({ id: echoable(id), outcome: { status: "ok", value: { type, value } } });
    };
    const fail = (id: unknown, error: unknown): void => {
      write({ id: echoable(id), outcome: { status: "err", value: bodyOf(error) } });
    };

    const handle = async (line: string): Promise<void> => {
      const envelope = parseEnvelope(line);
      if (envelope === null) {
        socket.destroy();
        return;
      }
      const { id, version, method, params } = envelope;
      if (version !== SCREEN_PROTOCOL_VERSION) {
        fail(
          id,
          new ScreenError(
            "incompatible_version",
            `this host speaks protocol version ${String(SCREEN_PROTOCOL_VERSION)}`,
          ),
        );
        if (!authenticated) socket.end();
        return;
      }
      if (!authenticated) {
        const offered = isObject(params) ? params["nonce"] : undefined;
        if (method !== "host.hello" || typeof offered !== "string" || !this.authenticate(offered)) {
          fail(
            id,
            new ScreenError(
              "not_owner",
              "the first line on a host connection must be host.hello carrying the ownership nonce " +
                "from <dataDir>/nonce, which only this user can read",
            ),
          );
          socket.end();
          return;
        }
        authenticated = true;
        this.preAuth.delete(socket);
        this.deps.clock.clearTimeout(deadline);
        ok(id, "host.hello", this.deps.hello());
        return;
      }
      if (typeof method !== "string") {
        fail(id, new ScreenError("invalid_request", "every request carries a string method"));
        return;
      }
      if (method === "host.hello") {
        fail(id, new ScreenError("invalid_request", "this connection has already said hello"));
        return;
      }
      try {
        ok(id, method, await this.deps.dispatch(method, params));
      } catch (error) {
        fail(id, error);
      }
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      bufferedBytes += Buffer.byteLength(chunk, "utf8");
      if (bufferedBytes > this.deps.lineCapBytes) {
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() !== "") {
          void handle(line).catch((error: unknown) => {
            fail("", error);
            socket.destroy();
          });
        }
        newline = buffered.indexOf("\n");
      }
      bufferedBytes = Buffer.byteLength(buffered, "utf8");
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.deps.clock.clearTimeout(deadline);
      this.connections.delete(socket);
      this.preAuth.delete(socket);
    });
  }

  private authenticate(offered: string): boolean {
    if (this.nonce === null || !/^[0-9a-f]{64}$/.test(offered)) return false;
    return timingSafeEqual(Buffer.from(offered, "hex"), this.nonce);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(line: string): { version: unknown; id: unknown; method: unknown; params: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const request = parsed["request"];
  return {
    version: parsed["version"],
    id: parsed["id"],
    method: isObject(request) ? request["method"] : undefined,
    params: isObject(request) ? request["params"] : undefined,
  };
}

function echoable(id: unknown): string | number {
  return typeof id === "string" || typeof id === "number" ? id : "";
}

function bodyOf(error: unknown): { code: string; message: string } {
  if (error instanceof ScreenError) return { code: error.code, message: error.message };
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}
