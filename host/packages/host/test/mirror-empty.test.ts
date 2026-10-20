/**
 * `Mirror.empty`: the screen host's mirror. It holds no vault, answers every
 * query as an empty vault, and no event, the resync road included, makes it
 * ask vaultd for anything: a resync on a mirror that was never hydrated would
 * load the whole vault, which is the cost the empty mirror exists to avoid.
 */

import { describe, expect, it } from "vitest";

import { defaultHostConfig } from "../src/config";
import { Mirror } from "../src/mirror/mirror";
import type { VaultdClient } from "../src/client/client";

function countingClient(): { source: () => VaultdClient; calls: string[] } {
  const calls: string[] = [];
  const client = new Proxy({} as VaultdClient, {
    get(_target, key): unknown {
      calls.push(String(key));
      return () => Promise.reject(new Error(`the empty mirror asked vaultd (${String(key)})`));
    },
  });
  return {
    source: () => {
      calls.push("source");
      return client;
    },
    calls,
  };
}

describe("Mirror.empty", () => {
  it("answers as an empty vault without asking vaultd", () => {
    const { source, calls } = countingClient();
    const mirror = Mirror.empty(source, defaultHostConfig("/nonexistent-vault"));
    expect(mirror.entries()).toEqual([]);
    expect(mirror.children("")).toEqual([]);
    expect(mirror.entry("A.md")).toBeUndefined();
    expect(mirror.note("A.md")).toBeUndefined();
    expect(mirror.resolvedLinks()).toEqual({});
    expect(mirror.unresolvedLinks()).toEqual({});
    expect(mirror.backlinks("A.md")).toEqual([]);
    expect(mirror.generation()).toBe(0);
    expect(calls).toEqual([]);
    mirror.stop();
  });

  it("ignores every event, a resync and a committed generation included", async () => {
    const { source, calls } = countingClient();
    const mirror = Mirror.empty(source, defaultHostConfig("/nonexistent-vault"));
    await mirror.applyEvent({ type: "resync_required", value: { current_generation: 9, reason: "engine_restarted" } });
    await mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 0,
        generation: 1,
        cause: "periodic",
        changes: { kind: "detailed", created: ["A.md"], modified: [], deleted: [] },
        affected_note_count: 1,
        affected_reference_count: 0,
      },
    });
    expect(calls).toEqual([]);
    expect(mirror.resyncCount()).toBe(0);
    expect(mirror.entries()).toEqual([]);
    mirror.stop();
  });
});
