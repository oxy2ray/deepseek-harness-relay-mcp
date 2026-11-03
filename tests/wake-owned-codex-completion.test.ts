import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyOwnedCodexCompletion } from '../src/wake/owned-codex-host.js'

test('local admission history snapshots stay pending until terminal event or durable completion', () => {
  assert.equal(classifyOwnedCodexCompletion('interrupted', true), 'pending')
  assert.equal(classifyOwnedCodexCompletion('failed', true), 'pending')
  assert.equal(classifyOwnedCodexCompletion('inProgress', true), 'pending')
  assert.equal(classifyOwnedCodexCompletion('interrupted', true, 'completed'), 'pending')
  assert.equal(classifyOwnedCodexCompletion('completed', false, 'completed'), 'completed')
})

test('genuine terminal failures are preserved and prior-process interruptions stay failed', () => {
  assert.equal(classifyOwnedCodexCompletion('failed', true, 'failed'), 'failed')
  assert.equal(classifyOwnedCodexCompletion('interrupted', true, 'interrupted'), 'failed')
  assert.equal(classifyOwnedCodexCompletion('interrupted', false), 'failed')
  assert.equal(classifyOwnedCodexCompletion('failed', false), 'failed')
})

test('contradictory durable success and terminal failure cannot be acknowledged', () => {
  assert.equal(classifyOwnedCodexCompletion('completed', false, 'failed'), 'unknown')
  assert.equal(classifyOwnedCodexCompletion('completed', false, 'interrupted'), 'unknown')
})
