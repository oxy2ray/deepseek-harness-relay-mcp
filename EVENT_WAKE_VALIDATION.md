# Event wake validation — through 2026-11-02

> **Current validation — 2026-11-03:** actual original-main E2E is verified: three concurrent DSH reviews, native watch acknowledgements, two automatic same-thread turns (B then A/C), three consumed results and zero model waits. Dedicated-worker restart recovery and a fresh default installed-plugin task are also verified. Approval/failure tests must be distinguished from live scenarios; see [EXISTING_CODEX_WAKE.md](EXISTING_CODEX_WAKE.md) for exact limits. Results below remain historical snapshots.

Checkout baseline: `5a2c9f5f1d47cb2bbaa64337cfddafe9c2363473`, package 0.2.19. Linux, Codex 0.165.0. Current final validation ran on Node 26.13.0; Node 26.8.1 belongs to earlier historical checks below. Older results are dated snapshots, not current status, and superseded pending findings are labeled. The installed plugin remains unchanged. After explicit authorization on October 30, the Host was gracefully restarted and one synthetic-only workspace registered; existing registrations and session counts were verified unchanged. November 2 tests do not restart the shared Host.

## Results

| Check | Actual result | What it proves |
| --- | --- | --- |
| Full `npm test` | **PASS — 326 total, 324 pass, 0 fail, 2 skip** | Latest preset follow-up: `/tmp/relay-agent-presets-final-unit.log`. Skips: native Win32 ACL on Linux and the opt-in live scenario. Earlier counts below are historical. |
| TypeScript and `npm run build` | PASS | Latest build: `/tmp/relay-agent-presets-final-build.log`; includes preset verification, workspace management and terminal-control rendering hardening. |
| Version/whitelist/budget gates | PASS | Latest package: 276 files, approximately 7.02 MB (<8 MiB); Relay artifact versions remain 0.2.19. |
| Independent installed Codex, no auth, network disabled | PASS | User/automatic admission serialization; actual history-based recovery or conservative unknown; restart of the same thread. Successful inference is not claimed. |
| Installed Codex with a deterministic local model fixture | PASS | Actual engine stores dispatch identity and completion; restart recovers that identity. **The model is simulated**, so this is not authenticated E2E. |
| Actual independent DSH/Relay Host | PASS | Read-only installed code, isolated `.dsh`, `.codex` shadow, private legacy authority registry/temp files, random loopback port; native MCP connection works. No existing credentials copied. |
| Actual private Codex → actual independent native Relay proxy | PASS | The actual thread discovers **31 tools**, including watch_run and original Relay tools. No model task or DSH run was submitted by this check. |
| Offline original MCP smoke | PASS | Original 27 tools with explicit unreachable test URL and temporary state. No production Host connection. |
| Built library/control smoke | PASS | Public library import; status does not create state; pause changes only an explicit temporary queue. |
| Default private prepared-instance preflight | Exit 2 | No private login was configured; this does not require a second account. |
| Explicit current-runtime / existing-authorized preflight | **PASS (exit 0)** | Authentication and native Relay connection verified with private runtime state and read-only current auth/settings mounts. |
| `git diff --check` | PASS | No whitespace errors. |
| Genuine DSH A/B/C → real Luna same-thread continuation | **PASS, controller-created runs** | B caused one wake turn; A/C caused a batched second turn. Actual history proves three native get_run calls, zero wait_run, verified replies and acknowledgements. |
| Corrected live recorder, fresh private consumer | **PASS** | A new real Luna thread consumed and verified all three real DSH terminal results; all events acknowledged. |
| Real App Server restart with explicit MCP reattachment | **PASS, offline stdio fixture** | Actual process close/relaunch, same-thread resume, tool discovery and read-only/on-request parameters verified. |
| Model-originated three-run delegation (Oct 30 registered-workspace attempt) | **HISTORICAL PARTIAL; superseded by accepted Nov 2 zero-poll run below** | That earlier attempt had one wait_run fallback during a readiness flicker and remains a failed attempt. It is not evidence for the later accepted scenario. |
| Authenticated existing-thread restart | **PASS (October 30 witness)** | Same thread/binding/tools restored; auth true; exact RESUMED reply, zero tool calls. Immediate interrupted history was a transient race, confirmed against exact completion notification and later durable success. SIGKILL recovery is separately accepted in the November 2 evidence below. |
| Ordinary remote-TUI automatic-wake acceptance | **NOT ACCEPTED** | The implemented safe admission path is the explicitly labeled managed-console fallback. |
| Production P95 and effectively-once guarantee | **NOT ESTABLISHED** | Recorded task-start deltas were 651/701/638 ms (3 events, 2 wake turns; empirical nearest-rank P95 701 ms). These are record timestamps, not exact engine admission or representative production P95. Zero wait_run is proved only for the measured consumer threads. |

## Failures found and corrected

- Original P0 overgeneralized a history failure to all 0.165.0 instances. A fresh real private-state probe supports resume and pagination; the earlier conclusion is superseded.
- Real App Server status can lag admission. A single client could still merge two turn/start inputs despite a local mutex. The adapter now reserves before sending and only releases with turn-specific evidence. The real-process regression covers this.
- An unauthenticated turn can fail before or after writing its user item. Recovery is accepted only when the actual item proves the dispatch ID; admission or idle alone never proves it.
- Existing tests hardcoded Windows paths for a native-platform resolver. Fixtures now use native temporary paths; the resolver behavior did not change.
- The module-boundary gate caught imports of wake internals from stdio-proxy. Integration now consumes the public wake root index, without weakening the gate.
- Crash testing found the need for explicit proven-dead lock recovery. A real SIGKILL test covers state, worker and dispatch locks; live/unknown ownership is not stolen.
- Persistent stop state now wins over bootstrap enabled configuration on restart. Watch acknowledgement rechecks fresh worker ownership/readiness inside its commit.
- Retention only compacts acknowledged prefixes; it keeps terminal tombstones and emits cursor-gap metadata. Held recovery is a trusted positive-history-only action and never resubmits a turn.

## Reproduction and evidence

Normal checks:

```sh
npm test
npm run build
node scripts/verify-built-relay-version.mjs
node scripts/validate-package-files.mjs
```

Explicit real Codex protocol checks (require bubblewrap/local sockets):

```sh
node --import tsx --test --test-isolation=none tests/wake-owned-codex.integration.mts tests/wake-codex-fixture.integration.mts
```

With the independent test Host running and the project built:

```sh
RELAY_WAKE_TEST_ROOT=/absolute/private-test-root RELAY_WAKE_TEST_DESCRIPTOR=/absolute/private-test-root/relay-state/relay-endpoint.json node --import tsx --test --test-isolation=none tests/wake-isolated-host.integration.mts tests/wake-console-wiring.integration.mts
```

The native Host checks in this session used DSH 0.2.0-rc.2 and the already installed 0.2.17 bundle as a compatibility fixture. They do not prove every newer embedded bundle or native approval combination. Its recorded owner PID was verified dead after the timed test; the production Host was never targeted.

Temporary evidence: `/tmp/relay-wake-full-tests.log`, `/tmp/relay-wake-real-protocol-tests.log`, `/tmp/relay-wake-isolated-host-test.log`, `/tmp/relay-wake-console-wiring.log`, `/tmp/relay-wake-build.log`, `/tmp/relay-wake-preflight.json`. Per-process evidence JSON locations are printed by the explicit integration tests. Private Host logs may contain its own generated UI access URL and are deliberately not printed or packaged.

## Authorized existing-service live evidence

The earlier requirement for another independently authenticated account/provider was too strict. The user explicitly authorized using the current DSH and Luna implementation agents. The test reused existing authentication through read-only namespace mounts while keeping all SQLite, rollout and test runtime state private. No login was executed, credentials copied or shared service reconfigured/restarted. On October 30 the native doctor still reports the same authority and owner PID 295484.

The first Ark economy run failed with an account-wide quota error; no result was claimed. The live-discovered `opencode-go / deepseek-v4.1-flash` route then completed three scoped read-only synthetic JSON tasks. Relay task messages contained paths and scope, not source bodies or credentials.

Evidence under `.runtime/current-service-e2e` (excluded from packaging):

- `control/consumer-history-evidence.json`: independent sanitized audit of actual rollout, three completed native MCP reads, exact result markers, unique dispatches/turns and two acknowledged deliveries. The original recorder failed because it missed the installed protocol field; this audit does not rewrite that test result.
- `control-v2/consumer-evidence.json`: corrected live test **success**, actual Luna thread `01a187bb-3851-7a30-bba5-08995cacad33`, three result verifications, zero wait_run, all events acknowledged.
- Separate queues `control/wake.json` and `control-v2/wake.json`; run IDs B `95552827-6dee-467c-8947-ad207c5448e7`, A `bc5082d9-60b4-4c96-94dd-96c00f2622e5`, C `a28a7345-5acd-4d73-a26a-895f293cc438`.

The first recorder called history too early, then missed the installed `mcpToolCall.tool` field. It now waits for the exact completion notification and recognizes completed MCP/message items. The corrected test passed in a fresh private consumer. Mapped scopes also now reject physical symlink escapes at registration and observation; cancelled watches cannot replay stale acknowledgement. Startup resume reapplies the configured MCP server and read-only/on-request constraints.

**Historical October 30 status, superseded for the fixture-only zero-poll case by the November 2 accepted run below.** At that point, model-originated delegation was blocked by automatic approval review: the current DSH registered the broad `/home/zer0in` workspace, and the declared per-path scope was instruction-only. Three synthetic fixture review requests were rejected before native execution; no run ID or watch acknowledgement was returned. That rejected attempt remains preserved and is not rewritten. Authenticated restart, steering, actual native interaction approval, controlled service interruption and ordinary remote-TUI acceptance remain separate. No production installation or release was performed.

Harness source delegation was previously rejected by automatic approval for source-egress authorization. Implementation/review used Luna agents and local work; no substitute RPC transport or source upload was used to bypass that rejection.

## October 30 independent rechecks

- **Historical October 30 snapshot:** `npm test`: 273 tests, 271 pass, 0 fail, 2 skips, verified again by the integrating agent (`/tmp/relay-wake-oct30-final-unit-tests.log`). Final November 2 counts appear in the Results table above.
- Actual Codex protocol integrations: 3 pass, 0 fail (`/tmp/relay-wake-oct30-final-protocol-tests.log`), covering admission, history/restart and explicit MCP reattachment. One uses a deterministic local simulated model, not real DSH inference.
- Build and artifact version gates pass; 269 whitelisted files, approximately 6.86 MB / 8 MiB budget. Offline original MCP smoke passes with an unreachable explicit test URL and private temporary state.
- **Historical October 30 attempt:** `.runtime/current-service-delegation-oct30/control/delegation-evidence.json` records the terminal failed attempt; `approval-rejections.json` records sanitized approval rejection facts from its actual rollout. Automatic review rejected all three start_review requests because the underlying registered workspace was broad and scope was not filesystem-enforced. That attempt did not pass; the separate fixture-only November 2 zero-poll scenario is recorded below.
- Authenticated restart evidence: `control-v2/resume-evidence-attempt1.json` and `resume-evidence.json` record matching binding/server/workspace/model, 31 discovered tools and failed account probes. Failure is an observed RPC result, not proof of invalid credentials or a requirement for another account. No model turn or DSH operation was submitted in this check.

The live-delegation test now stops and cleans up immediately when the exact automatic-approval rejection marker is returned; it stores only a rejection count and validated call IDs. Its additional synthetic classifier regression passes (1 pass; the live scenario is skipped without its explicit opt-in environment variable). The failed historical attempt remains recorded as an actual deadline failure, with sanitized approval facts alongside it.

The restart failure was classified from the owned App Server response as `workspace-routing` (code -32603), without emitting or storing its raw error. Existing sanctioned credential-free HTTP(S)/ALL proxy environment is now inherited only in model-access mode, with forced loopback exclusions; proxy URLs containing user info, query/fragment or non-root paths are rejected without echoing them, and no other credentials/environment are forwarded. Isolated mode remains unchanged. After this correction, the bounded account probe still reported workspace-routing failure, so the test preserved its state and did not submit an inference turn. Global account/configuration was not modified.

## November 2 continuation

- **Earlier November 2 snapshot, superseded by final results in the Results table:** pre-change full suite: 279 tests, 277 pass, 0 fail, 2 skips (`/tmp/relay-wake-nov02-unit.log`). Actual private Codex protocol tests: 3 pass (`/tmp/relay-wake-nov02-protocol.log`).
- Shared Host read-only doctor reports version 0.2.17, PID 2071, connected. It was not restarted in this continuation.
- The October 30 successful RESUMED witness is recorded at `.runtime/current-service-e2e/control-v2/resume-evidence.json`; it supersedes earlier account-read and premature-turn-failure conclusions for that witness.
- The registered-workspace delegation attempt is preserved at `.runtime/current-service-delegation-oct30/control-registered/delegation-evidence.json`. Three succeeded runs, three watch acknowledgements and three verified result replies; one wait_run means this attempt is not a zero-poll pass. Normal collector readiness flicker was identified and fixed with a blocked-collector regression.
- **Historical failed SIGKILL attempt, superseded by the accepted standard-home replay below:** it preserved the original thread, one event and zero deliveries, but exposed leftover empty auth/config mountpoints after the process died. The failed run remains preserved as failed; subsequent mount ownership recovery and fresh replay are separate evidence.
- Independent candidate startup failures were traced to an incorrect library bundle that lacked DSH plugin exports; only `dist/dsh-relay-harness.mjs` is a valid native Host plugin. Candidate startup/catalog success does not itself establish model authentication or real wake acceptance.

## November 2 crash recovery and usable console

The standard-home real replay now passes: `.runtime/current-service-e2e/control-live-reliability-1793589928503-39a7a319-a379-4516-98ba-bf2f7a8206b5/evidence.json`. It used a fresh private credential-free model configuration and a read-only current-runtime auth mount. The same Codex thread survives a private process-group SIGKILL; a paused event stays queued, then resumes with one acknowledged delivery/one admission attempt, one native get_run and zero wait_run. This test reused an existing real DSH run and did not create or mutate a DSH task. Earlier exploratory HOME-overridden attempts are not the accepted reproduction.

The private mountpoint manifest records exact owner and inode identities before launching; a new exclusive owner recovers only proven-owned empty placeholders. Existing, replaced, symlinked, nonempty or unmanifested private files are preserved or rejected; global credentials are never copied or modified. Unit coverage simulates a dead owner and checks normal cleanup and ambiguous/malformed records.

`disabledMcpServers` now allows explicit per-thread startup exclusions without changing global settings. Human terminal output and the JSON protocol are separate renderings of the same owned console; arbitrary tool payloads and repetitive polling diagnostics are omitted from human output, while explicit approvals remain manual. The original installed plugin catalog remains unchanged.

## Accepted zero-poll workflow (November 2)

The final A/B/C scenario is independently accepted from its actual private rollout and durable queue: `.runtime/current-service-delegation-oct30/control-zeropoll-final-1793590197815-8b1669aa-5800-48f4-9d5d-c9f6761f3360/history-acceptance-v2.json`. It records 3 native start_review calls, 3 real structured watch acknowledgements, 3 successful native get_run results and final marker replies, zero wait_run, and no reply/steer/cancel/start_run calls. The delegation turn ended while runs remained active; B became terminal first while A/C were nonterminal. All 3 events were acknowledged in the original Codex thread, with one delivery attempt each. The consumer model was the live-advertised `gpt-5.6-luna`; the DSH route was `ark/deepseek-v4.1-flash-economy`.

The original controller observer recorded zero watch acknowledgements because it demanded a `watch-e2e` prefix while the model supplied distinct, schema-valid per-run `wake-e2e` keys. The native API does not require a particular prefix; actual native tool responses and outbox rows prove the acknowledgements. The controller's original outcome remains unchanged and is not recast as a pass. The opt-in `tests/wake-live-history.integration.mts` independently audits the actual artifacts and passes.

The stronger v2 audit evidence is `.runtime/current-service-delegation-oct30/control-zeropoll-final-1793590197815-8b1669aa-5800-48f4-9d5d-c9f6761f3360/history-acceptance-v2.json`; it leaves the earlier `history-acceptance.json` untouched. It reads the selected console config, delegation ready/started/run/progress metadata, wake store, only the three synthetic marker fixtures for this binding, and the Codex rollout whose `session_meta.id` matches the thread. It makes no Relay calls and starts no worker. It verifies three native `start_review`, `watch_run` and `get_run` calls; zero `wait_run` or task-changing calls; start/watch calls in the delegation turn; and each get_run in the matching acknowledged delivery turn. For every dispatch ID it counts exactly one occurrence across all user-message items, checks unique wake turn IDs, and proves by JSONL row order that delegation `task_complete` precedes every dispatch-bearing wake input and that each wake `task_complete` follows its matching get_run. Parsed record timestamps are checked in the same order. Every native get_run is succeeded and its marker appears in that turn's final message. The evidence stores counts, labels and ordering facts only, not markers or assistant text. The controller's prefix-sensitive watch counter still reports zero; the independent native-call and durable-store assertions are the acceptance basis.

Reproduce the read-only audit against those existing artifacts with:

```sh
WAKE_HISTORY_CONFIG=/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control-zeropoll-final-1793590197815-8b1669aa-5800-48f4-9d5d-c9f6761f3360/console-config-live.json \
WAKE_HISTORY_CONTROL=/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control-zeropoll-final-1793590197815-8b1669aa-5800-48f4-9d5d-c9f6761f3360 \
node --import tsx tests/wake-live-history.integration.mts
```

The earlier partial C-only manual recovery belongs to a different failed scenario and is not used as evidence for this accepted fully automatic scenario.

Final checks after the approval-view and terminal-control refinements: `npm test` 291 total, 289 pass, 0 fail, 2 skips (`/tmp/relay-wake-nov02-final-unit-v3.log`); 3 real private Codex protocol integrations pass (`/tmp/relay-wake-nov02-final-protocol-v2.log`); final build passes (`/tmp/relay-wake-nov02-final-build-v3.log`). Version and whitelist gates pass: 272 package files, approximately 6.95 MB, below 8 MiB. Original offline MCP smoke retains 27 tools, including wait_run and excluding watch_run by default. The prepared private user-console preflight passes authentication and native Relay connectivity without starting a model turn.

Human output now escapes terminal and bidi control characters in assistant messages and approval summaries. A regression covers split escape sequences, raw-text completion deduplication, normal Unicode/newlines, and unchanged JSON protocol output; independent re-review found the original terminal-injection issue resolved.

Native DSH interaction E2E remains unaccepted: the running 0.2.17 service does not advertise `list_run_interactions` or `respond_to_run_interaction`. The independent newer candidate has no safe model authentication configured. Raw shared-credential mounts and provider overlays are disabled before launch; two guard tests pass. No shared service upgrade/restart or candidate model task was performed during this final check.

A secret-free anonymous-channel probe also rejected the proposed credential broker transport: bubblewrap 0.13.1's `--sync-fd 3` retained fd 3 in bubblewrap but the payload received EBADF; reopening that socket through `/proc` returned ENXIO. A synthetic stdin sentinel reached the payload, but did not establish a safe bidirectional broker. No DSH process or model job was launched for this probe. A different verified transport or an independently configured provider is required before native candidate interaction testing.

## Workspace-management follow-up (November 2)

Added native `register_workspace`, `archive_session` and `unarchive_session` tools. These are separate from the opt-in wake tools. The rebuilt default catalog now has 30 tools: all 27 previous source tools plus these three; watch tools remain opt-in. The currently installed plugin and running shared Host were not updated. New registration requires an existing canonical directory inside trusted configured workspace roots; registry-only mode allows idempotent lookup of existing registrations, not new ones. Both archive operations verify exact workspace membership and direct-session identity. Archive holds the same admission guard and cross-process session lease used for session reuse, rejects running/unreconciled/pending-interaction or permission-restoration states, and uses native `stopActivity: false`. No cancellation, prompt, permission escalation or direct-state fallback is used. Native archival drops a pin; unarchive restores visibility and membership position, but not the pin.

The integrating agent ran the real private DSH 0.2.1-rc.5 Host with the rebuilt 0.2.19 embedded bundle on an OS-assigned loopback port. It used the explicit `workspace-management` launcher mode, a private DSH/Codex/legacy registry, and no provider configuration or shared credential mounts. Two blank idle sessions were created through official controllers. Native MCP verified a new workspace registration, repeat registration with the same ID, wrong-workspace rejection for both archive directions, archive/unarchive round trip, unchanged unrelated session state and unchanged pre-existing workspace rows. This is a real Host/MCP integration with no model inference; it does not claim live model/job race coverage. Unit tests separately cover native activity rejection after an idle precheck, pending interactions, persisted needs_attention, submission concurrency and strict input rejection.

Independent review found no blocking Relay implementation issue. Native DSH documentation explicitly states that its activity check and archive write are not atomic against other clients: a racing turn can execute a model step before its next step is blocked. The Relay guard serializes Relay-owned admission only; no Host-wide atomic guarantee is claimed. Both READMEs document this limitation and the native pin-removal behavior.

Evidence: `.runtime/dsh-candidate/workspace-management-20261102-v1/workspace-management-native.log` (also `/tmp/relay-workspace-management-native.log`); fixture IDs at that private instance's `dsh-state/workspace-management-fixture-evidence.json`. The recorded launcher owner PID 910751 was verified against its command before stopping; its process exited and owner record was removed. The shared Host was not targeted.

Reproduction uses a fresh dedicated root under `.runtime/dsh-candidate`, the built native `dist/dsh-relay-harness.mjs`, and explicit candidate module/entrypoint paths:

```sh
node scripts/wake-isolated-dsh.mjs /absolute/private-candidate-root /absolute/dist/dsh-relay-harness.mjs /absolute/candidate/node_modules /absolute/candidate/node_modules/@deepseek-ai/dsh/lib/bin.js '' workspace-management
```

Run `tests/workspace-management-native.integration.mts` with explicit `WORKSPACE_MANAGEMENT_TEST_ROOT`, `WORKSPACE_MANAGEMENT_DESCRIPTOR`, `WORKSPACE_MANAGEMENT_ALLOWED_ROOT` (the root's `workspace` directory), and `WORKSPACE_MANAGEMENT_EVIDENCE` (the root's `dsh-state/workspace-management-fixture-evidence.json`). The test refuses port 3080, external descriptors/tokens and a root outside the private candidate directory. Stop only the owner-verified private launcher afterward.

## Live agent-preset follow-up (November 2)

Existing `start_run` and `start_review` already accepted `agentPreset` for new sessions. Added the read-only `list_agent_presets` tool and a bounded native metadata projection, also used by `list_capabilities.presets`. Every call queries the native Host. Published IDs, names, descriptions, ordering, default and broken flags are retained; unknown additive fields are omitted, malformed known fields/duplicate IDs are rejected, and absent names/descriptions are listed explicitly in `missingDisplayMetadata`. No preset ID/name/description table or cache is introduced. Exact IDs are validated without trimming or otherwise rewriting them.

Fresh-session selection now requires the created preset to match an explicit request. If create omits the field, Relay verifies the exact new main session and workspace against its native session projection before task admission. Mismatch/unverifiable selection stops before model/permission/prompt dispatch. The run snapshot reports the confirmed preset. Omitting a preset preserves the Host default; explicit reuse does not reconfigure an existing session. Unit tests verify these behaviors and both discovery paths, including metadata rename/default/removal changes, invalid data, and exact IDs with significant whitespace. Independent review found its two initial issues (ID trimming and an unprojected capabilities path) resolved.

Accepted native test: `.runtime/dsh-candidate/agent-presets-20261102-v4/agent-presets-native.log`, also `/tmp/relay-agent-presets-native-v4.log`. A real private DSH 0.2.1-rc.5 with the final rebuilt 0.2.19 Relay bundle registered an empty synthetic preset through the public registry, created one blank session with that exact preset, and exposed its live catalog through native MCP. Replacing the declaration with the same ID and changed name/description was visible on the next call; default flags and missing metadata matched the original native roster. No model work, shared authentication, or Host-default change was involved. Its owner PID 966118 was verified before stopping; all private preset test launchers were stopped, and the shared service/plugin remained unchanged.

Historical fixture attempts remain separate: v1 lacked readiness/error staging and its test failed before evidence existed; v2 proved loader readiness but was stopped before final-artifact acceptance; v3 failed because the fixture expected a top-level preset in native `sessionController.list` instead of `projections.values.agentPreset`. The production Typert adapter already handled that projection. The fixture was corrected without weakening the assertion; only v4 is the accepted end-to-end witness.

Display limitation: current native catalogs omit localized builtin names/descriptions. Those strings are generated by each browser Client's locale dictionary, which is not exposed by a public Host-side API. Published custom metadata is synchronized exactly; missing builtin display fields are reported rather than scraped or invented. Full parity with browser-localized builtin text still needs an upstream public display-metadata API. This is documented in both READMEs and is not claimed as implemented.

For a fresh private root, use the isolated launcher as above with final mode `agent-presets`. Run `tests/agent-presets-native.integration.mts` with explicit `AGENT_PRESETS_TEST_ROOT`, `AGENT_PRESETS_DESCRIPTOR`, `AGENT_PRESETS_WORKSPACE`, `AGENT_PRESETS_EVIDENCE` (`dsh-state/agent-presets-evidence.json`) and `AGENT_PRESETS_CONTROL` (`dsh-state/agent-presets-control.json`). The permanent test rejects shared endpoints, waits for regular private evidence, and only writes the fixed synthetic phase-2 request. Default offline MCP smoke now exposes 31 source tools including preset discovery and management, retains legacy tools, and excludes opt-in watches.
