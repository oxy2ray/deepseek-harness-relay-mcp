import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createProductToolCatalog } from '../mcp-server/index.js'
import { HarnessHostAutostartFacade } from './host-autostart-facade.js'
import { ProxyDiagnosticsFacade, type ProxyInspection } from './proxy-diagnostics-facade.js'
import type { ProxyDoctorReport, ProxyRouteFailure, StdioProxyConfig, StdioProxyDependencies } from './types.js'
import { callWakeTool, wakeTools, WakeCursorExpiredError } from '../wake/index.js'
import type { RunSnapshot } from '../types.js'
import { watchInput } from '../wake/tools.js'
import type { WakeRunSnapshot } from '../wake/schema.js'
import { decorateMonitoringTool, projectWaitResult, withWakeHint } from './monitoring-presentation.js'

const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const relayVersion = typeof __DSH_RELAY_VERSION__ === 'string' ? __DSH_RELAY_VERSION__ : 'development'
const doctorTool = {
  name: 'doctor',
  title: 'Diagnose Harness Relay MCP',
  description: 'Inspect the local Relay status, endpoint, token readability, and remote route without exposing credentials.',
  inputSchema: { type: 'object' as const, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

type RemoteTools = Awaited<ReturnType<Client['listTools']>>['tools']

/** Local-first MCP facade that keeps diagnostics available across embedded authority restarts. */
export class StdioProxyFacade {
  private readonly local = new Server(
    { name: 'dsh-relay-proxy', version: relayVersion },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: 'Local-first stdio proxy to the embedded Harness Relay authority. Use doctor to verify connectivity even if cached tool schemas are listed. Discover live models, presets and providerQuotas before dispatch. Prefer watch_run for active runs when offered. Automatic enrollment, when configured, uses host thread metadata and authorized workspace roots; callers never supply a destination. Only when watch_run returns structured acknowledged=true plus hostMayConcludeTurn=true may this host turn end awaiting events. wait_run defaults to a brief status projection; fetch complete terminal results with get_run. This is not task completion: retrieve get_run on wake and verify assistantText. Otherwise continue native wait_run to terminal. Never use a shell RPC client.',
    },
  )
  private readonly diagnostics: ProxyDiagnosticsFacade
  private readonly hostAutostart: NonNullable<StdioProxyDependencies['hostAutostart']> | null
  private remote: Client | null = null
  private remoteAuthorityKey: string | null = null
  private lastError: ProxyRouteFailure | null = null
  private connecting: Promise<boolean> | null = null
  private readonly productTools: Promise<RemoteTools>
  private connected = false

  constructor(private readonly config: StdioProxyConfig, dependencies: StdioProxyDependencies = {}) {
    if (!principalPattern.test(config.clientPrincipalId)) throw new Error('invalid DSH Relay client principal')
    if (config.wake !== undefined && config.wakeByThread !== undefined) throw new Error('ambiguous DSH Relay wake binding configuration')
    this.productTools = createProductToolCatalog(config.maxTaskCharacters)
    this.diagnostics = new ProxyDiagnosticsFacade(config.descriptorFile, config.statusFile, dependencies)
    this.hostAutostart = dependencies.hostAutostart
      ?? (config.autoStart === true
        ? new HarnessHostAutostartFacade(
          config.descriptorFile,
          this.diagnostics.statusFile,
          config.autoStartTimeoutMs ?? 120_000,
        )
        : null)
    this.local.setRequestHandler(ListToolsRequestSchema, request => this.listTools(request.params?.cursor))
    this.local.setRequestHandler(CallToolRequestSchema, request => this.callTool(request.params.name, request.params.arguments, request.params._meta))
  }

  async connect(localTransport: Transport): Promise<void> {
    if (this.connected) throw new Error('DSH Relay stdio proxy is already connected')
    await this.local.connect(localTransport)
    this.connected = true
    await this.ensureRemote()
  }

  async close(): Promise<void> {
    const remote = this.remote
    this.remote = null
    this.remoteAuthorityKey = null
    await Promise.allSettled([this.local.close(), remote?.close()])
    this.connected = false
  }

  private async listTools(cursor?: string): Promise<{ tools: RemoteTools; nextCursor?: string }> {
    const remote = this.remote
    if (remote === null) {
      this.beginRemoteRefresh()
      return { tools: cursor === undefined ? [...await this.localToolCatalog(), ...(this.hasWakeTools() ? wakeTools : [])] : [] }
    }
    try {
      const page = await remote.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.config.requestTimeoutMs })
      this.lastError = null
      return {
        tools: cursor === undefined
          ? [doctorTool, ...page.tools.filter(tool => tool.name !== doctorTool.name && (!this.hasWakeTools() || !wakeTools.some(w => w.name === tool.name))).map(decorateMonitoringTool), ...(this.hasWakeTools() ? wakeTools : [])]
          : page.tools.filter(tool => tool.name !== doctorTool.name).map(decorateMonitoringTool),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }
    } catch (error) {
      await this.invalidateRemote(this.diagnostics.remoteFailure(error))
      return { tools: cursor === undefined ? [...await this.localToolCatalog(), ...(this.hasWakeTools() ? wakeTools : [])] : [] }
    }
  }

  private async callTool(name: string, args: Record<string, unknown> | undefined, meta?: unknown): Promise<object> {
    if (this.hasWakeTools() && wakeTools.some(tool => tool.name === name)) {
      try {
        let ownedRun: RunSnapshot | undefined
        if (name === 'watch_run') {
          const input = watchInput.parse(args ?? {})
          const result = await this.callTool('get_run', { runId: input.runId }) as CallToolResult
          const snapshot = result.structuredContent as unknown as RunSnapshot | undefined
          if (result.isError || snapshot?.runId !== input.runId) throw new Error('owned run unavailable')
          ownedRun = snapshot
        }
        const context = await this.resolveWakeContext(meta, ownedRun)
        if (name === 'watch_run') await this.awaitWorkerBinding(context)
        const result = await callWakeTool(context, this.config.clientPrincipalId, name, args ?? {}, async runId => {
          if (ownedRun?.runId === runId) return ownedRun
          const remote = await this.callTool('get_run', { runId }) as { isError?: boolean; structuredContent?: RunSnapshot }
          if (remote.isError || !remote.structuredContent) throw new Error('owned run unavailable')
          return remote.structuredContent
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
      } catch (error) {
        if (error instanceof WakeCursorExpiredError) return {
          isError: true,
          content: [{ type: 'text', text: 'Durable replay cursor expired after acknowledged retention. Resynchronize retained events and verify owned runs with get_run.' }],
          structuredContent: { code: error.code, resynchronization: { earliestCursor: error.earliestCursor, latestCursor: error.latestCursor, nextAction: 'replay-without-cursor-then-get-run' } },
        }
        return { isError: true, content: [{ type: 'text', text: 'Durable wake unavailable or unauthorized. Keep using wait_run; no background-wake acknowledgement was issued.' }] }
      }
    }
    if (name === doctorTool.name) {
      if (this.remote === null) this.beginRemoteRefresh()
      const report = await this.diagnostics.doctor(relayVersion, this.remote !== null, this.lastError)
      return doctorResult(report)
    }
    if (!await this.ensureRemote()) return this.unavailableResult(name, this.requireFailure())
    const remote = this.remote
    if (remote === null) return this.unavailableResult(name, this.requireFailure())
    try {
      const detail = args?.detail ?? 'brief'
      if (name === 'wait_run' && detail !== 'brief' && detail !== 'full') {
        return { isError: true, content: [{ type: 'text', text: 'wait_run detail must be brief or full.' }] }
      }
      const forwarded = name === 'wait_run' && args ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'detail')) : args
      const result = await remote.callTool(
        { name, ...(forwarded === undefined ? {} : { arguments: forwarded }) },
        undefined,
        { timeout: this.config.requestTimeoutMs },
      ) as CallToolResult
      const monitored = ['start_run', 'start_review', 'get_run', 'wait_run'].includes(name)
      const wakeAvailable = monitored && !result.isError
        ? await this.prepareWakeHint(meta, result.structuredContent as unknown as WakeRunSnapshot | undefined)
        : false
      if (name === 'wait_run') return projectWaitResult(result, { detail: detail as 'brief' | 'full', wakeAvailable })
      return wakeAvailable ? withWakeHint(result) : result
    } catch (error) {
      if (isRequestTimeout(error)) return this.requestTimeoutResult(name, this.config.requestTimeoutMs)
      const routeFailure = this.diagnostics.remoteFailure(error)
      await this.invalidateRemote(routeFailure)
      return this.unavailableResult(name, routeFailure)
    }
  }

  private hasWakeTools(): boolean {
    return this.config.wake !== undefined || this.config.wakeByThread !== undefined
  }

  private async resolveWakeContext(meta: unknown, run?: WakeRunSnapshot) {
    if (this.config.wake !== undefined) return this.config.wake
    const outbox = this.config.wakeByThread?.outbox
    if (!outbox) throw new Error('wake is not configured')
    const threadId = (meta !== null && typeof meta === 'object' && !Array.isArray(meta))
      ? (meta as Record<string, unknown>).threadId
      : undefined
    if (typeof threadId !== 'string' || !uuidPattern.test(threadId)) throw new Error('host thread binding metadata required')
    let state = await outbox.store.read()
    if (!state.bindings.some(binding => binding.threadId === threadId && binding.principal === this.config.clientPrincipalId)
      && run && this.config.wakeByThread?.ensureBinding) {
      await this.config.wakeByThread.ensureBinding(threadId, run)
      state = await outbox.store.read()
    }
    const matches = state.bindings.filter(binding => binding.threadId === threadId
      && binding.principal === this.config.clientPrincipalId && binding.enabled && binding.expiresAt > outbox.now())
    if (matches.length !== 1) throw new Error('host thread has no unique enabled wake binding')
    return { outbox, bindingId: matches[0]!.bindingId }
  }

  private async prepareWakeHint(meta: unknown, run?: WakeRunSnapshot): Promise<boolean> {
    if (!this.hasWakeTools() || !run?.runId || !run.workspace) return false
    try {
      const context = await this.resolveWakeContext(meta, run)
      return (await context.outbox.store.read()).enabled
    } catch { return false }
  }

  /** First registration waits locally for the real worker, never for model completion. */
  private async awaitWorkerBinding(context: import('../wake/tools.js').WakeToolContext): Promise<void> {
    const deadline = Date.now() + 5000
    do {
      const state = await context.outbox.store.read()
      const now = context.outbox.now()
      const binding = state.bindings.find(row => row.bindingId === context.bindingId)
      if (!state.enabled || !binding?.enabled || binding.expiresAt <= now) return
      if (state.worker?.ready && state.worker.bindingIds.includes(context.bindingId)
        && state.worker.heartbeatAt <= now && now - state.worker.heartbeatAt <= 3000) return
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
  }

  private ensureRemote(): Promise<boolean> {
    if (this.connecting !== null) return this.connecting
    this.connecting = this.refreshRemote().finally(() => { this.connecting = null })
    return this.connecting
  }

  private beginRemoteRefresh(): void {
    void this.ensureRemote().catch(error => {
      this.lastError = this.diagnostics.remoteFailure(error)
    })
  }

  private async refreshRemote(): Promise<boolean> {
    let inspected = await this.diagnostics.inspect()
    if (inspected.failure !== null && this.hostAutostart !== null) {
      inspected = await this.hostAutostart.recover(inspected, () => this.diagnostics.inspect())
    }
    if (inspected.failure !== null) {
      if (this.remote === null) this.lastError = inspected.failure
      else await this.invalidateRemote(inspected.failure)
      return false
    }
    const authorityKey = inspected.descriptor === null ? null : descriptorKey(inspected.descriptor)
    if (this.remote !== null && this.remoteAuthorityKey === authorityKey) return true
    if (this.remote !== null) {
      await this.invalidateRemote({
        code: 'RELAY_ROUTE_UNAVAILABLE',
        reasonCode: 'STALE_ENDPOINT_DESCRIPTOR',
        message: 'Embedded Relay authority lifecycle changed; reconnecting to the published endpoint.',
        retryable: true,
        remediation: 'Retry after Relay reconnects to the new authority epoch.',
      })
    }
    return this.connectRemote(inspected)
  }

  private async connectRemote(inspected: ProxyInspection): Promise<boolean> {
    if (inspected.descriptor === null || inspected.token === null) return false
    const candidate = new Client({ name: 'dsh-relay-proxy', version: relayVersion })
    const remoteTransport = new StreamableHTTPClientTransport(new URL(inspected.descriptor.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${inspected.token}`,
          'x-dsh-relay-principal': this.config.clientPrincipalId,
        },
      },
    })
    try {
      await candidate.connect(remoteTransport as unknown as Transport)
      const page = await candidate.listTools(undefined, { timeout: this.config.requestTimeoutMs })
      const becameReady = this.remote === null
      this.remote = candidate
      this.remoteAuthorityKey = descriptorKey(inspected.descriptor)
      this.lastError = null
      if (becameReady) this.notifyToolsChanged()
      return true
    } catch (error) {
      await candidate.close().catch(() => undefined)
      this.lastError = this.diagnostics.remoteFailure(error)
      return false
    }
  }

  private async invalidateRemote(routeFailure: ProxyRouteFailure): Promise<void> {
    const remote = this.remote
    const becameUnavailable = remote !== null
    this.remote = null
    this.remoteAuthorityKey = null
    this.lastError = routeFailure
    await remote?.close().catch(() => undefined)
    if (becameUnavailable) this.notifyToolsChanged()
  }

  private notifyToolsChanged(): void {
    if (!this.connected) return
    void this.local.sendToolListChanged().catch(() => undefined)
  }

  private async localToolCatalog(): Promise<RemoteTools> {
    const productTools = await this.productTools
    return [doctorTool, ...productTools.filter(tool => tool.name !== doctorTool.name).map(decorateMonitoringTool)]
  }

  private async supportsStructuredError(toolName: string): Promise<boolean> {
    const tool = (await this.productTools).find(candidate => candidate.name === toolName)
    return tool?.outputSchema === undefined
  }

  private async unavailableResult(toolName: string, routeFailure: ProxyRouteFailure): Promise<object> {
    return unavailableResult(routeFailure, await this.supportsStructuredError(toolName))
  }

  private async requestTimeoutResult(toolName: string, timeoutMs: number): Promise<object> {
    return requestTimeoutResult(toolName, timeoutMs, await this.supportsStructuredError(toolName))
  }

  private requireFailure(): ProxyRouteFailure {
    return this.lastError ?? {
      code: 'RELAY_ROUTE_UNAVAILABLE',
      reasonCode: 'REMOTE_UNAVAILABLE',
      message: 'Embedded Relay route is unavailable.',
      retryable: true,
      remediation: 'Run doctor and retry after the Harness web profile reaches ready state.',
    }
  }
}

function doctorResult(report: ProxyDoctorReport): object {
  return {
    content: [{ type: 'text', text: JSON.stringify(report) }],
    structuredContent: report,
    isError: false,
  }
}

function unavailableResult(routeFailure: ProxyRouteFailure, structuredErrors: boolean): object {
  return {
    content: [{ type: 'text', text: `${routeFailure.code}: ${routeFailure.reasonCode}: ${routeFailure.message}` }],
    ...(structuredErrors ? { structuredContent: routeFailure } : {}),
    isError: true,
  }
}

function requestTimeoutResult(toolName: string, timeoutMs: number, structuredErrors: boolean): object {
  const timeout = {
    code: 'RELAY_REQUEST_TIMEOUT',
    message: `Remote Relay tool ${JSON.stringify(toolName)} timed out after ${timeoutMs} ms.`,
    retryable: true,
    outcome: 'unknown',
    nextAction: 'inspect_or_retry_idempotently',
  }
  return {
    content: [{ type: 'text', text: `${timeout.code}: ${timeout.message}` }],
    ...(structuredErrors ? { structuredContent: timeout } : {}),
    isError: true,
  }
}

function isRequestTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === ErrorCode.RequestTimeout
}

function descriptorKey(descriptor: ProxyInspection['descriptor']): string | null {
  if (descriptor === null) return null
  return `${descriptor.authorityId}\0${descriptor.ownerEpoch}\0${descriptor.mcpUrl}`
}
