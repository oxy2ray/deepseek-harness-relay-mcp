import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig } from '../src/config.js'
import { createServer } from '../src/mcp-server/index.js'
import { RelayFacade } from '../src/relay-broker/index.js'

test('preset discovery reads fresh native metadata without model discovery or task side effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-agent-presets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = resolveConfig({ DSH_RELAY_HOST_URL: 'http://127.0.0.1:1/', DSH_RELAY_STATE_FILE: join(root, 'state.json') })
  let presets: Array<Record<string, unknown>> = [
    { id: 'custom-fixture', name: '原名称', description: '原说明', isDefault: true },
    { id: 'native-missing-copy', isDefault: false },
  ]
  const calls: string[] = []
  const relay = new RelayFacade(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
    calls.push(request.method)
    if (request.method === 'llm.models') return Response.json({ rpcId: request.rpcId, result: { ok: true, value: {} } })
    assert.equal(request.method, 'agentPreset.list', 'catalog reads must not request models, sessions, settings or tasks')
    return Response.json({ rpcId: request.rpcId, result: { ok: true, value: { presets } } })
  })
  const server = createServer(relay, config)
  const client = new Client({ name: 'preset-catalog-test', version: '1' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  t.after(async () => { await client.close(); await server.close() })
  await server.connect(serverSide)
  await client.connect(clientSide)
  const tools = (await client.listTools()).tools
  assert.equal(tools.find(tool => tool.name === 'list_agent_presets')?.annotations?.readOnlyHint, true)
  for (const name of ['start_run', 'start_review']) {
    const properties = tools.find(tool => tool.name === name)?.inputSchema.properties as Record<string, { description?: string }>
    assert.match(properties.agentPreset?.description ?? '', /Exact preset ID/u)
    assert.match(properties.agentPreset?.description ?? '', /list_agent_presets/u)
  }
  const first = await client.callTool({ name: 'list_agent_presets', arguments: {} })
  assert.equal(first.isError, undefined)
  assert.deepEqual(first.structuredContent, { presets, metadataSource: 'harness-live',
    missingDisplayMetadata: [{ id: 'native-missing-copy', fields: ['name', 'description'] }] })
  presets = [{ id: 'custom-fixture', name: '更新名称', description: '更新说明', isDefault: false, broken: 'Fixture unavailable' },
    { id: 'new-native-default', name: '新增预设', description: '新增说明', isDefault: true }]
  const second = await client.callTool({ name: 'list_agent_presets', arguments: {} })
  assert.deepEqual(second.structuredContent, { presets, metadataSource: 'harness-live', missingDisplayMetadata: [] })
  assert.deepEqual(calls, ['agentPreset.list', 'agentPreset.list'])
  const capabilities = await relay.listCapabilities() as { presets: unknown }
  assert.deepEqual(capabilities.presets, second.structuredContent, 'both discovery paths use the same current bounded metadata contract')
  presets = [{ id: 'invalid-fixture', isDefault: 'yes' }]
  assert.equal((await client.callTool({ name: 'list_agent_presets', arguments: {} })).isError, true)
  await assert.rejects(relay.listCapabilities(), /isDefault/u)
})

test('a mismatched native preset stops the Relay before model, permission or prompt dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-preset-mismatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = resolveConfig({ DSH_RELAY_HOST_URL: 'http://127.0.0.1:1/', DSH_RELAY_STATE_FILE: join(root, 'state.json') })
  const calls: string[] = []
  const relay = new RelayFacade(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
    calls.push(request.method)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'preset-fixture-workspace', path: root, title: 'Fixture', sessionIds: [] }], archivedSessionIds: [] }; break
      case 'session.create': value = { sessionId: 'preset-mismatch-session', agentPreset: 'unexpected-default' }; break
      default: throw new Error(`Unexpected side effect after preset mismatch: ${request.method}`)
    }
    return Response.json({ rpcId: request.rpcId, result: { ok: true, value } })
  })
  await assert.rejects(relay.startRun({ workspace: root, task: 'Synthetic preset selection test.', agentPreset: 'selected-preset' }), /different agentPreset than requested/u)
  assert.equal(calls.filter(method => method === 'session.create').length, 1)
  assert.equal(calls.some(method => /prompt|selectModel|settings|cancel/u.test(method)), false)
})
