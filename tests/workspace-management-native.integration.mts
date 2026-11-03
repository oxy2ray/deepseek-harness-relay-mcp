// Native Host + Relay MCP integration test. It never starts a model task or discovers a shared Relay.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { readEndpointDescriptor } from '../src/stdio-proxy/descriptor-reader.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidateRoot = join(repoRoot, '.runtime/dsh-candidate')
const testRootInput = process.env.WORKSPACE_MANAGEMENT_TEST_ROOT
const descriptorInput = process.env.WORKSPACE_MANAGEMENT_DESCRIPTOR
const allowedRootInput = process.env.WORKSPACE_MANAGEMENT_ALLOWED_ROOT
const evidenceInput = process.env.WORKSPACE_MANAGEMENT_EVIDENCE

if (!testRootInput || !descriptorInput || !allowedRootInput || !evidenceInput) {
  test.skip('native workspace management requires explicit private candidate root, descriptor, allowed root and fixture evidence paths', () => {})
} else test('native Relay registers workspaces and archives/unarchives only verified idle sessions', async t => {
  const [testRoot, descriptorPath, allowedRoot, evidencePath] = await Promise.all([
    realpath(testRootInput), realpath(descriptorInput), realpath(allowedRootInput), realpath(evidenceInput),
  ])
  assert.ok(isWithin(candidateRoot, testRoot), 'candidate state must remain in the private test directory')
  assert.ok(isWithin(testRoot, descriptorPath), 'Relay descriptor must be private to the candidate Host')
  assert.ok(isWithin(testRoot, evidencePath), 'fixture evidence must remain private to the candidate Host')
  assert.ok(isWithin(testRoot, allowedRoot), 'registration root must remain private to the candidate Host')
  assert.equal(allowedRoot, await realpath(join(testRoot, 'workspace')), 'allowed root must be the candidate fixture workspace')

  const descriptor = await readEndpointDescriptor(descriptorPath)
  for (const endpoint of [descriptor.mcpUrl, descriptor.hostWebUrl]) {
    const url = new URL(endpoint)
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'candidate Host must be loopback only')
    assert.notEqual(url.port, '3080', 'refuse the shared Host port')
  }
  assert.ok(isWithin(testRoot, await realpath(descriptor.tokenFilePath)), 'candidate Relay token file must remain private')

  const fixture = asRecord(JSON.parse(await readFile(evidencePath, 'utf8')) as unknown)
  assert.ok(fixture && fixture.schemaVersion === 1 && fixture.modelTaskSubmitted === false && fixture.credentialsCopied === false)
  assert.equal(fixture.sessionsVerifiedBlankAndIdle, true)
  const fixtureWorkspace = asRecord(fixture.workspace)
  assert.ok(fixtureWorkspace)
  const fixtureWorkspaceId = nonEmptyString(fixtureWorkspace.workspaceId)
  const fixtureWorkspacePath = await realpath(nonEmptyString(fixtureWorkspace.path))
  const archiveSessionId = nonEmptyString(fixture.archiveSessionId)
  const untouchedSessionId = nonEmptyString(fixture.untouchedSessionId)
  assert.notEqual(archiveSessionId, untouchedSessionId)
  assert.equal(fixtureWorkspacePath, allowedRoot)

  const registrationPath = join(allowedRoot, `workspace-management-${randomUUID()}`)
  await mkdir(registrationPath, { mode: 0o700 })
  const canonicalRegistrationPath = await realpath(registrationPath)
  assert.ok(isWithin(allowedRoot, canonicalRegistrationPath))

  const proxy = new StdioProxyFacade({
    descriptorFile: descriptorPath,
    clientPrincipalId: `workspace-management-${randomUUID().slice(0, 8)}`,
    requestTimeoutMs: 10_000,
    autoStart: false,
  })
  const client = new Client({ name: 'workspace-management-native-test', version: '1.0.0' })
  t.after(async () => { await Promise.allSettled([client.close(), proxy.close()]) })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  await client.connect(clientTransport)

  const tools = await client.listTools()
  const names = new Set(tools.tools.map(tool => tool.name))
  for (const name of ['list_workspaces', 'list_workspace_sessions', 'register_workspace', 'archive_session', 'unarchive_session']) {
    assert.ok(names.has(name), `native Relay MCP tool ${name} must be available`)
  }

  const baseline = await listWorkspaces(client)
  assert.ok(baseline.some(item => item.workspaceId === fixtureWorkspaceId && samePath(item.path, fixtureWorkspacePath)))
  const baselineOtherRows = baseline.map(projectWorkspace).sort(compareWorkspace)

  const firstRegistration = await call(client, 'register_workspace', { workspace: registrationPath })
  const firstWorkspace = asRecord(firstRegistration.workspace)
  assert.ok(firstWorkspace)
  const newWorkspaceId = nonEmptyString(firstWorkspace.workspaceId)
  assert.equal(await realpath(nonEmptyString(firstWorkspace.path)), canonicalRegistrationPath)
  assert.equal(firstRegistration.registered, true)
  assert.equal(firstWorkspace.sessionCount, 0)

  const repeatedRegistration = await call(client, 'register_workspace', { workspace: registrationPath })
  const repeatedWorkspace = asRecord(repeatedRegistration.workspace)
  assert.ok(repeatedWorkspace)
  assert.equal(repeatedWorkspace.workspaceId, newWorkspaceId, 'same canonical path must be idempotent')
  assert.equal(await realpath(nonEmptyString(repeatedWorkspace.path)), canonicalRegistrationPath)

  const afterRegistration = await listWorkspaces(client)
  assert.deepEqual(afterRegistration.filter(item => item.workspaceId !== newWorkspaceId).map(projectWorkspace).sort(compareWorkspace), baselineOtherRows,
    'registration must leave all pre-existing workspace rows unchanged')
  assert.equal(afterRegistration.filter(item => item.workspaceId === newWorkspaceId).length, 1)

  const initialSessions = await listWorkspaceSessions(client, fixtureWorkspacePath)
  const initialArchiveRow = initialSessions.find(item => item.sessionId === archiveSessionId)
  const initialUntouchedRow = initialSessions.find(item => item.sessionId === untouchedSessionId)
  assert.ok(initialArchiveRow?.blank && !initialArchiveRow.running && !initialArchiveRow.archived)
  assert.ok(initialUntouchedRow?.blank && !initialUntouchedRow.running && !initialUntouchedRow.archived)

  const wrongWorkspaceArchive = await client.callTool({ name: 'archive_session', arguments: { workspace: canonicalRegistrationPath, sessionId: archiveSessionId } })
  assertErrorCode(wrongWorkspaceArchive, 'SESSION_SCOPE_MISMATCH')
  const wrongWorkspaceUnarchive = await client.callTool({ name: 'unarchive_session', arguments: { workspace: canonicalRegistrationPath, sessionId: archiveSessionId } })
  assertErrorCode(wrongWorkspaceUnarchive, 'SESSION_SCOPE_MISMATCH')

  const archived = await call(client, 'archive_session', { workspace: fixtureWorkspacePath, sessionId: archiveSessionId })
  assert.equal(archived.archived, true)
  const archivedSessions = await listWorkspaceSessions(client, fixtureWorkspacePath)
  assert.equal(archivedSessions.find(item => item.sessionId === archiveSessionId)?.archived, true)
  assert.equal(archivedSessions.find(item => item.sessionId === untouchedSessionId)?.archived, false)
  assert.equal(archivedSessions.find(item => item.sessionId === untouchedSessionId)?.running, false)

  const unarchived = await call(client, 'unarchive_session', { workspace: fixtureWorkspacePath, sessionId: archiveSessionId })
  assert.equal(unarchived.archived, false)
  const finalSessions = await listWorkspaceSessions(client, fixtureWorkspacePath)
  assert.equal(finalSessions.find(item => item.sessionId === archiveSessionId)?.archived, false)
  assert.equal(finalSessions.find(item => item.sessionId === untouchedSessionId)?.archived, false)
  assert.equal(finalSessions.find(item => item.sessionId === archiveSessionId)?.running, false)
  assert.equal(finalSessions.find(item => item.sessionId === untouchedSessionId)?.running, false)

  const finalWorkspaces = await listWorkspaces(client)
  assert.deepEqual(finalWorkspaces.filter(item => item.workspaceId !== newWorkspaceId).map(projectWorkspace).sort(compareWorkspace), baselineOtherRows,
    'archive lifecycle must not alter other workspace registrations')
  assert.equal(finalWorkspaces.filter(item => item.workspaceId === newWorkspaceId).length, 1)
  console.log(JSON.stringify({
    nativeHostMcp: true,
    registeredWorkspaceId: newWorkspaceId,
    repeatedRegistrationSameId: true,
    fixtureWorkspaceId,
    archiveSessionId,
    untouchedSessionId,
    wrongWorkspaceArchiveRejected: true,
    wrongWorkspaceUnarchiveRejected: true,
    archivedThenUnarchived: true,
    otherWorkspaceRowsUnchanged: true,
    modelTaskSubmitted: false,
    credentialsCopied: false,
  }))
})

interface WorkspaceProjection {
  workspaceId: string
  path: string
  title: string
  sessionCount: number
}

interface SessionProjection {
  sessionId: string
  running: boolean
  blank: boolean
  archived: boolean
}

async function listWorkspaces(client: Client): Promise<WorkspaceProjection[]> {
  const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
  const value = asRecord(requireSuccess(result, 'list_workspaces').structuredContent)
  assert.ok(value && Array.isArray(value.workspaces))
  return value.workspaces.map((workspace: unknown) => {
    const row = asRecord(workspace)
    assert.ok(row)
    return {
      workspaceId: nonEmptyString(row.workspaceId),
      path: nonEmptyString(row.path),
      title: nonEmptyString(row.title),
      sessionCount: integer(row.sessionCount),
    }
  })
}

async function listWorkspaceSessions(client: Client, workspacePath: string): Promise<SessionProjection[]> {
  const result = await client.callTool({ name: 'list_workspace_sessions', arguments: { workspace: workspacePath } })
  const value = asRecord(requireSuccess(result, 'list_workspace_sessions').structuredContent)
  assert.ok(value && Array.isArray(value.sessions))
  return value.sessions.map((session: unknown) => {
    const row = asRecord(session)
    assert.ok(row)
    return {
      sessionId: nonEmptyString(row.sessionId),
      running: row.running === true,
      blank: row.blank === true,
      archived: row.archived === true,
    }
  })
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return asRecord(requireSuccess(result, name).structuredContent) ?? {}
}

function requireSuccess(result: unknown, operation: string): Record<string, unknown> {
  const record = asRecord(result)
  assert.ok(record)
  assert.notEqual(record.isError, true, `${operation} failed: ${contentText(record)}`)
  assert.ok(record.structuredContent && typeof record.structuredContent === 'object', `${operation} omitted structured output`)
  return record
}

function assertErrorCode(result: unknown, code: string): void {
  const record = asRecord(result)
  assert.ok(record)
  assert.equal(record.isError, true, `expected ${code} rejection, received ${contentText(record)}`)
  assert.equal(asRecord(record.structuredContent)?.code, code, `expected ${code} rejection`)
}

function contentText(result: Record<string, unknown>): string {
  return Array.isArray(result.content) ? result.content.map(item => asRecord(item)?.text).filter((text): text is string => typeof text === 'string').join('\n') : ''
}

function projectWorkspace(workspace: WorkspaceProjection): WorkspaceProjection {
  return { workspaceId: workspace.workspaceId, path: workspace.path, title: workspace.title, sessionCount: workspace.sessionCount }
}

function compareWorkspace(left: WorkspaceProjection, right: WorkspaceProjection): number {
  return left.workspaceId.localeCompare(right.workspaceId)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US') : resolve(left) === resolve(right)
}

function isWithin(parent: string, path: string): boolean {
  const suffix = relative(parent, path)
  return suffix !== '' && !isAbsolute(suffix) && suffix.split(sep)[0] !== '..'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonEmptyString(value: unknown): string {
  assert.equal(typeof value, 'string')
  assert.notEqual(value, '')
  return value as string
}

function integer(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  return value as number
}
