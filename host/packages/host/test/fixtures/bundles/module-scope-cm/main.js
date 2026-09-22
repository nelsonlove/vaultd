"use strict";
// Registers at **module scope**, before any instance exists — which is where
// `nested-properties` reaches for CodeMirror too. The row it produces can only
// carry a plugin id if the loader compiles inside the plugin's attribution
// window rather than only around `onload`.
var import_state = require("@codemirror/state");
var import_obsidian = require("obsidian");
var ModuleScopePlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.sawStateField = typeof import_state.StateField;
  }
};
module.exports = ModuleScopePlugin;
