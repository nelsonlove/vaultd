import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VaultdClient, VaultdError } from "../src/client/client";
import { LineFramer } from "../src/client/framing";
import type { GetVaultInfoResponse, HealthResponse } from "../src/client/protocol";

/**
 * The one test in this task that talks to the **real** daemon.
 *
 * Everything else here is proved against `FakeDaemon`, which is fast, exact,
 * and entirely under this repository's control — which is also its weakness:
 * a fake agrees with whatever the client believes. The envelope is the thing
 * that must be right byte-for-byte, so this file asserts it against the shipped
 * Rust: the request line this client encodes is a line `vaultd` accepts, and
 * the response line `vaultd` writes is a line this client decodes.
 *
 * Health-only mode (no `--vault`) is enough and is the cheapest surface: it
 * starts no runtime, takes no lease, touches no filesystem, and still answers
 * one success, one typed refusal, and one version rejection.
 *
 * The binary is a Rust build artifact and is not in the repository. **Its
 * absence fails this file**, loudly, rather than skipping: these five cases are
 * the only wire truth in the whole client, and a green run with them silently
 * gone is a green run that proved nothing about the envelope. A TypeScript-only
 * checkout opts out deliberately with `VAULTD_ALLOW_MISSING_BINARY=1`, which is
 * a decision someone has to make on purpose and which CI must not set.
 *
 * Build it with `cargo build --release --bin vaultd`.
 */
const BINARY = resolve(__dirname, "..", "..", "..", "..", "target", "release", "vaultd");
const BINARY_EXISTS = existsSync(BINARY);
const ALLOW_MISSING = process.env.VAULTD_ALLOW_MISSING_BINARY === "1";

if (!BINARY_EXISTS && ALLOW_MISSING) {
  console.warn(
    `[client-real-daemon] skipping under VAULTD_ALLOW_MISSING_BINARY=1: ${BINARY} is absent. Build it with \`cargo build --release --bin vaultd\`.`,
  );
}

describe("the real vaultd binary", () => {
  it("is built, or its absence was opted into on purpose", () => {
    expect(
      BINARY_EXISTS || ALLOW_MISSING,
      `${BINARY} is absent, so the only tests that check this client against the real wire cannot run. ` +
        "Build it with `cargo build --release --bin vaultd`, or set VAULTD_ALLOW_MISSING_BINARY=1 to skip them deliberately.",
    ).toBe(true);
  });
});

/** A spawned `vaultd`, with a line rendezvous over its stdout. */
class RealDaemon {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly waiters: Array<{ count: number; resolve: (lines: string[]) => void }> = [];
  private buffered = "";

  constructor(observeStdout: boolean) {
    this.child = spawn(BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
    if (!observeStdout) return;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf("\n");
      while (newline !== -1) {
        this.lines.push(this.buffered.slice(0, newline));
        this.buffered = this.buffered.slice(newline + 1);
        newline = this.buffered.indexOf("\n");
      }
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]!;
        if (this.lines.length >= waiter.count) {
          this.waiters.splice(i, 1);
          waiter.resolve(this.lines.slice(0, waiter.count));
        }
      }
    });
  }

  write(text: string): void {
    this.child.stdin.write(text);
  }

  received(count: number): Promise<string[]> {
    if (this.lines.length >= count) return Promise.resolve(this.lines.slice(0, count));
    return new Promise((resolveLines) => {
      this.waiters.push({ count, resolve: resolveLines });
    });
  }

  kill(): void {
    this.child.kill();
  }
}

describe.skipIf(!BINARY_EXISTS)("the envelope this client encodes is the one vaultd answers", () => {
  let daemon: RealDaemon;

  beforeAll(() => {
    daemon = new RealDaemon(true);
  });

  afterAll(() => {
    daemon.kill();
  });

  it("round-trips a health request byte-for-byte", async () => {
    const encoded = LineFramer.encode({
      version: 1,
      id: "h-1",
      request: { method: "health" },
    });
    // The exact bytes, asserted before they are sent: no `params` key for a
    // unit-variant method, `version` first, `id` a string.
    expect(encoded.toString("utf8")).toBe('{"version":1,"id":"h-1","request":{"method":"health"}}\n');

    daemon.write(encoded.toString("utf8"));
    const [line] = await daemon.received(1);
    expect(line).toBe(
      '{"version":1,"id":"h-1","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}',
    );

    // And the framer reads back what the daemon wrote, unchanged.
    const framer = new LineFramer();
    const { frames, error } = framer.push(Buffer.from(`${line!}\n`, "utf8"));
    expect(error).toBeUndefined();
    expect(frames[0]).toEqual(JSON.parse(line!));
  });

  it("refuses a version this build does not speak, and names the one it does", async () => {
    daemon.write('{"version":2,"id":"h-2","request":{"method":"health"}}\n');
    const lines = await daemon.received(2);
    expect(lines[1]).toBe(
      '{"version":1,"id":"h-2","outcome":{"status":"err","value":{"code":"incompatible_version","message":"unsupported protocol version 2","supported_version":1}}}',
    );
  });
});

describe.skipIf(!BINARY_EXISTS)("VaultdClient against a real vaultd", () => {
  let daemon: RealDaemon;
  let client: VaultdClient;
  let fatal: Error | null = null;

  beforeAll(() => {
    daemon = new RealDaemon(false);
    client = new VaultdClient({
      stdout: daemon.child.stdout,
      stdin: daemon.child.stdin,
      onEvent: () => undefined,
      onFatal: (error) => {
        fatal = error;
      },
    });
  });

  afterAll(() => {
    client.close();
    daemon.kill();
  });

  it("resolves health with the unwrapped payload", async () => {
    const health = await client.request<HealthResponse>("health");
    expect(health).toEqual({ service: "vaultd", status: "ok" });
    expect(fatal).toBeNull();
  });

  it("rejects a refusal as a typed VaultdError", async () => {
    // Health-only mode: there is no vault, so every indexed operation is
    // `index_unavailable`.
    const pending = client.request<GetVaultInfoResponse>("get_vault_info");
    await expect(pending).rejects.toBeInstanceOf(VaultdError);
    await pending.catch((error: VaultdError) => {
      expect(error.code).toBe("index_unavailable");
      expect(error.currentGeneration).toBeNull();
      expect(error.message).toContain("no vault is configured");
    });
  });

  it("keeps serving after a refusal, and correlates a later request", async () => {
    await expect(client.request("write_note", { path: "x", content: "" })).rejects.toBeInstanceOf(
      VaultdError,
    );
    const health = await client.request<HealthResponse>("health");
    expect(health.service).toBe("vaultd");
    expect(client.pendingCount()).toBe(0);
  });
});
