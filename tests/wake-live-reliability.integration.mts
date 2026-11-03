// Opt-in live Relay facts + private worker restart. Never creates or mutates a DSH run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { buildCodexEnvironment } from '../src/wake/codex-process.js'
import { readConsoleConfig } from '../src/wake/console-config.js'
import { WakeStore } from '../src/wake/store.js'

const configPath = process.env.WAKE_RELIABILITY_CONFIG
const runsPath = process.env.WAKE_RELIABILITY_RUNS
const timeoutMs = 360_000
const liveRunsSchema = z.object({ runs: z.array(z.object({
  runId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  expectedToken: z.string().min(5).max(80).regex(/^E2E-[A-Za-z0-9_-]+$/),
}).strict()).length(1) }).strict()

if (!configPath || !runsPath) {
  test.skip('live reliability replay requires explicit WAKE_RELIABILITY_CONFIG and WAKE_RELIABILITY_RUNS opt-ins', () => {})
} else test('existing completed Relay event survives paused worker SIGKILL/restart and resumes once on the same thread', {
  timeout: timeoutMs,
}, async () => {
  const sourceConfig = await readConsoleConfig(configPath)
  assert.equal(sourceConfig.codexMode, 'current-runtime', 'explicit current-runtime authentication is required')
  assert.equal(sourceConfig.relayMode, 'existing-authorized', 'an explicitly authorized existing Relay is required')
  assert.equal(sourceConfig.network, 'model-access', 'explicit model access is required for result verification')
  assert.ok(sourceConfig.relayDescriptor && sourceConfig.relayAuthorityId)

  const fixture = liveRunsSchema.parse(JSON.parse(await readFile(runsPath, 'utf8')))
  const expected = fixture.runs[0]!
  const runNonce = `${Date.now()}-${randomUUID()}`
  const control = join(sourceConfig.testRoot, `control-live-reliability-${runNonce}`)
  const codexState = join(sourceConfig.testRoot, `codex-state-live-reliability-${runNonce}`)
  await mkdir(control, { recursive: false, mode: 0o700 })
  await mkdir(codexState, { recursive: false, mode: 0o700 })
  // Use private Codex settings with no user-global MCP servers. The current-runtime
  // auth.json remains supplied by the read-only runtime overlay.
  const privateCodexConfig = join(codexState, 'config.toml')
  await writeFile(privateCodexConfig, 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\n', { mode: 0o600, flag: 'wx' })
  const wakeState = join(control, 'wake.json')
  const configFile = join(control, 'console-config.json')
  const evidenceFile = join(control, 'evidence.json')
  const configDocument = { ...sourceConfig, codexState, wakeState, bindingId: randomUUID(), enabled: false }
  await writeFile(configFile, `${JSON.stringify(configDocument, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  const config = await readConsoleConfig(configFile)
  await assertPathMissing(wakeState)

  const consolePath = fileURLToPath(new URL('../dist/dsh-relay-wake-console.mjs', import.meta.url))
  const childEnvironment = buildCodexEnvironment(config.network)
  if (process.env.HOME) childEnvironment.HOME = process.env.HOME
  let worker = await startConsole(consolePath, configFile, childEnvironment)
  let threadId = ''
  let initialTurnId = ''
  let resumedThreadId = ''
  let wakeTurnId = ''
  let eventPersistedWhilePaused = false
  let preservedWhilePausedAfterRestart = false
  let finalChecks: { getRunCount: number; waitRunCount: number; forbiddenTaskCallCount: number; replyHasRunId: boolean; replyHasExpectedToken: boolean } | null = null
  let status = 'failed'
  let failureCategory = 'setup-or-runtime-failed'
  try {
    const configMessage = await worker.waitFor('console-bound')
    threadId = readStringField(configMessage.data, 'threadId')
    const readiness = await worker.waitFor('readiness')
    assert.equal(readBooleanField(readiness.data, 'authenticated'), true, 'current-runtime authentication must be ready')
    assert.equal(readBooleanField(readiness.data, 'relayConfigured'), true, 'native Relay source must be configured')

    // Keep the queue paused before any run is watched.
    worker.write('/pause')
    await worker.waitFor('status')
    worker.write('Reply exactly READY and call no tools. For any later automatic wake, call only the native Relay get_run tool for the referenced run, inspect the result, and reply with its runId and literal E2E-* token. Never call wait_run, create/steer/reply/cancel any DSH run, or read local files.')
    const initialAdmission = await worker.waitFor('user-admission')
    initialTurnId = readStringField(initialAdmission.data, 'turnId')
    assert.equal(readStringField(initialAdmission.data, 'kind'), 'accepted')
    await worker.waitForTurnCompleted(threadId, initialTurnId)

    worker.write(`/watch ${expected.runId} reliability-${runNonce}`)
    const watch = await worker.waitFor('watch-registered')
    assert.equal(readStringField(watch.data, 'runId'), expected.runId)
    const store = new WakeStore(config.wakeState)
    const pausedEvent = await waitForState(store, state => state.events.some(event => event.runId === expected.runId && event.status === 'succeeded'))
    assert.equal(pausedEvent.enabled, false)
    assert.equal(pausedEvent.events.length, 1, 'one observed terminal event should be persisted')
    assert.equal(pausedEvent.deliveries.length, 0, 'paused queue must not admit a Codex wake turn')
    eventPersistedWhilePaused = true

    await worker.killSigkill()
    worker = await startConsole(consolePath, configFile, childEnvironment)
    const resumedBinding = await worker.waitFor('console-bound')
    resumedThreadId = readStringField(resumedBinding.data, 'threadId')
    assert.equal(resumedThreadId, threadId, 'restart must resume the bound thread, not create a replacement')
    const resumedReadiness = await worker.waitFor('readiness')
    assert.equal(readBooleanField(resumedReadiness.data, 'authenticated'), true)
    await waitForState(store, state => state.worker?.ready === true)
    await delay(1200)
    const stillPaused = await store.read()
    assert.equal(stillPaused.enabled, false, 'persistent pause must win over restart configuration')
    assert.equal(stillPaused.events.length, 1, 'restart must replay the existing event without duplicating it')
    assert.equal(stillPaused.deliveries.length, 0, 'restart while paused must not admit a wake turn')
    preservedWhilePausedAfterRestart = true

    worker.write('/resume')
    await worker.waitFor('status')
    const completed = await waitForState(store, state => state.deliveries.length === 1
      && state.deliveries[0]?.state === 'acknowledged')
    wakeTurnId = completed.deliveries[0]!.turnId ?? ''
    assert.ok(wakeTurnId)
    assert.equal(completed.deliveries[0]!.attempts, 1, 'one persisted event should produce one admission')
    assert.deepEqual(completed.deliveries[0]!.eventIds, [completed.events[0]!.eventId])

    const history = await waitForWakeHistory(config.codexState, threadId, wakeTurnId, expected)
    finalChecks = history
    assert.equal(history.getRunCount, 1, 'wake turn must call native get_run once for the completed run')
    assert.equal(history.waitRunCount, 0)
    assert.equal(history.forbiddenTaskCallCount, 0, 'the test must not create, steer, reply to, or cancel DSH runs')
    assert.equal(history.replyHasRunId, true)
    assert.equal(history.replyHasExpectedToken, true)

    const finalState = await store.read()
    const evidence = {
      schemaVersion: 1, status: 'passed', threadId, resumedThreadId, initialTurnId, wakeTurnId,
      runId: expected.runId, eventCount: finalState.events.length, deliveryCount: finalState.deliveries.length,
      eventPersistedWhilePaused, preservedWhilePausedAfterRestart,
      privateCodexConfigPreseeded: true, authSource: 'read-only-current-runtime-overlay',
      deliveryState: finalState.deliveries[0]?.state, deliveryAttempts: finalState.deliveries[0]?.attempts,
      ...finalChecks, completedAt: new Date().toISOString(),
      limitations: ['run was supplied by the controller and not created by this test', 'does not prove model-originated delegation'],
    }
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    status = 'passed'
  } catch (error) {
    failureCategory = safeFailureCategory(error)
    const evidence = {
      schemaVersion: 1, status, failureCategory, threadId: threadId || null,
      resumedThreadId: resumedThreadId || null, initialTurnId: initialTurnId || null, wakeTurnId: wakeTurnId || null,
      runId: expected.runId, eventPersistedWhilePaused, preservedWhilePausedAfterRestart, finalChecks,
      completedAt: new Date().toISOString(), rawHistoryOrAssistantTextPersisted: false,
    }
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' }).catch(() => undefined)
    throw new Error(`live reliability replay failed at ${failureCategory}; inspect private metadata only`)
  } finally {
    await worker.killGracefully()
  }
  assert.equal(status, 'passed')
})

interface ConsoleMessage { type: string; data: unknown }
class ManagedConsole {
  private readonly messages: ConsoleMessage[] = []
  private readonly stderrKinds = new Set<string>()
  private readonly lines
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', line => {
      try {
        const value = JSON.parse(line) as ConsoleMessage
        if (value && typeof value.type === 'string') this.messages.push(value)
      } catch { /* Console protocol output is JSON lines; ignore non-protocol lines without logging them. */ }
    })
  }
  write(line: string): void { this.child.stdin.write(`${line}\n`) }
  recordStderr(chunk: string): void {
    const text = chunk.toLowerCase()
    if (/bwrap/u.test(text)) this.stderrKinds.add('bwrap')
    if (/operation not permitted|eperm/u.test(text)) this.stderrKinds.add('permission')
    if (/permission denied|eacces/u.test(text)) this.stderrKinds.add('access')
    if (/no such file|enoent|not found/u.test(text)) this.stderrKinds.add('missing-path')
    if (/auth|oauth|credential|token/u.test(text)) this.stderrKinds.add('authentication')
    if (/config|toml/u.test(text)) this.stderrKinds.add('config')
    if (/mcp|plugin|server startup/u.test(text)) this.stderrKinds.add('mcp-startup')
    if (/error|fail|panic|exception|fatal/u.test(text)) this.stderrKinds.add('runtime-error')
  }
  async waitFor(type: string, timeout = 45_000): Promise<ConsoleMessage> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(message => message.type === type)
      if (index >= 0) return this.messages.splice(index, 1)[0]!
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        const queuedTypes = [...new Set(this.messages.map(message => message.type))].filter(value => /^[a-z][a-z-]{0,40}$/u.test(value)).join('_') || 'no-message'
        const processState = this.child.signalCode ? 'signal-exit' : this.child.exitCode === 0 ? 'clean-exit' : 'nonzero-exit'
        const stderrKinds = [...this.stderrKinds].sort().join('_') || 'no-stderr-kind'
        throw new Error(`private-console-exited-${queuedTypes}-${processState}-${stderrKinds}`)
      }
      await delay(50)
    }
    throw new Error(`private-console-timeout-${type}`)
  }
  async waitForTurnCompleted(threadId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(message => {
        if (message.type !== 'codex' || !message.data || typeof message.data !== 'object') return false
        const data = message.data as Record<string, unknown>
        const params = data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {}
        const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {}
        return data.method === 'turn/completed' && params.threadId === threadId && turn.id === turnId
      })
      if (index >= 0) {
        const message = this.messages.splice(index, 1)[0]!
        const data = message.data as Record<string, unknown>
        const params = data.params as Record<string, unknown>
        const turn = params.turn as Record<string, unknown>
        if (turn.status !== 'completed') throw new Error('private-codex-turn-failed')
        return
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('private-console-exited')
      await delay(50)
    }
    throw new Error('private-codex-turn-timeout')
  }
  async killSigkill(): Promise<void> {
    // Kill the private console process group so its bwrap/Codex child cannot outlive the test.
    if (this.child.exitCode === null && this.child.signalCode === null) killPrivateProcessGroup(this.child, 'SIGKILL')
    await waitForChildClose(this.child)
    this.lines.close()
  }
  async killGracefully(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.write('/quit')
      const forceKill = setTimeout(() => killPrivateProcessGroup(this.child, 'SIGKILL'), 5000)
      await waitForChildClose(this.child)
      clearTimeout(forceKill)
      if (this.child.exitCode === null && this.child.signalCode === null) killPrivateProcessGroup(this.child, 'SIGKILL')
    }
    this.lines.close()
  }
}

async function startConsole(consolePath: string, path: string, environment: NodeJS.ProcessEnv): Promise<ManagedConsole> {
  const child = spawn(process.execPath, [consolePath, path], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const managed = new ManagedConsole(child)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => managed.recordStderr(chunk))
  child.once('error', () => undefined)
  return managed
}

function killPrivateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

async function waitForChildClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => child.once('close', () => resolve()))
}

async function waitForState(store: WakeStore, predicate: (state: Awaited<ReturnType<WakeStore['read']>>) => boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await store.read()
    if (predicate(state)) return state
    await delay(100)
  }
  throw new Error('wake-state-transition-timeout')
}

async function waitForWakeHistory(codexState: string, threadId: string, turnId: string, expected: { runId: string; expectedToken: string }) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const paths = await findRollouts(join(codexState, 'sessions'), threadId)
    for (const path of paths) {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
      const records = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      const calls = records.flatMap(record => {
        const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {}
        if (record.type !== 'event_msg' || payload.type !== 'item_completed' || !payload.item || typeof payload.item !== 'object') return []
        const item = payload.item as Record<string, unknown>
        if (item.type !== 'McpToolCall' || payload.turn_id !== turnId) return []
        return [item]
      })
      const getRuns = calls.filter(item => item.tool === 'get_run' && item.arguments && typeof item.arguments === 'object'
        && (item.arguments as Record<string, unknown>).runId === expected.runId)
      const waitRuns = calls.filter(item => item.tool === 'wait_run')
      const forbidden = calls.filter(item => ['start_run', 'start_review', 'reply_run', 'steer_run', 'cancel_run'].includes(String(item.tool)))
      const completion = records.find(record => {
        const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {}
        return record.type === 'event_msg' && payload.type === 'task_complete' && payload.turn_id === turnId
      })
      const payload = completion?.payload && typeof completion.payload === 'object' ? completion.payload as Record<string, unknown> : {}
      const finalReply = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : ''
      if (completion) return {
        getRunCount: getRuns.length,
        waitRunCount: waitRuns.length,
        forbiddenTaskCallCount: forbidden.length,
        replyHasRunId: finalReply.includes(expected.runId),
        replyHasExpectedToken: finalReply.includes(expected.expectedToken),
      }
    }
    await delay(100)
  }
  throw new Error('wake-turn-history-timeout')
}

async function findRollouts(directory: string, threadId: string): Promise<string[]> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const found: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await findRollouts(path, threadId))
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) found.push(path)
  }
  return found
}

async function assertPathMissing(path: string): Promise<void> {
  try { await access(path); throw new Error('wake-state-must-be-fresh') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== 'object') throw new Error('malformed-console-metadata')
  const result = (value as Record<string, unknown>)[field]
  if (typeof result !== 'string' || !result) throw new Error('malformed-console-metadata')
  return result
}

function readBooleanField(value: unknown, field: string): boolean {
  if (!value || typeof value !== 'object') throw new Error('malformed-console-metadata')
  return (value as Record<string, unknown>)[field] === true
}

function safeFailureCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error-failure'
  if (/^private-console-timeout-[a-z-]+$/u.test(error.message)) return error.message
  if (/^private-(?:console-exited(?:[-_][a-z_-]+)*|codex-turn-failed|codex-turn-timeout|wake-state-transition-timeout|wake-turn-history-timeout|state-must-be-fresh)$/u.test(error.message)) return error.message
  return 'reliability-check-failed'
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
