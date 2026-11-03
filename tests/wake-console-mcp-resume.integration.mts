// Real Codex App Server, isolated state, and an offline local MCP fixture. No model or shared DSH/Relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'

test('startup resume reapplies configured MCP server and read-only approval constraints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-mcp-resume-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace')
  await mkdir(state, { mode: 0o700 }); await mkdir(workspace)
  const fixturePath = join(root, 'offline-mcp-fixture.mjs')
  await writeFile(fixturePath, `
    import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))}
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}
    const server = new McpServer({ name: 'offline-wake-fixture', version: '1' })
    server.registerTool('offline_probe', { description: 'Local discovery fixture', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'offline fixture only' }] }))
    await server.connect(new StdioServerTransport())
  `)
  // Network namespace creation is not available in some containers; no model call is made by this protocol test.
  const options = { testRoot: root, stateDirectory: state, workspace, network: 'model-access' as const }
  const mcpConfig = { mcp_servers: { offline_fixture: {
    command: process.execPath, args: [fixturePath], startup_timeout_sec: 10, required: true,
  } } }
  let host = await OwnedCodexHost.launch(options)
  let threadId = ''
  const assertFixtureTool = async (current: OwnedCodexHost) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await current.process.request('mcpServerStatus/list', { threadId, serverName: 'offline_fixture' }) as {
        data?: Array<{ name?: string; tools?: Record<string, unknown> }>
      }
      const tools = status.data?.find(server => server.name === 'offline_fixture')?.tools ?? {}
      if (tools.offline_probe) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('offline MCP fixture tool did not become available')
  }
  try {
    threadId = await host.startThread(mcpConfig)
    await assertFixtureTool(host)
    const admission = await host.sendUserMessage(threadId, 'Materialize this private protocol-only thread.')
    assert.equal(admission.kind, 'accepted')
    if (admission.kind !== 'accepted') throw new Error('fixture turn was not admitted')
    let materialized = false
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await host.resumeThread(threadId); materialized = true; break }
      catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.equal(materialized, true, 'an unauthenticated private state can persist the protocol thread without model inference')
  } finally { await host.close() }

  host = await OwnedCodexHost.launch(options)
  try {
    let resumeParams: unknown
    const request = host.process.request.bind(host.process)
    host.process.request = (method, params, timeoutMs) => {
      if (method === 'thread/resume') resumeParams = params
      return timeoutMs === undefined ? request(method, params) : request(method, params, timeoutMs)
    }
    await host.resumeThread(threadId, mcpConfig)
    await assertFixtureTool(host)
    assert.deepEqual(resumeParams, { threadId, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request', config: mcpConfig })
  } finally { await host.close() }
})
