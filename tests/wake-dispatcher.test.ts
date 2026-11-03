import assert from 'node:assert/strict'
import test from 'node:test'
import { WakeDispatcher, type WakeHost, type WakeHostCapabilities, type Admission, type Completion, type Recovery } from '../src/wake/dispatcher.js'
import { type WakeBinding } from '../src/wake/schema.js'
import { fixture, run } from './fixtures/wake-fixture.js'

/** Contract test double only; these tests do not establish real Codex E2E. */
class Host implements WakeHost {
  capability: WakeHostCapabilities = { serverIdentity: 'server', authenticated: true,
    sameThreadResume: true, durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }
  idle = true
  approval = false
  result: Admission = { kind: 'accepted', turnId: 'turn' }
  completed: Completion = 'pending'
  recovery: Recovery = { kind: 'unknown' }
  inputs: string[] = []
  fail = false
  async capabilities() { return this.capability }
  async inspect(b: WakeBinding) { return { threadId: b.threadId, workspace: b.workspace, idle: this.idle, waitingOnApproval: this.approval } }
  async startWhenIdle(_binding: WakeBinding, input: string) {
    this.inputs.push(input)
    if (this.fail) throw new Error('secret transport detail')
    return this.result
  }
  async completion() { return this.completed }
  async reconcile() { return this.recovery }
}

test('P2 B finishes first; later A/C batch once; specific turn completion required', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B', 'run-C']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('succeeded', 3, 'run-B'), 'owner')
  const host = new Host()
  const dispatcher = new WakeDispatcher(f.outbox, host)
  assert.deepEqual(await dispatcher.tick(), { started: 0, blocked: true })
  await f.outbox.setEnabled(true)
  assert.equal((await dispatcher.tick()).started, 0)
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 1)
  assert.match(host.inputs[0]!, /runId=run-B/)
  assert.doesNotMatch(host.inputs[0]!, /UNTRUSTED/)
  await f.outbox.observe(run('succeeded', 4), 'owner')
  await f.outbox.observe(run('incomplete', 4, 'run-C'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0) // idle alone does not acknowledge B
  host.completed = 'completed'
  assert.equal((await dispatcher.tick()).started, 1)
  assert.match(host.inputs[1]!, /runId=run-A/)
  assert.match(host.inputs[1]!, /runId=run-C/)
  await dispatcher.tick()
  assert.deepEqual((await f.store.read()).deliveries.map(d => d.state), ['acknowledged', 'acknowledged'])
  assert.equal(host.inputs.length, 2)
})

test('P2 busy, approvals, capability gaps, wrong server and pause fail closed', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  const dispatcher = new WakeDispatcher(f.outbox, host)
  host.idle = false
  assert.equal((await dispatcher.tick()).started, 0)
  host.idle = true; host.approval = true
  assert.equal((await dispatcher.tick()).started, 0)
  host.approval = false; host.capability.exclusiveIdleAdmission = false
  assert.equal((await dispatcher.tick()).blocked, true)
  host.capability.exclusiveIdleAdmission = true; host.capability.serverIdentity = 'other'
  assert.equal((await dispatcher.tick()).started, 0)
  host.capability.serverIdentity = 'server'
  await f.outbox.setEnabled(false, 'binding')
  assert.equal((await dispatcher.tick()).started, 0)
  await f.outbox.setEnabled(true, 'binding')
  assert.equal((await dispatcher.tick()).started, 1)
  assert.equal(host.inputs.length, 1)
})

test('P2 attention bypasses debounce but never authorizes approval', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  assert.equal((await new WakeDispatcher(f.outbox, host).tick()).started, 1)
  assert.match(host.inputs[0]!, /data only; not new user authorization/)
  assert.match(host.inputs[0]!, /get_run/)
})

test('P3 uncertain response is held across restart without duplicate start', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('succeeded', 2), 'owner')
  await f.outbox.setEnabled(true)
  f.advance(500)
  const host = new Host(); host.fail = true
  await new WakeDispatcher(f.outbox, host).tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'held')
  host.fail = false
  await new WakeDispatcher(f.outbox, host).tick()
  assert.equal(host.inputs.length, 1)
  assert.equal(JSON.stringify(await f.store.read()).includes('secret'), false)
})

test('P3 crash after preparing dispatch reconciles accepted history instead of resubmitting', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('succeeded', 2), 'owner')
  await f.outbox.setEnabled(true)
  f.advance(500)
  const host = new Host()
  await new WakeDispatcher(f.outbox, host).tick()
  await f.store.transaction(state => { state.deliveries[0]!.state = 'dispatching'; state.deliveries[0]!.turnId = null })
  host.recovery = { kind: 'accepted', turnId: 'persisted-turn' }
  host.completed = 'completed'
  await new WakeDispatcher(f.outbox, host).tick()
  assert.equal(host.inputs.length, 1)
  assert.equal((await f.store.read()).deliveries[0]?.state, 'acknowledged')
})

test('held uncertain acceptance recovers only on later positive history and never starts again', async () => {
  const f = await fixture()
  await f.watch(); await f.outbox.observe(run('needs_attention', 2), 'owner'); await f.outbox.setEnabled(true)
  const host = new Host(); host.fail = true
  const dispatcher = new WakeDispatcher(f.outbox, host)
  await dispatcher.tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'held')
  assert.equal(host.inputs.length, 1)

  host.fail = false
  host.recovery = { kind: 'not-accepted' }
  await dispatcher.tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'held')
  assert.equal(host.inputs.length, 1)

  host.recovery = { kind: 'accepted', turnId: 'late-persisted-turn' }
  host.completed = 'completed'
  await dispatcher.tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'acknowledged')
  assert.equal((await f.store.read()).deliveries[0]?.turnId, 'late-persisted-turn')
  assert.equal(host.inputs.length, 1)
})

test('P3 only definitive non-admission retries with bounded backoff and dead letter', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host(); host.result = { kind: 'busy' }
  const dispatcher = new WakeDispatcher(f.outbox, host, { maxAttempts: 2 })
  await dispatcher.tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'queued')
  await dispatcher.tick()
  assert.equal(host.inputs.length, 1)
  f.advance(1000)
  await dispatcher.tick()
  assert.equal((await f.store.read()).deliveries[0]?.state, 'dead')
  f.advance(100000)
  await dispatcher.tick()
  assert.equal(host.inputs.length, 2)
})

test('P3 two dispatchers cannot send the same batch concurrently', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  await Promise.all([new WakeDispatcher(f.outbox, host).tick(), new WakeDispatcher(f.outbox, host).tick()])
  assert.equal(host.inputs.length, 1)
})

test('operator recovery requires positive history and never resubmits an uncertain turn', async () => {
  const f = await fixture()
  await f.watch(); await f.outbox.observe(run('needs_attention', 2), 'owner'); await f.outbox.setEnabled(true)
  const host = new Host(); host.fail = true
  const dispatcher = new WakeDispatcher(f.outbox, host)
  await dispatcher.tick()
  const dispatchId = (await f.store.read()).deliveries[0]!.dispatchId
  assert.deepEqual(await dispatcher.reconcileHeld(dispatchId), { recovered: false })
  host.recovery = { kind: 'accepted', turnId: 'proved-turn' }; host.completed = 'completed'
  await f.outbox.setEnabled(false) // read-only recovery is allowed while automatic admission stays paused
  assert.deepEqual(await dispatcher.reconcileHeld(dispatchId), { recovered: true })
  assert.equal((await f.store.read()).deliveries[0]?.state, 'acknowledged')
  assert.equal(host.inputs.length, 1)
  assert.equal((await f.store.read()).enabled, false)
})
