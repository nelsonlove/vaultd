"use strict";

/**
 * The `obsidian` module, as Node's own resolution algorithm finds it.
 *
 * `host/node_modules/obsidian` links here, so a bundle anywhere on disk whose
 * `module.paths` reach the host's `node_modules` resolves `require("obsidian")`
 * to this file — no patching, no loader hook, Node doing what Node does.
 *
 * The object itself is built by the host, not here, and the `Module._load`
 * patch in `runtime/intercept.ts` hands back that same object: one module
 * object per process, however a bundle reaches it. It is a live forwarding
 * proxy rather than a snapshot, because a module body runs once and the barrel
 * it would capture belongs to whichever host was assembled at that moment.
 * `runtime/electron-registry.ts` holds the whole of the reasoning.
 */

const { obsidianModule } = require("@vaultd/host/dist/runtime/electron-registry.js");

module.exports = obsidianModule();
