import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import { createConsoleMcpConfig, readConsoleConfig } from './console-config.js'
import { createConsoleOutput } from './console-output.js'
import { OwnedCodexHost } from './owned-codex-host.js'
import { NativeRelayWakeSource } from './relay-client.js'
import { WakeStore } from './store.js'
import { WakeOutbox } from './outbox.js'
import { WakeRuntime } from './runtime.js'
import { wakeDiagnostics } from './diagnostics.js'
import { WakeDispatcher } from './dispatcher.js'

// Managed-console fallback only. It never connects to the ordinary Codex daemon/TUI.
const cliArgs = process.argv.slice(2)
const knownFlags = new Set(['--check', '--json', '--human', '--help'])
const suppliedFlags = cliArgs.filter(arg => arg.startsWith('--'))
const unknownFlags = suppliedFlags.filter(arg => !knownFlags.has(arg))
if (unknownFlags.length) throw new Error(`Unknown console option: ${unknownFlags[0]}`)
if (cliArgs.includes('--json') && cliArgs.includes('--human')) throw new Error('--json and --human cannot be used together')
const positionalArgs = cliArgs.filter(arg => !arg.startsWith('--'))
if (positionalArgs.length > 1) throw new Error('Usage: dsh-relay-wake-console <absolute-test-config.json> [--check] [--json|--human]')
const configPath = positionalArgs[0]
const output = createConsoleOutput({ json: cliArgs.includes('--json') || (!cliArgs.includes('--human') && !process.stdout.isTTY),
  write: text => { process.stdout.write(text) } })
const emit = (type: string, data: unknown) => output.emit(type, data)
if (cliArgs.includes('--help')) {
  emit('help', undefined)
  output.close()
  process.exitCode = 0
} else if (!configPath) {
  process.stderr.write('Usage: dsh-relay-wake-console <absolute-test-config.json> [--check] [--json|--human]\n')
  output.close()
  process.exitCode = 2
} else {
const config = await readConsoleConfig(configPath)
const existingState = await access(config.wakeState).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
  throw error
})
const outbox = new WakeOutbox(new WakeStore(config.wakeState))
const host = await OwnedCodexHost.launch({ testRoot: config.testRoot, stateDirectory: config.codexState, workspace: config.workspace, codexMode: config.codexMode, ...(config.codexExecutable ? { codexExecutable: config.codexExecutable } : {}), network: config.network })
let source: NativeRelayWakeSource | undefined
let runtime: WakeRuntime | undefined
let stop = false
let pump: Promise<void> | undefined
host.process.on('notification', (message: unknown) => emit('codex', message))
host.process.on('serverRequest', (message: unknown) => emit('manual-response-required', message))
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const close = () => { stop = true; input.close() }
process.once('SIGINT', close)
process.once('SIGTERM', close)
try {
  if (process.argv.includes('--check')) {
    const capability = await host.capabilities()
    if (config.relayDescriptor) source = await NativeRelayWakeSource.connect({ descriptorFile: config.relayDescriptor,
      clientPrincipalId: config.principal, requestTimeoutMs: 5000, autoStart: false })
    const relay = await source?.diagnose()
    emit('preflight', { authenticated: capability.authenticated, relayConfigured: Boolean(config.relayDescriptor),
      relayConnected: relay?.connected ?? false, mode: 'managed-console-fallback' })
    process.exitCode = capability.authenticated && relay?.connected ? 0 : 2
  } else {
  const existing = (await outbox.store.read()).bindings.find(b => b.bindingId === config.bindingId)
  const mcpConfig = createConsoleMcpConfig(config.disabledMcpServers, config.relayDescriptor ? { command: process.execPath,
    args: [fileURLToPath(new URL('./dsh-relay-wake-proxy.mjs', import.meta.url)), configPath], startup_timeout_sec: 10, required: true } : undefined)
  let threadId: string
  if (existing) {
    if (existing.serverIdentity !== host.serverIdentity || existing.workspace !== config.workspace
      || (existing.relayWorkspace ?? existing.workspace) !== config.relayWorkspace
      || existing.principal !== config.principal || existing.expiresAt <= Date.now()) throw new Error('existing binding is mismatched or expired; no automatic retargeting')
    threadId = existing.threadId
    await host.resumeThread(threadId, mcpConfig)
  } else {
    threadId = await host.startThread(mcpConfig)
    await outbox.registerBinding({ bindingId: config.bindingId, threadId, principal: config.principal,
      workspace: config.workspace, relayWorkspace: config.relayWorkspace, serverIdentity: host.serverIdentity, enabled: true, expiresAt: Date.now() + 7 * 86400000 })
  }
  // A persisted pause wins over bootstrap configuration on every restart.
  if (config.enabled && !existingState) await outbox.setEnabled(true)
  if (config.relayDescriptor) source = await NativeRelayWakeSource.connect({
    descriptorFile: config.relayDescriptor, clientPrincipalId: config.principal, requestTimeoutMs: 5000, autoStart: false,
  })
  runtime = new WakeRuntime(outbox, source ?? { getRun: async () => { throw new Error('independent Relay not configured') } }, host)
  await runtime.start()
  emit('console-bound', { threadId, bindingId: config.bindingId, mode: 'managed-console-fallback', remoteTuiAcceptance: false })
  emit('readiness', { ...await host.capabilities(), relayConfigured: Boolean(source) })
  {
    pump = (async () => {
      while (!stop) {
        try {
          // Once the first user message materializes this owned thread, subscribe and probe history.
          await host.resumeThread(threadId).catch(() => undefined)
          const result = await runtime!.tick()
          if (result.started || result.failed) emit('wake-tick', result)
        } catch { emit('wake-paused-by-error', 'Queue preserved; inspect status. No DSH task was resubmitted.') }
        await new Promise(resolve => setTimeout(resolve, 750))
      }
    })()
    emit('help', 'Text submits a user message only when idle. /status /pause /resume /watch RUN KEY /recover DISPATCH_ID /respond ID JSON /quit. Approvals are never automatic.')
    for await (const line of input) {
      try {
        if (line === '/quit') { close(); break }
        if (line === '/status') emit('status', wakeDiagnostics(await outbox.store.read()))
        else if (line === '/pause' || line === '/resume') {
          await outbox.setEnabled(line === '/resume'); emit('status', wakeDiagnostics(await outbox.store.read()))
        } else if (line.startsWith('/recover ')) {
          const id = line.slice('/recover '.length)
          emit('held-recovery', await new WakeDispatcher(outbox, host).reconcileHeld(id))
        } else if (line.startsWith('/respond ')) {
          const match = /^\/respond (\S+) ([\s\S]+)$/.exec(line)
          if (!match) throw new Error('response syntax')
          const id = /^\d+$/.test(match[1]!) ? Number(match[1]) : match[1]!
          const response = JSON.parse(match[2]!) as Record<string, unknown>
          if (typeof response.decision === 'string' && !['accept', 'decline', 'cancel'].includes(response.decision)) throw new Error('only one-time approval decisions supported')
          host.process.answer(id, response)
        } else if (line.startsWith('/watch ')) {
          const match = /^\/watch ([A-Za-z0-9_.:-]+) ([A-Za-z0-9_.:-]+)$/.exec(line)
          if (!match || !source) throw new Error('independent Relay and run/key required')
          const run = await source.getRun(match[1]!, config.principal)
          const subscriptionId = await outbox.watch({ run, principal: config.principal, bindingId: config.bindingId, idempotencyKey: match[2]! })
          emit('watch-registered', { subscriptionId, runId: run.runId, note: 'Check readiness/status; registration alone is not an event-driven acknowledgement.' })
        } else if (line.startsWith('/')) throw new Error('unknown command')
        else if (line.trim()) {
          if (line.length > 100000) throw new Error('input too large')
          emit('user-admission', await host.sendUserMessage(threadId, line))
        }
      } catch { emit('command-rejected', 'No new permission was granted. Check syntax, readiness, idle status or pending request identity.') }
    }
  }
  }
} finally {
  stop = true
  input.close()
  let cleanupFailed = false
  try { await host.close() } catch { cleanupFailed = true }
  try { await pump } catch { cleanupFailed = true }
  try { await runtime?.close() } catch { cleanupFailed = true }
  try { await source?.close() } catch { cleanupFailed = true }
  if (cleanupFailed) { emit('cleanup-warning', 'Inspect private process/lock state; no shared process was targeted.'); process.exitCode = 1 }
  process.off('SIGINT', close)
  process.off('SIGTERM', close)
  output.close()
}
}
