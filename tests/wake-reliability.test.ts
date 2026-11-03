import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readFile } from 'node:fs/promises'
import { fixture, run } from './fixtures/wake-fixture.js'
import { wakeDiagnostics } from '../src/wake/diagnostics.js'
import { WakeDispatcher, type WakeHost } from '../src/wake/dispatcher.js'
import { WakeRuntime } from '../src/wake/runtime.js'
import { fileURLToPath } from 'node:url'

test('P3 cross-process writers persist one event under contention', async () => {
  const f = await fixture()
  await f.watch()
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/wake-writer.ts', import.meta.url)), f.store.path], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    worker.stderr.on('data', chunk => { error += chunk.toString() })
    worker.once('error', reject)
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker failed: ${error}`)))
  })))
  assert.equal((await f.store.read()).events.length, 1)
})

test('P3 disk write failure preserves the previous valid snapshot', async () => {
  if (process.platform === 'win32') return
  const f = await fixture()
  await f.watch()
  const before = await readFile(f.store.path, 'utf8')
  await chmod(f.directory, 0o500)
  try {
    await assert.rejects(f.outbox.observe(run('succeeded', 4), 'owner'))
    assert.equal(await readFile(f.store.path, 'utf8'), before)
  } finally { await chmod(f.directory, 0o700) }
  await f.outbox.observe(run('succeeded', 4), 'owner')
  assert.equal((await f.store.read()).events.length, 1)
})

test('P3 replay cursors and diagnostics survive paused event collection', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('needs_attention', 2), 'owner')
  const page = await f.outbox.replay('binding', 'owner')
  assert.equal(page.events.length, 1)
  assert.deepEqual(await f.outbox.replay('binding', 'owner', page.nextCursor), { events: [], nextCursor: 1 })
  await assert.rejects(f.outbox.replay('binding', 'other'))
  await assert.rejects(f.outbox.replay('binding', 'owner', 9))
  const diagnostics = wakeDiagnostics(await f.store.read(), f.outbox.now())
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.queuedEvents, 1)
  assert.equal(diagnostics.delivered, 0)
})

test('P3 retention removes only acknowledged prefixes, keeps tombstones and reports cursor gaps', async () => {
  const f = await fixture()
  await f.watch()
  await f.outbox.observe(run('succeeded', 4), 'owner')
  assert.deepEqual(await f.outbox.compactAcknowledged(f.outbox.now()), { removedEvents: 0, removedDeliveries: 0 })
  const host: WakeHost = {
    capabilities: async () => ({ serverIdentity: 'server', authenticated: true, sameThreadResume: true,
      durableHistory: true, completionEvidence: true, exclusiveIdleAdmission: true }),
    inspect: async b => ({ threadId: b.threadId, workspace: b.workspace, idle: true, waitingOnApproval: false }),
    startWhenIdle: async () => ({ kind: 'accepted', turnId: 'turn' }),
    completion: async () => 'completed', reconcile: async () => ({ kind: 'unknown' }),
  }
  await f.outbox.setEnabled(true); f.advance(500)
  const dispatcher = new WakeDispatcher(f.outbox, host)
  await dispatcher.tick(); await dispatcher.tick()
  assert.deepEqual(await f.outbox.compactAcknowledged(f.outbox.now()), { removedEvents: 1, removedDeliveries: 1 })
  await assert.rejects(f.outbox.replay('binding', 'owner', 0), /cursor expired/)
  assert.deepEqual(await f.outbox.replay('binding', 'owner'), { events: [], nextCursor: 1 })
  assert.equal(await f.outbox.observe(run('succeeded', 4), 'owner'), null)
  assert.equal((await f.store.read()).watches[0]?.terminal, true)
})

test('P3 SIGKILL leaves locks that only proven-dead recovery reclaims', async t => {
  const f = await fixture()
  await f.watch()
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/wake-crashed-owner.ts', import.meta.url)), f.store.path], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { child.kill('SIGKILL') })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock owner did not start')), 5000)
    child.once('error', reject)
    child.once('exit', () => { clearTimeout(timer); reject(new Error('lock owner exited before becoming ready')) })
    child.stdout.once('data', () => { clearTimeout(timer); resolve() })
  })
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
  await f.outbox.observe(run('succeeded', 4), 'owner')
  await f.outbox.setEnabled(false) // recovers the dead dispatch lock, never a live one
  const host: WakeHost = {
    capabilities: async () => ({ serverIdentity: 'server', authenticated: false, sameThreadResume: false,
      durableHistory: false, completionEvidence: false, exclusiveIdleAdmission: false }),
    inspect: async () => { throw new Error('no real host') }, startWhenIdle: async () => { throw new Error('must not submit') },
    completion: async () => 'unknown', reconcile: async () => ({ kind: 'unknown' }),
  }
  const runtime = new WakeRuntime(f.outbox, { getRun: async () => run('succeeded', 4) }, host)
  await runtime.start(); await runtime.tick(); await runtime.close()
  assert.equal((await f.store.read()).events.length, 1)
})
