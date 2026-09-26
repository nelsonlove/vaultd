/**
 * Is a `vaultd` already listening here?
 *
 * One connection, one `health` line, one answer, then close. **It never
 * throws**: every way this can fail — nothing at the path, a path that is not
 * a socket, a peer that accepts and says nothing, a half-line — means the same
 * thing to the caller, which is "no daemon here", and a probe that threw would
 * make `engine: auto`'s ordinary case an exception path.
 *
 * It does not use `VaultdClient`: the client is built to own a stream for the
 * life of an engine and to fail its pending requests when that stream ends,
 * and a probe wants the opposite — one question, a deadline, and no opinion
 * about what happens next.
 */

import { connect } from "node:net";
import type { Socket } from "node:net";

import type { Clock } from "./config";

export interface ProbeResult {
  readonly answered: boolean;
  /** Connect-to-answer, in milliseconds. `0` when nothing answered. */
  readonly ms: number;
}

/**
 * How long a probe waits before calling the path dead.
 *
 * The daemon's own `listener.rs::PROBE_TIMEOUT` — generous enough for a loaded
 * machine, short enough that a start is not held up by a socket nobody owns.
 */
export const PROBE_TIMEOUT_MS = 500;

/**
 * The `id` the probe sends, and one of the two ways an answer is recognised.
 *
 * The same literal as the daemon's `listener.rs::PROBE_ID`, so a daemon reading
 * its own logs sees one probe shape whichever process sent it.
 */
export const PROBE_ID = "vaultd-probe";

const HEALTH = `${JSON.stringify({
  version: 1,
  id: PROBE_ID,
  request: { method: "health" },
})}\n`;

/**
 * Is this line a `vaultd` response envelope?
 *
 * **Answering is the test, not answering well.** A daemon one protocol version
 * ahead replies an `incompatible_version` error and is exactly as alive as one
 * replying `ok`; requiring `ok` would hand a working daemon's socket to
 * whichever process probed it the day `PROTOCOL_VERSION` moves. So the rule is
 * the daemon's `listener.rs::is_response_envelope`, restated here: an `outcome`
 * object, which every response carries whatever its status, **or** the `id` the
 * probe sent echoed back. Two ways rather than one because a future envelope
 * may rename or nest the outcome, and the correlation id is the part the
 * protocol can least afford to change.
 *
 * Anything that is not a response envelope — a greeting banner, a stray line
 * from some unrelated program holding this path — is not a `vaultd`, and is as
 * stale as an empty file.
 */
function isResponseEnvelope(line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as { outcome?: unknown; id?: unknown };
  const outcome = envelope.outcome;
  if (typeof outcome === "object" && outcome !== null && !Array.isArray(outcome)) return true;
  return envelope.id === PROBE_ID;
}

export function probeEngineSocket(
  path: string,
  clock: Clock,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((settle) => {
    const started = clock.now();
    // Connected before the deadline is armed, so a synchronous throw — a path
    // long enough to overflow `sockaddr_un`, say — needs no timer to cancel.
    let socket: Socket;
    try {
      socket = connect(path);
    } catch {
      settle({ answered: false, ms: 0 });
      return;
    }
    let done = false;
    let buffered = "";
    const finish = (answered: boolean): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      socket.destroy();
      settle({ answered, ms: answered ? clock.now() - started : 0 });
    };
    const timer = clock.setTimeout(() => finish(false), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      // A write that fails raises `error`, which finishes the probe false.
      socket.write(HEALTH);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const at = buffered.indexOf("\n");
      if (at < 0) return;
      finish(isResponseEnvelope(buffered.slice(0, at)));
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
