/**
 * The cross-UID half of the socket's security assertion. **Manual.**
 *
 * A genuine cross-UID test needs a second UID and a password prompt, so it
 * cannot run unattended and nothing in the default suite runs it: without
 * `VAULTD_HOST_UID_TEST` in the environment every case here is skipped.
 *
 * What it proves is the layer that actually enforces. `server-security.test.ts`
 * asserts the **modes** — `0700` on the directory, `0600` on the socket — which
 * is a statement about what this host wrote, not about what the kernel does with
 * it. This one asserts the consequence: another user cannot reach the socket at
 * all, because traversing a `0700` directory requires execute permission on it.
 *
 * It is the directory, not the socket file, that is doing that work. Darwin and
 * the BSDs historically ignore permission bits on an `AF_UNIX` socket at
 * `connect()` time, so the socket's own `0600` may be advisory on the platform
 * this host is developed on — which is why the expected failure below is
 * `EACCES` from the *directory* walk rather than from the socket.
 *
 * ## Running it
 *
 * ```bash
 * sudo -v                                                      # authenticate first
 * VAULTD_HOST_UID_TEST=1 npm --prefix host test -- server-uid.manual
 * ```
 *
 * **The case runs `sudo -n`, which never prompts**, and the two lines above are
 * why there are two of them: a test runner's child process has no terminal to
 * prompt on, so a prompting `sudo` would hang until the runner's timeout rather
 * than ask anybody anything. `sudo -v` first, in your own shell, is what makes
 * the `-n` run succeed — it caches the credential for a few minutes. (A
 * passwordless `sudo` rule for this user works too, and on a machine with
 * neither the case fails with sudo's own refusal rather than passing quietly: a
 * security assertion that skips itself on the way to green is worse than no
 * assertion at all, and this file is already opt-in.)
 *
 * The child runs as `nobody`, which exists on every macOS and Linux box and owns
 * nothing; it needs no write access anywhere, because all it does is try to
 * connect and report what it was told.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { HostHarness } from "../src/testing/host-harness";

/** The one-liner the other user runs: connect, and report what happened. */
const PROBE = [
  'const net = require("node:net");',
  "const socket = net.connect(process.argv[1]);",
  'socket.on("connect", () => { console.log("CONNECTED"); process.exit(0); });',
  'socket.on("error", (error) => { console.log(error.code); process.exit(0); });',
].join("\n");

describe.skipIf(!process.env["VAULTD_HOST_UID_TEST"])("the socket across a UID boundary", () => {
  it("refuses another user at connect, because the directory is 0700", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      const socketPath = await harness.server.listen();
      const reported = execFileSync(
        "sudo",
        ["-n", "-u", "nobody", process.execPath, "-e", PROBE, socketPath],
        { encoding: "utf8" },
      ).trim();
      // `EACCES` is the directory refusing the walk. A `CONNECTED` here would
      // mean the `0700` is not doing what the trust model says it does; an
      // `ENOENT` would mean `nobody` could not even see the path, which is the
      // same refusal one step earlier and is also acceptable.
      expect(["EACCES", "ENOENT"]).toContain(reported);
    } finally {
      await harness.stop();
    }
  });
});
