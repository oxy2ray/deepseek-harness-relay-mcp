// Resume one existing, authorized consumer thread. No DSH run is started or mutated.
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, constants, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConsoleConfig } from '../src/wake/console-config.js'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'
import { classifyCodexRequestRejection } from '../src/wake/codex-process.js'
import { WakeStore } from '../src/wake/store.js'
import type { WakeBinding } from '../src/wake/schema.js'

const optedInConfigPath = process.env.WAKE_LIVE_CONFIG
if (!optedInConfigPath) {
  test.skip('current-runtime resume test requires explicit WAKE_LIVE_CONFIG opt-in', () => {})
} else test('current-runtime resumes the existing consumer thread, verifies tools, then replies RESUMED without tool calls', async () => {
  const configPath = optedInConfigPath
  let evidencePath: string | undefined
  let stage = 'config'
  let failureCategory: string | null = null
  let host: OwnedCodexHost | undefined
  let fullResumeConfig: Record<string, unknown> | undefined
  let binding: WakeBinding | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let pendingApproval = false
  const accountReadRejections: Array<{ method: 'account/read'; code: number | null; category: string }> = []
  const safeRequestRejections: Array<{ method: string; code: number | null; category: string; networkFailure?: { kind: string; host: string | null } }> = []
  const safeTurnNotifications: Array<Record<string, unknown>> = []
  const safeNotificationMethods: string[] = []
  const safeStderrDiagnostics: Array<{ category: string; code: string | null; httpStatus: number | null; host: string | null }> = []
  const evidence: Record<string, unknown> = { version: 1, status: 'running', configPath, startedAt: new Date().toISOString(),
    turnId: null, toolCallCount: 0, getRunCallCount: 0, waitRunCallCount: 0, pendingApproval: false }

  try {
    const config = await readConsoleConfig(configPath)
    evidencePath = join(dirname(config.wakeState), 'resume-evidence.json')
    try { await copyFile(evidencePath, join(dirname(config.wakeState), 'resume-evidence-attempt1.json'), constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (config.codexMode !== 'current-runtime' || config.relayMode !== 'existing-authorized' || config.network !== 'model-access') {
      fail('configuration-mode-mismatch')
    }
    if (!config.relayDescriptor || !config.relayAuthorityId) fail('authorized-relay-config-missing')
    const state = await new WakeStore(config.wakeState).read()
    const storedBinding = state.bindings.find(item => item.bindingId === config.bindingId)
    if (!storedBinding) fail('binding-not-found')
    binding = storedBinding
    threadId = storedBinding.threadId
    Object.assign(evidence, { bindingId: storedBinding.bindingId, threadId, workspace: storedBinding.workspace,
      relayWorkspace: storedBinding.relayWorkspace ?? storedBinding.workspace })
    if (storedBinding.workspace !== config.workspace || (storedBinding.relayWorkspace ?? storedBinding.workspace) !== config.relayWorkspace) {
      fail('binding-workspace-mismatch')
    }

    stage = 'codex-launch'
    host = await OwnedCodexHost.launch({ testRoot: config.testRoot, stateDirectory: config.codexState,
      workspace: config.workspace, codexMode: config.codexMode, ...(config.codexExecutable ? { codexExecutable: config.codexExecutable } : {}), network: config.network })
    host.process.on('serverRequest', () => { pendingApproval = true })
    host.process.on('requestRejected', (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const rejection = value as { method?: unknown; code?: unknown; category?: unknown; networkFailure?: { kind?: unknown; host?: unknown } }
      if (typeof rejection.method !== 'string' || typeof rejection.category !== 'string') return
      const item = { method: rejection.method.slice(0, 64), code: typeof rejection.code === 'number' ? rejection.code : null,
        category: rejection.category.slice(0, 40) }
      const networkFailure = rejection.networkFailure && typeof rejection.networkFailure.kind === 'string'
        ? { kind: rejection.networkFailure.kind.slice(0, 24), host: typeof rejection.networkFailure.host === 'string' ? rejection.networkFailure.host.slice(0, 255) : null }
        : undefined
      safeRequestRejections.push({ ...item, ...(networkFailure ? { networkFailure } : {}) })
      if (rejection.method === 'account/read') accountReadRejections.push({ method: 'account/read', code: item.code, category: item.category })
    })
    host.process.on('notification', (value: unknown) => {
      const message = value as { method?: unknown; params?: Record<string, unknown> }
      if (typeof message.method === 'string' && safeNotificationMethods.length < 100) safeNotificationMethods.push(message.method.slice(0, 80))
      const params = message.params
      if (typeof message.method !== 'string' || !/turn|error/iu.test(message.method) || !params) return
      const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : null
      const statusValue = turn?.status
      const status = typeof statusValue === 'string' ? statusValue
        : statusValue && typeof statusValue === 'object' && typeof (statusValue as Record<string, unknown>).type === 'string'
          ? (statusValue as Record<string, unknown>).type as string : null
      const errorValue = turn?.error ?? params.error
      const error = errorValue && typeof errorValue === 'object' ? errorValue as Record<string, unknown> : null
      safeTurnNotifications.push({ method: message.method.slice(0, 64), threadId: typeof params.threadId === 'string' ? params.threadId : null,
        turnId: typeof turn?.id === 'string' ? turn.id : null, status: status?.slice(0, 32) ?? null,
        ...(error ? { error: { code: typeof error.code === 'number' ? error.code : null,
          httpStatus: typeof error.status === 'number' ? error.status : null,
          category: typeof error.message === 'string' ? classifyCodexRequestRejection(error.message) : 'unknown' } } : {}) })
    })
    host.process.on('stderrDiagnostic', (value: unknown) => {
      if (!value || typeof value !== 'object' || safeStderrDiagnostics.length >= 100) return
      const diagnostic = value as { category?: unknown; code?: unknown; httpStatus?: unknown; host?: unknown }
      safeStderrDiagnostics.push({ category: typeof diagnostic.category === 'string' ? diagnostic.category.slice(0, 40) : 'unknown',
        code: typeof diagnostic.code === 'string' ? diagnostic.code.slice(0, 40) : null,
        httpStatus: typeof diagnostic.httpStatus === 'number' ? diagnostic.httpStatus : null,
        host: typeof diagnostic.host === 'string' ? diagnostic.host.slice(0, 255) : null })
    })
    if (host.serverIdentity !== storedBinding.serverIdentity || host.workspace !== storedBinding.workspace) fail('binding-identity-mismatch')
    Object.assign(evidence, { serverIdentity: host.serverIdentity })

    stage = 'auth-before-resume'
    const preResumeCapabilities = await host.capabilities()
    Object.assign(evidence, { preResumeAuthenticated: preResumeCapabilities.authenticated,
      accountReadRejections: [...accountReadRejections] })
    if (!preResumeCapabilities.authenticated) fail('current-runtime-auth-unavailable-before-resume')

    stage = 'model-discovery'
    const threadResponse = await host.process.request('thread/read', { threadId }) as { thread?: {
      model?: string | null; modelProvider?: string; cwd?: string
    } }
    const persistedModel = threadResponse.thread?.model
    const modelProvider = threadResponse.thread?.modelProvider
    if (threadResponse.thread?.cwd !== config.workspace) fail('thread-workspace-mismatch')
    if (!persistedModel || !modelProvider) fail('persisted-model-unavailable')
    const catalog = await host.process.request('model/list', {}) as { data?: Array<Record<string, unknown>> }
    const models = catalog.data ?? []
    const lunaModel = models.find(model => {
      const ids = ['id', 'model', 'slug'].flatMap(key => typeof model[key] === 'string' ? [model[key] as string] : [])
      return ids.includes(persistedModel) && ids.some(value => /luna/iu.test(value))
    })
    if (!lunaModel) fail('persisted-luna-model-unavailable')
    const modelId = persistedModel
    Object.assign(evidence, { modelId, modelProvider })

    stage = 'mcp-config'
    const proxyPath = fileURLToPath(new URL('../dist/dsh-relay-wake-proxy.mjs', import.meta.url))
    const proxyConfig = { mcp_servers: { harness_relay: {
      command: process.execPath, args: [proxyPath, configPath], startup_timeout_sec: 15, required: true, disabled_tools: [],
    } } }
    fullResumeConfig = { model: modelId, model_provider: modelProvider, ...proxyConfig }
    await host.resumeThread(threadId, fullResumeConfig)
    const tools = await waitForTools(host, threadId, 31)
    if (!tools.get_run || !tools.wait_run || !tools.start_review) fail('required-native-tools-missing')
    Object.assign(evidence, { nativeToolCount: Object.keys(tools).length,
      hasGetRun: Boolean(tools.get_run), hasWatchRun: Boolean(tools.watch_run), hasStartReview: Boolean(tools.start_review) })
    stage = 'auth-recheck'
    const postResumeCapabilities = await host.capabilities()
    Object.assign(evidence, { postResumeAuthenticated: postResumeCapabilities.authenticated,
      accountReadRejections: [...accountReadRejections] })
    if (!postResumeCapabilities.authenticated) fail('current-runtime-auth-unavailable')

    stage = 'turn-start'
    if (host.process.serverRequests.size || pendingApproval) fail('pending-approval-before-turn')
    const admission = await host.sendUserMessage(threadId, 'Reply exactly RESUMED and do not call any tools')
    if (admission.kind !== 'accepted') fail('turn-not-admitted')
    turnId = admission.turnId
    evidence.turnId = turnId

    stage = 'turn-completion'
    const firstHistory = await host.process.request('thread/turns/list', { threadId, limit: 20 }) as { data?: Array<{ id: string; status: string }> }
    evidence.initialHistoryStatus = firstHistory.data?.find(turn => turn.id === turnId)?.status ?? 'not-yet-materialized'
    const deadline = Date.now() + 120_000
    let completion: 'completed' | 'failed' | 'pending' = 'pending'
    while (Date.now() < deadline) {
      if (pendingApproval || host.process.serverRequests.size) fail('pending-approval')
      const completedEvent = safeTurnNotifications.find(item => item.method === 'turn/completed' && item.threadId === threadId && item.turnId === turnId)
      if (completedEvent) {
        completion = completedEvent.status === 'completed' ? 'completed' : 'failed'
        evidence.completionNotification = { status: completedEvent.status ?? 'missing-status', error: completedEvent.error ?? null }
        break
      }
      await delay(100)
    }
    evidence.turnStatus = completion
    if (completion === 'failed') {
      const failedItems = await host.process.request('thread/items/list', { threadId, turnId, limit: 500 }).catch(() => null)
      evidence.failedTurnItems = summarizeFailedTurnItems(failedItems, turnId)
      const turns = await host.process.request('thread/turns/list', { threadId, limit: 20 }).catch(() => null)
      evidence.failedTurnSummary = summarizeTurnStatus(turns, turnId)
    }
    if (completion !== 'completed') fail(completion === 'pending' ? 'turn-completion-timeout' : 'turn-failed-notification')

    const durableCompletion = await host.completion(binding, turnId)
    evidence.durableTurnStatus = durableCompletion
    if (durableCompletion !== 'completed') fail('completed-notification-without-durable-completion')

    stage = 'turn-history'
    const page = await host.process.request('thread/items/list', { threadId, turnId, limit: 500 }) as {
      data?: Array<{ turnId: string; item: { type: string; text?: string; phase?: string | null; tool?: string } }>
    }
    const turnItems = (page.data ?? []).filter(entry => entry.turnId === turnId).map(entry => entry.item)
    const toolCalls = turnItems.filter(item => item.type === 'mcpToolCall')
    const getRunCalls = toolCalls.filter(item => item.tool === 'get_run').length
    const waitRunCalls = toolCalls.filter(item => item.tool === 'wait_run').length
    const finalMessages = turnItems.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer')
    const exactResumedReply = finalMessages.length === 1 && finalMessages[0]?.text === 'RESUMED'
    Object.assign(evidence, { turnItemCount: turnItems.length, toolCallCount: toolCalls.length,
      getRunCallCount: getRunCalls, waitRunCallCount: waitRunCalls, exactResumedReply })
    if (toolCalls.length !== 0) fail('unexpected-tool-call')
    if (!exactResumedReply) fail('assistant-reply-mismatch')
    if (pendingApproval || host.process.serverRequests.size) fail('pending-approval-after-turn')

    evidence.status = 'passed'
    evidence.completedAt = new Date().toISOString()
  } catch (error) {
    failureCategory = isSafeFailure(error) ? error.message : categoryForStage(stage)
    evidence.status = 'failed'
    evidence.stage = stage
    evidence.failureCategory = failureCategory
    evidence.pendingApproval = pendingApproval || Boolean(host?.process.serverRequests.size)
    evidence.safeRequestRejections = [...safeRequestRejections]
    evidence.safeTurnNotifications = [...safeTurnNotifications]
    evidence.safeNotificationMethods = [...safeNotificationMethods]
    evidence.safeStderrDiagnostics = [...safeStderrDiagnostics]
    evidence.completedAt = new Date().toISOString()
  } finally {
    try { await host?.close() } catch {
      evidence.hostCleanupFailed = true
      if (!failureCategory) {
        failureCategory = 'host-cleanup-failed'
        evidence.status = 'failed'
        evidence.failureCategory = failureCategory
      }
    }
    if (evidencePath) await persistEvidence(evidencePath, evidence)
  }

  assert.equal(failureCategory, null, `live resume verification failed: ${failureCategory ?? 'unknown'}`)
})

async function waitForTools(host: OwnedCodexHost, threadId: string, expectedCount: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await host.process.request('mcpServerStatus/list', { threadId, serverName: 'harness_relay' }) as {
      data?: Array<{ name?: string; tools?: Record<string, unknown> }>
    }
    const server = response.data?.find(item => item.name === 'harness_relay')
    if (server && Object.keys(server.tools ?? {}).length === expectedCount) return server.tools ?? {}
    await delay(250)
  }
  fail(expectedCount === 0 ? 'mcp-tools-not-disabled-for-turn' : 'native-tools-not-ready')
}

async function persistEvidence(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

function fail(category: string): never { throw Object.assign(new Error(category), { safeFailure: true }) }
function isSafeFailure(error: unknown): error is Error & { safeFailure: true } {
  return error instanceof Error && (error as Error & { safeFailure?: unknown }).safeFailure === true
}
function categoryForStage(stage: string): string {
  return ({ config: 'configuration-or-binding-read-failed', 'codex-launch': 'private-codex-launch-failed',
    'auth-recheck': 'current-runtime-auth-unavailable', 'auth-before-resume': 'current-runtime-auth-unavailable-before-resume',
    'model-discovery': 'current-luna-discovery-failed',
    'mcp-config': 'native-proxy-resume-failed',
    'turn-start': 'turn-start-failed', 'turn-completion': 'turn-completion-failed',
    'turn-history': 'turn-history-verification-failed' } as Record<string, string>)[stage] ?? 'unexpected-safe-failure'
}
function summarizeFailedTurnItems(value: unknown, turnId: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) return []
  return ((value as { data: Array<unknown> }).data).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as { turnId?: unknown; item?: Record<string, unknown> }
    if (item.turnId !== turnId || !item.item || typeof item.item.type !== 'string') return []
    const errorValue = item.item.error
    let error: Record<string, unknown> | undefined
    if (errorValue && typeof errorValue === 'object') {
      const candidate = errorValue as { code?: unknown; message?: unknown }
      error = { code: typeof candidate.code === 'number' ? candidate.code : null,
        category: typeof candidate.message === 'string' ? classifyCodexRequestRejection(candidate.message) : 'unknown' }
    }
    return [{ type: item.item.type.slice(0, 48), ...(typeof item.item.phase === 'string' ? { phase: item.item.phase.slice(0, 32) } : {}),
      ...(typeof item.item.status === 'string' ? { status: item.item.status.slice(0, 32) } : {}), ...(error ? { error } : {}) }]
  }).slice(0, 100)
}
function summarizeTurnStatus(value: unknown, turnId: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) return null
  const turn = (value as { data: Array<Record<string, unknown>> }).data.find(item => item.id === turnId)
  if (!turn) return null
  const errorValue = turn.error
  const error = errorValue && typeof errorValue === 'object' ? errorValue as { code?: unknown; message?: unknown } : undefined
  return { status: typeof turn.status === 'string' ? turn.status.slice(0, 32) : null,
    ...(error ? { error: { code: typeof error.code === 'number' ? error.code : null,
      category: typeof error.message === 'string' ? classifyCodexRequestRejection(error.message) : 'unknown' } } : {}) }
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
