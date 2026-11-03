import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, type WakeState } from '../src/wake/schema.js'
import { wakeDiagnostics } from '../src/wake/diagnostics.js'

const binding = (bindingId: string, enabled: boolean): WakeState['bindings'][number] => ({
  bindingId, threadId: `thread-${bindingId}`, principal: 'owner', workspace: '/tmp/wake-workspace',
  serverIdentity: 'server', enabled, expiresAt: 100000,
})

test('diagnostics report bounded worker readiness and paused bindings', () => {
  const now = 10_000
  const base: WakeState = {
    ...emptyState(),
    bindings: [binding('active', true), binding('paused', false)],
    worker: { ownerId: 'worker', heartbeatAt: now - 500, ready: true, bindingIds: ['active'] },
  }

  // Fresh heartbeat inside the three-second lease.
  const fresh = wakeDiagnostics(base, now)
  assert.equal(fresh.workerReady, true)
  assert.equal(fresh.workerHeartbeatAgeMs, 500)
  assert.equal(fresh.workerBindings, 1)
  assert.equal(fresh.pausedBindings, 1)

  // Same ready flag, but the lease has expired.
  const staleState: WakeState = { ...base, worker: { ...base.worker!, heartbeatAt: now - 3001 } }
  const stale = wakeDiagnostics(staleState, now)
  assert.equal(stale.workerReady, false)
  assert.equal(stale.workerHeartbeatAgeMs, 3001)
  assert.equal(stale.workerBindings, 1)

  // No worker record at all: readiness and age are absent, controls still count.
  const absent = wakeDiagnostics({ ...base, worker: null }, now)
  assert.equal(absent.workerReady, false)
  assert.equal(absent.workerHeartbeatAgeMs, null)
  assert.equal(absent.workerBindings, 0)
  assert.equal(absent.pausedBindings, 1)
})
