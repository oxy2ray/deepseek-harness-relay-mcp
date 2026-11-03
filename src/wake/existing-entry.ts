import { access, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CodexDaemonClient, createCodexUnixWebSocketTransport } from './codex-daemon-client.js'
import { ExistingCodexHost } from './existing-codex-host.js'
import { existingWakeConfigPath, readExistingWakeConfig } from './existing-config.js'
import { WakeStore, acquireWakeLock } from './store.js'
import { WakeOutbox } from './outbox.js'
import { WakeRuntime } from './runtime.js'
import { NativeRelayWakeSource } from './relay-client.js'

const config = await readExistingWakeConfig(process.argv[2] ?? existingWakeConfigPath())
if (!config) throw new Error('explicit existing-daemon wake configuration required')
await mkdir(dirname(config.wakeState), { recursive: true, mode: 0o700 })
const outbox = new WakeOutbox(new WakeStore(config.wakeState))
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
try {
  while (!stop) {
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
