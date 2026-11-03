import type { WakeRunSnapshot } from './schema.js'
import { WakeOutbox } from './outbox.js'

export interface WakeRunSource {
  // The adapter must enforce principal ownership using the existing Relay broker.
  getRun(runId: string, principal: string): Promise<WakeRunSnapshot>
}

/** Single bounded pass, suitable for a long-lived authority's background loop. */
export async function collectWakeEvents(outbox: WakeOutbox, source: WakeRunSource): Promise<{ collected: number; failed: string[] }> {
  const state = await outbox.store.read()
  const result = { collected: 0, failed: [] as string[] }
  for (const watch of state.watches) {
    if (!watch.active || watch.terminal) continue
    const binding = state.bindings.find(b => b.bindingId === watch.bindingId)
    if (!binding || binding.expiresAt <= outbox.now()) continue
    try {
      const run = await source.getRun(watch.runId, binding.principal)
      if (run.runId !== watch.runId) throw new Error('wrong run returned by source')
      if (await outbox.observe(run, binding.principal)) result.collected++
    } catch {
      // No model output, remote error or credentials in durable diagnostics.
      result.failed.push(watch.subscriptionId)
    }
  }
  return result
}
