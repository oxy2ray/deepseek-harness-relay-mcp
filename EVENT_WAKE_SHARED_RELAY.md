# Explicit use of an existing loopback Relay

> **Workflow note — 2026-11-03:** The instructions below describe sharing Relay with the managed-console workflow. A separate opt-in now supports selected existing Codex daemon threads; it uses the current local Relay descriptor but has a distinct config and worker lifecycle. See [EXISTING_CODEX_WAKE.md](EXISTING_CODEX_WAKE.md). The existing-thread config is not enabled by default, and evidence on dedicated threads does not yet validate the original user root/main thread.

The wake console defaults to `relayMode: "isolated"`. In that mode, a configured Relay descriptor and its token file must both resolve inside `testRoot`, and port 3080 is rejected.

To deliberately use an existing authorized Relay, set `relayMode` to `"existing-authorized"` and provide both `relayDescriptor` and its exact `relayAuthorityId`. The descriptor is still parsed by the native Relay descriptor reader, which requires loopback HTTP URLs and a token file path. This mode permits the descriptor and token file paths to resolve outside `testRoot`, including the existing loopback Relay on port 3080. It never reads token contents in console configuration validation; the native proxy reads authentication when it connects.

This opt-in does not relax isolation for `codexState`, `workspace`, or `wakeState`: those remain confined to the dedicated test root, and descriptor/token paths must remain outside the model workspace. A missing or mismatched authority identity, non-loopback descriptor URL, or state path outside the test root is rejected.

Example fields (replace the paths and identity with values obtained from the authorized local setup):

```json
{
  "relayMode": "existing-authorized",
  "relayDescriptor": "/path/to/authorized/endpoint.json",
  "relayAuthorityId": "exact-authority-id"
}
```

This setting only changes validation for an explicitly configured console. It does not modify, restart, or reconfigure the shared Relay service.

## Codex authentication source

`codexMode` defaults to `"private-state"`, preserving the isolated private Codex state mount. Set it to `"current-runtime"` only when the local Codex runtime is already authenticated. The console still launches a new private stdio App Server and uses the configured dedicated workspace and private owner lock; it never attaches to the existing daemon or resumes an existing user's thread. This mode keeps the private `.codex` state directory writable for its own SQLite, rollout and runtime files. It checks whether the current runtime has `config.toml` and `auth.json` using path metadata only, then overlays each existing regular file read-only at its corresponding location inside the private state, only when the private state has no same-named entry. Existing private files are preserved. Missing targets are created as empty mountpoints before launch so bwrap can mount over them; after child exit, cleanup removes only mountpoints created by this launch whose device/inode still match and which remain regular empty files. Cleanup is idempotent and runs on child close as well as explicit close. Before launching the child, an atomic private manifest records the owner lease token and each created mountpoint’s device/inode. After SIGKILL, the next exclusive owner can recover only these exact empty mountpoints; replaced files and unmanifested private files are preserved. Malformed or ambiguous ownership fails closed. These read-only mounts exist only in the child process namespace. The implementation does not read or copy file contents or edit global configuration. Process-level `-c` overrides remain command arguments, and the thread stays `read-only` with `on-request` approvals.

Both modes require a dedicated test root, Codex state directory, workspace and wake queue. `codexMode` is strict: unknown values are rejected.

## Relay source workspace mapping

The console accepts optional `relayWorkspace`, defaulting to `workspace`. An explicitly configured value must be an existing canonical absolute directory; it may identify the workspace root recorded by a run in the authorized Relay. The console stores this source root on the binding when creating a new thread and refuses to reuse an existing binding if its source mapping differs. Changing the mapping therefore requires a new binding/thread identity.

This setting does not broaden the outbox's cross-workspace gate. Mapped runs still need a complete structured task scope, `read-only` permission, no write paths, normalized source-relative scope entries, and every resolved source path must remain within the managed target workspace. Review targets must remain within readable scope and outside excluded paths. Runs that fail any of these checks are rejected.

## Network and failure diagnostics

`model-access` mode inherits only existing credential-free HTTP(S)/ALL proxy variables and combines existing NO_PROXY entries with explicit loopback exclusions so local Relay traffic bypasses external proxies. Credential-bearing, malformed or nonstandard-path proxy URLs are rejected with a fixed error before launch; no URL value is echoed and there is no silent direct-network fallback. Both bare and bracketed IPv6 loopback forms are excluded. Other environment credentials are not inherited. `isolated` mode retains its restricted environment and separate network namespace. An App Server request rejection can emit a finite diagnostic category and numeric protocol code; raw error text and authentication payloads are never emitted by that diagnostic. A catalog entry or successful tool discovery does not prove account readiness: failed account/workspace routing keeps automatic delivery closed and preserves the queue.

## Per-thread MCP startup

`disabledMcpServers` is an optional array of explicitly named servers to disable only in the managed thread’s startup/resume overrides. It does not edit global Codex configuration. Names must be unique and valid; `harness_relay` is reserved for the required wake proxy. This can prevent unrelated global MCP startup from blocking the private consumer. Alternatively, provide a private, credential-free `codexState/config.toml`; existing private settings are preserved while current authentication can still be mounted read-only.
