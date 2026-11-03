// Candidate-only read probe for provider registration and catalog resolution.
// It never submits a model task or returns credential values.
import { writeFile } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

const EXPECTED_ROUTES = [
  ['ark', 'deepseek-v4.1-flash-economy'],
  ['ark', 'deepseek-v4.1-flash'],
  ['opencode-go', 'deepseek-v4.1-flash'],
]

export default class CandidateProviderBootFixture extends Service {
  static Config = Schema.object({ outputPath: Schema.string() })
  static inject = ['llm']

  constructor(ctx, config) {
    super(ctx)
    this.outputPath = config.outputPath
  }

  async *[Service.init]() {
    const llm = this.ctx.llm
    const providers = llm.listProviders().map(provider => provider.id)
    const loader = this.ctx.loader
    const loaderEntries = loader?.entries?.() ?? []
    const credentialEntry = loaderEntries.find(entry => entry.options?.id === 'credentials')
    const candidateAdapterEntry = loaderEntries.find(entry => entry.options?.id === 'candidate-pi-ai-with-readonly-refs')
    const bootFixtureEntry = loaderEntries.find(entry => entry.options?.id === 'candidate-provider-boot-fixture')
    const credentialEntryState = await projectEntryState(credentialEntry)
    const candidateAdapterEntryState = await projectEntryState(candidateAdapterEntry)
    const bootFixtureEntryState = await projectEntryState(bootFixtureEntry)
    const catalogs = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider)
        catalogs.push({ provider, models: models.map(model => ({ id: model.id, name: model.name })) })
      } catch (error) {
        catalogs.push({ provider, error: safeError(error) })
      }
    }
    const exactRoutes = []
    for (const [provider, model] of EXPECTED_ROUTES) {
      try {
        const resolved = await llm.resolveModelInfo(provider, model)
        exactRoutes.push({
          provider,
          model,
          resolvable: true,
          contextWindow: resolved.context?.contextWindow,
          maxTokens: resolved.context?.maxTokens,
        })
      } catch (error) {
        exactRoutes.push({ provider, model, resolvable: false, error: safeError(error) })
      }
    }
    const evidence = {
      credentialServicePresent: this.ctx.get('credentials') !== undefined,
      credentialEntry: credentialEntryState,
      candidateAdapterEntry: candidateAdapterEntryState,
      bootFixtureEntry: bootFixtureEntryState,
      providers,
      catalogs,
      exactRoutes,
      modelTaskSubmitted: false,
      credentialValuesSerialized: false,
    }
    await writeFile(this.outputPath, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' })
  }
}

async function projectEntryState(entry) {
  if (entry === undefined) return undefined
  const fiber = entry.fiber
  const state = fiber === undefined ? 'no-fiber' : String(fiber.state)
  const missingServices = fiber === undefined || !fiber.inject || !fiber.ctx?.get
    ? []
    : Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined).sort()
  let failure
  if (state === '3') {
    try { await fiber.await() }
    catch (error) { failure = safeError(error) }
  }
  return {
    state,
    disabled: entry.disabled === true,
    moduleKind: String(entry.options?.name ?? '').includes('candidate-pi-ai-with-readonly-refs.mjs') ? 'candidate-pi-ai-wrapper'
      : String(entry.options?.name ?? '').includes('candidate-readonly-ref-credentials.mjs') ? 'candidate-reference-provider'
        : 'other',
    missingServices,
    ...(failure === undefined ? {} : { failure }),
  }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  const messageCategory = /credential|api[- ]?key|authentication|authorization/iu.test(message) ? 'credential'
    : /baseurl|endpoint|protocol|api\b/iu.test(message) ? 'route-configuration'
      : /catalog|model/iu.test(message) ? 'model-catalog'
        : /schema|invalid|unsupported|config/iu.test(message) ? 'configuration-validation'
          : message ? 'other' : 'none'
  return { ...(code === undefined ? {} : { code }), messageCategory }
}
