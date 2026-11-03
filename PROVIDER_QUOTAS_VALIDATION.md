# Provider quota integration validation

This change is staged locally. It has not replaced the shared DSH profile or the
installed Codex Relay plugin. Synthetic tests are not real-account validation.

## Scope

- Maintained MIT OpenCode dock fork: `../dsh-opencode-go-usage-dock`, version
  `0.1.4-relay.1`.
- Personal Ark Agent Plan dock: `../dsh-ark-agent-plan-usage-dock`, version
  `0.1.0`, with five-hour, daily, weekly and monthly windows.
- Relay: additive `list_capabilities.providerQuotas` and read-only
  `list_provider_quotas`. No automatic provider change, prompt submission,
  cancellation or task retry occurs during a quota read.

Quota reads use the native Host services through the existing admitted Relay
connection. Fixed upstream endpoints, deadlines, body limits and redirect
refusal are implemented by the companion plugins. Missing, invalid, stale or
unconfigured results cannot become a full balance. Account and model coverage
remain explicitly unverified; paid overage is not inferred.

## Recorded checks

| Check | Result |
| --- | --- |
| Relay unit/regression suite | 340 pass, 2 skip (342 total) |
| Relay TypeScript and build | Pass |
| Ark plugin tests and syntax checks | 30 pass |
| OpenCode plugin tests and syntax checks | 16 pass |
| Chromium test of both actual client bundles with synthetic Remotes | Pass, including provider/session switches and late-response suppression; schema transport is a fixture |
| Official DSH CLI local-package installation, private rc5 profile | Pass, package scripts disabled |
| Native rc5 Host → quota HTTP adapter → Typert → MCP | Pass, 1 integration test |
| Actual DSH Web UI provider-switch acceptance | Not accepted: private session and both client modules load, but the native preview notice still blocks the page |
| Official installed rc2 CLI private quota-package installation | Pass, package scripts disabled |
| Native rc2 quota Web UI acceptance | Not run to completion; separate profile without incompatible new Relay is prepared |
| Official private-profile plugin removal / rollback | Pass; both quota dependencies/bundles removed, unrelated bundles preserved |
| Real-account quota API | Not run; requires user-managed credentials |

The native MCP test invokes `list_capabilities` before any model task, validates
Ark exhaustion and OpenCode availability, then simulates Ark HTTP failure and
an incomplete OpenCode response after cache expiry. Both become unknown. It
also verifies the registered private Workspace and blank idle Session, synthetic
credential routing, and zero model requests. It never invokes `start_run`.

Private evidence is retained below `.runtime/dsh-candidate/`; logs can contain
test browser launch tokens and should not be pasted into chat. The permanent
test is `tests/provider-quotas-native.integration.mts`. Test fixture HTTP
adapters are installed on the actual quota services, preserving production
request/signing/parsing/cache code and native transport. No shared credential
store is mounted. DSH may create its own private browser-auth credential store;
the test checks owner-only metadata without reading its contents.

The actual browser attempt did not establish that the quota dock or credential
form rendered in the full DSH application. The first-run preview notice remained
visible, with zero quota and zero model requests from that browser attempt.
Its Continue control writes only the private Host's
`ui-settings-general.welcomeNoticeVersion` preference. An initial read-only
subtask prohibited this write and automatic approval rejected it. After checking
the native source, the parent explicitly allowed that one private preference
write under the user's existing isolated-testing authorization. The bounded
attempt still did not produce acceptance evidence and was stopped. No direct
setting seed or alternative RPC transport was used. The user then requested
less testing; no further browser runs or version comparisons are scheduled.

## Compatibility and activation

The currently installed DSH CLI reports `0.2.0-rc.2`. The staged Relay `0.2.19`
declares a newer minimum DSH peer version, so rc2 rejects it. This compatibility
check has not been exempted or bypassed. Full Relay acceptance uses an isolated
`0.2.1-rc.5` Host. Quota-package rc2 UI compatibility is a separate check and
does not imply that the new Relay can run on rc2.

The shared Host was checked through the existing native MCP: Relay `0.2.17`
remained ready and connected, with its original owner process. A single
deployment-readiness metadata check saw no running direct sessions in readable
workspaces, but two workspace rosters could not be read. That is not a guarantee
that restarting the shared Host cannot interrupt other work.

Before activation, retain the current Host/runtime, profile package files and
Relay artifacts as a rollback set. Use the official plugin manager for the two
local quota packages. A running Host must reload or restart to load them; do
not interrupt active sessions. Update the embedded Relay and Codex proxy
together, following repository `AGENTS.md` and `prepare:codex-local` for a local
Codex-plugin installation. Verify `doctor.relayVersion` and the actual tool
catalog in a new Codex task. A displayed package version alone is insufficient.

The Ark usage API needs personal-plan AK/SK, separate from the model API key.
The native plugin settings card accepts password drafts and writes through the
existing DSH credential Remote. It never reads saved values back. The two
writes are not atomic; after partial failure, re-enter both values. Do not send
keys through chat or MCP. No real secrets have been configured by this work.

Rollback removes the two packages using the official profile plugin manager
and restores the saved runtime/profile/Relay versions, then reloads the Host
and starts a new Codex task. Credential records are managed separately by the
user; uninstalling a dock must not silently delete them.
