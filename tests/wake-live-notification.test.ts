import test from 'node:test'
import assert from 'node:assert/strict'
import { observeNotification } from './wake-live-runs.integration.mjs'

test('live consumer recognizes actual MCP tool and completed AgentMessage items', () => {
  const expected = new Map([['run-fixture', { runId: 'run-fixture', expectedToken: 'E2E-SYNTHETIC-42' }]])
  const getRunCalls = new Set<string>()
  const waitRunCalls = new Set<string>()
  const replyBuffers = new Map<string, string>()
  const matchingReplies = new Set<string>()
  observeNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'mcpToolCall', server: 'harness_relay', tool: 'get_run', arguments: { runId: 'run-fixture' },
  } } }, expected, getRunCalls, waitRunCalls, replyBuffers, matchingReplies)
  observeNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'mcpToolCall', server: 'harness_relay', tool: 'wait_run', arguments: { runId: 'run-fixture' },
  } } }, expected, getRunCalls, waitRunCalls, replyBuffers, matchingReplies)
  observeNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'agentMessage', text: 'Verified run-fixture; result token E2E-SYNTHETIC-42',
  } } }, expected, getRunCalls, waitRunCalls, replyBuffers, matchingReplies)
  assert.deepEqual([...getRunCalls], ['run-fixture'])
  assert.deepEqual([...waitRunCalls], ['run-fixture'])
  assert.deepEqual([...matchingReplies], ['run-fixture'])
})
