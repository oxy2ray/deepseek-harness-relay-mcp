import test from 'node:test'
import assert from 'node:assert/strict'
import { ExistingCodexHost, type ExistingCodexClient } from '../src/wake/existing-codex-host.js'
import type { WakeBinding } from '../src/wake/schema.js'

class FakeClient implements ExistingCodexClient {
  disconnected = false
  serverRequestCount = 0
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  queue: Array<{ id: string; clientUserMessageId: string | null }> = []
  items: unknown[] = []
  turns: unknown[] = []
  consumeOnAdd = false
  startBusy = false
  deleteWins = true
  addCount = 0
  startCount = 0
  deleteCount = 0

  async initialize() { return {} }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const p = params as Record<string, unknown>
    this.calls.push({ method, params: p })
    let result: unknown
    switch (method) {
      case 'thread/resume':
      case 'thread/read': result = { thread: { id: 'thread-1', cwd: '/workspace', status: { type: 'idle', activeFlags: [] } } }; break
      case 'thread/turns/list': result = { data: this.turns, nextCursor: null }; break
      case 'thread/items/list': result = { data: this.items, nextCursor: null }; break
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
        this.items.push({ turnId: 'turn-started', item: { type: 'userMessage', content: [{ type: 'text', text: 'wake\ndispatchId=dispatch-1' }] } })
        this.turns.push({ id: 'turn-started', status: 'inProgress' })
        result = { turn: { id: 'turn-started' } }
        break
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

async function attach(client: FakeClient) {
  const host = await ExistingCodexHost.attach({ client, socket: '/tmp/codex.sock', codexHome: '/tmp/codex-home', uid: 1000,
    bindings: [{ threadId: 'thread-1', workspace: '/workspace' }] })
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
