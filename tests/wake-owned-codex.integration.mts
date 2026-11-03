// Real installed Codex protocol integration. No credentials, no model network, no DSH mock success claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'
import type { WakeBinding } from '../src/wake/schema.js'

test('private unauthenticated App Server serializes admission and never invents dispatch evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-owned-codex-'))
  const state = join(root, 'codex-state')
  const workspace = join(root, 'workspace')
  await mkdir(state, { mode: 0o700 }); await mkdir(workspace)
  const options = { testRoot: root, stateDirectory: state, workspace, network: 'isolated' as const }
  let host = await OwnedCodexHost.launch(options)
  let threadId = ''
  let automaticTurnId = ''
  const verifyRecovery = async (current: OwnedCodexHost, binding: WakeBinding) => {
    const recovered = await current.reconcile(binding, 'probe-1')
    if (recovered.kind === 'accepted') {
      assert.equal(recovered.turnId, automaticTurnId)
      const page = await current.process.request('thread/items/list', { threadId, limit: 100 }) as { data: Array<{ turnId: string; item: { type: string; content?: Array<{ type: string; text?: string }> } }> }
      assert.ok(page.data.some(entry => entry.turnId === automaticTurnId && entry.item.type === 'userMessage'
        && entry.item.content?.some(item => item.type === 'text' && item.text?.split('\n').includes('dispatchId=probe-1'))), 'accepted recovery must have actual durable input evidence')
    } else assert.deepEqual(recovered, { kind: 'unknown' })
  }
  try {
    assert.equal((await host.capabilities()).authenticated, false)
    threadId = await host.startThread()
    const binding: WakeBinding = { bindingId: 'binding', threadId, principal: 'owner', workspace,
      serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 60000 }
    const [wake, user] = await Promise.all([
      host.startWhenIdle(binding, 'Private network-disabled probe\ndispatchId=probe-1', 'probe-1'),
      host.sendUserMessage(threadId, 'Another private protocol probe'),
    ])
    assert.equal(wake.kind, 'accepted')
    if (wake.kind !== 'accepted') throw new Error('wake not admitted')
    automaticTurnId = wake.turnId
    if (user.kind === 'accepted') assert.notEqual(user.turnId, wake.turnId, 'must never merge into the user/wake turn')
    // Admission may precede rollout materialization; wait for actual history, not a fixed success assumption.
    let materialized = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await host.resumeThread(threadId); materialized = true; break }
      catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.equal(materialized, true)
    assert.equal((await host.capabilities()).durableHistory, true)
    // Without auth the engine can fail either before or after durable user-item persistence.
    // Admission alone is insufficient; positive recovery must be backed by the actual item.
    await verifyRecovery(host, binding)
    assert.deepEqual(await host.reconcile(binding, 'absent'), { kind: 'unknown' })
  } finally { await host.close() }
  host = await OwnedCodexHost.launch(options)
  try {
    await host.resumeThread(threadId)
    const binding: WakeBinding = { bindingId: 'binding', threadId, principal: 'owner', workspace,
      serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 60000 }
    await verifyRecovery(host, binding)
    const status = await host.completion(binding, automaticTurnId)
    assert.ok(['pending', 'failed'].includes(status), 'network-disabled probe cannot establish successful inference')
  } finally { await host.close() }
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ mode: 'real-Codex-private-stdio-network-disabled',
    threadId, automaticTurnId, admissionSerialized: true, restartHistory: true, dispatchRecovery: 'requires-actual-input-evidence', authenticatedE2E: false }, null, 2))
  console.log('Evidence:', join(root, 'evidence.json'))
})
