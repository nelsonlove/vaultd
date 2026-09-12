/**
 * `App` — the object every plugin is handed, and the container the shim
 * assembles itself into.
 *
 * Built here, in Task 6b, ahead of its consumers: `harness.app` is read by
 * tests from Task 7 onward and `new Plugin(app, manifest)` needs the type, so a
 * plan that produced `App` in Task 12 produced it five tasks after its first
 * consumer.
 *
 * **A mutable container, assigned once.** The shim's surfaces refer to each
 * other in a cycle — the vault's rename event reaches the metadata cache, which
 * resolves links through the vault — so no construction order builds them all
 * with `readonly` fields set in their constructors. `assembleShim()` is the one
 * function allowed to fill this in, it does so exactly once, and every field
 * arrives non-null before any plugin bundle is loaded. A plugin therefore never
 * observes a half-built app; only the assembler does, and only for the length
 * of its own body.
 *
 * The fields land as their tasks build them, and this comment is the map:
 * Task 7 added `vault`, Task 8 adds `metadataCache`, Task 9 `fileManager`,
 * Task 11a `workspace` (it is Task 11a that builds `workspace.ts` and
 * `WorkspaceLeaf`, not Task 10 — the old Task 11 split into 11a and 11b and
 * this line did not follow), Task 12 `plugins`, `internalPlugins`, `commands`,
 * `keymap`, `scope`, `setting` and `foldManager`. Nothing here is re-decided later — a task adds its field and
 * the assembler's one assignment, and that is all.
 */
import type { MetadataCache } from "./metadata-cache";
import type { Vault } from "./vault";

export class App {
  /**
   * Obsidian's own per-vault identifier: a 16-character hex string a plugin may
   * use to key per-vault storage.
   *
   * Stable for a given vault root, because a plugin that keyed anything by it
   * would otherwise find its data orphaned on every host restart. The host
   * derives it from the vault path — see `assembleShim`.
   */
  readonly appId: string;

  /**
   * `app.vault` — filled by `assembleShim`, exactly once.
   *
   * Definite-assignment rather than a constructor argument, because the vault
   * holds surfaces that hold the app: there is no order in which both can be
   * built with their fields final. `assignOnce` refuses a second assignment, so
   * "assigned once by the assembler" is enforced rather than asserted, and no
   * plugin bundle is loaded before it lands.
   */
  vault!: Vault;

  /**
   * `app.metadataCache` — filled by `assembleShim`, exactly once, straight
   * after the vault.
   *
   * It is built second because it resolves links to the very `TFile` instances
   * the vault's index hands out, and it is assigned rather than constructed
   * into a `readonly` field for the same reason the vault is: the two surfaces
   * refer to each other, so no construction order leaves both final.
   */
  metadataCache!: MetadataCache;

  constructor(options: { appId: string }) {
    this.appId = options.appId;
  }
}
