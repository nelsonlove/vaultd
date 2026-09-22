/**
 * `@vaultd/host` — the headless Obsidian plugin host.
 *
 * This entry point re-exports the runtime pieces the workspace stub packages
 * (`obsidian`, `electron`) and the host binary reach for. It deliberately does
 * not export anything from `src/testing/`: that code patches process-wide fs
 * namespaces and belongs only to the test tree.
 */
export {
  ElectronNotRegistered,
  clearElectronStub,
  currentElectronStub,
  registerElectronStub,
} from "./runtime/electron-registry";
export type { ElectronStub } from "./runtime/electron-registry";
