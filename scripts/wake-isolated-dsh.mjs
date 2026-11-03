// Linux test-only Host launcher. Explicit paths; no shared profile, token or registry discovery.
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const [requestedRoot, requestedBundle, requestedModules, requestedEntrypoint, readonlyMountsFile, requestedMode, requestedProviderOverlay] = process.argv.slice(2)
if (requestedMode === 'readonly-api-credentials') {
  throw new Error('readonly-api-credentials mode is disabled: shared credential files contain unrelated records and are readable by candidate tools')
}
if (requestedMode !== undefined && requestedMode !== '' && !['workspace-management', 'agent-presets', 'provider-quotas', 'provider-quotas-ui'].includes(requestedMode)) throw new Error('unsupported private candidate mode')
const workspaceManagementMode = requestedMode === 'workspace-management'
const agentPresetsMode = requestedMode === 'agent-presets'
const providerQuotasMode = requestedMode === 'provider-quotas'
const providerQuotasUiMode = requestedMode === 'provider-quotas-ui'
const anyProviderQuotasMode = providerQuotasMode || providerQuotasUiMode
if (requestedProviderOverlay !== undefined) {
  throw new Error('candidate provider overlays are disabled until credentials are resolved through a private broker')
}
if (![requestedRoot, requestedBundle, requestedModules].every(p => p && isAbsolute(p))) {
  console.error('Usage: node scripts/wake-isolated-dsh.mjs <absolute-private-test-root> <dsh-relay-harness.mjs> <readonly-node_modules-root> [candidate-dsh-entrypoint.js [readonly-mount-manifest.json [workspace-management|agent-presets|provider-quotas]]]')
  process.exit(2)
}
const [bundle, modules] = await Promise.all([realpath(requestedBundle), realpath(requestedModules)])
const entrypoint = requestedEntrypoint === undefined || requestedEntrypoint === '' ? undefined : await realpath(requestedEntrypoint)
const relayPlugin = await import(pathToFileURL(bundle).href)
if (relayPlugin.name !== 'harness-relay-mcp'
  || !Array.isArray(relayPlugin.inject)
  || typeof relayPlugin.Config !== 'function'
  || typeof relayPlugin.apply !== 'function') {
  throw new Error('candidate Relay bundle is not a native DSH plugin entry; use the dsh-relay-harness.mjs bundle')
}
await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
const root = await realpath(requestedRoot)
const contained = (parent, path) => { const suffix = relative(parent, path); return !isAbsolute(suffix) && suffix.split(sep)[0] !== '..' }
if (root === '/' || root === homedir() || ['.codex', '.dsh', 'dsh-relay'].some(dir => contained(join(homedir(), dir), root))) throw new Error('dedicated test root required')
if (entrypoint !== undefined && !contained(modules, entrypoint)) throw new Error('candidate DSH entrypoint must be inside the read-only candidate modules root')
const readonlyMounts = []
if (readonlyMountsFile !== undefined && readonlyMountsFile !== '') {
  if (!isAbsolute(readonlyMountsFile)) throw new Error('read-only mount manifest must use an absolute path')
  const manifest = JSON.parse(await readFile(await realpath(readonlyMountsFile), 'utf8'))
  if (!Array.isArray(manifest) || manifest.length > 4 || !manifest.every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('read-only mount manifest must contain at most four absolute file paths')
  }
  const allowedSources = new Set(['profiles/web/cordis.patch.yml'])
  for (const requestedSource of manifest) {
    const link = await lstat(requestedSource)
    if (!link.isFile()) throw new Error('read-only mount source must be a regular non-symlink file')
    const source = await realpath(requestedSource)
    const sourceRelative = relative(join(homedir(), '.dsh'), source)
    if (sourceRelative === '.credentials.yaml') {
      throw new Error('shared credential store mounts are disabled for candidate runtimes')
    }
    if (!allowedSources.has(sourceRelative) || contained(root, source) || contained(join(root, 'workspace'), source)) {
      throw new Error('read-only mount source is outside the explicit credential/provider configuration allowlist')
    }
    if ((link.mode & 0o077) !== 0) throw new Error('read-only mount source permissions must exclude group and other access')
    readonlyMounts.push({ source, sourceRelative })
  }
  if (readonlyMounts.length > 0) await mkdir(join(root, 'readonly-sources'), { recursive: true, mode: 0o700 })
  for (let index = 0; index < readonlyMounts.length; index++) {
    const mount = readonlyMounts[index]
    mount.stage = join(root, 'readonly-sources', String(index))
    try { await writeFile(mount.stage, '', { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (error?.code !== 'EEXIST') throw error }
  }
}
const lockPath = join(root, 'host-owner.json')
const owner = { pid: process.pid, token: randomUUID() }
const lock = await open(lockPath, 'wx', 0o600)
await lock.writeFile(JSON.stringify(owner)); await lock.close()
let child
let log
const stop = () => child?.kill('SIGTERM')
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  for (const dir of ['dsh-state', 'codex-shadow', 'legacy-registry', 'workspace']) await mkdir(join(root, dir), { recursive: true, mode: 0o700 })
  const workspacePath = join(root, 'workspace')
  if ((workspaceManagementMode || agentPresetsMode || anyProviderQuotasMode) && await realpath(workspacePath) !== workspacePath) {
    throw new Error('fixture mode requires workspace to resolve exactly to the private candidate workspace')
  }
  const localBundle = join(root, 'relay-bundle.mjs')
  const providerBootFixture = join(root, 'candidate-provider-boot-fixture.mjs')
  const providerBootEvidence = join(root, 'candidate-provider-boot.json')
  if (bundle !== localBundle) await copyFile(bundle, localBundle)
  const patchEntries = []
  if (workspaceManagementMode) {
    const workspaceFixture = join(root, 'workspace-management-host.mjs')
    const workspaceEvidence = join(root, 'dsh-state', 'workspace-management-fixture-evidence.json')
    await copyFile(new URL('../tests/fixtures/workspace-management-host.mjs', import.meta.url), workspaceFixture)
    patchEntries.push(`- insert:\n    - id: workspace-management-host-fixture\n      name: ${JSON.stringify(workspaceFixture)}\n      config:\n        workspacePath: ${JSON.stringify(workspacePath)}\n        evidencePath: ${JSON.stringify(workspaceEvidence)}`)
  } else if (agentPresetsMode) {
    const fixture = join(root, 'agent-presets-host.mjs')
    await copyFile(new URL('../tests/fixtures/agent-presets-host.mjs', import.meta.url), fixture)
    patchEntries.push(`- insert:\n    - id: agent-presets-host-fixture\n      name: ${JSON.stringify(fixture)}\n      config:\n        workspacePath: ${JSON.stringify(workspacePath)}\n        evidencePath: ${JSON.stringify(join(root, 'dsh-state', 'agent-presets-evidence.json'))}\n        controlPath: ${JSON.stringify(join(root, 'dsh-state', 'agent-presets-control.json'))}`)
  } else if (anyProviderQuotasMode) {
    let fixture
    if (providerQuotasUiMode) {
      const fixtureDirectory = join(root, 'synthetic-fixture')
      await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
      fixture = join(fixtureDirectory, 'provider-quotas-host.mjs')
      await writeFile(join(fixtureDirectory, 'package.json'), JSON.stringify({
        name: 'dsh-provider-quotas-test-fixture', version: '0.0.0', type: 'module', private: true,
      }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    } else {
      fixture = join(root, 'provider-quotas-host.mjs')
    }
    await copyFile(new URL('../tests/fixtures/provider-quotas-host.mjs', import.meta.url), fixture)
    const model = (id, name) => ({ id, name, contextWindow: 8192, maxTokens: 1024 })
    const providers = {
      'opencode-go': { apiKeyEnv: 'RELAY_FIXTURE_OPENCODE_GO_KEY', api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1', models: [model('relay-opencode-quota-fixture-model', 'OpenCode quota fixture (unused)')] },
      ark: { apiKeyEnv: 'RELAY_FIXTURE_ARK_AK', api: 'openai-completions',
        baseURL: 'https://ark.cn-beijing.volcengineapi.com/api/v3', models: [model('relay-quota-fixture-model', 'Ark quota fixture (unused)')] },
    }
    patchEntries.push(`- id: llm-pi-ai\n  config: ${JSON.stringify({ providers })}`)
    patchEntries.push(`- id: opencode-go-usage-dock\n  config: ${JSON.stringify({ cacheTtlMs: 5000 })}`)
    patchEntries.push(`- id: ark-agent-plan-usage-dock\n  config: ${JSON.stringify({ akRef: 'RELAY_FIXTURE_ARK_AK', skRef: 'RELAY_FIXTURE_ARK_SK', cacheTtlMs: 5000 })}`)
    patchEntries.push(`- insert:\n    - id: provider-quotas-host-fixture\n      name: ${JSON.stringify(fixture)}\n      config:\n        workspacePath: ${JSON.stringify(workspacePath)}\n        evidencePath: ${JSON.stringify(join(root, 'dsh-state', 'provider-quotas-evidence.json'))}\n        controlPath: ${JSON.stringify(join(root, 'dsh-state', 'provider-quotas-control.json'))}`)
  } else {
    await copyFile(new URL('./candidate-provider-boot-fixture.mjs', import.meta.url), providerBootFixture)
    patchEntries.push(`- insert:\n    - id: candidate-provider-boot-fixture\n      name: ${JSON.stringify(providerBootFixture)}\n      config:\n        outputPath: ${JSON.stringify(providerBootEvidence)}`)
  }
  if (!providerQuotasUiMode) {
    patchEntries.push(`- insert:\n    - id: harness-relay-mcp\n      name: ${JSON.stringify(localBundle)}\n      config:\n        stateDirectory: ${JSON.stringify(join(root, 'relay-state'))}`)
  }
  const patch = join(root, 'relay.patch.yml')
  await writeFile(patch, `${patchEntries.join('\n')}\n`, { mode: 0o600 })
  const logPath = join(root, `host-${Date.now()}-${process.pid}.log`)
  log = await open(logPath, 'wx', 0o600)
  const dshCommand = entrypoint === undefined
    ? ['dsh']
    : ['node', join(root, 'node_modules', relative(modules, entrypoint))]
  const args = ['--unshare-user', '--new-session', '--die-with-parent', '--ro-bind', '/', '/',
    '--tmpfs', '/tmp', '--bind', root, root,
    ...readonlyMounts.flatMap(mount => ['--ro-bind', mount.source, mount.stage]),
    '--bind', join(root, 'dsh-state'), join(homedir(), '.dsh'),
    '--bind', join(root, 'codex-shadow'), join(homedir(), '.codex'),
    '--bind', join(root, 'legacy-registry'), join(homedir(), 'dsh-relay'),
    '--ro-bind', modules, join(root, 'node_modules'), '--proc', '/proc', '--dev', '/dev',
    '--chdir', join(root, 'workspace'), '--clearenv',
    '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'DSH_HOME', join(root, 'dsh-state'),
    ...(workspaceManagementMode || agentPresetsMode || anyProviderQuotasMode ? ['--setenv', 'DSH_RELAY_ALLOWED_WORKSPACE_ROOTS', workspacePath] : []),
    ...(anyProviderQuotasMode ? ['--setenv', 'RELAY_FIXTURE_OPENCODE_GO_KEY', 'relay-fixture-opencode-key-v1',
      '--setenv', 'RELAY_FIXTURE_ARK_AK', 'relay-fixture-ark-ak-v1', '--setenv', 'RELAY_FIXTURE_ARK_SK', 'relay-fixture-ark-sk-v1'] : []), '--',
    ...dshCommand, '--profile', 'web',
    ...readonlyMounts.filter(mount => mount.sourceRelative === 'profiles/web/cordis.patch.yml')
      .flatMap(mount => ['--patch', mount.stage]),
    '--patch', patch, '--', '--host', '127.0.0.1', '--port', '0', '--no-open']
  // Keep the host PID namespace: existing Relay owner sidecars must be meaningful to external native clients.
  child = spawn('bwrap', args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', log.fd, log.fd] })
  console.log(JSON.stringify({ stateRoot: root, privateLog: logPath, port: 'OS-assigned', authentication: 'not-copied-or-configured' }))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = typeof code === 'number' ? code : 0
} finally {
  stop()
  await log?.close()
  try { if (JSON.parse(await readFile(lockPath, 'utf8')).token === owner.token) await unlink(lockPath) } catch { /* never remove a different owner's lock */ }
  process.off('SIGINT', stop); process.off('SIGTERM', stop)
}

