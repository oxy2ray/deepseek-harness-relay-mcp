import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpHttpFacade } from '../src/mcp-http/index.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { WakeStore } from '../src/wake/store.js'

const facts = (r: Record<string, unknown>) => (r.structuredContent ?? {}) as Record<string, unknown>

const threadId = '11111111-1111-4111-8111-111111111111'

test('proxy defaults to a compact wait while explicit full and get_run preserve results', async t => {
  const f = await fixture(t)
  const catalog = await f.client.listTools()
  assert.ok(catalog.tools.find(tool => tool.name === 'wait_run')?.inputSchema.properties?.detail)
  const brief = await f.client.callTool({ name: 'wait_run', arguments: { runId: 'run' } })
  assert.notEqual(brief.isError, true, brief.isError ? JSON.stringify(brief) : undefined)
  assert.ok(JSON.stringify(brief).length < 1200)
  assert.equal(facts(brief).assistantText, undefined)
  assert.equal(facts(brief).task, undefined)
  const full = await f.client.callTool({ name: 'wait_run', arguments: { runId: 'run', detail: 'full' } })
  assert.equal(facts(full).assistantText, f.large)
  const result = await f.client.callTool({ name: 'get_run', arguments: { runId: 'run' } })
  assert.equal(facts(result).assistantText, f.large)
  assert.deepEqual(f.waitArguments, [{ runId: 'run' }, { runId: 'run' }])
})

test('proxy enrolls only host thread metadata and acknowledges only after worker readiness', async t => {
  const f = await fixture(t, true)
  const start = await f.client.callTool({ name: 'start_run', arguments: {}, _meta: { threadId } })
  assert.notEqual(start.isError, true, start.isError ? JSON.stringify(start) : undefined)
  assert.equal(facts(start).hostMayConcludeTurn, undefined)
  assert.equal((facts(start).hostPollContract as { nextTool: string }).nextTool, 'watch_run')
  assert.equal(f.enrollments.length, 1)
  assert.equal(f.enrollments[0], threadId)
  const state = await f.outbox.store.read()
  assert.equal(state.bindings[0]?.threadId, threadId)
  // Controlled worker readiness is deliberately a unit fixture, not live E2E evidence.
  const ready = new Promise<void>(resolve => setTimeout(() => {
    void f.outbox.store.transaction(s => {
      s.worker = { ownerId: 'test-worker', ready: true, heartbeatAt: Date.now(), bindingIds: ['auto-test'] }
    }).then(resolve)
  }, 120))
  const watched = await f.client.callTool({ name: 'watch_run', arguments: { runId: 'run', idempotencyKey: 'key' }, _meta: { threadId } })
  await ready
  assert.equal(facts(watched).acknowledged, true)
  assert.equal(facts(watched).hostMayConcludeTurn, true)
  assert.equal(f.enrollments.length, 1)

  const injected = await f.client.callTool({ name: 'watch_run', arguments: { runId: 'run', idempotencyKey: 'bad', threadId: 'other' }, _meta: { threadId } })
  const missing = await f.client.callTool({ name: 'watch_run', arguments: { runId: 'run', idempotencyKey: 'missing' } })
  assert.equal(injected.isError, true)
  assert.equal(missing.isError, true)
  assert.equal(f.enrollments.length, 1)
  assert.equal((await f.outbox.store.read()).watches.length, 1)
})

async function fixture(t: TestContext, automatic = false) {
  const root = await mkdtemp(join(tmpdir(), 'relay-monitoring-'))
  const large = 'large-result-'.repeat(30_000)
  const outbox = new WakeOutbox(new WakeStore(join(root, 'wake.json')))
  await outbox.setEnabled(true)
  const enrollments: string[] = []
  const waitArguments: unknown[] = []
  const snapshot = { runId: 'run', sessionId: 'session', workspace: root, status: 'running', lastEventSeq: 1,
    permissionPreset: 'read-only', task: large, assistantText: large,
    hostPollContract: { hostMustCallWaitRunAgain: true, nextTool: 'wait_run', doNotConcludeHostTurn: true } }
  const token = 'T'.repeat(43)
  await writeFile(join(root, 'relay.token'), token, { mode: 0o600 })
  let authority: McpHttpFacade
  const http = createServer((req, res) => { void authority.handle(req, res) })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert.ok(address && typeof address === 'object')
  const host = `127.0.0.1:${address.port}`
  authority = new McpHttpFacade({ token, allowedHosts: [host], allowedOrigins: [], maxBodyBytes: 65536,
    maxConcurrent: 8, requestsPerMinute: 1000, drainTimeoutMs: 100 }, () => {
    const remote = new McpServer({ name: 'controlled-legacy-host', version: '1' })
    const result = () => ({ content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }], structuredContent: snapshot })
    remote.registerTool('start_run', { inputSchema: {} }, result)
    remote.registerTool('get_run', { inputSchema: { runId: z.string() } }, result)
    remote.registerTool('wait_run', { inputSchema: { runId: z.string(), detail: z.never().optional() } }, args => {
      waitArguments.push(args)
      return result()
    })
    return remote
  })
  await writeFile(join(root, 'relay-endpoint.json'), JSON.stringify({ schemaVersion: 1, authorityId: 'test', mode: 'embedded',
    mcpUrl: `http://${host}/plugins/dsh-relay/mcp`, tokenFilePath: join(root, 'relay.token'), hostWebUrl: `http://${host}/`,
    ownerEpoch: 1, updatedAt: new Date().toISOString() }))
  await writeFile(join(root, 'relay-status.json'), JSON.stringify({ schemaVersion: 1, authorityId: 'test', mode: 'embedded',
    instanceId: 'test', state: 'ready', ownerPid: process.pid, processStartedAt: new Date().toISOString(), ownerEpoch: 1,
    hostIdentity: `http://${host}`, profile: 'test', dshHome: root, launcher: null, lastError: null, updatedAt: new Date().toISOString() }))
  const proxy = new StdioProxyFacade({ descriptorFile: join(root, 'relay-endpoint.json'), clientPrincipalId: 'owner', requestTimeoutMs: 2000,
    ...(automatic ? { wakeByThread: { outbox, ensureBinding: async (id: string) => {
      enrollments.push(id)
      const binding = { bindingId: 'auto-test', threadId: id, principal: 'owner', workspace: root,
        serverIdentity: 'server', enabled: true, expiresAt: Date.now() + 60000 }
      await outbox.registerBinding(binding)
      return binding
    } } } : {}) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'controlled-client', version: '1' })
  await proxy.connect(b)
  await client.connect(a)
  t.after(async () => {
    await client.close(); await proxy.close(); await authority.drain()
    await new Promise<void>(resolve => http.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  return { client, large, outbox, enrollments, waitArguments }
}
