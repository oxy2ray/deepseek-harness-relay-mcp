// Real installed Codex + simulated local model. Does not substitute for real DSH/model E2E.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'
import type { WakeBinding } from '../src/wake/schema.js'
import { startWakeModelFixture } from './fixtures/wake-model-server.js'

test('real Codex with a simulated model persists dispatch identity and completion across restart', async () => {
  const model = await startWakeModelFixture()
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-simulated-model-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace')
  await mkdir(state, { mode: 0o700 }); await mkdir(workspace)
  await writeFile(join(state, 'config.toml'), `model_provider = "relay_fixture"\nmodel = "relay-fixture-only"\n[model_providers.relay_fixture]\nname = "local deterministic test fixture"\nbase_url = "${model.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const options = { testRoot: root, stateDirectory: state, workspace, network: 'model-access' as const }
  let host = await OwnedCodexHost.launch(options)
  let threadId = '', turnId = ''
  try {
    threadId = await host.startThread()
    const binding: WakeBinding = { bindingId: 'fixture-binding', threadId, principal: 'fixture', workspace,
      serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 60000 }
    const [automatic, user] = await Promise.all([
      host.startWhenIdle(binding, 'Protocol fixture data\ndispatchId=fixture-dispatch', 'fixture-dispatch'),
      host.sendUserMessage(threadId, 'concurrent user input must not merge'),
    ])
    assert.equal(automatic.kind, 'accepted')
    if (automatic.kind !== 'accepted') throw new Error('not admitted')
    turnId = automatic.turnId
    if (user.kind === 'accepted') assert.notEqual(user.turnId, turnId)
    let complete = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await host.resumeThread(threadId)
        if (await host.completion(binding, turnId) === 'completed') { complete = true; break }
      } catch { /* wait for actual materialization */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(complete, true, 'simulated protocol turn must complete')
    assert.ok(model.count() >= 1, 'must reach the local fixture instead of merely admitting the API request')
    assert.deepEqual(await host.reconcile(binding, 'fixture-dispatch'), { kind: 'accepted', turnId })
    assert.equal((await host.capabilities()).authenticated, true, 'explicit no-auth custom provider is locally configured')
  } finally { await host.close() }
  host = await OwnedCodexHost.launch(options)
  try {
    await host.resumeThread(threadId)
    const binding: WakeBinding = { bindingId: 'fixture-binding', threadId, principal: 'fixture', workspace,
      serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 60000 }
    assert.deepEqual(await host.reconcile(binding, 'fixture-dispatch'), { kind: 'accepted', turnId })
    assert.equal(await host.completion(binding, turnId), 'completed')
  } finally { await host.close(); await model.close() }
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ realInstalledCodex: true, simulatedModel: true,
    realDsh: false, authenticatedE2E: false, dispatchRecovery: true, turnCompletion: true }, null, 2))
  console.log('SIMULATED MODEL evidence:', join(root, 'evidence.json'))
})
