import { afterEach, describe, expect, it } from "vitest";
import {
  ElectronNotRegistered,
  clearElectronStub,
  currentElectronStub,
  registerElectronStub,
} from "../src/runtime/electron-registry";
import type { ElectronStub } from "../src/runtime/electron-registry";

const fakeStub = (): ElectronStub => ({
  shell: {
    openPath: () => Promise.resolve(""),
    showItemInFolder: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
  },
  ipcRenderer: {
    on: () => {}, off: () => {}, once: () => {},
    removeListener: () => {}, removeAllListeners: () => {}, send: () => {},
    sendSync: () => { throw new Error("unreachable"); },
    invoke: () => { throw new Error("unreachable"); },
  },
});

afterEach(() => clearElectronStub());

describe("electron registry", () => {
  it("throws a typed error when nothing is registered", () => {
    expect(() => currentElectronStub()).toThrow(ElectronNotRegistered);
    expect(() => currentElectronStub()).toThrow(/before the host registered its stub/);
  });

  it("returns the registered singleton, identically, on every call", () => {
    const stub = fakeStub();
    registerElectronStub(stub);
    expect(currentElectronStub()).toBe(stub);
    expect(currentElectronStub()).toBe(currentElectronStub());
  });

  it("lets a later registration replace an earlier one", () => {
    const first = fakeStub();
    const second = fakeStub();
    registerElectronStub(first);
    registerElectronStub(second);
    expect(currentElectronStub()).toBe(second);
  });
});
