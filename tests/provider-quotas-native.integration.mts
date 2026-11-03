// Read-only acceptance test against an explicitly isolated native DSH Host.
// Quota HTTP endpoints are intercepted by the private fixture with synthetic keys.
import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { readEndpointDescriptor } from '../src/stdio-proxy/descriptor-reader.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidateRoot = join(repoRoot, '.runtime/dsh-candidate')
const testRootInput = process.env.PROVIDER_QUOTAS_TEST_ROOT
const descriptorInput = process.env.PROVIDER_QUOTAS_DESCRIPTOR
const workspaceInput = process.env.PROVIDER_QUOTAS_WORKSPACE
const evidenceInput = process.env.PROVIDER_QUOTAS_EVIDENCE
const controlInput = process.env.PROVIDER_QUOTAS_CONTROL
const syntheticSecrets = [
  'relay-fixture-opencode-key-v1',
  'relay-fixture-ark-ak-v1',
  'relay-fixture-ark-sk-v1',
]

if (![testRootInput, descriptorInput, workspaceInput, evidenceInput, controlInput].every(Boolean)) {
  test.skip('native provider quota integration requires explicit private candidate Host paths', () => {})
} else test('native Relay exposes synthetic Ark and OpenCode quota snapshots without submitting a model task', async t => {
  const [testRoot, descriptorPath, workspacePath, evidenceParent, controlParent] = await Promise.all([
    realpath(testRootInput!), realpath(descriptorInput!), realpath(workspaceInput!),
    realpath(dirname(evidenceInput!)), realpath(dirname(controlInput!)),
  ])
  const evidenceCandidate = join(evidenceParent, basename(resolve(evidenceInput!)))
  const controlPath = join(controlParent, basename(resolve(controlInput!)))
  assert.ok(isWithin(candidateRoot, testRoot), 'private DSH state must remain under the candidate package')
  for (const path of [descriptorPath, workspacePath, evidenceCandidate, controlPath]) {
    assert.ok(isWithin(testRoot, path), 'descriptor, workspace, evidence, and control must remain in the private test root')
  }
  assert.equal(await realpath(dirname(descriptorPath)), dirname(descriptorPath), 'descriptor parent must be canonical')
  assert.equal(await realpath(dirname(evidenceCandidate)), evidenceParent)
  assert.equal(await realpath(dirname(controlPath)), controlParent)

  const descriptor = await readEndpointDescriptor(descriptorPath)
  for (const endpoint of [descriptor.mcpUrl, descriptor.hostWebUrl]) {
    const url = new URL(endpoint)
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'candidate Host endpoints must be loopback only')
    assert.notEqual(url.port, '3080', 'refuse the shared Host port')
  }
  assert.ok(isWithin(testRoot, await realpath(descriptor.tokenFilePath)), 'candidate Relay token must remain private')

  const proxy = new StdioProxyFacade({
    descriptorFile: descriptorPath,
    clientPrincipalId: `provider-quotas-${randomUUID().slice(0, 8)}`,
    requestTimeoutMs: 15_000,
    autoStart: false,
  })
  const client = new Client({ name: 'provider-quotas-native-test', version: '1.0.0' })
  t.after(async () => { await Promise.allSettled([client.close(), proxy.close()]) })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  await client.connect(clientTransport)

  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map(tool => tool.name))
  assert.ok(toolNames.has('list_capabilities'))
  assert.ok(toolNames.has('list_provider_quotas'))
  assert.ok(toolNames.has('list_workspace_sessions'))
  assert.ok(toolNames.has('start_run'), 'the task tool remains available but is never invoked')

  const calledTools = ['list_capabilities']
  const capabilitiesResult = await client.callTool({ name: 'list_capabilities', arguments: {} })
  const capabilities = record(requireSuccess(capabilitiesResult, 'list_capabilities').structuredContent)
  const models = record(capabilities.models)
  assert.ok(Array.isArray(models.groups))
  const modelProviderIds = models.groups.map(item => record(item).id)
  assert.ok(modelProviderIds.includes('ark'), 'native model catalog must advertise the Ark route')
  assert.ok(modelProviderIds.includes('opencode-go'), 'native model catalog must advertise OpenCode Go')
  const firstCatalog = quotaCatalog(capabilities.providerQuotas, 'list_capabilities')
  const ark = providerSnapshot(firstCatalog, 'ark')
  const openCode = providerSnapshot(firstCatalog, 'opencode-go')
  assert.ok(ark.models.includes('relay-quota-fixture-model'))
  assert.ok(openCode.models.includes('relay-opencode-quota-fixture-model'))
  assert.equal(ark.state, 'exhausted', `Ark quota snapshot: ${JSON.stringify(ark)}`)
  assert.deepEqual(ark.windows.map(window => window.id), ['5h', 'daily', 'weekly', 'monthly'])
  assert.equal(ark.windows[0]?.usedPercent, 100)
  assert.equal(openCode.state, 'available', `OpenCode quota snapshot: ${JSON.stringify(openCode)}`)
  assert.deepEqual(openCode.windows.map(window => window.id), ['rolling', 'weekly', 'monthly'])
  assert.equal(ark.advisory, true)
  assert.equal(openCode.advisory, true)
  assert.equal(ark.modelScope, 'unknown')
  assert.equal(openCode.modelScope, 'unknown')

  const firstEvidence = await waitForEvidence(evidenceCandidate, value => {
    const events = Array.isArray(value.quotaRequests) ? value.quotaRequests.map(record) : []
    return value.ready === true && events.some(event => event.provider === 'ark' && event.phase === 1)
      && events.some(event => event.provider === 'opencode-go' && event.phase === 1)
  }, testRoot)
  await assertFixtureEvidence(firstEvidence, testRoot)
  assertFixtureSessionEvidence(firstEvidence, workspacePath)
  assert.equal(firstEvidence.modelRequestCount, 0)
  assertExpectedSyntheticRequests(firstEvidence, 1)
  assertNoSyntheticSecret(firstCatalog)

  calledTools.push('list_workspace_sessions')
  const sessionsResult = await client.callTool({ name: 'list_workspace_sessions', arguments: { workspace: workspacePath } })
  const workspaceSessions = record(requireSuccess(sessionsResult, 'list_workspace_sessions').structuredContent)
  const registeredWorkspace = record(workspaceSessions.workspace)
  assert.equal(resolve(String(registeredWorkspace.path)), workspacePath)
  assert.equal(registeredWorkspace.workspaceId, record(firstEvidence.workspace).workspaceId)
  assert.ok(Array.isArray(workspaceSessions.sessions))
  const nativeSession = workspaceSessions.sessions.map(record)
    .find(row => row.sessionId === firstEvidence.sessionId)
  assert.ok(nativeSession, 'private native session must appear in the registered workspace roster')
  assert.equal(nativeSession.blank, true)
  assert.equal(nativeSession.running, false)
  assert.equal(nativeSession.archived, false)

  await writeFile(controlPath, '{"phase":2}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const deadline = Date.now() + 22_000
  let secondCatalog: QuotaCatalog | undefined
  let secondEvidence: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    await delay(500)
    calledTools.push('list_provider_quotas')
    const result = await client.callTool({ name: 'list_provider_quotas', arguments: {} })
    secondCatalog = quotaCatalog(requireSuccess(result, 'list_provider_quotas').structuredContent, 'list_provider_quotas')
    secondEvidence = await readEvidence(evidenceCandidate, testRoot)
    const phaseTwoRequests = requestEvents(secondEvidence).filter(event => event.phase === 2)
    if (phaseTwoRequests.some(event => event.provider === 'ark')
      && phaseTwoRequests.some(event => event.provider === 'opencode-go')) break
  }
  assert.ok(secondCatalog && secondEvidence)
  assert.ok(requestEvents(secondEvidence).some(event => event.phase === 2 && event.provider === 'ark'),
    'Ark synthetic error phase must reach the native quota plugin before deadline')
  assert.ok(requestEvents(secondEvidence).some(event => event.phase === 2 && event.provider === 'opencode-go'),
    'OpenCode incomplete-window phase must reach the native quota plugin before deadline')
  assert.equal(providerSnapshot(secondCatalog, 'ark').state, 'unknown')
  assert.equal(providerSnapshot(secondCatalog, 'opencode-go').state, 'unknown')
  await assertFixtureEvidence(secondEvidence, testRoot)
  assert.equal(secondEvidence.modelRequestCount, 0)
  assertExpectedSyntheticRequests(secondEvidence, 2)
  assertNoSyntheticSecret(secondCatalog)
  assert.ok(calledTools.every(name => ['list_capabilities', 'list_provider_quotas', 'list_workspace_sessions'].includes(name)))
  assert.equal(calledTools.includes('start_run'), false)

  console.log(JSON.stringify({
    nativeHostMcp: true,
    privateCandidateHost: true,
    syntheticQuotaEndpointsIntercepted: true,
    nativeCapabilitiesReadBeforeAnyTask: true,
    arkAvailableExhaustedUnknownStatesVerified: true,
    opencodeAvailableUnknownStatesVerified: true,
    modelRequests: 0,
    modelTaskSubmitted: false,
    realCredentialsMounted: false,
  }))
})

interface QuotaCatalog { schemaVersion: 1; providers: QuotaSnapshot[] }
interface QuotaSnapshot {
  provider: string
  models: string[]
  state: string
  windows: Array<{ id: string; usedPercent: number | null; state: string }>
  advisory: boolean
  modelScope: string
}

function quotaCatalog(value: unknown, operation: string): QuotaCatalog {
  const catalog = record(value)
  assert.equal(catalog.schemaVersion, 1, `${operation} quota schema version`)
  assert.ok(Array.isArray(catalog.providers), `${operation} must include quota providers`)
  return catalog as unknown as QuotaCatalog
}

function providerSnapshot(catalog: QuotaCatalog, provider: string): QuotaSnapshot {
  const snapshot = catalog.providers.find(item => item.provider === provider)
  assert.ok(snapshot, `quota snapshot missing for ${provider}`)
  return snapshot
}

async function waitForEvidence(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
  privateRoot: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const evidence = await readEvidence(path, privateRoot)
      if (evidence.failure) throw new Error(`private quota fixture failed (${String(evidence.failure)})`)
      if (predicate(evidence)) return evidence
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('timed out waiting for native quota fixture evidence')
}

async function readEvidence(path: string, privateRoot: string): Promise<Record<string, unknown>> {
  const stat = await lstat(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'fixture evidence must be a regular private file')
  assert.ok(isWithin(privateRoot, await realpath(path)), 'fixture evidence must resolve inside the private test root')
  return record(JSON.parse(await readFile(path, 'utf8')))
}

async function assertFixtureEvidence(evidence: Record<string, unknown>, privateRoot: string): Promise<void> {
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.fixture, 'synthetic-provider-quota-http')
  assert.equal(typeof evidence.privateHome, 'string')
  assert.ok(isWithin(privateRoot, await realpath(String(evidence.privateHome))), 'private DSH_HOME must remain inside the isolated test root')
  assert.equal(typeof evidence.privateCredentialStorePresent, 'boolean')
  assert.equal(evidence.privateCredentialFilesMounted, false, 'launcher must not mount the global credentials file')
  assert.equal(evidence.ready, true)
  assert.equal(evidence.syntheticCredentialsOnly, true)
  assert.equal(evidence.credentialValuesSerialized, false)
  assert.equal(evidence.modelTaskSubmitted, false)
  assert.equal(evidence.modelRequestCount, 0)
}

function assertFixtureSessionEvidence(evidence: Record<string, unknown>, workspacePath: string): void {
  const workspace = record(evidence.workspace)
  assert.equal(resolve(String(workspace.path)), workspacePath)
  assert.equal(typeof workspace.workspaceId, 'string')
  assert.equal(typeof evidence.sessionId, 'string')
  assert.equal(evidence.nativeSessionBlankAndIdle, true)
  const selected = record(evidence.selectedModel)
  assert.equal(selected.provider, 'ark')
  assert.equal(selected.model, 'relay-quota-fixture-model')
  assert.ok(evidence.modelSelectionProjectionMatches === true || evidence.modelSelectionProjectionMatches === null)
}

function requestEvents(evidence: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(evidence.quotaRequests))
  return evidence.quotaRequests.map(record)
}

function assertExpectedSyntheticRequests(evidence: Record<string, unknown>, phase: number): void {
  const events = requestEvents(evidence).filter(event => event.phase === phase)
  for (const provider of ['ark', 'opencode-go']) {
    const matching = events.filter(event => event.provider === provider)
    assert.ok(matching.length >= 1, `no synthetic ${provider} request recorded in phase ${phase}`)
    assert.ok(matching.every(event => event.credentialMatched === true), `${provider} request did not use its synthetic credential`)
  }
}

function assertNoSyntheticSecret(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const secret of syntheticSecrets) assert.equal(serialized.includes(secret), false)
}

function requireSuccess(value: unknown, operation: string): Record<string, unknown> {
  const result = record(value)
  assert.notEqual(result.isError, true, `${operation} failed: ${contentText(result)}`)
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${operation} omitted structured output`)
  return result
}

function contentText(value: Record<string, unknown>): string {
  return Array.isArray(value.content)
    ? value.content.map(item => asRecord(item)?.text).filter((text): text is string => typeof text === 'string').join('\n')
    : ''
}

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value)
  assert.ok(result)
  return result
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isWithin(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate)
  return suffix !== '' && !isAbsolute(suffix) && suffix.split(sep)[0] !== '..'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
