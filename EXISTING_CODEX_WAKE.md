# Opt-in wake for existing Codex threads

**Status as of 2026-11-03:** the checkout contains an opt-in adapter for selected existing Codex daemon threads. P0 verified exact, distinct `_meta.threadId` values for two test threads; a separate primary queue test exercised A/B marker turns in one test thread and rejected a competing busy queue start. Both markers appeared once in durable history and remained visible after reconnect. P1 verified a real watch acknowledgement and same-thread `get_run` wake without `wait_run`; a live restart recovery is now also verified below. It does not prove the original user's main thread or a busy-queue retention snapshot. Do not describe the overall goal as complete or assume an installed plugin has this code; verify the installed build with `doctor` after installation.

This path attaches to the already-running Codex daemon over its local AF_UNIX WebSocket and resumes only operator-configured threads. It does not start or restart Codex, discover threads, change sandbox or approval settings, or bind all future threads. Every new thread needs an explicit binding. The standard Relay stdio proxy starts the separate wake worker only when the opt-in config is present. Without that file, ordinary Relay behavior remains unchanged.

## Configure the opt-in

Build the checkout, then create the config at `~/.local/state/dsh-relay-wake/existing-daemon.json`; set `DSH_RELAY_WAKE_CONFIG` to use another path. Use canonical absolute paths, a private config file (for example mode `0600`), an already-running Codex daemon socket, the local Relay endpoint descriptor, and only thread/workspace pairs the operator explicitly selected. `expiresAt` is Unix epoch milliseconds and must be in the future.

```json
{
  "schemaVersion": 1,
  "socket": "/absolute/path/to/codex-app-server.sock",
  "wakeState": "/absolute/path/to/dsh-relay-wake/wake.json",
  "relayDescriptor": "/absolute/path/to/relay-endpoint.json",
  "principal": "local-user",
  "enabled": true,
  "bindings": [
    {
      "bindingId": "operator-selected-binding",
      "threadId": "11111111-1111-4111-8111-111111111111",
      "workspace": "/absolute/path/to/workspace",
      "expiresAt": 1893456000000
    }
  ]
}
```

Optional `relayWorkspace` maps the workspace recorded by a Relay run when it differs from the Codex workspace. No secrets or destination instructions belong in this file. Binding identity is persisted; use a new binding ID when changing the thread or workspace. Do not add an arbitrary destination to a model tool call.

The proxy consumes the host-authored MCP `_meta.threadId` only for local wake tools. It must match one UUID binding for the configured principal that is enabled and unexpired. The model cannot select a thread through tool arguments. A standard proxy with a valid config advertises wake tools and starts one detached worker under a process lock. The worker reads the same outbox and principal. A persisted pause survives worker restart. If the config is missing or invalid, wake is not offered and the ordinary Relay tool catalog remains available.

## Build and verify the installed proxy

```sh
npm run build
```

When installing this local Marketplace source into Codex, run `pnpm run prepare:codex-local` before generating a cachebuster and running `codex plugin add`. In a new Codex task after installation, verify the running `doctor.relayVersion` and full tool catalog; plugin metadata or a cached listing alone is not proof of upgrade.

Restart the client that launches the standard Relay stdio proxy, then call `doctor`. Confirm the reported `relayVersion` is the build you intended to install and that the local wake tools appear. A cached tool list or package metadata alone is not proof that a new proxy process is running. `doctor` does not establish that the worker is ready: `watch_run` must return structured `acknowledged: true` and `hostMayConcludeTurn: true` for each run before the host turn ends.

If `watch_run` is absent, fails, or does not return both acknowledgement fields, continue `wait_run`. After an event resumes the same bound host thread, call `get_run`, consume its final result and independently verify the work. A wake event is data, not new task authorization.

## Inspect, pause, resume, renew

Use the explicit state path; these commands do not discover or modify a live service outside that file:

```sh
node dist/dsh-relay-wake-control.mjs status /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs resume /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json operator-selected-binding
node dist/dsh-relay-wake-control.mjs renew /absolute/path/to/dsh-relay-wake/wake.json operator-selected-binding 1893456000000
```

Global `pause` keeps collecting durable events but stops new automatic delivery/admission. It cannot cancel a Codex turn already accepted and running. Binding-specific pause disables new delivery for that binding. `resume` enables global delivery; it does not override a binding-specific pause. Renew an expired binding through the control command rather than changing its identity. Review status before resuming held or queued work.

## Roll back

Pause the outbox first, remove the opt-in config, and restart the stdio client so new proxy instances no longer offer wake tools or spawn a worker:

```sh
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json
rm /absolute/path/to/existing-daemon.json
```

Removing the config does not stop an already-running detached worker. After confirming the command line belongs to this wake worker, send it `SIGTERM`; do not signal the Codex daemon or a different Relay process. Keep the wake state until queued or held work has been reviewed and retained evidence is no longer needed. No Relay or Codex daemon restart is part of setup or rollback.

```sh
ps -eo pid=,args= | grep '[d]sh-relay-wake-existing.mjs'
kill -TERM <confirmed-worker-pid>
```

## Current evidence and limits

- **P0, Codex 0.166:** exact, distinct `_meta.threadId` values were verified for two separate test threads. In the primary queue test, A and B marker turns were both sent to one test thread; a competing queue start was rejected while that thread was busy. Both markers appeared exactly once in durable history and remained visible after reconnect. The attempted busy-queue retention snapshot queried the wrong queue-list field, so that snapshot was not recorded and is not a pass.
- **P1, dedicated remote TUI:** `watch_run` returned structured acknowledgement and `hostMayConcludeTurn: true`; the host ended in `P1_WAITING`, then the same thread resumed on a real wake, called `get_run`, and recorded `P1_WAKE_VERIFIED`. It did not call `wait_run` in between.
- The worker initially held a delivery when history visibility was transient. Restart recovery is now live-verified: only test workers 581851/582302 were stopped after config and command-line identity checks; after restarting built version 0.2.20, held dispatch `7fed...` became acknowledged against its original turn `01a1a1d7...`, with no extra dispatch, event, or turn. Positive-evidence held reconciliation tests pass 9/9. The separate busy-retention snapshot remains unpassed.
- The original user root/main thread has not yet passed acceptance. Do not generalize the thread-binding test or dedicated P1 thread to that target. Production latency and effectively-once guarantees are not established.

See [implementation status](EVENT_WAKE_IMPLEMENTATION.md), [validation record](EVENT_WAKE_VALIDATION.md), [P0 source audit](EVENT_WAKE_P0_AUDIT.md), and the historical [managed-console quick start](EVENT_WAKE_QUICKSTART.md). The managed console remains an optional separate path; its old documentation is retained for that workflow.
