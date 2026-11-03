import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { RelayConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import type { RelayFacade } from '../src/relay-broker/index.js'

test('exposes advisory provider quotas in capabilities and through a read-only filterable tool', async () => {
  const providerQuota = {
    schemaVersion: 1,
    providers: [{
      provider: 'opencode-go', models: ['model-a'], state: 'unknown', reason: 'upstream-network',
      errorCode: 'upstream-network', checkedAt: '2026-11-02T00:00:00.000Z', updatedAt: null, expiresAt: null,
      scope: 'provider-plan', modelScope: 'unknown', accountScope: 'unverified', extraUsage: 'unknown', windows: [], advisory: true,
    }],
  }
  const requested: Array<string[] | undefined> = []
  let taskCalls = 0
  const relay = {
    async listCapabilities() { return { models: { groups: [{ id: 'opencode-go', models: [{ id: 'model-a' }] }] }, providerQuotas: providerQuota } },
    async listProviderQuotas(providers?: readonly string[]) {
      requested.push(providers === undefined ? undefined : [...providers])
      return providerQuota
    },
    async startRun() { taskCalls++; throw new Error('quota lookup must not submit tasks') },
  } as unknown as RelayFacade
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer(relay, config())
  const client = new Client({ name: 'provider-quotas-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    const quotaTool = tools.tools.find(tool => tool.name === 'list_provider_quotas')
    assert.ok(quotaTool)
    assert.equal(quotaTool.annotations?.readOnlyHint, true)
    assert.equal(quotaTool.annotations?.destructiveHint, false)
    assert.ok(quotaTool.outputSchema)

    const capabilities = await client.callTool({ name: 'list_capabilities', arguments: {} })
    assert.deepEqual((capabilities.structuredContent as { providerQuotas?: unknown }).providerQuotas, providerQuota)
    const filtered = await client.callTool({ name: 'list_provider_quotas', arguments: { providers: ['opencode-go'] } })
    assert.notEqual(filtered.isError, true)
    assert.deepEqual(filtered.structuredContent, providerQuota)
    assert.deepEqual(requested, [['opencode-go']])
    assert.equal(taskCalls, 0)
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
})

function config(): RelayConfig {
  return {
    hostUrl: 'http://127.0.0.1:3080/', allowedWorkspaceRoots: [], rpcTimeoutMs: 30_000,
    pollIntervalMs: 750, maxTaskCharacters: 100_000, maxAssistantTextBytes: 256_000,
    maxImageBytes: 5 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * 1024 * 1024,
    stateFile: 'C:\\test\\relay-state.json', persistPromptText: false, clientPrincipalId: 'quota-test',
    permissionLeaseMs: 86_400_000, maxHistoryPages: 100, runStallMs: 300_000,
  }
}
