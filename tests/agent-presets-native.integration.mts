// Read-only Relay MCP verification against an explicitly isolated native Host.
// The fixture only registers metadata and creates a blank Session; no model task is submitted.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { readEndpointDescriptor } from '../src/stdio-proxy/descriptor-reader.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidateRoot = join(repoRoot, '.runtime/dsh-candidate')
const testRootInput = process.env.AGENT_PRESETS_TEST_ROOT
const descriptorInput = process.env.AGENT_PRESETS_DESCRIPTOR
const workspaceInput = process.env.AGENT_PRESETS_WORKSPACE
const evidenceInput = process.env.AGENT_PRESETS_EVIDENCE
const controlInput = process.env.AGENT_PRESETS_CONTROL

if (!testRootInput || !descriptorInput || !workspaceInput || !evidenceInput || !controlInput) {
  test.skip('native preset integration requires explicit private candidate Host, descriptor, workspace, evidence, and control paths', () => {})
} else test('native Relay lists live preset metadata and verifies native Session preset selection', async t => {
  const [testRoot, descriptorPath, workspacePath, evidenceParent, controlParent] = await Promise.all([
    realpath(testRootInput), realpath(descriptorInput), realpath(workspaceInput),
    realpath(dirname(evidenceInput)), realpath(dirname(controlInput)),
  ])
  const evidenceCandidate = join(evidenceParent, basename(resolve(evidenceInput)))
  const controlPath = join(controlParent, controlInput.slice(controlInput.lastIndexOf(sep) + 1))
  assert.ok(isWithin(candidateRoot, testRoot), 'private candidate state must remain under the checked-out candidate package')
  for (const path of [descriptorPath, workspacePath, evidenceCandidate, controlPath]) {
    assert.ok(isWithin(testRoot, path), 'descriptor, workspace, evidence, and control must remain in the private test root')
  }
  assert.equal(await realpath(dirname(descriptorPath)), dirname(descriptorPath), 'descriptor parent must be canonical')

  // The private fixture starts asynchronously after Loader readiness. Poll for
  // initial evidence before requiring that the fixture-created file exist.
  const phaseOne = await waitForEvidence(evidenceCandidate, 1, testRoot)
  const evidencePath = await realpath(evidenceCandidate)
  assert.ok(isWithin(testRoot, evidencePath), 'fixture evidence must resolve inside the private test root')

  const descriptor = await readEndpointDescriptor(descriptorPath)
  for (const endpoint of [descriptor.mcpUrl, descriptor.hostWebUrl]) {
    const url = new URL(endpoint)
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'candidate Host endpoints must be loopback only')
    assert.notEqual(url.port, '3080', 'refuse the shared Host port')
  }
  assert.ok(isWithin(testRoot, await realpath(descriptor.tokenFilePath)), 'candidate Relay token must remain private')

  const proxy = new StdioProxyFacade({
    descriptorFile: descriptorPath,
    clientPrincipalId: `agent-presets-${randomUUID().slice(0, 8)}`,
    requestTimeoutMs: 10_000,
    autoStart: false,
  })
  const client = new Client({ name: 'agent-presets-native-test', version: '1.0.0' })
  t.after(async () => { await Promise.allSettled([client.close(), proxy.close()]) })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  await client.connect(clientTransport)

  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map(tool => tool.name))
  assert.ok(toolNames.has('list_agent_presets'))
  assert.ok(toolNames.has('list_workspace_sessions'))
  for (const forbiddenTaskTool of ['start_run', 'start_review', 'reply_run']) {
    assert.ok(toolNames.has(forbiddenTaskTool), `native Relay should expose ${forbiddenTaskTool}; this test must not invoke it`)
  }

  assertFixtureEvidence(phaseOne, workspacePath)
  const firstCatalog = await listAgentPresets(client)
  assertCatalogMatchesEvidence(firstCatalog, phaseOne)
  const selectedSession = await listWorkspaceSession(client, workspacePath, string(phaseOne.sessionId))
  assert.equal(selectedSession.agentPreset, 'relay-fixture-preset', 'native Session must retain the exact selected preset id')
  assert.equal(selectedSession.blank, true)
  assert.equal(selectedSession.running, false)

  await writeFile(controlPath, '{"phase":2}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const phaseTwo = await waitForEvidence(evidencePath, 2, testRoot)
  assertFixtureEvidence(phaseTwo, workspacePath)
  assert.equal(phaseTwo.sessionId, phaseOne.sessionId, 'metadata refresh must not create or replace a Session')
  const secondCatalog = await listAgentPresets(client)
  assertCatalogMatchesEvidence(secondCatalog, phaseTwo)
  const changedPreset = secondCatalog.presets.find(row => row.id === 'relay-fixture-preset')
  assert.equal(changedPreset?.name, 'Fixture name 2')
  assert.equal(changedPreset?.description, 'Fixture desc 2')
  assert.equal(secondCatalog.presets.some(row => row.name === 'Fixture name 1' || row.description === 'Fixture desc 1'), false,
    'fresh native catalog must not retain stale fixture metadata')

  console.log(JSON.stringify({
    nativeHostMcp: true,
    privateCandidateHost: true,
    fixturePresetListedFromNativeCatalog: true,
    samePresetIdMetadataChanged: true,
    defaultFlagsMatchedNativeRoster: true,
    missingDisplayMetadataMatchedNativeRoster: true,
    selectedSessionPresetVerified: true,
    modelTaskSubmitted: false,
    credentialsCopied: false,
  }))
})

async function waitForEvidence(path: string, phase: number, privateRoot: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const stat = await lstat(path)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'fixture evidence must be a regular private file')
      assert.ok(isWithin(privateRoot, await realpath(path)), 'fixture evidence must resolve inside the private test root')
      const record = asRecord(JSON.parse(await readFile(path, 'utf8')))
      assert.ok(record)
      if (record.phase === 'error') {
        throw new Error(`private preset fixture failed at ${String(record.stage)} (${String(record.errorType)})`)
      }
      if (record.phase === phase) return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for private native preset fixture phase ${phase}`)
}

function assertFixtureEvidence(evidence: Record<string, unknown>, workspacePath: string): void {
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.modelTaskSubmitted, false)
  assert.equal(evidence.credentialsCopied, false)
  assert.equal(evidence.sessionVerifiedBlankAndIdle, true)
  const workspace = asRecord(evidence.workspace)
  assert.ok(workspace)
  assert.equal(resolve(string(workspace.path)), workspacePath)
  assert.equal(evidence.selectedAgentPreset, 'relay-fixture-preset')
  const definition = asRecord(evidence.registeredPreset)
  assert.ok(definition)
  assert.equal(definition.id, 'relay-fixture-preset')
  assert.equal(definition.plugins && Array.isArray(definition.plugins) && definition.plugins.length, 0)
}

async function listAgentPresets(client: Client): Promise<PresetCatalog> {
  const result = await client.callTool({ name: 'list_agent_presets', arguments: {} })
  const value = asRecord(requireSuccess(result, 'list_agent_presets').structuredContent)
  assert.ok(value && Array.isArray(value.presets) && Array.isArray(value.missingDisplayMetadata))
  assert.equal(value.metadataSource, 'harness-live')
  return value as unknown as PresetCatalog
}

function assertCatalogMatchesEvidence(catalog: PresetCatalog, evidence: Record<string, unknown>): void {
  const roster = asRecord(evidence.nativeRoster)
  assert.ok(roster && Array.isArray(roster.presets), 'fixture must record the official native preset registry roster')
  const nativeRows = roster.presets.map(projectNativePreset)
  const relayRows = catalog.presets.map(projectNativePreset)
  assert.deepEqual(relayRows, nativeRows, 'Relay catalog rows must exactly reflect the native registry, including default flags and absent fields')
  const expectedMissing = nativeRows.flatMap(row => {
    const fields = [
      ...(row.name === undefined ? ['name'] : []),
      ...(row.description === undefined ? ['description'] : []),
    ]
    return fields.length === 0 ? [] : [{ id: row.id, fields }]
  })
  assert.deepEqual(catalog.missingDisplayMetadata, expectedMissing,
    'missingDisplayMetadata must correspond exactly to fields omitted by the native registry')
  const fixture = nativeRows.find(row => row.id === 'relay-fixture-preset')
  const definition = asRecord(evidence.registeredPreset)
  assert.ok(fixture && definition)
  assert.equal(fixture.name, definition.name)
  assert.equal(fixture.description, definition.description)
  assert.equal(typeof fixture.isDefault, 'boolean')
  for (const row of catalog.presets) assert.equal(typeof row.isDefault, 'boolean')
}

async function listWorkspaceSession(client: Client, workspace: string, sessionId: string): Promise<SessionProjection> {
  const result = await client.callTool({ name: 'list_workspace_sessions', arguments: { workspace } })
  const value = asRecord(requireSuccess(result, 'list_workspace_sessions').structuredContent)
  assert.ok(value && Array.isArray(value.sessions))
  const row = value.sessions.map(asRecord).find(item => item?.sessionId === sessionId)
  assert.ok(row)
  return {
    sessionId: string(row.sessionId),
    agentPreset: string(row.agentPreset),
    blank: row.blank === true,
    running: row.running === true,
  }
}

function requireSuccess(result: unknown, operation: string): Record<string, unknown> {
  const record = asRecord(result)
  assert.ok(record)
  assert.notEqual(record.isError, true, `${operation} failed: ${contentText(record)}`)
  assert.ok(record.structuredContent && typeof record.structuredContent === 'object', `${operation} omitted structured output`)
  return record
}

function contentText(result: Record<string, unknown>): string {
  return Array.isArray(result.content)
    ? result.content.map(item => asRecord(item)?.text).filter((text): text is string => typeof text === 'string').join('\n')
    : ''
}

function projectNativePreset(value: unknown): PresetRow {
  const row = asRecord(value)
  assert.ok(row)
  assert.equal(typeof row.id, 'string')
  assert.equal(typeof row.isDefault, 'boolean')
  const projected: PresetRow = { id: row.id as string, isDefault: row.isDefault as boolean }
  for (const key of ['name', 'description', 'order', 'broken'] as const) {
    if (row[key] !== undefined) projected[key] = row[key] as never
  }
  return projected
}

function isWithin(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate)
  return suffix !== '' && !isAbsolute(suffix) && suffix.split(sep)[0] !== '..'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown): string {
  assert.equal(typeof value, 'string')
  assert.notEqual(value, '')
  return value as string
}

interface PresetRow {
  id: string
  isDefault: boolean
  name?: unknown
  description?: unknown
  order?: unknown
  broken?: unknown
}

interface PresetCatalog {
  presets: PresetRow[]
  metadataSource: string
  missingDisplayMetadata: Array<{ id: string; fields: string[] }>
}

interface SessionProjection {
  sessionId: string
  agentPreset: string
  blank: boolean
  running: boolean
}
