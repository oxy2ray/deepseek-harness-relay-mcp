// Install the two reviewable local quota packages into a private DSH profile only.
import { spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidate = await realpath(join(repo, '.runtime/dsh-candidate'))
const [requestedRoot, requestedCli] = process.argv.slice(2)
if (!requestedRoot || !isAbsolute(requestedRoot)) throw new Error('An explicit private test root is required')
const root = await realpath(requestedRoot)
if (!within(candidate, root)) throw new Error('Test installation must stay below the private candidate directory')
const home = join(root, 'dsh-state')
await mkdir(home, { recursive: true, mode: 0o700 })
if (await realpath(home) !== home || !(await lstat(home)).isDirectory()) throw new Error('Private DSH state must be a canonical directory')
const artifactRoot = join(root, 'artifacts')
const artifacts = [join(artifactRoot, 'dsh-opencode-go-usage-dock-0.1.4-relay.1.tgz'), join(artifactRoot, 'dsh-ark-agent-plan-usage-dock-0.1.0.tgz')]
for (const file of artifacts) {
  if (!within(root, await realpath(file)) || !(await lstat(file)).isFile()) throw new Error('Private local package artifacts are required')
}
let cli
if (requestedCli !== undefined) {
  if (!isAbsolute(requestedCli)) throw new Error('Explicit DSH CLI path must be absolute')
  const cliStat = await lstat(requestedCli)
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) throw new Error('Explicit DSH CLI must be a regular non-symlink file')
  cli = await realpath(requestedCli)
  if (cli !== requestedCli) throw new Error('Explicit DSH CLI path must be canonical')
} else {
  cli = await realpath(join(candidate, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
}
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', DSH_HOME: home }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  const value = process.env[key]
  if (!value) continue
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid proxy configuration') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Credential-free proxy configuration required')
  env[key] = value
}
env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1,[::1]'
const logPath = join(root, 'package-install.log')
const log = await open(logPath, 'wx', 0o600)
try {
  const child = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', ...artifacts.map(path => `file:${path}`),
    '--ignore-scripts', '--config.auto-install-peers=false', '--store-dir', join(root, 'pnpm-store')], {
    cwd: root, env, stdio: ['ignore', log.fd, log.fd],
  })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
  if (code !== 0) throw new Error('Private DSH package installation failed; inspect its private installation log')
} finally { await log.close() }
const profilePath = join(home, 'profiles/web/package.json')
const profile = JSON.parse(await readFile(profilePath, 'utf8'))
for (const name of ['dsh-opencode-go-usage-dock', 'dsh-ark-agent-plan-usage-dock']) {
  if (!profile.dependencies?.[name]) throw new Error('Expected quota dependency missing from private profile')
}
process.stdout.write(`${JSON.stringify({ installedPackages: Object.keys(profile.dependencies).filter(name => /usage-dock/u.test(name)),
  privateDshHome: home, profile: profilePath, sharedProfileTouched: false, packageScriptsExecuted: false, logPath })}\n`)

function within(parent, path) {
  const part = relative(parent, path)
  return part !== '' && !isAbsolute(part) && part.split(sep)[0] !== '..'
}
