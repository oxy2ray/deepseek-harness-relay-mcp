import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { bindingSchema, eventKind, type EventKind, type WakeBinding, type WakeEvent, type WakeState, type WakeRunSnapshot } from './schema.js'
import { WakeStore, acquireWakeLock } from './store.js'

export interface WakeLimits {
  maxBindings: number
  maxWatches: number
  maxEvents: number
  maxDeliveries: number
}
export const defaultLimits: WakeLimits = { maxBindings: 100, maxWatches: 1000, maxEvents: 10000, maxDeliveries: 5000 }
const terminal = new Set(['succeeded', 'failed', 'incomplete', 'cancelled'])
export class WakeCursorExpiredError extends Error {
  readonly code = 'WAKE_CURSOR_EXPIRED'
  constructor(readonly earliestCursor: number, readonly latestCursor: number) {
    super('replay cursor expired; resynchronize from retained events and get_run')
  }
}

/** Trusted control-plane API. Do not expose registerBinding/setEnabled to model tools. */
export class WakeOutbox {
  readonly limits: WakeLimits
  constructor(readonly store: WakeStore, limits: Partial<WakeLimits> = {}, readonly now: () => number = Date.now) {
    this.limits = { ...defaultLimits, ...limits }
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('invalid wake limit')
  }

  async registerBinding(input: WakeBinding): Promise<void> {
    const binding = bindingSchema.parse(input)
    if (resolve(binding.workspace) !== binding.workspace) throw new Error('workspace must be absolute and normalized')
    if (binding.relayWorkspace !== undefined && resolve(binding.relayWorkspace) !== binding.relayWorkspace) throw new Error('relayWorkspace must be absolute and normalized')
    if (binding.expiresAt <= this.now()) throw new Error('binding already expired')
    await this.store.transaction(state => {
      const old = state.bindings.find(b => b.bindingId === binding.bindingId)
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(binding)) throw new Error('binding identity is immutable; use a new binding ID')
        return
      }
      // Exactly one binding owns a target thread, including paused bindings.
      if (state.bindings.some(b => b.threadId === binding.threadId && b.serverIdentity === binding.serverIdentity)) throw new Error('thread already bound')
      if (state.bindings.length >= this.limits.maxBindings) throw new Error('wake binding limit reached')
      state.bindings.push(binding)
    })
  }

  async setEnabled(enabled: boolean, bindingId?: string): Promise<void> {
    // Serialize stop controls against the dispatcher's admission boundary.
    const lease = await acquireWakeLock(`${this.store.path}.dispatch.lock`)
    try {
    await this.store.transaction(state => {
      if (bindingId === undefined) state.enabled = enabled
      else {
        const binding = state.bindings.find(b => b.bindingId === bindingId)
        if (!binding) throw new Error('unknown binding')
        binding.enabled = enabled
      }
    })
    } finally { await lease.release() }
  }

  async renewBinding(bindingId: string, expiresAt: number): Promise<void> {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new Error('future binding expiry required')
    const lease = await acquireWakeLock(`${this.store.path}.dispatch.lock`)
    try {
      await this.store.transaction(state => {
        const binding = state.bindings.find(b => b.bindingId === bindingId)
        if (!binding) throw new Error('unknown binding')
        // Trusted operator renewal cannot retarget thread, workspace, principal or server.
        binding.expiresAt = expiresAt
      })
    } finally { await lease.release() }
  }

  async watch(input: { run: WakeRunSnapshot; bindingId: string; principal: string; idempotencyKey: string; events?: EventKind[]; requireReadyWorker?: boolean }): Promise<string> {
    const filters = [...new Set((input.events ?? ['terminal', 'needs_attention']).map(x => eventKind.parse(x)))].sort()
    if (!filters.length) throw new Error('empty event filter')
    // Filesystem checks are asynchronous; perform them before the synchronous
    // state transaction, then re-check binding authorization at commit time.
    const initial = await this.store.read()
    const initialBinding = authorizedBinding(initial, input.bindingId, input.principal, input.run.workspace, this.now())
    await validateMappedRun(initialBinding, input.run)
    return this.store.transaction(state => {
      const binding = authorizedBinding(state, input.bindingId, input.principal, input.run.workspace, this.now())
      if (input.requireReadyWorker && (!state.enabled || !binding.enabled || !state.worker?.ready
        || !state.worker.bindingIds.includes(binding.bindingId)
        || state.worker.heartbeatAt > this.now() || this.now() - state.worker.heartbeatAt > 3000)) throw new Error('wake worker no longer ready')
      const replay = state.watches.find(w => w.idempotencyKey === input.idempotencyKey && w.bindingId === binding.bindingId)
      if (replay) {
        if (replay.runId !== input.run.runId || replay.sessionId !== input.run.sessionId || JSON.stringify(replay.filters) !== JSON.stringify(filters)) throw new Error('watch idempotency conflict')
        // An idempotency replay must not undo an operator's unwatch or promise
        // another callback after this subscription has already reached terminal.
        if (!replay.active) throw new Error('watch is inactive; use a new idempotency key to create another subscription')
        if (replay.terminal) throw new Error('watch is terminal; verify the run with get_run')
        return replay.subscriptionId
      }
      if (state.watches.some(w => w.runId === input.run.runId)) throw new Error('run already watched; re-enable its existing subscription')
      // An attention-only subscription cannot deliver anything for a run that
      // is already terminal, so it must not acknowledge future notification.
      if (terminal.has(input.run.status) && !filters.includes('terminal')) throw new Error('run is terminal and the watch excludes terminal events; verify with get_run')
      if (state.watches.length >= this.limits.maxWatches) throw new Error('wake watch limit reached')
      const subscriptionId = randomUUID()
      state.watches.push({ subscriptionId, runId: input.run.runId, sessionId: input.run.sessionId,
        bindingId: binding.bindingId, idempotencyKey: input.idempotencyKey, filters,
        active: true, lastSourceSeq: -1, lastStatus: '', nextEventSeq: 1, terminal: false })
      // Already-finished runs are observed by the next collector pass; no submit/reply operation.
      return subscriptionId
    })
  }

  async unwatch(subscriptionId: string, principal: string): Promise<void> {
    const lease = await acquireWakeLock(`${this.store.path}.dispatch.lock`)
    try {
    await this.store.transaction(state => {
      const watch = state.watches.find(w => w.subscriptionId === subscriptionId)
      if (!watch) throw new Error('unknown subscription')
      const binding = state.bindings.find(b => b.bindingId === watch.bindingId)
      if (binding?.principal !== principal) throw new Error('watch owner mismatch')
      watch.active = false
    })
    } finally { await lease.release() }
  }

  /** Snapshot must come directly from a principal-scoped broker getRun, never DSH text. */
  async observe(run: WakeRunSnapshot, principal: string): Promise<WakeEvent | null> {
    // Re-resolve mapped paths for each source snapshot so a symlink retargeted
    // after watch registration cannot make an out-of-scope run emit an event.
    const initial = await this.store.read()
    const initialWatch = initial.watches.find(w => w.runId === run.runId)
    if (!initialWatch?.active || initialWatch.terminal) return null
    const initialBinding = initial.bindings.find(b => b.bindingId === initialWatch.bindingId)
    if (!initialBinding || initialBinding.principal !== principal || (initialBinding.relayWorkspace ?? initialBinding.workspace) !== resolve(run.workspace)
      || initialWatch.sessionId !== run.sessionId) throw new Error('run ownership mismatch')
    await validateMappedRun(initialBinding, run)
    return this.store.transaction(state => {
      const watch = state.watches.find(w => w.runId === run.runId)
      if (!watch?.active || watch.terminal) return null
      const binding = state.bindings.find(b => b.bindingId === watch.bindingId)
      if (!binding || binding.principal !== principal || (binding.relayWorkspace ?? binding.workspace) !== resolve(run.workspace)
        || watch.sessionId !== run.sessionId) throw new Error('run ownership mismatch')
      if (!Number.isSafeInteger(run.lastEventSeq) || run.lastEventSeq < -1) throw new Error('invalid source sequence')
      if (run.lastEventSeq < watch.lastSourceSeq) return null
      const isTerminal = terminal.has(run.status)
      const kind = isTerminal ? 'terminal' : run.status === 'needs_attention' ? 'needs_attention' : null
      const changed = watch.lastStatus !== run.status
      watch.lastSourceSeq = run.lastEventSeq
      watch.lastStatus = run.status
      if (isTerminal) watch.terminal = true
      if (kind === null || !changed || !watch.filters.includes(kind)) return null
      if (state.events.length >= this.limits.maxEvents) throw new Error('wake event limit reached; snapshot remains retryable')
      const eventSeq = watch.nextEventSeq++
      const eventId = createHash('sha256').update(`${watch.runId}:${eventSeq}:${watch.bindingId}`).digest('hex')
      const event: WakeEvent = {
        eventId, runId: run.runId, sessionId: run.sessionId, bindingId: binding.bindingId,
        eventSeq, sourceSeq: run.lastEventSeq, kind,
        status: run.status as WakeEvent['status'], occurredAt: this.now(),
        resultRef: `relay://runs/${encodeURIComponent(run.runId)}`,
        source: 'relay-durable-snapshot', trust: 'data-only',
      }
      state.events.push(event)
      watch.terminal = isTerminal
      return event
    })
  }

  async replay(bindingId: string, principal: string, cursor?: number): Promise<{ events: WakeEvent[]; nextCursor: number }> {
    // Cursor is a global array position, not eventSeq (which is per run).
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('invalid replay cursor')
    const state = await this.store.read()
    if (state.bindings.find(b => b.bindingId === bindingId)?.principal !== principal) throw new Error('binding owner mismatch')
    const after = cursor ?? state.eventCursorBase
    if (after < state.eventCursorBase) throw new WakeCursorExpiredError(state.eventCursorBase, state.eventCursorBase + state.events.length)
    if (after > state.eventCursorBase + state.events.length) throw new Error('replay cursor ahead of durable state')
    return { events: state.events.slice(after - state.eventCursorBase).filter(e => e.bindingId === bindingId), nextCursor: state.eventCursorBase + state.events.length }
  }

  /** Trusted operator maintenance only. Never discards uncertain/pending events or run tombstones. */
  async compactAcknowledged(before: number): Promise<{ removedEvents: number; removedDeliveries: number }> {
    if (!Number.isSafeInteger(before) || before < 0 || before > this.now()) throw new Error('invalid retention cutoff')
    return this.store.transaction(state => {
      const acknowledged = new Set(state.deliveries.filter(d => d.state === 'acknowledged').flatMap(d => d.eventIds))
      let count = 0
      for (const event of state.events) {
        if (event.occurredAt > before || !acknowledged.has(event.eventId)) break
        count++
      }
      state.events.splice(0, count)
      state.eventCursorBase += count
      const retained = new Set(state.events.map(e => e.eventId))
      const previous = state.deliveries.length
      state.deliveries = state.deliveries.filter(d => d.state !== 'acknowledged' || d.eventIds.some(id => retained.has(id)))
      state.lastCompactedAt = this.now()
      return { removedEvents: count, removedDeliveries: previous - state.deliveries.length }
    })
  }
}

function authorizedBinding(state: WakeState, bindingId: string, principal: string, workspace: string, now: number): WakeBinding {
  const binding = state.bindings.find(b => b.bindingId === bindingId)
  if (!binding || binding.principal !== principal || (binding.relayWorkspace ?? binding.workspace) !== resolve(workspace) || binding.expiresAt <= now) throw new Error('binding not authorized')
  return binding
}

/** Cross-workspace delivery is an explicit read-only mapping whose source paths physically lie inside the managed target root. */
async function validateMappedRun(binding: WakeBinding, run: WakeRunSnapshot): Promise<void> {
  const targetRoot = resolve(binding.workspace)
  const sourceRoot = resolve(binding.relayWorkspace ?? binding.workspace)
  if (sourceRoot === targetRoot) return // Preserve legacy same-workspace watch behavior.
  if (run.permissionPreset !== 'read-only') throw new Error('mapped workspace runs must use read-only permission')
  const scope = run.taskScope
  if (!scope || !scope.reviewTargets.length || !scope.contextReadScope.length || scope.writeScope.length !== 0
    || scope.enforcement !== 'instruction-only') throw new Error('mapped workspace requires a complete read-only taskScope')
  // Unlike lexical resolve(), realpath follows symlinks. If either root or any
  // scoped path cannot be resolved, reject the mapped run instead of treating
  // the declared path as evidence of physical containment.
  const [physicalSourceRoot, physicalTargetRoot] = await Promise.all([
    realpath(sourceRoot).catch(() => { throw new Error('mapped Relay workspace is physically unavailable') }),
    realpath(targetRoot).catch(() => { throw new Error('mapped binding workspace is physically unavailable') }),
  ])
  const normalize = async (entries: string[], field: string): Promise<string[]> => Promise.all(entries.map(async entry => {
    if (!entry || entry.trim() !== entry || entry.includes('\0')) throw new Error(`invalid mapped ${field} path`)
    const absolute = resolve(sourceRoot, entry)
    const local = relative(sourceRoot, absolute)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`mapped ${field} escapes Relay workspace`)
    const canonical = local === '' ? '.' : local.replaceAll('\\', '/')
    if (entry !== canonical) throw new Error(`mapped ${field} must be normalized`)
    let physicalPath: string
    try { physicalPath = await realpath(absolute) }
    catch { throw new Error(`mapped ${field} path is physically unavailable`) }
    if (!containsPhysicalPath(physicalSourceRoot, physicalPath)) throw new Error(`mapped ${field} escapes Relay workspace through a symlink`)
    // Do not virtually relocate Relay-relative paths: validate the actual
    // source location against the narrower target workspace.
    if (!containsPhysicalPath(physicalTargetRoot, physicalPath)) throw new Error(`mapped ${field} escapes binding workspace through a symlink`)
    return canonical
  }))
  const targets = await normalize(scope.reviewTargets, 'reviewTargets')
  const reads = await normalize(scope.contextReadScope, 'contextReadScope')
  const excluded = await normalize(scope.excludedPaths, 'excludedPaths')
  if (targets.some(target => !reads.some(context => contains(context, target)) || excluded.some(path => contains(path, target)))) {
    throw new Error('mapped reviewTargets must be readable and not excluded')
  }
}

function containsPhysicalPath(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function contains(parent: string, child: string): boolean {
  return parent === '.' || parent === child || child.startsWith(`${parent}/`)
}
