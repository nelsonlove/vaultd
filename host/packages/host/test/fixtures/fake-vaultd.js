"use strict";
/**
 * A fake `vaultd`, as a **real child process**.
 *
 * The supervisor's whole job is process lifecycle — spawn, stdio ownership,
 * death, restart — and an in-process fake cannot prove any of it: there is no
 * pid to kill, no stdin whose EOF ends anything, and no exit code. So this is a
 * separate Node program, spawned exactly the way the real engine is.
 *
 * It speaks only the handful of methods the supervisor itself issues, plus the
 * two the supervisor's tests need to steer it. Everything else is refused with
 * the real daemon's own `invalid_request` shape.
 *
 * Modes, from `FAKE_VAULTD_MODE` (which arrives through `HostConfig.env`, so a
 * test proves the env crossed the process boundary rather than merely existing
 * on a config object):
 *
 * - `ok` — answers everything, lives until its stdin closes.
 * - `exit-immediately` — exits 3 before reading a byte: an engine that cannot
 *   start at all.
 * - `die-after-health` — answers one `health` and exits 9: an engine that dies
 *   the instant it is declared ready.
 * - `slow-health` — holds the `health` answer for `FAKE_VAULTD_HEALTH_DELAY_MS`
 *   (default 400 ms), which is the only way to be *inside* a spawn when
 *   something else happens to the supervisor.
 * - `no-subscribe` — answers everything except `subscribe_events`, which it
 *   refuses: an engine with no runtime to subscribe to, the shape a
 *   health-only daemon has.
 * - `no-vault-info` — answers `subscribe_events` and then refuses
 *   `get_vault_info`: a subscription that half-opens.
 *
 * Three further steering doors, in every mode: the `die` method exits 9 on
 * demand (a crash at a moment a test chooses), `FAKE_VAULTD_LIVE_STATE`
 * decides whether the subscription opens already `watching` or opens
 * `catching_up` and then announces the move — which is the real daemon's own
 * startup shape and the thing the supervisor's readiness hangs on — and
 * `FAKE_VAULTD_PIDFILE` names a file this process writes its pid into, so a
 * test can ask the operating system whether an engine was orphaned rather than
 * asking the supervisor, which is the thing under test.
 */
const readline = require("node:readline");
const { writeFileSync } = require("node:fs");

const mode = process.env.FAKE_VAULTD_MODE ?? "ok";
const generation = Number(process.env.FAKE_VAULTD_GENERATION ?? "1");
const liveState = process.env.FAKE_VAULTD_LIVE_STATE ?? "catching_up";
const healthDelayMs = Number(process.env.FAKE_VAULTD_HEALTH_DELAY_MS ?? "400");
const pidfile = process.env.FAKE_VAULTD_PIDFILE;
if (pidfile) writeFileSync(pidfile, String(process.pid), "utf8");
if (mode === "exit-immediately") {
  // Say why on stderr, the way the real daemon does when it refuses to start.
  process.stderr.write("fake-vaultd: refusing to start\n");
  process.exit(3);
}

let subscriptions = 0;

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function ok(id, type, value) {
  send({ version: 1, id, outcome: { status: "ok", value: { type, value } } });
}

function refuse(id, message) {
  send({
    version: 1,
    id,
    outcome: { status: "err", value: { code: "invalid_request", message } },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const envelope = JSON.parse(line);
  const method = envelope.request.method;
  if (method === "health") {
    const answer = () => {
      ok(envelope.id, "health", { service: "vaultd", status: "ok" });
      if (mode === "die-after-health") process.exit(9);
    };
    if (mode === "slow-health") setTimeout(answer, healthDelayMs);
    else answer();
    return;
  }
  if (method === "get_vault_info" && mode === "no-vault-info") {
    refuse(envelope.id, "get_vault_info is refused in this mode");
    return;
  }
  if (method === "get_vault_info") {
    ok(envelope.id, "get_vault_info", {
      generation,
      canonical_root: process.env.FAKE_VAULTD_ROOT ?? "/tmp/vault",
      // Echo the mode so the supervisor test can prove config.env reached this
      // process rather than merely existing on the config object.
      vault_identity: `fake:${mode}`,
      state: { state: "ready" },
      note_count: 0,
      refreshed_at_unix_ms: 0,
      live_state: "watching",
    });
    return;
  }
  if (method === "subscribe_events" && mode === "no-subscribe") {
    refuse(envelope.id, "this engine has no runtime to subscribe to");
    return;
  }
  if (method === "subscribe_events") {
    subscriptions += 1;
    const subscriptionId = `fake-sub-${subscriptions}`;
    ok(envelope.id, "subscribe_events", {
      subscription_id: subscriptionId,
      generation,
      live_state: liveState,
    });
    // A subscription that opened during catch-up sees the move to `watching`
    // as an ordinary event, exactly as the real daemon delivers it. Sent on a
    // later turn so it is a genuine post-response event rather than part of
    // the response's own chunk.
    if (liveState === "catching_up") {
      setImmediate(() => {
        send({
          version: 1,
          subscription_id: subscriptionId,
          event: {
            type: "runtime_state_changed",
            value: { generation, live_state: "watching" },
          },
        });
      });
    }
    return;
  }
  if (method === "unsubscribe") {
    ok(envelope.id, "unsubscribe", null);
    return;
  }
  if (method === "die") {
    // No response, ever: a crash is not a refusal, and the client must fail
    // the request itself when the transport dies under it.
    process.exit(9);
  }
  refuse(envelope.id, `unknown method ${method}`);
});
// The host owns this process's stdin. When the host goes, so does this.
rl.on("close", () => process.exit(0));
