/**
 * Which paths a rename changes — the one answer both rename surfaces use.
 *
 * `vaultd` answers a rename with a generation, a revision and a **count** of
 * the inbound links it repaired. It never says which notes those links were in,
 * and for a folder it never says which rows moved. So a host that refetched
 * only the paths the wire named would leave the mirror wrong in two different
 * ways at once:
 *
 * - **The destination subtree.** A folder move lands every descendant at a new
 *   path nothing in the answer mentions. Refetching only the two named paths
 *   advanced the mirror past the generation that moved them, so the
 *   `generation_committed` describing it was dropped by the staleness guard and
 *   every file under that folder was gone from this host until a resync. Found
 *   in review against the real daemon; the reason `Vault.rename` has expanded
 *   subtrees since Task 7.
 * - **The referrers.** Every note whose links the daemon just rewrote has
 *   different bytes and a different revision. Leaving them in the mirror leaves
 *   `resolvedLinks`, `unresolvedLinks`, `backlinks` and every `outgoing`
 *   resolution stale — all four of which Task 8 hands straight to plugin code.
 *
 * The referrer set comes from the mirror's own resolved-link index, which is
 * the same data `vaultd` used to find the links it rewrote, so it is a superset
 * of what changed and never a subset; a superset only costs a refetch. Notes
 * the daemon *failed* to rewrite are in it too, because "the daemon could not
 * rewrite `Busy.md`" and "`Busy.md` is unchanged" are the same statement only
 * if nothing else touched it, which the mirror cannot know without asking.
 *
 * **Everything here must be read before the mutation is sent.** Afterwards
 * `from` no longer exists, its backlink entry is gone with it, and the subtree
 * this walks has moved — so a caller that computed the set afterwards would
 * compute an emptier one, silently.
 *
 * It lives in its own module because both `Vault.rename` and
 * `FileManager.renameFile` need it and neither is the other's dependency;
 * Task 9's review found the two surfaces disagreeing about what a rename
 * affects, which is exactly what one shared answer prevents.
 */

import { TFolder } from "./files";
import type { MirrorQuery } from "../mirror/types";
import type { TAbstractFile } from "./files";
import type { Vault } from "./vault";

/** The two subtree questions this needs of a vault, and nothing else. */
export type RenameVaultView = Pick<Vault, "movedPaths" | "descendantsOf">;

/**
 * Every path a rename of `file` to `newPath` changes: both ends, every row
 * under both ends of a folder move, and every note that linked to any of them.
 *
 * Call it **before** the mutation goes out — see the module doc.
 */
export function affectedPathsForRename(
  vault: RenameVaultView,
  mirror: Pick<MirrorQuery, "backlinks">,
  file: TAbstractFile,
  newPath: string,
): string[] {
  const from = file.path;
  const folder = file instanceof TFolder;
  const affected = new Set<string>(folder ? vault.movedPaths(from, newPath) : [from, newPath]);
  // A folder's referrers are the referrers of the notes inside it: nothing
  // links to a folder, and every note under it is about to move.
  const targets = folder ? [from, ...vault.descendantsOf(from)] : [from];
  for (const target of targets) {
    for (const reference of mirror.backlinks(target)) affected.add(reference.source_path);
  }
  return [...affected];
}
