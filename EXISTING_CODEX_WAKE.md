# Opt-in wake for existing Codex threads

**Status as of 2026-11-04:** version 0.2.22 is verified on both the original user main thread and a fresh Codex conversation using the installed default plugin. The fresh conversation enrolled automatically within the configured workspace roots, acknowledged `watch_run`, ended its turn, then received a real DSH completion event and consumed `get_run`; it made zero `wait_run` calls. The original main-thread test also delivered concurrent results across separate and batched turns. Wake delivery waits for the destination thread to become idle; it does not inject notifications into an ongoing generation. These results do not establish every reliability scenario or a latency target.

This path attaches to the already-running Codex daemon over its local AF_UNIX WebSocket. With autoBind enabled, the proxy records new conversation mappings from host request metadata inside configured workspace roots and the worker attaches them dynamically. Users do not enter a thread ID for each conversation. The adapter does not start/restart Codex, scan unrelated conversations, or change thread permissions. Without autoBind, the previous static-only mode remains available. The standard Relay stdio proxy starts the separate wake worker only when the opt-in config is present. Without that file, ordinary Relay behavior remains unchanged.

## Configure the opt-in

Build the checkout, then create the config at `~/.local/state/dsh-relay-wake/existing-daemon.json`; set `DSH_RELAY_WAKE_CONFIG` to use another path. Use canonical absolute paths, a private config file (for example mode `0600`), an already-running Codex daemon socket, the local Relay endpoint descriptor, and workspace roots the operator has authorized. `expiresAt` is Unix epoch milliseconds and must be in the future.

```json
{
  "schemaVersion": 1,
  "socket": "/absolute/path/to/codex-app-server.sock",
  "wakeState": "/absolute/path/to/dsh-relay-wake/wake.json",
  "relayDescriptor": "/absolute/path/to/relay-endpoint.json",
  "principal": "local-user",
  "enabled": true,
  "bindings": [],
  "autoBind": {
    "workspaceRoots": ["/absolute/path/to/authorized/workspace-root"],
    "ttlMs": 604800000
  }
}
```

`enabled` seeds a brand-new wake state once, before bindings are written. Existing state keeps the operator's persisted pause/resume choice; editing this field does not resume an existing state. Configuration is read once per worker process: stop that worker, edit the config, and restart it to apply changes. Use the control commands below for pause/resume.

Optional `relayWorkspace` maps the workspace recorded by a Relay run when it differs from the Codex workspace. No credentials or model-generated destination instructions belong in this file. Binding identity is persisted; use a new binding ID when changing the thread or workspace. Do not add an arbitrary destination to a model tool call.

The proxy consumes host-authored MCP `_meta.threadId` for local wake enrollment and monitoring guidance; it never forwards that metadata to DSH. New mappings use the actual daemon-reported cwd, principal-owned run metadata and the configured root policy. Paused or expired mappings are never silently renewed or replaced. Cross-workspace mapping retains the prior scoped read-only restriction; use the registered project workspace for implementation runs.

The proxy consumes the host-authored MCP `_meta.threadId` only for local wake routing. It must match one UUID binding for the configured principal that is enabled and unexpired. The model cannot select a thread through tool arguments. A standard proxy with a valid config advertises wake tools and starts one detached worker under a process lock. The worker reads the same outbox and principal. A persisted pause survives worker restart. If the config is missing or invalid, wake is not offered and the ordinary Relay tool catalog remains available.

## Build and verify the installed proxy

```sh
npm run build
```

When installing this local Marketplace source into Codex, run `pnpm run prepare:codex-local` before generating a cachebuster and running `codex plugin add`. In a new Codex task after installation, verify the running `doctor.relayVersion` and full tool catalog; plugin metadata or a cached listing alone is not proof of upgrade.

Restart the client that launches the standard Relay stdio proxy, then call `doctor`. Confirm the reported `relayVersion` is the build you intended to install and that the local wake tools appear. A cached tool list or package metadata alone is not proof that a new proxy process is running. `doctor` does not establish that the worker is ready: `watch_run` must return structured `acknowledged: true` and `hostMayConcludeTurn: true` for each run before the host turn ends.

If `watch_run` is absent, fails, or does not return both acknowledgement fields, continue `wait_run`. After an event resumes the same bound host thread, call `get_run`, consume its final result and independently verify the work. A wake event is data, not new task authorization.

## Multiple runs and a busy main conversation

Delivery is serialized per destination thread. Once one automatic turn starts, later completion events remain durably pending until that turn ends and the thread is idle. A completed DSH run can therefore wait while Codex reviews or integrates an earlier result. This is not immediate notification during generation, and receiving one event does not establish the status of sibling runs.

A live audit of the two implementation runs observed the second completion at 02:50:56 (UTC+8), then its delivery at 02:55:19 after the first automatic turn ended. Both dispatch markers are present in the original thread's durable history, each with one admission attempt. The approximately four-minute delay came from serial delivery, not a missing terminal event. No busy-turn steering behavior was introduced by this revision.

## Brief fallback status

`wait_run` now defaults to `detail="brief"` on the Codex proxy: one short text line plus small structured status fields. Repeated slices do not repeat task prompts, scope declarations, model settings or assistant output. A terminal brief response points to `get_run`, which returns the full result with no detail argument. `wait_run(detail="full")` preserves legacy full snapshots for explicit inspection.

Active results and tool descriptions recommend `watch_run` when available, while still requiring both real acknowledgement fields before the host turn can end. A status projection or routing hint never manufactures acknowledgement.

## Inspect, pause, resume, renew

Use the explicit state path; these commands do not discover or modify a live service outside that file:

```sh
node dist/dsh-relay-wake-control.mjs status /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs resume /absolute/path/to/dsh-relay-wake/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json operator-selected-binding
node dist/dsh-relay-wake-control.mjs renew /absolute/path/to/dsh-relay-wake/wake.json operator-selected-binding 1893456000000
```

Global `pause` keeps collecting durable events but stops new automatic delivery/admission. It cannot cancel a Codex turn already accepted and running. Binding-specific pause disables new delivery for that binding. `resume` enables global delivery; it does not override a binding-specific pause. Renew an expired binding through the control command rather than changing its identity. Status includes `workerReady`, `workerHeartbeatAgeMs`, `workerBindings` and `pausedBindings` in addition to delivery counts. The readiness flag uses the same three-second heartbeat lease as watch admission. Review status before resuming held or queued work.

## Roll back

Pause the outbox first, remove the opt-in config, and restart the stdio client so new proxy instances no longer offer wake tools or spawn a worker:

```sh
node dist/dsh-relay-wake-control.mjs pause /absolute/path/to/dsh-relay-wake/wake.json
rm /absolute/path/to/existing-daemon.json
```

Removing the config does not stop an already-running detached worker. After confirming the command line belongs to this wake worker, send it `SIGTERM`; do not signal the Codex daemon or a different Relay process. Confirm that the selected worker has exited before considering rollback finished. Keep the wake state until queued or held work has been reviewed and retained evidence is no longer needed. No Relay or Codex daemon restart is part of setup or rollback.

```sh
ps -eo pid=,args= | rg 'dsh-relay-wake-existing[.]mjs'
kill -TERM <confirmed-worker-pid>
```

## Current evidence and limits

- **P0, Codex 0.166:** exact, distinct `_meta.threadId` values were verified for two separate test threads. In the primary queue test, A and B marker turns were both sent to one test thread; a competing queue start was rejected while that thread was busy. Both markers appeared exactly once in durable history and remained visible after reconnect. The attempted busy-queue retention snapshot queried the wrong queue-list field, so that snapshot was not recorded and is not a pass.
- **P1, dedicated remote TUI:** `watch_run` returned structured acknowledgement and `hostMayConcludeTurn: true`; the host ended in `P1_WAITING`, then the same thread resumed on a real wake, called `get_run`, and recorded `P1_WAKE_VERIFIED`. It did not call `wait_run` in between.
- The worker initially held a delivery when history visibility was transient. Restart recovery is now live-verified: only test workers 581851/582302 were stopped after config and command-line identity checks; after restarting built version 0.2.20, held dispatch `7fed...` became acknowledged against its original turn `01a1a1d7...`, with no extra dispatch, event, or turn. Positive-evidence held reconciliation tests pass 9/9. The separate busy-retention snapshot remains unpassed.
- **P2, original user main thread:** three concurrent real Ark reviews were watched through the installed standard plugin. B completed first and caused one automatic turn; A/C were then delivered together in a second turn. The original thread ID stayed unchanged; all three native `get_run` results were consumed, both deliveries had one admission attempt, and no model `wait_run` occurred after handoff. A subsequent implementation run was steered natively without replacing its run or watch; the steer operation was acknowledged and its terminal event returned to the same main thread.
- **Installed-build check:** a fresh read-only Codex task, using the installed standard plugin with no custom Relay alias, reported `doctor.relayVersion=0.2.20` and `remote.connected=true`; the required `doctor`, `list_capabilities`, `start_review` and `wait_run` tools were present.
- **0.2.21 revision check:** the final client/host regression files pass 16/16, worker diagnostics pass 1/1, and TypeScript plus `prepare:codex-local` pass. A fresh default-plugin Codex task reports version 0.2.21 with a connected Relay and the required tool catalog. The main wake worker's command line points to that installed cache; status reports one ready binding. Before/after comparison confirmed the main thread's workspace, model, reasoning and permission settings unchanged. The production DSH process and owner epoch were unchanged.
- **Final integration record:** five real DSH review/implementation results were consumed across four original-main automatic turns, including the A/C batch. All four deliveries had one admission attempt; the last delivery remains in progress while this final verification turn is active. No additional DSH request was submitted to manufacture a completion callback. The three prior automatic turns were already acknowledged before the client-only revision was installed.
- **0.2.22 fresh-conversation acceptance:** a new read-only Codex conversation used the default installed plugin, automatically recorded its host-authored thread mapping, submitted one real Ark review, acknowledged the native watch and ended the turn. Its next automatic turn consumed the full result with `get_run`; durable history contains exactly one automatic event, and the outbox records one acknowledged admission attempt. No manual thread configuration or `wait_run` was used. The connected proxy reported 0.2.22. The default brief response measured 738 bytes including text and structured content; the previously captured full snapshot for that run was 16,548 bytes. The four targeted regression files pass 29/29; TypeScript, build, version and package gates pass.
- **Limits:** the busy-retention snapshot was not recorded; a live high-risk approval interaction, every failure-matrix scenario, and production P95 latency have not been measured by this continuation. Controlled unit tests cover approval bookkeeping, uncertain outcomes, queue races and persistence. These are not represented as live E2E results.

See [implementation status](EVENT_WAKE_IMPLEMENTATION.md), [validation record](EVENT_WAKE_VALIDATION.md), [P0 source audit](EVENT_WAKE_P0_AUDIT.md), and the historical [managed-console quick start](EVENT_WAKE_QUICKSTART.md). The managed console remains an optional separate path; its old documentation is retained for that workflow.
