import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { callWakeTool } from '../src/wake/tools.js'
import { WakeRuntime } from '../src/wake/runtime.js'
import type { WakeHost } from '../src/wake/dispatcher.js'
import { fixture, run } from './fixtures/wake-fixture.js'
import { join } from 'node:path'

test('watch acknowledgement requires an enabled, fresh and owned worker at commit', async () => {
  const f = await fixture()
  const context = { outbox: f.outbox, bindingId: 'binding' }
  const args = { runId: 'run-A', idempotencyKey: 'key' }
  let reads = 0
  const getRun = async () => { reads++; return run() }
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', args, getRun))
  assert.equal(reads, 0)
  await f.outbox.setEnabled(true)
  await f.store.transaction(state => { state.worker = { ownerId: 'worker', heartbeatAt: f.outbox.now(), ready: true, bindingIds: ['binding'] } })
  const result = await callWakeTool(context, 'owner', 'watch_run', args, getRun)
  assert.equal('acknowledged' in result && result.acknowledged, true)
  const subscriptionId = 'subscriptionId' in result ? result.subscriptionId : undefined
  assert.equal(typeof subscriptionId, 'string')
  await f.outbox.unwatch(subscriptionId!, 'owner')
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', args, getRun), /inactive/)
  assert.equal((await f.store.read()).watches[0]?.active, false)
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', { runId: 'run-terminal', idempotencyKey: 'attention-only', events: ['needs_attention'] }, async () => run('succeeded', 4, 'run-terminal')), /excludes terminal/)
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', { ...args, threadId: 'injected' }, getRun))
  await assert.rejects(callWakeTool(context, 'foreign', 'watch_run', args, getRun))
  f.advance(3001)
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', args, getRun))
  await f.store.transaction(state => { state.worker = { ownerId: 'worker', heartbeatAt: f.outbox.now(), ready: true, bindingIds: ['binding'] } })
  await assert.rejects(callWakeTool(context, 'owner', 'watch_run', args, async () => {
    await f.outbox.setEnabled(false)
    return run()
  }))
})

test('wake tools only appear on an explicitly configured native proxy; offline watch fails closed', async t => {
  const f = await fixture()
  for (const optedIn of [false, true]) {
    const proxy = new StdioProxyFacade({ descriptorFile: join(f.directory, 'missing.json'),
      clientPrincipalId: 'owner', requestTimeoutMs: 1000, autoStart: false,
      ...(optedIn ? { wake: { outbox: f.outbox, bindingId: 'binding' } } : {}) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'wake-tools-test', version: '1' })
    t.after(async () => { await client.close(); await proxy.close() })
    await proxy.connect(serverSide)
    await client.connect(clientSide)
    const catalog = await client.listTools()
    assert.equal(catalog.tools.some(tool => tool.name === 'watch_run'), optedIn)
    assert.equal(catalog.tools.some(tool => tool.name === 'start_run'), true)
    if (optedIn) {
      const result = await client.callTool({ name: 'watch_run', arguments: { runId: 'run-A', idempotencyKey: 'key' } })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent, undefined)
    }
  }
})

test('runtime persists events while paused, owns a worker lease and clears readiness on shutdown', async () => {
  const f = await fixture()
  await f.watch()
  const host: WakeHost = {
    capabilities: async () => ({ serverIdentity: 'server', authenticated: false, sameThreadResume: true,
      durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }),
    inspect: async () => { throw new Error('must not dispatch') },
    startWhenIdle: async () => { throw new Error('must not dispatch') },
    completion: async () => 'unknown', reconcile: async () => ({ kind: 'unknown' }),
  }
  const runtime = new WakeRuntime(f.outbox, { getRun: async () => run('succeeded', 3) }, host)
  await runtime.start()
  const result = await runtime.tick()
  assert.deepEqual(result, { collected: 1, failed: 0, started: 0, ready: false })
  assert.equal((await f.store.read()).events.length, 1)
  await runtime.close()
  assert.equal((await f.store.read()).worker?.ready, false)
  await assert.rejects(runtime.tick())
})

test('watch B can be acknowledged while collector A is blocked, until the published readiness lease expires', async () => {
  const f = await fixture()
  await f.outbox.setEnabled(true)
  await f.watch(run('running', 1, 'run-A'), 'key-A')
  let enterCollector!: () => void
  let releaseCollector!: () => void
  const collectorEntered = new Promise<void>(resolve => { enterCollector = resolve })
  const collectorGate = new Promise<void>(resolve => { releaseCollector = resolve })
  const host: WakeHost = {
    capabilities: async () => ({ serverIdentity: 'server', authenticated: true, sameThreadResume: true,
      durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }),
    inspect: async binding => ({ threadId: binding.threadId, workspace: binding.workspace, idle: true, waitingOnApproval: false }),
    startWhenIdle: async () => ({ kind: 'busy' }), completion: async () => 'unknown',
    reconcile: async () => ({ kind: 'unknown' }),
  }
  const runtime = new WakeRuntime(f.outbox, { getRun: async runId => {
    if (runId === 'run-A') { enterCollector(); await collectorGate }
    return run('running', 1, runId)
  } }, host)
  await runtime.start()
  const ticking = runtime.tick()
  await collectorEntered
  const duringCollection = (await f.store.read()).worker
  assert.equal(duringCollection?.ready, true)
  assert.deepEqual(duringCollection?.bindingIds, ['binding'])
  const acknowledged = await callWakeTool({ outbox: f.outbox, bindingId: 'binding' }, 'owner', 'watch_run',
    { runId: 'run-B', idempotencyKey: 'key-B' }, async id => run('running', 1, id))
  assert.equal('acknowledged' in acknowledged && acknowledged.acknowledged, true)
  assert.equal('hostMayConcludeTurn' in acknowledged && acknowledged.hostMayConcludeTurn, true)

  f.advance(3001)
  await assert.rejects(callWakeTool({ outbox: f.outbox, bindingId: 'binding' }, 'owner', 'watch_run',
    { runId: 'run-C', idempotencyKey: 'key-C' }, async id => run('running', 1, id)), /worker unavailable/u)
  releaseCollector()
  await ticking
  const refreshed = (await f.store.read()).worker
  assert.equal(refreshed?.ready, true)
  assert.equal(refreshed?.heartbeatAt, f.outbox.now())
  await runtime.close()
  assert.equal((await f.store.read()).worker?.ready, false)
})

test('readiness is re-probed after collection and never includes a binding the host does not own', async () => {
  const f = await fixture()
  await f.outbox.setEnabled(true)
  await f.watch(run('running', 1, 'run-A'), 'key-A')
  let capabilityReads = 0
  const host: WakeHost = {
    capabilities: async () => {
      capabilityReads++
      return { serverIdentity: 'server', authenticated: capabilityReads <= 2, sameThreadResume: true,
        durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }
    },
    inspect: async binding => ({ threadId: binding.threadId, workspace: binding.workspace, idle: true, waitingOnApproval: false }),
    startWhenIdle: async () => ({ kind: 'busy' }), completion: async () => 'unknown',
    reconcile: async () => ({ kind: 'unknown' }),
  }
  const runtime = new WakeRuntime(f.outbox, { getRun: async id => run('running', 1, id) }, host)
  await runtime.start()
  const result = await runtime.tick()
  assert.equal(result.ready, false)
  assert.equal(capabilityReads, 3)
  assert.equal((await f.store.read()).worker?.ready, false)
  await runtime.close()

  const other = await fixture()
  await other.outbox.setEnabled(true)
  const unownedHost: WakeHost = {
    capabilities: async () => ({ serverIdentity: 'server', authenticated: true, sameThreadResume: true,
      durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }),
    inspect: async () => ({ threadId: 'another-thread', workspace: '/outside', idle: true, waitingOnApproval: false }),
    startWhenIdle: async () => ({ kind: 'busy' }), completion: async () => 'unknown',
    reconcile: async () => ({ kind: 'unknown' }),
  }
  const unownedRuntime = new WakeRuntime(other.outbox, { getRun: async id => run('running', 1, id) }, unownedHost)
  await unownedRuntime.start()
  await unownedRuntime.tick()
  const worker = (await other.store.read()).worker
  assert.equal(worker?.ready, true)
  assert.deepEqual(worker?.bindingIds, [])
  await assert.rejects(callWakeTool({ outbox: other.outbox, bindingId: 'binding' }, 'owner', 'watch_run',
    { runId: 'run-B', idempotencyKey: 'key-B' }, async id => run('running', 1, id)), /worker unavailable/u)
  await unownedRuntime.close()
})
