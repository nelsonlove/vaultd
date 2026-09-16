/**
 * How a plugin asks a human a question when there is no window to ask it in.
 *
 * **One holder at a time, and the holder is a connection.** A prompt is not a
 * broadcast: it is a question addressed to whoever said they would answer it,
 * and two clients answering one prompt is two answers to a question that has
 * one. So a session {@link InteractionBroker.attach}es, every prompt raised
 * while it holds the channel goes to it alone, and a second session asking to
 * attach is refused by name rather than silently taking the channel from
 * whoever is using it.
 *
 * **Every way this can fail is typed, and none of them is a wedged process.**
 * That is the whole reason the broker exists rather than a `Modal.open()` that
 * waits:
 *
 * - nobody attached → {@link InteractionUnavailable}, immediately;
 * - the holder disconnects or detaches → {@link InteractionUnavailable} for
 *   every prompt it had not answered;
 * - nobody answers inside `promptTimeoutMs` → {@link InteractionTimeout}.
 *
 * A plugin sees each as a rejected promise from the surface it called, which is
 * its own error path. A host that instead left the promise pending would hang
 * the dispatch queue on a human who closed their laptop.
 *
 * **Timers come from `config.clock`, never from the global.** That is the
 * phase's Global Constraint, and it is what lets the timeout case advance two
 * minutes instantly instead of sleeping them. A timer is cleared on answer and
 * on detach, so an answered prompt can never fire a late rejection and a leaked
 * timer is a number a case can assert on (`TestClock.armed()`).
 *
 * **The broker is installed against the `App`**, exactly as `installPluginHost`
 * is and for the same reason: two hosts in one process — a test that assembles
 * twice, a live host beside a harness — must never read each other's wiring, and
 * a module-level variable is the one shape that guarantees they do.
 */

import { HOST_PLUGIN_ID } from "../shim/errors";
import { toWireInteractionRequest } from "../server/wire";
import type { App } from "../shim/app";
import type { HostConfig } from "../config";
import type { HostErrors } from "../shim/errors";

/** The four shapes of question this host knows how to ask. */
export type PromptKind = "suggest" | "fuzzy_suggest" | "text" | "confirm";

/** One question, as the broker holds it and as the wire carries it. */
export interface PromptRequest {
  readonly promptId: string;
  readonly pluginId: string;
  readonly kind: PromptKind;
  readonly prompt: string;
  readonly items: readonly string[];
  readonly timeoutMs: number;
}

/**
 * One answer.
 *
 * Three optional fields rather than a union, because that is the shape the wire
 * carries (`host.respond_interaction` takes `choice_index`, `value` and
 * `cancelled`, all optional) and a broker that declared a tighter type than the
 * protocol would have to invent a refusal for every shape the protocol allows.
 * Which field means what is per {@link PromptKind}, and the mapping lives with
 * the surface that asked — see `shim/components.ts` and the confirm adapter in
 * `testing/assemble.ts`.
 */
export interface PromptAnswer {
  readonly choiceIndex?: number;
  readonly value?: string;
  readonly cancelled?: boolean;
}

/**
 * The holder of the channel, as the broker needs it.
 *
 * Two things, and deliberately no more: who it is, so a refusal can name it and
 * a disconnect can be matched against it, and how to reach that **one**
 * connection. The ops layer builds it per connection; nothing here knows what a
 * socket is.
 */
export interface ClientSession {
  /** Identity for the things a client owns. The same object `OpSession` uses. */
  readonly owner: object;
  /** What a refusal calls this connection. Never parsed. */
  readonly label: string;
  /**
   * Deliver one event to this connection alone. `false` means it did not land
   * — the client holds no subscription, or the one it holds was collapsed into
   * a `resync_required` and this event is part of the gap.
   */
  deliver(event: { type: string; value: unknown }): boolean;
}

/**
 * Nobody can answer: nobody is attached, the holder went away, or the prompt
 * this answer names is not one the broker is still waiting on.
 *
 * The message always begins with the code, because the code is what a plugin
 * branches on and the message is what a failing case prints — and the one place
 * both are read is `harness.lastHandlerError`, which only has the message.
 */
export class InteractionUnavailable extends Error {
  readonly code = "interaction_unavailable";

  constructor(reason: string) {
    super(`interaction_unavailable: ${reason}`);
    this.name = "InteractionUnavailable";
  }
}

/** Nobody answered inside `promptTimeoutMs`. */
export class InteractionTimeout extends Error {
  readonly code = "interaction_timeout";
  readonly promptId: string;

  constructor(request: PromptRequest) {
    super(
      `interaction_timeout: ${request.pluginId}'s ${request.kind} prompt ${request.promptId} ` +
        `went unanswered for ${String(request.timeoutMs)} ms`,
    );
    this.name = "InteractionTimeout";
    this.promptId = request.promptId;
  }
}

export interface InteractionBrokerDeps {
  readonly config: HostConfig;
  /**
   * Where a prompt failure nobody is waiting on goes.
   *
   * Most plugins call `modal.open()` **without** awaiting it, so a timeout or a
   * detach would otherwise surface as a process-level `unhandledRejection` with
   * no plugin name on it. See {@link InteractionBroker.reportUnobserved}.
   */
  readonly errors: HostErrors;
}

interface Pending {
  readonly request: PromptRequest;
  readonly resolve: (answer: PromptAnswer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class InteractionBroker {
  private session: ClientSession | null = null;
  private readonly prompts = new Map<string, Pending>();
  private sequence = 0;

  constructor(private readonly deps: InteractionBrokerDeps) {}

  /**
   * Take the channel, or be told who has it.
   *
   * Refusing the second attach rather than replacing the first is the whole of
   * the one-holder rule: a client that took the channel from another would
   * silently redirect prompts the first client is still showing a human.
   */
  attach(session: ClientSession): void {
    const held = this.session;
    if (held !== null && held.owner !== session.owner) {
      throw new InteractionUnavailable(
        `${held.label} already holds the interaction channel; it has to detach (or ` +
          "disconnect) before another client can answer prompts",
      );
    }
    this.session = session;
  }

  /**
   * Release the channel, and fail everything it had not answered.
   *
   * A detach that left prompts pending would leave them to time out two minutes
   * later against a client that is already gone — so the plugin would wait two
   * minutes to be told something the host knew immediately.
   *
   * A detach from a session that is not the holder is a no-op rather than a
   * throw: the ordinary caller is a disconnect, and every connection that ever
   * closes runs through it whether or not it ever attached.
   */
  detach(session: ClientSession): void {
    const held = this.session;
    if (held === null || held.owner !== session.owner) return;
    this.session = null;
    this.failAll(
      new InteractionUnavailable(
        `${held.label} released the interaction channel before answering`,
      ),
    );
  }

  attached(): boolean {
    return this.session !== null;
  }

  /** Is this the connection that holds the channel? */
  isHolder(session: ClientSession): boolean {
    return this.session !== null && this.session.owner === session.owner;
  }

  /** Ask, and answer with what the human chose — or fail, typed. */
  ask(request: Omit<PromptRequest, "promptId" | "timeoutMs">): Promise<PromptAnswer> {
    const session = this.session;
    if (session === null) {
      return Promise.reject(
        new InteractionUnavailable(
          `no client is attached to answer ${request.pluginId}'s ${request.kind} prompt`,
        ),
      );
    }
    this.sequence += 1;
    const full: PromptRequest = {
      ...request,
      promptId: `prompt-${String(this.sequence)}`,
      items: [...request.items],
      timeoutMs: this.deps.config.promptTimeoutMs,
    };
    return new Promise<PromptAnswer>((resolve, reject) => {
      const timer = this.deps.config.clock.setTimeout(() => {
        // Dropped before the rejection, so a `catch` that asks what is pending
        // sees the truth rather than a prompt nothing will ever answer.
        this.prompts.delete(full.promptId);
        reject(new InteractionTimeout(full));
      }, full.timeoutMs);
      this.prompts.set(full.promptId, { request: full, resolve, reject, timer });
      try {
        // **A prompt that was not delivered fails now, not in two minutes.**
        // An ordinary event a lagging client missed is recovered by re-reading
        // — that is what the `resync_required` it was given instead is for. A
        // prompt is not recoverable that way: it is a question with a plugin
        // waiting on the answer, and nobody received it, so the honest outcome
        // is the same typed refusal a detach gives, immediately.
        if (
          !session.deliver({
            type: "host.interaction_request",
            value: toWireInteractionRequest(full),
          })
        ) {
          this.settle(full.promptId);
          reject(
            new InteractionUnavailable(
              `${session.label} did not receive the prompt: its event subscription is behind and ` +
                "was collapsed into a resync, so the question reached nobody",
            ),
          );
        }
      } catch (error) {
        // The socket went between the attach and this write. Fail now rather
        // than waiting two minutes to discover it, and keep the cause.
        this.settle(full.promptId);
        reject(
          new InteractionUnavailable(
            `${session.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /**
   * Answer one prompt. `false` when the id names nothing the broker is waiting
   * on — an unknown prompt, or one that has already been answered or timed out.
   */
  answer(promptId: string, answer: PromptAnswer): boolean {
    const pending = this.settle(promptId);
    if (pending === null) return false;
    pending.resolve(answer);
    return true;
  }

  /** Every question still waiting on a human, oldest first. */
  pending(): readonly PromptRequest[] {
    return [...this.prompts.values()].map((entry) => entry.request);
  }

  /**
   * The question `promptId` names, if it is still waiting.
   *
   * The ops layer reads it to check an answer's `choice_index` against the
   * items this host actually offered — a check only the request can settle, and
   * one that has to happen before {@link answer} consumes the prompt.
   */
  pendingFor(promptId: string): PromptRequest | null {
    return this.prompts.get(promptId)?.request ?? null;
  }

  /**
   * Report a prompt failure the plugin never looked at.
   *
   * Phase `interaction`, which **never counts toward a quarantine**: a host
   * whose client detached is not evidence that a plugin is broken, and five
   * prompts abandoned by a human would otherwise disable a working plugin. It
   * is still attributed and still visible to `harness.lastHandlerError`, which
   * is the difference between "uncounted" and "swallowed" — see
   * `runtime/quarantine.ts` and the `config`-phase precedent it names.
   *
   * **Only a broker failure belongs here.** The caller narrows to
   * {@link InteractionUnavailable} and {@link InteractionTimeout} before
   * calling; a plugin's own throw from its choice handler travels the counting
   * path like any other handler failure. See `shim/components.ts`.
   *
   * The arguments are in `HostErrors.report`'s order — error first, plugin
   * second — because this forwards straight to it and both are loose enough
   * that a transposition would type-check.
   */
  reportUnobserved(error: unknown, pluginId: string | null): void {
    this.deps.errors.report(error, pluginId ?? HOST_PLUGIN_ID, "interaction");
  }

  /**
   * Report a **plugin's own** failure raised inside a brokered prompt, with
   * nobody awaiting it.
   *
   * The counterpart to {@link reportUnobserved}, and the reason that one is
   * narrowed: a prompt's promise covers two pieces of plugin code — an `async`
   * `getSuggestions()` and the choice handler — and a throw from either is the
   * plugin failing, not the channel. Phase `command`, which is where an
   * unawaited command callback's rejection already goes, so it is counted
   * toward a quarantine exactly as that one is.
   */
  reportHandlerFailure(error: unknown, pluginId: string | null): void {
    this.deps.errors.report(error, pluginId ?? HOST_PLUGIN_ID, "command");
  }

  /** Take a prompt out of the map and disarm its timer. */
  private settle(promptId: string): Pending | null {
    const pending = this.prompts.get(promptId);
    if (pending === undefined) return null;
    this.prompts.delete(promptId);
    this.deps.config.clock.clearTimeout(pending.timer);
    return pending;
  }

  private failAll(error: InteractionUnavailable): void {
    for (const promptId of [...this.prompts.keys()]) {
      const pending = this.settle(promptId);
      pending?.reject(error);
    }
  }
}

/**
 * Keyed by the `App` rather than held in a module-level variable, so two hosts
 * in one process never read each other's wiring — the same rule
 * `installPluginHost` follows, and for the same failure.
 */
const brokers = new WeakMap<App, InteractionBroker>();

/** Wire an assembled host's broker to the `App` its plugins are handed. */
export function installInteractionBroker(app: App, broker: InteractionBroker): void {
  brokers.set(app, broker);
}

/**
 * The broker behind an `App`, or `null` for an `App` this host never assembled.
 *
 * `null` rather than a throw, because the caller is a modal's `open()`: a
 * `Modal` built against a bare `App` is a plugin's own business, and the honest
 * answer to "can anybody answer this" there is no, not an exception about
 * assembly.
 */
export function interactionBrokerFor(app: App): InteractionBroker | null {
  return brokers.get(app) ?? null;
}
