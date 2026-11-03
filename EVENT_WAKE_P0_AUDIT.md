# Event-driven wake: P0 source audit (2026-10-29)

## Baseline and isolation

- Checkout: `5a2c9f5f1d47cb2bbaa64337cfddafe9c2363473`, package 0.2.19; clean before this report.
- Installed Relay: 0.2.17, embedded authority behind the existing stdio proxy. DSH launcher reports 0.2.0-rc.2; this is not proof of the running Host's package version.
- Codex: 0.165.0; Node: 26.8.1.
- User requires separate test instances. Do not install this checkout into the live Host, update plugin caches, change live configuration, restart shared processes, or migrate live state without explicit permission.
- Feasibility artifacts are in `/home/zer0in/dsh-wake-p0`. That experiment is separate from production implementation; its final report determines the P0 gate.

## Verified source structure

| Concern | Existing owner | Consequence for proposed change |
| --- | --- | --- |
| Run outcomes | `src/run-events.ts`, `src/relay-broker/run-reconciler.ts` | Reconcile owned durable history before emitting a fact; preserve interrupted/max-token `incomplete`, errors, cancellation and stalled attention distinctions. |
| Start/reply/steer idempotency | `src/relay-broker/operation-journal.ts`, `src/relay-broker/relay-broker-facade.ts` | Reuse run/operation identity. Never retry a DSH submission to recover a wake delivery. |
| Stream hints | `src/event-monitoring/event-monitoring-facade.ts`, `src/harness-entry.ts` (`projectEventNotice`) | Stream hints request durable reconciliation. They are not an authoritative persistent outbox. |
| Notification projection | `src/monitoring/notification-buffer.ts`, `monitoring-facade.ts` | UUID/cursor and bounded array live in memory. Restart loses them. Do not use these cursor identities for durable delivery deduplication. |
| Durable state | `src/state-repository/state-schema.ts`, `src/state-store.ts` | V3 stores services, runs, operations and permission leases, with authority identity. It has no bindings/watches/events/deliveries. |
| Atomicity and locking | `src/state-repository/atomic-json-file.ts`, `file-lock-facade.ts` | Reuse established file permissions, sync/rename and owner-verified locking patterns. Preserve stale-writer protection. |
| Approval ownership | `src/user-interactions/user-interaction-facade.ts`, broker interaction methods | Keep initiating principal/run/session/live-agent ownership. Do not persist or replay approval tickets as grants. |
| Client transport | `src/stdio-proxy/`, `src/mcp-server/` | Persistent watcher cannot depend on the lifetime of the external stdio proxy. |

The README explicitly describes native notification transport as disabled and polling as the fallback. The presence of the stream accelerator does not establish that native completion notifications are active in the installed Host.

## Proposed gated stages (not implemented)

P1: After P0 passes, add an opt-in watcher/outbox owned by an independent long-lived test service, and a trusted binding registry. Default disabled. Project only bounded run facts and references. A separate dispatcher serializes per-thread turns; persist dispatch identity before sending and reconcile uncertain responses against supported durable Codex history. If history cannot establish whether a turn was accepted, hold for manual recovery. Bind workspace, principal and expiry explicitly; never accept an arbitrary destination from DSH text.

P2: Add independent watches for multiple runs, debounce batching, attention priority, per-thread queue/lock, global concurrency limit and pause/resume/disable controls. Attention remains pending human action, not terminal success. Preserve an existing watch when steering its run.

P3: Exercise crash windows, duplicate and reordered facts, stale locks, reconnects, authentication and disk failures against separate services/state. Add bounded retention, exponential backoff, dead letters and redacted diagnostics. Document compatibility, migration and rollback. A real three-run E2E is required before performance or effectively-once claims.

Keep wake state separate from the existing V3 production state during experimental rollout, so disabling the test service preserves the original state reader. Do not add fields to a strict V3 schema without a versioned migration and rollback design. No old APIs or skill wait policy should change before the dispatcher is verified and authorized.

## Checks performed

- `node scripts/sync-version.mjs --check`: passed.
- `npm test`: version precheck passed; test runner could not launch (`tsx: command not found`). Fresh checkout has no installed development dependencies. No unit-test pass is claimed.
- `codex app-server generate-ts --out /tmp/dsh-wake-p0-types`: passed for the installed binary. This confirms schema generation only, not runtime method implementation.
- No production code changes, installation, migration, commit or push performed.

## Gate

P0 is not accepted by this source audit alone. Consult the isolated experiment report for actual remote TUI, external same-thread turn, approval/race and restart results. Missing or failing cases must block P1 production work under the supplied specification.

Final decision: **NO-GO for P1–P3 implementation** under the supplied gate. The experiment demonstrated visible same-thread external turns, but history hydration failed in the tested configuration, turn-level notifications were not delivered to the second client, and busy requests merged into the active turn. The experiment also shared the existing Codex state home; future tests require separate authenticated state. Its default replay and PID-file cleanup entry points were disabled during review. A status-idle observation is insufficient to acknowledge a particular completed turn or eliminate a concurrent user-input race. Dispatcher-owned ledgers cannot alone resolve uncertain server acceptance.

Only this audit document was added to the checkout. Test artifacts remain outside it. Recorded experiment app-server and PTY PIDs were verified absent after completion. The live Relay was used for ordinary delegated work and was not upgraded, restarted or reconfigured; its normal run records necessarily include these delegations. Production permission and state formats remain unchanged.

## Subsequent isolated implementation

The statements above record the original P0 result, not the current file inventory. After the user requested continued modification, a dormant wake library, control CLI, isolated protocol probe and tests were added. See `EVENT_WAKE_IMPLEMENTATION.md` for precise acceptance status.

The earlier version-wide inference about missing history APIs is superseded: a real 0.165.0 App Server in a fresh private state namespace can resume and page a materialized test thread. The historical experiment's failures do not prove that this Codex version lacks those methods. A minimal-environment, network-isolated probe now reproduces this without reading shared credentials or sessions. Authenticated, fully isolated remote-TUI E2E is still outstanding. No production adapter has been enabled, and exclusive admission against concurrent user input is not proven.

The following continuation added and tested exclusive admission for the **managed-console fallback only**, a long-lived worker, optional native MCP watch tools and independent DSH/Relay connectivity. The actual ordinary remote-TUI acceptance remains outstanding. See the implementation/validation documents for the current file inventory and evidence; earlier stage statements above are historical snapshots.
