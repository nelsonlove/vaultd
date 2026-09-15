"use strict";

/**
 * The `obsidian` module, as Node's own resolution algorithm finds it.
 *
 * `host/node_modules/obsidian` links here, so a bundle anywhere on disk whose
 * `module.paths` reach the host's `node_modules` resolves `require("obsidian")`
 * to this file — no patching, no loader hook, Node doing what Node does.
 *
 * **It is a `Proxy` and not a snapshot, because a module body runs once.** The
 * object a bundle must be handed is built per host (`createObsidianApi` binds
 * this host's clock, this host's notice log, this host's `window`), and a second
 * assembly in the same process must not leave a bundle holding the first one's
 * surfaces. So nothing is captured here: every read asks the registry for the
 * host assembled *now*.
 *
 * `has`, `ownKeys` and `getOwnPropertyDescriptor` are forwarded too, because
 * bundlers interrogate a module object as well as reading from it —
 * `"default" in mod`, `Object.keys(mod)`, `Object.assign({}, mod)`. A proxy that
 * answered only `get` would look empty to all three.
 *
 * The descriptor trap forces `configurable: true`. The assembled barrel is
 * frozen, so its own descriptors are non-configurable, and reporting a
 * non-configurable property that the proxy's target does not have is a
 * `TypeError` by the Proxy invariants — a correct answer that the language
 * refuses to let us give.
 */

const { currentObsidianApi } = require("@vaultd/host/dist/runtime/electron-registry.js");

module.exports = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property === "symbol") return undefined;
    return currentObsidianApi(property)[property];
  },
  has(_target, property) {
    if (typeof property === "symbol") return false;
    return property in currentObsidianApi(property);
  },
  ownKeys() {
    return Reflect.ownKeys(currentObsidianApi());
  },
  getOwnPropertyDescriptor(_target, property) {
    if (typeof property === "symbol") return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(currentObsidianApi(property), property);
    if (descriptor === undefined) return undefined;
    return { ...descriptor, configurable: true };
  },
});
