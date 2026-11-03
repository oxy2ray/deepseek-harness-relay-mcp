import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import {
  CodexDaemonClient,
  CodexDaemonRequestError,
  createCodexUnixWebSocketTransport,
} from '../src/wake/codex-daemon-client.js'
import type {
  CodexDaemonInitializeSummary,
  CodexDaemonNotification,
  CodexDaemonServerRequest,
} from '../src/wake/codex-daemon-client.js'

interface UnixWebSocketFixture {
  socketPath: string
  upgradeUrls: string[]
  upgradeHeaders: Array<http.IncomingHttpHeaders>
  clientMessages: Array<Record<string, unknown>>
  closeCodes: number[]
  close: () => Promise<void>
}

type RequestHandler = (message: Record<string, unknown>, socket: WebSocket) => void

/** Real controlled server: AF_UNIX socket + HTTP Upgrade + WebSocket framing. */
async function startUnixWebSocketServer(onRequest: RequestHandler): Promise<UnixWebSocketFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-ws-'))
  const socketPath = join(dir, 'control.sock')
  const upgradeUrls: string[] = []
  const upgradeHeaders: Array<http.IncomingHttpHeaders> = []
  const clientMessages: Array<Record<string, unknown>> = []
  const closeCodes: number[] = []

  const httpServer = http.createServer((_request, response) => {
    response.writeHead(426)
    response.end()
  })
  const wsServer = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (request, socket, head) => {
    upgradeUrls.push(request.url ?? '')
    upgradeHeaders.push(request.headers)
    wsServer.handleUpgrade(request, socket, head, ws => {
      ws.on('close', code => { closeCodes.push(code) })
      ws.on('message', data => {
        const message = JSON.parse(String(data)) as Record<string, unknown>
        clientMessages.push(message)
        onRequest(message, ws)
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(socketPath, () => { resolve() })
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const ws of wsServer.clients) ws.terminate()
    await new Promise<void>(resolve => { wsServer.close(() => { resolve() }) })
    await new Promise<void>(resolve => { httpServer.close(() => { resolve() }) })
    await rm(dir, { recursive: true, force: true })
  }

  return { socketPath, upgradeUrls, upgradeHeaders, clientMessages, closeCodes, close }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for controlled fixture condition')
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  }
}

function tick(ms = 25): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

test('initialize and thread metadata run over a real Unix WebSocket control socket', async () => {
  const initializedNotifications: Array<Record<string, unknown>> = []
  let modelRequestId: unknown = null

  const fixture = await startUnixWebSocketServer((message, socket) => {
    const method = typeof message.method === 'string' ? message.method : ''
    if (method === 'initialize') {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          userAgent: 'codex-app-server/0.166.0-fixture (unix; x86_64)',
          platformFamily: 'unix',
          platformOs: 'linux',
          codexHome: '/private/codex',
        },
      }))
      return
    }
    if (method === 'initialized') {
      initializedNotifications.push(message)
      return
    }
    if (method === 'model/list') {
      // Deferred so the reply can arrive out of order with `thread/read`.
      modelRequestId = message.id
      return
    }
    if (method === 'thread/read') {
      const params = message.params as { threadId?: string }
      assert.equal(params.threadId, 'thread-a')
      // Out-of-order reply for the earlier request, then an unknown id.
      socket.send(JSON.stringify({ id: modelRequestId, result: { models: ['fixture-model'] } }))
      socket.send(JSON.stringify({ id: 99, result: { ignored: true } }))
      socket.send(JSON.stringify({
        method: 'thread/status/changed',
        params: { threadId: 'thread-a', status: { type: 'idle' } },
      }))
      socket.send(JSON.stringify({
        id: 'approval-1',
        method: 'execCommandApproval',
        params: { conversationId: 'thread-a', command: ['fixture'] },
      }))
      socket.send(JSON.stringify({
        id: message.id,
        result: { thread: { id: 'thread-a', name: 'Fixture thread', status: { type: 'idle' }, canAcceptDirectInput: true } },
      }))
      return
    }
  })

  const transport = createCodexUnixWebSocketTransport({ socket: fixture.socketPath })
  const client = new CodexDaemonClient({
    transport,
    requestTimeoutMs: 2000,
    clientInfo: { name: 'dsh-relay-codex-daemon-client-fixture', title: null, version: '1' },
  })
  const notifications: CodexDaemonNotification[] = []
  const serverRequests: CodexDaemonServerRequest[] = []
  client.onNotification(notification => { notifications.push(notification) })
  client.onServerRequest(request => { serverRequests.push(request) })

  try {
    assert.equal(transport.kind, 'unix-websocket')

    const summary: CodexDaemonInitializeSummary = await client.initialize()
    assert.deepEqual(summary, {
      userAgent: 'codex-app-server/0.166.0-fixture (unix; x86_64)',
      platformFamily: 'unix',
      platformOs: 'linux',
      codexHome: '/private/codex',
    })
    await waitFor(() => initializedNotifications.length === 1)

    const modelsPromise = client.request('model/list', {})
    const readPromise = client.request('thread/read', { threadId: 'thread-a', includeTurns: false })
    assert.deepEqual(await modelsPromise, { models: ['fixture-model'] })
    assert.deepEqual(await readPromise, {
      thread: { id: 'thread-a', name: 'Fixture thread', status: { type: 'idle' }, canAcceptDirectInput: true },
    })

    await waitFor(() => notifications.length >= 1)
    await waitFor(() => serverRequests.length === 1)
    assert.equal(notifications[0]?.method, 'thread/status/changed')
    assert.deepEqual(notifications[0]?.params, { threadId: 'thread-a', status: { type: 'idle' } })
    assert.deepEqual(serverRequests, [{ id: 'approval-1', method: 'execCommandApproval' }])
    assert.equal(client.serverRequestCount, 1)
    assert.equal(client.malformedMessageCount, 0)

    // The HTTP Upgrade really happened on the Unix socket.
    await waitFor(() => fixture.upgradeUrls.length === 1)
    assert.deepEqual(fixture.upgradeUrls, ['/'])
    assert.equal(fixture.upgradeHeaders[0]?.upgrade, 'websocket')
    assert.ok(typeof fixture.upgradeHeaders[0]?.['sec-websocket-key'] === 'string')

    // Inbound server requests are recorded and never answered.
    await tick()
    assert.equal(fixture.clientMessages.some(message => message.id === 'approval-1'), false)
    assert.deepEqual(fixture.clientMessages.map(message => message.id), [1, undefined, 2, 3])

    // Clean close: this client's WebSocket closes; outstanding work is rejected.
    const outstanding = client.request('model/list', {})
    const closing = client.close()
    await assert.rejects(outstanding, (error: unknown) => {
      assert.ok(error instanceof CodexDaemonRequestError)
      assert.equal(error.category, 'connection')
      assert.equal(error.outcomeUncertain, true)
      return true
    })
    await closing
    assert.equal(client.disconnected, true)
    assert.equal(transport.closed, true)
    await waitFor(() => fixture.closeCodes.length === 1)
    assert.equal(fixture.closeCodes[0], 1000)
    await client.close()
    assert.equal(fixture.closeCodes.length, 1)
  } finally {
    await client.close().catch(() => {})
    await fixture.close()
  }
})

test('a raw byte socket without an HTTP Upgrade is a bounded connection failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-raw-'))
  const socketPath = join(dir, 'control.sock')
  const rawServer = net.createServer(socket => {
    // Consume the raw bytes so the paused stream can end and close.
    socket.resume()
    socket.on('error', () => {})
    socket.write(`${JSON.stringify({ id: 1, result: { userAgent: 'raw-bytes' } })}\n`)
  })
  await new Promise<void>((resolve, reject) => {
    rawServer.once('error', reject)
    rawServer.listen(socketPath, () => { resolve() })
  })

  const transport = createCodexUnixWebSocketTransport({ socket: socketPath, handshakeTimeoutMs: 2000 })
  const client = new CodexDaemonClient({ transport, requestTimeoutMs: 2000 })

  try {
    await assert.rejects(client.initialize(), (error: unknown) => {
      assert.ok(error instanceof CodexDaemonRequestError)
      assert.equal(error.category, 'connection')
      assert.match(error.message, /daemon (control socket|transport)/u)
      return true
    })
  } finally {
    await client.close()
    await new Promise<void>(resolve => { rawServer.close(() => { resolve() }) })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing Unix socket path is a bounded connection failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-missing-'))
  const socketPath = join(dir, `missing-${randomUUID()}.sock`)

  const transport = createCodexUnixWebSocketTransport({ socket: socketPath })
  const client = new CodexDaemonClient({ transport, requestTimeoutMs: 2000 })

  try {
    await assert.rejects(client.initialize(), (error: unknown) => {
      assert.ok(error instanceof CodexDaemonRequestError)
      assert.equal(error.category, 'connection')
      return true
    })
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('serverRequest/resolved retires the inbound record without ever answering it', async () => {
  const fixture = await startUnixWebSocketServer((message, socket) => {
    const method = typeof message.method === 'string' ? message.method : ''
    if (method === 'probe/error') {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'connection lost' } }))
      return
    }
    if (method === 'initialize') {
      socket.send(JSON.stringify({
        id: message.id,
        result: { userAgent: 'codex-fixture/0.166', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' },
      }))
      return
    }
    if (method === 'thread/read') {
      socket.send(JSON.stringify({
        id: 'approval-1', method: 'execCommandApproval', params: { conversationId: 'thread-a' },
      }))
      socket.send(JSON.stringify({
        method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 'approval-1' },
      }))
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-a', cwd: '/workspace', status: { type: 'idle' } } } }))
      return
    }
  })

  const transport = createCodexUnixWebSocketTransport({ socket: fixture.socketPath })
  const client = new CodexDaemonClient({ transport, requestTimeoutMs: 2000 })
  const recorded: CodexDaemonServerRequest[] = []
  const notifications: CodexDaemonNotification[] = []
  client.onServerRequest(request => { recorded.push(request) })
  client.onNotification(notification => { notifications.push(notification) })

  try {
    await client.initialize()
    await client.request('thread/read', { threadId: 'thread-a', includeTurns: false })
    await waitFor(() => notifications.some(notification => notification.method === 'serverRequest/resolved'))
    // The request was recorded, then retired by its requestId.
    assert.deepEqual(recorded, [{ id: 'approval-1', method: 'execCommandApproval' }])
    assert.equal(client.serverRequestCount, 0)
    await assert.rejects(client.request('probe/error'), (error: unknown) => {
      assert.ok(error instanceof CodexDaemonRequestError)
      assert.equal(error.origin, 'server')
      return true
    })
    // And it was never answered: no client frame replies to the approval id.
    await tick()
    assert.equal(fixture.clientMessages.some(message => message.id === 'approval-1'), false)
    assert.equal(fixture.clientMessages.some(message => message.method === 'execCommandApproval'), false)
  } finally {
    await client.close().catch(() => {})
    await fixture.close()
  }
})

test('transport rejects unsafe socket paths before opening a connection', () => {
  assert.throws(
    () => createCodexUnixWebSocketTransport({ socket: '' }),
    /explicit daemon socket path required/u,
  )
  assert.throws(
    () => createCodexUnixWebSocketTransport({ socket: '/tmp/a\nb.sock' }),
    /single-line filesystem path/u,
  )
  assert.throws(
    () => createCodexUnixWebSocketTransport({ socket: 'a'.repeat(4097) }),
    /explicit daemon socket path required/u,
  )
})
