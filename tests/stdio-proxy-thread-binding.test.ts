import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { WakeStore } from '../src/wake/store.js'

const threadA = '11111111-1111-4111-8111-111111111111'
const threadB = '22222222-2222-4222-8222-222222222222'

test('stdio proxy binds each wake request to the host thread metadata', async t => {
  const { directory, outbox } = await fixture(t)
  await addBinding(outbox, 'binding-a', threadA)
  await addBinding(outbox, 'binding-b', threadB)
  await outbox.store.transaction(state => {
    state.watches.push(watch('sub-a', 'binding-a'), watch('sub-b', 'binding-b'))
  })
  const { proxy, client } = await connect(t, {
    descriptorFile: join(directory, 'missing.json'), clientPrincipalId: 'owner', requestTimeoutMs: 1000,
    wakeByThread: { outbox },
  })

  const names = (await client.listTools()).tools.map(tool => tool.name)
  assert.ok(names.includes('list_watches'))
  const first = await client.callTool({ name: 'list_watches', arguments: {}, _meta: { threadId: threadA } })
  const second = await client.callTool({ name: 'list_watches', arguments: {}, _meta: { threadId: threadB } })
  assert.deepEqual((first.structuredContent as { watches: Array<{ subscriptionId: string }> }).watches.map(x => x.subscriptionId), ['sub-a'])
  assert.deepEqual((second.structuredContent as { watches: Array<{ subscriptionId: string }> }).watches.map(x => x.subscriptionId), ['sub-b'])

  const missing = await client.callTool({ name: 'list_watches', arguments: {} })
  const unknown = await client.callTool({ name: 'list_watches', arguments: {}, _meta: { threadId: '33333333-3333-4333-8333-333333333333' } })
  assert.equal(missing.isError, true)
  assert.equal(unknown.isError, true)
  assert.deepEqual((await outbox.store.read()).watches.map(x => x.subscriptionId), ['sub-a', 'sub-b'])

  const injected = await client.callTool({ name: 'watch_run', arguments: { runId: 'run', idempotencyKey: 'key', threadId: threadB }, _meta: { threadId: threadA } })
  assert.equal(injected.isError, true)
  assert.deepEqual((await outbox.store.read()).watches.map(x => x.subscriptionId), ['sub-a', 'sub-b'])
})

test('stdio proxy retains fixed wake binding compatibility and rejects mixed binding modes', async t => {
  const { directory, outbox } = await fixture(t)
  await addBinding(outbox, 'fixed', 'fixed-thread')
  await outbox.store.transaction(state => { state.watches.push(watch('sub-fixed', 'fixed')) })
  const base = { descriptorFile: join(directory, 'missing.json'), clientPrincipalId: 'owner', requestTimeoutMs: 1000 }
  assert.throws(() => new StdioProxyFacade({ ...base, wake: { outbox, bindingId: 'fixed' }, wakeByThread: { outbox } }), /ambiguous/u)
  const { client } = await connect(t, { ...base, wake: { outbox, bindingId: 'fixed' } })
  const result = await client.callTool({ name: 'list_watches', arguments: {} })
  assert.deepEqual((result.structuredContent as { watches: Array<{ subscriptionId: string }> }).watches.map(x => x.subscriptionId), ['sub-fixed'])
})

async function connect(t: TestContext, config: ConstructorParameters<typeof StdioProxyFacade>[0]) {
  const proxy = new StdioProxyFacade(config)
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'thread-binding-test', version: '1' })
  await proxy.connect(proxyTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await proxy.close() })
  return { proxy, client }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-thread-binding-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return { directory, outbox: new WakeOutbox(new WakeStore(join(directory, 'wake-state.json'))) }
}

async function addBinding(outbox: WakeOutbox, bindingId: string, threadId: string) {
  await outbox.registerBinding({ bindingId, threadId, principal: 'owner', workspace: '/tmp', serverIdentity: 'server', enabled: true, expiresAt: Date.now() + 60_000 })
}

function watch(subscriptionId: string, bindingId: string) {
  return { subscriptionId, runId: `run-${bindingId}`, sessionId: `session-${bindingId}`, bindingId,
    idempotencyKey: `key-${bindingId}`, filters: ['terminal'] as ['terminal'], active: true,
    lastSourceSeq: -1, lastStatus: '', nextEventSeq: 1, terminal: false }
}
