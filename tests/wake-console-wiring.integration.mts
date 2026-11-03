// Actual private Codex + actual independent Relay. No model task is submitted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'

test('private Codex thread discovers the opted-in tools through the actual independent native Relay proxy', async () => {
  const root = process.env.RELAY_WAKE_TEST_ROOT
  const descriptorPath = process.env.RELAY_WAKE_TEST_DESCRIPTOR
  if (!root || !descriptorPath) throw new Error('explicit independent test paths required')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { authorityId: string; mcpUrl: string }
  assert.notEqual(new URL(descriptor.mcpUrl).port, '3080')
  const state = join(root, 'codex-wiring-state'), workspace = join(root, 'workspace')
  await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 })
  const configPath = join(root, 'wiring-config.json')
  await writeFile(configPath, JSON.stringify({ testRoot: root, codexState: state, workspace,
    wakeState: join(root, 'control', 'wiring-wake.json'), bindingId: 'wiring-binding', principal: 'wake-wiring-test',
    relayDescriptor: descriptorPath, relayAuthorityId: descriptor.authorityId, network: 'model-access', enabled: false }, null, 2), { mode: 0o600 })
  const host = await OwnedCodexHost.launch({ testRoot: root, stateDirectory: state, workspace, network: 'model-access' })
  try {
    const threadId = await host.startThread({ mcp_servers: { harness_relay: {
      command: process.execPath, args: [fileURLToPath(new URL('../dist/dsh-relay-wake-proxy.mjs', import.meta.url)), configPath],
      startup_timeout_sec: 10, required: true,
    } } })
    let names: string[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await host.process.request('mcpServerStatus/list', { threadId, serverName: 'harness_relay' }) as { data: Array<{ name: string; tools: Record<string, unknown> }> }
      names = Object.keys(response.data.find(server => server.name === 'harness_relay')?.tools ?? {})
      if (names.includes('watch_run')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(names.includes('watch_run') && names.includes('get_run') && names.includes('start_run'))
    assert.equal((await host.capabilities()).authenticated, false)
    console.log(JSON.stringify({ realCodex: true, independentNativeRelay: true, optedInTools: names.length,
      credentialsCopied: false, modelInference: false, realDshRunSubmitted: false }))
  } finally { await host.close() }
})
