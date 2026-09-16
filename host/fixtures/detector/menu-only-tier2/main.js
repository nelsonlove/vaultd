"use strict";

// Hand-authored fixture. Tier 2, the harvestable half: no command is
// registered, and the one entry point is a file-menu hook a headless host can
// still build and fire.
var obsidian = require("obsidian");

class RenameTagPlugin extends obsidian.Plugin {
  onload() {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item.setTitle("Rename tag").onClick(() => this.renameTag(file));
        });
      }),
    );
    this.tagPane = this.app.internalPlugins.getPluginById("tag-pane");
    this.wrangler = this.app.plugins.getPlugin("tag-wrangler");
  }

  async renameTag(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache === null) return;
    await this.app.vault.process(file, (text) => text.replace("#old", "#new"));
  }
}

module.exports = RenameTagPlugin;
