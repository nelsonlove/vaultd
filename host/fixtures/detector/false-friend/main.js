"use strict";

// Hand-authored fixture. No framework at all — the two traps the 2026-08-28
// minification study found are both here: the substring "vue" inside a French
// locale string, and "hydration" in a comment. A scanner that matched bare
// substrings would report Vue and React for a plugin that carries neither.
//
// Rehydration note: the cache is rebuilt at load, so hydration order is not
// load-bearing here.
//
// The bare framework *words* appear below and no framework-owned constant does
// anywhere in this file, which is the whole point of the case: a matcher
// loosened from a framework's own constant to the framework's name would report
// this plugin as a framework plugin. (The constants themselves are deliberately
// not written even in a comment here — a comment is bytes like any other, and
// the scanner reads bytes.)
var obsidian = require("obsidian");

const TOOLCHAIN = "built with esbuild: no svelte, no react, no preact and no vue in this bundle";

const LOCALE = {
  fr: { overview: "Vue d'ensemble", review: "Revue des notes", short: "vue" },
  en: { overview: "Overview", review: "Review of notes", short: "view" },
};

class ReviewPlugin extends obsidian.Plugin {
  onload() {
    this.addCommand({
      id: "review-note",
      name: LOCALE.en.review,
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file === null) return;
        const cache = this.app.metadataCache.getFileCache(file);
        void cache;
        void TOOLCHAIN;
      },
    });
  }
}

module.exports = ReviewPlugin;
