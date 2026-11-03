// Read-only acceptance audit for an already completed live wake/delegation run.
// Opt in with WAKE_HISTORY_CONFIG and WAKE_HISTORY_CONTROL. This test never
// connects to Relay or starts a worker; it only audits durable local artifacts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { open, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { readConsoleConfig } from '../src/wake/console-config.js'
import { WakeStore } from '../src/wake/store.js'

const runLabels = ['A', 'B', 'C'] as const
type Label = typeof runLabels[number]
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/
const expectedRunIds: Record<Label, string> = {
  A: 'e835f73d-0c95-4aed-ae89-c2f836e0b668',
  B: '9c36be2e-9dc4-464f-85c1-85b8b17f4c81',
  C: 'd62b034c-43f3-49e6-8cf3-dc98c2f7133c',
}

test('read-only live history proves A/B/C delegation, wake acknowledgement, and same-thread replies', {
  skip: !process.env.WAKE_HISTORY_CONFIG || !process.env.WAKE_HISTORY_CONTROL,
}, async () => {
  const config = await readConsoleConfig(process.env.WAKE_HISTORY_CONFIG!)
  const control = resolve(process.env.WAKE_HISTORY_CONTROL!)
  assert.equal(control, process.env.WAKE_HISTORY_CONTROL, 'control directory must be normalized')
  assert.ok(isWithin(config.testRoot, control), 'control directory must remain inside the dedicated test root')
  assert.equal(resolve(config.wakeState), join(control, 'wake.json'), 'wake state must belong to the selected control directory')

  const [ready, started, runManifest, progress, wake] = await Promise.all([
    readJson(join(control, 'delegation-ready.json')),
    readJson(join(control, 'delegation-started.json')),
    readJson(join(control, 'delegation-runs.json')),
    readJson(join(control, 'delegation-progress.json')),
    new WakeStore(config.wakeState).read(),
  ])
  const threadId = string(ready.threadId)
  const bindingId = string(ready.bindingId)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.fixtureCount, 3)
  assert.equal(started.status, 'delegation-started')
  assert.equal(started.threadId, threadId)
  assert.equal(started.bindingId, bindingId)
  assert.equal(progress.threadId, threadId)
  assert.equal(progress.status, 'running', 'the controller remained active while terminal results were consumed')
  assert.equal(progress.delegationCompletedAt !== null, true)
  assert.equal(progress.startReviewCalls, 3)
  assert.equal(progress.startedRunCount, 3)
  assert.equal(progress.completedStartReviewCount, 3)
  assert.equal(progress.invalidStartReviewCount, 0)
  assert.equal(progress.forbiddenTaskCallCount, 0)
  assert.equal(progress.getRunCallCount, 3)
  assert.equal(progress.waitRunCallCount, 0)
  assert.equal(progress.eventCount, 3)
  assert.equal(progress.acknowledgedEventRunCount, 3)
  assert.equal(progress.matchingReplyCount, 3)
  assert.equal(progress.firstTerminalLabel, 'B')
  assert.equal(progress.firstTerminalRunId, expectedRunIds.B)
  assert.equal(progress.firstTerminalOthersNonterminal, true)
  assert.deepEqual(new Set(array(progress.runningAfterDelegationRunIds).map(string)), new Set(Object.values(expectedRunIds)))

  const manifestRuns = array(runManifest.runs)
  assert.equal(manifestRuns.length, 3)
  const runRows = new Map<Label, Record<string, unknown>>()
  for (const item of manifestRuns) {
    const row = object(item)
    const label = string(row.label) as Label
    assert.ok(runLabels.includes(label))
    assert.equal(row.runId, expectedRunIds[label])
    assert.equal(runRows.has(label), false)
    runRows.set(label, row)
  }
  assert.deepEqual([...runRows.keys()].sort(), [...runLabels].sort())

  const idempotencyKeys = array(started.idempotencyKeys).map(string)
  assert.equal(idempotencyKeys.length, 3)
  assert.equal(new Set(idempotencyKeys).size, 3)
  for (const key of idempotencyKeys) assert.match(key, idPattern)

  const binding = wake.bindings.find(value => value.bindingId === bindingId)
  assert.ok(binding)
  assert.equal(binding.threadId, threadId)
  assert.equal(binding.enabled, true)
  const watches = wake.watches.filter(value => value.bindingId === bindingId)
  const events = wake.events.filter(value => value.bindingId === bindingId)
  const deliveries = wake.deliveries.filter(value => value.bindingId === bindingId)
  assert.equal(watches.length, 3)
  assert.equal(events.length, 3)
  assert.equal(deliveries.length, 3)

  const watchByRun = new Map(watches.map(watch => [watch.runId, watch]))
  const eventByRun = new Map(events.map(event => [event.runId, event]))
  const deliveryByRun = new Map<string, typeof deliveries[number]>()
  for (const delivery of deliveries) {
    assert.equal(delivery.threadId, threadId)
    assert.equal(delivery.state, 'acknowledged')
    assert.equal(delivery.attempts, 1)
    assert.equal(delivery.eventIds.length, 1)
    const event = events.find(candidate => candidate.eventId === delivery.eventIds[0])
    assert.ok(event)
    assert.equal(deliveryByRun.has(event.runId), false)
    deliveryByRun.set(event.runId, delivery)
  }
  for (const label of runLabels) {
    const runId = expectedRunIds[label]
    const watch = watchByRun.get(runId)
    const event = eventByRun.get(runId)
    const delivery = deliveryByRun.get(runId)
    assert.ok(watch && event && delivery)
    assert.equal(watch.idempotencyKey, idempotencyKeys[runLabels.indexOf(label)])
    assert.equal(watch.active, true)
    assert.equal(watch.terminal, true)
    assert.equal(event.status, 'succeeded')
    assert.equal(event.kind, 'terminal')
    assert.equal(delivery.eventIds[0], event.eventId)
  }
  assert.equal([...events].sort((left, right) => left.occurredAt - right.occurredAt)[0]?.runId, expectedRunIds.B)

  const markerByLabel = new Map<Label, string>()
  for (const label of runLabels) {
    const fixturePath = join(config.workspace, '.wake-live-delegation', bindingId, `${label}.md`)
    const fixture = await readFile(fixturePath, 'utf8')
    const markers = [...fixture.matchAll(/Marker:\s*(E2E-DELEGATION-[ABC]-[a-f0-9-]{36})/g)].map(match => match[1]!)
    assert.equal(markers.length, 1)
    markerByLabel.set(label, markers[0]!)
  }

  const rolloutPath = await findSessionRollout(config.codexState, threadId)
  const rollout = await readRollout(rolloutPath)
  assert.equal(rollout.sessionId, threadId)
  const calls = rollout.calls.filter(call => call.server === 'harness_relay')
  const startCalls = calls.filter(call => call.tool === 'start_review')
  const watchCalls = calls.filter(call => call.tool === 'watch_run')
  const getCalls = calls.filter(call => call.tool === 'get_run')
  assert.equal(startCalls.length, 3)
  assert.equal(watchCalls.length, 3)
  assert.equal(getCalls.length, 3)
  assert.equal(calls.filter(call => call.tool === 'wait_run').length, 0)
  assert.equal(calls.some(call => ['start_run', 'reply_run', 'cancel_run', 'steer_run'].includes(call.tool)), false)
  assert.ok(startCalls.every(call => call.turnId === rollout.delegationTurnId))
  assert.ok(watchCalls.every(call => call.turnId === rollout.delegationTurnId))

  const callRunIds = new Map<Label, string>()
  for (const label of runLabels) {
    const fixtureRelative = `.wake-live-delegation/${bindingId}/${label}.md`
    const start = startCalls.filter(call => call.args.idempotencyKey === idempotencyKeys[runLabels.indexOf(label)])
    assert.equal(start.length, 1)
    const startCall = start[0]!
    const startResult = startCall.result
    const startArgs = startCall.args
    const startReviewTargets = array(startArgs.reviewTargets)
    assert.deepEqual(startReviewTargets, [fixtureRelative])
    assert.deepEqual(array(startArgs.contextReadScope), [fixtureRelative])
    assert.deepEqual(array(startArgs.writeScope), [])
    assert.equal(startResult.status, 'completed')
    assert.equal(startResult.structured.status, 'running')
    assert.equal(startResult.structured.runId, expectedRunIds[label])
    assert.equal(startResult.structured.idempotencyKey, idempotencyKeys[runLabels.indexOf(label)])
    assert.deepEqual(startResult.structured.modelSelection, ready.route)
    callRunIds.set(label, string(startResult.structured.runId))

    const watch = watchCalls.filter(call => call.args.runId === expectedRunIds[label])
    assert.equal(watch.length, 1)
    assert.equal(watch[0]!.args.idempotencyKey, idempotencyKeys[runLabels.indexOf(label)])
    assert.match(string(watch[0]!.args.idempotencyKey), idPattern)
    assert.equal(watch[0]!.result.status, 'completed')
    assert.equal(watch[0]!.result.structured.acknowledged, true)
    assert.equal(watch[0]!.result.structured.hostMayConcludeTurn, true)
    assert.equal(watch[0]!.result.structured.runId, expectedRunIds[label])

    const getRun = getCalls.filter(call => call.args.runId === expectedRunIds[label])
    assert.equal(getRun.length, 1)
    assert.ok(typeof deliveryByRun.get(expectedRunIds[label])?.turnId === 'string')
    assert.equal(getRun[0]!.turnId, deliveryByRun.get(expectedRunIds[label])!.turnId)
    assert.equal(getRun[0]!.result.status, 'completed')
    assert.equal(getRun[0]!.result.structured.runId, expectedRunIds[label])
    assert.equal(getRun[0]!.result.structured.status, 'succeeded')
    assert.equal(string(getRun[0]!.result.structured.assistantText).includes(markerByLabel.get(label)!), true)
    assert.equal(runRows.get(label)?.runId, getRun[0]!.result.structured.runId)
  }

  const delegationTurn = rollout.userTurns.find(turn => turn.turnId === rollout.delegationTurnId)
  assert.ok(delegationTurn)
  const delegationCompletion = rollout.completions.find(completion => completion.turnId === rollout.delegationTurnId)
  assert.ok(delegationCompletion)
  const wakeDispatchIds = new Set([...deliveryByRun.values()].map(delivery => delivery.dispatchId))
  const wakeTurns = rollout.userTurns.filter(turn => [...wakeDispatchIds].some(dispatchId => turn.text.includes(dispatchId)))
  assert.equal(wakeTurns.length, 3)
  assert.equal(new Set(wakeTurns.map(turn => turn.turnId)).size, 3)
  assert.ok(delegationCompletion.timestampMs !== undefined, 'delegation completion must have a parseable record timestamp')
  for (const dispatchId of wakeDispatchIds) {
    assert.equal(rollout.userTurns.reduce((count, turn) => count + occurrences(turn.text, dispatchId), 0), 1)
  }
  assert.equal(delegationCompletion.rowIndex < Math.min(...wakeTurns.map(turn => turn.rowIndex)), true)
  const completionByTurn = new Map(rollout.completions.map(completion => [completion.turnId, completion]))
  for (const label of runLabels) {
    const runId = expectedRunIds[label]
    const delivery = deliveryByRun.get(runId)!
    assert.ok(typeof delivery.turnId === 'string')
    const turnId = delivery.turnId
    const wakeTurn = wakeTurns.filter(turn => turn.turnId === turnId)
    assert.equal(wakeTurn.length, 1)
    assert.equal(occurrences(wakeTurn[0]!.text, delivery.dispatchId), 1)
    assert.ok(delegationCompletion.rowIndex < wakeTurn[0]!.rowIndex)
    assert.ok(wakeTurn[0]!.timestampMs !== undefined, 'wake user item must have a parseable record timestamp')
    assert.ok(delegationCompletion.timestampMs < wakeTurn[0]!.timestampMs)
    const finalReply = completionByTurn.get(turnId)
    assert.ok(finalReply)
    assert.ok(wakeTurn[0]!.rowIndex < finalReply.rowIndex)
    assert.equal(finalReply.message.includes(runId), true)
    assert.equal(finalReply.message.includes(markerByLabel.get(label)!), true)
    const getRunForTurn = getCalls.filter(call => call.turnId === turnId && call.args.runId === runId)
    assert.equal(getRunForTurn.length, 1)
    assert.ok(getRunForTurn[0]!.rowIndex < finalReply.rowIndex)
  }

  const evidence = {
    version: 2,
    status: 'accepted',
    audit: 'read-only-local-artifacts',
    runLabels: [...runLabels],
    nativeToolCounts: { start_review: 3, watch_run: 3, get_run: 3, wait_run: 0, forbiddenTaskCalls: 0 },
    acknowledgedEvents: 3,
    deliveryAttempts: [1, 1, 1],
    sameCodexThread: true,
    nativeAckCallsInDelegationTurn: true,
    getRunCallsInMatchingWakeTurns: true,
    uniqueDispatchMarkerPerWakeInput: true,
    eachWakeCompletedAfterMatchingGetRun: true,
    delegationCompletedBeforeEveryWakeInput: true,
    orderingProof: 'JSONL row sequence; exact record timestamps also checked where present',
    firstTerminalLabel: 'B',
    codexModelId: string(ready.codexModelId),
    route: object(ready.route),
    controllerObserverNote: 'Controller watch count remained zero because its prefix-based observer did not count the valid native watch keys; native acknowledgements were independently verified from rollout results.'
  }
  await writeEvidence(join(control, 'history-acceptance-v2.json'), evidence)
})

interface NativeCall {
  rowIndex: number
  turnId: string
  timestampMs: number | undefined
  server: string
  tool: string
  args: Record<string, unknown>
  result: { status: string; structured: Record<string, unknown> }
}
interface UserTurn { rowIndex: number; turnId: string; timestampMs: number | undefined; text: string }
interface Completion { rowIndex: number; turnId: string; timestampMs: number | undefined; message: string }
interface Rollout {
  sessionId: string
  delegationTurnId: string
  calls: NativeCall[]
  userTurns: UserTurn[]
  completions: Completion[]
}

async function readRollout(path: string): Promise<Rollout> {
  const content = await readFile(path, 'utf8')
  assert.ok(Buffer.byteLength(content) <= 32 * 1024 * 1024, 'rollout file exceeded audit bound')
  const rows = content.split('\n').filter(Boolean).map(line => object(JSON.parse(line)))
  const session = rows.find(row => row.type === 'session_meta')
  assert.ok(session)
  const sessionId = string(object(session.payload).id)
  const calls: NativeCall[] = []
  const userTurns: UserTurn[] = []
  const completions: Completion[] = []
  let delegationTurnId = ''
  for (const [rowIndex, row] of rows.entries()) {
    const payload = objectOrUndefined(row.payload)
    if (!payload) continue
    const item = objectOrUndefined(payload.item)
    if (payload.type === 'item_completed' && item?.type === 'McpToolCall') {
      const rawResult = objectOrUndefined(item.result)
      const structured = objectOrUndefined(rawResult?.structuredContent) ?? parseStructuredText(rawResult?.content)
      if (!rawResult || !structured) continue
      calls.push({ rowIndex, turnId: stringOrEmpty(payload.turn_id), timestampMs: timestampMillis(row.timestamp),
        server: stringOrEmpty(item.server), tool: stringOrEmpty(item.tool),
        args: objectOrUndefined(item.arguments) ?? {},
        result: { status: stringOrEmpty(item.status), structured } })
    }
    if (payload.type === 'item_completed' && item?.type === 'UserMessage') {
      const turnId = stringOrEmpty(payload.turn_id)
      const text = contentText(item.content)
      userTurns.push({ rowIndex, turnId, timestampMs: timestampMillis(row.timestamp), text })
      if (text.includes('start_review') && text.includes('watch_run')) delegationTurnId = turnId
    }
    if (payload.type === 'task_complete') {
      const turnId = stringOrEmpty(payload.turn_id)
      const message = stringOrEmpty(payload.last_agent_message)
      completions.push({ rowIndex, turnId, timestampMs: timestampMillis(row.timestamp), message })
    }
  }
  assert.ok(delegationTurnId && completions.some(completion => completion.turnId === delegationTurnId), 'rollout lacked required delegation turn boundaries')
  return { sessionId, delegationTurnId, calls, userTurns, completions }
}

async function findSessionRollout(stateDirectory: string, threadId: string): Promise<string> {
  const root = join(stateDirectory, 'sessions')
  const candidates = await listFiles(root)
  for (const path of candidates.filter(path => path.endsWith('.jsonl') && path.includes(threadId))) {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]
      if (!firstLine) continue
      const row = object(JSON.parse(firstLine))
      if (row.type === 'session_meta' && object(row.payload).id === threadId) return path
    } finally { await file.close() }
  }
  throw new Error('matching session rollout was not found')
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function parseStructuredText(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const row = objectOrUndefined(block)
    if (typeof row?.text === 'string') {
      try { return object(JSON.parse(row.text)) } catch { /* non-JSON fallback block */ }
    }
  }
  return undefined
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    const row = objectOrUndefined(block)
    return typeof row?.text === 'string' ? [row.text] : []
  }).join('\n')
}

async function writeEvidence(path: string, evidence: Record<string, unknown>): Promise<void> {
  const text = `${JSON.stringify(evidence, null, 2)}\n`
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readJson(path)
    assert.deepEqual(existing, evidence, 'existing acceptance evidence did not match this audit')
  } finally { await handle?.close() }
}

async function readJson(path: string): Promise<Record<string, unknown>> { return object(JSON.parse(await readFile(path, 'utf8'))) }
function object(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object artifact')
  return value as Record<string, any>
}
function objectOrUndefined(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}
function array(value: unknown): unknown[] { assert.ok(Array.isArray(value), 'expected array artifact'); return value }
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string }
function stringOrEmpty(value: unknown): string { return typeof value === 'string' ? value : '' }
function timestampMillis(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
function occurrences(text: string, target: string): number {
  if (!target) return 0
  return text.split(target).length - 1
}
function isWithin(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep)
}
