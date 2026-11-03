// Private native Host fixture for provider quota projection.
// Synthetic credentials and deterministic HTTP replies stay inside this Host.
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

const REFERENCES = {
  opencode: ['RELAY_FIXTURE_OPENCODE_GO_KEY', 'relay-fixture-opencode-key-v1'],
  arkAk: ['RELAY_FIXTURE_ARK_AK', 'relay-fixture-ark-ak-v1'],
  arkSk: ['RELAY_FIXTURE_ARK_SK', 'relay-fixture-ark-sk-v1'],
}
const OPENCODE_URL = 'https://opencode.ai/zen/go/v1/usage'
const ARK_URL = 'https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01'
const FIXTURE_MODEL = { provider: 'ark', model: 'relay-quota-fixture-model' }

export default class ProviderQuotasHostFixture extends Service {
  static Config = Schema.object({ workspacePath: Schema.string(), evidencePath: Schema.string(), controlPath: Schema.string() })
  static inject = ['credentials', 'settings', 'llm', 'workspaceController', 'sessionController', 'arkAgentPlanUsage', 'opencodeUsage']

  constructor(ctx, config) {
    super(ctx)
    this.workspacePath = config.workspacePath
    this.evidencePath = config.evidencePath
    this.controlPath = config.controlPath
    this.events = []
    this.modelRequestCount = 0
    this.writeChain = Promise.resolve()
    this.privateHome = undefined
    this.privateCredentialStorePresent = false
    this.originalFetch = globalThis.fetch
    this.quotaServiceFetchAdapters = []
    this.previousEnvironment = new Map()
    for (const [name, value] of Object.values(REFERENCES)) {
      this.previousEnvironment.set(name, process.env[name])
      process.env[name] = value
    }
    this.fetchWrapper = (input, init) => this.interceptFetch(input, init)
    globalThis.fetch = this.fetchWrapper
    for (const service of [ctx.arkAgentPlanUsage, ctx.opencodeUsage]) {
      if (!service || typeof service.usage !== 'function' || typeof service.fetchImpl !== 'function') {
        throw new Error('native quota services did not expose their fetch adapter')
      }
      this.quotaServiceFetchAdapters.push({ service, previous: service.fetchImpl })
      service.fetchImpl = this.fetchWrapper
    }
  }

  async *[Service.init]() {
    try {
      await this.verifyPrivateSetup()
      this.ready = true
      await this.writeEvidence()
    } catch (error) {
      this.failure = safeFailure(error)
      await this.writeEvidence().catch(() => {})
      throw new Error(`private provider quota fixture failed: ${this.failure}`)
    }
    yield async () => {
      if (globalThis.fetch === this.fetchWrapper) globalThis.fetch = this.originalFetch
      for (const { service, previous } of this.quotaServiceFetchAdapters) {
        if (service.fetchImpl === this.fetchWrapper) service.fetchImpl = previous
      }
      for (const [name, value] of this.previousEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await this.writeChain
    }
  }

  async verifyPrivateSetup() {
    const dshHome = process.env.DSH_HOME
    if (!dshHome || !isAbsolute(dshHome)) throw new Error('private DSH_HOME is required')
    const [privateHome, evidenceParent, controlParent, workspacePath] = await Promise.all([
      realpath(dshHome), realpath(dirname(this.evidencePath)), realpath(dirname(this.controlPath)), realpath(this.workspacePath),
    ])
    if (!contains(privateHome, evidenceParent) || !contains(privateHome, controlParent)) {
      throw new Error('fixture evidence and control must remain in private DSH_HOME')
    }
    const privateTestRoot = await realpath(dirname(privateHome))
    if (!contains(privateTestRoot, workspacePath)) throw new Error('fixture workspace must remain in the isolated test root')
    for (const name of ['.credentials.yaml', '.env']) {
      try {
        const details = await lstat(join(privateHome, name))
        if (name === '.env') throw new Error('private quota Host must not contain a dotenv file')
        if (!details.isFile() || details.isSymbolicLink()) throw new Error('private quota credential store must be a regular file')
        if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
          throw new Error('private quota credential store must have owner-only permissions')
        }
        this.privateCredentialStorePresent = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    this.privateHome = privateHome
    for (const [reference, expected] of Object.values(REFERENCES)) {
      const resolved = await this.ctx.credentials.resolve(reference)
      if (resolved?.value !== expected || resolved.source !== 'env') {
        throw new Error('synthetic quota credential did not resolve from the isolated Host environment')
      }
    }
    const settings = this.ctx.settings.describe({ redactSecrets: true })
    const llm = settings.find(item => item.ns === 'llm-pi-ai')
    const providers = llm?.value?.providers
    if (!providers || !Object.hasOwn(providers, 'ark') || !Object.hasOwn(providers, 'opencode-go')) {
      throw new Error('private llm-pi-ai settings must include ark and opencode-go routes')
    }
    const liveProviders = this.ctx.llm.listProviders().map(item => item.id)
    if (!liveProviders.includes('ark') || !liveProviders.includes('opencode-go')) {
      throw new Error('native model catalog must register both quota provider routes')
    }

    const registration = await this.ctx.workspaceController.create({ path: workspacePath })
    const created = await this.ctx.sessionController.create({ workspaceId: registration.workspace.workspaceId })
    const selection = await this.ctx.sessionController.selectModel({ sessionId: created.sessionId, ...FIXTURE_MODEL })
    if (selection.selected.provider !== FIXTURE_MODEL.provider || selection.selected.model !== FIXTURE_MODEL.model) {
      throw new Error('native Session did not retain the requested fixture model selection')
    }
    const listed = await this.ctx.sessionController.list({}, new AbortController().signal)
    const session = listed.items.find(item => item.sessionId === created.sessionId)
    if (!session || session.running || !session.blank) {
      throw new Error('native fixture Session must remain blank and idle after model selection')
    }
    const nextModel = session.projections?.values?.modelSelection?.next
    if (nextModel && (nextModel.provider !== FIXTURE_MODEL.provider || nextModel.model !== FIXTURE_MODEL.model)) {
      throw new Error('native Session projection does not match the selected fixture model')
    }
    this.workspace = { workspaceId: registration.workspace.workspaceId, path: registration.workspace.path }
    this.sessionId = created.sessionId
    this.nativeSessionBlankAndIdle = true
    this.selectedModel = { ...selection.selected }
    this.modelSelectionProjectionMatches = nextModel
      ? nextModel.provider === FIXTURE_MODEL.provider && nextModel.model === FIXTURE_MODEL.model
      : null
  }

  async interceptFetch(input, init) {
    const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    let url
    try { url = new URL(requestUrl) } catch { return this.originalFetch(input, init) }
    if (url.href === OPENCODE_URL) return this.handleQuotaRequest('opencode-go', url, input, init)
    if (url.href === ARK_URL) return this.handleQuotaRequest('ark', url, input, init)
    if (isModelRequest(url)) {
      this.modelRequestCount++
      await this.writeEvidence()
    }
    return this.originalFetch(input, init)
  }

  async handleQuotaRequest(provider, url, input, init) {
    const request = typeof input === 'object' && input !== null ? input : undefined
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? request?.headers)
    const authorization = headers.get('authorization') ?? ''
    const phase = await this.readPhase()
    const credentialMatched = provider === 'opencode-go'
      ? method === 'GET' && authorization === `Bearer ${REFERENCES.opencode[1]}`
      : method === 'POST' && authorization.startsWith(`HMAC-SHA256 Credential=${REFERENCES.arkAk[1]}/`)
        && headers.has('x-date') && headers.has('x-content-sha256')
    this.events.push({ provider, method, phase, credentialMatched })
    await this.writeEvidence()
    if (!credentialMatched) return jsonResponse({ error: 'synthetic credential mismatch' }, 401)
    if (phase === 2 && provider === 'ark') return jsonResponse({ error: 'synthetic upstream unavailable' }, 503)
    return provider === 'opencode-go'
      ? jsonResponse(phase === 1 ? openCodeResponse() : incompleteOpenCodeResponse())
      : jsonResponse(arkResponse())
  }

  async readPhase() {
    try {
      const control = JSON.parse(await readFile(this.controlPath, 'utf8'))
      return control?.phase === 2 ? 2 : 1
    } catch (error) {
      if (error?.code === 'ENOENT') return 1
      throw new Error('private fixture control file is invalid')
    }
  }

  writeEvidence() {
    const record = {
      schemaVersion: 1,
      fixture: 'synthetic-provider-quota-http',
      privateHome: this.privateHome,
      privateCredentialStorePresent: this.privateCredentialStorePresent,
      privateCredentialFilesMounted: false,
      workspace: this.workspace ?? null,
      sessionId: this.sessionId ?? null,
      nativeSessionBlankAndIdle: this.nativeSessionBlankAndIdle === true,
      selectedModel: this.selectedModel ?? null,
      modelSelectionProjectionMatches: this.modelSelectionProjectionMatches ?? null,
      ready: this.ready === true,
      failure: this.failure ?? null,
      syntheticCredentialsOnly: true,
      credentialValuesSerialized: false,
      modelTaskSubmitted: false,
      modelRequestCount: this.modelRequestCount,
      quotaRequests: this.events.map(event => ({ ...event })),
    }
    this.writeChain = this.writeChain.then(async () => {
      const tempPath = `${this.evidencePath}.${randomUUID()}.tmp`
      await writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(tempPath, this.evidencePath)
    })
    return this.writeChain
  }
}

function openCodeResponse() {
  return { usage: {
    rolling: { status: 'ok', percent: 20, resetsAt: '2026-11-03T00:00:00.000Z' },
    weekly: { status: 'ok', percent: 30, resetsAt: null },
    monthly: { status: 'ok', percent: 40, resetsAt: null },
  } }
}

function incompleteOpenCodeResponse() {
  return { usage: {
    rolling: { status: 'ok', percent: 20, resetsAt: null },
    weekly: { status: 'ok', percent: 30, resetsAt: null },
  } }
}

function arkResponse() {
  const resetAt = Date.now() + 60_000
  return { Result: { PlanType: 'Agent',
    AFPFiveHour: { Quota: '100', Used: '100', ResetTime: resetAt },
    AFPDaily: { Quota: '500', Used: '50', ResetTime: resetAt },
    AFPWeekly: { Quota: '1000', Used: '100', ResetTime: resetAt },
    AFPMonthly: { Quota: '5000', Used: '500', ResetTime: resetAt },
  } }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function isModelRequest(url) {
  return /\/(?:chat\/completions|responses|completions|messages)(?:\/|$)/u.test(url.pathname)
}

function safeFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/credential|api[- ]?key/iu.test(message)) return 'credential-setup'
  if (/settings|provider|model/iu.test(message)) return 'provider-setup'
  return 'fixture-setup'
}

function contains(parent, candidate) {
  const suffix = relative(parent, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix.split(sep)[0] !== '..')
}
