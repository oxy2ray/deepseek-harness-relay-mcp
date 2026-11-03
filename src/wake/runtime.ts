import { randomUUID } from 'node:crypto'
import type { FileLockLease } from '../state-repository/index.js'
import { acquireWakeLock } from './store.js'
import { collectWakeEvents, type WakeRunSource } from './collector.js'
import { WakeDispatcher, type WakeHost } from './dispatcher.js'
import { WakeOutbox } from './outbox.js'

/** Long-lived collector independent of MCP proxy lifetimes. No DSH submission API. */
export class WakeRuntime {
  private readonly ownerId = randomUUID()
  private lease: FileLockLease | null = null
  private running = false
  private closing = false
  private activeTick: Promise<void> | null = null
  constructor(readonly outbox: WakeOutbox, readonly source: WakeRunSource, readonly host: WakeHost) {}

  async start(): Promise<void> {
    if (this.lease) throw new Error('wake worker already started')
    this.lease = await acquireWakeLock(`${this.outbox.store.path}.worker.lock`)
    this.closing = false
    try { await this.heartbeat(false) }
    catch (error) { await this.lease.release(); this.lease = null; throw error }
  }

  async tick(): Promise<{ collected: number; failed: number; started: number; ready: boolean }> {
    if (!this.lease || this.running || this.closing) throw new Error('wake worker not started or already ticking')
    this.running = true
    let finish!: () => void
    this.activeTick = new Promise<void>(resolve => { finish = resolve })
    try {
      const beforeCollection = await this.probeReadiness()
      await this.heartbeat(beforeCollection.ready && !this.closing, beforeCollection.bindingIds)
      const collected = await collectWakeEvents(this.outbox, this.source)
      // Collection may be slow. Re-probe before extending the three-second readiness lease.
      const afterCollection = await this.probeReadiness()
      const ready = afterCollection.ready && !this.closing
      await this.heartbeat(ready, ready ? afterCollection.bindingIds : [])
      const dispatched = ready ? await new WakeDispatcher(this.outbox, this.host).tick() : { started: 0 }
      return { collected: collected.collected, failed: collected.failed.length, started: dispatched.started, ready }
    } catch (error) {
      await this.heartbeat(false).catch(() => undefined)
      throw error
    } finally { this.running = false; this.activeTick = null; finish() }
  }

  async close(): Promise<void> {
    if (!this.lease) return
    this.closing = true
    await this.activeTick
    try { await this.heartbeat(false) }
    finally { await this.lease.release(); this.lease = null }
  }

  private async heartbeat(ready: boolean, bindingIds: string[] = []): Promise<void> {
    await this.outbox.store.transaction(state => {
      state.worker = { ownerId: this.ownerId, heartbeatAt: this.outbox.now(), ready, bindingIds }
    })
  }

  private async probeReadiness(): Promise<{ ready: boolean; bindingIds: string[] }> {
    try {
      const capability = await this.host.capabilities()
      const capable = capability.authenticated && capability.sameThreadResume && capability.durableHistory
        && capability.completionEvidence && capability.exclusiveIdleAdmission
      if (!capable || this.closing) return { ready: false, bindingIds: [] }
      const bindings = (await this.outbox.store.read()).bindings
      const bindingIds: string[] = []
      for (const binding of bindings) {
        if (binding.serverIdentity !== capability.serverIdentity || binding.expiresAt <= this.outbox.now()) continue
        try {
          const inspected = await this.host.inspect(binding)
          if (inspected.threadId === binding.threadId && inspected.workspace === binding.workspace) bindingIds.push(binding.bindingId)
        } catch { /* cannot acknowledge a watch for an unowned/unloaded thread */ }
      }
      // Ownership checks can take time too; use a capability result after them as the readiness proof.
      const finalCapability = await this.host.capabilities()
      const finalReady = finalCapability.serverIdentity === capability.serverIdentity
        && finalCapability.authenticated && finalCapability.sameThreadResume && finalCapability.durableHistory
        && finalCapability.completionEvidence && finalCapability.exclusiveIdleAdmission
      return { ready: finalReady && !this.closing, bindingIds: finalReady && !this.closing ? bindingIds : [] }
    } catch { return { ready: false, bindingIds: [] } }
  }
}
