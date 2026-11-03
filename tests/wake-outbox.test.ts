import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { WakeStore } from '../src/wake/store.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { collectWakeEvents } from '../src/wake/collector.js'

import { run, fixture } from './fixtures/wake-fixture.js'

test('P1 durable duplicate terminal projection, restart and safe references', async () => {
  const f = await fixture()
  const subscriptionId = await f.watch()
  assert.equal(await f.watch(), subscriptionId)
  assert.equal(await f.outbox.observe(run(), 'owner'), null)
  const event = await f.outbox.observe(run('succeeded', 4), 'owner')
  assert.equal(event?.kind, 'terminal')
  const restarted = new WakeOutbox(new WakeStore(f.store.path))
  assert.equal(await restarted.observe(run('succeeded', 4), 'owner'), null)
  const state = await restarted.store.read()
  assert.equal(state.events.length, 1)
  assert.equal(state.enabled, false)
  assert.equal(JSON.stringify(state).includes('UNTRUSTED'), false)
  if (process.platform !== 'win32') assert.equal((await stat(f.store.path)).mode & 0o777, 0o600)
})

test('P1 ownership, immutable destinations, idempotency conflicts and unwatch', async () => {
  const f = await fixture()
  await assert.rejects(f.outbox.watch({ run: run(), bindingId: 'binding', principal: 'foreign', idempotencyKey: 'key' }))
  const subscription = await f.watch()
  await assert.rejects(f.outbox.watch({ run: run('running', 1, 'run-B'), bindingId: 'binding', principal: 'owner', idempotencyKey: 'key-run-A' }))
  await assert.rejects(f.outbox.observe({ ...run(), sessionId: 'other' }, 'owner'))
  await assert.rejects(f.outbox.unwatch(subscription, 'foreign'))
  await f.outbox.unwatch(subscription, 'owner')
  assert.equal(await f.outbox.observe(run('failed', 8), 'owner'), null)
})

test('watch idempotency replay preserves unwatch and rejects terminal subscriptions', async () => {
  const f = await fixture()
  const subscription = await f.watch()
  await f.outbox.unwatch(subscription, 'owner')
  await assert.rejects(f.watch(), /inactive/)
  assert.equal((await f.store.read()).watches[0]?.active, false)

  const terminal = await fixture()
  const terminalSubscription = await terminal.watch(run(), 'terminal-key')
  await terminal.outbox.observe(run('succeeded', 4), 'owner')
  await assert.rejects(terminal.outbox.watch({ run: run('succeeded', 4), bindingId: 'binding', principal: 'owner', idempotencyKey: 'terminal-key' }), /terminal/)
  assert.equal((await terminal.store.read()).watches[0]?.subscriptionId, terminalSubscription)
})

test('P1 attention is separate, can recur after progress, stale snapshots ignored', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 4), 'owner')
  assert.equal(await f.outbox.observe(run('needs_attention', 4), 'owner'), null)
  assert.equal(await f.outbox.observe(run('succeeded', 3), 'owner'), null)
  await f.outbox.observe(run('running', 5), 'owner')
  await f.outbox.observe(run('needs_attention', 6), 'owner')
  await f.outbox.observe(run('cancelled', 7), 'owner')
  assert.deepEqual((await f.store.read()).events.map(e => [e.kind, e.eventSeq]), [
    ['needs_attention', 1], ['needs_attention', 2], ['terminal', 3],
  ])
})

test('P1 queue limits roll back observations; corrupt state is never overwritten', async () => {
  const f = await fixture({ maxEvents: 1 })
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  await assert.rejects(f.outbox.observe(run('failed', 3), 'owner'))
  assert.equal((await f.store.read()).watches[0]?.terminal, false)
  await writeFile(f.store.path, '{broken')
  await assert.rejects(f.outbox.setEnabled(true))
  assert.equal(await readFile(f.store.path, 'utf8'), '{broken')
})

test('P1 independent store writers serialize without lost events', async () => {
  const f = await fixture()
  await f.watch()
  const second = new WakeOutbox(new WakeStore(f.store.path), {}, f.outbox.now)
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    (i % 2 ? second : f.outbox).observe(run('succeeded', 4), 'owner')))
  assert.equal((await f.store.read()).events.length, 1)
})

test('P1 collector only reads registered run/principal and isolates failures', async () => {
  const f = await fixture()
  await f.watch()
  await f.watch(run('running', 1, 'run-B'))
  const calls: string[] = []
  const result = await collectWakeEvents(f.outbox, { getRun: async (id, principal) => {
    calls.push(`${id}:${principal}`)
    if (id === 'run-B') throw new Error('secret remote error')
    return run('incomplete', 3)
  } })
  assert.equal(result.collected, 1)
  assert.equal(result.failed.length, 1)
  assert.deepEqual(calls, ['run-A:owner', 'run-B:owner'])
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('attention-only subscriptions stop collecting a terminal run without emitting a filtered event', async () => {
  const f = await fixture()
  await f.outbox.watch({ run: run(), bindingId: 'binding', principal: 'owner', idempotencyKey: 'attention-only', events: ['needs_attention'] })
  await f.outbox.observe(run('succeeded', 4), 'owner')
  const state = await f.store.read()
  assert.equal(state.watches[0]?.terminal, true)
  assert.equal(state.events.length, 0)
  const result = await collectWakeEvents(f.outbox, { getRun: async () => { throw new Error('must not poll terminal run') } })
  assert.deepEqual(result, { collected: 0, failed: [] })
})

test('attention-only watch cannot acknowledge a run that is already terminal', async () => {
  const f = await fixture()
  await assert.rejects(f.outbox.watch({ run: run('succeeded', 4), bindingId: 'binding', principal: 'owner', idempotencyKey: 'attention-only', events: ['needs_attention'] }), /excludes terminal/)
  assert.equal((await f.store.read()).watches.length, 0)
})

test('explicit relay workspace mapping accepts only scoped read-only runs', async () => {
  const f = await fixture()
  const relay = join(f.directory, 'relay-workspace')
  const target = join(relay, '.runtime/test/workspace')
  const targetPrefix = relative(relay, target).replaceAll('\\', '/')
  await mkdir(join(target, 'fixture'), { recursive: true })
  await writeFile(join(target, 'fixture', 'README.md'), 'in-scope fixture')
  await mkdir(join(relay, '.aws'))
  await f.outbox.registerBinding({ bindingId: 'mapped', threadId: 'mapped-thread', principal: 'owner', workspace: target,
    relayWorkspace: relay, serverIdentity: 'server', enabled: true, expiresAt: 100000 })
  const mappedRun = (overrides: Record<string, unknown> = {}) => ({
    ...run(), workspace: relay, permissionPreset: 'read-only' as const,
    taskScope: { reviewTargets: [`${targetPrefix}/fixture/README.md`], contextReadScope: [`${targetPrefix}/fixture`], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' as const },
    ...overrides,
  })
  const watch = (snapshot: ReturnType<typeof mappedRun>) => f.outbox.watch({ run: snapshot, bindingId: 'mapped', principal: 'owner', idempotencyKey: `mapped-${String(snapshot.status)}` })
  await watch(mappedRun())
  await assert.rejects(watch(mappedRun({ workspace: `${relay}-other` })), /not authorized/)
  await assert.rejects(watch(mappedRun({ taskScope: undefined })), /complete read-only taskScope/)
  await assert.rejects(watch(mappedRun({ permissionPreset: 'workspace-write' })), /read-only/)
  await assert.rejects(watch(mappedRun({ taskScope: { reviewTargets: ['../outside'], contextReadScope: ['.'], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' } })), /escapes Relay workspace/)
  await assert.rejects(watch(mappedRun({ taskScope: { reviewTargets: ['.aws'], contextReadScope: ['.aws'], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' } })), /escapes binding workspace/)
  await assert.rejects(watch(mappedRun({ taskScope: { reviewTargets: ['.'], contextReadScope: ['.'], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' } })), /escapes binding workspace/)
  await assert.rejects(watch(mappedRun({ taskScope: { reviewTargets: [`${targetPrefix}/fixture/README.md`], contextReadScope: [`${targetPrefix}/fixture`], excludedPaths: [], writeScope: [`${targetPrefix}/fixture/README.md`], enforcement: 'instruction-only' } })), /complete read-only taskScope/)
  await assert.rejects(f.outbox.watch({ run: mappedRun(), bindingId: 'mapped', principal: 'other', idempotencyKey: 'wrong-principal' }), /not authorized/)
  await assert.rejects(f.outbox.observe({ ...mappedRun(), sessionId: 'another-session' }, 'owner'), /ownership mismatch/)
  const state = await f.store.read()
  assert.deepEqual(state.watches.map(w => w.runId), ['run-A'])
  await assert.rejects(f.outbox.registerBinding({ bindingId: 'bad-path', threadId: 'bad-path-thread', principal: 'owner', workspace: target,
    relayWorkspace: `${relay}/../outside`, serverIdentity: 'server', enabled: true, expiresAt: 100000 }), /absolute and normalized/)
})

test('mapped review paths reject symlinks outside the target and revalidate them on observation', async t => {
  const f = await fixture()
  const relay = join(f.directory, 'relay-workspace')
  const target = join(relay, '.runtime/test/workspace')
  const fixtureDirectory = join(target, 'fixture')
  const outside = join(relay, 'outside-target')
  await mkdir(fixtureDirectory, { recursive: true })
  await mkdir(outside)
  await writeFile(join(fixtureDirectory, 'README.md'), 'in-scope fixture')
  await writeFile(join(outside, 'secret.txt'), 'outside target')
  await writeFile(join(outside, 'README.md'), 'retargeted outside path')
  await f.outbox.registerBinding({ bindingId: 'mapped', threadId: 'mapped-thread', principal: 'owner', workspace: target,
    relayWorkspace: relay, serverIdentity: 'server', enabled: true, expiresAt: 100000 })
  const mappedRun = (scopePath: string, readPath = scopePath, runId = 'mapped-run') => ({
    ...run('running', 1, runId), workspace: relay, permissionPreset: 'read-only' as const,
    taskScope: { reviewTargets: [scopePath], contextReadScope: [readPath], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' as const },
  })
  const outsideLink = join(fixtureDirectory, 'outside-link')
  try { await symlink(outside, outsideLink, 'dir') }
  catch (error) {
    if (process.platform === 'win32') { t.skip(`directory symlink unavailable: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); return }
    throw error
  }
  const escapedReview = mappedRun('.runtime/test/workspace/fixture/outside-link/secret.txt', '.runtime/test/workspace/fixture/outside-link')
  await assert.rejects(f.outbox.watch({ run: escapedReview, bindingId: 'mapped', principal: 'owner', idempotencyKey: 'escaped-review' }), /escapes binding workspace through a symlink/)
  // Keep the reviewed file inside the target and make only the declared read
  // root resolve outside it; mapped runs must reject either scope field.
  const escapedReadRoot = mappedRun('.runtime/test/workspace/fixture/README.md', '.runtime/test/workspace/fixture/outside-link')
  await assert.rejects(f.outbox.watch({ run: escapedReadRoot, bindingId: 'mapped', principal: 'owner', idempotencyKey: 'escaped-read-root' }), /escapes binding workspace through a symlink/)

  const inTarget = join(fixtureDirectory, 'allowed')
  await mkdir(inTarget)
  await writeFile(join(inTarget, 'README.md'), 'safe target')
  const mutableLink = join(fixtureDirectory, 'mutable-link')
  await symlink(inTarget, mutableLink, 'dir')
  const watched = mappedRun('.runtime/test/workspace/fixture/mutable-link/README.md', '.runtime/test/workspace/fixture/mutable-link', 'retargeted-run')
  await f.outbox.watch({ run: watched, bindingId: 'mapped', principal: 'owner', idempotencyKey: 'retargeted-watch' })
  await unlink(mutableLink)
  await symlink(outside, mutableLink, 'dir')
  await assert.rejects(f.outbox.observe({ ...watched, status: 'succeeded', lastEventSeq: 2 }, 'owner'), /escapes binding workspace through a symlink/)
  assert.equal((await f.store.read()).events.length, 0)
})

test('trusted renewal changes only expiry and preserves a persistent pause', async () => {
  const f = await fixture()
  await f.outbox.setEnabled(false, 'binding')
  const before = (await f.store.read()).bindings[0]!
  f.advance(100000)
  await f.outbox.renewBinding('binding', f.outbox.now() + 60000)
  const after = (await f.store.read()).bindings[0]!
  assert.deepEqual({ ...after, expiresAt: before.expiresAt }, before)
  assert.equal(after.enabled, false)
  await assert.rejects(f.outbox.renewBinding('binding', f.outbox.now() - 1))
})
