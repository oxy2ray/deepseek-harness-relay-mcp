// EXPERIMENTAL AND DISABLED: this helper emits public provider configuration
// only. The candidate launcher rejects provider overlays until credentials
// are served through a private broker inaccessible to candidate tools.
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import yaml from 'js-yaml'

const [requestedSource, requestedOutput] = process.argv.slice(2)
const sourceAllowed = '/home/zer0in/.dsh/profiles/web/cordis.patch.yml'
if (requestedSource !== sourceAllowed || !requestedOutput || !isAbsolute(requestedOutput)) {
  throw new Error('Usage: node scripts/build-candidate-provider-overlay.mjs /home/zer0in/.dsh/profiles/web/cordis.patch.yml <absolute-private-output>')
}
const source = await realpath(requestedSource)
const sourceStat = await lstat(requestedSource)
if (!sourceStat.isFile() || (sourceStat.mode & 0o077) !== 0) throw new Error('approved provider profile must be a private regular file')
const output = requestedOutput
const allowedOutputRoot = await realpath('/home/zer0in/deepseek-harness-relay-mcp/.runtime/dsh-candidate')
const outputSuffix = relative(allowedOutputRoot, output)
if (isAbsolute(outputSuffix) || outputSuffix.split(sep)[0] === '..') throw new Error('candidate provider overlay output must stay under the private candidate runtime')
const outputStat = await lstat(output).catch(() => undefined)
if (outputStat !== undefined) throw new Error('candidate provider overlay output already exists')

const parsed = yaml.load(await (await import('node:fs/promises')).readFile(source, 'utf8'))
if (!Array.isArray(parsed)) throw new Error('approved provider profile is not a patch list')
const providerRow = parsed.find(row => row && typeof row === 'object' && row.id === 'llm-pi-ai')
const sourceProviders = providerRow?.config?.providers
if (!sourceProviders || typeof sourceProviders !== 'object') throw new Error('approved pi-ai provider definitions are unavailable')

const requireProvider = (id, keyRef) => {
  const provider = sourceProviders[id]
  if (!provider || typeof provider !== 'object' || provider.apiKeyEnv !== keyRef) {
    throw new Error(`approved provider profile is missing ${id} or its expected credential reference`)
  }
  for (const key of Object.keys(provider)) {
    if (!['apiKeyEnv', 'api', 'baseURL', 'models', 'displayName'].includes(key)) {
      throw new Error(`provider ${id} contains an unsupported field`)
    }
  }
  return provider
}
const safeModel = (providerId, modelId) => {
  const model = sourceProviders[providerId]?.models?.find(entry => entry?.id === modelId)
  if (!model || Object.keys(model).some(key => !['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].includes(key))) {
    throw new Error(`approved profile is missing a safe definition for ${providerId}/${modelId}`)
  }
  // Preserve the public catalog facts for custom routes such as Ark. Routes
  // already described by the installed catalog can still merge their defaults.
  return Object.fromEntries(Object.entries(model))
}

const ark = requireProvider('ark', 'ARK_API_KEY')
const opencode = requireProvider('opencode-go', 'OPENCODE_GO_API_KEY')
const endpoint = new URL(ark.baseURL)
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
  || endpoint.hostname !== 'ark.cn-beijing.volces.com' || endpoint.pathname !== '/api/plan/v3'
  || ark.api !== 'openai-responses') throw new Error('approved Ark endpoint or protocol failed the fixed allowlist')

const overlay = [{
  id: 'llm-pi-ai',
  config: {
    providers: {
      ark: {
        apiKeyEnv: 'ARK_API_KEY',
        api: 'openai-responses',
        baseURL: endpoint.origin + endpoint.pathname,
        models: [
          safeModel('ark', 'deepseek-v4.1-flash-economy'),
          safeModel('ark', 'deepseek-v4.1-flash'),
        ],
      },
      'opencode-go': {
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        models: [safeModel('opencode-go', 'deepseek-v4.1-flash')],
      },
    },
  },
}]

await realpath(dirname(output)).catch(() => { throw new Error('candidate overlay parent directory must already exist') })
const sourceParent = '/home/zer0in/.dsh'
const sourceSuffix = relative(sourceParent, source)
if (isAbsolute(sourceSuffix) || sourceSuffix.split(sep)[0] === '..') throw new Error('provider profile source escaped the approved directory')
await writeFile(output, yaml.dump(overlay, { noRefs: true, lineWidth: 120 }), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ output, providers: ['ark', 'opencode-go'], modelRoutes: 3, credentialValuesIncluded: false }))
