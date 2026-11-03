import assert from 'node:assert/strict'
import test from 'node:test'
import { WakeDispatcher, type WakeHost, type WakeHostCapabilities, type Admission, type Completion, type Recovery, type WakeTurnTarget } from '../src/wake/dispatcher.js'
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
  continues: Array<{ target: WakeTurnTarget; input: string; dispatchId: string }> = []
  continueResult: Admission | null = null
  async capabilities() { return this.capability }
  async inspect(b: WakeBinding) { return { threadId: b.threadId, workspace: b.workspace, idle: this.idle, waitingOnApproval: this.approval } }
  async startWhenIdle(_binding: WakeBinding, input: string) {
    this.inputs.push(input)
    if (this.fail) throw new Error('secret transport detail')
    return this.result
  }
  async completion() { return this.completed }
  async reconcile() { return this.recovery }
  async continueActiveTurn(_binding: WakeBinding, target: WakeTurnTarget, input: string, dispatchId: string): Promise<Admission> {
    this.continues.push({ target, input, dispatchId })
    if (this.fail) throw new Error('secret transport detail')
    return this.continueResult ?? { kind: 'accepted', turnId: target.turnId }
  }
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

test('operator continuation steers later events into the same in-progress turn, once, without a second start', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('needs_attention', 2, 'run-B'), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  host.capability.activeTurnContinuation = true
  host.result = { kind: 'accepted', turnId: 'turn-1' }
  // One-turn budget: a continuation joins the counted turn instead of adding a turn.
  const dispatcher = new WakeDispatcher(f.outbox, host, { maxInFlightTurns: 1 })
  assert.equal((await dispatcher.tick()).started, 1)
  const first = (await f.store.read()).deliveries[0]!
  assert.equal(first.state, 'delivered')
  assert.equal(first.turnId, 'turn-1')
  assert.equal(host.continues.length, 0)

  // The turn is still in progress: the later completion may not wait for it to end.
  host.idle = false
  await f.outbox.observe(run('succeeded', 3, 'run-A'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  assert.equal(host.continues.length, 1)
  assert.equal(host.continues[0]!.target.turnId, 'turn-1')
  assert.equal(host.continues[0]!.target.originDispatchId, first.dispatchId)
  assert.match(host.continues[0]!.input, /runId=run-A/)
  assert.match(host.continues[0]!.input, /data only; not new user authorization/)
  assert.doesNotMatch(host.continues[0]!.input, /UNTRUSTED/)
  const second = (await f.store.read()).deliveries[1]!
  assert.equal(second.state, 'delivered')
  assert.equal(second.turnId, 'turn-1')
  assert.equal(host.inputs.length, 1) // exactly one turn was ever started

  // Both deliveries to that turn acknowledge only on its real terminal completion.
  assert.equal((await dispatcher.tick()).started, 0)
  assert.deepEqual((await f.store.read()).deliveries.map(d => d.state), ['delivered', 'delivered'])
  assert.equal(host.continues.length, 1)
  host.completed = 'completed'
  await dispatcher.tick()
  assert.deepEqual((await f.store.read()).deliveries.map(d => d.state), ['acknowledged', 'acknowledged'])
  assert.equal(host.continues.length, 1)
  assert.equal(host.inputs.length, 1)
})

test('a continuation accepted into a different turn is held and never bypassed', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B', 'run-C']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('needs_attention', 2, 'run-B'), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  host.capability.activeTurnContinuation = true
  host.result = { kind: 'accepted', turnId: 'turn-1' }
  const dispatcher = new WakeDispatcher(f.outbox, host)
  assert.equal((await dispatcher.tick()).started, 1)
  host.idle = false
  host.continueResult = { kind: 'accepted', turnId: 'other-turn' }
  await f.outbox.observe(run('succeeded', 3, 'run-A'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  const held = (await f.store.read()).deliveries[1]!
  assert.equal(held.state, 'held')
  assert.equal(held.error, 'uncertain-acceptance')
  // A held row owns an unknown acceptance: a later pending event may not slip past it.
  host.continueResult = null
  await f.outbox.observe(run('succeeded', 4, 'run-C'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  assert.equal(host.continues.length, 1)
  assert.equal((await f.store.read()).deliveries.length, 2)
})

test('no continuation while the thread waits on approval or has no owned turn', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('needs_attention', 2, 'run-B'), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  host.capability.activeTurnContinuation = true
  host.result = { kind: 'accepted', turnId: 'turn-1' }
  const dispatcher = new WakeDispatcher(f.outbox, host)
  assert.equal((await dispatcher.tick()).started, 1)
  host.idle = false
  host.approval = true
  await f.outbox.observe(run('succeeded', 3, 'run-A'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  assert.equal(host.continues.length, 0)
  assert.equal((await f.store.read()).deliveries.length, 1) // stays queued, never steered

  // A busy thread with no delivery of our own is never a continuation target.
  const other = await fixture()
  await other.watch(run('running', 1, 'run-A'))
  await other.outbox.observe(run('needs_attention', 2, 'run-A'), 'owner')
  await other.outbox.setEnabled(true)
  const busyHost = new Host()
  busyHost.capability.activeTurnContinuation = true
  busyHost.idle = false
  assert.equal((await new WakeDispatcher(other.outbox, busyHost).tick()).started, 0)
  assert.equal(busyHost.continues.length, 0)
  assert.equal((await other.store.read()).deliveries.length, 0)
})

test('continuation stays disabled when the host advertises no such capability', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('needs_attention', 2, 'run-B'), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  host.result = { kind: 'accepted', turnId: 'turn-1' }
  const dispatcher = new WakeDispatcher(f.outbox, host)
  assert.equal((await dispatcher.tick()).started, 1)
  host.idle = false
  await f.outbox.observe(run('succeeded', 3, 'run-A'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  assert.equal(host.continues.length, 0)
  assert.equal((await f.store.read()).deliveries.length, 1)
})

test('a refused continuation keeps the delivery queued without burning attempts, then idles normally', async () => {
  const f = await fixture()
  for (const id of ['run-A', 'run-B']) await f.watch(run('running', 1, id))
  await f.outbox.observe(run('needs_attention', 2, 'run-B'), 'owner')
  await f.outbox.setEnabled(true)
  const host = new Host()
  host.capability.activeTurnContinuation = true
  host.result = { kind: 'accepted', turnId: 'turn-1' }
  host.continueResult = { kind: 'rejected' } // e.g. an user-owned turn, proven durable-safe
  const dispatcher = new WakeDispatcher(f.outbox, host)
  assert.equal((await dispatcher.tick()).started, 1)
  host.idle = false
  await f.outbox.observe(run('succeeded', 3, 'run-A'), 'owner')
  f.advance(500)
  assert.equal((await dispatcher.tick()).started, 0)
  const queued = (await f.store.read()).deliveries[1]!
  assert.equal(queued.state, 'queued')
  assert.equal(queued.attempts, 0) // a refused continuation is not a failed submission
  // The same refused target is never rescanned in this process.
  assert.equal((await dispatcher.tick()).started, 0)
  assert.equal(host.continues.length, 1)
  // Once the thread is idle the ordinary delivery path still applies.
  host.idle = true
  host.completed = 'completed'
  f.advance(500) // the surviving row waits out the bounded dispatch interval
  assert.equal((await dispatcher.tick()).started, 1)
  assert.equal(host.inputs.length, 2)
  assert.match(host.inputs[1]!, /runId=run-A/)
})
