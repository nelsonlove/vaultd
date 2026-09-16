"use strict";

// Hand-authored fixture. Tier 2, the unreachable half: no command is
// registered either, but every entry point is a delegated DOM listener, and a
// host with no DOM can never deliver one.
var obsidian = require("obsidian");

class TagPanePlugin extends obsidian.Plugin {
  onload() {
    this.register(
      document.on("contextmenu", ".tag-pane-tag", (event, target) => {
        this.openMenu(event, target);
      }),
    );
    this.registerDomEvent(document, "contextmenu", (event) => {
      this.maybeMenu(event);
    });
    document.addEventListener("dragstart", (event) => {
      this.startDrag(event);
    });
  }

  openMenu(event, target) {
    const menu = new obsidian.Menu();
    menu.showAtMouseEvent(event);
    void target;
  }

  maybeMenu(event) {
    void event;
  }

  startDrag(event) {
    void event;
  }
}

module.exports = TagPanePlugin;
