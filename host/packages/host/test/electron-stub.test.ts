import { afterEach, describe, expect, it, vi } from "vitest";

import { HeadlessUnsupported } from "../src/shim/policy";
import { DryRunRefused } from "../src/shim/policy";
import { createElectronStub } from "../src/runtime/electron-stub";
import {
  ElectronNotRegistered,
  clearElectronStub,
  currentElectronStub,
  registerElectronStub,
} from "../src/runtime/electron-registry";

/**
 * The `electron` module a desktop-only bundle resolves, and the two things it
 * has to be at once: a real bridge to the OS opener for the three `shell` calls
 * plugins actually make, and a *named* refusal for everything else.
 *
 * The named half is the point of the `Proxy`. A bundle that reaches for
 * `remote` or `webFrame` on a plain object gets `undefined`, calls it, and dies
 * with `undefined is not a function` several frames from the cause — which
 * tells a compatibility report nothing. Here it dies with `electron.remote`, in
 * the message, with the plugin attributed.
 */
afterEach(() => {
  clearElectronStub();
});

describe("electron stub", () => {
  it("bridges shell.openPath to the OS opener", async () => {
    const spawned: Array<[string, string[]]> = [];
    const stub = createElectronStub({
      dryRun: false,
      spawn: (command, args) => {
        spawned.push([command, [...args]]);
        return Promise.resolve();
      },
    });
    await expect(stub.shell.openPath("/tmp/x.md")).resolves.toBe("");
    await stub.shell.showItemInFolder("/tmp/x.md");
    await stub.shell.openExternal("https://example.test/");
    expect(spawned).toEqual([
      ["open", ["/tmp/x.md"]],
      ["open", ["-R", "/tmp/x.md"]],
      ["open", ["https://example.test/"]],
    ]);
  });

  it("makes ipcRenderer inert for listeners and typed for invoke", () => {
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() });
    const listener = vi.fn();
    expect(() => stub.ipcRenderer.on("channel", listener)).not.toThrow();
    expect(() => stub.ipcRenderer.send("channel", 1)).not.toThrow();
    expect(() => stub.ipcRenderer.removeListener("channel", listener)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    try {
      stub.ipcRenderer.invoke("some-channel");
      expect.unreachable("invoke must throw");
    } catch (error) {
      // One constructor signature everywhere: (symbol, pluginId, detail?).
      expect(error).toBeInstanceOf(HeadlessUnsupported);
      expect((error as HeadlessUnsupported).symbol).toBe("electron.ipcRenderer.invoke");
      expect((error as HeadlessUnsupported).detail).toBe("some-channel");
      expect((error as HeadlessUnsupported).message).toContain("electron.ipcRenderer.invoke");
    }
  });

  it("registers as the singleton the electron package resolves", () => {
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() });
    registerElectronStub(stub);
    expect(currentElectronStub()).toBe(stub);
    clearElectronStub();
    expect(() => currentElectronStub()).toThrow(ElectronNotRegistered);
  });

  it("refuses every OS bridge under dry-run", async () => {
    const stub = createElectronStub({
      dryRun: true,
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(stub.shell.openPath("/tmp/x.md")).rejects.toThrow(/dry_run_refused/);
    await expect(stub.shell.openExternal("https://example.test/")).rejects.toThrow(/dry_run_refused/);
    await expect(stub.shell.showItemInFolder("/tmp/x.md")).rejects.toThrow(DryRunRefused);
    // The surface is what a dry-run report groups by, so it is a field rather
    // than a substring of the message.
    await stub.shell.openPath("/tmp/x.md").catch((error: unknown) => {
      expect((error as DryRunRefused).surface).toBe("os_bridge");
      expect((error as DryRunRefused).symbol).toBe("electron.shell.openPath");
    });
  });

  it("throws typed for remote and webFrame", () => {
    const stub = createElectronStub({
      dryRun: false,
      spawn: () => Promise.resolve(),
    }) as unknown as Record<string, unknown>;
    for (const property of ["remote", "webFrame", "clipboard", "nativeImage"]) {
      try {
        (stub[property] as () => void)();
        expect.unreachable(`${property} must throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(HeadlessUnsupported);
        expect((error as HeadlessUnsupported).symbol).toBe(`electron.${property}`);
      }
    }
  });

  it("answers the interop probes a bundler asks, rather than refusing them", () => {
    // `__esModule`, `default` and `then` are asked by machinery, not by a
    // plugin: a bundler's default-interop wrapper reads the first two, and
    // `await` reads the third. A refusal there would turn `await import`-shaped
    // code and every `await stub` into a throw naming a symbol nobody wrote.
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() }) as unknown as Record<
      string,
      unknown
    >;
    for (const probe of ["__esModule", "default", "then"]) {
      expect(stub[probe], probe).toBeUndefined();
    }
  });
});
