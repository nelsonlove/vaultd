/**
 * The injectable clock a test drives by hand. It lives in
 * `runtime/driven-clock.ts`, because the screen host uses the same clock in
 * production; this module keeps the name every test imports.
 */

export { drivenClock as testClock } from "../runtime/driven-clock";
export type { DrivenClock as TestClock } from "../runtime/driven-clock";
