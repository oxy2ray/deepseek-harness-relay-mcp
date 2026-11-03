import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProviderQuota, projectProviderQuotaCatalog } from '../src/provider-quotas/index.js'

const now = Date.parse('2026-11-02T00:00:00.000Z')
const models = ['model-a', 'model-b']

test('normalizes OpenCode provider windows without inventing model, account, or extra-usage coverage', () => {
  const snapshot = normalizeProviderQuota('opencode-go', models, openCodeResponse(), now)
  assert.equal(snapshot.state, 'available')
  assert.deepEqual(snapshot.windows.map(window => [window.id, window.usedPercent, window.resetsAt]), [
    ['rolling', 30, '2026-11-02T01:00:00.000Z'],
    ['weekly', 20, null],
    ['monthly', 10, null],
  ])
  assert.equal(snapshot.modelScope, 'unknown')
  assert.equal(snapshot.accountScope, 'unverified')
  assert.equal(snapshot.extraUsage, 'unknown')
  assert.equal(snapshot.advisory, true)
})

test('reports OpenCode extra usage only when the source explicitly supplies a valid field', () => {
  const snapshot = normalizeProviderQuota('opencode-go', models, {
    ...openCodeResponse(),
    extraUsage: { status: 'ok', percent: 45, resetsAt: '2026-11-03T00:00:00.000Z' },
    apiKey: 'must never be projected',
  }, now)
  assert.deepEqual(snapshot.extraUsage, {
    state: 'reported', usagePercent: 45, resetsAt: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(JSON.stringify(snapshot).includes('must never be projected'), false)
})

test('OpenCode missing, invalid, and incomplete windows stay unknown rather than becoming zero', () => {
  for (const usage of [
    null,
    { rolling: null, weekly: openCodeWindow(1), monthly: openCodeWindow(1) },
    { rolling: openCodeWindow(null), weekly: openCodeWindow(1), monthly: openCodeWindow(1) },
    { rolling: openCodeWindow(101), weekly: openCodeWindow(1), monthly: openCodeWindow(1) },
  ]) {
    const snapshot = normalizeProviderQuota('opencode-go', models, { configured: true, error: null, usage }, now)
    assert.equal(snapshot.state, 'unknown')
    assert.equal(snapshot.windows.length, 0)
  }
  const notExplicitlyConfigured = normalizeProviderQuota('opencode-go', models, {
    reason: null, error: null, usage: openCodeResponse().usage,
  }, now)
  assert.equal(notExplicitlyConfigured.state, 'unknown')
})

test('unconfigured, failed, and stale OpenCode results have distinct non-zero states', () => {
  const unconfigured = normalizeProviderQuota('opencode-go', models, {
    configured: false, reason: 'no-api-key', error: null, usage: null,
  }, now)
  assert.equal(unconfigured.state, 'unconfigured')

  const error = normalizeProviderQuota('opencode-go', models, {
    configured: true, reason: null, error: 'unauthorized', usage: null,
  }, now)
  assert.equal(error.state, 'unknown')
  assert.equal(error.errorCode, 'upstream-unauthorized')

  const stale = normalizeProviderQuota('opencode-go', models, {
    ...openCodeResponse(), updatedAt: now - 10 * 60_000,
  }, now)
  assert.equal(stale.state, 'stale')
  assert.equal(stale.windows.length, 0)
})

test('normalizes Ark Agent Plan scopes and reports exhausted plan windows only as advisory', () => {
  const result = normalizeProviderQuota('ark', models, arkResponse(), now)
  assert.equal(result.state, 'exhausted')
  assert.deepEqual(result.windows.map(window => window.id), ['5h', 'daily', 'weekly', 'monthly'])
  assert.equal(result.windows[0]?.state, 'exhausted')
  assert.equal(result.modelScope, 'unknown')
  assert.equal(result.accountScope, 'unverified')
  assert.equal(result.advisory, true)
})

test('quota availability requires complete, ordered freshness timestamps from either Host plugin', () => {
  for (const [provider, response] of [['ark', arkResponse()], ['opencode-go', openCodeResponse()]] as const) {
    for (const timestamps of [
      { updatedAt: null, expiresAt: null },
      { updatedAt: undefined, expiresAt: undefined },
      { updatedAt: now - 1000, expiresAt: undefined },
      { updatedAt: undefined, expiresAt: now + 1000 },
      { updatedAt: now + 2000, expiresAt: now + 1000 },
    ]) {
      const snapshot = normalizeProviderQuota(provider, models, { ...response, ...timestamps }, now)
      assert.equal(snapshot.state, 'unknown')
      assert.equal(snapshot.reason, 'invalid-timestamp')
      assert.deepEqual(snapshot.windows, [])
    }
  }
})

test('Ark incomplete or unknown windows do not become exhausted or available', () => {
  const missing = normalizeProviderQuota('ark', models, {
    ...arkResponse(), windows: arkResponse().windows.filter(window => window.id !== 'daily'),
  }, now)
  assert.equal(missing.state, 'unknown')

  const unknown = arkResponse()
  unknown.windows[0]!.status = 'unknown'
  const snapshot = normalizeProviderQuota('ark', models, unknown, now)
  assert.equal(snapshot.state, 'unknown')
  assert.equal(snapshot.windows[0]?.state, 'unknown')
})

test('Ark over-quota usage remains exhausted with zero remaining and impossible ratios stay unknown', () => {
  const overQuota = arkResponse()
  overQuota.windows[0] = { ...overQuota.windows[0]!, quota: 100, used: 120, usedPercent: 120, remainingPercent: -20 }
  const exhausted = normalizeProviderQuota('ark', models, overQuota, now)
  assert.equal(exhausted.state, 'exhausted')
  assert.equal(exhausted.windows[0]?.usedPercent, 120)
  assert.equal(exhausted.windows[0]?.remainingPercent, 0)

  const contradictory = arkResponse()
  contradictory.windows[0] = { ...contradictory.windows[0]!, remainingPercent: 100 }
  assert.equal(normalizeProviderQuota('ark', models, contradictory, now).state, 'unknown')

  const inconsistentUsage = arkResponse()
  inconsistentUsage.windows[0] = { ...inconsistentUsage.windows[0]!, used: 120, usedPercent: 100, remainingPercent: 0 }
  assert.equal(normalizeProviderQuota('ark', models, inconsistentUsage, now).state, 'unknown')

  const impossibleNegativeUsage = arkResponse()
  impossibleNegativeUsage.windows[0] = { ...impossibleNegativeUsage.windows[0]!, used: -1 }
  assert.equal(normalizeProviderQuota('ark', models, impossibleNegativeUsage, now).state, 'unknown')
})

test('recognized Ark credential and missing-source errors are explicit sanitized unknown states', () => {
  const unconfigured = normalizeProviderQuota('ark', models, {
    configured: false, reason: 'credentials-not-configured', error: null, windows: [],
  }, now)
  assert.equal(unconfigured.state, 'unconfigured')
  assert.equal(unconfigured.reason, 'credentials-unconfigured')
  for (const [error, expected] of [
    ['credential-rotation', 'credential-rotation-required'],
    ['missing-source', 'quota-source-unavailable'],
  ] as const) {
    const snapshot = normalizeProviderQuota('ark', models, { configured: true, error, plan: null, windows: [] }, now)
    assert.equal(snapshot.state, 'unknown')
    assert.equal(snapshot.errorCode, expected)
    assert.equal(snapshot.reason, expected)
  }
  for (const reason of ['missing-source', 'credential_invalid']) {
    const snapshot = normalizeProviderQuota('ark', models, {
      configured: false, reason, error: null,
    }, now)
    assert.equal(snapshot.state, 'unknown')
    assert.equal(snapshot.reason, reason === 'missing-source' ? 'quota-source-unavailable' : 'credential-rotation-required')
  }
})

test('Ark requires an explicit configured result before any quota can be available', () => {
  const response = arkResponse() as Record<string, unknown>
  delete response.configured
  const snapshot = normalizeProviderQuota('ark', models, response, now)
  assert.equal(snapshot.state, 'unknown')
  assert.equal(snapshot.errorCode, 'invalid-response')
})

test('catalog projection queries only fixed supported IDs and isolates each provider failure', async () => {
  const calls: string[] = []
  const catalog = await projectProviderQuotaCatalog(modelCatalog(), async provider => {
    calls.push(provider)
    if (provider === 'ark') throw Object.assign(new Error('sensitive provider diagnostic'), { code: 'HOST_TIMEOUT' })
    return openCodeResponse()
  }, undefined, now)

  assert.deepEqual(calls.sort(), ['ark', 'opencode-go'])
  assert.equal(catalog.providers.find(item => item.provider === 'opencode-go')?.state, 'available')
  const ark = catalog.providers.find(item => item.provider === 'ark')
  assert.equal(ark?.state, 'unknown')
  assert.equal(ark?.errorCode, 'host-timeout')
  assert.equal(JSON.stringify(catalog).includes('sensitive provider diagnostic'), false)
  assert.equal(catalog.providers.find(item => item.provider === 'deepseek-official')?.state, 'unsupported')
  assert.equal(catalog.providers.find(item => item.provider === 'broken-provider')?.reason, 'model-catalog-unavailable')
})

test('catalog projection bounds custom quota readers and keeps other provider results', async () => {
  const signals: AbortSignal[] = []
  const result = await projectProviderQuotaCatalog(modelCatalog(), (provider, signal) => {
    if (provider === 'opencode-go') {
      assert.ok(signal)
      signals.push(signal)
      return new Promise(() => {})
    }
    if (provider === 'ark') return Promise.resolve(arkResponse())
    return Promise.resolve(undefined)
  }, undefined, now, 10)
  assert.equal(signals[0]?.aborted, true)
  assert.equal(result.providers.find(item => item.provider === 'opencode-go')?.errorCode, 'host-timeout')
  assert.equal(result.providers.find(item => item.provider === 'ark')?.state, 'exhausted')
})

test('catalog provider filters require unique exact live provider IDs and never query unknown IDs', async () => {
  const calls: string[] = []
  const read = async (provider: string) => { calls.push(provider); return openCodeResponse() }
  const selected = await projectProviderQuotaCatalog(modelCatalog(), read, ['opencode-go'], now)
  assert.deepEqual(selected.providers.map(item => item.provider), ['opencode-go'])
  assert.deepEqual(calls, ['opencode-go'])

  await assert.rejects(projectProviderQuotaCatalog(modelCatalog(), read, ['not-live'], now), /current model catalog/u)
  await assert.rejects(projectProviderQuotaCatalog(modelCatalog(), read, ['ark', 'ark'], now), /unique/u)
  assert.deepEqual(calls, ['opencode-go'])
})

function openCodeWindow(percent: number | null, resetsAt: string | null = null) {
  return { status: 'ok', percent, resetsAt }
}

function openCodeResponse() {
  return {
    configured: true,
    reason: null,
    error: null,
    updatedAt: now - 1_000,
    expiresAt: now + 60_000,
    usage: {
      rolling: openCodeWindow(30, '2026-11-02T01:00:00.000Z'),
      weekly: openCodeWindow(20),
      monthly: openCodeWindow(10),
    },
  }
}

function arkResponse() {
  return {
    configured: true,
    reason: null,
    error: null,
    updatedAt: now - 1_000,
    expiresAt: now + 60_000,
    plan: 'agent',
    windows: [
      { id: '5h', quota: 100, used: 100, usedPercent: 100, remainingPercent: 0, resetAt: now + 3_600_000, status: 'ok' },
      { id: 'daily', quota: 500, used: 10, usedPercent: 2, remainingPercent: 98, resetAt: null, status: 'ok' },
      { id: 'weekly', quota: 1000, used: 100, usedPercent: 10, remainingPercent: 90, resetAt: null, status: 'ok' },
      { id: 'monthly', quota: 5000, used: 500, usedPercent: 10, remainingPercent: 90, resetAt: null, status: 'ok' },
    ],
  }
}

function modelCatalog() {
  return {
    groups: [
      { id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'model-a' }, { id: 'model-b' }] },
      { id: 'ark', name: 'Ark', models: [{ id: 'ark-a' }] },
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'ds-a' }] },
    ],
    failures: [{ id: 'broken-provider', name: 'Broken', message: 'do not echo this' }],
  }
}
