/**
 * The one {@link RequestSink} that survives an engine restart.
 *
 * A `VaultdClient` is one connection to one engine and dies with it. The mirror
 * has always known that — `Mirror.open` takes a supplier rather than a client,
 * and the type was narrowed to the supplier form so that a silently-wrong call
 * could not compile. The shim did not know it: `assembleShim` took a client and
 * handed the same object to the vault, the adapter, both config registries, the
 * command registry, the plugin host and the editor, every one of which kept it
 * for the life of the process.
 *
 * Measured against a real daemon, that cost one defect and hid it completely.
 * SIGKILL the engine under a running host, let the supervisor bring a new one
 * up, then edit a note: the plugin gets `modify` and `resolved` and **never
 * gets `changed`**, because the lifecycle sequencer's read of the note's source
 * goes to the dead socket, fails, and the event is skipped rather than fired
 * with data the host does not have. Metadata-change events stop reaching
 * plugins, for the life of the process, with nothing in any log to say so. No
 * fake-daemon test can see it: a fake daemon's connection never dies.
 *
 * So the supplier is resolved **per call**, at one place, behind an interface
 * that says the shim only ever asks questions.
 */

import type { RequestSink } from "../client/request-sink";
import type { VaultdClient } from "../client/client";

/**
 * A sink that asks whoever is the engine's client **now**.
 *
 * `supplier` is read at every call and never stored: that is the whole of the
 * mechanism. It is also why this returns a sink rather than exposing the
 * supplier — a module handed the supplier can resolve it once into a field, and
 * a module handed a sink cannot.
 *
 * The supplier may throw (the supervisor's `client()` does when there is no
 * engine at all), and the throw is left to travel: "there is no engine" is a
 * real answer to a request, and a sink that swallowed it would hand the caller
 * a promise that never settles.
 */
export function forwardingSink(supplier: () => VaultdClient): RequestSink {
  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      return supplier().request<T>(method, params);
    },
  };
}
