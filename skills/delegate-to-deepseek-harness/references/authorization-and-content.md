# Authorization and task content

## Scope and permission

- An explicit request for Harness or a named Harness model to review an identified registered workspace authorizes that selected provider/model to process reads within the stated scope. Do not request redundant confirmation just because the workspace is private or model processing is external. Every `start_review` requires exact discovered provider/model and `authorizationBasis: explicit-user-request`; use it only for the explicit request and never for inferred/background delegation. This records existing authorization and does not expand scope.
- A request to call Harness alone is not write authorization. `start_review` is read-only. Use `start_run` with `workspace-write` only when the user asks Harness to implement or modify the workspace.
- `danger-full-access` is exceptional. Use it only for a necessary in-scope operation that cannot be done with a narrower native preset, after explicit user confirmation; set `confirmedDangerousPermission: true` only then.
- Record the initial worktree state before writes. Harness must preserve pre-existing changes and work only in the named authorized workspace. Treat `reviewTargets`, `contextReadScope`, `excludedPaths`, and `writeScope` as prompt-level scope declarations; native permission presets enforce broad access, not per-path isolation.
- Do not authorize credentials, secrets, browser storage, production data, unrelated files, `.git` internals, commits, pushes, messages, or external writes unless separately authorized. Keep integration, destructive cleanup, security decisions, and release decisions with the calling agent.

## Path-reference-only transfer

For `start_review`, `start_run`, `steer_run`, and `reply_run`, pass workspace roots and file/directory locations, symbols or line references, exclusions, write paths, task scope, and acceptance criteria. Never embed source lines, file bodies, diffs, patches, encoded source, or repository archives in task or content fields. Harness reads named files from the authorized workspace itself; a write grant does not relax this rule. If required material is not available there, request an authorized location or separate attachment workflow instead of copying it into a prompt.

Use the task-manifest helper when available; it validates path containment (including existing symlink targets) and formats scope references without reading or uploading source. Do not treat the helper's path fields as an enforced read whitelist.

Public network research relevant to the task is at Harness's discretion. Prefer primary sources and require URLs for material external claims. This does not authorize account sign-in, private services, credentials, uploads, external writes, messages, pushes, or broader filesystem access. A loopback Relay control connection does not mean model-provider processing stays local. If the selected preset cannot access the public network, report that limitation; do not escalate permission solely for research.

Every delegated prompt must require compliance with the target `AGENTS.md`, preservation of pre-existing changes, the exact authorized read/write scope, no unauthorized side effects, and a reproducible final report. A review should include file/line evidence, severity, consequence, smallest correction, confidence, and `not_applicable` for checks it cannot run. A write run should make the requested change, run proportionate checks, and report files, results, unresolved issues, and scope deviations.

## Authorization continuity and approval review

- Preserve explicit user authorization across turns. Do not ask the user to repeat an already authorized reversible in-scope action. Ask only when scope or destination must change, platform policy requires it, or the action is materially destructive, irreversible, private-account/credential-sensitive, or externally consequential.
- If automatic approval review rejects a path-only call, report the exact submitted workspace/locations/scope, the stated reason, and whether a run was created. Do not switch transport, retry through another channel, silently narrow the task and claim completion, or ask for unchanged authorization again. A rejection does not prove Harness cannot access the workspace.
- If an action exceeds current Harness capability or permission, ask the calling agent for a concrete decision with the action, targets, reason, risk, and least-privilege alternative. The calling agent resolves ordinary reversible in-scope choices under existing authorization; do not escalate to the user by default.
