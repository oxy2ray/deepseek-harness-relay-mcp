import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWakeRunSnapshot } from '../src/wake/relay-client.js'

test('wake source preserves permission and scope metadata without retaining assistant content', () => {
  const projected = parseWakeRunSnapshot({
    runId: 'run-1', sessionId: 'session-1', workspace: '/relay/work', status: 'running', lastEventSeq: 2,
    permissionPreset: 'read-only',
    taskScope: { reviewTargets: ['fixture/README.md'], contextReadScope: ['fixture'], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' },
    assistantText: 'must never be retained', task: 'also not wake state', error: 'private diagnostic',
  })
  assert.equal(projected.permissionPreset, 'read-only')
  assert.deepEqual(projected.taskScope?.reviewTargets, ['fixture/README.md'])
  assert.equal('assistantText' in projected, false)
  assert.equal('task' in projected, false)
  assert.equal('error' in projected, false)
  assert.throws(() => parseWakeRunSnapshot({
    runId: 'run-1', sessionId: 'session-1', workspace: '/relay/work', status: 'running', lastEventSeq: 2,
    permissionPreset: 'root',
  }))
})
