/**
 * The `obsidian` module, as a plugin bundle resolves it.
 *
 * **A minimal barrel, created in Task 10 and owned by Task 11b.** Task 10's own
 * cases write `class extends harness.api.Plugin`, so the barrel has to be
 * reachable two tasks before the task that fills it in. What is here is exactly
 * the bindings that exist so far, bound by hand. Task 11b **replaces the body**
 * of {@link createObsidianApi} with the `API_POLICY`-driven walk: every symbol
 * in the policy table, bound to its implementation, its safe stub, or a getter
 * that throws `HeadlessUnsupported` — and it asserts that the barrel's key set
 * and `declaredSymbols()` agree. Until then, a name a plugin reaches for that is
 * not below is `undefined` rather than a typed refusal.
 *
 * The index signature is 11b's declaration, kept here unchanged: a barrel is a
 * module object, and a plugin may read any name off it. The named members are
 * the ones this host's own code and tests use as types — an index signature
 * alone would type every one of them `unknown`, and `class extends
 * (something: unknown)` does not compile.
 */

import { App } from "./app";
import { Component, Plugin } from "./plugin";
import { DataAdapter, FileSystemAdapter } from "./adapter";
import { Events, Menu, MenuItem } from "./events";
import { FileManager } from "./file-manager";
import { MetadataCache } from "./metadata-cache";
import { StubEl, StubFragment, createDiv, createEl, createFragment, createSpan, getIcon, setIcon } from "./dom";
import { TAbstractFile, TFile, TFolder } from "./files";
import { Vault } from "./vault";
import {
  EditableFileView,
  FileView,
  ItemView,
  MarkdownView,
  View,
  Workspace,
  WorkspaceLeaf,
} from "./workspace";
import type { HostAssembly } from "../testing/assemble";
import type { HostWindow } from "./globals";
import type { StubDocument } from "./dom";

/**
 * `window` and `document`, as a plugin uses them.
 *
 * **Aliases since Task 11a**, and that is the point: the `window` a plugin
 * reaches through the `obsidian` module and the `window` it reaches as a bare
 * global have to be the same object, or a plugin that arms an interval through
 * one and clears it through the other would leak a timer the host cannot see.
 * The names stay because Task 10's surfaces are typed with them.
 */
export type ShimWindow = HostWindow;
export type ShimDocument = StubDocument;

export interface ObsidianApi {
  readonly App: typeof App;
  readonly Component: typeof Component;
  readonly DataAdapter: typeof DataAdapter;
  readonly DocumentFragment: typeof StubFragment;
  readonly EditableFileView: typeof EditableFileView;
  readonly Events: typeof Events;
  readonly FileManager: typeof FileManager;
  readonly FileSystemAdapter: typeof FileSystemAdapter;
  readonly FileView: typeof FileView;
  readonly HTMLElement: typeof StubEl;
  readonly ItemView: typeof ItemView;
  readonly MarkdownView: typeof MarkdownView;
  readonly Menu: typeof Menu;
  readonly MenuItem: typeof MenuItem;
  readonly MetadataCache: typeof MetadataCache;
  readonly Plugin: typeof Plugin;
  readonly TAbstractFile: typeof TAbstractFile;
  readonly TFile: typeof TFile;
  readonly TFolder: typeof TFolder;
  readonly Vault: typeof Vault;
  readonly View: typeof View;
  readonly Workspace: typeof Workspace;
  readonly WorkspaceLeaf: typeof WorkspaceLeaf;
  readonly createDiv: typeof createDiv;
  readonly createEl: typeof createEl;
  readonly createFragment: typeof createFragment;
  readonly createSpan: typeof createSpan;
  readonly getIcon: typeof getIcon;
  readonly setIcon: typeof setIcon;
  readonly moment: HostWindow["moment"];
  readonly window: ShimWindow;
  readonly activeWindow: ShimWindow;
  readonly activeDocument: ShimDocument;
  readonly [symbol: string]: unknown;
}

/**
 * Bind one assembled host's `obsidian` module.
 *
 * It takes the assembly rather than nothing because the timer functions have to
 * arm on **this** host's clock: a test that advances its own `TestClock` must
 * see its own plugin's intervals fire, and a module-level pair would arm every
 * host's timers on whichever clock was installed last.
 *
 * The parameter is spelled `Omit<HostAssembly, "api">` so the assembler can
 * call it while building the very object it returns; a full {@link HostAssembly}
 * is assignable to it, so a later caller holding one passes it unchanged.
 */
export function createObsidianApi(assembly: Omit<HostAssembly, "api">): ObsidianApi {
  const { globals } = assembly;
  return Object.freeze({
    App,
    Component,
    DataAdapter,
    DocumentFragment: StubFragment,
    EditableFileView,
    Events,
    FileManager,
    FileSystemAdapter,
    FileView,
    HTMLElement: StubEl,
    ItemView,
    MarkdownView,
    Menu,
    MenuItem,
    MetadataCache,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    Vault,
    View,
    Workspace,
    WorkspaceLeaf,
    createDiv,
    createEl,
    createFragment,
    createSpan,
    getIcon,
    setIcon,
    // The same library the globals install, at the second address plugins read
    // it from: `import { moment } from "obsidian"`. Two of the eight golden
    // bundles take that road and `window.moment` the other, and handing them
    // two different objects would be a bug waiting for a locale change.
    moment: globals.window.moment,
    // The installed globals themselves, not a second pair: a plugin that arms
    // an interval through `window.setInterval` and clears it through the bare
    // global has to be talking to one registry, or the host leaks a timer it
    // cannot count.
    window: globals.window,
    activeWindow: globals.window,
    activeDocument: globals.document,
  });
}
