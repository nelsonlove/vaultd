"use strict";
// A plugin whose **constructor** throws: the one failure path that reaches no
// `unload`, and therefore no `forgetPlugin`. The bundle evaluates, the class is
// found, and the plugin never exists — so anything the loader recorded against
// its id before construction has nothing to drop it.
var import_obsidian = require("obsidian");
var Doomed = class extends import_obsidian.Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    throw new Error("constructor blew up");
  }
};
module.exports = Doomed;
