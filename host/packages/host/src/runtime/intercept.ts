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
import { electronModule, interceptionLayers, obsidianModule } from "./electron-registry";
import { currentPluginId, declarePolicy, refuseInDryRun } from "../shim/policy";
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
const REFUSED_BARE: readonly string[] = [
  // The file system, through the seam that is the one file allowed to name it.
  ...FS_MODULE_SPECIFIERS.filter((specifier) => !specifier.startsWith("node:")),
  // Spawning a process, which reaches everything else on the machine.
  "child_process",
  // The network, all of it. The review found `dgram`, `tls`, `dns` and `http2`
  // resolving under an earlier list that named only `http`/`https`/`net`; a
  // refusal list with holes is a refusal list a bundle walks around by
  // accident, so the holes are closed rather than carried to Task 19.
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dns",
  "dgram",
  // The escape hatches: three ways to reach any of the above from code this
  // list would otherwise never see.
  "worker_threads",
  "vm",
  "inspector",
];

/**
 * What `--dry-run` refuses to hand a bundle: the file system, process spawning,
 * the network, and the ways out of this list.
 *
 * Both spellings of each, because `require("http")` and `require("node:http")`
 * are the same module.
 *
 * **It refuses every requester while installed, not only plugin bundles.** The
 * host's own file-system access is captured at module scope in
 * `runtime/fs-access.ts` and so is unaffected, but anything that reached for
 * one of these lazily during a dry-run would refuse itself. Task 19 built the
 * gate and left this boundary where it found it, because nothing in the host
 * installs this patch yet: `installModuleInterception` has no non-test caller,
 * so the only thing arming it today is `test/module-intercept.test.ts`. **Task
 * 22's `main.ts` is where it gets drawn properly** — that is the entry point
 * that will pass `allowNodeBuiltins: !config.dryRun`, and the first
 * configuration in which "who is asking" is a question with consequences.
 */
const REFUSED_UNDER_DRY_RUN: ReadonlySet<string> = new Set([
  ...REFUSED_BARE,
  ...REFUSED_BARE.map((specifier) => `node:${specifier}`),
]);

/** The symbol a refusal of `specifier` is recorded under. */
function builtinSymbol(specifier: string): string {
  return `node_builtin.${specifier}`;
}

/** Node's own loader, as a callable, plus the slot it lives in. */
interface LoaderSlot {
  // A property rather than a method, so that reading it to keep the original
  // is not an unbound-method mistake: it really is a free function that takes
  // its receiver from the call site, and `delegate.call(this, …)` below is what
  // hands it back.
  _load: LoadFn;
  globalPaths: string[];
}

type LoadFn = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;

/**
 * One installed interception, as a link in a chain rather than as an owner of
 * the slot.
 *
 * **Why a chain and not "put back what I found".** Interceptions nest — a
 * harness installs one, a test installs another inside it — and they are not
 * guaranteed to be restored in the order they were installed. The obvious
 * implementation captures `Module._load` at install and writes it back at
 * restore, which silently clobbers a newer patch; the obvious repair ("only
 * write back if the slot is still mine") turns that into something worse, an
 * outer layer that quietly gives up its original and leaves `Module._load`
 * patched for the life of the process with no handle able to undo it.
 *
 * So each layer keeps a `delegate` it forwards to and an `active` flag, and
 * restoring a layer does two things: it goes inert (so an orphaned reference to
 * its `patched` still forwards correctly), and the layer above it is re-linked
 * to skip it. Only the top layer touches the slot. Restore the layers in any
 * order and `Module._load` ends byte-identical to what Node installed.
 */
interface Layer {
  active: boolean;
  /** What this layer forwards to: the layer below, or Node's own `_load`. */
  delegate: LoadFn;
  /** The function this layer put in the slot. */
  patched: LoadFn;
}

/**
 * Every interception installed and not yet restored, bottom first.
 *
 * **In the process cell, not module-level**, and for the same reason
 * `electron-registry.ts` keeps its registries there: a test process holds two
 * copies of this file — Vitest's transform of `src/`, and Node's `dist/` if a
 * package pulls it in — and two module-level arrays would be two independent
 * chains over **one** `Module._load`. Restoring out of order across them is
 * exactly the stranded-patch failure the chain exists to close, so the chain
 * has to be the process's, not the module instance's.
 */
function layerStack(): Layer[] {
  return interceptionLayers() as Layer[];
}

/**
 * One inert stub module per `@codemirror/*` specifier, for the life of the
 * process.
 *
 * Cached because a module is: two requires of the same package in one process
 * hand back the same object, and a bundle that compares what it got from two
 * call sites would otherwise see two different things.
 *
 * The *recording* state is deliberately not here — see the note on
 * `recorded` inside {@link installModuleInterception}.
 */
const codemirrorModules = new Map<string, unknown>();

export function installModuleInterception(options: InterceptionOptions): Interception {
  const slot = Module as unknown as LoaderSlot;
  let intercepted = 0;
  let restored = false;
  /**
   * Which `(plugin, package)` pairs this interception has already written down.
   *
   * **Per interception, not per process.** A module-level set would be a
   * process-wide memo of rows already reported, so a second host in the same
   * process — a second harness, a test that assembles twice — would record
   * nothing at all for a bundle the first host had already loaded, and its
   * compatibility report would be silently short. The dedup is only ever meant
   * to collapse a bundle requiring one package from three call sites into one
   * dependency; that question is per host, and an interception belongs to one.
   */
  const recorded = new Set<string>();

  // The host's `node_modules` as a **last-resort** lookup path, which is what
  // `globalPaths` is: Node consults it only for a specifier that its ordinary
  // walk up the directory tree failed to find. So this changes nothing for any
  // module that already resolves, and gives the two workspace packages a way to
  // be found from a bundle materialised outside the host tree even when the
  // patch below is not the thing that answers.
  const addedGlobalPaths = options.hostModulePaths.filter((path) => !slot.globalPaths.includes(path));
  slot.globalPaths.unshift(...addedGlobalPaths);

  const layer: Layer = { active: true, delegate: slot._load, patched: passThrough };

  function patched(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    // Restored, but somebody still holds a reference to this function — an
    // outer patch that captured it as its own original. Forward and stay out of
    // the way.
    if (!layer.active) return layer.delegate.call(this, request, parent, isMain);
    // Both mechanisms hand back the **same** module object, built once per
    // process by `electron-registry.ts`. Returning the barrel directly here
    // would make this mechanism the one that hands out a snapshot.
    if (request === "obsidian") {
      intercepted += 1;
      return obsidianModule();
    }
    if (request === "electron") {
      intercepted += 1;
      return electronModule();
    }
    if (request.startsWith(CODEMIRROR)) {
      intercepted += 1;
      return codemirrorModule(request, options.harvest, recorded);
    }
    if (!options.allowNodeBuiltins && REFUSED_UNDER_DRY_RUN.has(request)) {
      refuseInDryRun(builtinSymbol(request), "node_builtin", request);
    }
    return layer.delegate.call(this, request, parent, isMain);
  }

  layer.patched = patched;
  layerStack().push(layer);
  slot._load = patched;

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      layer.active = false;
      const stack = layerStack();
      const at = stack.indexOf(layer);
      if (at !== -1) {
        stack.splice(at, 1);
        // After the splice, index `at` is the layer that sat directly above
        // this one. Re-link it past this layer, so a chain that is later
        // unwound from the top reaches Node's own `_load` and nothing else.
        const above = stack[at];
        if (above !== undefined && above.delegate === patched) above.delegate = layer.delegate;
      }
      // Only the top layer owns the slot. Any other position is already handled
      // by the re-link above, and a foreign patch on top is left alone — this
      // layer has gone inert, so it costs that patch nothing but one forward.
      if (slot._load === patched) slot._load = layer.delegate;
      for (const path of addedGlobalPaths) {
        const at2 = slot.globalPaths.indexOf(path);
        if (at2 !== -1) slot.globalPaths.splice(at2, 1);
      }
    },
    interceptedCount(): number {
      return intercepted;
    },
  };
}

/** Placeholder until the real `patched` closure exists. Never called. */
function passThrough(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  void request;
  void parent;
  void isMain;
  throw new Error("module interception was used before it finished installing");
}

// The refusal rows this file owns. Declared `implemented`, because that is what
// these modules are: a host outside dry-run really does hand them over, and a
// compatibility report that showed the file system as a surface this host does
// not have would be describing the flag rather than the host. The dry-run
// refusal records a hit at this policy, which is the honest shape — "reached
// for, and this run said no".
for (const specifier of REFUSED_UNDER_DRY_RUN) declarePolicy(builtinSymbol(specifier), "implemented");

/**
 * The stub a `@codemirror/*` specifier resolves to, and the row it records.
 *
 * Recorded once per `(plugin, package)` rather than once per call: the
 * compatibility report is about what a plugin reaches for, and a bundle that
 * requires the same package from three call sites has one dependency on it, not
 * three.
 */
function codemirrorModule(
  specifier: string,
  harvest: Harvest | undefined,
  recorded: Set<string>,
): unknown {
  const pluginId = currentPluginId();
  if (harvest !== undefined && pluginId !== null) {
    const key = `${pluginId}\0${specifier}`;
    if (!recorded.has(key)) {
      recorded.add(key);
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
