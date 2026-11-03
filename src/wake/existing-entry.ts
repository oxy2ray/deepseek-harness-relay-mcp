import { access, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { CodexDaemonClient, createCodexUnixWebSocketTransport } from './codex-daemon-client.js'
import { ExistingCodexHost } from './existing-codex-host.js'
import { existingWakeConfigPath, readExistingWakeConfig } from './existing-config.js'
import { WakeStore, acquireWakeLock } from './store.js'
import { WakeOutbox } from './outbox.js'
import { WakeRuntime } from './runtime.js'
import { NativeRelayWakeSource } from './relay-client.js'

const config = await readExistingWakeConfig(process.argv[2] ?? existingWakeConfigPath())
if (!config) throw new Error('explicit existing-daemon wake configuration required')
// Captured after the null guard so nested worker helpers keep the non-null type.
const wakeConfig = config
await mkdir(dirname(config.wakeState), { recursive: true, mode: 0o700 })
const outbox = new WakeOutbox(new WakeStore(config.wakeState))
// Canonical auto-bind roots are resolved once per worker process. A root that is
// physically unavailable simply cannot admit auto-bound threads.
const autoRoots: string[] = config.autoBind
  ? (await Promise.all(config.autoBind.workspaceRoots.map(async root => realpath(root).catch(() => null))))
    .filter((root): root is string => root !== null)
  : []
// This process lease also covers reconnect intervals, preventing duplicate reconnect workers.
const owner = await acquireWakeLock(config.wakeState + '.existing-process.lock')
const hasState = await access(config.wakeState).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
  throw error
})
// Bootstrap seed only: config.enabled initializes a brand-new store before bindings
// create durable state, so an interrupted first attach cannot strand the initial
// opt-in. An existing store keeps its `enabled`, including an operator pause; this
// is not a standing override and config is read once per process (stop/restart).
if (!hasState) await outbox.store.transaction(state => { state.enabled = config.enabled })
let stop = false
let timer: NodeJS.Timeout | undefined
let wake: (() => void) | undefined
const sleep = (ms: number) => new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, ms) })
const close = () => { stop = true; if (timer) clearTimeout(timer); wake?.() }
process.once('SIGINT', close)
process.once('SIGTERM', close)

/** Bounded local memory of persisted auto rows this worker already tried to attach. */
const attempted = new Map<string, string>()
const staticBindingIds = new Set(config.bindings.map(binding => binding.bindingId))

/**
 * Reads persisted bindings on every worker iteration and attaches only threads the
 * operator policy allows: configured static bindings (attached at startup) or
 * auto-created rows whose canonical workspace physically lies under a configured
 * auto-bind root. Global/per-binding pause and expiry are honored, and nothing is
 * retargeted. This reuses the one long-lived daemon client and worker lease.
 */
async function attachEligibleBindings(host: ExistingCodexHost): Promise<void> {
  if (autoRoots.length === 0) return
  const state = await outbox.store.read()
  if (!state.enabled) return // A global operator pause also pauses auto attachment.
  const now = outbox.now()
  for (const binding of state.bindings) {
    if (binding.principal !== wakeConfig.principal || binding.serverIdentity !== host.serverIdentity) continue
    if (!binding.enabled || binding.expiresAt <= now) continue
    if (staticBindingIds.has(binding.bindingId)) continue // Already attached through config.
    const fingerprint = JSON.stringify(binding)
    if (attempted.get(binding.bindingId) === fingerprint) continue
    const physical = await realpath(binding.workspace).catch(() => null)
    if (physical === null || !autoRoots.some(root => containsPhysicalPath(root, physical))) continue
    try {
      await host.attachBindings([{ threadId: binding.threadId, workspace: binding.workspace }])
      attempted.set(binding.bindingId, fingerprint)
    } catch { /* stay unattached; only a changed persisted row is retried */ }
  }
}

function containsPhysicalPath(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

try {
  while (!stop) {
    // A fresh client means a fresh host: every persisted auto row must attach again
    // on the new daemon connection.
    attempted.clear()
    const client = new CodexDaemonClient({ transport: createCodexUnixWebSocketTransport({ socket: config.socket }) })
    let disconnected = false
    client.onDisconnected(() => { disconnected = true; if (timer) clearTimeout(timer); wake?.() })
    let runtime: WakeRuntime | undefined
    let source: NativeRelayWakeSource | undefined
    try {
      const initialized = await client.initialize()
      if (!initialized.codexHome) throw new Error('daemon did not publish its identity')
      const host = await ExistingCodexHost.attach({ client, socket: config.socket,
        codexHome: initialized.codexHome, uid: process.getuid?.() ?? 0, bindings: config.bindings })
      for (const binding of config.bindings) {
        const old = (await outbox.store.read()).bindings.find(b => b.bindingId === binding.bindingId)
        if (old) {
          if (old.threadId !== binding.threadId || old.workspace !== binding.workspace
            || old.principal !== config.principal || old.serverIdentity !== host.serverIdentity
            || old.relayWorkspace !== binding.relayWorkspace) throw new Error('existing binding identity changed')
        } else await outbox.registerBinding({ ...binding, principal: config.principal,
          serverIdentity: host.serverIdentity, enabled: true })
      }
      source = await NativeRelayWakeSource.connect({ descriptorFile: config.relayDescriptor,
        clientPrincipalId: config.principal, requestTimeoutMs: 5000, autoStart: false })
      runtime = new WakeRuntime(outbox, source, host)
      await runtime.start()
      while (!stop && !disconnected) {
        await attachEligibleBindings(host).catch(() => undefined)
        try { await runtime.tick() }
        catch { process.stderr.write('Wake tick unavailable; durable queue retained.\n') }
        if (!stop && !disconnected) await sleep(750)
      }
    } catch { process.stderr.write('Existing Codex attachment unavailable; no turn submitted. Retrying local attachment.\n') }
    finally {
      await runtime?.close()
      await source?.close()
      await client.close()
    }
    if (!stop) await sleep(2000)
  }
} finally {
  await owner.release()
  process.off('SIGINT', close)
  process.off('SIGTERM', close)
}
