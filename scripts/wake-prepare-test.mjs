// Prepare reviewable, independent state. Login is a separate user-invoked script.
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const requested = process.argv[2]
if (!requested || !isAbsolute(requested)) throw new Error('explicit absolute test directory required')
await mkdir(requested, { recursive: true, mode: 0o700 })
const root = await realpath(requested)
const inside = (parent, path) => { const suffix = relative(parent, path); return !isAbsolute(suffix) && suffix.split(sep)[0] !== '..' }
if (root === '/' || root === homedir() || ['.codex', '.dsh', 'dsh-relay'].some(p => inside(join(homedir(), p), root))) throw new Error('dedicated test root required')
for (const name of ['codex-state', 'workspace', 'control']) await mkdir(join(root, name), { recursive: true, mode: 0o700 })
const config = { testRoot: root, codexState: join(root, 'codex-state'), workspace: join(root, 'workspace'),
  wakeState: join(root, 'control', 'wake.json'), principal: 'wake-test', bindingId: randomUUID(), network: 'isolated', enabled: false }
const configPath = join(root, 'console-config.json')
try { await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST') throw error }
const quote = arg => `'${arg.replaceAll("'", "'\"'\"'")}'`
const args = ['bwrap', '--unshare-user', '--new-session', '--die-with-parent', '--ro-bind', '/', '/', '--tmpfs', '/tmp',
  '--bind', root, root, '--bind', config.codexState, join(homedir(), '.codex'), '--proc', '/proc', '--dev', '/dev',
  '--chdir', config.workspace, '--clearenv', '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
  '--', 'codex', 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']
const loginPath = join(root, 'login-codex-isolated.sh')
try { await writeFile(loginPath, '#!/bin/sh\n# USER INVOKES THIS LOGIN; no shared credentials are read/copied.\nexec ' + args.map(quote).join(' ') + '\n', { mode: 0o700, flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST') throw error }
console.log(JSON.stringify({ config: configPath, userLoginScript: loginPath, loginExecuted: false,
  note: 'Review and invoke the login script yourself. Configure only the independent DSH provider/UI; never paste credentials into chat. Add its descriptor and authority ID to the config, then explicitly select model-access networking.' }, null, 2))
