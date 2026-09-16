"use strict";

// Hand-authored fixture. Tier 1: every entry point is a command callback or an
// event handler, and no callback builds any DOM.
var obsidian = require("obsidian");

class TagCountPlugin extends obsidian.Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.counts = new Map();
  }

  async onload() {
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.recount(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        this.recount(file);
      }),
    );
    this.addCommand({
      id: "count-tags",
      name: "Count the tags in this note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file === null) return;
        const cache = this.app.metadataCache.getFileCache(file);
        this.counts.set(file.path, cache === null ? 0 : 1);
      },
    });
    this.addCommand({
      id: "stamp-counts",
      name: "Stamp the count into this note",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (file === null) return;
        await this.app.vault.process(file, (text) => text + "\n<!-- counted -->\n");
      },
    });
  }

  recount(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    this.counts.set(file.path, cache === null ? 0 : 1);
  }
}

module.exports = TagCountPlugin;
