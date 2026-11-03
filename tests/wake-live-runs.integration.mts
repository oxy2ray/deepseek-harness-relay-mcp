// Authenticated live Relay + real model consumer. Run creation is external and supplied through control/live-runs.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readConsoleConfig } from '../src/wake/console-config.js'
import { NativeRelayWakeSource } from '../src/wake/relay-client.js'
import { WakeStore } from '../src/wake/store.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { WakeRuntime } from '../src/wake/runtime.js'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'

const liveRunList = z.object({ runs: z.array(z.object({
  runId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/),
  expectedToken: z.string().min(5).max(80).regex(/^E2E-[A-Za-z0-9_-]+$/),
}).strict()).max(100) }).strict()
const CONTROL_TIMEOUT_MS = 360_000
const POLL_MS = 500

interface ExpectedRun { runId: string; expectedToken: string }
interface TurnCompletionNotice { status: string; errorCode: string | number | null }

test('managed Codex consumer wakes on controller-provided live Relay runs and verifies each result', {
  skip: !process.env.WAKE_LIVE_CONFIG,
  timeout: CONTROL_TIMEOUT_MS + 15_000,
}, async () => {
  const configPath = process.env.WAKE_LIVE_CONFIG!
  const config = await readConsoleConfig(configPath)
  const control = dirname(config.wakeState)
  const readyPath = join(control, 'consumer-ready.json')
  const progressPath = join(control, 'consumer-progress.json')
  const evidencePath = join(control, 'consumer-evidence.json')
  const runsPath = join(control, 'live-runs.json')
  let host: OwnedCodexHost | undefined
  let source: NativeRelayWakeSource | undefined
  let runtime: WakeRuntime | undefined
  const getRunCalls = new Set<string>()
  const waitRunCalls = new Set<string>()
  const replyBuffers = new Map<string, string>()
  const matchingReplies = new Set<string>()
  const expected = new Map<string, ExpectedRun>()
  const turnCompletions = new Map<string, TurnCompletionNotice>()
  let failureReason = 'setup-or-runtime-error'
  let stage = 'configuration'
  const enteredStageFlags: Record<string, true> = { configuration: true }
  const markStage = (name: string) => { stage = name; enteredStageFlags[name] = true }
  let threadId = ''
  let modelId = ''
  let initialTurnId = ''
  let initialCompletionStatus: string | null = null
  let initialCompletionErrorCode: string | number | null = null
  let advertisedLunaModelIds: string[] = []
  let advertisedModelIds: string[] = []

  try {
    if (config.codexMode !== 'current-runtime' || config.relayMode !== 'existing-authorized' || config.network !== 'model-access') {
      failureReason = 'configuration-mode-mismatch'
      throw new Error('live consumer requires current-runtime, existing-authorized, model-access configuration')
    }
    assert.ok(config.relayDescriptor && config.relayAuthorityId)
    await mkdir(control, { recursive: true, mode: 0o700 })

    markStage('codex-launch')
    host = await OwnedCodexHost.launch({ testRoot: config.testRoot, stateDirectory: config.codexState,
      workspace: config.workspace, codexMode: config.codexMode, network: config.network })
    host.process.on('notification', message => {
      observeNotification(message, expected, getRunCalls, waitRunCalls, replyBuffers, matchingReplies)
      recordTurnCompletion(message, turnCompletions)
    })
    source = await NativeRelayWakeSource.connect({ descriptorFile: config.relayDescriptor,
      clientPrincipalId: config.principal, requestTimeoutMs: 10_000, autoStart: false })

    markStage('model-catalog')
    const catalog = await host.process.request('model/list', {}) as { data?: unknown[] }
    const models = Array.isArray(catalog.data) ? catalog.data : []
    advertisedModelIds = [...new Set(models.flatMap(modelIdsOf))]
    advertisedLunaModelIds = advertisedModelIds.filter(id => /luna/i.test(id))
    modelId = advertisedLunaModelIds.includes('gpt-6-luna') ? 'gpt-6-luna' : advertisedLunaModelIds[0] ?? ''
    if (!modelId) { failureReason = 'luna-model-unavailable'; throw new Error('no advertised Luna model is available') }

    markStage('thread-start')
    const proxyPath = fileURLToPath(new URL('../dist/dsh-relay-wake-proxy.mjs', import.meta.url))
    threadId = await host.startThread({ model: modelId, mcp_servers: { harness_relay: {
      command: process.execPath, args: [proxyPath, configPath], startup_timeout_sec: 15, required: true,
    } } })
    markStage('mcp-readiness')
    await waitForWakeTools(host, threadId)
    markStage('initial-ready-turn')
    const initial = await host.sendUserMessage(threadId,
      'Reply exactly READY and do not call any tools in this turn. For each later automatic wake event, call the native Relay get_run tool for every referenced runId, inspect its returned result, then reply with that runId and any literal E2E-* token found in that result. Do not call wait_run or other tools. Do not read local files, modify files, or start any task.')
    if (initial.kind !== 'accepted') throw new Error('initial model turn was not admitted')
    initialTurnId = initial.turnId
    const binding = { bindingId: config.bindingId, threadId, principal: config.principal, workspace: config.workspace,
      relayWorkspace: config.relayWorkspace, serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 8 * 60 * 60_000 }
    markStage('initial-turn-completion')
    const initialDeadline = Date.now() + 60_000
    while (Date.now() < initialDeadline) {
      const notice = turnCompletions.get(`${threadId}:${initialTurnId}`)
      if (notice) {
        initialCompletionStatus = notice.status
        initialCompletionErrorCode = notice.errorCode
        if (notice.status === 'completed') break
        if (notice.status === 'failed' || notice.status === 'interrupted') {
          failureReason = 'initial-turn-failed'
          throw new Error('initial model turn reported an unsuccessful completion status')
        }
      }
      await delay(100)
    }
    if (initialCompletionStatus !== 'completed') {
      failureReason = 'initial-turn-completion-timeout'
      throw new Error('initial model turn completion notification timed out')
    }
    // Only hydrate durable thread history after the matching successful completion event.
    markStage('initial-history-verification')
    let resumed = false
    const historyDeadline = Date.now() + 60_000
    while (!resumed && Date.now() < historyDeadline) {
      try {
        await host.resumeThread(threadId)
        resumed = true
      } catch (error) {
        if (!isHistoryNotMaterializedError(error)) throw error
        await delay(100)
      }
    }
    if (!resumed) { failureReason = 'initial-history-timeout'; throw new Error('completed initial turn history did not materialize') }
    const persistedCompletion = await host.completion(binding, initialTurnId)
    if (persistedCompletion !== 'completed') { failureReason = 'initial-history-verification-failed'; throw new Error('completed turn was not verified in durable history') }
    if (getRunCalls.size || waitRunCalls.size) throw new Error('initial READY turn unexpectedly called Relay tools')
    if ([...replyBuffers.values()].join('').trim() !== 'READY') throw new Error('initial model turn did not reply exactly READY')
    await host.resumeThread(threadId) // establish durable resume/history capability before readiness

    markStage('binding-worker-readiness')
    const store = new WakeStore(config.wakeState)
    const outbox = new WakeOutbox(store)
    await outbox.registerBinding(binding)
    await outbox.setEnabled(true)
    runtime = new WakeRuntime(outbox, source, host)
    await runtime.start()
    const firstTick = await runtime.tick()
    if (!firstTick.ready) throw new Error('wake consumer prerequisites are not ready')

    await atomicMetadata(readyPath, { version: 1, status: 'ready', threadId, bindingId: config.bindingId,
      modelId, relayAuthorityId: config.relayAuthorityId, startedAt: new Date().toISOString() })

    markStage('waiting-for-controller-runs')
    const deadline = Date.now() + CONTROL_TIMEOUT_MS
    const registered = new Set<string>()
    let lastControllerSnapshot = ''
    let lastProgressSnapshot = ''
    let stableSince = Date.now()
    while (Date.now() < deadline) {
      const controllerList = await readLiveRuns(runsPath)
      const controllerSnapshot = JSON.stringify(controllerList.runs)
      if (controllerSnapshot !== lastControllerSnapshot) { lastControllerSnapshot = controllerSnapshot; stableSince = Date.now() }
      for (const item of controllerList.runs) {
        const old = expected.get(item.runId)
        if (old && old.expectedToken !== item.expectedToken) throw new Error('controller changed an expected token')
        expected.set(item.runId, item)
        for (const reply of replyBuffers.values()) {
          if (getRunCalls.has(item.runId) && reply.includes(item.runId) && reply.includes(item.expectedToken)) matchingReplies.add(item.runId)
        }
        if (registered.has(item.runId)) continue
        const run = await source.getRun(item.runId, config.principal)
        const subscriptionId = await outbox.watch({ run, bindingId: binding.bindingId, principal: binding.principal,
          idempotencyKey: `live-${createHash('sha256').update(item.runId).digest('hex').slice(0, 32)}` })
        registered.add(item.runId)
        void subscriptionId // Keep no run content or result payload in test evidence.
      }
      await runtime.tick()
      const state = await store.read()
      const allEventsAcknowledged = state.events.length > 0 && state.events.every(event =>
        state.deliveries.some(delivery => delivery.state === 'acknowledged' && delivery.eventIds.includes(event.eventId)))
      const acknowledgedEventCount = state.events.filter(event =>
        state.deliveries.some(delivery => delivery.state === 'acknowledged' && delivery.eventIds.includes(event.eventId))).length
      const progress = { version: 1, status: 'running', stage, threadId, bindingId: binding.bindingId,
        controllerRunCount: controllerList.runs.length, registeredRunCount: registered.size,
        getRunCallCount: getRunCalls.size, waitRunCallCount: waitRunCalls.size, matchingReplyCount: matchingReplies.size,
        eventCount: state.events.length, acknowledgedEventCount }
      const progressSnapshot = JSON.stringify(progress)
      if (progressSnapshot !== lastProgressSnapshot) {
        await atomicMetadata(progressPath, { ...progress, updatedAt: new Date().toISOString() })
        lastProgressSnapshot = progressSnapshot
      }
      const allRunsVerified = controllerList.runs.length > 0 && controllerList.runs.every(item =>
        registered.has(item.runId) && getRunCalls.has(item.runId) && matchingReplies.has(item.runId))
      if (controllerList.runs.length >= 3 && allEventsAcknowledged && allRunsVerified
        && waitRunCalls.size === 0 && Date.now() - stableSince >= 5_000) {
        markStage('evidence-success')
        await atomicMetadata(evidencePath, { version: 1, status: 'success', stage, enteredStageFlags, threadId, bindingId: binding.bindingId,
          modelId, advertisedModelIds, advertisedLunaModelIds, runIds: controllerList.runs.map(item => item.runId), eventCount: state.events.length,
          initialCompletionStatus,
          allEventsAcknowledged, getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls],
          matchingReplyRunIds: [...matchingReplies], completedAt: new Date().toISOString() })
        return
      }
      await delay(POLL_MS)
    }

    failureReason = 'deadline'
    markStage('deadline')
    await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: 'deadline', stage, enteredStageFlags, threadId,
      bindingId: config.bindingId, modelId, advertisedModelIds, advertisedLunaModelIds, registeredRunIds: [...registered], getRunRunIds: [...getRunCalls],
      waitRunRunIds: [...waitRunCalls], matchingReplyRunIds: [...matchingReplies], initialCompletionStatus,
      initialCompletionErrorCode, deadlineMs: CONTROL_TIMEOUT_MS })
    assert.fail('live wake verification deadline expired')
  } catch (error) {
    await atomicMetadata(evidencePath, { version: 1, status: 'failure', reason: failureReason, stage, enteredStageFlags,
      threadId: threadId || null, modelId: modelId || null, advertisedModelIds, advertisedLunaModelIds,
      initialTurnAdmitted: Boolean(initialTurnId),
      initialCompletionStatus, initialCompletionErrorCode,
      getRunRunIds: [...getRunCalls], waitRunRunIds: [...waitRunCalls], matchingReplyRunIds: [...matchingReplies],
      error: safeErrorMetadata(error) }).catch(() => undefined)
    throw new Error('live wake consumer failed; inspect only the private metadata evidence file')
  } finally {
    try { await runtime?.close() } catch { /* evidence reports the run outcome, never process details */ }
    try { await source?.close() } catch { /* ignore private teardown details */ }
    try { await host?.close() } catch { /* ignore private teardown details */ }
  }
})

function modelIdsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const model = value as Record<string, unknown>
  return ['id', 'model', 'slug'].flatMap(key => typeof model[key] === 'string' ? [model[key] as string] : [])
}

function recordTurnCompletion(value: unknown, records: Map<string, TurnCompletionNotice>): void {
  if (!value || typeof value !== 'object') return
  const notification = value as { method?: unknown; params?: unknown }
  if (notification.method !== 'turn/completed' || !notification.params || typeof notification.params !== 'object') return
  const params = notification.params as Record<string, unknown>
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : undefined
  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
  const turnId = typeof turn?.id === 'string' ? turn.id : undefined
  if (!threadId || !turnId) return
  const rawStatus = typeof turn?.status === 'string' ? turn.status : typeof params.status === 'string' ? params.status : ''
  const status = ['completed', 'failed', 'interrupted', 'inProgress'].includes(rawStatus) ? rawStatus : 'unknown'
  const rawCode = turn?.error && typeof turn.error === 'object' ? (turn.error as Record<string, unknown>).code : undefined
  const errorCode = typeof rawCode === 'number' && Number.isFinite(rawCode) ? rawCode
    : typeof rawCode === 'string' && /^[A-Za-z0-9_-]+$/.test(rawCode) ? rawCode : null
  records.set(`${threadId}:${turnId}`, { status, errorCode })
}

function isHistoryNotMaterializedError(error: unknown): boolean {
  return error instanceof Error && /^Codex request history-not-materialized; code=[A-Za-z0-9_-]+$/.test(error.message)
}

function safeErrorMetadata(error: unknown): { category: string; code?: string } {
  if (!(error instanceof Error)) return { category: 'non-error-throwable' }
  const codex = /^Codex request (history-not-materialized|unsupported|rejected); code=([A-Za-z0-9_-]+)$/.exec(error.message)
  if (codex) return { category: `codex-${codex[1]}`, code: codex[2]! }
  const code = (error as Error & { code?: unknown }).code
  if (error.name === 'AssertionError' && typeof code === 'string' && /^ERR_[A-Z0-9_]+$/.test(code)) {
    return { category: 'assertion', code }
  }
  const known: Record<string, string> = {
    'initial model turn was not admitted': 'initial-turn-not-admitted',
    'initial model turn did not complete successfully': 'initial-turn-failed',
    'initial model turn timed out': 'initial-turn-timeout',
    'initial READY turn unexpectedly called Relay tools': 'initial-turn-called-tools',
    'initial model turn did not reply exactly READY': 'initial-ready-mismatch',
    'wake consumer prerequisites are not ready': 'wake-prerequisites-not-ready',
    'wake proxy tools did not become ready': 'wake-proxy-not-ready',
    'no advertised Luna model is available': 'luna-model-unavailable',
    'live consumer requires current-runtime, existing-authorized, model-access configuration': 'configuration-mode-mismatch',
    'controller changed an expected token': 'controller-token-changed',
  }
  return { category: known[error.message] ?? 'unclassified-error' }
}

async function waitForWakeTools(host: OwnedCodexHost, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await host.process.request('mcpServerStatus/list', { threadId, serverName: 'harness_relay' }) as {
      data?: Array<{ name?: string; tools?: Record<string, unknown> }>
    }
    const tools = result.data?.find(server => server.name === 'harness_relay')?.tools ?? {}
    if (tools.get_run && tools.watch_run && tools.start_run) return
    await delay(250)
  }
  throw new Error('wake proxy tools did not become ready')
}

export function observeNotification(message: unknown, expected: Map<string, ExpectedRun>, getRunCalls: Set<string>,
  waitRunCalls: Set<string>, replyBuffers: Map<string, string>, matchingReplies: Set<string>): void {
  if (!message || typeof message !== 'object') return
  const notification = message as { method?: unknown; params?: unknown }
  const method = typeof notification.method === 'string' ? notification.method : ''
  const params = notification.params
  scanToolCalls(params, getRunCalls, waitRunCalls)
  if (!isAgentMessageNotification(method, params)) return
  const turnId = extractTurnId(params) ?? 'unknown-turn'
  const delta = collectAgentText(params)
  if (!delta) return
  const buffer = method.toLowerCase().includes('/delta')
    ? `${replyBuffers.get(turnId) ?? ''}${delta}`.slice(-8192)
    : delta.slice(-8192)
  replyBuffers.set(turnId, buffer)
  for (const [runId, item] of expected) {
    if (getRunCalls.has(runId) && buffer.includes(runId) && buffer.includes(item.expectedToken)) matchingReplies.add(runId)
  }
}

function scanToolCalls(value: unknown, getRunCalls: Set<string>, waitRunCalls: Set<string>, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) { for (const child of value) scanToolCalls(child, getRunCalls, waitRunCalls, seen); return }
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name
    : typeof record.toolName === 'string' ? record.toolName : typeof record.tool === 'string' ? record.tool : ''
  const args = parseArguments(record.arguments ?? record.input)
  const runId = typeof args?.runId === 'string' ? args.runId : undefined
  if (runId && name === 'get_run') getRunCalls.add(runId)
  if (runId && name === 'wait_run') waitRunCalls.add(runId)
  for (const child of Object.values(record)) scanToolCalls(child, getRunCalls, waitRunCalls, seen)
}

function isAgentMessageNotification(method: string, params: unknown): boolean {
  if (method.toLowerCase().includes('agentmessage')) return true
  if (method !== 'item/completed' || !params || typeof params !== 'object') return false
  const item = (params as Record<string, unknown>).item
  return Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).type === 'agentMessage')
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined }
    catch { return undefined }
  }
  return undefined
}

function extractTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) { for (const child of value) { const found = extractTurnId(child); if (found) return found }; return undefined }
  const record = value as Record<string, unknown>
  if (typeof record.turnId === 'string') return record.turnId
  if (record.turn && typeof record.turn === 'object' && typeof (record.turn as Record<string, unknown>).id === 'string') return (record.turn as Record<string, unknown>).id as string
  for (const child of Object.values(record)) { const found = extractTurnId(child); if (found) return found }
  return undefined
}

function collectAgentText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(collectAgentText).join('')
  const record = value as Record<string, unknown>
  return ['text', 'delta', 'message'].map(key => typeof record[key] === 'string' ? record[key] as string : '').join('')
    + (Array.isArray(record.content) ? record.content.map(collectAgentText).join('') : '')
    + (record.item && typeof record.item === 'object' ? collectAgentText(record.item) : '')
}

async function readLiveRuns(path: string): Promise<z.infer<typeof liveRunList>> {
  try { return liveRunList.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [] }
    throw error
  }
}

async function atomicMetadata(path: string, value: object): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
