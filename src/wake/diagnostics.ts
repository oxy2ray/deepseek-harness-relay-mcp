import type { WakeState } from './schema.js'

/** Bounded counts only: no provider output, authentication or user conversation content. */
export function wakeDiagnostics(state: WakeState, now = Date.now()) {
  const assigned = new Set(state.deliveries.flatMap(row => row.eventIds))
  const queued = state.events.filter(event => !assigned.has(event.eventId))
  // Same three-second lease the watch admission gate enforces; a worker record whose
  // heartbeat is absent, future-dated or stale is not a ready worker.
  const worker = state.worker
  const heartbeatAgeMs = worker ? Math.max(0, now - worker.heartbeatAt) : null
  const workerReady = worker !== null && worker.ready && worker.heartbeatAt <= now
    && heartbeatAgeMs !== null && heartbeatAgeMs <= 3000
  return {
    enabled: state.enabled,
    workerReady,
    workerHeartbeatAgeMs: heartbeatAgeMs,
    workerBindings: worker ? worker.bindingIds.length : 0,
    pausedBindings: state.bindings.filter(row => !row.enabled).length,
    eventCursorBase: state.eventCursorBase,
    lastCompactedAt: state.lastCompactedAt,
    watches: state.watches.length,
    watching: state.watches.filter(row => row.active && !row.terminal).length,
    expiredBindings: state.bindings.filter(row => row.expiresAt <= now).length,
    queuedEvents: queued.length,
    oldestQueuedAgeMs: queued.length ? Math.max(0, now - Math.min(...queued.map(row => row.occurredAt))) : 0,
    retryable: state.deliveries.filter(row => row.state === 'queued').length,
    delivered: state.deliveries.filter(row => row.state === 'delivered').length,
    acknowledged: state.deliveries.filter(row => row.state === 'acknowledged').length,
    held: state.deliveries.filter(row => row.state === 'held').length,
    deadLetters: state.deliveries.filter(row => row.state === 'dead').length,
  }
}
