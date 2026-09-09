import type { ErrorCode, ProtocolErrorBody } from "./protocol";

/**
 * A typed refusal from the daemon: `outcome.status === "err"`.
 *
 * The three tails are lifted onto camelCase properties because this is an
 * `Error` subclass rather than a wire shape, and every one of them is `null`
 * rather than `undefined` when absent — a caller branching on
 * `error.currentRevision` should not have to know which flavour of nothing the
 * daemon omitted.
 *
 * - `currentGeneration` accompanies `generation_mismatch`: the generation a
 *   stale cursor, or a lost snapshot pin, must restart from.
 * - `currentRevision` accompanies `revision_conflict`: the revision the target
 *   actually holds, so a compare-and-swap retry does not have to re-read and
 *   race the next writer.
 * - `supportedVersion` accompanies `incompatible_version`.
 *
 * `body` keeps the undisturbed wire object, including any field a later daemon
 * adds that this build does not lift.
 */
export class VaultdError extends Error {
  readonly code: ErrorCode;
  readonly currentGeneration: number | null;
  readonly currentRevision: string | null;
  readonly supportedVersion: number | null;
  readonly body: ProtocolErrorBody;

  constructor(body: ProtocolErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = "VaultdError";
    this.code = body.code;
    this.currentGeneration = body.current_generation ?? null;
    this.currentRevision = body.current_revision ?? null;
    this.supportedVersion = body.supported_version ?? null;
    this.body = body;
  }
}
