/**
 * The socket's trust model, asserted in the order the layers actually hold the
 * door.
 *
 * **The directory mode is the enforcement layer.** A `0700` directory is what
 * stops another user reaching the socket at all, on every Unix, because
 * traversal needs execute permission on the directory. The socket's own `0600`
 * is defense in depth and may be advisory: Darwin and the BSDs historically
 * ignore permission bits on an `AF_UNIX` socket at `connect()` time, and Darwin
 * is the platform this host is developed on. The nonce is the portable stand-in
 * for the peer-UID check Node cannot make without a native addon.
 *
 * The genuine cross-UID half cannot run unattended and lives in
 * `server-uid.manual.test.ts`.
 */

import { connect } from "node:net";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

/**
 * Write one line to the socket and resolve with the first line that comes back.
 *
 * Deliberately not a {@link HostTestClient}: these cases are about what an
 * *unauthenticated* peer is told, and the harness's client presents the nonce
 * for you.
 */
const speak = (path: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        socket.destroy();
        resolve(buffer.slice(0, newline));
      }
    });
    socket.on("close", () => {
      if (!buffer.includes("\n")) resolve(buffer);
    });
    socket.on("error", reject);
  });

const request = (method: string, params: unknown): string =>
  JSON.stringify({ version: 1, id: "x", request: { method, params } });

describe("host socket security", () => {
  it("asserts 0700 on the directory and 0600 on the socket", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    } finally {
      await harness.stop();
    }
  });

  it("refuses to listen when the socket directory is group-writable", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      harness.chmodSocketDir(0o770);
      await expect(harness.server.listen()).rejects.toThrow(/socket directory mode/);
    } finally {
      // Back to something removable, so the harness teardown is not the thing
      // that fails when the assertion above already has.
      harness.chmodSocketDir(0o700);
      await harness.stop();
    }
  });

  it("refuses a connection that cannot present the ownership nonce", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const reply = await speak(socketPath, request("host.hello", { nonce: "wrong" }));
      expect(JSON.parse(reply)).toMatchObject({
        outcome: { status: "err", value: { code: "not_owner" } },
      });
      expect(harness.server.clientCount()).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it("refuses any op before hello", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const reply = await speak(socketPath, request("host.list_commands", {}));
      expect(JSON.parse(reply)).toMatchObject({
        outcome: { status: "err", value: { code: "not_owner" } },
      });
      expect(harness.server.clientCount()).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it("admits a connection presenting the nonce from the 0600 file", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      expect(statSync(harness.noncePath()).mode & 0o777).toBe(0o600);
      const reply = await speak(socketPath, request("host.hello", { nonce: harness.readNonce() }));
      expect(JSON.parse(reply)).toMatchObject({
        outcome: { status: "ok", value: { type: "host.hello" } },
      });
    } finally {
      await harness.stop();
    }
  });

  it("refuses a second hello on a connection that already said it", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.server.listen();
      const client = await harness.connectClient();
      await expect(client.call("host.hello", { nonce: harness.readNonce() })).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.stop();
    }
  });
});
