/**
 * What the shim actually needs of the daemon: one method, and a promise back.
 *
 * Seventeen call sites across `shim/` and `pluginset/` ask the daemon
 * questions. Every one of them calls `request`; not one touches framing,
 * subscriptions, `onEvent`, `onFatal`, or the transport's lifecycle. Typing
 * those modules against a whole {@link VaultdClient} therefore overstated what
 * they need, and the overstatement cost a real defect: a `VaultdClient` belongs
 * to one engine and dies with it, so a shim assembled around a captured one
 * went on asking a socket nobody was listening to after the first restart. The
 * symptom was silent and permanent — `Vault.cachedRead` failed, the lifecycle
 * sequencer skipped the `changed` event rather than firing one with invented
 * data, and metadata-change events simply stopped reaching plugins for the life
 * of the process.
 *
 * So the boundary is declared at its real width. A sink is anything that can be
 * asked a question: `VaultdClient` satisfies it structurally with no wrapper,
 * and so does the forwarding sink in `runtime/forwarding-sink.ts`, which looks
 * the current engine's client up **per call** and is what survives a restart.
 *
 * **One boundary, one interface, one implementation.** The alternative — hand
 * every module the supplier and let each call `client().request(...)` — puts
 * connection lifetime into seventeen places with no business knowing about it,
 * and gives every future module the chance to resolve the supplier once into a
 * field and reintroduce exactly this bug.
 */

/** Ask the daemon something. The only thing the shim ever does to it. */
export interface RequestSink {
  request<T>(method: string, params?: unknown): Promise<T>;
}
