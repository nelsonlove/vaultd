"use strict";

// Hand-authored fixture. Tier 3: the configuration is authored through the
// settings panel and the rendering is a framework's, so the logic and the UI
// are one thing. The two Svelte constants below are the framework's own — they
// are what the scanner is allowed to match on.
var obsidian = require("obsidian");

const SettingsView = { name: "SettingsView" };

function mount(component, options) {
  const target = options.target;
  target.__svelte_meta = { loc: { file: "src/SettingsView.svelte", line: 1 } };
  return component;
}

function invalidDefaultSnippet() {
  throw new Error("https://svelte.dev/e/invalid_default_snippet");
}

class WidgetSettingTab extends obsidian.PluginSettingTab {
  display() {
    const container = this.containerEl;
    container.empty();
    new obsidian.Setting(container).setName("Widget mode").addToggle((toggle) => toggle.setValue(true));
    mount(SettingsView, { target: container.createEl("div") });
  }
}

class WidgetPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = await this.loadData();
    this.addSettingTab(new WidgetSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor("widget", (source, el) => {
      void source;
      mount(SettingsView, { target: el });
    });
    void invalidDefaultSnippet;
  }
}

module.exports = WidgetPlugin;
