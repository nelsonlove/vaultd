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
import type { Socket } from "node:net";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";
import { rejectionGuardArmed, reportUnhandledRejection } from "../src/server/server";

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

/** Every line the peer has been sent so far, split on the framing newline. */
function reader(socket: Socket, replies: string[]): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      replies.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
}

/**
 * Send some lines and resolve when the **host** closes the connection.
 *
 * No deadline and no sleep: the close is the event being asserted, so a host
 * that wrongly keeps the connection fails by the runner's own timeout rather
 * than by a number somebody guessed.
 */
const untilClose = (path: string, lines: string[]): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    const replies: string[] = [];
    let connected = false;
    reader(socket, replies);
    socket.on("connect", () => {
      connected = true;
      for (const line of lines) socket.write(`${line}\n`);
    });
    socket.on("close", () => {
      resolve(replies);
    });
    socket.on("error", (error) => {
      // **An `EPIPE` here is the host doing its job.** A line past the cap is
      // destroyed mid-write, so the rest of what this probe was sending has
      // nowhere to go — which is the assertion, not a failure of it. Only a
      // failure to reach the socket at all is this probe's problem.
      if (!connected) reject(error);
    });
  });

/**
 * Send some lines and resolve once `count` replies have come back.
 *
 * This is how "the connection was **kept**" is asserted without a deadline: ask
 * for a second answer on the same connection and wait for it. A host that closed
 * after the first would never send it.
 */
const untilReplies = (path: string, lines: string[], count: number): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    const replies: string[] = [];
    let buffer = "";
    socket.on("connect", () => {
      for (const line of lines) socket.write(`${line}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        replies.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (replies.length >= count) {
          socket.destroy();
          resolve(replies);
          return;
        }
      }
    });
    socket.on("error", reject);
  });

/**
 * A connected socket that says nothing at all, and a promise for the host
 * closing it.
 *
 * The peer the nonce gate could not reach: every other refusal in this file is
 * an answer to a line, and this one connects and then holds the socket open in
 * silence. The `close` promise is the assertion — there is no reply to wait for,
 * because a host that answered a silent peer would be telling it the socket is
 * there.
 */
const silentPeer = async (path: string): Promise<{ closed: Promise<void> }> => {
  const socket = connect(path);
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // Attached only after the connect: the host destroying this socket raises
  // `ECONNRESET` here, which is the assertion rather than a failure of it.
  socket.on("error", () => undefined);
  return { closed };
};

/**
 * Yield turns of the loop until `holds()` is true.
 *
 * A rendezvous on observable state, never a sleep — and with no deadline of its
 * own, so a host that never gets there fails by the runner's timeout rather than
 * by a number somebody guessed. A macrotask rather than an immediate, because
 * what is being waited for is a socket reaching the host's `accept` from the
 * poll phase.
 */
const until = async (holds: () => boolean): Promise<void> => {
  while (!holds()) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const outcomeOf = (line: string): { status: string; value: { code?: string } } =>
  (JSON.parse(line) as { outcome: { status: string; value: { code?: string } } }).outcome;

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

  it("destroys the connection on a line that is not a request at all", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    const rejections: unknown[] = [];
    const collect = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", collect);
    try {
      const socketPath = await harness.server.listen();
      // **`null` is the one that used to take the host down.** `JSON.parse`
      // answers `null`, reading `.id` off it throws a `TypeError`, and the
      // handler was invoked as a floating promise — so five bytes from a peer
      // that had presented no nonce became an unhandled rejection, which Node
      // terminates the process for. Every one of these is now the same fatal
      // input error a line of garbage already was: no reply, connection gone.
      for (const line of ["null", "5", '"x"', "[]", "{not json"]) {
        expect(await untilClose(socketPath, [line]), `for ${line}`).toEqual([]);
      }
      expect(rejections).toEqual([]);
      expect(harness.server.clientCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", collect);
      await harness.stop();
    }
  });

  it("destroys an unauthenticated connection after one not_owner, whatever it sent", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      // A malformed-but-parseable envelope used to answer `invalid_request` and
      // **keep** the connection — a free retry channel for a peer that has
      // presented no nonce, and the same path a rejection escaped through.
      // Measured before the fix: a hundred refusals on one connection, then a
      // successful hello on that same connection.
      const malformed = [
        JSON.stringify({ version: 1, id: "a" }),
        JSON.stringify({ version: 1, id: "b", request: {} }),
        JSON.stringify({ version: 1, id: "c", request: { method: 7 } }),
        JSON.stringify({ version: 1, id: "d", request: { method: "host.hello" } }),
        JSON.stringify({ version: 1, id: "e", request: { method: "host.hello", params: "nope" } }),
        JSON.stringify({ version: 1, id: "f", request: { method: "host.list_plugins", params: {} } }),
      ];
      for (const line of malformed) {
        const replies = await untilClose(socketPath, [line]);
        expect(replies, `for ${line}`).toHaveLength(1);
        expect(outcomeOf(replies[0] as string), `for ${line}`).toMatchObject({
          status: "err",
          value: { code: "not_owner" },
        });
      }
      // And a flood on one connection cannot outlive the first line either.
      const flood = await untilClose(socketPath, [...malformed, ...malformed]);
      expect(flood).toHaveLength(1);
      expect(harness.server.clientCount()).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it("refuses a version it does not speak, before it dispatches anything", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const nonce = harness.readNonce();
      // Version validation precedes method dispatch, which is `docs/protocol.md`'s
      // rule and the reason version numbers exist: the day this envelope changes,
      // an old client must be told rather than silently mis-served. A version-99
      // client used to be answered as though it spoke version 1.
      for (const envelope of [
        { version: 99, id: "v99", request: { method: "host.hello", params: { nonce } } },
        { id: "none", request: { method: "host.hello", params: { nonce } } },
        { version: "1", id: "str", request: { method: "nonesuch", params: {} } },
      ]) {
        const replies = await untilClose(socketPath, [JSON.stringify(envelope)]);
        expect(replies).toHaveLength(1);
        const outcome = outcomeOf(replies[0] as string);
        expect(outcome).toMatchObject({
          status: "err",
          value: { code: "incompatible_version", supported_version: 1 },
        });
        // Pre-authentication it is still not a well-formed hello, so the socket
        // goes with the refusal.
        expect(JSON.parse(replies[0] as string)).toMatchObject({ id: envelope.id });
      }

      // An **admitted** client is told and kept, the way the daemon keeps a
      // connection that sent one bad version.
      const admitted = await untilReplies(
        socketPath,
        [
          request("host.hello", { nonce }),
          JSON.stringify({ version: 42, id: "bad", request: { method: "host.list_plugins" } }),
          JSON.stringify({ version: 1, id: "good", request: { method: "host.list_plugins" } }),
        ],
        3,
      );
      // **Paired by id, not by arrival order.** `host.hello` reads the plugin
      // set through the daemon and the version refusal is answered inline, so a
      // client that pipelines gets its answers as they are ready — which is what
      // the `id` is for, and is why nothing here indexes by position.
      const byId = new Map(
        admitted.map((line) => [(JSON.parse(line) as { id: string }).id, outcomeOf(line)]),
      );
      expect(byId.get("x")?.status).toBe("ok");
      expect(byId.get("bad")).toMatchObject({ status: "err", value: { code: "incompatible_version" } });
      expect(byId.get("good")?.status).toBe("ok");
    } finally {
      await harness.stop();
    }
  });

  it("echoes the id a client sent, string or number", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const replies = await untilClose(socketPath, [
        JSON.stringify({ version: 1, id: 7, request: { method: "host.list_plugins", params: {} } }),
      ]);
      // A client that spelled its id as a number gets that number back, rather
      // than an empty string it cannot pair with anything it sent.
      expect(JSON.parse(replies[0] as string)).toMatchObject({ id: 7 });
    } finally {
      await harness.stop();
    }
  });

  it("keeps the host alive when a rejection escapes anyway", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.server.listen();
      const client = await harness.connectClient();
      // The guard is defence in depth: every per-line handler carries its own
      // catch, and this is what happens when a promise escapes somewhere nobody
      // has thought of yet. Node's default is to terminate the process.
      expect(rejectionGuardArmed()).toBe(true);
      const planted = new Error("a promise nobody awaited");
      reportUnhandledRejection(planted);
      // Reported through the host's own error seam — visible, attributed to the
      // host rather than to any plugin, and counted against nobody.
      expect(harness.hostErrors.map((entry) => entry.error)).toContain(planted);
      expect(harness.hostErrors.at(-1)?.pluginId).toBe("host");
      // And the host is still serving.
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
    } finally {
      await harness.stop();
    }
  });

  it("measures the line cap in bytes, not in UTF-16 units", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      // The cap is `writeFileCapBytes` plus a megabyte of headroom, so a small
      // write cap makes this case cheap rather than a 20 MB one.
      config: { writeFileCapBytes: 4096 },
    });
    try {
      const socketPath = await harness.server.listen();
      // Three bytes each in UTF-8 and one UTF-16 unit each, so this payload is
      // **over** the byte cap and well under the unit count a `String.length`
      // check would have measured. Before the fix a multi-byte line reached
      // several times the intended cap before the destroy fired.
      const cjk = "漢".repeat(600_000);
      expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(4096 + 1024 * 1024);
      expect(cjk.length).toBeLessThan(4096 + 1024 * 1024);
      expect(await untilClose(socketPath, [JSON.stringify({ padding: cjk })])).toEqual([]);
      // The host is unharmed, and a line inside the cap is still served.
      const client = await harness.connectClient();
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
    } finally {
      await harness.stop();
    }
  }, 30_000);

  it("disarms the rejection guard when the last host closes", async () => {
    // The refcount is what keeps two live hosts to one `process.on` listener and
    // a host that is never closed from leaking one. Asserted at the boundary:
    // this is the only harness alive at this point in the file, so the last
    // `close()` is this one's.
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    expect(rejectionGuardArmed()).toBe(true);
    await harness.stop();
    expect(rejectionGuardArmed()).toBe(false);
  });

  it("stops listening on a refusal, and can listen again once it is repaired", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      harness.chmodSocketDir(0o770);
      await expect(harness.server.listen()).rejects.toThrow(/socket directory mode/);
      // A rejected promise is not nullish, so a cached one would leave this host
      // unable to listen for the rest of the process — even after the operator
      // ran the very `chmod` the refusal asked for.
      harness.chmodSocketDir(0o700);
      await expect(harness.server.listen()).resolves.toContain("/");
    } finally {
      await harness.stop();
    }
  });

  it("closes a peer that never says hello, and leaves an authenticated client alone", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      // Authenticated first, so the baseline below includes whatever a live
      // client has armed and the assertion is about the silent peer's timer and
      // nothing else.
      const client = await harness.connectClient();
      const baseline = harness.clock.armed();
      const peer = await silentPeer(socketPath);
      // The deadline is armed on `config.clock` like every other duration in
      // this host, which is what lets this case advance to it rather than wait
      // for it.
      await until(() => harness.clock.armed() === baseline + 1);
      expect(harness.server.preAuthClosed()).toBe(0);
      await harness.advanceClock(5_000);
      // No reply, just gone: the peer sent nothing, so there is nothing to
      // answer.
      await peer.closed;
      expect(harness.server.preAuthClosed()).toBe(1);
      // And the client that did say hello is untouched by any of it.
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
      expect(harness.server.clientCount()).toBe(1);
      // Nothing left armed: an admitted client is not on a deadline, and a
      // closed connection's timer goes with it.
      expect(harness.clock.armed()).toBe(baseline);
    } finally {
      await harness.stop();
    }
  });

  it("closes the seventeenth silent peer at once, and the sixteen before it on the deadline", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const baseline = harness.clock.armed();
      const peers: Array<{ closed: Promise<void> }> = [];
      for (let i = 0; i < 16; i += 1) {
        peers.push(await silentPeer(socketPath));
        await until(() => harness.clock.armed() === baseline + i + 1);
      }
      // The cap is what holds under a flood: the deadline bounds how long one
      // silent peer lasts, this bounds how many can exist inside that window.
      // **The newest goes** — an older pre-auth connection may be a real client
      // mid-handshake, and this one is the marginal socket of whoever is opening
      // them in a loop.
      const seventeenth = await silentPeer(socketPath);
      await seventeenth.closed;
      expect(harness.server.preAuthClosed()).toBe(1);
      // Closed before a connection was built for it, so it armed nothing.
      expect(harness.clock.armed()).toBe(baseline + 16);
      await harness.advanceClock(5_000);
      for (const peer of peers) await peer.closed;
      // One count for both rules: from the operator's side they are one fact —
      // a peer that held a socket and never presented the nonce.
      expect(harness.server.preAuthClosed()).toBe(17);
      expect(harness.clock.armed()).toBe(baseline);
      // The host is unharmed and still admits a client that speaks.
      const client = await harness.connectClient();
      await expect(client.call("host.list_plugins", {})).resolves.toMatchObject({ plugins: [] });
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
