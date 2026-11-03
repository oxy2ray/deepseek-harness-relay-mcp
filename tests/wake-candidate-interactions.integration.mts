// Read-only native tool catalog check against a separately launched candidate DSH Host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import { readEndpointDescriptor } from '../src/stdio-proxy/descriptor-reader.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidateRuntimeRoot = join(repoRoot, '.runtime/dsh-candidate')

test('candidate launcher rejects raw credential-store mode before creating a runtime', async () => {
  const root = join(candidateRuntimeRoot, `credential-mode-guard-${randomUUID()}`)
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts/wake-isolated-dsh.mjs'), root,
    join(repoRoot, 'dist/dsh-relay-harness.mjs'),
    join(candidateRuntimeRoot, 'node_modules'),
    join(candidateRuntimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(candidateRuntimeRoot, 'readonly-credentials-only.json'), 'readonly-api-credentials',
    join(candidateRuntimeRoot, 'provider-only-luna-fixed.patch.yml'),
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /readonly-api-credentials mode is disabled/u)
  await assert.rejects(realpath(root), { code: 'ENOENT' })
})

test('candidate launcher rejects every raw credential-store mount before creating mount staging', async () => {
  const root = join(candidateRuntimeRoot, `credential-mount-guard-${randomUUID()}`)
  try {
    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts/wake-isolated-dsh.mjs'), root,
      join(repoRoot, 'dist/dsh-relay-harness.mjs'),
      join(candidateRuntimeRoot, 'node_modules'),
      join(candidateRuntimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      join(candidateRuntimeRoot, 'readonly-credentials-only.json'),
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /shared credential store mounts are disabled/u)
    await assert.rejects(realpath(join(root, 'readonly-sources')), { code: 'ENOENT' })
    await assert.rejects(realpath(join(root, 'host-owner.json')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const candidateRoot = process.env.WAKE_CANDIDATE_ROOT
const hostRoot = process.env.WAKE_CANDIDATE_HOST_ROOT
const descriptorPath = process.env.WAKE_CANDIDATE_DESCRIPTOR
const modulesRoot = process.env.WAKE_CANDIDATE_MODULES_ROOT

if (!candidateRoot || !hostRoot || !descriptorPath || !modulesRoot) {
  test.skip('candidate native-interaction check requires explicit private Host, descriptor, and module paths', () => {})
} else test('candidate DSH Host publishes native interaction tools through Relay MCP', async t => {
  const [candidate, root, descriptorFile, modules] = await Promise.all([
    realpath(candidateRoot), realpath(hostRoot), realpath(descriptorPath), realpath(modulesRoot),
  ])
  const isWithin = (parent: string, path: string) => {
    const suffix = relative(parent, path)
    return suffix !== '' && !isAbsolute(suffix) && suffix.split(/[\\/]/u)[0] !== '..'
  }
  assert.ok(isWithin(candidate, root), 'private Host state must stay under the candidate runtime root')
  assert.ok(isWithin(root, descriptorFile), 'descriptor must stay under the private Host state')
  assert.ok(isWithin(candidate, modules), 'candidate modules must stay under the candidate runtime root')
  const dshPackage = JSON.parse(await readFile(`${modules}/@deepseek-ai/dsh/package.json`, 'utf8')) as { version?: unknown }
  assert.equal(dshPackage.version, '0.2.1-rc.5')
  const descriptor = await readEndpointDescriptor(descriptorFile)
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'candidate-interactions-verifier', requestTimeoutMs: 5000, autoStart: false })
  const client = new Client({ name: 'candidate-interactions-verifier', version: '1' })
  t.after(async () => { await Promise.allSettled([client.close(), proxy.close()]) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await proxy.connect(serverSide)
  await client.connect(clientSide)
  const catalog = await client.listTools()
  const names = catalog.tools.map(tool => tool.name)
  assert.ok(names.includes('list_run_interactions'))
  assert.ok(names.includes('respond_to_run_interaction'))
  assert.ok(names.includes('get_run'))
  const capabilityResult = await client.callTool({ name: 'list_capabilities', arguments: {} }, undefined, { timeout: 15_000 })
  const routes = extractRoutes(capabilityResult.structuredContent)
  const nativeCatalog = projectNativeCatalog(capabilityResult.structuredContent)
  const capabilityError = asRecord(capabilityResult.structuredContent)
  const capabilityMessage = typeof capabilityError?.message === 'string' ? capabilityError.message : ''
  console.log(JSON.stringify({ candidateVersion: dshPackage.version, hostAuthorityId: descriptor.authorityId,
    capabilityCallSucceeded: capabilityResult.isError !== true,
    capabilityFailureCategory: capabilityResult.isError === true ? classifyProviderFailure(capabilityMessage) : undefined,
    capabilityStructuredFields: safeFieldNames(asRecord(capabilityResult.structuredContent)),
    capabilityFailureCode: safeIdentifier(asRecord(capabilityResult.structuredContent)?.code),
    capabilityFailureReasonCode: safeIdentifier(asRecord(capabilityResult.structuredContent)?.reasonCode),
    nativePeerStartup: true, nativeInteractionTools: ['list_run_interactions', 'respond_to_run_interaction'],
    catalogToolCount: names.length, routeCatalogReady: routes.length > 0, advertisedRoutes: routes, nativeCatalog,
    modelTaskSubmitted: false, credentialsCopied: false,
    credentialSourceMountedReadOnly: process.env.WAKE_CANDIDATE_CREDENTIAL_MOUNTED === 'true' }))
  assert.notEqual(capabilityResult.isError, true, 'native capability discovery must be available')
  if (process.env.WAKE_CANDIDATE_EXPECT_ROUTES === 'true') {
    assert.ok(routes.length > 0, 'candidate provider configuration must advertise at least one exact route')
  }
})

function extractRoutes(value: unknown): Array<{ provider: string; model: string }> {
  if (!value || typeof value !== 'object') return []
  const models = (value as Record<string, unknown>).models
  if (!models || typeof models !== 'object' || !Array.isArray((models as Record<string, unknown>).groups)) return []
  const routes: Array<{ provider: string; model: string }> = []
  for (const group of (models as { groups: unknown[] }).groups) {
    if (!group || typeof group !== 'object') continue
    const provider = (group as Record<string, unknown>).id
    const groupModels = (group as Record<string, unknown>).models
    if (typeof provider !== 'string' || !Array.isArray(groupModels)) continue
    for (const model of groupModels) {
      if (model && typeof model === 'object' && typeof (model as Record<string, unknown>).id === 'string') {
        routes.push({ provider, model: (model as Record<string, unknown>).id as string })
      }
    }
  }
  return routes
}

function projectNativeCatalog(value: unknown): Record<string, unknown> {
  const root = asRecord(value)
  const models = asRecord(root?.models)
  if (!models) return { structuredFields: safeFieldNames(root), modelShape: root?.models === undefined ? 'missing' : typeof root.models }
  const groups = Array.isArray(models.groups) ? models.groups.map(group => {
    const record = asRecord(group)
    const groupModels = Array.isArray(record?.models) ? record.models.map(model => {
      const item = asRecord(model)
      return { id: safeIdentifier(item?.id), name: safeIdentifier(item?.name) }
    }).filter(item => item.id !== undefined) : []
    return { provider: safeIdentifier(record?.id), name: safeIdentifier(record?.name), modelCount: groupModels.length, models: groupModels }
  }) : []
  const failures = Array.isArray(models.failures) ? models.failures.map(failure => {
    const record = asRecord(failure)
    const message = typeof record?.message === 'string' ? record.message : typeof record?.error === 'string' ? record.error : ''
    const error = asRecord(record?.error)
    return {
      provider: safeIdentifier(record?.provider ?? record?.id),
      code: safeIdentifier(record?.code ?? error?.code),
      messageCategory: classifyProviderFailure(message),
      fields: safeFieldNames(record),
    }
  }) : []
  return {
    structuredFields: safeFieldNames(root),
    modelFields: safeFieldNames(models),
    defaultRoute: projectDefaultRoute(models.default),
    routableProviders: Array.isArray(models.routableProviders) ? models.routableProviders.map(safeIdentifier).filter((id): id is string => id !== undefined) : [],
    groupCount: groups.length,
    groups,
    failureCount: failures.length,
    failures,
  }
}

function projectDefaultRoute(value: unknown): { provider?: string; model?: string } | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const provider = safeIdentifier(record.provider)
  const model = safeIdentifier(record.model)
  return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeFieldNames(value: Record<string, unknown> | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(key)).sort()
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u.test(value) ? value : undefined
}

function classifyProviderFailure(message: string): string {
  if (/credential|api[- ]?key|authentication|authorization/iu.test(message)) return 'credential'
  if (/baseurl|endpoint|protocol|api\b/iu.test(message)) return 'route-configuration'
  if (/catalog|model/iu.test(message)) return 'model-catalog'
  if (/schema|invalid|unsupported|config/iu.test(message)) return 'configuration-validation'
  return message ? 'other' : 'none'
}
