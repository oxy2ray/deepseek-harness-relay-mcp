import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, access, stat, lstat, readFile, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readConsoleConfig } from '../src/wake/console-config.js'
import { OwnedCodexHost } from '../src/wake/owned-codex-host.js'
import { buildCodexArgs } from '../src/wake/codex-process.js'
import { acquireWakeLock } from '../src/wake/store.js'

test('console configuration confines state to a private root and keeps it outside the task workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-config-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace')
  await mkdir(state); await mkdir(workspace)
  const path = join(root, 'config.json')
  const config = { testRoot: root, codexState: state, workspace, wakeState: join(root, 'wake.json'), principal: 'test', bindingId: 'binding' }
  await writeFile(path, JSON.stringify(config))
  assert.equal((await readConsoleConfig(path)).network, 'isolated')
  assert.equal((await readConsoleConfig(path)).codexMode, 'private-state')
  assert.equal((await readConsoleConfig(path)).relayWorkspace, workspace)
  await writeFile(path, JSON.stringify({ ...config, codexExecutable: path }))
  assert.equal((await readConsoleConfig(path)).codexExecutable, path)
  await writeFile(path, JSON.stringify({ ...config, codexExecutable: 'relative/codex' }))
  await assert.rejects(readConsoleConfig(path))
  await writeFile(path, JSON.stringify({ ...config, codexMode: 'current-runtime' }))
  assert.equal((await readConsoleConfig(path)).codexMode, 'current-runtime')
  await writeFile(path, JSON.stringify({ ...config, codexMode: 'unknown-mode' }))
  await assert.rejects(readConsoleConfig(path))
  await writeFile(path, JSON.stringify({ ...config, wakeState: join(workspace, 'wake.json') }))
  await assert.rejects(readConsoleConfig(path))
  const outside = await mkdtemp(join(tmpdir(), 'relay-wake-outside-'))
  await writeFile(path, JSON.stringify({ ...config, relayWorkspace: outside }))
  assert.equal((await readConsoleConfig(path)).relayWorkspace, outside)
  await symlink(outside, join(root, 'relay-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, relayWorkspace: join(root, 'relay-alias') }))
  await assert.rejects(readConsoleConfig(path), /canonical absolute directory/iu)
  await writeFile(path, JSON.stringify({ ...config, relayWorkspace: join(root, 'missing-relay-workspace') }))
  await assert.rejects(readConsoleConfig(path))
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, codexState: join(root, 'escape') }))
  await assert.rejects(readConsoleConfig(path))

  await symlink(state, join(root, 'state-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, codexState: join(root, 'state-alias') }))
  await assert.rejects(readConsoleConfig(path), /canonical absolute directories/iu)
  await symlink(workspace, join(root, 'workspace-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, workspace: join(root, 'workspace-alias') }))
  await assert.rejects(readConsoleConfig(path), /canonical absolute directories/iu)
  const control = join(root, 'control')
  await mkdir(control)
  await symlink(control, join(root, 'control-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, wakeState: join(root, 'control-alias', 'wake.json') }))
  await assert.rejects(readConsoleConfig(path), /canonical absolute directories/iu)
  const wakeTarget = join(root, 'wake-target.json'), wakeAlias = join(root, 'wake-alias.json')
  await writeFile(wakeTarget, '{}')
  await symlink(wakeTarget, wakeAlias)
  await writeFile(path, JSON.stringify({ ...config, wakeState: wakeAlias }))
  await assert.rejects(readConsoleConfig(path), /wakeState must not be a symlink/iu)
  const rootAlias = join(dirname(root), `${basename(root)}-alias`)
  await symlink(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path, JSON.stringify({ ...config, testRoot: rootAlias }))
  await assert.rejects(readConsoleConfig(path), /testRoot must be a canonical/iu)
})

test('invalid isolation is rejected before creating any owner lock or starting a process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-invalid-owner-'))
  await assert.rejects(OwnedCodexHost.launch({ testRoot: root, stateDirectory: root, workspace: root, network: 'isolated' }))
  await assert.rejects(access(join(root, 'relay-wake-owner.lock')))
})

test('existing Relay authority requires explicit mode and exact identity while state stays isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-authorized-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'relay-wake-authorized-relay-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace')
  await mkdir(state); await mkdir(workspace)
  const configPath = join(root, 'config.json')
  const base = {
    testRoot: root, codexState: state, workspace, wakeState: join(root, 'wake.json'),
    principal: 'test', bindingId: 'binding', relayDescriptor: join(outside, 'endpoint.json'), relayAuthorityId: 'shared-authority',
  }
  const tokenFilePath = join(outside, 'token')
  // The fixture token is deliberately opaque; the config reader must only resolve its path.
  await writeFile(tokenFilePath, 'fixture-token-content-must-not-be-read')
  const descriptor = (mcpUrl = 'http://127.0.0.1:3080/plugins/dsh-relay/mcp') => ({
    schemaVersion: 1, authorityId: 'shared-authority', mode: 'embedded', mcpUrl,
    tokenFilePath, hostWebUrl: 'http://127.0.0.1:3080/', ownerEpoch: 1, updatedAt: new Date().toISOString(),
  })
  await writeFile(base.relayDescriptor, JSON.stringify(descriptor()))

  await writeFile(configPath, JSON.stringify(base))
  await assert.rejects(readConsoleConfig(configPath))

  const inRootToken = join(root, 'relay-token')
  const inRootDescriptor = join(root, 'endpoint.json')
  await writeFile(inRootToken, 'fixture-only')
  await writeFile(inRootDescriptor, JSON.stringify({ ...descriptor(), tokenFilePath: inRootToken }))
  await writeFile(configPath, JSON.stringify({ ...base, relayDescriptor: inRootDescriptor }))
  await assert.rejects(readConsoleConfig(configPath), /independent test Relay authority required/iu)

  await writeFile(configPath, JSON.stringify({ ...base, relayMode: 'existing-authorized' }))
  assert.equal((await readConsoleConfig(configPath)).relayMode, 'existing-authorized')

  await writeFile(configPath, JSON.stringify({ ...base, relayMode: 'existing-authorized', relayAuthorityId: 'different-authority' }))
  await assert.rejects(readConsoleConfig(configPath))

  await writeFile(base.relayDescriptor, JSON.stringify(descriptor('http://example.com:3080/plugins/dsh-relay/mcp')))
  await writeFile(configPath, JSON.stringify({ ...base, relayMode: 'existing-authorized' }))
  await assert.rejects(readConsoleConfig(configPath), /loopback HTTP/iu)

  await writeFile(base.relayDescriptor, JSON.stringify(descriptor()))
  await writeFile(configPath, JSON.stringify({ ...base, relayMode: 'existing-authorized', wakeState: join(outside, 'wake.json') }))
  await assert.rejects(readConsoleConfig(configPath), /escapes isolated root/iu)

  await writeFile(configPath, JSON.stringify({ ...base, relayMode: 'existing-authorized' }))
  await writeFile(base.relayDescriptor, JSON.stringify({ ...descriptor(), tokenFilePath: join(workspace, 'token') }))
  await writeFile(join(workspace, 'token'), 'fixture-only')
  await assert.rejects(readConsoleConfig(configPath), /outside the model workspace/iu)
})

test('current-runtime keeps writable private state and overlays only absent auth files read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-mount-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace'), currentCodex = join(root, 'current-codex')
  await mkdir(state); await mkdir(workspace); await mkdir(currentCodex)
  const sharedConfig = join(currentCodex, 'config.toml'), sharedAuth = join(currentCodex, 'auth.json')
  const privateAuth = join(state, 'auth.json')
  await writeFile(sharedConfig, 'fixture config')
  await writeFile(sharedAuth, 'fixture auth')
  await writeFile(privateAuth, 'private fixture auth')
  const before = await stat(privateAuth)
  const owner = await acquireWakeLock(join(state, 'relay-wake-owner.lock'))
  try {
    const command = await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex)
    const args = command.args
    assert.ok(args.includes('--bind') && args.includes(state))
    assert.ok(args.includes(sharedConfig))
    assert.ok(args.includes('--ro-bind'))
    assert.ok(!args.includes(sharedAuth))
    assert.ok(args.includes(join(homedir(), '.codex', 'config.toml')))
    assert.ok(!args.includes('--unshare-net'))
    assert.equal((await stat(join(state, 'config.toml'))).size, 0)
    const after = await stat(privateAuth)
    assert.equal(after.ino, before.ino)
    assert.equal(after.size, before.size)
    await command.cleanup()
    await command.cleanup()
    await assert.rejects(stat(join(state, 'config.toml')))

    const second = await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex)
    await writeFile(join(state, 'config.toml'), 'keep this private file')
    await second.cleanup()
    assert.equal((await stat(join(state, 'config.toml'))).size, 'keep this private file'.length)
    await assert.rejects(buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'invalid' as never }, root, state, workspace, currentCodex))
  } finally { await owner.release() }
})

test('current-runtime recovers only manifest-owned placeholders after the previous owner process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-crash-recovery-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace'), currentCodex = join(root, 'current-codex')
  await mkdir(state); await mkdir(workspace); await mkdir(currentCodex)
  const sharedConfig = join(currentCodex, 'config.toml'), sharedAuth = join(currentCodex, 'auth.json')
  await writeFile(sharedConfig, 'fixture config')
  await writeFile(sharedAuth, 'fixture auth')

  const codexProcessUrl = new URL('../src/wake/codex-process.js', import.meta.url).href
  const storeUrl = new URL('../src/wake/store.js', import.meta.url).href
  const childCode = `
    import { join } from 'node:path';
    import { acquireWakeLock } from ${JSON.stringify(storeUrl)};
    import { buildCodexArgs } from ${JSON.stringify(codexProcessUrl)};
    const [root, state, workspace, currentCodex] = process.argv.slice(1, 5);
    await acquireWakeLock(join(state, 'relay-wake-owner.lock'));
    await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex);
    process.exit(0);
  `
  const crash = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode, root, state, workspace, currentCodex], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(crash.status, 0, `crash fixture must create owned placeholders: ${crash.stderr}`)
  const configPath = join(state, 'config.toml'), authPath = join(state, 'auth.json')
  const before = await Promise.all([stat(configPath), stat(authPath)])
  assert.equal(before[0]!.size, 0)
  assert.equal(before[1]!.size, 0)

  const owner = await acquireWakeLock(join(state, 'relay-wake-owner.lock'))
  try {
    const recovered = await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex)
    assert.ok(recovered.args.includes(sharedConfig), 'config overlay is restored after stale-owner recovery')
    assert.ok(recovered.args.includes(sharedAuth), 'auth overlay is restored after stale-owner recovery')
    assert.equal((await stat(configPath)).size, 0)
    assert.equal((await stat(authPath)).size, 0)
    assert.ok((await stat(configPath)).ino !== before[0]!.ino || (await stat(authPath)).ino !== before[1]!.ino,
      'recovery should remove old placeholders and create mountpoints for the new owner')
    await recovered.cleanup()
    await assert.rejects(stat(configPath))
    await assert.rejects(stat(authPath))
    await assert.rejects(stat(join(state, '.relay-wake-current-runtime-mountpoints.json')))
  } finally { await owner.release() }
})

test('current-runtime preserves replaced, nonempty, and unmanifested empty user files during recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-preserve-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace'), currentCodex = join(root, 'current-codex')
  await mkdir(state); await mkdir(workspace); await mkdir(currentCodex)
  const sharedConfig = join(currentCodex, 'config.toml'), sharedAuth = join(currentCodex, 'auth.json')
  await writeFile(sharedConfig, 'fixture config')
  await writeFile(sharedAuth, 'fixture auth')

  const codexProcessUrl = new URL('../src/wake/codex-process.js', import.meta.url).href
  const storeUrl = new URL('../src/wake/store.js', import.meta.url).href
  const childCode = `
    import { join } from 'node:path';
    import { acquireWakeLock } from ${JSON.stringify(storeUrl)};
    import { buildCodexArgs } from ${JSON.stringify(codexProcessUrl)};
    const [root, state, workspace, currentCodex] = process.argv.slice(1, 5);
    await acquireWakeLock(join(state, 'relay-wake-owner.lock'));
    await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex);
    process.exit(0);
  `
  const crash = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode, root, state, workspace, currentCodex], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(crash.status, 0, `crash fixture must create owned placeholders: ${crash.stderr}`)
  const configPath = join(state, 'config.toml'), authPath = join(state, 'auth.json')
  const oldConfig = await stat(configPath), oldAuth = await stat(authPath)
  const replacementConfig = join(state, 'replacement-config')
  const replacementAuth = join(state, 'replacement-auth')
  await writeFile(replacementConfig, 'private config that must survive')
  await writeFile(replacementAuth, '')
  assert.notEqual((await stat(replacementConfig)).ino, oldConfig.ino)
  assert.notEqual((await stat(replacementAuth)).ino, oldAuth.ino)
  await rename(replacementConfig, configPath)
  await rename(replacementAuth, authPath)
  const configReplacementIdentity = await stat(configPath)
  const authReplacementIdentity = await stat(authPath)

  const owner = await acquireWakeLock(join(state, 'relay-wake-owner.lock'))
  try {
    const recovered = await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex)
    assert.ok(!recovered.args.includes(sharedConfig), 'nonempty replacement is preserved without an overlay')
    assert.ok(!recovered.args.includes(sharedAuth), 'empty replacement inode is preserved without an overlay')
    assert.equal(await readFile(configPath, 'utf8'), 'private config that must survive')
    assert.equal((await stat(configPath)).ino, configReplacementIdentity.ino)
    assert.equal((await stat(authPath)).ino, authReplacementIdentity.ino)
    await recovered.cleanup()
  } finally { await owner.release() }

  const emptyRoot = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-unmanifested-empty-'))
  const emptyState = join(emptyRoot, 'codex-state'), emptyWorkspace = join(emptyRoot, 'workspace'), emptyCodex = join(emptyRoot, 'current-codex')
  await mkdir(emptyState); await mkdir(emptyWorkspace); await mkdir(emptyCodex)
  await writeFile(join(emptyCodex, 'auth.json'), 'fixture auth')
  const privateEmpty = join(emptyState, 'auth.json')
  await writeFile(privateEmpty, '')
  const emptyIdentity = await stat(privateEmpty)
  const emptyOwner = await acquireWakeLock(join(emptyState, 'relay-wake-owner.lock'))
  try {
    const command = await buildCodexArgs({ testRoot: emptyRoot, stateDirectory: emptyState, workspace: emptyWorkspace, network: 'model-access', codexMode: 'current-runtime' }, emptyRoot, emptyState, emptyWorkspace, emptyCodex)
    assert.ok(!command.args.includes(join(emptyCodex, 'auth.json')), 'unmanifested empty private auth file is not treated as an owned placeholder')
    await command.cleanup()
    assert.equal((await stat(privateEmpty)).ino, emptyIdentity.ino)
  } finally { await emptyOwner.release() }
})

test('current-runtime fails closed on a malformed mountpoint ownership manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-malformed-manifest-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace'), currentCodex = join(root, 'current-codex')
  await mkdir(state); await mkdir(workspace); await mkdir(currentCodex)
  const manifest = join(state, '.relay-wake-current-runtime-mountpoints.json')
  await writeFile(manifest, '{not valid json', { mode: 0o600 })
  const owner = await acquireWakeLock(join(state, 'relay-wake-owner.lock'))
  try {
    await assert.rejects(buildCodexArgs({ testRoot: root, stateDirectory: state, workspace, network: 'model-access', codexMode: 'current-runtime' }, root, state, workspace, currentCodex),
      /current-runtime mountpoint manifest is malformed/iu)
    assert.equal(await readFile(manifest, 'utf8'), '{not valid json')
    await assert.rejects(stat(join(state, 'config.toml')))
  } finally { await owner.release() }
})

test('an explicitly selected installed App Server runtime is mounted read-only outside the shadowed Codex home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-wake-runtime-binary-'))
  const state = join(root, 'codex-state'), workspace = join(root, 'workspace')
  await mkdir(state); await mkdir(workspace)
  const installed = join(homedir(), '.codex/packages/app-server-daemon/releases')
  const { readdir } = await import('node:fs/promises')
  const candidates = (await readdir(installed)).sort().reverse().map(name => join(installed, name, 'bin/codex'))
  let executable: string | undefined
  for (const path of candidates) {
    try { if ((await stat(path)).isFile()) { executable = path; break } } catch {}
  }
  if (!executable) return
  const owner = await acquireWakeLock(join(state, 'relay-wake-owner.lock'))
  try {
    const command = await buildCodexArgs({ testRoot: root, stateDirectory: state, workspace,
      codexMode: 'current-runtime', network: 'model-access', codexExecutable: executable }, root, state, workspace)
    const marker = command.args.indexOf('--')
    assert.ok(marker > 0)
    const mountIndex = command.args.indexOf(executable.replace(/\/bin\/codex$/u, ''))
    assert.ok(mountIndex > 0)
    const mountTarget = command.args[mountIndex + 1]!
    assert.ok(mountTarget.startsWith(root))
    assert.equal(command.args[marker + 1], join(mountTarget, 'bin/codex'))
    assert.ok(!command.args.slice(0, marker).includes('--bind') || !command.args.slice(0, marker).includes(executable))
    await command.cleanup()
    await assert.rejects(stat(mountTarget))
    await assert.rejects(buildCodexArgs({ testRoot: root, stateDirectory: state, workspace,
      codexMode: 'current-runtime', network: 'model-access', codexExecutable: join(root, 'not-installed') }, root, state, workspace))
  } finally { await owner.release() }
})
