/**
 * Reusable, bounded client for an ALREADY RUNNING Codex app-server daemon.
 *
 * Transport evidence (public official sources in the permitted runtime subtree):
 *   - `daemon-client.rs` connects an AF_UNIX stream to the daemon control socket
 *     and performs a WebSocket HTTP Upgrade against `ws://localhost/`:
 *     `client_async("ws://localhost/", UnixStream::connect(socket))`.
 *   - `stdio-to-uds.rs` only copies raw bytes between stdio and the Unix socket;
 *     it performs no HTTP Upgrade, so `codex app-server proxy` cannot carry the
 *     daemon control protocol. The earlier raw-stdio transport was therefore a
 *     wrong assumption and is retired here.
 *
 * The client owns exactly one short-lived Unix WebSocket connection. It
 * deliberately does not:
 *   - start, restart or stop the daemon (the daemon lifecycle is not ours),
 *   - spawn proxy/daemon processes,
 *   - expose a TCP/network target (the WebSocket URL is fixed and the only
 *     socket is a `node:net` stream bound to the operator-provided Unix path),
 *   - read or copy auth/config files (no filesystem access at all),
 *   - unlink the socket,
 *   - approve server requests (inbound requests are only recorded for the caller),
 *   - change thread settings or submit turns,
 *   - connect to Relay RPC.
 *
 * Protocol shapes mirror the generated Codex 0.166 app-server types in the
 * permitted runtime subtree (`InitializeParams`, `InitializeCapabilities`,
 * `InitializeResponse`, `ThreadReadParams` with `includeTurns: false`, and
 * `ThreadReadResponse`). Only the fields this module actually consumes are
 * restated locally so the module has no dependency on that private subtree.
 */
import net from 'node:net'
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000
const DEFAULT_CLOSE_GRACE_MS = 2000
const MAX_PENDING_REQUESTS = 64
const MAX_INBOUND_BYTES = 4 * 1024 * 1024
const MAX_SERVER_REQUESTS = 128
const MAX_METHOD_LENGTH = 200
const MAX_USER_AGENT_LENGTH = 200
const MAX_BUFFERED_LINES = 32
const MAX_QUEUED_SENDS = 64

/**
 * The official daemon control socket speaks WebSocket over AF_UNIX with the
 * HTTP Upgrade URL `ws://localhost/`. The URL is fixed: it is never resolved to
 * a TCP target because the socket is supplied by `createConnection`.
 */
export const CODEX_DAEMON_WS_URL = 'ws://localhost/'

export type CodexDaemonRequestCategory =
  | 'unsupported'
  | 'unauthorized'
  | 'not-found'
  | 'timeout'
  | 'connection'
  | 'busy'
  | 'failed'

/** Error surfaced to callers; never carries server-provided text. */
export class CodexDaemonRequestError extends Error {
  readonly method: string
  readonly code: number | null
  readonly category: CodexDaemonRequestCategory
  readonly outcomeUncertain: boolean

  constructor(
    method: string,
    code: number | null,
    category: CodexDaemonRequestCategory,
    message: string,
    outcomeUncertain = false,
    readonly origin: 'local' | 'server' = 'local',
  ) {
    super(message)
    this.name = 'CodexDaemonRequestError'
    this.method = method
    this.code = code
    this.category = category
    this.outcomeUncertain = outcomeUncertain
  }
}

export interface CodexDaemonInitializeSummary {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export interface CodexDaemonNotification {
  method: string
  params: unknown
}

export interface CodexDaemonServerRequest {
  id: string | number
  method: string
}

export interface CodexDaemonClientOptions {
  transport: CodexDaemonTransport
  requestTimeoutMs?: number
  clientInfo?: { name: string; title: string | null; version: string }
}

export interface CodexDaemonTransport {
  /** Concrete transport in use; only the Unix WebSocket transport exists. */
  readonly kind: 'unix-websocket'
  /** True once this client's transport has been closed (never the daemon). */
  readonly closed: boolean
  send(line: string): void
  onLine(listener: (line: string) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
  /** Closes only this client's WebSocket. Never touches the daemon or socket file. */
  close(): Promise<void>
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: string, max: number): string {
  // Server text is untrusted: strip control characters and cap the length.
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max)
}

function assertSingleLinePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`explicit ${label} required`)
  }
  if (/[\u0000\r\n]/u.test(value)) throw new Error(`${label} must be a single-line filesystem path`)
  return value
}

/** Keeps only a system-style error code; raw error text is never retained. */
function failureText(prefix: string, error: unknown): string {
  const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(error.code)
    ? error.code
    : null
  return code === null ? prefix : `${prefix} (${code})`
}

function frameToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export interface CodexUnixWebSocketTransportOptions {
  /** Operator-provided AF_UNIX path of the already running daemon control socket. */
  socket: string
  handshakeTimeoutMs?: number
  closeGraceMs?: number
}

/**
 * Unix WebSocket transport for the daemon control socket.
 *
 * The only socket is a `node:net` stream connected to the operator-provided
 * filesystem path; there is no host/port, no TCP fallback and no proxy child.
 * Each WebSocket text frame carries one JSON-RPC document. `send` only writes
 * over this client's WebSocket and `close` only closes it.
 */
export class CodexUnixWebSocketTransport implements CodexDaemonTransport {
  readonly kind = 'unix-websocket' as const
  private readonly ws: WebSocket
  private ownSocket: net.Socket | null = null
  private readonly graceMs: number
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private bufferedLines: string[] = []
  private queuedSends: string[] = []
  private closedFlag = false
  private failureNotified: Error | null = null
  private closePromise: Promise<void> | null = null

  constructor(options: CodexUnixWebSocketTransportOptions) {
    const socketPath = assertSingleLinePath(options.socket, 'daemon socket path')
    this.graceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    this.ws = new WebSocket(CODEX_DAEMON_WS_URL, {
      handshakeTimeout: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: MAX_INBOUND_BYTES,
      // Backed ONLY by the operator-provided Unix path; never a network target.
      createConnection: () => {
        const socket = net.connect({ path: socketPath })
        // Prevent an unhandled socket error when the WebSocket handshake aborts
        // before it attaches its own listeners; failures surface via `ws`.
        socket.on('error', () => { /* surfaced through the WebSocket handshake */ })
        this.ownSocket = socket
        return socket
      },
    })

    this.ws.on('open', () => { this.flushQueuedSends() })
    this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => { this.receive(data) })
    this.ws.on('unexpected-response', () => {
      this.fail('daemon control socket refused the WebSocket upgrade')
    })
    this.ws.on('error', (error: Error & { code?: string }) => {
      this.fail(failureText('daemon control socket error', error))
    })
    this.ws.on('close', () => { this.fail('daemon control socket closed') })
  }

  get closed(): boolean {
    return this.closedFlag
  }

  send(line: string): void {
    if (this.closedFlag) throw new Error('daemon control socket transport is closed')
    if (typeof line !== 'string' || /[\r\n]/u.test(line)) {
      throw new Error('daemon messages must be single-line JSON')
    }
    if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      throw new Error('daemon control socket is not open')
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      // The WebSocket handshake is asynchronous; queue until `open`.
      if (this.queuedSends.length >= MAX_QUEUED_SENDS) throw new Error('daemon control socket is not open')
      this.queuedSends.push(line)
      return
    }
    this.write(line)
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    if (this.bufferedLines.length > 0) {
      const queued = this.bufferedLines
      this.bufferedLines = []
      for (const line of queued) listener(line)
    }
    return () => { this.lineListeners.delete(listener) }
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (this.failureNotified) {
      listener(this.failureNotified)
      return () => {}
    }
    this.failureListeners.add(listener)
    return () => { this.failureListeners.delete(listener) }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.dispose()
    return this.closePromise
  }

  private fail(message: string): void {
    if (this.closedFlag || this.failureNotified) return
    this.queuedSends = []
    const failure = new Error(message)
    this.failureNotified = failure
    for (const listener of this.failureListeners) listener(failure)
    this.failureListeners.clear()
    // A failed handshake must not leave the AF_UNIX stream dangling.
    try { this.ws.terminate() } catch { /* already gone */ }
    this.ownSocket?.destroy()
  }

  private write(line: string): void {
    this.ws.send(line, error => {
      if (error) this.fail('daemon control socket write failed')
    })
  }

  private flushQueuedSends(): void {
    if (this.closedFlag || this.ws.readyState !== WebSocket.OPEN) return
    const queued = this.queuedSends
    this.queuedSends = []
    for (const line of queued) this.write(line)
  }

  private receive(data: Buffer | ArrayBuffer | Buffer[]): void {
    if (this.closedFlag) return
    const text = frameToString(data)
    if (text.length === 0) return
    if (Buffer.byteLength(text) > MAX_INBOUND_BYTES) {
      this.fail('daemon control socket message exceeded the bounded framing limit')
      return
    }
    // The daemon sends one JSON document per text frame; tolerate newline framing.
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      this.deliver(line)
    }
  }

  private deliver(line: string): void {
    if (this.lineListeners.size === 0) {
      if (this.bufferedLines.length < MAX_BUFFERED_LINES) this.bufferedLines.push(line)
      return
    }
    for (const listener of this.lineListeners) listener(line)
  }

  private async dispose(): Promise<void> {
    this.closedFlag = true
    this.queuedSends = []
    const ws = this.ws
    if (ws.readyState === WebSocket.CLOSED) {
      this.ownSocket?.destroy()
      return
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      // Abort the handshake and destroy only this client's socket.
      try { ws.terminate() } catch { /* already gone */ }
      this.ownSocket?.destroy()
      return
    }
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.ownSocket?.destroy()
        try { ws.terminate() } catch { /* already gone */ }
        finish()
      }, this.graceMs)
      ws.once('close', finish)
      try {
        ws.close(1000, 'client closing')
      } catch {
        this.ownSocket?.destroy()
        try { ws.terminate() } catch { /* already gone */ }
        finish()
      }
    })
    this.ownSocket?.destroy()
  }
}

export function createCodexUnixWebSocketTransport(
  options: CodexUnixWebSocketTransportOptions,
): CodexDaemonTransport {
  return new CodexUnixWebSocketTransport(options)
}

function classifyRequestError(message: string): CodexDaemonRequestCategory {
  if (/not supported|unsupported|unknown method/iu.test(message)) return 'unsupported'
  if (/unauthor|forbidden|401|403/iu.test(message)) return 'unauthorized'
  if (/not found|not materialized|no rollout|404/iu.test(message)) return 'not-found'
  return 'failed'
}

/**
 * Correlated JSON-RPC-style client over an owned Unix WebSocket transport.
 * Inbound server requests are recorded, never answered.
 */
export class CodexDaemonClient {
  private readonly options: CodexDaemonClientOptions
  private readonly events = new EventEmitter()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly serverRequests = new Map<string | number, string>()
  private detachListeners: (() => void) | null = null
  private nextId = 0
  private connected = false
  private closed = false
  private malformedMessages = 0
  private notificationCount = 0
  private initializePromise: Promise<CodexDaemonInitializeSummary> | null = null
  private closePromise: Promise<void> | null = null

  constructor(options: CodexDaemonClientOptions) {
    this.options = options
  }

  get transport(): CodexDaemonTransport {
    return this.options.transport
  }

  get disconnected(): boolean {
    return this.closed
  }

  get serverRequestCount(): number {
    return this.serverRequests.size
  }

  get malformedMessageCount(): number {
    return this.malformedMessages
  }

  get receivedNotificationCount(): number {
    return this.notificationCount
  }

  /** Attaches transport listeners; idempotent and safe to call before requests. */
  connect(): void {
    if (this.closed) throw new Error('daemon client is closed')
    if (this.connected) return
    this.connected = true
    const offLine = this.options.transport.onLine(line => { this.receive(line) })
    const offFailure = this.options.transport.onFailure(error => { this.fail(error) })
    this.detachListeners = () => { offLine(); offFailure() }
  }

  onNotification(listener: (notification: CodexDaemonNotification) => void): () => void {
    const handler = (value: unknown) => listener(value as CodexDaemonNotification)
    this.events.on('notification', handler)
    return () => { this.events.off('notification', handler) }
  }

  onServerRequest(listener: (request: CodexDaemonServerRequest) => void): () => void {
    const handler = (value: unknown) => listener(value as CodexDaemonServerRequest)
    this.events.on('serverRequest', handler)
    return () => { this.events.off('serverRequest', handler) }
  }

  onDisconnected(listener: () => void): () => void {
    const handler = () => listener()
    this.events.on('disconnected', handler)
    return () => { this.events.off('disconnected', handler) }
  }

  /** Performs `initialize` plus the `initialized` notification exactly once. */
  initialize(): Promise<CodexDaemonInitializeSummary> {
    this.initializePromise ??= this.runInitialize()
    return this.initializePromise
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (typeof method !== 'string' || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
      return Promise.reject(new CodexDaemonRequestError('invalid', null, 'failed', 'explicit request method required'))
    }
    if (this.closed) {
      return Promise.reject(new CodexDaemonRequestError(method, null, 'connection', 'daemon client is closed; request not sent'))
    }
    if (!Number.isSafeInteger(this.nextId)) {
      return Promise.reject(new CodexDaemonRequestError(method, null, 'busy', 'request id space exhausted'))
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new CodexDaemonRequestError(method, null, 'busy', 'too many pending daemon requests'))
    }
    this.connect()
    const id = ++this.nextId
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexDaemonRequestError(method, null, 'timeout', 'daemon request outcome uncertain; no correlated reply arrived', true))
      }, timeout)
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer })
      try {
        this.options.transport.send(JSON.stringify({ id, method, params }))
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CodexDaemonRequestError(method, null, 'connection', 'daemon transport unavailable; request not sent'))
      }
    })
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) throw new Error('daemon client is closed')
    this.connect()
    this.options.transport.send(JSON.stringify({ method, params }))
  }

  /** Rejects outstanding requests and closes only the owned WebSocket. */
  async close(): Promise<void> {
    this.closePromise ??= this.runClose()
    return this.closePromise
  }

  private async runClose(): Promise<void> {
    this.closed = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new CodexDaemonRequestError(
        pending.method, null, 'connection',
        'daemon client closed before the request completed; outcome uncertain', true,
      ))
    }
    this.serverRequests.clear()
    this.detachListeners?.()
    this.detachListeners = null
    this.emitSafely('disconnected')
    await this.options.transport.close()
  }

  private async runInitialize(): Promise<CodexDaemonInitializeSummary> {
    this.connect()
    const clientInfo = this.options.clientInfo
      ?? { name: 'dsh-relay-codex-daemon-client', title: null, version: '1' }
    const result = await this.request<unknown>('initialize', {
      clientInfo: { name: clientInfo.name, title: clientInfo.title, version: clientInfo.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    if (!isRecord(result)) throw new Error('daemon initialize response is malformed')
    const userAgent = typeof result.userAgent === 'string' ? boundedText(result.userAgent, MAX_USER_AGENT_LENGTH) : ''
    const platformFamily = typeof result.platformFamily === 'string' ? boundedText(result.platformFamily, 64) : ''
    const platformOs = typeof result.platformOs === 'string' ? boundedText(result.platformOs, 64) : ''
    if (userAgent === '' || platformFamily === '' || platformOs === '') {
      throw new Error('daemon initialize response is malformed')
    }
    this.notify('initialized', {})
    return { userAgent, platformFamily, platformOs, codexHome: typeof result.codexHome === 'string' ? result.codexHome : '' }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new CodexDaemonRequestError(
        pending.method, null, 'connection',
        `daemon connection lost (${error.message}); outcome uncertain`, true,
      ))
    }
    this.serverRequests.clear()
    this.detachListeners?.()
    this.detachListeners = null
    this.emitSafely('disconnected')
  }

  private emitSafely(event: string, value?: unknown): void {
    try {
      if (value === undefined) this.events.emit(event)
      else this.events.emit(event, value)
    } catch { /* Listener faults must not break protocol framing. */ }
  }

  /**
   * The official `serverRequest/resolved` notification retires a recorded request.
   * Bookkeeping only: this client never answers, approves or rejects a server
   * request — it just forgets that the request is still outstanding.
   */
  private retireServerRequest(params: unknown): void {
    if (!isRecord(params)) return
    const requestId = params.requestId
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return
    this.serverRequests.delete(requestId)
  }

  private receive(line: string): void {
    if (this.closed) return
    let message: unknown
    try { message = JSON.parse(line) } catch {
      this.malformedMessages += 1
      return
    }
    if (!isRecord(message)) {
      this.malformedMessages += 1
      return
    }
    const id = message.id
    const method = message.method
    if (typeof method === 'string') {
      const requestId = typeof id === 'number' || typeof id === 'string' ? id : null
      if (requestId !== null) {
        if (this.serverRequests.size >= MAX_SERVER_REQUESTS) {
          this.fail(new Error('daemon sent too many server requests'))
          return
        }
        // Record only the method: params may contain conversation content and are never retained.
        this.serverRequests.set(requestId, method)
        this.emitSafely('serverRequest', { id: requestId, method })
        return
      }
      this.notificationCount += 1
      if (method === 'serverRequest/resolved') this.retireServerRequest(message.params)
      this.emitSafely('notification', { method, params: message.params })
      return
    }
    if (typeof id !== 'number') {
      this.malformedMessages += 1
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    if (!('result' in message) && !('error' in message)) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in message) {
      const error = isRecord(message.error) ? message.error : {}
      const serverText = typeof error.message === 'string' ? error.message : ''
      const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : null
      const category = classifyRequestError(serverText)
      pending.reject(new CodexDaemonRequestError(
        pending.method, code, category,
        `Codex request failed (method=${pending.method}, category=${category}, code=${code ?? 'unknown'})`,
        false, 'server',
      ))
      return
    }
    pending.resolve(message.result)
  }
}
