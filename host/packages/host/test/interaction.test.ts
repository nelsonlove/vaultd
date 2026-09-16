/**
 * Interaction brokerage: a plugin asks, a client answers, and every way that
 * can fail is typed.
 *
 * The five cases are the brief's, with three amendments the dispatch made and
 * one this file makes for determinism:
 *
 * - `HostHarness.suggestPlugin`'s callback is `async` and awaits `open()`
 *   (dispatch ruling 4), so the timeout case does not race the broker.
 * - The timeout case asserts the injected clock has nothing left armed
 *   (ruling 8), measured against the baseline the host itself holds — the
 *   coexistence poll is a live timer on the same clock, so the honest assertion
 *   is "nothing of this prompt's is left" rather than "the clock is empty".
 * - `host.invoke_command` answers as soon as `executeCommandById` returns, and
 *   that is synchronous by design (`shim/commands.ts`): an `async` callback's
 *   continuation is still running when the response reaches the client. So the
 *   cases that assert on what the continuation did settle on the fact itself
 *   through {@link settleUntil} rather than on `await invoking`, which is a
 *   sync point for the request and not for the plugin.
 */

import { describe, expect, it } from "vitest";
import { HeadlessUnsupported } from "../src/shim/policy";
import { HostHarness } from "../src/testing/host-harness";

/**
 * Turn the event loop until `check` holds, or give up and let the assertion
 * that follows say what was actually true.
 *
 * Turns rather than a sleep: everything being waited on here is a microtask
 * chain or a local socket, so a bounded number of `setImmediate` hops is a real
 * sync point, and one that costs nothing when the fact is already true.
 */
async function settleUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("interaction brokerage", () => {
  it("round-trips a FuzzySuggestModal choice through an attached client", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: {
        picker: (api) =>
          class extends api.Plugin {
            override onload(): void {
              this.addCommand({
                id: "pick",
                name: "Pick",
                // `open()` returns a promise that settles when the client
                // answers, so the callback must be async and must await it —
                // exactly like the interaction_unavailable case below. Without
                // the await, the choice handler never runs at all.
                callback: async () => {
                  class Picker extends api.FuzzySuggestModal<string> {
                    override getItems(): string[] {
                      return ["Alpha", "Beta", "Gamma"];
                    }
                    override getItemText(item: string): string {
                      return item;
                    }
                    override onChooseItem(item: string): void {
                      chosen.push(item);
                    }
                  }
                  await new Picker(this.app).open();
                },
              });
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      const invoking = client.call("host.invoke_command", { command_id: "picker:pick" });
      const request = await client.nextEvent("host.interaction_request");
      expect(request).toMatchObject({
        plugin_id: "picker",
        kind: "fuzzy_suggest",
        items: ["Alpha", "Beta", "Gamma"],
        timeout_ms: 120000,
      });
      await client.call("host.respond_interaction", {
        prompt_id: (request as { prompt_id: string }).prompt_id,
        choice_index: 1,
      });
      await invoking;
      await settleUntil(() => chosen.length > 0);
      expect(chosen).toEqual(["Beta"]);
      expect(harness.broker.pending()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("fails a prompt with interaction_unavailable when no client is attached", async () => {
    const errors: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: {
        picker: (api) =>
          class extends api.Plugin {
            override onload(): void {
              this.addCommand({
                id: "pick",
                name: "Pick",
                callback: async () => {
                  class Picker extends api.SuggestModal<string> {
                    override getSuggestions(): string[] {
                      return ["only"];
                    }
                    override onChooseSuggestion(): void {
                      // Never reached: nobody is attached to choose.
                    }
                  }
                  try {
                    await new Picker(this.app).open();
                  } catch (error) {
                    errors.push((error as { code?: string }).code ?? "none");
                  }
                },
              });
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.invoke_command", { command_id: "picker:pick" });
      await settleUntil(() => errors.length > 0);
      expect(errors).toEqual(["interaction_unavailable"]);
    } finally {
      await harness.stop();
    }
  });

  it("times out a prompt at 120 seconds without hanging the plugin", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: HostHarness.suggestPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      // Read before the prompt is armed, because the host runs timers of its
      // own on this clock — the coexistence poll is one — and a leaked prompt
      // timer is a rise above this, not a non-zero reading.
      const baseline = harness.clock.armed();
      const invoking = client.call("host.invoke_command", { command_id: "picker:pick" });
      await client.nextEvent("host.interaction_request");
      expect(harness.clock.armed()).toBe(baseline + 1);
      await harness.advanceClock(120_000);
      await invoking;
      await settleUntil(() => harness.lastHandlerError("picker") !== null);
      expect(harness.lastHandlerError("picker")?.message).toMatch(/interaction_timeout/);
      expect(harness.broker.pending()).toEqual([]);
      expect(harness.clock.armed()).toBe(baseline);
    } finally {
      await harness.stop();
    }
  });

  it("fails a pending prompt when the handler disconnects", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: HostHarness.suggestPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      const invoking = client
        .call("host.invoke_command", { command_id: "picker:pick" })
        .catch(() => "gone");
      await client.nextEvent("host.interaction_request");
      await client.disconnect();
      await invoking;
      await settleUntil(() => !harness.broker.attached());
      expect(harness.broker.attached()).toBe(false);
      expect(harness.broker.pending()).toEqual([]);
      await settleUntil(() => harness.lastHandlerError("picker") !== null);
      expect(harness.lastHandlerError("picker")?.message).toMatch(/interaction_unavailable/);
    } finally {
      await harness.stop();
    }
  });

  it("throws typed for a bespoke Modal.onOpen UI", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["bespoke"],
      plugins: {
        bespoke: (api) =>
          class extends api.Plugin {
            override onload(): void {
              this.addCommand({
                id: "show",
                name: "Show",
                callback: () => {
                  class Bespoke extends api.Modal {
                    override onOpen(): void {
                      this.contentEl.createEl("h2", { text: "hi" });
                    }
                  }
                  void new Bespoke(this.app).open();
                },
              });
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.invoke_command", { command_id: "bespoke:show" }).catch(() => undefined);
      const error = harness.lastHandlerError("bespoke");
      expect(error).toBeInstanceOf(HeadlessUnsupported);
      expect((error as HeadlessUnsupported).symbol).toBe("Modal.open");
      expect(error?.message).toContain("Bespoke");
    } finally {
      await harness.stop();
    }
  });

  it("refuses a second attach, releases on detach, and refuses an unknown answer", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.lifecycle.start();
      const first = await harness.connectClient();
      const second = await harness.connectClient();
      await expect(first.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
      await expect(second.call("host.attach_interaction", {})).rejects.toMatchObject({
        code: "interaction_unavailable",
      });
      // An unknown prompt id is refused rather than silently ignored: a client
      // answering a prompt that timed out has to be told it was too late.
      await expect(
        first.call("host.respond_interaction", { prompt_id: "prompt-404", choice_index: 0 }),
      ).rejects.toMatchObject({ code: "interaction_unavailable" });
      // And a client that does not hold the channel cannot answer at all: the
      // prompt went to one connection, so an answer from another is an answer
      // to a question it never saw.
      await expect(
        second.call("host.respond_interaction", { prompt_id: "prompt-1", choice_index: 0 }),
      ).rejects.toMatchObject({ code: "interaction_unavailable" });
      await expect(first.call("host.detach_interaction", {})).resolves.toEqual({ attached: false });
      await expect(second.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
    } finally {
      await harness.stop();
    }
  });
});
