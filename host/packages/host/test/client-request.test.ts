import { describe, expect, it } from "vitest";

import { VaultdClient, VaultdError } from "../src/client/client";
import { FakeDaemon } from "../src/testing/fake-daemon";

describe("VaultdClient", () => {
  it("correlates two in-flight requests answered out of order", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const first = client.request<{ generation: number }>("get_vault_info");
    const second = client.request<{ service: string }>("health");
    expect(client.pendingCount()).toBe(2);
    const sent = await daemon.received(2);
    expect(sent[0]?.request.method).toBe("get_vault_info");
    expect(sent[0]?.id).not.toBe(sent[1]?.id);
    daemon.respondOk(sent[1]!.id, "health", { service: "vaultd", status: "ok" });
    daemon.respondOk(sent[0]!.id, "get_vault_info", { generation: 7 });
    await expect(second).resolves.toEqual({ service: "vaultd", status: "ok" });
    await expect(first).resolves.toEqual({ generation: 7 });
    expect(client.pendingCount()).toBe(0);
  });

  it("omits the params key entirely for a no-params method", async () => {
    // `health` and `get_vault_info` are unit variants of the daemon's
    // adjacently tagged `Request`: it serializes them with no `params` key, and
    // `"params": null` is not a shape it produces.
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const pending = client.request("health");
    const [sent] = await daemon.received(1);
    expect(Object.keys(sent!.request)).toEqual(["method"]);
    expect(daemon.rawLines()[0]).toBe(
      `{"version":1,"id":"${sent!.id}","request":{"method":"health"}}`,
    );
    client.close();
    await expect(pending).rejects.toThrow(/client closed/);
  });

  it("rejects with a typed VaultdError carrying current_generation", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const pending = client.request("list_notes", { cursor: "stale", limit: 100 });
    const [sent] = await daemon.received(1);
    daemon.respondErr(sent!.id, {
      code: "generation_mismatch",
      message: "cursor generation 2 does not match current generation 3",
      current_generation: 3,
    });
    await expect(pending).rejects.toBeInstanceOf(VaultdError);
    await pending.catch((error: VaultdError) => {
      expect(error.code).toBe("generation_mismatch");
      expect(error.currentGeneration).toBe(3);
      expect(error.currentRevision).toBeNull();
      expect(error.supportedVersion).toBeNull();
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("carries current_revision off a revision_conflict, for the retry loop", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const pending = client.request("write_note", {
      path: "Note.md",
      content: "# Note\n",
      expected: { revision: "blake3:stale" },
    });
    const [sent] = await daemon.received(1);
    daemon.respondErr(sent!.id, {
      code: "revision_conflict",
      message: "Note.md holds a different revision",
      current_revision: "blake3:live",
    });
    await pending.catch((error: VaultdError) => {
      expect(error.code).toBe("revision_conflict");
      expect(error.currentRevision).toBe("blake3:live");
      expect(error.currentGeneration).toBeNull();
    });
    await expect(pending).rejects.toBeInstanceOf(VaultdError);
  });

  it("routes an event line to onEvent, never to a pending request", async () => {
    const daemon = new FakeDaemon();
    const events: string[] = [];
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: (envelope) => events.push(envelope.event.type),
      onFatal: () => undefined,
    });
    const pending = client.request("health");
    const [sent] = await daemon.received(1);
    daemon.emit("sub-1", {
      type: "resync_required",
      value: { current_generation: 4, reason: "runtime_recovered" },
    });
    daemon.respondOk(sent!.id, "health", { service: "vaultd", status: "ok" });
    await pending;
    expect(events).toEqual(["resync_required"]);
  });

  it("passes an event kind it has never heard of straight through", async () => {
    // Unknown-variant tolerance: the daemon degrades an unrecognized `type` to
    // its own `Unknown` rather than failing the line, and the mirror-image
    // obligation here is to hand it to `onEvent` instead of throwing.
    const daemon = new FakeDaemon();
    const types: string[] = [];
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: (envelope) => types.push(envelope.event.type),
      onFatal: () => undefined,
    });
    const pending = client.request("health");
    const [sent] = await daemon.received(1);
    daemon.writeRaw(
      '{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future","value":{"whatever":true}}}\n',
    );
    daemon.respondOk(sent!.id, "health", { service: "vaultd", status: "ok" });
    await pending;
    expect(types).toEqual(["from_the_future"]);
  });

  it("settles the good frame that shared a chunk with a corrupt line", async () => {
    // The whole point of `LineFramer.push` returning its error: this request's
    // answer arrived intact, and it must resolve even though the connection is
    // about to die on the line behind it.
    const daemon = new FakeDaemon();
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.request<{ service: string }>("health");
    const [sent] = await daemon.received(1);
    daemon.writeRaw(
      `{"version":1,"id":"${sent!.id}","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}\n{oops\n`,
    );
    await expect(pending).resolves.toEqual({ service: "vaultd", status: "ok" });
    expect(fatal).toBeInstanceOf(Error);
    expect((fatal as unknown as Error).message).toMatch(/unparseable daemon line/);
  });

  it("fails every pending request when the stream dies", async () => {
    const daemon = new FakeDaemon();
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: (error) => {
        fatal = error;
      },
    });
    const pending = client.request("health");
    await daemon.received(1);
    daemon.endStdout();
    await expect(pending).rejects.toThrow(/daemon stdout closed/);
    expect(fatal).toBeInstanceOf(Error);
    expect(client.pendingCount()).toBe(0);
  });

  it("reports fatality once, and refuses requests after it", async () => {
    const daemon = new FakeDaemon();
    let fatalCount = 0;
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => {
        fatalCount += 1;
      },
    });
    const pending = client.request("health");
    await daemon.received(1);
    daemon.endStdout();
    await expect(pending).rejects.toThrow(/daemon stdout closed/);
    daemon.stdout.emit("error", new Error("and then it errored too"));
    expect(fatalCount).toBe(1);
    await expect(client.request("health")).rejects.toThrow(/client is closed/);
  });

  it("close() fails what is in flight and writes nothing more", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const pending = client.request("health");
    await daemon.received(1);
    client.close();
    await expect(pending).rejects.toThrow(/client closed/);
    expect(client.pendingCount()).toBe(0);
    await expect(client.request("health")).rejects.toThrow(/client is closed/);
    expect(daemon.rawLines()).toHaveLength(1);
  });

  it("ignores a response whose id nobody is waiting on", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout,
      stdin: daemon.stdin,
      onEvent: () => undefined,
      onFatal: () => undefined,
    });
    const pending = client.request<{ service: string }>("health");
    const [sent] = await daemon.received(1);
    daemon.respondOk("h-nobody", "health", { service: "ghost", status: "ok" });
    daemon.respondOk(sent!.id, "health", { service: "vaultd", status: "ok" });
    await expect(pending).resolves.toEqual({ service: "vaultd", status: "ok" });
    expect(client.pendingCount()).toBe(0);
  });
});
