/**
 * The `global-search` instance and the two search operations, through the
 * production wiring and a real daemon.
 *
 * `startHost` is `src/host.ts`, the one copy of the wiring that ships, so this
 * pins what a real host does: a host client runs a query through
 * `host.search`; a plugin's `openGlobalSearch` — the call tag-wrangler makes —
 * raises one `host.search_opened` to a subscribed client; and
 * `host.search_state` then answers the opened query and its result. Headless,
 * that state is all "open a search" means.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { defaultHostConfig, systemClock } from "../src/config";
import { startHost } from "../src/host";
import { HostTestClient } from "../src/testing/host-harness";
import type { GlobalSearchInstance } from "../src/shim/global-search";
import type { HostConfig } from "../src/config";
import type { RunningHost } from "../src/host";

/** A scratch vault with `global-search` enabled and two notes. */
function configFor(): HostConfig {
  const vault = scratchRoot("vaultd-search-");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, ".obsidian", "core-plugins.json"), `${JSON.stringify({ "global-search": true })}\n`, "utf8");
  writeFileSync(join(vault, "A.md"), "#project meeting\n", "utf8");
  writeFileSync(join(vault, "B.md"), "meeting\n", "utf8");
  const state = scratchRoot("vaultd-search-state-");
  return {
    ...defaultHostConfig(vault),
    engine: "spawn" as const,
    vaultdBinary: BINARY,
    dataDir: state,
    socketPath: join(state, "s"),
    clock: systemClock(),
    allowNetwork: false,
  };
}

interface SearchAnswer {
  total_files: number;
  items: Array<{ path: string }>;
}

describe.skipIf(!BINARY_EXISTS)("global-search over a real daemon", () => {
  let running: RunningHost | null = null;
  let client: HostTestClient | null = null;

  afterEach(async () => {
    await client?.disconnect();
    client = null;
    await running?.stop();
    running = null;
    await cleanupRealDaemons();
  });

  it("serves host.search, raises host.search_opened, and answers host.search_state", async () => {
    const config = configFor();
    running = await startHost(config);
    await running.assembly.app.internalPlugins.ready();
    client = await HostTestClient.open(running.socketPath);
    const nonce = readFileSync(join(config.dataDir, "nonce"), "utf8").trim();
    await client.call("host.hello", { nonce });
    await client.call("host.subscribe", {});

    const searched = await client.call<SearchAnswer>("host.search", { query: "meeting" });
    expect(searched.items.map((item) => item.path).sort()).toEqual(["A.md", "B.md"]);

    const opened = client.nextEvent("host.search_opened");
    const instance = running.assembly.app.internalPlugins.getPluginById("global-search")
      ?.instance as GlobalSearchInstance;
    instance.openGlobalSearch("tag:#project");
    await expect(opened).resolves.toEqual({ query: "tag:#project", total_files: 1, error: null });
    const events = await client.drainEvents();
    expect(events.filter((event) => event.type === "host.search_opened")).toHaveLength(1);

    const state = await client.call<{ query: string; answer: SearchAnswer | null; error: string | null }>(
      "host.search_state",
      {},
    );
    expect(state.query).toBe("tag:#project");
    expect(state.error).toBeNull();
    expect(state.answer?.items.map((item) => item.path)).toEqual(["A.md"]);
  }, 120_000);
});
