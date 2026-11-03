# Event-driven wake: implementation and acceptance

> **Current status — 2026-11-03:** The checkout now also contains a separately opt-in adapter for explicitly configured existing Codex daemon threads. P0 verified distinct host metadata for two test threads, while A/B marker turns and busy rejection were exercised in one primary test thread; both markers appeared once in durable history and after reconnect. The attempted busy-retention snapshot used the wrong queue-list field and remains unpassed. P1 verified structured watch acknowledgement and same-thread `get_run` wake without intervening `wait_run`. Live restart recovery after a transient history-visibility hold now passes against built 0.2.20: the persisted held delivery was acknowledged against its original turn, with no additional dispatch/event/turn. The original user root/main thread remains unverified. This does not establish production rollout, P95, or effectively-once behavior. See [EXISTING_CODEX_WAKE.md](EXISTING_CODEX_WAKE.md) for setup and exact evidence. The managed-console material below is a dated historical workflow and remains optional.

This checkout provides an opt-in **managed console**, long-lived collector/dispatcher, private Codex App Server adapter and an augmented native Relay MCP proxy. It is an experimental implementation, not a production rollout. The installed Codex plugin remains unchanged. Under the user’s explicit October 30 authorization, the existing Host was gracefully restarted to register one synthetic fixture workspace; its eight existing registrations and session counts were preserved. November 2 work uses private test processes and does not restart the currently running Host.

The ordinary Relay proxy keeps its original tool catalog and polling behavior. Only an explicitly configured wake proxy adds the four durable-watch tools. Production Relay V3 state is unchanged; wake data uses its own strict V1 store.

## Acceptance matrix

| Stage | Implemented and verified | Still required before claiming completion |
| --- | --- | --- |
| P0 | Real installed Codex 0.165.0 in private state; resume/history; admission race reproduced and fixed in managed mode; actual independent DSH/Relay startup and native MCP connectivity | Ordinary remote TUI does not have exclusive admission; its acceptance remains open |
| P1 | Durable bindings/watches/outbox; background native get_run collector; watch acknowledgement; owned Codex adapter; dispatch identity and history reconciliation; actual model-originated A/B/C delegation ended while runs remained active, followed by three automatic same-thread result verifications with zero wait_run; independently audited from durable history | Managed-console vertical slice accepted; ordinary remote-TUI display remains outside this acceptance |
| P2 | Independent runs, attention priority, 500 ms batching, per-thread exclusion, global bounds, pause/resume/expiry and operator renewal | Real B-first and A/C continuation accepted; native DSH steering and human-interaction E2E remain |
| P3 | Atomic storage, cross-process locks, proven-dead-owner recovery, uncertain delivery holds, backoff/dead letters, retention, cursor gaps and diagnostics | Real paused-event SIGKILL/restart/same-thread replay accepted; native interaction, steering and private Host interruption matrix remain under validation |

The managed console is the specification's explicit fallback. It is **not** the ordinary `codex --remote` TUI, and does not claim that the original CLI window acceptance passed. It owns a private stdio App Server, so all user and automatic submissions share one admission gate. No Codex core source is patched.

The current DSH was used for explicitly authorized, read-only synthetic fixture tasks. One real idle Luna thread received B in one wake turn and A/C in a second batched turn. All three native `get_run` results were verified, with zero `wait_run` calls in that consumer thread. A corrected live recorder then passed the three-result integration test. These runs were controller-created; this evidence alone does not establish model-originated delegation or the complete P2/P3 acceptance matrix. The later model-originated test was rejected by automatic approval before DSH execution because its registered source workspace is the broad home directory and scope is instruction-only. It was not retried through another transport/provider. The user subsequently authorized registering a fixture-only workspace. That registration succeeded through the official Workspace Controller, with rollback metadata. In the later registered-workspace test, all three real DSH runs succeeded, their watches were acknowledged, and their results were verified in the same thread; one watch briefly failed during normal collector polling and caused a legitimate wait_run fallback. The worker no longer clears a healthy readiness lease while collecting. That earlier scenario remains a recorded failure. A later fully automatic A/B/C scenario passed independent native-history acceptance with B first, three result verifications and zero wait_run. The controller observer had an unrelated false negative about key prefixes; its recorded outcome is kept separate from the passing audit. See `EVENT_WAKE_VALIDATION.md` for exact scope and evidence.

The real App Server tests also proved that a locally admitted turn can temporarily appear `interrupted` before its actual completion notification. Such snapshots remain pending; completed notifications must agree with durable history before acknowledgement. A real same-thread restart then replied exactly RESUMED with no tool calls.

The real App Server tests uncovered a delayed-status race: even immediately after successful `turn/start`, `thread/read` can still report idle. The adapter reserves admission before sending and retains that reservation until turn-specific completion/history evidence arrives. Exceptions preserve uncertainty. A plain idle check never acknowledges a turn.

## Prepare an independent test instance

Requirements: Linux, installed Codex/DSH, Node >=22.19, bubblewrap and a compatible embedded Relay bundle. No global install or shared-state migration is performed by these helpers.

```sh
npm run build
node scripts/wake-prepare-test.mjs /home/zer0in/deepseek-harness-relay-mcp/.runtime/wake-test
```

The helper creates separate `codex-state`, `workspace` and `control` directories, a disabled `console-config.json` and a reviewable `login-codex-isolated.sh`. It does **not** execute login or read/copy existing authentication. The user can review and run that login script to authenticate only the private Codex state. Do not paste credentials into chat.

A separate DSH Host can be started using explicit code/module locations:

```sh
node scripts/wake-isolated-dsh.mjs /absolute/private-test-root /absolute/compatible/dsh-relay-harness.mjs /absolute/readonly/node_modules
```

This reuses only read-only installed code. It hides the existing `.codex`, `.dsh` and legacy `dsh-relay` registry, uses a private temporary filesystem, chooses a random loopback port and suppresses browser opening. Its log is private (0600). It does not import existing providers or credentials. Configure the required model provider in this **independent** Host yourself. The verification on this machine used installed DSH 0.2.0-rc.2 and the existing 0.2.17 bundle; this demonstrates native interoperability, not acceptance of every newer Host/bundle combination.

Add the independent descriptor path and its exact `authorityId` to `console-config.json` as `relayDescriptor` and `relayAuthorityId`. Both must remain inside the test root; the production port 3080 is rejected by this test configuration. The descriptor includes a token **file location**, never paste a token into configuration. Explicitly choose `network: "model-access"` for real model/MCP operation. Default `isolated` mode has no network and is only a protocol probe.

Alternatively, explicitly select `relayMode: "existing-authorized"` to connect to the user's already authorized loopback DSH without changing its service. `codexMode: "current-runtime"` can reuse current authentication/settings through read-only file mounts inside a new private process namespace. SQLite, rollout history and all test runtime state remain private. Neither account login nor copying credentials is required. These opt-ins are separate and default off; see [existing Relay configuration](EVENT_WAKE_SHARED_RELAY.md). If the registered source workspace differs from the private model workspace, declare `relayWorkspace` explicitly. Only read-only scopes whose actual canonical filesystem paths lie within the model workspace pass this mapping; missing paths and symlink escapes fail closed.

```sh
node dist/dsh-relay-wake-console.mjs /absolute/private-test-root/console-config.json --check
node dist/dsh-relay-wake-console.mjs /absolute/private-test-root/console-config.json
```

`--check` does not create a binding/turn and reports authentication plus native Relay connectivity. Missing authentication returns exit 2. In a terminal, interactive mode displays concise human output; `--json` retains the event protocol for scripts and `--human` forces human output. Internal polling records and arbitrary tool-result bodies are omitted from human output. Text is submitted only when idle; busy input is explicitly rejected rather than merged. Commands:

- `/status`, `/pause`, `/resume`, `/quit`.
- `/recover DISPATCH_ID` performs positive-history-only recovery of a held delivery, even while paused; it never starts/retries a turn.
- `/watch RUN_ID IDEMPOTENCY_KEY` registers a run through a principal-scoped native get_run read. Registration alone is not a background-delivery acknowledgement.
- `/respond REQUEST_ID JSON` answers only an outstanding native request owned by this private connection. There is no automatic approval, session-wide approval or remembered-grant convenience.

The configured MCP proxy lets Codex use original Relay tools and the opt-in watch tools. When it returns a structured durable-watch acknowledgement, Codex may end its current turn with a factual delegation status. The worker continues without model polling. On wake, Codex must retrieve get_run and verify the complete result within the original task authorization.

Bootstrap `enabled` applies only when creating the first state file. Persistent pause wins on restart. Threads are never silently retargeted. A process restart resumes the existing binding/thread or fails closed if identity/history cannot be established.

Startup resume explicitly reapplies the configured Relay MCP server, `read-only` sandbox and `on-request` approval policy. It does not rely on thread-level MCP overrides surviving an App Server restart. Workspace/state aliases are rejected so the configured, persisted and actual identities agree.

## Native tools and trusted controls

The wake-specific proxy adds:

| Tool | Input | Effect |
| --- | --- | --- |
| watch_run | runId, idempotencyKey, optional terminal/needs_attention filters | Verifies run principal/workspace and configured binding; acknowledges only a fresh, ready worker that owns that binding |
| unwatch_run | subscriptionId | Stops observation/admission; does not cancel DSH or delete events |
| list_watches | none | Returns only this binding's subscriptions |
| replay_run_events | optional durable cursor | Returns bounded event facts and next cursor; retention gaps include explicit resynchronization metadata |

There are no model-controlled thread IDs, server URLs, provider overrides or permission grants in these tools. Registering a binding, enabling a queue, renewing expiry and compacting data are trusted local controls only.

```sh
node dist/dsh-relay-wake-control.mjs status /absolute/test-state/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/test-state/wake.json
node dist/dsh-relay-wake-control.mjs resume /absolute/test-state/wake.json
node dist/dsh-relay-wake-control.mjs pause /absolute/test-state/wake.json BINDING_ID
node dist/dsh-relay-wake-control.mjs renew /absolute/test-state/wake.json BINDING_ID NEW_EXPIRY_EPOCH_MS
node dist/dsh-relay-wake-control.mjs compact /absolute/test-state/wake.json BEFORE_EPOCH_MS
```

Status does not create a state file. Renewal cannot change thread/workspace/principal/server or clear a pause. Compaction deletes only an old, fully acknowledged event prefix and obsolete acknowledged delivery rows. It retains per-run tombstones/watermarks, never removes queued/uncertain/dead-letter records, advances the cursor base and reports expired cursors. Watches/bindings remain bounded; archival of an entire exhausted instance is an explicit operator operation, outside automatic recovery guarantees.

## Persistence and state machine

`WakeStore` reuses atomic fsync/rename, strict UTF-8, 0600 permissions and owner-verified locks. Stale recovery only reclaims a record whose exact owner is provably dead. Live, malformed or unknown ownership is never stolen. State, worker, dispatch and owned-Codex locks are separate. Corrupt state is not overwritten.

Events carry eventId, runId, sessionId, bindingId, monotonically increasing per-run eventSeq, Relay sourceSeq, status/kind, time, resultRef and fixed `source=relay-durable-snapshot`/`trust=data-only`. No task body, assistant output, credential or raw remote error is persisted in wake facts. `(runId,eventSeq)` identities and terminal tombstones survive ordinary restart and acknowledged retention.

| Delivery state | Meaning | Next action |
| --- | --- | --- |
| queued | Definitively not admitted | Bounded backoff and retry if still authorized |
| dispatching | Dispatch ID committed before the external call | Reconcile durable history before another action |
| delivered | Specific server turn ID accepted | Wait for that turn's completion evidence |
| acknowledged | Codex target turn completed | Never resend; does not mean DSH succeeded |
| held | Admission/completion/binding uncertain | Preserve data for investigation, never blindly retry |
| dead | Definitive failure or exhausted retry budget | Preserve for inspection, no automatic resend |

The owned adapter scans actual user-item history for the dispatch marker. Missing or incomplete evidence is unknown, not proof of non-admission. Multiple matches also hold. Its private stdio connection is the single writer; ordinary remote TUI clients cannot bypass it. Human approval requests remain outstanding on that original connection and are invalidated on process loss; no approval tickets are persisted as grants.

Default bounds: 100 bindings, 1,000 watches, 10,000 events, 5,000 deliveries, 20 events/batch, 500 ms debounce, 250 ms minimum dispatch interval, four in-flight turns, four admissions/tick and five definitive rejection attempts. Attention can bypass debounce but cannot bypass approval/active-turn gates. Stop controls serialize against dispatch admission. Cross-thread admissions are conservative and serialized; accepted turns can remain independently in flight.

## Compatibility, testing and rollback

Original start_run/start_review/get_run/wait_run/reply_run/steer_run/cancel_run behavior, native permissions and provider routing remain in place. No new service is started by ordinary Relay entry points. The source Skill has a narrowly scoped event-driven exception; the installed Skill was not edited. Bundle/Host upgrades remain a separate user-approved step.

Run the normal suite and build plus the explicit integration checks described in `EVENT_WAKE_VALIDATION.md`. The original MCP smoke script defaults to the live Host: during this rollout always supply independent fixtures or an explicit unreachable test URL and temporary state file.

Rollback: stop only the independent console/worker, preserve its queue, and continue using the original tools. Stopping the worker never cancels DSH jobs. There is no migration of production V3 state or need to restart the shared Host. Experimental wake state is private to this iteration; older experimental clients must not write its newer fields.

The private App Server probe and simulated-model fixtures are not real DSH E2E. The live three-result test establishes zero model polling for that measured consumer only. It does not establish an effectively-once production guarantee or a representative P95 latency.

Protocol references: [Codex App Server](https://developers.openai.com/codex/app-server/) and [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).
