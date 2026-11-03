// Real installed App Server protocol probe. No authentication or model inference.
// Linux bubblewrap hides the shared Codex home without changing HOME/CODEX_HOME.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = await mkdtemp(join(tmpdir(), 'relay-wake-probe-'))
const state = join(root, 'state')
const workspace = join(root, 'workspace')
await mkdir(state, { mode: 0o700 })
await mkdir(workspace)
const child = spawn('bwrap', [
  '--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
  '--ro-bind', '/', '/', '--bind', state, join(homedir(), '.codex'),
  '--bind', root, root, '--proc', '/proc', '--dev', '/dev',
  '--chdir', workspace, '--', 'codex', 'app-server', '--listen', 'stdio://',
  '-c', 'cli_auth_credentials_store="file"',
], { stdio: ['pipe', 'pipe', 'pipe'], env: {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: 'C.UTF-8',
} })
const pending = new Map()
let nextId = 0
let stderr = ''
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const resolve = pending.get(message.id)
  if (resolve) { pending.delete(message.id); resolve(message) }
})
async function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)) }, 15000)
    pending.set(id, result => { clearTimeout(timer); resolve(result) })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
const report = { isolation: 'bubblewrap-private-state-and-network', authentication: 'none', inference: 'network-disabled-admission-only', checks: {} }
try {
  const initialized = await rpc('initialize', { clientInfo: { name: 'relay-wake-isolated-probe', version: '1' }, capabilities: { experimentalApi: true } })
  if (initialized.error) throw new Error(JSON.stringify(initialized.error))
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  const started = await rpc('thread/start', { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'on-request' })
  if (started.error) throw new Error(JSON.stringify(started.error))
  const threadId = started.result.thread.id
  // Materialize only this empty test thread. With no auth this must fail closed;
  // a successful API admission is not evidence of successful model inference.
  report.materialization = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Isolated protocol probe: reply OK.' }] })
  await new Promise(resolve => setTimeout(resolve, 1000))
  for (const [name, method, params] of [
    ['resumeMetadata', 'thread/resume', { threadId, excludeTurns: true }],
    ['resumeFull', 'thread/resume', { threadId }],
    ['turnHistory', 'thread/turns/list', { threadId, limit: 10 }],
  ]) {
    const result = await rpc(method, params)
    report.checks[name] = result.error ? { passed: false, error: result.error } : { passed: true }
  }
  report.gate = 'not-accepted: no authenticated same-thread remote TUI E2E in isolated state'
} catch (error) {
  report.failure = String(error)
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill('SIGTERM')
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  lines.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ root, ...report }, null, 2))
  if (report.failure) console.error(stderr)
}
