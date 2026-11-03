import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { StdioProxyFacade } from '../stdio-proxy/index.js'
import type { StdioProxyConfig } from '../stdio-proxy/index.js'
import type { WakeRunSnapshot } from './schema.js'
import type { WakeRunSource } from './collector.js'

const taskScope = z.object({
  reviewTargets: z.array(z.string()), contextReadScope: z.array(z.string()),
  excludedPaths: z.array(z.string()), writeScope: z.array(z.string()), enforcement: z.literal('instruction-only'),
}).strict()
const snapshot = z.object({ runId: z.string(), sessionId: z.string(), workspace: z.string(),
  status: z.enum(['running', 'unknown', 'needs_attention', 'succeeded', 'failed', 'incomplete', 'cancelled']),
  lastEventSeq: z.number().int().min(-1),
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  taskScope: taskScope.optional(),
})

export function parseWakeRunSnapshot(value: unknown): WakeRunSnapshot {
  return snapshot.parse(value)
}

/** Persistent product adapter over the existing native MCP proxy; no alternate Relay RPC transport. */
export class NativeRelayWakeSource implements WakeRunSource {
  private readonly client = new Client({ name: 'dsh-relay-wake-worker', version: '1' })
  private readonly proxy: StdioProxyFacade
  private constructor(private readonly config: StdioProxyConfig) {
    this.proxy = new StdioProxyFacade({ ...config, autoStart: false })
  }
  static async connect(config: StdioProxyConfig): Promise<NativeRelayWakeSource> {
    const source = new NativeRelayWakeSource(config)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    try { await source.proxy.connect(serverSide); await source.client.connect(clientSide); return source }
    catch (error) { await source.close(); throw error }
  }
  async getRun(runId: string, principal: string): Promise<WakeRunSnapshot> {
    if (principal !== this.config.clientPrincipalId) throw new Error('principal mismatch')
    const result = await this.client.callTool({ name: 'get_run', arguments: { runId } }, undefined, { timeout: this.config.requestTimeoutMs })
    if (result.isError) throw new Error('native Relay read unavailable')
    // Parse an explicit projection: assistant text, prompt content and remote diagnostics never enter wake state.
    return parseWakeRunSnapshot(result.structuredContent)
  }
  async diagnose(): Promise<{ connected: boolean; advertisedModels: number }> {
    const doctor = await this.client.callTool({ name: 'doctor', arguments: {} }, undefined, { timeout: this.config.requestTimeoutMs })
    const status = z.object({ remote: z.object({ connected: z.boolean() }) }).safeParse(doctor.structuredContent)
    if (doctor.isError || !status.success || !status.data.remote.connected) return { connected: false, advertisedModels: 0 }
    const catalog = await this.client.callTool({ name: 'list_capabilities', arguments: {} }, undefined, { timeout: this.config.requestTimeoutMs })
    const models = z.object({ models: z.object({ groups: z.array(z.object({ models: z.array(z.unknown()) })) }) }).safeParse(catalog.structuredContent)
    return { connected: !catalog.isError && models.success, advertisedModels: models.success ? models.data.models.groups.reduce((n, group) => n + group.models.length, 0) : 0 }
  }
  async close(): Promise<void> { await Promise.allSettled([this.client.close(), this.proxy.close()]) }
}
