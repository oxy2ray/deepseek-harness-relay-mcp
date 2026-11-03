import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig } from '../src/config.js'
import { HostRpcError } from '../src/harness-gateway/index.js'
import { RelayFacade, RelayError } from '../src/relay-broker/index.js'
import { createServer } from '../src/mcp-server/index.js'
import type { RunSnapshot } from '../src/types.js'
import { UserInteractionFacade, type InteractionAgent } from '../src/user-interactions/index.js'

test('register_workspace is idempotent, confirms the registry and preserves unrelated entries', async t => {
  const f = await fixture(t)
  const before = structuredClone(f.workspaces)
  const first = await f.relay.registerWorkspace(f.newProject)
  const second = await f.relay.registerWorkspace(f.newProject)
  assert.deepEqual(first, second)
  assert.equal(first.registered, true)
  assert.equal(f.calls.filter(call => call.method === 'workspace.create').length, 1)
  assert.deepEqual(f.workspaces.slice(0, before.length), before)
  assert.equal(f.calls.some(call => /prompt|cancel|settings|selectModel/u.test(call.method)), false)

  const registryOnly = new RelayFacade({ ...f.config, allowedWorkspaceRoots: [] }, f.fetch)
  assert.deepEqual(await registryOnly.registerWorkspace(f.newProject), first)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await assert.rejects(registryOnly.registerWorkspace(outside), /DSH_RELAY_ALLOWED_WORKSPACE_ROOTS/u)
  await assert.rejects(f.relay.registerWorkspace(outside), /outside DSH_RELAY_ALLOWED_WORKSPACE_ROOTS/u)
  assert.equal(f.calls.filter(call => call.method === 'workspace.create').length, 1)
})

test('registration does not claim success from an unverified create acknowledgement', async t => {
  const f = await fixture(t)
  f.ackOnly = true
  await assert.rejects(f.relay.registerWorkspace(f.newProject), (error: unknown) =>
    error instanceof HostRpcError && error.code === 'WORKSPACE_REGISTRATION_UNVERIFIED')
})

test('archive and unarchive retain workspace membership, are reversible and return only scoped state', async t => {
  const f = await fixture(t)
  const before = structuredClone(f.workspaces)
  for (const expected of [true, true, false, false]) {
    const result = expected ? await f.relay.archiveSession(f.input) : await f.relay.unarchiveSession(f.input)
    assert.equal(result.sessionId, 'session-target')
    assert.equal(result.archived, expected)
    assert.equal('archivedSessionIds' in result, false)
    assert.equal(JSON.stringify(result).includes('unrelated-archive'), false)
    assert.equal(f.archived.has('unrelated-archive'), true)
    assert.deepEqual(f.workspaces, before)
  }
  const mutations = f.calls.filter(call => /workspace\.(?:un)?archiveSession/u.test(call.method))
  assert.equal(mutations.length, 4)
  assert.deepEqual(mutations[0]?.payload, { sessionId: 'session-target', stopActivity: false })
  assert.deepEqual(mutations[2]?.payload, { sessionId: 'session-target' })
})

test('scope, native subagent and active-session checks reject before archive dispatch', async t => {
  const f = await fixture(t)
  await assert.rejects(f.relay.archiveSession({ workspace: f.otherProject, sessionId: 'session-target' }), /does not belong/u)
  await assert.rejects(f.relay.unarchiveSession({ ...f.input, sessionId: 'unrelated-archive' }), /does not belong/u)
  f.sessions[0]!.origin = 'subagent'
  await assert.rejects(f.relay.archiveSession(f.input), /could not be verified/u)
  f.sessions[0]!.origin = undefined
  f.sessions[0]!.running = true
  await assert.rejects(f.relay.archiveSession(f.input), (error: unknown) => error instanceof RelayError && error.code === 'SESSION_ACTIVE')
  assert.equal(f.calls.some(call => /archiveSession/u.test(call.method)), false)
})

test('native activity refusal after the idle precheck is preserved and never stops work', async t => {
  const f = await fixture(t)
  f.rejectActive = true
  await assert.rejects(f.relay.archiveSession(f.input), (error: unknown) =>
    error instanceof HostRpcError && error.code === 'workspace/session-active')
  assert.equal(f.archived.has('session-target'), false)
  assert.equal(f.calls.some(call => /cancel|prompt/u.test(call.method)), false)
  f.rejectActive = false
  assert.equal((await f.relay.archiveSession(f.input)).archived, true, 'failed mutations release their session lock')
})

test('the archive critical section excludes concurrent archive and start_run admission', async t => {
  const f = await fixture(t)
  let entered!: () => void
  let release!: () => void
  const admitted = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.beforeArchive = async () => { entered(); await gate }
  const archiving = f.relay.archiveSession(f.input)
  await admitted
  try {
    await assert.rejects(f.relay.archiveSession(f.input), /Another operation owns/u)
    await assert.rejects(f.relay.startRun({ workspace: f.input.workspace, sessionId: f.input.sessionId, task: 'Synthetic scope-only admission check.' }), /active DSH Relay run/u)
    assert.equal(f.calls.some(call => /prompt|selectModel|settings/u.test(call.method)), false)
  } finally { release() }
  assert.equal((await archiving).archived, true)
})

test('persisted needs_attention and permission-restore failures block archival even when Host is idle', async t => {
  const f = await fixture(t)
  await seedAttentionState(f)
  const restored = new RelayFacade(f.config, f.fetch)
  await assert.rejects(restored.archiveSession(f.input), /Reconcile unfinished Relay work or permission restoration/u)
  assert.equal(f.calls.some(call => /archiveSession/u.test(call.method)), false)
})

test('a pending native interaction blocks archive without answering or cancelling the request', async t => {
  const f = await fixture(t)
  const runId = await seedAttentionState(f)
  const agent: InteractionAgent = { id: 'agent-pending', session: { id: f.input.sessionId }, ctx: {
    effect(install) { const dispose = install(); return dispose },
  } }
  const interactions = new UserInteractionFacade(() => ({ runId, sessionId: f.input.sessionId, clientPrincipalId: 'local-user' }))
  const pending = interactions.approval({ agent, toolName: 'synthetic-read', reason: 'Fixture request' }, async () => 'unavailable')
  const restored = new RelayFacade(f.config, f.fetch, undefined, { interactions })
  try {
    await assert.rejects(restored.archiveSession(f.input), /Resolve the pending session interaction/u)
    assert.equal(interactions.list(runId, 'local-user').length, 1)
    assert.equal(f.calls.some(call => /archiveSession|cancel|prompt/u.test(call.method)), false)
  } finally { interactions.dispose(); await pending }
})

async function seedAttentionState(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const now = new Date().toISOString()
  const snapshot: RunSnapshot = {
    runId: randomUUID(), serviceId: randomUUID(), sessionId: f.input.sessionId, sessionReused: false,
    parentRunId: null, workspace: f.input.workspace, webUrl: 'http://127.0.0.1:1/', status: 'needs_attention',
    attentionReason: 'permission_restore_failed', modelSelection: null, permissionPreset: 'read-only', agentPreset: null,
    modelDefaultRestore: 'not-needed', warnings: [], task: '', taskPersisted: false, taskImageCount: 0,
    cancelRequested: false, startedAt: now, finishedAt: now, promptAdmission: 'accepted', promptMessageId: null,
    assistantText: '', assistantTextBytes: 0, assistantTextTruncated: false, lastEventSeq: 0, error: null,
  }
  await writeFile(f.config.stateFile, JSON.stringify({ schemaVersion: 2, services: [], operations: [], permissionLeases: [],
    runs: [{ snapshot, baselineSeq: 0, promptRpcId: randomUUID() }] }), { mode: 0o600 })
  return snapshot.runId
}

test('MCP management schemas reject stopActivity and path-policy overrides without side effects', async t => {
  const f = await fixture(t)
  const server = createServer(f.relay, f.config)
  const client = new Client({ name: 'workspace-management-test', version: '1' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  t.after(async () => { await client.close(); await server.close() })
  await server.connect(serverSide)
  await client.connect(clientSide)
  const tools = (await client.listTools()).tools
  for (const name of ['register_workspace', 'archive_session', 'unarchive_session']) {
    const tool = tools.find(item => item.name === name)!
    assert.equal(tool.annotations?.readOnlyHint, false)
    assert.equal(tool.annotations?.destructiveHint, false)
    assert.equal(tool.annotations?.idempotentHint, true)
    assert.equal(tool.inputSchema.additionalProperties, false)
  }
  for (const call of [
    { name: 'register_workspace', arguments: { workspace: f.newProject, allowedRoots: [f.root] } },
    { name: 'archive_session', arguments: { ...f.input, stopActivity: true } },
  ]) assert.equal((await client.callTool(call)).isError, true)
  assert.equal(f.calls.length, 0)
  const registered = await client.callTool({ name: 'register_workspace', arguments: { workspace: f.newProject } })
  assert.equal(registered.isError, undefined)
  assert.equal((registered.structuredContent as { registered: boolean }).registered, true)
  for (const name of ['archive_session', 'unarchive_session']) {
    const result = await client.callTool({ name, arguments: f.input })
    assert.equal(result.isError, undefined)
    assert.equal((result.structuredContent as { archived: boolean }).archived, name === 'archive_session')
  }
})

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-workspace-management-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const allowed = join(root, 'allowed')
  const project = join(allowed, 'project'), newProject = join(allowed, 'new-project'), otherProject = join(allowed, 'other')
  await Promise.all([mkdir(project, { recursive: true }), mkdir(newProject, { recursive: true }), mkdir(otherProject, { recursive: true })])
  const view = (path: string, workspaceId: string, sessionIds: string[]) => ({
    workspaceId, path, title: workspaceId, sessionIds, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  const config = resolveConfig({ DSH_RELAY_HOST_URL: 'http://127.0.0.1:1/', DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: allowed,
    DSH_RELAY_STATE_FILE: join(root, 'state.json') })
  const f = {
    root, newProject, otherProject, config, input: { workspace: project, sessionId: 'session-target' },
    workspaces: [view(project, 'workspace-target', ['session-target']), view(otherProject, 'workspace-other', ['session-other'])],
    sessions: [{ sessionId: 'session-target', running: false, blank: false, updatedAt: 1, cwd: project, origin: undefined as 'subagent' | undefined }],
    archived: new Set(['unrelated-archive']), calls: [] as Array<{ method: string; payload: Record<string, unknown> }>,
    ackOnly: false, rejectActive: false, beforeArchive: undefined as (() => Promise<void>) | undefined,
    fetch: undefined as unknown as typeof fetch, relay: undefined as unknown as RelayFacade,
  }
  f.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    f.calls.push(request)
    let value: unknown
    switch (request.method) {
      case 'workspace.list': value = { items: f.workspaces, archivedSessionIds: [...f.archived] }; break
      case 'workspace.create': {
        const row = view(String(request.payload.path), 'workspace-new', [])
        if (!f.ackOnly) f.workspaces.push(row)
        value = { workspace: row }; break
      }
      case 'session.list': value = { items: f.sessions }; break
      case 'host.describe': value = {}; break
      case 'workspace.archiveSession':
        await f.beforeArchive?.()
        if (f.rejectActive) return Response.json({ rpcId: request.rpcId, result: { ok: false, error: { code: 'workspace/session-active', message: 'Synthetic active job' } } })
        f.archived.add(String(request.payload.sessionId))
        value = { archivedSessionIds: [...f.archived] }; break
      case 'workspace.unarchiveSession':
        f.archived.delete(String(request.payload.sessionId))
        value = { archivedSessionIds: [...f.archived] }; break
      default: throw new Error(`Unexpected Host call: ${request.method}`)
    }
    return Response.json({ rpcId: request.rpcId, result: { ok: true, value } })
  }
  f.relay = new RelayFacade(config, f.fetch)
  return f
}
