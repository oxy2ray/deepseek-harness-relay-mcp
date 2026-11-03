// EXPERIMENTAL AND DISABLED: this composition depended on exposing the shared
// credential document inside the candidate namespace. Do not load it until
// credentials are served through a private broker inaccessible to candidate tools.
import { isAbsolute, join, dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import CandidateReadonlyRefCredentials from './candidate-readonly-ref-credentials.mjs'

export const name = PiAi.name
export const inject = PiAi.inject
export const Config = PiAi.Config

export async function apply(ctx, config) {
  const sourcePath = process.env.CANDIDATE_PROVIDER_SOURCE_PATH
  const privatePath = process.env.CANDIDATE_PROVIDER_PRIVATE_PATH
  if (![sourcePath, privatePath].every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('candidate provider source and private paths must be absolute')
  }

  const evidencePath = join(dirname(privatePath), 'candidate-pi-ai-composition.json')
  const evidence = {
    wrapperApplyEntered: true,
    officialAdapterNamePresent: typeof PiAi.name === 'string',
    configuredProviders: config?.providers && typeof config.providers === 'object' ? Object.keys(config.providers).sort() : [],
    credentialServiceAlreadyPresent: ctx.get('credentials') !== undefined,
  }
  const writeEvidence = async () => writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' })

  const credentials = new CandidateReadonlyRefCredentials(ctx, { sourcePath, privatePath })
  const lifecycle = credentials[Service.init]()
  const initialized = await lifecycle.next()
  if (initialized.done) throw new Error('candidate credential provider did not initialize')
  evidence.credentialServiceAfterInit = ctx.get('credentials') !== undefined
  evidence.credentialSource = await credentials.availableSharedReferences().catch(() => ({ unavailable: true }))
  evidence.referenceDescriptions = {}
  for (const reference of ['ARK_API_KEY', 'OPENCODE_GO_API_KEY']) {
    try {
      const description = await credentials.describe(reference)
      evidence.referenceDescriptions[reference] = { configured: description.configured, source: description.source }
    } catch (error) {
      evidence.referenceDescriptions[reference] = { errorCategory: error instanceof Error ? 'reference-provider' : 'unknown' }
    }
  }
  try {
    await PiAi.apply(ctx, config)
    evidence.officialAdapterApplyReturned = true
    evidence.credentialServiceAfterComposition = ctx.get('credentials') !== undefined
    evidence.registeredProviders = ctx.llm.listProviders().map(provider => provider.id)
    evidence.routableProviders = ctx.llm.listRoutableProviders?.().map(provider => provider.id)
    evidence.exactRoutes = []
    for (const [provider, model] of [['ark', 'deepseek-v4.1-flash-economy'], ['opencode-go', 'deepseek-v4.1-flash']]) {
      try {
        const resolved = await ctx.llm.resolveModelInfo(provider, model)
        evidence.exactRoutes.push({ provider, model, resolvable: true, contextWindow: resolved.context?.contextWindow })
      } catch (error) {
        evidence.exactRoutes.push({ provider, model, resolvable: false, code: typeof error?.code === 'string' ? error.code : undefined })
      }
    }
    await writeEvidence()
  } catch (error) {
    evidence.officialAdapterApplyReturned = false
    evidence.failureClass = error instanceof Error && error.constructor?.name === 'SchemaError' ? 'schema-validation' : 'adapter-apply'
    try { await writeEvidence() } catch { /* avoid changing candidate startup outcome for diagnostic output */ }
    await initialized.value?.()
    await lifecycle.return()
    throw error
  }
  return async () => {
    await initialized.value?.()
    await lifecycle.return()
  }
}
