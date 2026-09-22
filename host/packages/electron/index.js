"use strict";

/**
 * The `electron` module, for a bundle compiled against Electron.
 *
 * A live forwarding proxy rather than `currentElectronStub()` called once, for
 * the same reason the `obsidian` package is one: a module body runs once, and a
 * stub captured then belongs to whichever host was assembled at that moment. It
 * also means a bundle that requires this **before** a host has assembled gets
 * the typed refusal at its first property read rather than at require time,
 * which is where the diagnostic is useful.
 *
 * `runtime/electron-registry.ts` holds the whole of the reasoning.
 */

const { electronModule } = require("@vaultd/host/dist/runtime/electron-registry.js");

module.exports = electronModule();
