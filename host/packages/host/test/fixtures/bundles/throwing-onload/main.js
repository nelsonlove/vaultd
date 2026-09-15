"use strict";
// A plugin that gets far enough to register real things and then fails. The
// registrations are the point: a host that rolled back only the registry entry
// would leave this plugin's command invokable and its interval firing.
var import_obsidian = require("obsidian");
var ThrowingPlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.addCommand({ id: "doomed", name: "Doomed", callback: () => {} });
    this.registerInterval(setInterval(() => {}, 1000));
    throw new Error("onload blew up");
  }
};
module.exports = ThrowingPlugin;
