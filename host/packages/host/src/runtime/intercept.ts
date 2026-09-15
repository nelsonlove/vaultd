/**
 * The **second** of the two module mechanisms: a deliberately narrow patch of
 * `Module._load`.
 *
 * The first mechanism is resolution, and it is where the work should happen:
 * `loadPluginBundle` gives the module it builds a `paths` array that starts at
 * the host's own `node_modules`, so an ordinary `require("obsidian")` inside a
 * bundle resolves to the workspace's `obsidian` package by Node's own
 * algorithm, with nothing patched and every other specifier keeping Node's
 * ordinary semantics. That covers a bundle this loader compiled.
 *
 * It does not cover everything. A bundle that re-requires itself by path, a
 * nested worker file it spawns, a package it reaches that in turn reaches for
 * `obsidian` — those are loaded by modules this loader never built, with `paths`
 * that go nowhere near the host. So there is a patch, and it maps the specifiers
 * **regardless of who is asking**.
 *
 * **What it maps, and why that is the whole list.**
 *
 * - `obsidian` and `electron` — the two bare specifiers every sampled bundle
 *   reaches for, answered from the registries a host registered at assembly.
 * - the `@codemirror/` namespace — an inert stub, recorded. CodeMirror is the
 *   design's out-of-scope tier and no `@codemirror/*` package is installed at
 *   all, so an unmapped require of one is `Cannot find module` at **module
 *   scope**, which kills the bundle before its class is defined. Exactly one
 *   golden does this (`nested-properties`, `@codemirror/state` and
 *   `@codemirror/view`), and what it does with the result is register an editor
 *   extension — which this host already harvests as unreachable. So the stub is
 *   not a pretence that CM6 works: the require itself is recorded as an
 *   `editor_extension` the host cannot reach, naming the package, and the
 *   compatibility report says so.
 *
 * Everything else delegates to the original `_load`, which is how a bundle's
 * `require("tty")`, `require("util")` and `require("os")` come out as Node's own
 * modules. A broader patch would slow every unrelated require in the process and
 * would be an unbounded behaviour change for no named gain.
 *
 * **No `vm` context anywhere.** Plugins run with the host's Node privileges, as
 * they do under Electron. The design's non-goals say so, and `--dry-run` is
 * explicitly a refusal gate rather than a sandbox: the list below is what a
 * dry-run run refuses to hand out, and a determined bundle could still reach
 * those modules another way. It is a guard rail, not a wall.
 */

import Module from "node:module";

import { FS_MODULE_SPECIFIERS } from "./fs-access";
import { currentElectronStub, currentObsidianApi } from "./electron-registry";
import { currentPluginId, refuseInDryRun } from "../shim/policy";
import type { Harvest } from "../shim/harvest";

export interface InterceptionOptions {
  /** Where the workspace's `obsidian` and `electron` packages live. */
  readonly hostModulePaths: readonly string[];
  /** `false` under dry-run: the modules in {@link REFUSED_UNDER_DRY_RUN} refuse. */
  readonly allowNodeBuiltins: boolean;
  /**
   * Where a `@codemirror/*` require is written down.
   *
   * Optional because the patch is useful without it — a caller that only wants
   * the two bare specifiers mapped needs no harvest — and because the harvest
   * belongs to an assembled host, which an interception installed before one
   * exists does not have.
   */
  readonly harvest?: Harvest | undefined;
}

export interface Interception {
  restore(): void;
  interceptedCount(): number;
}

/** The namespace with no package behind it. See the header. */
const CODEMIRROR = "@codemirror/";

/**
 * What `--dry-run` refuses to hand a bundle: the file system, process spawning,
 * and the network.
 *
 * Both spellings of each, because `require("http")` and `require("node:http")`
 * are the same module and a list that named one would be a list a bundle walks
 * around by accident. The fs spellings come from the seam, which is the one
 * file allowed to name them — see `runtime/fs-access.ts`.
 */
const REFUSED_UNDER_DRY_RUN: ReadonlySet<string> = new Set([
  ...FS_MODULE_SPECIFIERS,
  "child_process",
  "node:child_process",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
]);

/** Node's own loader, as a callable, plus the slot it lives in. */
interface LoaderSlot {
  // A property rather than a method, so that reading it to keep the original
  // is not an unbound-method mistake: it really is a free function that takes
  // its receiver from the call site, and `original.call(this, …)` below is what
  // hands it back.
  _load: (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
  globalPaths: string[];
}

/**
 * One inert stub module per `@codemirror/*` specifier, for the life of the
 * process.
 *
 * Cached because a module is: two requires of the same package in one process
 * hand back the same object, and a bundle that compares what it got from two
 * call sites would otherwise see two different things.
 */
const codemirrorModules = new Map<string, unknown>();

/** Which plugins have already been recorded against which package. */
const codemirrorRecorded = new Set<string>();

export function installModuleInterception(options: InterceptionOptions): Interception {
  const slot = Module as unknown as LoaderSlot;
  const original = slot._load;
  let intercepted = 0;
  let restored = false;

  // The host's `node_modules` as a **last-resort** lookup path, which is what
  // `globalPaths` is: Node consults it only for a specifier that its ordinary
  // walk up the directory tree failed to find. So this changes nothing for any
  // module that already resolves, and gives the two workspace packages a way to
  // be found from a bundle materialised outside the host tree even when the
  // patch below is not the thing that answers.
  const addedGlobalPaths = options.hostModulePaths.filter((path) => !slot.globalPaths.includes(path));
  slot.globalPaths.unshift(...addedGlobalPaths);

  function patched(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "obsidian") {
      intercepted += 1;
      return currentObsidianApi();
    }
    if (request === "electron") {
      intercepted += 1;
      return currentElectronStub();
    }
    if (request.startsWith(CODEMIRROR)) {
      intercepted += 1;
      return codemirrorModule(request, options.harvest);
    }
    if (!options.allowNodeBuiltins && REFUSED_UNDER_DRY_RUN.has(request)) {
      refuseInDryRun(`node_builtin.${request}`, "node_builtin", request);
    }
    return original.call(this, request, parent, isMain);
  }

  slot._load = patched;

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      // Only if it is still ours. A second interception installed on top of
      // this one and not yet restored owns the slot, and putting Node's
      // original back would drop that one silently — a patch that vanished
      // without anyone asking is the failure this guard exists to prevent.
      if (slot._load === patched) slot._load = original;
      for (const path of addedGlobalPaths) {
        const at = slot.globalPaths.indexOf(path);
        if (at !== -1) slot.globalPaths.splice(at, 1);
      }
    },
    interceptedCount(): number {
      return intercepted;
    },
  };
}

/**
 * The stub a `@codemirror/*` specifier resolves to, and the row it records.
 *
 * Recorded once per `(plugin, package)` rather than once per call: the
 * compatibility report is about what a plugin reaches for, and a bundle that
 * requires the same package from three call sites has one dependency on it, not
 * three.
 */
function codemirrorModule(specifier: string, harvest: Harvest | undefined): unknown {
  const pluginId = currentPluginId();
  if (harvest !== undefined && pluginId !== null) {
    const key = `${pluginId}\0${specifier}`;
    if (!codemirrorRecorded.has(key)) {
      codemirrorRecorded.add(key);
      harvest.recordUnreachable({ pluginId, kind: "editor_extension", detail: specifier });
    }
  }
  const existing = codemirrorModules.get(specifier);
  if (existing !== undefined) return existing;
  const fresh = inertModule(specifier);
  codemirrorModules.set(specifier, fresh);
  return fresh;
}

/**
 * A module object whose every member is an inert class-or-function, never
 * `undefined`.
 *
 * "Never `undefined`" is the requirement, and it is a requirement about how
 * bundles fail. `Prec.highest(...)`, `StateField.define({...})`,
 * `new ViewPlugin(...)` — a member that came back `undefined` turns each of
 * those into a `TypeError` at module scope, which costs the plugin everything
 * after it. An inert callable lets the expression complete with a value that
 * goes on to be handed to `registerEditorExtension`, which this host records as
 * unreachable and never runs.
 *
 * **Three names answer something other than an inert member**, because all
 * three are read by machinery rather than by plugin code: `then` must be
 * `undefined` or `await`ing anything from this module hangs forever waiting for
 * a thenable that never settles; `__esModule` is `true` and `default` is the
 * module itself, which is what a CommonJS build of an ES module looks like and
 * what every interop wrapper in the corpus is written against.
 */
function inertModule(specifier: string): unknown {
  const target: Record<string, unknown> = {};
  const module: unknown = new Proxy(target, {
    get(_target, property: string | symbol): unknown {
      if (typeof property === "symbol") return undefined;
      if (property === "then") return undefined;
      if (property === "__esModule") return true;
      if (property === "default") return module;
      const cached = target[property];
      if (cached !== undefined) return cached;
      const member = inertMember(`${specifier}.${property}`);
      target[property] = member;
      return member;
    },
    has(): boolean {
      return true;
    },
  });
  return module;
}

/**
 * One inert member: callable, constructible, and endlessly reachable through.
 *
 * Named after the path that reached it, so a stack trace from a bundle that
 * does something surprising with one says which package and which member it
 * came from rather than `anonymous`.
 */
function inertMember(name: string): unknown {
  const shape = function inert(): void {
    // Nothing. Construction and calls both answer with another inert member.
  };
  Object.defineProperty(shape, "name", { value: name, configurable: true });
  const members = new Map<string, unknown>();
  const member: unknown = new Proxy(shape, {
    get(shapeTarget, property: string | symbol): unknown {
      if (typeof property === "symbol") return Reflect.get(shapeTarget, property);
      if (property === "then") return undefined;
      if (property === "prototype" || property === "name" || property === "length") {
        return Reflect.get(shapeTarget, property);
      }
      const cached = members.get(property);
      if (cached !== undefined) return cached;
      const nested = inertMember(`${name}.${property}`);
      members.set(property, nested);
      return nested;
    },
    apply(): unknown {
      return member;
    },
    construct(): object {
      return member as object;
    },
  });
  return member;
}
