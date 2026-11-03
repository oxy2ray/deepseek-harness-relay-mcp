import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WakeRunSnapshot } from './schema.js'
import { WakeOutbox } from './outbox.js'

export interface WakeToolContext { outbox: WakeOutbox; bindingId: string }
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/)
const watchInput = z.object({ runId: identifier, idempotencyKey: identifier,
  events: z.array(z.enum(['terminal', 'needs_attention'])).min(1).max(2).optional() }).strict()

export const wakeTools: Tool[] = [
  { name: 'watch_run', description: 'Opt-in durable watch for this console’s preconfigured binding. Only acknowledged=true and hostMayConcludeTurn=true permit ending this host turn. If unavailable, continue wait_run. No destination or permission can be changed.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, idempotencyKey: { type: 'string' }, events: { type: 'array', items: { enum: ['terminal', 'needs_attention'] } } }, required: ['runId', 'idempotencyKey'], additionalProperties: false } },
  { name: 'unwatch_run', description: 'Stop observing an owned subscription; preserve durable events.', inputSchema: { type: 'object', properties: { subscriptionId: { type: 'string' } }, required: ['subscriptionId'], additionalProperties: false } },
  { name: 'list_watches', description: 'List subscriptions owned by this console binding.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'replay_run_events', description: 'Read bounded durable event facts, not full DSH results.', inputSchema: { type: 'object', properties: { cursor: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
]

export async function callWakeTool(context: WakeToolContext, principal: string, name: string, args: unknown,
  getRun: (id: string) => Promise<WakeRunSnapshot>) {
  const state = await context.outbox.store.read()
  const binding = state.bindings.find(b => b.bindingId === context.bindingId)
  if (!binding || binding.principal !== principal) throw new Error('wake binding not owned by this principal')
  switch (name) {
    case 'watch_run': {
      const input = watchInput.parse(args)
      const now = context.outbox.now()
      if (!state.enabled || !binding.enabled || binding.expiresAt <= now || !state.worker?.ready
        || !state.worker.bindingIds.includes(binding.bindingId)
        || state.worker.heartbeatAt > now || now - state.worker.heartbeatAt > 3000) throw new Error('wake worker unavailable; continue wait_run')
      const run = await getRun(input.runId)
      if (run.runId !== input.runId) throw new Error('run identity mismatch')
      const subscriptionId = await context.outbox.watch({ run, bindingId: binding.bindingId, principal,
        idempotencyKey: input.idempotencyKey, requireReadyWorker: true, ...(input.events ? { events: input.events } : {}) })
      return { subscriptionId, runId: run.runId, acknowledged: true, currentStatus: run.status, hostMayConcludeTurn: true }
    }
    case 'unwatch_run': {
      const input = z.object({ subscriptionId: identifier }).strict().parse(args)
      // A principal may have multiple bindings; don't allow cross-binding changes.
      if (!state.watches.some(w => w.subscriptionId === input.subscriptionId && w.bindingId === binding.bindingId)) throw new Error('subscription not owned by this binding')
      await context.outbox.unwatch(input.subscriptionId, principal)
      return { stopped: true }
    }
    case 'list_watches':
      z.object({}).strict().parse(args)
      return { watches: state.watches.filter(w => w.bindingId === binding.bindingId) }
    case 'replay_run_events': {
      const input = z.object({ cursor: z.number().int().nonnegative().optional() }).strict().parse(args)
      return context.outbox.replay(binding.bindingId, principal, input.cursor)
    }
    default: throw new Error('unknown wake tool')
  }
}
