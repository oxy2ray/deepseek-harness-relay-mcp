import { z } from 'zod'
import type { RunSnapshot } from '../types.js'
export type WakeRunSnapshot = Pick<RunSnapshot, 'runId' | 'sessionId' | 'workspace' | 'status' | 'lastEventSeq' | 'permissionPreset' | 'taskScope'>

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/)
const path = z.string().min(1).max(4096)
const timestamp = z.number().int().nonnegative()
export const eventKind = z.enum(['terminal', 'needs_attention'])
export const bindingSchema = z.object({
  bindingId: id, threadId: id, principal: id, workspace: path, relayWorkspace: path.optional(),
  serverIdentity: id, enabled: z.boolean(), expiresAt: timestamp,
}).strict()
export const watchSchema = z.object({
  subscriptionId: id, runId: id, sessionId: id, bindingId: id,
  idempotencyKey: id, filters: z.array(eventKind).min(1).max(2),
  active: z.boolean(), lastSourceSeq: z.number().int().min(-1),
  lastStatus: z.string().max(40), nextEventSeq: timestamp,
  terminal: z.boolean(),
}).strict()
export const eventSchema = z.object({
  eventId: id, runId: id, sessionId: id, bindingId: id,
  eventSeq: timestamp, sourceSeq: z.number().int().min(-1), kind: eventKind,
  status: z.enum(['succeeded', 'failed', 'incomplete', 'cancelled', 'needs_attention']),
  occurredAt: timestamp, resultRef: z.string().max(220),
  source: z.literal('relay-durable-snapshot'), trust: z.literal('data-only'),
}).strict()
export const deliverySchema = z.object({
  dispatchId: id, bindingId: id, threadId: id, eventIds: z.array(id).min(1),
  state: z.enum(['queued', 'dispatching', 'delivered', 'acknowledged', 'held', 'dead']),
  turnId: id.nullable(), attempts: timestamp, updatedAt: timestamp,
  nextAttemptAt: timestamp,
  error: z.enum(['uncertain-acceptance', 'permission-or-binding-changed', 'turn-failed', 'unsupported-host']).nullable(),
}).strict()
export const stateSchema = z.object({
  schemaVersion: z.literal(1), enabled: z.boolean(),
  nextDispatchAt: timestamp,
  eventCursorBase: timestamp.default(0),
  lastCompactedAt: timestamp.nullable().default(null),
  worker: z.object({ ownerId: id, heartbeatAt: timestamp, ready: z.boolean(), bindingIds: z.array(id).max(100).default([]) }).strict().nullable().default(null),
  bindings: z.array(bindingSchema), watches: z.array(watchSchema),
  events: z.array(eventSchema), deliveries: z.array(deliverySchema),
}).strict()
export type WakeBinding = z.infer<typeof bindingSchema>
export type WakeWatch = z.infer<typeof watchSchema>
export type WakeEvent = z.infer<typeof eventSchema>
export type WakeDelivery = z.infer<typeof deliverySchema>
export type WakeState = z.infer<typeof stateSchema>
export type EventKind = z.infer<typeof eventKind>

export const emptyState = (): WakeState => ({
  schemaVersion: 1, enabled: false, nextDispatchAt: 0, worker: null, eventCursorBase: 0, lastCompactedAt: null, bindings: [], watches: [], events: [], deliveries: [],
})
