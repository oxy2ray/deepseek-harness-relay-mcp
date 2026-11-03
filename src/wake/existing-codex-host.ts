import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Admission, Completion, Recovery, WakeHost, WakeHostCapabilities } from './dispatcher.js'
import type { WakeBinding } from './schema.js'

/** The narrow initialized-client surface used by an already running local Codex daemon. */
export interface ExistingCodexClient {
  initialize(): Promise<unknown>
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  readonly disconnected?: boolean
  readonly serverRequestCount?: number
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

/** Attach to selected existing main-thread conversations without owning daemon lifecycle or changing thread settings. */
export class ExistingCodexHost implements WakeHost {
  private readonly bound = new Map<string, string>()
  private readonly attemptedDispatches = new Set<string>()
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
      const status = typeof params.turn?.status === 'string' ? params.turn.status
        : params.turn?.status && typeof params.turn.status === 'object' && 'type' in params.turn.status
          ? (params.turn.status as { type?: unknown }).type : undefined
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
    return { threadId: thread.id, workspace: resolve(thread.cwd), idle: thread.status.type === 'idle',
      waitingOnApproval: (this.client.serverRequestCount ?? 0) > 0 || (thread.status.activeFlags ?? []).includes('waitingOnApproval') }
  }

  async startWhenIdle(binding: WakeBinding, input: string, dispatchId: string): Promise<Admission> {
    this.requireBinding(binding)
    const result = this.startTail.then(() => this.admit(binding, input, dispatchId))
    this.startTail = result.catch(() => undefined)
    return result
  }

  private async admit(binding: WakeBinding, input: string, dispatchId: string): Promise<Admission> {
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
      } catch {
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

  async completion(binding: WakeBinding, turnId: string): Promise<Completion> {
    this.requireBinding(binding)
    const status = await this.findTurnStatus(binding.threadId, turnId)
    const notice = this.completionNotices.get(turnId)
    if (status === 'completed') return notice === 'failed' || notice === 'interrupted' ? 'unknown' : 'completed'
    if (status === 'failed' || status === 'interrupted') return notice === 'completed' ? 'pending' : 'failed'
    if (status === 'inProgress' || notice === 'completed') return 'pending'
    return 'unknown'
  }

  async reconcile(binding: WakeBinding, dispatchId: string): Promise<Recovery> {
    this.requireBinding(binding)
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
    const matching = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const result = pageShape.parse(await this.client.request('thread/items/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }))
      for (const raw of result.data) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as { turnId?: unknown; item?: { type?: unknown; content?: unknown } }
        if (entry.item?.type !== 'userMessage' || typeof entry.turnId !== 'string' || !Array.isArray(entry.item.content)) continue
        if (entry.item.content.some(part => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          && typeof (part as { text?: unknown }).text === 'string' && (part as { text: string }).text.split('\n').includes(`dispatchId=${dispatchId}`))) matching.add(entry.turnId)
      }
      if (matching.size > 1) throw new Error('duplicate existing Codex dispatch marker')
      if (result.nextCursor === null) return [...matching][0] ?? null
      cursor = result.nextCursor
    }
    throw new Error('existing Codex history scan exceeded its page bound')
  }

  private async findTurnStatus(threadId: string, turnId: string): Promise<string | null> {
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = pageShape.parse(await this.client.request('thread/turns/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }))
      for (const raw of result.data) if (raw && typeof raw === 'object' && (raw as { id?: unknown }).id === turnId) return String((raw as { status?: unknown }).status)
      if (result.nextCursor === null) return null
      cursor = result.nextCursor
    }
    return null
  }
}
