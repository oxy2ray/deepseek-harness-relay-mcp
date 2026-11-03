---
name: delegate-to-deepseek-harness
description: Dispatch and monitor a scoped workspace review or user-authorized implementation through DeepSeek Harness Relay. Use when the user asks Harness to analyze, review, fix, edit, refactor, or test. Keep final integration and consequential actions with the calling agent.
---

# Delegate to DeepSeek Harness

Use the installed native Relay MCP tools for bounded reviews and workspace changes. Keep the calling agent responsible for final review and verification. A returned `webUrl` is a link, not a completed run.

## Dispatch

1. Read the target workspace's `AGENTS.md` and the calling instructions. Follow their live provider/model routing order; discover exact current routes with `list_capabilities`. Never hardcode a provider, model, preset ID, quota, or default route. Before choosing a route, inspect provider quota snapshots; read [routing, workspaces, and presets](references/routing-workspaces-presets.md) for workspace registration, session, preset, and quota rules.
2. Use `start_review` for analysis and review; it is fixed to `read-only`. Use `start_run` with `workspace-write` only when the user asks Harness to implement. Do not treat a generic request to call Harness as write authorization. `danger-full-access` requires an action that needs it and explicit user confirmation.
3. Keep every task path-reference-only. Use the workspace root, `reviewTargets`, `contextReadScope`, `excludedPaths`, and (for writes) `writeScope`, plus concise scope and acceptance criteria. Run this installed skill's `scripts/build_task_manifest.py` (resolve it relative to this `SKILL.md`, not the target workspace) with an explicit Python executable and the appropriate `--path`, `--context-path`, `--write-path`, and `--scope` arguments; it validates and formats locations without reading source contents. Never place source, diffs, patches, file dumps, encoded source, or archives in task, content, steer, or reply arguments. These scope fields are instructions alongside native permissions, not per-path filesystem isolation. See [authorization and task content](references/authorization-and-content.md).
4. Select a registered workspace from `list_workspaces`; do not route by `host.describe.cwd`. Register an existing directory only when allowed by the configured workspace roots. Preserve existing changes. If reusing a conversation, list workspace sessions and select a non-archived idle session. `sessionId` and `sessionMode` are mutually exclusive.
5. Select provider/model from live capabilities and caller routing policy. Use `list_agent_presets` when selecting a preset; pass the exact live ID, never the display name. A preset applies only to a new session. Never choose a broken preset or invent missing display metadata. Quota snapshots are advisory; unknown, stale, unsupported, or unconfigured is neither zero nor exhausted and does not authorize an inferred reroute or retry.
6. Pass exact scope and routing metadata to the appropriate start tool, with a stable idempotency key. Every `start_review` requires the exact discovered provider/model and `authorizationBasis: explicit-user-request`; use it only for an explicit user request to have Harness review, and do not ask them to repeat that authorization solely because processing is external. Do not set this marker for inferred or background delegation. On an uncertain start, reconcile the original operation before any retry; never create a duplicate run to resolve ambiguity.
7. Share the returned stable `webUrl` without opening a browser unless the user explicitly asks to open/show it. Monitor and collect results according to [run lifecycle and event wakeups](references/run-lifecycle.md). A host-specific opt-in may support native event wake on a configured existing Codex thread; installation alone does not establish that support. After success, consume `assistantText`, inspect the actual worktree or reproduce review findings, and report changed files, checks, unresolved issues, and any rejected suggestions.

## Keep these boundaries

- Use only native Relay MCP tools for Relay operations. Never create a shell, Node, Python, or PowerShell Relay client. Ordinary local verification commands are fine.
- Keep credentials, secrets, browser storage, production data, unrelated files, commits, pushes, external messages, and release decisions out of scope unless separately authorized.
- If automatic approval review rejects a path-only call, report the exact submitted paths/scope, stated reason, and whether a run was created. Do not switch transport, retry through another channel, narrow the work and claim completion, or ask the user to repeat unchanged authorization. Ask for new input only if the destination or scope must change.
- Preserve user authorization across turns. Do not request permission again for already-authorized reversible in-scope work. Escalate only when the action materially exceeds the existing scope or platform policy requires it.
