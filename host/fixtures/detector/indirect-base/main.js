"use strict";

// Hand-authored fixture. The plugin class does not extend obsidian.Plugin: it
// extends a local base class that does. Matching `class extends *.Plugin`
// misses this shape (2 of the 34 minified bundles the study sampled), so the
// scanner has to follow the chain.
var obsidian = require("obsidian");

class BasePlugin extends obsidian.Plugin {
  async onload() {
    this.settings = await this.loadData();
    this.registerAll();
  }

  registerAll() {
    // Filled in by the subclass.
  }
}

class LinterPlugin extends BasePlugin {
  registerAll() {
    this.addCommand({
      id: "lint-file",
      name: "Lint the current file",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (file === null) return;
        await this.app.vault.process(file, (text) => text.trimEnd() + "\n");
      },
    });
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.sweep();
      }),
    );
  }

  sweep() {
    const files = this.app.vault.getMarkdownFiles();
    void files;
  }
}

module.exports = LinterPlugin;
