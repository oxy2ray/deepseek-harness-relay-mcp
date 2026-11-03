# Event wake managed-console quick start

> **Workflow note — 2026-11-03:** This is the historical, separate managed-console quick start. For the new opt-in that attaches to operator-selected threads in an already-running Codex daemon, use [EXISTING_CODEX_WAKE.md](EXISTING_CODEX_WAKE.md). The existing-thread path is not auto-bound to every thread, and the original user root/main thread is not yet validated. No config means the ordinary Relay proxy remains unchanged.

The wake consumer currently runs as an opt-in managed-console fallback. It owns a private Codex app-server process and thread; it is not a general plugin integration for an existing Codex TUI session.

## Prepare a private config

Build the console from the repository:

```sh
npm run build
```

Create a dedicated test root containing separate state, workspace, and control directories. Keep that root outside existing task workspaces; the configured workspace should be a subdirectory inside the dedicated root. Do not point the root at your ordinary `~/.codex` or shared Relay state. The console config is a private JSON file; use canonical absolute paths.

```json
{
  "testRoot": "/absolute/path/to/private-wake-root",
  "codexState": "/absolute/path/to/private-wake-root/codex-state",
  "workspace": "/absolute/path/to/private-wake-root/workspace",
  "wakeState": "/absolute/path/to/private-wake-root/control/wake.json",
  "principal": "local-user",
  "bindingId": "stable-local-binding-id",
  "codexMode": "current-runtime",
  "relayMode": "existing-authorized",
  "relayDescriptor": "/absolute/path/to/relay-endpoint.json",
  "relayAuthorityId": "the-exact-authority-id-from-the-descriptor",
  "relayWorkspace": "/absolute/path/to/authorized-relay-workspace",
  "network": "model-access",
  "enabled": true,
  "disabledMcpServers": ["unrelated-server"]
}
```

`relayDescriptor` and `relayAuthorityId` must identify the same existing Relay authority. The descriptor owns its token-file reference; do not copy tokens into this config. `disabledMcpServers` disables only the named per-thread MCP servers. The console adds its own required `harness_relay` server; that name is reserved and cannot be disabled here.

With `current-runtime`, auth and config files are mounted read-only only when the private Codex state has no file at that name. A private `config.toml` in `codexState` lets you choose model settings without inheriting user-global MCP servers. Keep that file and the workspace free of credentials.

## Start and control the consumer

Run the built console with the absolute config path. A terminal uses concise human output by default; `--json` preserves the JSON-lines event protocol for pipes and scripts. `--human` forces the human renderer.

```sh
node dist/dsh-relay-wake-console.mjs /absolute/path/to/console-config.json
```

Commands:

- `/status` shows the persisted queue and delivery counts.
- `/pause` keeps collecting events and stops new automatic Codex admission; it cannot cancel a turn already accepted and running.
- `/resume` allows queued events to be delivered to the bound thread.
- `/watch RUN_ID KEY` watches an existing Relay run with an idempotency key.
- `/recover DISPATCH_ID` asks the host to reconcile one held dispatch.
- `/respond REQUEST_ID JSON` responds to the exact pending Codex approval request. Review the displayed method and summary first; approvals are never automatic.
- `/quit` stops the managed console. Plain text sends a user message only when the bound thread is idle.

The persisted pause remains in effect after a restart. Starting a new console does not retarget an existing binding or create a replacement thread automatically.

## Stop or roll back

Use `/pause`, then `/quit` (or Ctrl-C) to stop the managed console. This leaves private wake state in place for inspection and restart. Do not remove its state directory while the console process is running or while queued or held events still need reconciliation. Stopping the console does not change the ordinary Codex TUI, user-global Codex configuration, or the Relay service.

## 本机已准备的测试入口

构建验证通过后，可在终端执行：

```sh
/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/start-wake-console.sh
```

这个入口使用独立 Codex 状态和已登记的合成测试工作区；它不会接管当前普通 Codex 窗口。委派并成功登记监听后，当前回合可以结束，后台程序继续检查 DSH；有结果时才恢复同一个控制台线程。`/pause` 停止自动生成但保存事件，`/resume` 补发，`/quit` 退出。普通插件入口仍保留原来的等待方式。
