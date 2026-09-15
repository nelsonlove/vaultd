"use strict";
// Five of the eight golden bundles call the timer names **bare** — `setTimeout`,
// not `window.setTimeout` — because that is what they were compiled for. A bare
// call inside a bundle resolves to `globalThis`, and `globalThis.setTimeout` is
// Node's own, which no injected clock can see and no test can advance. The
// loader's bundle wrapper shadows the four names with `window`'s, so this
// fixture arms its interval and its timeout with the bare spellings and the host
// still counts both.
var import_obsidian = require("obsidian");
var BareTimers = class extends import_obsidian.Plugin {
  async onload() {
    this.ticks = 0;
    // Registered, so the plugin's own teardown disarms it. The bare name is the
    // point: if it were Node's, `TestClock.armed()` would stay at zero.
    this.registerInterval(setInterval(() => {
      this.ticks += 1;
    }, 1000));
    // Armed and immediately withdrawn, which proves the other two names are the
    // host's as well: a bare `clearTimeout` of an id the host's clock handed out
    // only disarms anything if both halves came from the same clock.
    var pending = setTimeout(() => {
      this.timedOut = true;
    }, 500);
    clearTimeout(pending);
  }
};
module.exports = BareTimers;
