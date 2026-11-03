import type { ModelSelection, PermissionPreset, PromptPart } from '../types.js'
import { hostApiIncompatible } from './host-errors.js'
import type {
  HarnessGatewayProvider,
  BeforeDispatch,
  GatewayHostFrame,
  GatewayMuxFrame,
  GatewayStreamEnvelope,
  HistoryPage,
  HistoryRequest,
  PromptAcceptance,
  QueueUpdateRequest,
  SessionCreateRequest,
  SessionCreateResult,
  SessionSummary,
  SettingsDescription,
  WorkspaceCatalog,
  WorkspaceArchiveResult,
  WorkspaceView,
} from './types.js'

export class HarnessGatewayFacade {
  constructor(private readonly provider: HarnessGatewayProvider) {}

  describeHost(): Promise<Record<string, unknown>> { return this.provider.describeHost() }
  listWorkspaces(): Promise<WorkspaceCatalog> { return this.provider.listWorkspaces() }
  async archiveSession(sessionId: string): Promise<WorkspaceArchiveResult> {
    const archive = this.provider.archiveSession
    if (typeof archive !== 'function') throw hostApiIncompatible('workspace.archiveSession')
    return archive.call(this.provider, sessionId)
  }
  async unarchiveSession(sessionId: string): Promise<WorkspaceArchiveResult> {
    const unarchive = this.provider.unarchiveSession
    if (typeof unarchive !== 'function') throw hostApiIncompatible('workspace.unarchiveSession')
    return unarchive.call(this.provider, sessionId)
  }
  createWorkspace(path: string): Promise<WorkspaceView> { return this.provider.createWorkspace(path) }
  listSessions(): Promise<SessionSummary[]> { return this.provider.listSessions() }
  createSession(request: SessionCreateRequest): Promise<SessionCreateResult> { return this.provider.createSession(request) }
  readHistory(request: HistoryRequest): Promise<HistoryPage> { return this.provider.readHistory(request) }
  describeSettings(): Promise<SettingsDescription> { return this.provider.describeSettings() }
  selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> { return this.provider.selectSessionModel(sessionId, selection) }
  replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> { return this.provider.replaceSettings(namespace, section, expectedRevision) }
  mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void> { return this.provider.mutateSettings(namespace, ops, expectedRevision) }
  submitPrompt(sessionId: string, mode: 'queue' | 'steer', content: PromptPart[], rpcId: string, beforeDispatch?: BeforeDispatch): Promise<PromptAcceptance> { return this.provider.submitPrompt(sessionId, mode, content, rpcId, beforeDispatch) }
  updateQueue(request: QueueUpdateRequest): Promise<void> { return this.provider.updateQueue(request) }
  cancelSession(sessionId: string, rpcId: string, beforeDispatch?: BeforeDispatch): Promise<void> { return this.provider.cancelSession(sessionId, rpcId, beforeDispatch) }
  openPath(path: string): Promise<void> { return this.provider.openPath(path) }
  listModels(): Promise<Record<string, unknown>> { return this.provider.listModels() }
  listAgentPresets(): Promise<Record<string, unknown>> { return this.provider.listAgentPresets() }
  readProviderQuota(provider: string, signal?: AbortSignal): Promise<unknown | undefined> {
    return this.provider.readProviderQuota?.(provider, signal) ?? Promise.resolve(undefined)
  }
  readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }> { return this.provider.readPermissionProjection(sessionId) }
  requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }> { return this.provider.requestPermissionSelection(sessionId, preset) }

  /** Whether this adapter can accelerate reconciliation with native Host streams. */
  supportsEventStreams(): boolean {
    return this.provider.openMuxEvents !== undefined && this.provider.openHostEvents !== undefined
  }

  openMuxEvents(
    since: Record<string, number>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayMuxFrame>> {
    const open = this.provider.openMuxEvents
    if (open === undefined) throw new Error('Harness adapter does not provide mux events')
    return open.call(this.provider, since, signal, onOpen)
  }

  openHostEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayHostFrame>> {
    const open = this.provider.openHostEvents
    if (open === undefined) throw new Error('Harness adapter does not provide host events')
    return open.call(this.provider, signal, onOpen)
  }
}
