import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { CodexDaemonRequestError } from './codex-daemon-client.js'
import type { Admission, Completion, Recovery, WakeHost, WakeHostCapabilities } from './dispatcher.js'
import type { WakeBinding } from './schema.js'

/** The narrow initialized-client surface used by an already running local Codex daemon. */
export interface ExistingCodexClient {
  initialize(): Promise<unknown>
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  readonly disconnected?: boolean
  onNotification?(listener: (notification: { method: string; params: unknown }) => void): () => void
  onDisconnected?(listener: () => void): () => void
}

export interface ExistingCodexBinding {
  threadId: string
  workspace: string
}

export interface ExistingCodexHostOptions {
  client: ExistingCodexClient
  socket: string
  codexHome: string
  uid: number | string
  bindings: ExistingCodexBinding[]
}

const threadShape = z.object({ thread: z.object({
  id: z.string(), cwd: z.string(),
  status: z.object({ type: z.string(), activeFlags: z.array(z.string()).optional() }).passthrough(),
}).passthrough() }).passthrough()
const pageShape = z.object({ data: z.array(z.unknown()), nextCursor: z.string().nullable() }).passthrough()
const queuePageShape = z.object({ data: z.array(z.object({ id: z.string(), clientUserMessageId: z.string().nullable().optional() }).passthrough()), nextCursor: z.string().nullable() }).passthrough()
const turnStartShape = z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough()
const queueAddShape = z.object({ queuedSubmission: z.object({ id: z.string(), clientUserMessageId: z.string() }).passthrough() }).passthrough()
const queueDeleteShape = z.object({ deleted: z.boolean() }).passthrough()

/** A locally admitted turn stays answerable as `pending` only for this bounded window. */
const LOCAL_ACCEPTANCE_TTL_MS = 120_000
const MAX_LOCAL_ACCEPTANCES = 256

/**
 * An explicit local NOT-SENT outcome proves the request never reached the daemon:
 * `outcomeUncertain === false` with no server code and a connection/busy category.
 * Any JSON-RPC server failure (including a null code) or an uncertain outcome stays
 * ambiguous and must keep the existing held behavior.
 */
function isLocalNotSentFailure(error: unknown): boolean {
  return error instanceof CodexDaemonRequestError
    && error.origin === 'local'
    && error.outcomeUncertain === false
    && error.code === null
    && (error.category === 'connection' || error.category === 'busy')
}

/** Attach to selected existing main-thread conversations without owning daemon lifecycle or changing thread settings. */
export class ExistingCodexHost implements WakeHost {
  private readonly bound = new Map<string, string>()
  private readonly attemptedDispatches = new Set<string>()
  /** Locally confirmed dispatchId -> turnId, bounded by size and lifetime. */
  private readonly locallyAccepted = new Map<string, { turnId: string; recordedAt: number }>()
  private readonly completionNotices = new Map<string, 'completed' | 'failed' | 'interrupted'>()
  private startTail: Promise<unknown> = Promise.resolve()
  private readonly capability: WakeHostCapabilities
  private constructor(
    private readonly client: ExistingCodexClient,
    readonly serverIdentity: string,
    capabilityReady: boolean,
  ) {
    this.capability = {
      serverIdentity, authenticated: capabilityReady, sameThreadResume: capabilityReady,
      durableHistory: capabilityReady, completionEvidence: capabilityReady, exclusiveIdleAdmission: capabilityReady,
    }
    client.onDisconnected?.(() => { this.disconnected = true })
    client.onNotification?.(notification => {
      if (notification.method !== 'turn/completed' || !notification.params || typeof notification.params !== 'object') return
      const params = notification.params as { threadId?: string; turn?: { id?: unknown; status?: unknown } }
      if (!params.threadId || !this.bound.has(params.threadId)) return
      const id = params.turn?.id
      // Current native protocol carries a string TurnStatus; no shape fallbacks.
      const status = typeof params.turn?.status === 'string' ? params.turn.status : undefined
      if (typeof id === 'string' && (status === 'completed' || status === 'failed' || status === 'interrupted')) {
        this.completionNotices.set(id, status)
        if (this.completionNotices.size > 1000) this.completionNotices.delete(this.completionNotices.keys().next().value!)
      }
    })
  }

  private disconnected = false

  static async attach(options: ExistingCodexHostOptions): Promise<ExistingCodexHost> {
    const socket = resolve(options.socket)
    const codexHome = resolve(options.codexHome)
    const identity = createHash('sha256').update(JSON.stringify([socket, codexHome, String(options.uid)])).digest('hex')
    await options.client.initialize()
    if (options.client.disconnected) throw new Error('existing Codex daemon client is disconnected')

    const bound = new Map<string, string>()
    for (const binding of options.bindings) {
      const workspace = resolve(binding.workspace)
      const resumed = threadShape.parse(await options.client.request('thread/resume', { threadId: binding.threadId, excludeTurns: true }))
      if (resumed.thread.id !== binding.threadId || resolve(resumed.thread.cwd) !== workspace) throw new Error('existing Codex thread identity/workspace mismatch')
      const read = threadShape.parse(await options.client.request('thread/read', { threadId: binding.threadId }))
      if (read.thread.id !== binding.threadId || resolve(read.thread.cwd) !== workspace) throw new Error('existing Codex thread identity/workspace mismatch')
      // These reads establish durable-history and exact-thread queue support before capabilities are advertised.
      pageShape.parse(await options.client.request('thread/turns/list', { threadId: binding.threadId, limit: 1 }))
      pageShape.parse(await options.client.request('thread/items/list', { threadId: binding.threadId, limit: 1 }))
      queuePageShape.parse(await options.client.request('thread/queue/list', { threadId: binding.threadId, limit: 1 }))
      bound.set(binding.threadId, workspace)
    }
    const attached = new ExistingCodexHost(options.client, identity, bound.size > 0 && !options.client.disconnected)
    for (const [threadId, workspace] of bound) attached.bound.set(threadId, workspace)
    return attached
  }

  async capabilities(): Promise<WakeHostCapabilities> {
    const live = !this.disconnected && !this.client.disconnected
    return { ...this.capability, authenticated: live && this.capability.authenticated,
      sameThreadResume: live && this.capability.sameThreadResume, durableHistory: live && this.capability.durableHistory,
      completionEvidence: live && this.capability.completionEvidence, exclusiveIdleAdmission: live && this.capability.exclusiveIdleAdmission }
  }

  async inspect(binding: WakeBinding) {
    this.requireBinding(binding)
    const { thread } = threadShape.parse(await this.client.request('thread/read', { threadId: binding.threadId }))
    // Approval state is per inspected thread only: a global inbound-request count can
    // include another thread's (or an already resolved) server request.
    return { threadId: thread.id, workspace: resolve(thread.cwd), idle: thread.status.type === 'idle',
      waitingOnApproval: (thread.status.activeFlags ?? []).includes('waitingOnApproval') }
  }

  async startWhenIdle(binding: WakeBinding, input: string, dispatchId: string): Promise<Admission> {
    this.requireBinding(binding)
    const result = this.startTail.then(() => this.admit(binding, input, dispatchId))
    this.startTail = result.catch(() => undefined)
    return result
  }

  private async admit(binding: WakeBinding, input: string, dispatchId: string): Promise<Admission> {
    // An idempotent retry of a dispatch this process already admitted is answered from
    // the local record; the admitted turn may not be visible in durable history yet.
    const local = this.localAcceptance(dispatchId)
    if (local) return { kind: 'accepted', turnId: local }
    const prior = await this.findDispatch(binding.threadId, dispatchId)
    if (prior) return { kind: 'accepted', turnId: prior }
    const queued = await this.findQueued(binding.threadId, dispatchId)
    if (!queued && this.attemptedDispatches.has(dispatchId)) throw new Error('existing Codex queue outcome remains uncertain')
    if (!queued) {
      this.attemptedDispatches.add(dispatchId)
      try {
        const response = queueAddShape.parse(await this.client.request('thread/queue/add', {
          threadId: binding.threadId, input: [{ type: 'text', text: input }], clientUserMessageId: dispatchId,
        }))
        if (response.queuedSubmission.clientUserMessageId !== dispatchId) throw new Error('existing Codex queue identity mismatch')
      } catch (error) {
        if (isLocalNotSentFailure(error)) {
          // Provably never sent: forget the attempt so the dispatcher can safely retry.
          this.attemptedDispatches.delete(dispatchId)
          return { kind: 'busy' }
        }
        // Any ambiguous failure (timeout, uncertain connection loss, server error) stays held.
        const accepted = await this.findDispatch(binding.threadId, dispatchId)
        if (accepted) return { kind: 'accepted', turnId: accepted }
        if (!await this.findQueued(binding.threadId, dispatchId)) throw new Error('existing Codex queue outcome remains uncertain')
      }
    }
    const row = queued ?? await this.findQueued(binding.threadId, dispatchId)
    if (!row) {
      const accepted = await this.findDispatch(binding.threadId, dispatchId)
      if (accepted) return { kind: 'accepted', turnId: accepted }
      throw new Error('existing Codex queue outcome remains uncertain')
    }
    try {
      const started = turnStartShape.parse(await this.client.request('thread/queue/start', { threadId: binding.threadId, queuedSubmissionId: row.id }))
      this.rememberAcceptance(dispatchId, started.turn.id)
      return { kind: 'accepted', turnId: started.turn.id }
    } catch {
      const accepted = await this.findDispatch(binding.threadId, dispatchId)
      if (accepted) return { kind: 'accepted', turnId: accepted }
      const stillQueued = await this.findQueued(binding.threadId, dispatchId)
      if (stillQueued) {
        try {
          const deleted = queueDeleteShape.parse(await this.client.request('thread/queue/delete', {
            threadId: binding.threadId, queuedSubmissionId: stillQueued.id,
          })).deleted
          if (deleted) {
            this.attemptedDispatches.delete(dispatchId)
            return { kind: 'busy' }
          }
        } catch { /* deletion outcome is uncertain; inspect durable history below */ }
      }
      const afterDelete = await this.findDispatch(binding.threadId, dispatchId)
      if (afterDelete) return { kind: 'accepted', turnId: afterDelete }
      throw new Error('existing Codex queue start outcome remains uncertain')
    }
  }

  async completion(binding: WakeBinding, turnId: string, dispatchId = ''): Promise<Completion> {
    this.requireBinding(binding)
    const status = await this.findTurnStatus(binding.threadId, turnId)
    const notice = this.completionNotices.get(turnId)
    if (status === 'completed') {
      // Durable terminal completion confirms the outcome; the local record is no longer needed.
      this.forgetAcceptance(dispatchId)
      return notice === 'failed' || notice === 'interrupted' ? 'unknown' : 'completed'
    }
    if (status === 'failed' || status === 'interrupted') {
      this.forgetAcceptance(dispatchId)
      return notice === 'completed' ? 'pending' : 'failed'
    }
    if (status === 'inProgress' || notice === 'completed') return 'pending'
    // Durable history has not surfaced the admitted turn yet: while the bounded local
    // acceptance record is live, the outcome is pending rather than unknown.
    if (dispatchId !== '' && this.localAcceptance(dispatchId) === turnId) return 'pending'
    return 'unknown'
  }

  async reconcile(binding: WakeBinding, dispatchId: string): Promise<Recovery> {
    this.requireBinding(binding)
    // Positive local admission evidence from this process outranks a missing history row.
    const local = this.localAcceptance(dispatchId)
    if (local) return { kind: 'accepted', turnId: local }
    const turnId = await this.findDispatch(binding.threadId, dispatchId)
    if (turnId) return { kind: 'accepted', turnId }
    let queued: { id: string } | null
    try { queued = await this.findQueued(binding.threadId, dispatchId) }
    catch { return { kind: 'unknown' } }
    if (!queued) return { kind: 'unknown' }
    let deleted = false
    try {
      deleted = queueDeleteShape.parse(await this.client.request('thread/queue/delete', {
        threadId: binding.threadId, queuedSubmissionId: queued.id,
      })).deleted
    } catch { /* an uncertain delete requires positive history evidence */ }
    if (deleted) {
      this.attemptedDispatches.delete(dispatchId)
      return { kind: 'not-accepted' }
    }
    const accepted = await this.findDispatch(binding.threadId, dispatchId)
    return accepted ? { kind: 'accepted', turnId: accepted } : { kind: 'unknown' }
  }

  private requireBinding(binding: WakeBinding): void {
    if (binding.serverIdentity !== this.serverIdentity || this.bound.get(binding.threadId) !== resolve(binding.workspace)) throw new Error('binding is not attached to this Codex daemon')
  }

  /** Records a locally admitted dispatch without unbounded growth. */
  private rememberAcceptance(dispatchId: string, turnId: string): void {
    this.locallyAccepted.delete(dispatchId)
    this.locallyAccepted.set(dispatchId, { turnId, recordedAt: Date.now() })
    while (this.locallyAccepted.size > MAX_LOCAL_ACCEPTANCES) {
      const oldest = this.locallyAccepted.keys().next().value
      if (oldest === undefined) break
      this.locallyAccepted.delete(oldest)
    }
  }

  /** Live local acceptance for this dispatch, expiring past its bounded lifetime. */
  private localAcceptance(dispatchId: string): string | null {
    const entry = this.locallyAccepted.get(dispatchId)
    if (!entry) return null
    if (Date.now() - entry.recordedAt > LOCAL_ACCEPTANCE_TTL_MS) {
      this.locallyAccepted.delete(dispatchId)
      return null
    }
    return entry.turnId
  }

  private forgetAcceptance(dispatchId: string): void {
    if (dispatchId !== '') this.locallyAccepted.delete(dispatchId)
  }

  private async findQueued(threadId: string, dispatchId: string): Promise<{ id: string } | null> {
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = queuePageShape.parse(await this.client.request('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }))
      const matching = result.data.filter(row => row.clientUserMessageId === dispatchId)
      if (matching.length > 1) throw new Error('duplicate existing Codex queue identity')
      if (matching[0]) return { id: matching[0].id }
      if (result.nextCursor === null) return null
      cursor = result.nextCursor
    }
    throw new Error('existing Codex queue scan exceeded its page bound')
  }

  private async findDispatch(threadId: string, dispatchId: string): Promise<string | null> {
    let cursor: string | undefined
    // `thread/items/list` defaults to ASC; ask for DESC so the newest durable pages (and
    // therefore the newest dispatch marker) are seen first.
    for (let page = 0; page < 100; page++) {
      const result = pageShape.parse(await this.client.request('thread/items/list', {
        threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      }))
      for (const raw of result.data) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as { turnId?: unknown; item?: { type?: unknown; content?: unknown } }
        if (entry.item?.type !== 'userMessage' || typeof entry.turnId !== 'string' || !Array.isArray(entry.item.content)) continue
        if (entry.item.content.some(part => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          && typeof (part as { text?: unknown }).text === 'string' && (part as { text: string }).text.split('\n').includes(`dispatchId=${dispatchId}`))) {
          // Outbox/native queue dedup already guarantees one marker; stop at the newest match.
          return entry.turnId
        }
      }
      if (result.nextCursor === null) return null
      cursor = result.nextCursor
    }
    // A bound-limited miss is unknown, never evidence of non-acceptance.
    throw new Error('existing Codex history scan exceeded its page bound')
  }

  private async findTurnStatus(threadId: string, turnId: string): Promise<string | null> {
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = pageShape.parse(await this.client.request('thread/turns/list', {
        threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      }))
      for (const raw of result.data) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as { id?: unknown; status?: unknown }
        if (entry.id !== turnId) continue
        // TurnStatus is a native string union; anything else is unknown, not a guess.
        return typeof entry.status === 'string' ? entry.status : null
      }
      if (result.nextCursor === null) return null
      cursor = result.nextCursor
    }
    return null
  }
}
