export interface ElectronStub {
  readonly shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  readonly ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
    once(channel: string, listener: (...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (...args: unknown[]) => void): void;
    removeAllListeners(channel?: string): void;
    send(channel: string, ...args: unknown[]): void;
    sendSync(channel: string, ...args: unknown[]): never;
    invoke(channel: string, ...args: unknown[]): never;
  };
}

export class ElectronNotRegistered extends Error {
  readonly code = "electron_not_registered";
  constructor() {
    super(
      "require(\"electron\") was resolved before the host registered its stub; " +
        "call registerElectronStub(createElectronStub(...)) during host assembly, " +
        "before any plugin bundle loads",
    );
    this.name = "ElectronNotRegistered";
  }
}

let registered: ElectronStub | null = null;

/** Called exactly once during host assembly, before any bundle loads. */
export function registerElectronStub(stub: ElectronStub): void {
  registered = stub;
}

/** Called by the `electron` package's `index.js` at require time. */
export function currentElectronStub(): ElectronStub {
  if (registered === null) throw new ElectronNotRegistered();
  return registered;
}

/** Test-only: drop the registration so a fresh assembly can install its own. */
export function clearElectronStub(): void {
  registered = null;
}
