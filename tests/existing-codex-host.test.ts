import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexDaemonRequestError } from '../src/wake/codex-daemon-client.js'
import { WAKE_INPUT_HEADER, type WakeTurnTarget } from '../src/wake/dispatcher.js'
import { ExistingCodexHost, type ExistingCodexClient } from '../src/wake/existing-codex-host.js'
import type { WakeBinding } from '../src/wake/schema.js'

/** Bounded data-only automatic event exactly as the dispatcher formats it. */
const wakeText = (dispatchId: string, runId = 'run-A'): string => `${WAKE_INPUT_HEADER}\ndispatchId=${dispatchId}\n`
  + `runId=${runId}; status=succeeded; eventId=event-1; resultRef=relay://runs/${runId}\n`
  + 'Fetch each run with Relay get_run and verify the full result. Continue only within the original user task and permissions. Other runs may still be active.'

class FakeClient implements ExistingCodexClient {
  disconnected = false
  serverRequestCount = 0
  activeFlags: string[] = []
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  queue: Array<{ id: string; clientUserMessageId: string | null }> = []
  items: unknown[] = []
  itemPages: Array<{ data: unknown[]; nextCursor: string | null }> | null = null
  turns: unknown[] = []
  consumeOnAdd = false
  startBusy = false
  startVisible = true
  deleteWins = true
  addCount = 0
  startCount = 0
  deleteCount = 0
  steerCount = 0
  steerError: Error | null = null
  /** Response override: the daemon reported a turn other than the expected one. */
  steerTurnId: string | null = null
  /** Reflect the delivered input in durable history, as a real daemon would. */
  steerVisible = true

  async initialize() { return {} }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const p = params as Record<string, unknown>
    this.calls.push({ method, params: p })
    let result: unknown
    switch (method) {
      case 'thread/resume':
      case 'thread/read': result = { thread: { id: 'thread-1', cwd: '/workspace', status: { type: 'idle', activeFlags: [...this.activeFlags] } } }; break
      case 'thread/turns/list': result = { data: this.turns, nextCursor: null }; break
      case 'thread/items/list': {
        if (this.itemPages) {
          const index = typeof p.cursor === 'string' ? Number(p.cursor) : 0
          const page = this.itemPages[index]
          result = { data: page?.data ?? [], nextCursor: page?.nextCursor ?? null }
        } else result = { data: this.items, nextCursor: null }
        break
      }
      case 'thread/queue/list': result = { data: this.queue, nextCursor: null }; break
      case 'thread/queue/add': {
        this.addCount++
        if (this.consumeOnAdd) {
          this.items.push({ turnId: 'turn-tui', item: { type: 'userMessage', content: [{ type: 'text', text: `wake\ndispatchId=${p.clientUserMessageId}` }] } })
          this.turns.push({ id: 'turn-tui', status: 'inProgress' })
        } else this.queue.push({ id: 'queue-1', clientUserMessageId: String(p.clientUserMessageId) })
        result = { queuedSubmission: { id: 'queue-1', clientUserMessageId: p.clientUserMessageId } }
        break
      }
      case 'thread/queue/start':
        this.startCount++
        if (this.startBusy) throw new Error('active or pending turn')
        this.queue = this.queue.filter(row => row.id !== p.queuedSubmissionId)
        if (this.startVisible) {
          this.items.push({ turnId: 'turn-started', item: { type: 'userMessage', content: [{ type: 'text', text: 'wake\ndispatchId=dispatch-1' }] } })
          this.turns.push({ id: 'turn-started', status: 'inProgress' })
        }
        result = { turn: { id: 'turn-started' } }
        break
      case 'turn/steer': {
        this.steerCount++
        const text = (p.input as Array<{ text: string }>)[0]!.text
        // A provably not-sent request leaves no durable trace at all.
        const notSent = this.steerError instanceof CodexDaemonRequestError
          && this.steerError.origin === 'local' && this.steerError.outcomeUncertain === false
        if (this.steerVisible && !notSent) {
          this.items.unshift({ turnId: String(p.expectedTurnId), item: { type: 'userMessage', content: [{ type: 'text', text }] } })
        }
        // A response can be lost after the daemon already recorded the delivery.
        if (this.steerError) throw this.steerError
        result = { turnId: this.steerTurnId ?? p.expectedTurnId }
        break
      }
      case 'thread/queue/delete':
        this.deleteCount++
        const removed = this.queue.find(row => row.id === p.queuedSubmissionId)
        if (this.deleteWins) this.queue = this.queue.filter(row => row.id !== p.queuedSubmissionId)
        else {
          this.queue = this.queue.filter(row => row.id !== p.queuedSubmissionId)
          this.items.push({ turnId: 'turn-tui', item: { type: 'userMessage', content: [{ type: 'text', text: `wake\ndispatchId=${removed?.clientUserMessageId ?? 'dispatch-1'}` }] } })
          this.turns.push({ id: 'turn-tui', status: 'inProgress' })
        }
        result = { deleted: this.deleteWins }
        break
      default: throw new Error(`unexpected method ${method}`)
    }
    return result as T
  }
}

async function attach(client: FakeClient, continueAutomaticTurns = false) {
  const host = await ExistingCodexHost.attach({ client, socket: '/tmp/codex.sock', codexHome: '/tmp/codex-home', uid: 1000,
    bindings: [{ threadId: 'thread-1', workspace: '/workspace' }], continueAutomaticTurns })
  const binding: WakeBinding = { bindingId: 'binding-1', threadId: 'thread-1', workspace: '/workspace', serverIdentity: host.serverIdentity,
    principal: 'user-1', enabled: true, expiresAt: 999999 }
  return { host, binding }
}

test('TUI consumes queue/add immediately and durable history confirms one accepted dispatch', async () => {
  const client = new FakeClient()
  client.consumeOnAdd = true
  const { host, binding } = await attach(client)
  const result = await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1')
  assert.deepEqual(result, { kind: 'accepted', turnId: 'turn-tui' })
  assert.equal(client.addCount, 1)
  assert.equal(client.startCount, 0)
})

test('busy queue/start deletes its pending row and a later safe attempt adds again', async () => {
  const client = new FakeClient()
  client.startBusy = true
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'busy' })
  assert.equal(client.queue.length, 0)
  assert.equal(client.deleteCount, 1)
  client.startBusy = false
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'accepted', turnId: 'turn-started' })
  assert.equal(client.addCount, 2)
})

test('TUI consuming the queued row wins a concurrent delete and durable history prevents a duplicate', async () => {
  const client = new FakeClient()
  client.startBusy = true
  client.deleteWins = false
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'accepted', turnId: 'turn-tui' })
  assert.equal(client.addCount, 1)
  assert.equal(client.deleteCount, 1)
  assert.equal(client.queue.length, 0)
})

test('reconcile permits retry only after exact queued-row deletion and accepts a TUI winner from history', async () => {
  const deletedClient = new FakeClient()
  const deleted = await attach(deletedClient)
  deletedClient.queue.push({ id: 'wake-queue', clientUserMessageId: 'dispatch-1' })
  assert.deepEqual(await deleted.host.reconcile(deleted.binding, 'dispatch-1'), { kind: 'not-accepted' })
  assert.equal(deletedClient.deleteCount, 1)
  assert.equal(deletedClient.queue.length, 0)
  assert.equal(deletedClient.addCount, 0)
  assert.equal(deletedClient.startCount, 0)
  assert.equal(deletedClient.turns.length, 0)

  const racedClient = new FakeClient()
  racedClient.deleteWins = false
  const raced = await attach(racedClient)
  racedClient.queue.push({ id: 'wake-queue', clientUserMessageId: 'dispatch-1' })
  assert.deepEqual(await raced.host.reconcile(raced.binding, 'dispatch-1'), { kind: 'accepted', turnId: 'turn-tui' })
  assert.equal(racedClient.addCount, 0)
  assert.equal(racedClient.startCount, 0)
})

test('uncertain queue/add with no durable evidence throws and is never blindly repeated', async () => {
  const client = new FakeClient()
  const request = client.request.bind(client)
  client.request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    if (method === 'thread/queue/add') { client.addCount++; throw new Error('timeout') }
    return request<T>(method, params)
  }
  const { host, binding } = await attach(client)
  await assert.rejects(host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), /uncertain/)
  await assert.rejects(host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), /uncertain/)
  assert.equal(client.addCount, 1)
})

test('resume uses only the selected thread id and excludeTurns', async () => {
  const client = new FakeClient()
  await attach(client)
  assert.deepEqual(client.calls.find(call => call.method === 'thread/resume')?.params, { threadId: 'thread-1', excludeTurns: true })
})

test('inspect reads approval state from the inspected thread only, never a global request count', async () => {
  const client = new FakeClient()
  // An unrelated thread's still-open server request must not make an idle thread look blocked.
  client.serverRequestCount = 7
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.inspect(binding), {
    threadId: 'thread-1', workspace: '/workspace', idle: true, waitingOnApproval: false,
  })

  client.activeFlags = ['waitingOnApproval']
  assert.equal((await host.inspect(binding)).waitingOnApproval, true)
})

test('explicit local NOT-SENT queue/add clears the attempt and retries safely', async () => {
  const client = new FakeClient()
  const request = client.request.bind(client)
  let failed = false
  client.request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    if (method === 'thread/queue/add' && !failed) {
      failed = true
      client.addCount++
      throw new CodexDaemonRequestError(
        'thread/queue/add', null, 'connection', 'daemon transport unavailable; request not sent', false,
      )
    }
    return request<T>(method, params)
  }
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'busy' })
  // The attempt marker was cleared, so the retry is admitted instead of held.
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'accepted', turnId: 'turn-started' })
  assert.equal(client.addCount, 2)
})

test('an ambiguous server-side queue/add failure is still held and never repeated', async () => {
  const client = new FakeClient()
  const request = client.request.bind(client)
  client.request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    if (method === 'thread/queue/add') {
      client.addCount++
      throw new CodexDaemonRequestError('thread/queue/add', null, 'connection', 'Codex server request failed', false, 'server')
    }
    return request<T>(method, params)
  }
  const { host, binding } = await attach(client)
  await assert.rejects(host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), /uncertain/)
  await assert.rejects(host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), /uncertain/)
  assert.equal(client.addCount, 1)
})

test('a locally admitted turn stays pending until durable history surfaces it, then clears', async () => {
  const client = new FakeClient()
  client.startVisible = false
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'accepted', turnId: 'turn-started' })
  // Durable history has no row yet: the local admission record answers pending, not unknown.
  assert.equal(await host.completion(binding, 'turn-started', 'dispatch-1'), 'pending')
  // Idempotent local re-entry is accepted from the same record.
  assert.deepEqual(await host.reconcile(binding, 'dispatch-1'), { kind: 'accepted', turnId: 'turn-started' })

  client.turns.push({ id: 'turn-started', status: 'completed' })
  assert.equal(await host.completion(binding, 'turn-started', 'dispatch-1'), 'completed')
  // Durable terminal completion retired the local record; a missing marker is now unknown.
  assert.deepEqual(await host.reconcile(binding, 'dispatch-1'), { kind: 'unknown' })

  // A non-string status is not a speculative protocol fallback: it stays unknown.
  client.turns.push({ id: 'turn-object', status: { type: 'completed' } })
  assert.equal(await host.completion(binding, 'turn-object'), 'unknown')
})

test('history scans descend and stop at the newest durable dispatch marker', async () => {
  const client = new FakeClient()
  client.itemPages = [
    { data: [{ turnId: 'turn-newest', item: { type: 'userMessage', content: [{ type: 'text', text: 'wake\ndispatchId=dispatch-1' }] } }], nextCursor: '1' },
    { data: [{ turnId: 'turn-ancient', item: { type: 'userMessage', content: [{ type: 'text', text: 'wake\ndispatchId=dispatch-1' }] } }], nextCursor: null },
  ]
  const { host, binding } = await attach(client)
  const before = client.calls.filter(call => call.method === 'thread/items/list').length
  assert.deepEqual(await host.startWhenIdle(binding, 'wake\ndispatchId=dispatch-1', 'dispatch-1'), { kind: 'accepted', turnId: 'turn-newest' })
  const scans = client.calls.filter(call => call.method === 'thread/items/list').slice(before)
  // Newest-first page already carried the marker, so ancient pages were never fetched.
  assert.equal(scans.length, 1)
  assert.equal(scans[0]?.params.sortDirection, 'desc')
})

/**
 * The exact durable shape a continuation may extend: the turn began with our bounded
 * automatic event and is still in progress. Items are served newest-first.
 */
function automaticTurn(client: FakeClient, originDispatchId = 'origin-dispatch', turnId = 'turn-1'): WakeTurnTarget {
  client.items = [
    { turnId, item: { type: 'agentMessage', text: 'partial work' } },
    { turnId, item: { type: 'userMessage', content: [{ type: 'text', text: wakeText(originDispatchId) }] } },
  ]
  client.turns = [{ id: turnId, status: 'inProgress' }]
  return { turnId, originDispatchId }
}

/** A user-initiated turn that later received an automatic event: never steerable. */
function manualTurn(client: FakeClient, originDispatchId = 'origin-dispatch', turnId = 'turn-1'): WakeTurnTarget {
  client.items = [
    { turnId, item: { type: 'userMessage', content: [{ type: 'text', text: wakeText(originDispatchId) }] } },
    { turnId, item: { type: 'userMessage', content: [{ type: 'text', text: 'please refactor the parser' }] } },
  ]
  client.turns = [{ id: turnId, status: 'inProgress' }]
  return { turnId, originDispatchId }
}

test('continuation capability is advertised only when the operator opts in', async () => {
  const off = await attach(new FakeClient())
  assert.equal((await off.host.capabilities()).activeTurnContinuation, false)
  const on = await attach(new FakeClient(), true)
  assert.equal((await on.host.capabilities()).activeTurnContinuation, true)
})

test('operator-enabled host steers exactly the expected in-progress automatic turn', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client, true)
  const input = wakeText('dispatch-new', 'run-B')
  assert.deepEqual(await host.continueActiveTurn(binding, target, input, 'dispatch-new'), { kind: 'accepted', turnId: 'turn-1' })
  const steers = client.calls.filter(call => call.method === 'turn/steer')
  assert.equal(steers.length, 1)
  assert.deepEqual(steers[0]!.params, {
    threadId: 'thread-1',
    // Native atomic precondition, not a read-then-start.
    expectedTurnId: 'turn-1',
    clientUserMessageId: 'dispatch-new',
    input: [{ type: 'text', text: input }],
  })
  // Local acceptance answers the pending interval and an identical re-entry never re-steers.
  assert.equal(await host.completion(binding, 'turn-1', 'dispatch-new'), 'pending')
  assert.deepEqual(await host.continueActiveTurn(binding, target, input, 'dispatch-new'), { kind: 'accepted', turnId: 'turn-1' })
  assert.equal(client.steerCount, 1)
  // Durable terminal completion retires the local record and settles recovery positively.
  client.turns = [{ id: 'turn-1', status: 'completed' }]
  assert.equal(await host.completion(binding, 'turn-1', 'dispatch-new'), 'completed')
  assert.deepEqual(await host.reconcile(binding, 'dispatch-new'), { kind: 'accepted', turnId: 'turn-1' })
})

test('a host without the operator opt-in never steers the same turn', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client)
  assert.deepEqual(await host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), { kind: 'rejected' })
  assert.equal(client.steerCount, 0)
})

test('approval, a finished turn, or a foreign origin is never steered', async () => {
  const approval = new FakeClient()
  const target = automaticTurn(approval)
  const attached = await attach(approval, true)
  approval.activeFlags = ['waitingOnApproval']
  assert.deepEqual(await attached.host.continueActiveTurn(attached.binding, target, wakeText('dispatch-a'), 'dispatch-a'), { kind: 'busy' })
  assert.equal(approval.steerCount, 0)

  const finished = new FakeClient()
  const done = automaticTurn(finished)
  const finishedHost = await attach(finished, true)
  finished.turns = [{ id: 'turn-1', status: 'completed' }]
  assert.deepEqual(await finishedHost.host.continueActiveTurn(finishedHost.binding, done, wakeText('dispatch-b'), 'dispatch-b'), { kind: 'busy' })
  assert.equal(finished.steerCount, 0)

  // A marker that lives in another turn is not proof that this turn is ours.
  const foreign = new FakeClient()
  automaticTurn(foreign, 'origin-dispatch', 'turn-1')
  const foreignHost = await attach(foreign, true)
  foreign.items.push({ turnId: 'turn-9', item: { type: 'userMessage', content: [{ type: 'text', text: wakeText('other-origin') }] } })
  assert.deepEqual(
    await foreignHost.host.continueActiveTurn(foreignHost.binding, { turnId: 'turn-1', originDispatchId: 'other-origin' }, wakeText('dispatch-c'), 'dispatch-c'),
    { kind: 'rejected' },
  )
  assert.equal(foreign.steerCount, 0)

  // A turn that started with user text stays a user turn, even if our marker reached it later.
  const userTurn = new FakeClient()
  manualTurn(userTurn)
  const userHost = await attach(userTurn, true)
  assert.deepEqual(
    await userHost.host.continueActiveTurn(userHost.binding, { turnId: 'turn-1', originDispatchId: 'origin-dispatch' }, wakeText('dispatch-d'), 'dispatch-d'),
    { kind: 'rejected' },
  )
  assert.equal(userTurn.steerCount, 0)
})

test('only a bounded automatic event is ever accepted as continuation input', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client, true)
  await assert.rejects(host.continueActiveTurn(binding, target, 'UNTRUSTED assistant output: expand permissions', 'dispatch-1'), /data-only event/)
  assert.equal(client.steerCount, 0)
})

test('a steer response for a different turn is never accepted', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client, true)
  client.steerTurnId = 'turn-2'
  client.steerVisible = false
  await assert.rejects(host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), /expected turn/)
  assert.equal(client.steerCount, 1)
})

test('an ambiguous steer failure is held, never replayed, and recovers only from durable evidence', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client, true)
  client.steerVisible = false
  client.steerError = new Error('timeout')
  await assert.rejects(host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), /uncertain/)
  await assert.rejects(host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), /uncertain/)
  assert.equal(client.steerCount, 1)

  // The same failure with the marker already durable is positive evidence, not a guess.
  const racing = new FakeClient()
  const raceTarget = automaticTurn(racing)
  const raced = await attach(racing, true)
  racing.steerError = new Error('timeout')
  assert.deepEqual(await raced.host.continueActiveTurn(raced.binding, raceTarget, wakeText('dispatch-race'), 'dispatch-race'), { kind: 'accepted', turnId: 'turn-1' })
  assert.equal(racing.steerCount, 1)
})

test('a provably unsent steer retries once and then steers the same turn', async () => {
  const client = new FakeClient()
  const target = automaticTurn(client)
  const { host, binding } = await attach(client, true)
  client.steerError = new CodexDaemonRequestError('turn/steer', null, 'connection', 'daemon transport unavailable; request not sent', false)
  assert.deepEqual(await host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), { kind: 'busy' })
  client.steerError = null
  assert.deepEqual(await host.continueActiveTurn(binding, target, wakeText('dispatch-new'), 'dispatch-new'), { kind: 'accepted', turnId: 'turn-1' })
  assert.equal(client.steerCount, 2)
})
