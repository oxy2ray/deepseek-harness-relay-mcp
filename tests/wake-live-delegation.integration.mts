// Real Codex/Luna delegation acceptance. This test owns only a generated fixture workspace and a private wake state.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { createConsoleMcpConfig, readConsoleConfig } from '../src/wake/console-config.js'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'
import { NativeRelayWakeSource } from '../src/wake/relay-client.js'
import { WakeStore } from '../src/wake/store.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { WakeRuntime } from '../src/wake/runtime.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import type { StdioProxyConfig } from '../src/stdio-proxy/index.js'

const timeoutMs = 600_000
const terminalStatuses = new Set(['succeeded', 'failed', 'incomplete', 'cancelled'])
const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/)
const requireBFirst = process.env.WAKE_TEST_ORDER === 'B-first'

interface Route { provider: string; model: string }
interface Fixture { label: string; workspaceRelative: string; relayRelative: string; token: string; delaySeconds: number }
interface RunExpectation { runId: string; token: string; label: string }

test('automatic approval rejection classifier matches only the bounded rejection marker', () => {
  assert.equal(hasAutomaticApprovalRejection({ status: 'failed', error: { message: 'This action was rejected due to unacceptable risk. Reason: redacted' } }), true)
  assert.equal(hasAutomaticApprovalRejection({ status: 'failed', error: { message: 'permission denied' } }), false)
  assert.equal(hasAutomaticApprovalRejection({ status: 'completed', error: { message: 'This action was rejected due to unacceptable risk. Reason: redacted' } }), false)
})

test('real Luna starts A/B/C reviews, acknowledges watches, then verifies completed results after wake', {
  skip: !process.env.WAKE_LIVE_DELEGATION_CONFIG,
  timeout: timeoutMs + 15_000,
}, async () => {
  const deadlineAt = Date.now() + timeoutMs
  const config = await readConsoleConfig(process.env.WAKE_LIVE_DELEGATION_CONFIG!)
  const control = dirname(config.wakeState)
  const startedPath = join(control, 'delegation-started.json')
  const readyPath = join(control, 'delegation-ready.json')
  const progressPath = join(control, 'delegation-progress.json')
  const evidencePath = join(control, 'delegation-evidence.json')
  let host: OwnedCodexHost | undefined
  let source: NativeRelayWakeSource | undefined
  let proxy: StdioProxyFacade | undefined
  let catalogClient: Client | undefined
  let runtime: WakeRuntime | undefined
  let threadId = ''
  let codexModelId = ''
  let route: Route | undefined
  let stage = 'configuration'
  let failureReason = 'setup-or-runtime-error'
  const enteredStages: Record<string, true> = { configuration: true }
  const markStage = (name: string) => { stage = name; enteredStages[name] = true }
  const expectations = new Map<string, RunExpectation>()
  const fixtureByRelayPath = new Map<string, Fixture>()
  const startReviewCallIds = new Set<string>()
  const startedReviewTargets = new Map<string, string>()
  const startedReviewValidity = new Map<string, boolean>()
  const startedWatchRuns = new Map<string, string>()
  const startedWatchKeys = new Map<string, string>()
  const completedStartReviewCallIds = new Set<string>()
  const invalidStartReviewRunIds = new Set<string>()
  const startedRunMetadata = new Map<string, { label: string; webUrl: string | null }>()
  const watchRunCallIds = new Set<string>()
  const duplicateWatchRunIds = new Set<string>()
  const watchRequestedKeyAcknowledgements = new Set<string>()
  const watchStartKeyAcknowledgements = new Set<string>()
  let startedMetadataWrites = Promise.resolve()
  const approvalRejectedCallIds = new Set<string>()
  let approvalMetadataWrites = Promise.resolve()
  const watchAcknowledgements = new Set<string>()
  const getRunCalls = new Set<string>()
  const getRunCallCounts = new Map<string, number>()
  const waitRunCalls = new Set<string>()
  const forbiddenTaskCalls = new Set<string>()
  const replyBuffers = new Map<string, string>()
  const matchingReplies = new Set<string>()
  const turnStatuses = new Map<string, string>()
  let approvalRejectionCount = 0
  let needsHumanCount = 0
  const needsHumanRunIds = new Set<string>()
  const runningAfterDelegationRunIds = new Set<string>()
  const runStatusReadFailures = new Map<string, number>()
  const runStatusReadRetryAt = new Map<string, number>()
  const codexRuntimeDiagnostics: Array<Record<string, string | number | boolean | null>> = []
  let delegationCompletedAt: string | null = null
  let firstTerminalRunId: string | null = null
  let firstTerminalOthersNonterminal = false
  let zeroPollingWorkflowPassed = false

  try {
    if (config.codexMode !== 'current-runtime' || config.relayMode !== 'existing-authorized' || config.network !== 'model-access') {
      failureReason = 'configuration-mode-mismatch'
      throw new Error('unsupported test configuration modes')
    }
    assert.ok(config.relayDescriptor && config.relayAuthorityId)
    const sourceRoot = resolve(config.relayWorkspace)
    const targetRoot = resolve(config.workspace)
    const workspacePrefix = relative(sourceRoot, targetRoot).replaceAll('\\', '/')
    if (workspacePrefix.startsWith('../') || workspacePrefix === '..') {
      failureReason = 'workspace-mapping-invalid'
      throw new Error('test workspace must be inside relayWorkspace')
    }
    await mkdir(control, { recursive: true, mode: 0o700 })
    ensureTime(deadlineAt)

    // A reused control root could repeat DSH operations after an uncertain prior start. Fail closed.
    const outbox = new WakeOutbox(new WakeStore(config.wakeState))
    const prior = await outbox.store.read()
    if (prior.bindings.length || prior.watches.length || prior.events.length || prior.deliveries.length) {
      failureReason = 'wake-state-not-fresh'
      throw new Error('private wake state is not fresh')
    }
    try { await readFile(startedPath); failureReason = 'prior-delegation-attempt'; throw new Error('prior attempt marker exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }

    // A fresh binding gets its own fixture directory, so prior attempts cannot be overwritten.
    const fixtureDirectory = join(config.workspace, '.wake-live-delegation', config.bindingId)
    await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
    const fixtures: Fixture[] = [
      { label: 'A', delaySeconds: configuredDelay('A', 80) },
      { label: 'B', delaySeconds: configuredDelay('B', 45) },
      { label: 'C', delaySeconds: configuredDelay('C', 70) },
    ].map(({ label, delaySeconds }) => {
      const workspaceRelative = `.wake-live-delegation/${config.bindingId}/${label}.md`
      const token = `E2E-DELEGATION-${label}-${randomUUID()}`
      const relayRelative = workspacePrefix ? `${workspacePrefix}/${workspaceRelative}` : workspaceRelative
      const fixture = { label, workspaceRelative, relayRelative, token, delaySeconds }
      fixtureByRelayPath.set(relayRelative, fixture)
      return fixture
    })
    for (const fixture of fixtures) {
      await writeFile(join(config.workspace, fixture.workspaceRelative),
        `Synthetic acceptance fixture ${fixture.label}. Marker: ${fixture.token}\nReview this fixture for its stated acceptance evidence.\n`, { mode: 0o600 })
    }

    ensureTime(deadlineAt)
    markStage('codex-launch')
    host = await OwnedCodexHost.launch({ testRoot: config.testRoot, stateDirectory: config.codexState,
      workspace: config.workspace, codexMode: config.codexMode, network: config.network })
    host.process.on('stderrDiagnostic', value => {
      if (!value || typeof value !== 'object') return
      const diagnostic = value as Record<string, unknown>
      codexRuntimeDiagnostics.push({ kind: 'stderr', category: safeEnum(diagnostic.category), code: safeCode(diagnostic.code),
        httpStatus: typeof diagnostic.httpStatus === 'number' ? diagnostic.httpStatus : null,
        host: typeof diagnostic.host === 'string' ? diagnostic.host.slice(0, 255) : null })
      void atomicMetadata(join(control, 'codex-runtime-diagnostics.json'), { version: 1, diagnostics: codexRuntimeDiagnostics }).catch(() => undefined)
    })
    host.process.on('requestRejected', value => {
      if (!value || typeof value !== 'object') return
      const diagnostic = value as Record<string, unknown>
      const network = diagnostic.networkFailure && typeof diagnostic.networkFailure === 'object'
        ? diagnostic.networkFailure as Record<string, unknown> : undefined
      codexRuntimeDiagnostics.push({ kind: 'request-rejected', method: safeEnum(diagnostic.method),
        category: safeEnum(diagnostic.category), code: typeof diagnostic.code === 'number' ? diagnostic.code : null,
        networkKind: network ? safeEnum(network.kind) : null,
        host: network && typeof network.host === 'string' ? network.host.slice(0, 255) : null })
      void atomicMetadata(join(control, 'codex-runtime-diagnostics.json'), { version: 1, diagnostics: codexRuntimeDiagnostics }).catch(() => undefined)
    })
    host.process.on('notification', message => {
      observeCodexNotification(message, { expectations, startReviewCallIds, startedReviewTargets, startedReviewValidity,
        startedWatchRuns, startedWatchKeys, completedStartReviewCallIds,
        watchRunCallIds, duplicateWatchRunIds, watchAcknowledgements, watchRequestedKeyAcknowledgements,
        watchStartKeyAcknowledgements, getRunCalls, getRunCallCounts, waitRunCalls, replyBuffers,
        matchingReplies, fixtureByRelayPath, turnStatuses,
        forbiddenTaskCalls, bindingId: config.bindingId, startedRunMetadata, invalidStartReviewRunIds,
        currentRoute: () => route, relayWorkspace: config.relayWorkspace,
        onApprovalRejection: callId => {
          if (approvalRejectedCallIds.has(callId)) return
          approvalRejectedCallIds.add(callId)
          approvalRejectionCount = approvalRejectedCallIds.size
          approvalMetadataWrites = approvalMetadataWrites.then(() => atomicMetadata(join(control, 'delegation-approval-rejected.json'), {
            version: 1, status: 'automatic-approval-rejected', count: approvalRejectionCount,
            toolCallIds: [...approvalRejectedCallIds],
          })).catch(() => undefined)
        }, onStartedRunsChanged: () => {
          startedMetadataWrites = startedMetadataWrites.then(() => atomicMetadata(join(control, 'delegation-runs.json'), {
            version: 1, status: 'started-runs', runs: [...startedRunMetadata.entries()].map(([runId, data]) => ({ runId, ...data })),
          })).catch(() => undefined)
        } })
    })
    host.process.on('serverRequest', () => {
      needsHumanCount++
      void atomicMetadata(join(control, 'needs-human.json'), { version: 1, status: 'needs-human',
        pendingRequestCount: needsHumanCount, note: 'Manual review required; no approval was sent.' }).catch(() => undefined)
    })

    markStage('codex-model-discovery')
    const codexCatalog = await host.process.request('model/list', {}) as { data?: unknown[] }
    const codexModels = Array.isArray(codexCatalog.data) ? codexCatalog.data : []
    const codexModelIds = [...new Set(codexModels.flatMap(modelIdsOf))]
    const lunaIds = codexModelIds.filter(id => /luna/i.test(id))
    codexModelId = lunaIds.includes('gpt-6-luna') ? 'gpt-6-luna' : lunaIds[0] ?? ''
    if (!codexModelId) { failureReason = 'luna-model-unavailable'; throw new Error('no advertised Codex Luna model') }

    markStage('relay-capability-discovery')
    const relayProxyConfig: StdioProxyConfig = { descriptorFile: config.relayDescriptor,
      clientPrincipalId: config.principal, requestTimeoutMs: 10_000, autoStart: false }
    proxy = new StdioProxyFacade(relayProxyConfig)
    const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
    await proxy.connect(proxyTransport)
    catalogClient = new Client({ name: 'wake-live-delegation-capabilities', version: '1' })
    await catalogClient.connect(clientTransport)
    const capabilityResult = await catalogClient.callTool({ name: 'list_capabilities', arguments: {} }, undefined, { timeout: 15_000 })
    if (capabilityResult.isError) throw new Error('native capability discovery failed')
    const routeData = getStructuredContent(capabilityResult)
    const routes = extractRoutes(routeData)
    route = chooseRoute(routes, process.env.WAKE_LIVE_PROVIDER, process.env.WAKE_LIVE_MODEL)
    if (!route) { failureReason = 'no-advertised-review-route'; throw new Error('no eligible advertised provider/model route') }

    ensureTime(deadlineAt)
    source = await NativeRelayWakeSource.connect({ descriptorFile: config.relayDescriptor,
      clientPrincipalId: config.principal, requestTimeoutMs: 10_000, autoStart: false })
    markStage('managed-thread-start')
    ensureTime(deadlineAt)
    const proxyPath = fileURLToPath(new URL('../dist/dsh-relay-wake-proxy.mjs', import.meta.url))
    const mcpConfig = createConsoleMcpConfig(config.disabledMcpServers, { command: process.execPath,
      args: [proxyPath, process.env.WAKE_LIVE_DELEGATION_CONFIG!], startup_timeout_sec: 15, required: true })
    threadId = await host.startThread({ model: codexModelId, ...mcpConfig })
    markStage('relay-tools-readiness')
    await waitForWakeTools(host, threadId)
    ensureTime(deadlineAt)
    markStage('ready-turn-admission')
    const ready = await host.sendUserMessage(threadId,
      'Reply exactly READY and call no tools in this turn. For each later automatic wake event, call native get_run for every referenced runId, inspect the complete returned result, and reply with each runId plus the literal E2E marker found in that result. Do not call wait_run or read local files.')
    if (ready.kind !== 'accepted') throw new Error('READY turn not admitted')
    const binding = { bindingId: config.bindingId, threadId, principal: config.principal, workspace: config.workspace,
      relayWorkspace: config.relayWorkspace, serverIdentity: host.serverIdentity, enabled: true,
      expiresAt: Date.now() + 8 * 60 * 60_000 }
    markStage('ready-turn-completion')
    await waitForTurnCompletion(threadId, ready.turnId, turnStatuses, Math.min(60_000, remaining(deadlineAt)))
    markStage('ready-thread-resume')
    await host.resumeThread(threadId)
    markStage('ready-history-verification')
    if (await host.completion(binding, ready.turnId) !== 'completed') throw new Error('READY durable history verification failed')
    if (replyBuffers.get(ready.turnId)?.trim() !== 'READY' || startReviewCallIds.size || getRunCalls.size || waitRunCalls.size) {
      failureReason = 'ready-bootstrap-contract-failed'
      throw new Error('READY bootstrap response/tool contract failed')
    }

    markStage('binding-runtime-ready')
    await outbox.registerBinding(binding)
    await outbox.setEnabled(true)
    runtime = new WakeRuntime(outbox, source, host)
    await runtime.start()
    if (!(await runtime.tick()).ready) throw new Error('wake runtime prerequisites are unavailable')
    await atomicMetadata(readyPath, { version: 1, status: 'ready', threadId, bindingId: binding.bindingId,
      codexModelId, route, relayAuthorityId: config.relayAuthorityId, fixtureCount: fixtures.length })
    ensureTime(deadlineAt)

    // Marker is written immediately before any start_review call; rerunning this control root never repeats dispatches.
    await atomicMetadata(startedPath, { version: 1, status: 'delegation-started', threadId, bindingId: binding.bindingId,
      idempotencyKeys: fixtures.map(fixture => idempotencyKey(binding.bindingId, fixture.label)) })
    markStage('delegation-turn')
    const instructions = buildDelegationPrompt(config.relayWorkspace, route, fixtures, workspacePrefix || '.', binding.bindingId)
    const delegation = await host.sendUserMessage(threadId, instructions)
    if (delegation.kind !== 'accepted') throw new Error('delegation turn not admitted')

    const deadline = deadlineAt
    let lastProgress = ''
    while (Date.now() < deadline) {
      if (approvalRejectionCount > 0) {
        failureReason = 'automatic-approval-rejected'
        markStage('automatic-approval-rejected')
        await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: failureReason, stage,
          threadId, bindingId: config.bindingId, codexModelId, route,
          approvalRejectionCount, approvalRejectedToolCallIds: [...approvalRejectedCallIds] })
        throw new Error('start_review was rejected by automatic approval review')
      }
      await runtime.tick()
      if (approvalRejectionCount > 0) {
        failureReason = 'automatic-approval-rejected'
        markStage('automatic-approval-rejected')
        await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: failureReason, stage,
          threadId, bindingId: config.bindingId, codexModelId, route,
          approvalRejectionCount, approvalRejectedToolCallIds: [...approvalRejectedCallIds] })
        throw new Error('start_review was rejected by automatic approval review')
      }
      const state = await outbox.store.read()
      const acknowledgedEventRunIds = new Set(state.events.filter(event => state.deliveries.some(delivery =>
        delivery.state === 'acknowledged' && delivery.eventIds.includes(event.eventId))).map(event => event.runId))
      const allRunsStarted = expectations.size === 3 && completedStartReviewCallIds.size === 3
      const allWatchesAcknowledged = expectations.size === 3 && watchRunCallIds.size === 3 && duplicateWatchRunIds.size === 0
        && [...expectations.keys()].every(runId => watchAcknowledgements.has(runId))
      const runStatuses = new Map<string, string>()
      for (const runId of expectations.keys()) {
        if (Date.now() >= (runStatusReadRetryAt.get(runId) ?? 0)) {
          try {
            runStatuses.set(runId, (await source.getRun(runId, config.principal)).status)
            runStatusReadFailures.delete(runId)
            runStatusReadRetryAt.delete(runId)
          } catch {
            // This is a read-only status probe; a transient native Relay error must not close a live Codex turn.
            const failures = (runStatusReadFailures.get(runId) ?? 0) + 1
            runStatusReadFailures.set(runId, failures)
            runStatusReadRetryAt.set(runId, Date.now() + Math.min(5000, 250 * 2 ** Math.min(4, failures - 1)))
            if (!runStatuses.has(runId)) runStatuses.set(runId, 'unknown')
          }
        } else if (!runStatuses.has(runId)) runStatuses.set(runId, 'unknown')
        if (runStatuses.get(runId) === 'needs_attention' && !needsHumanRunIds.has(runId)) {
          needsHumanRunIds.add(runId)
          void atomicMetadata(join(control, 'needs-human.json'), { version: 1, status: 'needs-human',
            pendingRunIds: [...needsHumanRunIds], note: 'A DSH run needs human attention; no interaction was answered.' }).catch(() => undefined)
        }
      }
      const delegationCompleted = turnStatuses.get(`${threadId}:${delegation.turnId}`) === 'completed'
      if (delegationCompleted && !delegationCompletedAt) delegationCompletedAt = new Date().toISOString()
      if (delegationCompleted) for (const [runId, status] of runStatuses) if (status === 'running') runningAfterDelegationRunIds.add(runId)
      if (!firstTerminalRunId && expectations.size === 3 && completedStartReviewCallIds.size === 3) {
        const firstTerminal = [...runStatuses].find(([, status]) => terminalStatuses.has(status))
        if (firstTerminal) {
          firstTerminalRunId = firstTerminal[0]
          firstTerminalOthersNonterminal = [...runStatuses].every(([runId, status]) =>
            runId === firstTerminalRunId || !terminalStatuses.has(status))
        }
      }
      const allRunsTerminal = expectations.size === 3 && [...expectations.keys()].every(runId => terminalStatuses.has(runStatuses.get(runId) ?? ''))
      const allEventsAcknowledged = expectations.size === 3 && [...expectations.keys()].every(runId => acknowledgedEventRunIds.has(runId))
      const allResultsReplied = expectations.size === 3 && [...expectations.keys()].every(runId =>
        getRunCalls.has(runId) && getRunCallCounts.get(runId) === 1 && matchingReplies.has(runId))
      zeroPollingWorkflowPassed = allRunsStarted && startReviewCallIds.size === 3 && invalidStartReviewRunIds.size === 0
        && forbiddenTaskCalls.size === 0 && allWatchesAcknowledged && delegationCompleted
        && allRunsTerminal && allEventsAcknowledged && allResultsReplied && waitRunCalls.size === 0
        && runningAfterDelegationRunIds.size > 0
      const progress = { version: 1, status: approvalRejectionCount ? 'automatic-approval-rejected'
        : needsHumanCount || needsHumanRunIds.size ? 'needs-human' : 'running', stage, threadId,
        codexModelId, route, startReviewCalls: startReviewCallIds.size, startedRunCount: expectations.size,
        completedStartReviewCount: completedStartReviewCallIds.size, invalidStartReviewCount: invalidStartReviewRunIds.size,
        forbiddenTaskCallCount: forbiddenTaskCalls.size, acknowledgedWatchCount: watchAcknowledgements.size,
        watchRunCallCount: watchRunCallIds.size, duplicateWatchRunIds: [...duplicateWatchRunIds],
        watchRequestedKeyAcknowledgementRunIds: [...watchRequestedKeyAcknowledgements],
        watchStartKeyAcknowledgementRunIds: [...watchStartKeyAcknowledgements],
        getRunCallCounts: [...getRunCallCounts.entries()].map(([runId, count]) => ({ runId, count })),
        runStatusReadFailures: [...runStatusReadFailures.entries()].map(([runId, count]) => ({ runId, count })),
        approvalRejectionCount,
        getRunCallCount: getRunCalls.size, waitRunCallCount: waitRunCalls.size, eventCount: state.events.length,
        acknowledgedEventRunCount: acknowledgedEventRunIds.size, matchingReplyCount: matchingReplies.size, needsHumanCount,
        zeroPollingWorkflowPassed,
        needsHumanRunIds: [...needsHumanRunIds], delegationCompletedAt, runningAfterDelegationRunIds: [...runningAfterDelegationRunIds],
        firstTerminalRunId, firstTerminalLabel: firstTerminalRunId ? expectations.get(firstTerminalRunId)?.label ?? null : null,
        firstTerminalOthersNonterminal, requireBFirst }
      const progressSnapshot = JSON.stringify(progress)
      if (progressSnapshot !== lastProgress) {
        await atomicMetadata(progressPath, { ...progress, updatedAt: new Date().toISOString() })
        lastProgress = progressSnapshot
      }

      if (allRunsStarted && startReviewCallIds.size === 3 && invalidStartReviewRunIds.size === 0 && forbiddenTaskCalls.size === 0
        && watchRunCallIds.size === 3 && duplicateWatchRunIds.size === 0
        && allWatchesAcknowledged && delegationCompleted && allRunsTerminal
        && allEventsAcknowledged && allResultsReplied && waitRunCalls.size === 0 && runningAfterDelegationRunIds.size > 0
        && expectations.get(firstTerminalRunId ?? '')?.label === 'B' && firstTerminalOthersNonterminal) {
        markStage('success')
        await atomicMetadata(evidencePath, { version: 1, status: 'success', stage, threadId, bindingId: binding.bindingId,
          codexModelId, route, runIds: [...expectations.keys()], acknowledgedWatchRunIds: [...watchAcknowledgements],
          watchRunCallCount: watchRunCallIds.size, duplicateWatchRunIds: [...duplicateWatchRunIds],
          watchRequestedKeyAcknowledgementRunIds: [...watchRequestedKeyAcknowledgements],
          watchStartKeyAcknowledgementRunIds: [...watchStartKeyAcknowledgements],
          getRunCallCounts: [...getRunCallCounts.entries()].map(([runId, count]) => ({ runId, count })),
          completedDshRunCount: [...state.watches].filter(watch => expectations.has(watch.runId) && watch.terminal).length,
          eventCount: state.events.length, acknowledgedEventRunIds: [...acknowledgedEventRunIds],
          getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls], matchingReplyRunIds: [...matchingReplies],
          needsHumanCount, delegationCompletedAt, runningAfterDelegationRunIds: [...runningAfterDelegationRunIds],
          firstTerminalRunId, firstTerminalLabel: firstTerminalRunId ? expectations.get(firstTerminalRunId)?.label ?? null : null,
          firstTerminalOthersNonterminal, strictBFirstPassed: expectations.get(firstTerminalRunId ?? '')?.label === 'B'
            && firstTerminalOthersNonterminal, zeroPollingWorkflowPassed, completedAt: new Date().toISOString() })
        await startedMetadataWrites
        return
      }
      if (zeroPollingWorkflowPassed && (expectations.get(firstTerminalRunId ?? '')?.label !== 'B' || !firstTerminalOthersNonterminal)) {
        if (!requireBFirst) {
          markStage('success')
          await atomicMetadata(evidencePath, { version: 1, status: 'success', stage, threadId, bindingId: binding.bindingId,
            codexModelId, route, runIds: [...expectations.keys()], acknowledgedWatchRunIds: [...watchAcknowledgements],
            watchRunCallCount: watchRunCallIds.size, duplicateWatchRunIds: [...duplicateWatchRunIds],
            watchRequestedKeyAcknowledgementRunIds: [...watchRequestedKeyAcknowledgements],
            watchStartKeyAcknowledgementRunIds: [...watchStartKeyAcknowledgements],
            getRunCallCounts: [...getRunCallCounts.entries()].map(([runId, count]) => ({ runId, count })),
            completedDshRunCount: [...state.watches].filter(watch => expectations.has(watch.runId) && watch.terminal).length,
            eventCount: state.events.length, acknowledgedEventRunIds: [...acknowledgedEventRunIds],
            getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls], matchingReplyRunIds: [...matchingReplies],
            needsHumanCount, delegationCompletedAt, runningAfterDelegationRunIds: [...runningAfterDelegationRunIds],
            firstTerminalRunId, firstTerminalLabel: firstTerminalRunId ? expectations.get(firstTerminalRunId)?.label ?? null : null,
            firstTerminalOthersNonterminal, strictBFirstPassed: false, zeroPollingWorkflowPassed, completedAt: new Date().toISOString() })
          await startedMetadataWrites
          return
        }
        failureReason = 'first-terminal-order-mismatch'
        markStage('first-terminal-order-mismatch')
        throw new Error('strict B-first ordering condition failed after the zero-poll workflow completed')
      }
      await delay(500)
    }
    failureReason = needsHumanCount || needsHumanRunIds.size ? 'needs-human' : 'deadline'
    markStage('deadline')
    await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: failureReason, stage, threadId,
      codexModelId, route, runIds: [...expectations.keys()], startReviewCalls: startReviewCallIds.size,
      completedStartReviewCount: completedStartReviewCallIds.size, acknowledgedWatchRunIds: [...watchAcknowledgements],
      watchRunCallCount: watchRunCallIds.size, duplicateWatchRunIds: [...duplicateWatchRunIds],
      watchRequestedKeyAcknowledgementRunIds: [...watchRequestedKeyAcknowledgements],
      watchStartKeyAcknowledgementRunIds: [...watchStartKeyAcknowledgements],
      getRunCallCounts: [...getRunCallCounts.entries()].map(([runId, count]) => ({ runId, count })),
      getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls], matchingReplyRunIds: [...matchingReplies],
      needsHumanCount, needsHumanRunIds: [...needsHumanRunIds], approvalRejectionCount,
      runStatusReadFailures: [...runStatusReadFailures.entries()].map(([runId, count]) => ({ runId, count })),
      approvalRejectedToolCallIds: [...approvalRejectedCallIds], delegationCompletedAt,
      runningAfterDelegationRunIds: [...runningAfterDelegationRunIds], firstTerminalRunId,
      firstTerminalLabel: firstTerminalRunId ? expectations.get(firstTerminalRunId)?.label ?? null : null,
      firstTerminalOthersNonterminal, requireBFirst, zeroPollingWorkflowPassed })
    assert.fail('delegation acceptance did not complete before deadline')
  } catch (error) {
    await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: failureReason, stage,
      enteredStages, threadId: threadId || null, codexModelId: codexModelId || null, route: route ?? null,
      runIds: [...expectations.keys()], startedRuns: [...startedRunMetadata.entries()].map(([runId, data]) => ({ runId, ...data })),
      startReviewCalls: startReviewCallIds.size, startedRunCount: expectations.size, forbiddenTaskCalls: [...forbiddenTaskCalls],
      acknowledgedWatchRunIds: [...watchAcknowledgements], getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls],
      watchRunCallCount: watchRunCallIds.size, duplicateWatchRunIds: [...duplicateWatchRunIds],
      watchRequestedKeyAcknowledgementRunIds: [...watchRequestedKeyAcknowledgements],
      watchStartKeyAcknowledgementRunIds: [...watchStartKeyAcknowledgements],
      getRunCallCounts: [...getRunCallCounts.entries()].map(([runId, count]) => ({ runId, count })),
      matchingReplyRunIds: [...matchingReplies], needsHumanCount, needsHumanRunIds: [...needsHumanRunIds],
      approvalRejectionCount, approvalRejectedToolCallIds: [...approvalRejectedCallIds],
      runStatusReadFailures: [...runStatusReadFailures.entries()].map(([runId, count]) => ({ runId, count })),
      zeroPollingWorkflowPassed,
      requireBFirst,
      error: safeError(error) }).catch(() => undefined)
    throw new Error('live delegation acceptance failed; inspect private metadata evidence only')
  } finally {
    try { await startedMetadataWrites } catch { /* preserve any run IDs already captured */ }
    try { await approvalMetadataWrites } catch { /* rejection metadata contains safe counters and IDs */ }
    try { await runtime?.close() } catch { /* do not write raw process errors */ }
    try { await catalogClient?.close() } catch { /* do not write raw process errors */ }
    try { await proxy?.close() } catch { /* do not write raw process errors */ }
    try { await source?.close() } catch { /* do not write raw process errors */ }
    try { await host?.close() } catch { /* do not write raw process errors */ }
  }
})

function buildDelegationPrompt(relayWorkspace: string, route: Route, fixtures: Fixture[], prefix: string, bindingId: string): string {
  const rows = fixtures.map(fixture => {
    const key = idempotencyKey(bindingId, fixture.label)
    return `${fixture.label}: workspace=${relayWorkspace}; sessionMode=fresh; reviewTargets/contextReadScope=[${fixture.relayRelative}]; excludedPaths=[]; writeScope=[]; idempotencyKey=${key}; watchIdempotencyKey=${watchIdempotencyKey(bindingId, fixture.label)}; task=Use exactly one passive delay by running sleep ${fixture.delaySeconds} once; do not poll status or call any status tool during the delay. Then review only the named synthetic fixture with read-only access and include its literal E2E marker in the review result. Do not write.`
  })
  return [
    'This explicit test authorization is for exactly three read-only synthetic fixture reviews A, B, and C.',
    `Use start_review exactly once for each row. Use provider=${route.provider} and model=${route.model} exactly, permission is fixed read-only, and authorizationBasis must be explicit-user-request.`,
    ...rows,
    'After each start_review result, immediately call watch_run with that returned runId and the exact watchIdempotencyKey from that row. End this delegation turn only after all three watch_run responses say acknowledged=true and hostMayConcludeTurn=true.',
    'Do not call wait_run, start_run, steer_run, or any other task-creation tool. Do not read any files outside the listed reviewTargets/contextReadScope. Do not modify files. Report only the three runIds and factual watch-registration acknowledgements.',
    'After a later automatic wake event, call get_run for every referenced runId, inspect the full result, and reply with each runId and the literal E2E marker present in that result. Never use wait_run.',
    `Fixture workspace prefix is ${prefix}; the Relay source workspace is ${relayWorkspace}.`,
  ].join('\n')
}

function idempotencyKey(bindingId: string, label: string): string {
  return `wake-e2e-${createHash('sha256').update(`${bindingId}:${label}`).digest('hex').slice(0, 24)}`
}

function watchIdempotencyKey(bindingId: string, label: string): string {
  return `watch-e2e-${createHash('sha256').update(`${bindingId}:${label}`).digest('hex').slice(0, 24)}`
}

async function waitForWakeTools(host: OwnedCodexHost, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let result: { data?: Array<{ name?: string; tools?: Record<string, unknown> }> }
    try {
      // A required MCP server may consume its full 15-second startup window before status becomes responsive.
      result = await host.process.request('mcpServerStatus/list', { threadId, serverName: 'harness_relay' }, 20_000) as typeof result
    } catch (error) {
      const safe = safeError(error)
      throw new Error(`wake-tools-status-request-failed:${safe.category}:${safe.code ?? 'none'}`)
    }
    const tools = result.data?.find(server => server.name === 'harness_relay')?.tools ?? {}
    if (tools.start_review && tools.watch_run && tools.get_run) return
    await delay(250)
  }
  throw new Error('wake relay tools not ready')
}

async function waitForTurnCompletion(threadId: string, turnId: string, statuses: Map<string, string>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = statuses.get(`${threadId}:${turnId}`)
    if (status === 'completed') return
    if (status === 'failed' || status === 'interrupted') throw new Error('turn completed unsuccessfully')
    await delay(100)
  }
  throw new Error('turn completion notification timeout')
}

function observeCodexNotification(message: unknown, state: {
  expectations: Map<string, RunExpectation>; startReviewCallIds: Set<string>; startedReviewTargets: Map<string, string>;
  startedReviewValidity: Map<string, boolean>; startedWatchRuns: Map<string, string>; startedWatchKeys: Map<string, string>;
  completedStartReviewCallIds: Set<string>;
  watchRunCallIds: Set<string>; duplicateWatchRunIds: Set<string>; watchAcknowledgements: Set<string>;
  watchRequestedKeyAcknowledgements: Set<string>; watchStartKeyAcknowledgements: Set<string>;
  getRunCalls: Set<string>; getRunCallCounts: Map<string, number>; waitRunCalls: Set<string>; replyBuffers: Map<string, string>;
  matchingReplies: Set<string>; fixtureByRelayPath: Map<string, Fixture>; turnStatuses: Map<string, string>;
  startedRunMetadata: Map<string, { label: string; webUrl: string | null }>; invalidStartReviewRunIds: Set<string>;
  forbiddenTaskCalls: Set<string>; bindingId: string; currentRoute: () => Route | undefined;
  relayWorkspace: string; onStartedRunsChanged: () => void; onApprovalRejection: (callId: string) => void
}): void {
  if (!message || typeof message !== 'object') return
  const notification = message as { method?: unknown; params?: unknown }
  const method = typeof notification.method === 'string' ? notification.method : ''
  const params = notification.params
  scanToolObservations(params, state)
  recordTurnStatus(message, state.turnStatuses)
  const item = nestedItem(params)
  if (!item) return
  if (method === 'item/started' && toolName(item) === 'start_review') {
    const key = toolCallKey(item)
    state.startReviewCallIds.add(key)
    const args = parseObject(item.arguments ?? item.input)
    const target = Array.isArray(args?.reviewTargets) && typeof args.reviewTargets[0] === 'string' ? args.reviewTargets[0] : undefined
    if (target) state.startedReviewTargets.set(key, target)
    const fixture = target ? state.fixtureByRelayPath.get(target) : undefined
    state.startedReviewValidity.set(key, Boolean(fixture && validReviewArgs(args, fixture, state.currentRoute(), state.relayWorkspace, state.bindingId)))
  }
  if (method === 'item/started' && toolName(item) === 'watch_run') {
    const args = parseObject(item.arguments ?? item.input)
    const key = toolCallKey(item)
    if (typeof args?.runId === 'string') {
      if ([...state.startedWatchRuns.values()].includes(args.runId)) state.duplicateWatchRunIds.add(args.runId)
      state.startedWatchRuns.set(key, args.runId)
      state.watchRunCallIds.add(key)
    }
    if (typeof args?.idempotencyKey === 'string') state.startedWatchKeys.set(key, args.idempotencyKey)
  }
  if (method !== 'item/completed') return
  const name = toolName(item)
  if (name === 'start_review' && hasAutomaticApprovalRejection(item)) {
    state.onApprovalRejection(safeApprovalToolCallId(item))
    return
  }
  if (name === 'start_review') {
    const args = parseObject(item.arguments ?? item.input)
    const target = Array.isArray(args?.reviewTargets) && typeof args.reviewTargets[0] === 'string'
      ? args.reviewTargets[0] : state.startedReviewTargets.get(toolCallKey(item)) ?? ''
    const fixture = state.fixtureByRelayPath.get(target)
    const runId = extractRunId(item.result)
    if (runId && fixture) {
      state.expectations.set(runId, { runId, token: fixture.token, label: fixture.label })
      const callKey = toolCallKey(item)
      const validArgs = args
        ? validReviewArgs(args, fixture, state.currentRoute(), state.relayWorkspace, state.bindingId)
        : state.startedReviewValidity.get(callKey) === true
      if (validArgs) state.completedStartReviewCallIds.add(runId)
      else state.invalidStartReviewRunIds.add(runId)
      const webUrl = extractWebUrl(item.result)
      state.startedRunMetadata.set(runId, { label: fixture.label, webUrl })
      state.onStartedRunsChanged()
    }
  }
  if (name === 'watch_run') {
    const args = parseObject(item.arguments ?? item.input)
    const runId = typeof args?.runId === 'string' ? args.runId : state.startedWatchRuns.get(toolCallKey(item))
    const structured = findStructuredResult(item.result)
    const expected = runId ? state.expectations.get(runId) : undefined
    const watchKey = typeof args?.idempotencyKey === 'string' ? args.idempotencyKey : state.startedWatchKeys.get(toolCallKey(item))
    const requestedKey = expected ? watchIdempotencyKey(state.bindingId, expected.label) : ''
    const startKey = expected ? idempotencyKey(state.bindingId, expected.label) : ''
    if (runId && expected && (watchKey === requestedKey || watchKey === startKey)
      && structured?.acknowledged === true && structured.hostMayConcludeTurn === true) {
      state.watchAcknowledgements.add(runId)
      if (watchKey === requestedKey) state.watchRequestedKeyAcknowledgements.add(runId)
      else state.watchStartKeyAcknowledgements.add(runId)
    }
  }
  if (isAgentMessageItem(item)) recordAgentReply(item, params, state)
}

function hasAutomaticApprovalRejection(value: unknown, failedContext = false): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(child => hasAutomaticApprovalRejection(child, failedContext))
  const record = value as Record<string, unknown>
  const isFailure = failedContext || record.status === 'failed' || record.isError === true
  const error = record.error
  if (isFailure && error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.startsWith('This action was rejected due to unacceptable risk')) return true
  }
  return Object.values(record).some(child => hasAutomaticApprovalRejection(child, isFailure))
}

function safeApprovalToolCallId(item: Record<string, unknown>): string {
  for (const key of ['callId', 'id']) {
    const value = item[key]
    if (typeof value === 'string' && idSchema.safeParse(value).success) return value
  }
  return `rejected-call-${randomUUID()}`
}

function toolCallKey(item: Record<string, unknown>): string {
  if (typeof item.callId === 'string') return item.callId
  if (typeof item.id === 'string') return item.id
  return JSON.stringify(item.arguments ?? item.input ?? item.reviewTargets ?? item.runId ?? {})
}

function validReviewArgs(args: Record<string, unknown> | undefined, fixture: Fixture, route: Route | undefined,
  relayWorkspace: string, bindingId: string): boolean {
  if (!args || !route || args.workspace !== relayWorkspace || args.provider !== route.provider || args.model !== route.model
    || args.sessionMode !== 'fresh' || args.authorizationBasis !== 'explicit-user-request'
    || args.idempotencyKey !== idempotencyKey(bindingId, fixture.label)) return false
  if (!Array.isArray(args.reviewTargets) || !Array.isArray(args.contextReadScope)
    || !Array.isArray(args.excludedPaths) || !Array.isArray(args.writeScope)) return false
  const targets = args.reviewTargets
  const reads = args.contextReadScope
  const excluded = args.excludedPaths
  const writes = args.writeScope
  return targets.length === 1 && targets[0] === fixture.relayRelative
    && reads.length === 1 && reads[0] === fixture.relayRelative
    && excluded.length === 0 && writes.length === 0
    && typeof args.task === 'string' && !args.task.includes(fixture.token)
}

function scanToolObservations(value: unknown, state: Parameters<typeof observeCodexNotification>[1], seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) { for (const child of value) scanToolObservations(child, state, seen); return }
  const record = value as Record<string, unknown>
  const name = toolName(record)
  const args = parseObject(record.arguments ?? record.input)
  const runId = typeof args?.runId === 'string' ? args.runId : undefined
  if (['start_run', 'steer_run', 'reply_run', 'cancel_run'].includes(name)) state.forbiddenTaskCalls.add(name)
  if (runId && name === 'get_run') {
    state.getRunCalls.add(runId)
    state.getRunCallCounts.set(runId, (state.getRunCallCounts.get(runId) ?? 0) + 1)
  }
  if (runId && name === 'wait_run') state.waitRunCalls.add(runId)
  for (const child of Object.values(record)) scanToolObservations(child, state, seen)
}

function nestedItem(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) { for (const child of value) { const found = nestedItem(child); if (found) return found }; return undefined }
  const record = value as Record<string, unknown>
  if (record.item && typeof record.item === 'object' && !Array.isArray(record.item)) return record.item as Record<string, unknown>
  for (const child of Object.values(record)) { const found = nestedItem(child); if (found) return found }
  return undefined
}

function toolName(item: Record<string, unknown>): string {
  for (const key of ['tool', 'name', 'toolName']) if (typeof item[key] === 'string') return item[key] as string
  return ''
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined } catch { return undefined } }
  return undefined
}

function extractRunId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) { for (const child of value) { const id = extractRunId(child); if (id) return id }; return undefined }
  const record = value as Record<string, unknown>
  if (typeof record.runId === 'string' && idSchema.safeParse(record.runId).success) return record.runId
  if (record.structuredContent) { const id = extractRunId(record.structuredContent); if (id) return id }
  if (record.result) { const id = extractRunId(record.result); if (id) return id }
  return undefined
}

function extractWebUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) { for (const child of value) { const url = extractWebUrl(child); if (url) return url }; return null }
  const record = value as Record<string, unknown>
  if (typeof record.webUrl === 'string') {
    try { const url = new URL(record.webUrl); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null }
    catch { return null }
  }
  if (record.structuredContent) return extractWebUrl(record.structuredContent)
  if (record.result) return extractWebUrl(record.result)
  return null
}

function findStructuredResult(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) { for (const child of value) { const found = findStructuredResult(child); if (found) return found }; return undefined }
  const record = value as Record<string, unknown>
  if (record.structuredContent && typeof record.structuredContent === 'object') return record.structuredContent as Record<string, unknown>
  if (record.result) return findStructuredResult(record.result)
  return undefined
}

function isAgentMessageItem(item: Record<string, unknown>): boolean { return item.type === 'agentMessage' }

function recordAgentReply(item: Record<string, unknown>, params: unknown, state: Parameters<typeof observeCodexNotification>[1]): void {
  const turnId = findTurnId(params) ?? 'unknown-turn'
  const text = collectText(item)
  if (!text) return
  const buffer = `${state.replyBuffers.get(turnId) ?? ''}${text}`.slice(-16_384)
  state.replyBuffers.set(turnId, buffer)
  for (const [runId, expected] of state.expectations) {
    if (state.getRunCalls.has(runId) && buffer.includes(runId) && buffer.includes(expected.token)) state.matchingReplies.add(runId)
  }
}

function collectText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(collectText).join('')
  const record = value as Record<string, unknown>
  return ['text', 'delta', 'message'].map(key => typeof record[key] === 'string' ? record[key] as string : '').join('')
    + (Array.isArray(record.content) ? record.content.map(collectText).join('') : '')
}

function findTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) { for (const child of value) { const found = findTurnId(child); if (found) return found }; return undefined }
  const record = value as Record<string, unknown>
  if (typeof record.turnId === 'string') return record.turnId
  for (const child of Object.values(record)) { const found = findTurnId(child); if (found) return found }
  return undefined
}

function recordTurnStatus(message: unknown, statuses: Map<string, string>): void {
  if (!message || typeof message !== 'object') return
  const notification = message as { method?: unknown; params?: unknown }
  if (notification.method !== 'turn/completed' || !notification.params || typeof notification.params !== 'object') return
  const params = notification.params as Record<string, unknown>
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : undefined
  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
  const turnId = typeof turn?.id === 'string' ? turn.id : undefined
  const status = typeof turn?.status === 'string' ? turn.status : ''
  if (threadId && turnId && ['completed', 'failed', 'interrupted'].includes(status)) statuses.set(`${threadId}:${turnId}`, status)
}

function extractRoutes(value: unknown): Route[] {
  const routes: Route[] = []
  const seen = new WeakSet<object>()
  const visit = (node: unknown, inheritedProvider = ''): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) { for (const child of node) visit(child, inheritedProvider); return }
    const record = node as Record<string, unknown>
    const explicitProvider = ['provider', 'providerId', 'providerName'].map(key => record[key]).find(item => typeof item === 'string') as string | undefined
    const provider = explicitProvider ?? (Array.isArray(record.models)
      ? ['id', 'name'].map(key => record[key]).find(item => typeof item === 'string') as string | undefined
      : undefined) ?? inheritedProvider
    const model = ['model', 'modelId', 'modelName'].map(key => record[key]).find(item => typeof item === 'string') as string | undefined
      ?? (provider ? ['id', 'name'].map(key => record[key]).find(item => typeof item === 'string') as string | undefined : undefined)
    if (provider && model) routes.push({ provider, model })
    for (const child of Object.values(record)) visit(child, provider)
  }
  visit(value)
  return [...new Map(routes.map(route => [`${route.provider}\0${route.model}`, route])).values()]
}

function chooseRoute(routes: Route[], configuredProvider?: string, configuredModel?: string): Route | undefined {
  if (configuredProvider || configuredModel) {
    if (!configuredProvider || !configuredModel) return undefined
    return routes.find(route => route.provider === configuredProvider && route.model === configuredModel)
  }
  const preferred = [
    ['ark', 'deepseek-v4.1-flash-economy'], ['ark', 'deepseek-v4.1-flash'], ['ark', 'glm-5.3-flash'],
  ]
  for (const [provider, model] of preferred) {
    const found = routes.find(route => route.provider === provider && route.model === model)
    if (found) return found
  }
  return routes.find(route => route.provider === 'opencode-go')
}

function getStructuredContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  return (result as Record<string, unknown>).structuredContent
}

function modelIdsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return ['id', 'model', 'slug'].flatMap(key => typeof record[key] === 'string' ? [record[key] as string] : [])
}

async function atomicMetadata(path: string, value: object): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()) }
function ensureTime(deadline: number): void { if (Date.now() >= deadline) throw new Error('total test deadline expired during bootstrap') }
function configuredDelay(label: 'A' | 'B' | 'C', fallback: number): number {
  const value = process.env[`WAKE_TEST_DELAY_${label}`]
  if (value === undefined) return fallback
  if (!/^[0-9]{1,3}$/u.test(value) || Number(value) < 1 || Number(value) > 300) throw new Error(`invalid configured delay for ${label}`)
  return Number(value)
}
function safeEnum(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : null
}
function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : null
}

function safeError(error: unknown): { category: string; code?: string } {
  if (!(error instanceof Error)) return { category: 'non-error-throwable' }
  const statusFailure = /^wake-tools-status-request-failed:([a-z0-9-]+):([A-Za-z0-9_-]+)$/.exec(error.message)
  if (statusFailure) return { category: statusFailure[1]!, code: statusFailure[2]! }
  const codex = /^Codex request (history-not-materialized|unsupported|rejected); code=([A-Za-z0-9_-]+)$/.exec(error.message)
  if (codex) return { category: `codex-${codex[1]}`, code: codex[2]! }
  const code = (error as Error & { code?: unknown }).code
  if (error.name === 'AssertionError' && typeof code === 'string' && /^ERR_[A-Z0-9_]+$/.test(code)) return { category: 'assertion', code }
  const known = new Map<string, string>([
    ['no eligible advertised provider/model route', 'route-unavailable'],
    ['no advertised Codex Luna model', 'luna-model-unavailable'],
    ['test workspace must be inside relayWorkspace', 'workspace-mapping-invalid'],
    ['private wake state is not fresh', 'wake-state-not-fresh'],
    ['prior attempt marker exists', 'prior-delegation-attempt'],
    ['turn completed unsuccessfully', 'turn-failed'],
    ['turn completion notification timeout', 'turn-timeout'],
    ['wake relay tools not ready', 'wake-tools-not-ready'],
    ['start_review was rejected by automatic approval review', 'automatic-approval-rejected'],
    ['total test deadline expired during bootstrap', 'bootstrap-deadline'],
    ['strict B-first ordering condition failed after the zero-poll workflow completed', 'first-terminal-order-mismatch'],
  ])
  return { category: known.get(error.message) ?? 'unclassified-error' }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
