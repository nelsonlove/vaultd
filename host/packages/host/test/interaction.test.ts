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
import { ClientSubscriptions } from "../src/server/subscriptions";
import { HeadlessUnsupported } from "../src/shim/policy";
import { HostErrors } from "../src/shim/errors";
import { HostHarness } from "../src/testing/host-harness";
import { InteractionBroker } from "../src/interaction/broker";
import { defaultHostConfig } from "../src/config";
import { testClock } from "../src/testing/clock";
import type { HostTestClient, PluginFactory } from "../src/testing/host-harness";

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

  /**
   * A plugin whose command raises a fuzzy prompt and leaves it pending.
   *
   * The callback deliberately does **not** await `open()` — that is the shape
   * the overwhelming majority of real plugins take, since Obsidian's `open()`
   * returns `void` — so the prompt outlives the `host.invoke_command` response
   * and a case can act on a question that is genuinely still open.
   */
  function pendingPicker(
    chosen: string[],
    options: { throwOnChoose?: boolean } = {},
  ): PluginFactory {
    return (api) =>
      class extends api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "pick",
            name: "Pick",
            callback: () => {
              class Picker extends api.FuzzySuggestModal<string> {
                override getItems(): string[] {
                  return ["Alpha", "Beta", "Gamma"];
                }
                override getItemText(item: string): string {
                  return item;
                }
                override onChooseItem(item: string): void {
                  if (options.throwOnChoose === true) throw new Error("handler exploded");
                  chosen.push(item);
                }
              }
              void new Picker(this.app).open();
            },
          });
        }
      };
  }

  /** Raise a prompt and hand back the request the client was sent. */
  async function raisePrompt(
    harness: HostHarness,
    client: HostTestClient,
  ): Promise<{ prompt_id: string }> {
    void client.call("host.invoke_command", { command_id: "picker:pick" });
    const request = (await client.nextEvent("host.interaction_request")) as { prompt_id: string };
    await settleUntil(() => harness.broker.pending().length > 0);
    return request;
  }

  it("disarms the prompt timer on an answer and on a detach", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: pendingPicker(chosen) },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      // **The timeout case cannot prove this.** On that path `TestClock` deletes
      // the fired timer itself, so an `armed()` assertion there holds whether or
      // not anything called `clearTimeout`. These two paths are the ones where
      // the host has to disarm it, and deleting that call makes them red.
      const baseline = harness.clock.armed();

      const answered = await raisePrompt(harness, client);
      expect(harness.clock.armed()).toBe(baseline + 1);
      await client.call("host.respond_interaction", {
        prompt_id: answered.prompt_id,
        choice_index: 0,
      });
      await settleUntil(() => chosen.length > 0);
      expect(chosen).toEqual(["Alpha"]);
      expect(harness.broker.pending()).toEqual([]);
      expect(harness.clock.armed()).toBe(baseline);

      await raisePrompt(harness, client);
      expect(harness.clock.armed()).toBe(baseline + 1);
      await client.call("host.detach_interaction", {});
      expect(harness.broker.pending()).toEqual([]);
      expect(harness.clock.armed()).toBe(baseline);
    } finally {
      await harness.stop();
    }
  });

  it("refuses a non-holder's answer to a prompt that is genuinely pending", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: pendingPicker(chosen) },
    });
    try {
      await harness.lifecycle.start();
      const holder = await harness.connectClient();
      const other = await harness.connectClient();
      await holder.call("host.attach_interaction", {});
      const request = await raisePrompt(harness, holder);
      // **A real prompt, outstanding.** Answering an id that names nothing is
      // refused by a different mechanism, so a case built on one would stay
      // green with the holder check deleted.
      await expect(
        other.call("host.respond_interaction", {
          prompt_id: request.prompt_id,
          choice_index: 2,
        }),
      ).rejects.toMatchObject({ code: "interaction_unavailable" });
      // Untouched by the refusal: the question is still the holder's to answer.
      expect(harness.broker.pending()).toHaveLength(1);
      await holder.call("host.respond_interaction", {
        prompt_id: request.prompt_id,
        choice_index: 1,
      });
      await settleUntil(() => chosen.length > 0);
      expect(chosen).toEqual(["Beta"]);
    } finally {
      await harness.stop();
    }
  });

  it("refuses an out-of-range choice_index and leaves the prompt answerable", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: pendingPicker(chosen) },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      const request = await raisePrompt(harness, client);
      // A client miscounting is the **client's** error, not the plugin's: it is
      // refused the way a missing `command_id` is, and the question survives it.
      for (const index of [3, -1, 1.5]) {
        await expect(
          client.call("host.respond_interaction", {
            prompt_id: request.prompt_id,
            choice_index: index,
          }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(harness.broker.pending()).toHaveLength(1);
      }
      await client.call("host.respond_interaction", {
        prompt_id: request.prompt_id,
        choice_index: 2,
      });
      await settleUntil(() => chosen.length > 0);
      expect(chosen).toEqual(["Gamma"]);
    } finally {
      await harness.stop();
    }
  });

  it("counts a choice handler's own throw against the plugin", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: { picker: pendingPicker([], { throwOnChoose: true }) },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      const request = await raisePrompt(harness, client);
      await client.call("host.respond_interaction", {
        prompt_id: request.prompt_id,
        choice_index: 0,
      });
      await settleUntil(() => harness.lastHandlerError("picker") !== null);
      // **Counted.** The uncounted `interaction` phase is for the channel
      // failing — nobody attached, nobody answered — and a plugin's own throw
      // from its choice handler is not that. Filing this one under `interaction`
      // would leave a plugin that throws on every choice unquarantinable.
      expect(harness.lastHandlerError("picker")?.message).toContain("handler exploded");
      expect(harness.quarantine.failuresFor("picker")).toBe(1);
    } finally {
      await harness.stop();
    }
  });

  it("leaves no subscription behind a refused attach, and closes the one it opened", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.lifecycle.start();
      const holder = await harness.connectClient();
      const refused = await harness.connectClient();
      await holder.call("host.attach_interaction", {});
      await expect(refused.call("host.attach_interaction", {})).rejects.toMatchObject({
        code: "interaction_unavailable",
      });
      // Being told no must not sign a client up for the whole event firehose.
      harness.noticeLog.record("after the refusal", null);
      await harness.serverQuiesce();
      expect(await refused.drainEvents()).toEqual([]);

      // And a detach gives back exactly what the attach took out.
      await holder.call("host.detach_interaction", {});
      harness.noticeLog.record("after the detach", null);
      await harness.serverQuiesce();
      const seen = (await holder.drainEvents()).map((event) => event.value);
      expect(seen).not.toContainEqual(expect.objectContaining({ message: "after the detach" }));
    } finally {
      await harness.stop();
    }
  });

  it("fails a prompt whose delivery was collapsed, rather than waiting for the timeout", async () => {
    // **The delivery seam, driven directly.** A client that has stopped reading
    // fills the kernel buffer, then the socket's, and then its subscription
    // overflows its bound and is collapsed into one `resync_required` standing
    // in for everything it missed. An ordinary event is recovered by re-reading;
    // a prompt is a question with a plugin waiting on it, so a prompt nobody
    // received has to fail now rather than in two minutes.
    const clock = testClock();
    const config = { ...defaultHostConfig("/nonexistent/interaction-probe"), clock };
    const errors = new HostErrors();
    errors.onError(() => undefined);
    const subscriptions = new ClientSubscriptions({
      // Backed up from the first line, so nothing is ever written and the
      // queue is the only place an event can go.
      writer: { write: () => false, onceDrain: () => undefined },
      limit: 4,
      currentGeneration: () => 1,
      mintId: () => "probe-sub-1",
    });
    subscriptions.open();
    for (let i = 0; i < 5; i += 1) subscriptions.deliver({ type: "host.notice", value: { i } });

    const broker = new InteractionBroker({ config, errors });
    broker.attach({
      owner: {},
      label: "host-conn-probe",
      deliver: (event) => subscriptions.deliver(event),
    });
    const asking = broker.ask({
      pluginId: "picker",
      kind: "suggest",
      prompt: "Pick",
      items: ["one", "two"],
    });
    await expect(asking).rejects.toMatchObject({ code: "interaction_unavailable" });
    expect(broker.pending()).toEqual([]);
    // Nothing armed, so nothing to wait 120 seconds for and nothing to leak.
    expect(clock.armed()).toBe(0);
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
