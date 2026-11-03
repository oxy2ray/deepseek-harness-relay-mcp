export const QUOTA_PROVIDER_IDS = ['opencode-go', 'ark'] as const
export type QuotaProviderId = typeof QUOTA_PROVIDER_IDS[number]

export type ProviderQuotaState = 'available' | 'exhausted' | 'unconfigured' | 'unsupported' | 'unknown' | 'stale'

export interface ProviderQuotaWindow {
  id: string
  state: 'available' | 'exhausted' | 'unknown'
  usedPercent: number | null
  remainingPercent: number | null
  quota: number | null
  used: number | null
  resetsAt: string | null
}

export interface ProviderQuotaSnapshot {
  provider: string
  models: string[]
  state: ProviderQuotaState
  reason: string
  errorCode: string | null
  checkedAt: string
  updatedAt: string | null
  expiresAt: string | null
  scope: 'provider-plan'
  modelScope: 'unknown'
  accountScope: 'unverified'
  extraUsage: 'unknown' | {
    state: 'reported'
    usagePercent: number
    resetsAt: string | null
  }
  windows: ProviderQuotaWindow[]
  advisory: true
}

export interface ProviderQuotaCatalog {
  schemaVersion: 1
  providers: ProviderQuotaSnapshot[]
}

export type ProviderQuotaReader = (provider: string, signal?: AbortSignal) => Promise<unknown | undefined>

const WINDOW_IDS = {
  'opencode-go': ['rolling', 'weekly', 'monthly'],
  ark: ['5h', 'daily', 'weekly', 'monthly'],
} as const
const MAX_AGE_MS = 5 * 60_000
const MAX_READ_TIMEOUT_MS = 5_000

/** Project only exact provider routes present in the live native model catalog. */
export async function projectProviderQuotaCatalog(
  modelCatalog: unknown,
  read: ProviderQuotaReader,
  requestedProviders?: readonly string[],
  now = Date.now(),
  timeoutMs = MAX_READ_TIMEOUT_MS,
): Promise<ProviderQuotaCatalog> {
  const catalog = asRecord(modelCatalog)
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
  const live = new Map<string, string[]>()
  for (const item of groups) {
    const group = asRecord(item)
    if (!group || typeof group.id !== 'string' || group.id.length === 0 || !Array.isArray(group.models)) continue
    const models = group.models.map(asRecord)
      .filter((model): model is Record<string, unknown> => model !== null && typeof model.id === 'string' && model.id.length > 0)
      .map(model => model.id as string)
    live.set(group.id, models)
  }
  const failed = new Set(failures.map(asRecord).map(item => item?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))
  const knownIds = [...new Set([...live.keys(), ...failed])]
  if (requestedProviders !== undefined) {
    if (requestedProviders.length > 32 || new Set(requestedProviders).size !== requestedProviders.length) {
      throw new TypeError('providers must contain at most 32 unique provider IDs')
    }
    for (const provider of requestedProviders) {
      if (!knownIds.includes(provider)) throw new TypeError(`provider is not present in the current model catalog: ${provider}`)
    }
  }
  const selectedIds = requestedProviders ?? knownIds
  const snapshots = await Promise.all(selectedIds.map(async provider => {
    const models = live.get(provider) ?? []
    if (failed.has(provider)) return emptySnapshot(provider, models, 'unknown', 'model-catalog-unavailable', now)
    if (!live.has(provider)) return emptySnapshot(provider, models, 'unsupported', 'not-routable', now)
    if (!(QUOTA_PROVIDER_IDS as readonly string[]).includes(provider)) {
      return emptySnapshot(provider, models, 'unsupported', 'provider-not-supported', now)
    }
    try {
      const raw = await readWithDeadline(provider, read, timeoutMs)
      if (raw === undefined) return emptySnapshot(provider, models, 'unsupported', 'host-method-unavailable', now)
      return normalizeProviderQuota(provider as QuotaProviderId, models, raw, now)
    } catch (error) {
      return emptySnapshot(provider, models, 'unknown', safeGatewayError(error), now)
    }
  }))
  return { schemaVersion: 1, providers: snapshots }
}

/** Normalize one fixed native quota service result without inferring missing balances. */
export function normalizeProviderQuota(
  provider: QuotaProviderId,
  models: readonly string[],
  raw: unknown,
  now = Date.now(),
): ProviderQuotaSnapshot {
  const value = asRecord(raw)
  if (!value) return emptySnapshot(provider, [...models], 'unknown', 'invalid-response', now)
  if (value.configured === false) {
    const reason = normalizedReason(value.reason)
    return emptySnapshot(provider, [...models], reason === 'credentials-unconfigured' ? 'unconfigured' : 'unknown', reason, now)
  }
  if (value.configured !== true) return emptySnapshot(provider, [...models], 'unknown', 'invalid-response', now)
  if (value.error !== null && value.error !== undefined) {
    return emptySnapshot(provider, [...models], 'unknown', normalizedError(value.error), now)
  }

  const updatedMs = optionalTime(value.updatedAt)
  const expiresMs = optionalTime(value.expiresAt)
  if (updatedMs === null || expiresMs === null || expiresMs <= updatedMs) {
    return emptySnapshot(provider, [...models], 'unknown', 'invalid-timestamp', now)
  }
  const updatedAt = updatedMs === null ? null : new Date(updatedMs).toISOString()
  const expiresAt = expiresMs === null ? null : new Date(expiresMs).toISOString()
  if ((expiresMs !== null && expiresMs <= now) || (updatedMs !== null && (updatedMs > now + 60_000 || now - updatedMs > MAX_AGE_MS))) {
    return { ...emptySnapshot(provider, [...models], 'stale', 'quota-data-stale', now), updatedAt, expiresAt }
  }

  const windows = provider === 'opencode-go'
    ? normalizeOpenCodeWindows(value.usage)
    : normalizeArkWindows(value)
  if (windows === null) return { ...emptySnapshot(provider, [...models], 'unknown', 'invalid-or-incomplete-windows', now), updatedAt, expiresAt }
  const state = windows.some(window => window.state === 'unknown')
    ? 'unknown'
    : windows.some(window => window.state === 'exhausted') ? 'exhausted' : 'available'
  if (state === 'unknown') return { ...emptySnapshot(provider, [...models], state, 'window-status-unknown', now), updatedAt, expiresAt, windows }
  return {
    provider,
    models: [...models],
    state,
    reason: state === 'exhausted' ? 'plan-window-exhausted' : 'fresh-provider-plan-snapshot',
    errorCode: null,
    checkedAt: new Date(now).toISOString(),
    updatedAt,
    expiresAt,
    scope: 'provider-plan',
    modelScope: 'unknown',
    accountScope: 'unverified',
    extraUsage: normalizeOpenCodeExtraUsage(provider, value.extraUsage),
    windows,
    advisory: true,
  }
}

function normalizeOpenCodeWindows(raw: unknown): ProviderQuotaWindow[] | null {
  const usage = asRecord(raw)
  if (!usage) return null
  const windows: ProviderQuotaWindow[] = []
  for (const id of WINDOW_IDS['opencode-go']) {
    const source = asRecord(usage[id])
    if (!source || typeof source.status !== 'string' || typeof source.percent !== 'number'
      || !Number.isFinite(source.percent) || source.percent < 0 || source.percent > 100
      || (source.resetsAt !== null && typeof source.resetsAt !== 'string')) return null
    const resetAt = source.resetsAt === null ? null : normalizeTimestamp(source.resetsAt)
    if (source.resetsAt !== null && resetAt === null) return null
    windows.push({
      id,
      state: source.status === 'exhausted' || source.percent >= 100
        ? 'exhausted'
        : source.status === 'ok' ? 'available' : 'unknown',
      usedPercent: source.percent,
      remainingPercent: null,
      quota: null,
      used: null,
      resetsAt: resetAt,
    })
  }
  return windows
}

function normalizeArkWindows(value: Record<string, unknown>): ProviderQuotaWindow[] | null {
  if (value.plan !== 'agent' || !Array.isArray(value.windows)) return null
  const sourceById = new Map<string, Record<string, unknown>>()
  for (const item of value.windows) {
    const window = asRecord(item)
    if (!window || typeof window.id !== 'string' || !['5h', 'daily', 'weekly', 'monthly'].includes(window.id)
      || sourceById.has(window.id)) return null
    sourceById.set(window.id, window)
  }
  const required = WINDOW_IDS.ark
  if (required.some(id => !sourceById.has(id))) return null
  const result: ProviderQuotaWindow[] = []
  for (const id of required) {
    const source = sourceById.get(id)
    if (!source || (source.status !== 'ok' && source.status !== 'unknown')) return null
    const numeric = ['quota', 'used', 'usedPercent'] as const
    if (numeric.some(key => typeof source[key] !== 'number' || !Number.isFinite(source[key]) || (source[key] as number) < 0)
      || typeof source.remainingPercent !== 'number' || !Number.isFinite(source.remainingPercent)
      || (source.quota as number) <= 0
      || (source.resetAt !== null && (typeof source.resetAt !== 'number' || !Number.isFinite(source.resetAt)))) return null
    const resetAt = source.resetAt === null ? null : normalizeTimestamp(source.resetAt)
    if (source.resetAt !== null && resetAt === null) return null
    const usedPercent = source.usedPercent as number
    const rawRemainingPercent = source.remainingPercent as number
    const quota = source.quota as number
    const used = source.used as number
    const expectedUsedPercent = used / quota * 100
    const expectedRemainingPercent = Math.max(0, 100 - usedPercent)
    if (Math.abs(usedPercent - expectedUsedPercent) > 1
      || (usedPercent <= 100 && (rawRemainingPercent < 0 || rawRemainingPercent > 100
        || Math.abs(rawRemainingPercent - expectedRemainingPercent) > 1))
      || (usedPercent > 100 && rawRemainingPercent > 1)) return null
    const remainingPercent = Math.max(0, rawRemainingPercent)
    result.push({
      id,
      state: source.status === 'unknown' ? 'unknown' : remainingPercent <= 0 || usedPercent >= 100 ? 'exhausted' : 'available',
      usedPercent,
      remainingPercent,
      quota,
      used,
      resetsAt: resetAt,
    })
  }
  return result
}

function emptySnapshot(
  provider: string,
  models: string[],
  state: ProviderQuotaState,
  reason: string,
  now: number,
): ProviderQuotaSnapshot {
  return {
    provider,
    models,
    state,
    reason,
    errorCode: state === 'unknown' ? reason : null,
    checkedAt: new Date(now).toISOString(),
    updatedAt: null,
    expiresAt: null,
    scope: 'provider-plan',
    modelScope: 'unknown',
    accountScope: 'unverified',
    extraUsage: 'unknown',
    windows: [],
    advisory: true,
  }
}

function normalizeOpenCodeExtraUsage(
  provider: QuotaProviderId,
  raw: unknown,
): ProviderQuotaSnapshot['extraUsage'] {
  if (provider !== 'opencode-go' || raw === undefined || raw === null) return 'unknown'
  const source = asRecord(raw)
  if (!source || (source.status !== 'ok' && source.status !== 'exhausted') || typeof source.percent !== 'number'
    || !Number.isFinite(source.percent) || source.percent < 0 || source.percent > 100
    || (source.resetsAt !== undefined && source.resetsAt !== null && typeof source.resetsAt !== 'string')) return 'unknown'
  const resetsAt = source.resetsAt === undefined || source.resetsAt === null ? null : normalizeTimestamp(source.resetsAt)
  if (source.resetsAt !== undefined && source.resetsAt !== null && resetsAt === null) return 'unknown'
  return { state: 'reported', usagePercent: source.percent, resetsAt }
}

function normalizedReason(value: unknown): string {
  if (['not-in-models', 'no-api-key', 'credentials-missing', 'credentials-not-configured'].includes(String(value))) return 'credentials-unconfigured'
  if (['credential-rotation', 'credential-rotated', 'credential_rotation', 'credential-rotation-required', 'credential_invalid'].includes(String(value))) return 'credential-rotation-required'
  if (['missing-source', 'missing_source', 'source-unavailable'].includes(String(value))) return 'quota-source-unavailable'
  return 'source-status-unknown'
}

function normalizedError(value: unknown): string {
  if (typeof value !== 'string') return 'upstream-error'
  if (value === 'network') return 'upstream-network'
  if (value === 'unauthorized') return 'upstream-unauthorized'
  if (value === 'bad-json') return 'upstream-invalid-response'
  if (['credential-rotation', 'credential-rotated', 'credential_rotation', 'credential-rotation-required', 'credential_invalid'].includes(value)) return 'credential-rotation-required'
  if (['missing-source', 'missing_source', 'source-unavailable'].includes(value)) return 'quota-source-unavailable'
  if (/^http-\d{3}$/u.test(value)) return 'upstream-http-error'
  if (value === 'timeout' || value === 'rate-limited' || value === 'credentials') return value
  return 'upstream-error'
}

function safeGatewayError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (/timeout/iu.test(code)) return 'host-timeout'
  if (/rate|too.many/iu.test(code)) return 'host-rate-limited'
  if (/not.found|unsupported|unknown.method|endpoint/iu.test(code)) return 'host-method-unavailable'
  return 'host-unavailable'
}

async function readWithDeadline(
  provider: string,
  read: ProviderQuotaReader,
  requestedTimeoutMs: number,
): Promise<unknown | undefined> {
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.min(MAX_READ_TIMEOUT_MS, Math.max(1, requestedTimeoutMs))
    : MAX_READ_TIMEOUT_MS
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(Object.assign(new Error('provider quota query timed out'), { code: 'HOST_TIMEOUT' }))
    }, timeoutMs)
  })
  try {
    const readResult = Promise.resolve().then(() => read(provider, controller.signal))
    const result = await Promise.race([readResult, deadline])
    if (timedOut) throw Object.assign(new Error('provider quota query timed out'), { code: 'HOST_TIMEOUT' })
    return result
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('provider quota query timed out'), { code: 'HOST_TIMEOUT' })
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function optionalTime(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && Number.isFinite(new Date(parsed).getTime()) ? parsed : null
  }
  return null
}

function normalizeTimestamp(value: unknown): string | null {
  const timestamp = optionalTime(value)
  return timestamp === null ? null : new Date(timestamp).toISOString()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
