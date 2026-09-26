/**
 * The daemon socket path rule, and the probe that asks whether one is there.
 *
 * Two halves of one contract. The path rule is restated from the daemon's own
 * `crates/vault-server/src/listener.rs` rather than imported — two processes,
 * two languages — so both sides pin it against the same fixed vector: if they
 * ever disagree, `engine: "auto"` spawns a second daemon beside a perfectly
 * good one and neither process notices.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupScratchRoots, scratchRoot } from "./scratch";
import { probeEngineSocket } from "../src/engine-probe";
import { systemClock, vaultdSocketPathFor } from "../src/config";

afterEach(() => {
  cleanupScratchRoots();
});

/**
 * A response envelope on one line, the shape `vault_protocol` serializes.
 *
 * `status` is a parameter because "answering is the test, not answering well":
 * an `err` outcome is exactly as alive as an `ok` one.
 */
function responseLine(status: "ok" | "err"): string {
  const outcome =
    status === "ok"
      ? { status: "ok", value: { type: "health", value: { service: "vaultd", status: "ok" } } }
      : { status: "err", value: { code: "incompatible_version", message: "version 2" } };
  return `${JSON.stringify({ version: 1, id: "vaultd-probe", outcome })}\n`;
}

/**
 * A listener at a short path under `target/tmp`, with every accepted socket
 * held so the case can destroy them.
 *
 * The path is short on purpose: a Unix socket address is capped near 104 bytes
 * on Darwin and this worktree's own path is most of that, so the scratch prefix
 * and the file name are both as short as they can be while still naming what
 * made them.
 */
async function listenAt(
  prefix: string,
  onConnection: (socket: Socket, held: Socket[]) => void,
): Promise<{ path: string; close: () => Promise<void> }> {
  const root = scratchRoot(prefix);
  const path = join(root, "s.sock");
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
    onConnection(socket, held);
  });
  await new Promise<void>((settle, fail) => {
    server.once("error", fail);
    server.listen(path, settle);
  });
  return {
    path,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((settle) => server.close(() => settle()));
    },
  };
}

describe("the daemon socket path", () => {
  it("is the digest rule the daemon's own listener applies", () => {
    // The same vector as
    // `crates/vault-server/src/listener.rs`'s
    // `the_digest_is_sixteen_hex_characters_of_sha256_of_the_root`, which pins
    // the digest of this exact string. Recompute with:
    //   printf '%s' /vaults/example | shasum -a 256
    const expected = createHash("sha256").update("/vaults/example").digest("hex").slice(0, 16);
    expect(expected).toBe("d19f29498912d9a3");

    const path = vaultdSocketPathFor("/vaults/example");
    expect(path.endsWith(`/${expected}.sock`)).toBe(true);
    // Not a digest of anything else — `sha256("example")`, say, whose first
    // sixteen characters are `50d858e0985ecc7f`.
    expect(path.endsWith("/50d858e0985ecc7f.sock")).toBe(false);
    expect(/\/[0-9a-f]{16}\.sock$/.test(path)).toBe(true);
  });

  it("prefers XDG_RUNTIME_DIR and falls back to the cache directory", () => {
    const runtime = process.env.XDG_RUNTIME_DIR;
    const cache = process.env.XDG_CACHE_HOME;
    try {
      process.env.XDG_RUNTIME_DIR = "/run/user/501";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/run/user/501/vaultd/")).toBe(true);
      delete process.env.XDG_RUNTIME_DIR;
      process.env.XDG_CACHE_HOME = "/home/x/.cache";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/home/x/.cache/vaultd/run/")).toBe(
        true,
      );
      // Set but empty is the same as unset, which is the daemon's
      // `run_dir_from(Some(directory), _) if !directory.is_empty()`.
      process.env.XDG_RUNTIME_DIR = "";
      expect(vaultdSocketPathFor("/vaults/example").startsWith("/home/x/.cache/vaultd/run/")).toBe(
        true,
      );
    } finally {
      if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = runtime;
      if (cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = cache;
    }
  });

  it("is not the host's own socket path", () => {
    expect(vaultdSocketPathFor("/vaults/example").endsWith("host.sock")).toBe(false);
  });
});

describe("probeEngineSocket", () => {
  it("answers true when something speaks the protocol there", async () => {
    const server = await listenAt("p-ok-", (socket) => {
      socket.once("data", () => socket.write(responseLine("ok")));
    });
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 2_000);
      expect(result.answered).toBe(true);
      expect(result.ms).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it("answers true for an error envelope, because answering is the test", async () => {
    // A daemon one protocol version ahead replies `incompatible_version` and is
    // exactly as alive as one replying `ok`. Requiring `ok` would hand a
    // working daemon's socket to whichever process probed it the day
    // `PROTOCOL_VERSION` moves — the daemon's own `something_answers` keeps
    // this rule and so must this.
    const server = await listenAt("p-err-", (socket) => {
      socket.once("data", () => socket.write(responseLine("err")));
    });
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 2_000);
      expect(result.answered).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("answers false for a path with nothing at it, without throwing", async () => {
    const root = scratchRoot("p-absent-");
    const result = await probeEngineSocket(join(root, "s.sock"), systemClock(), 250);
    expect(result.answered).toBe(false);
    expect(result.ms).toBe(0);
  });

  it("answers false when the peer accepts and then says nothing", async () => {
    const server = await listenAt("p-mute-", () => {
      // Held open, never written to: the read deadline is the only way out.
    });
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 250);
      expect(result.answered).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("answers false when the peer hangs up without a line", async () => {
    const server = await listenAt("p-eof-", (socket) => socket.end());
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 2_000);
      expect(result.answered).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("answers false when the line is not JSON at all", async () => {
    // Some unrelated program holding this path and greeting its callers is not
    // a vaultd, and is as stale as an empty file.
    const server = await listenAt("p-junk-", (socket) => {
      socket.once("data", () => socket.write("HELO not-a-vaultd\n"));
    });
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 2_000);
      expect(result.answered).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("answers false for JSON that is not a response envelope", async () => {
    const server = await listenAt("p-json-", (socket) => {
      socket.once("data", () => socket.write(`${JSON.stringify({ version: 1, hello: true })}\n`));
    });
    try {
      const result = await probeEngineSocket(server.path, systemClock(), 2_000);
      expect(result.answered).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("answers false for a path that is not a socket at all", async () => {
    const root = scratchRoot("p-dir-");
    const directory = join(root, `d-${randomUUID().slice(0, 4)}`);
    mkdirSync(directory);
    const result = await probeEngineSocket(directory, systemClock(), 250);
    expect(result.answered).toBe(false);
  });
});
