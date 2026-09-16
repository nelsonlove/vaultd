"use strict";

// Hand-authored fixture. Tier 4: the plugin is the view. Its whole body builds
// a leaf and fills it with DOM, and its one lifecycle gate is onLayoutReady.
// The React constant below is the framework's own.
var obsidian = require("obsidian");

const React = {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentOwner: {} },
};

class UpdateListView extends obsidian.ItemView {
  getViewType() {
    return "update-list";
  }

  getDisplayText() {
    return "Updates";
  }

  async onOpen() {
    const root = this.containerEl.createEl("div", { cls: "update-root" });
    root.createEl("h2", { text: "Updates" });
    renderInto(root);
  }
}

function renderInto(root) {
  root.createEl("div", { text: Object.keys(React).length.toString() });
}

class UpdateTrackerPlugin extends obsidian.Plugin {
  async onload() {
    this.registerView("update-list", (leaf) => new UpdateListView(leaf));
    this.addRibbonIcon("refresh-cw", "Show updates", () => this.reveal());
    this.app.workspace.onLayoutReady(() => this.reveal());
  }

  async reveal() {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: "update-list", active: true });
  }
}

module.exports = UpdateTrackerPlugin;
