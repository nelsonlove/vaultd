/**
 * The event half of the vaultd protocol, as the subscription API's own surface.
 *
 * **Every type here is re-exported from `protocol.ts`, never re-declared.**
 * That module was written field-for-field from the shipped Rust
 * (`crates/vault-protocol/src/events.rs`) with `docs/protocol.md` as the
 * wire-verified example set, and a second declaration of the same shapes is a
 * second thing to keep in step. This module exists so a consumer of
 * {@link VaultdClient.subscribeEvents} imports the event vocabulary from one
 * place — and so the rules that vocabulary does *not* express have somewhere to
 * live. They are below, because a client that surfaces a change set without
 * them hands its caller a delta it will apply wrongly.
 *
 * ---
 *
 * ## The two change-set rules
 *
 * Both come from `docs/protocol.md` §Events, and this client applies neither:
 * it surfaces `changes` exactly as the daemon sent it. Applying them is the
 * consumer's job, and getting them wrong is silent.
 *
 * **1. Within one generation, `deleted` applies before `created`.** One path
 * may appear in both lists in the same generation, and that pairing has exactly
 * one meaning: the thing at that path was removed and a *different* thing was
 * created there — a folder replaced by a file of the same name is the case that
 * produces it. Apply `deleted` first and the path ends up holding the new
 * thing; apply `created` first and the delete wipes out the entry that was just
 * made. `modified` is unordered with respect to both.
 *
 * **2. A deleted folder implies its whole subtree.** A folder in `deleted`
 * means the folder and everything that was under it is gone. The descendants
 * are not necessarily spelled out — a watcher-driven delete names the folder
 * alone, while a complete reconciliation, which enumerated the vault, names the
 * folder *and* its descendants. Both are correct, and only a consumer that
 * applies the subtree rule gets the same state from either. Rule 1 takes the
 * removed subtree with it, which is why the two are stated together.
 *
 * A third fact is not a rule but is mistaken for one just as often: **a path in
 * `changes` is not necessarily a note.** The change set spans both axes the
 * cache indexes — semantic rows and file-tree rows — while
 * `affected_note_count` counts notes alone. A generation that only moved the
 * file tree reports zero affected notes with its paths still spelled out, so a
 * consumer that wants notes filters by extension, exactly as it must for the
 * vault itself.
 *
 * ## What to do on each `resync_required` reason
 *
 * `resync_required` means the generation moved in a way no per-path change set
 * describes. This client never retries anything on its own: it has no idea what
 * the caller's state is, and a retry it invented would race the caller's own
 * recovery. `current_generation` names the generation to re-read at, and **from
 * the daemon** it is never null in protocol version 1 — an event that could not
 * name a generation would tell a client nothing, so it is withheld rather than
 * emitted. The one null a subscriber can meet is this client's own, and the
 * next section says exactly which marker it is.
 *
 * - `runtime_recovered` — a startup catch-up, a periodic tick, a manual
 *   refresh, or a watcher-failure recovery. Re-read current state. This is also
 *   what a **slow stdio client** meets: backpressure latches dropped notices
 *   and announces them this way, not as the daemon's `subscriber_lag`.
 * - `watcher_overflow` — the watcher lost events. Re-read current state; the
 *   subscription itself is fine and detail resumes after it.
 * - `root_invalidated` — the vault root was removed or renamed. Re-reading is
 *   not enough: the host's whole view of the vault is suspect, and the correct
 *   response is to stop applying deltas and surface the condition.
 * - `subscriber_lag` — events were lost and detail was collapsed onto one
 *   marker. Re-read current state, and drain faster. **This is the one reason
 *   with two producers, and `current_generation` tells them apart.** From the
 *   daemon it names a generation (`lag_marker` always sets one) and means the
 *   *subscription's* queue filled because this client stopped draining. With
 *   `current_generation: null` it is **synthesized by this client**: its
 *   pre-registration buffer — the events that arrive between the daemon writing
 *   the subscribe response and the handler being installed — overflowed, and
 *   the client genuinely does not know which generations went missing, so it
 *   says null rather than inventing one. Null on `subscriber_lag`, and only
 *   there, is therefore the reliable signature of a client-synthesized marker.
 *   Both mean the same thing to a consumer: you lost events, re-read. The
 *   client's own marker is unreachable against a conformant daemon (§Bounds:
 *   the dispatcher drains after every notice, the registry's per-subscription
 *   bound of 64 is not reachable over stdio, and a subscription receives
 *   nothing before its response is written), so treat it as defence in depth
 *   rather than a case to plan around.
 * - `oversized_change_set` — the *preceding* generation held more than 1024
 *   paths and arrived as `counts_only`. Re-read current state; the counts are
 *   real, the paths are not coming.
 *
 * ## Ordering guarantees this client relies on, and passes through
 *
 * A `subscribe_events` response is written before its subscription can receive
 * anything, and an `unsubscribe` response is written *after* that
 * subscription's queue is flushed — so an event sharing a chunk with the
 * unsubscribe response is still that subscription's, and nothing follows it.
 * `generation` in the subscribe response is a **strict start point**: no
 * `generation_committed` at or below it is ever delivered. `resync_required`
 * and `runtime_state_changed` are not filtered that way, because an old
 * generation is still news when the message is "re-read".
 */

export {
  KNOWN_CHANGE_SET_KINDS,
  KNOWN_EVENT_TYPES,
  isKnownChangeSet,
  isKnownRuntimeEvent,
} from "./protocol";

export type {
  ChangeSetDto,
  ConfigChangedEventDto,
  EventEnvelope,
  GenerationCauseDto,
  GenerationCommittedEventDto,
  KnownChangeSetDto,
  KnownRuntimeEventDto,
  LiveStateDto,
  ResyncReasonDto,
  ResyncRequiredEventDto,
  RuntimeEventDto,
  RuntimeStateChangedEventDto,
  SubscribeEventsResponse,
  UnknownChangeSetDto,
  UnknownRuntimeEventDto,
} from "./protocol";

export type { SubscriptionHandle, SubscriptionErrorHandler } from "./client";
