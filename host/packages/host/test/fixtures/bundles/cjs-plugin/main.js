"use strict";
// The esbuild-CJS shape every sampled bundle in the corpus has: a `__toCommonJS`
// wrapper, a namespace object for the `obsidian` import, and the plugin class on
// `default`. Checked in as a fixture so the loader is exercised against the
// shape it will really meet rather than against a hand-written module.
var __toCommonJS = (mod) => Object.assign({ __esModule: true }, mod);
var main_exports = {};
var import_obsidian = require("obsidian");
var CjsPlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.loadedWith = import_obsidian.normalizePath("Folder//Note.md");
    this.addCommand({ id: "probe", name: "Probe", callback: () => {} });
  }
};
main_exports.default = CjsPlugin;
module.exports = __toCommonJS(main_exports);
