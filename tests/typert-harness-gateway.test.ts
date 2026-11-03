import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTypertHarnessGateway,
  HostRpcError,
  type TypertGatewayPort,
  type TypertPeerScope,
} from '../src/harness-gateway/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

const peer: TypertPeerScope = {
  id: 'relay-test-peer', ctx: {}, principal: { kind: 'owner' },
  signal: new AbortController().signal, interactions: 'none',
  async dispose() {},
}

test('Typert adapter consumes Workspace and Session baselines from Harness 0.1.2 streams', async () => {
  const typert = new RecordingTypertGateway()
  const gateway = createTypertHarnessGateway(typert, permissions(), peer)

  assert.deepEqual(await gateway.listWorkspaces(), {
    items: [workspace],
    archivedSessionIds: ['archived-1'],
  })
  assert.deepEqual(await gateway.listSessions(), [{
    sessionId: 'session-1',
    updatedAt: 1,
    running: false,
    blank: false,
    projections: { asOfSeq: 8, values: { agentPreset: 'coding' } },
    agentPreset: 'coding',
  }])
  assert.deepEqual(typert.streamCalls.map(call => `${call.namespace}.${call.method}`), ['workspace.follow'])
  assert.deepEqual(typert.invokeCalls[0], { namespace: 'session', method: 'list', args: { _request: {} }, peer })
  assert.equal(typert.invokeCalls[0]?.peer, peer)
  assert.equal(typert.streamCalls[0]?.peer, peer)
})

test('Typert adapter maps Session follow/page history and current projections', async () => {
  const typert = new RecordingTypertGateway()
  const gateway = createTypertHarnessGateway(typert, permissions(), peer)

  const latest = await gateway.readHistory({ sessionId: 'session-1', maxMessages: 100 })
  assert.equal(latest.events[0]?.event.type, 'assistant/message')
  assert.equal(latest.projections?.asOfSeq, 8)

  const previous = await gateway.readHistory({ sessionId: 'session-1', maxMessages: 100, beforeSeq: 8 })
  assert.equal(previous.events[0]?.event.seq, 4)
  assert.deepEqual(typert.invokeCalls.at(-1), {
    namespace: 'session',
    method: 'page',
    peer,
    args: {
      request: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 8,
        beforeSeq: 8,
        maxMessages: 100,
      },
    },
  })
})

test('Typert adapter persists the Relay request id before direct prompt dispatch', async () => {
  const order: string[] = []
  const typert = new RecordingTypertGateway(order)
  const gateway = createTypertHarnessGateway(typert, permissions(), peer)

  const accepted = await gateway.submitPrompt(
    'session-1',
    'queue',
    [{ type: 'text', text: 'review' }],
    'relay-request-1',
    async rpcId => { order.push(`persist:${rpcId}`) },
  )

  assert.deepEqual(accepted, { accepted: true, rpcId: 'relay-request-1' })
  assert.deepEqual(order, ['persist:relay-request-1', 'invoke:session.prompt'])
  assert.deepEqual(typert.invokeCalls.at(-1)?.args, {
    request: {
      requestId: 'relay-request-1',
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'review' }],
    },
  })
})

test('Typert adapter preserves new namespaced business and transient error codes', async () => {
  const business = createTypertHarnessGateway(new ThrowingTypertGateway('session/not-found'), permissions(), peer)
  await assert.rejects(business.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'session/not-found')
    assert.equal(error.definitiveRejection, true)
    return true
  })

  const transient = createTypertHarnessGateway(new ThrowingTypertGateway('gateway/internal'), permissions(), peer)
  await assert.rejects(transient.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'gateway/internal')
    assert.equal(error.retryable, true)
    return true
  })

  const unavailable = createTypertHarnessGateway(new ThrowingTypertGateway('gateway/context-unavailable'), permissions(), peer)
  await assert.rejects(unavailable.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'gateway/context-unavailable')
    assert.equal(error.retryable, true)
    return true
  })
})

test('Typert archive operations keep the admitted Peer and explicitly refuse stopActivity', async () => {
  const typert = new RecordingTypertGateway()
  const gateway = createTypertHarnessGateway(typert, permissions(), peer)

  assert.deepEqual(await gateway.archiveSession('session-1'), { archivedSessionIds: ['session-1'] })
  assert.deepEqual(await gateway.unarchiveSession('session-1'), { archivedSessionIds: [] })
  assert.deepEqual(typert.invokeCalls.slice(-2).map(({ namespace, method, args, peer: actualPeer }) => ({
    namespace, method, args, samePeer: actualPeer === peer,
  })), [
    { namespace: 'workspace', method: 'archiveSession', args: { request: { sessionId: 'session-1', stopActivity: false } }, samePeer: true },
    { namespace: 'workspace', method: 'unarchiveSession', args: { request: { sessionId: 'session-1' } }, samePeer: true },
  ])
})

test('Typert archive preserves native active-session rejection and translates a missing method', async () => {
  const active = createTypertHarnessGateway(new ThrowingTypertGateway('workspace/session-active'), permissions(), peer)
  await assert.rejects(active.archiveSession('session-1'), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'workspace/session-active')
    assert.equal(error.retryable, false)
    return true
  })

  const oldHost = createTypertHarnessGateway(new ThrowingTypertGateway('TYPERT_METHOD_NOT_FOUND'), permissions(), peer)
  await assert.rejects(oldHost.archiveSession('session-1'), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'HOST_API_INCOMPATIBLE')
    assert.match(error.message, /update the Host and reconnect/u)
    return true
  })

  const unrelatedMissing = createTypertHarnessGateway(new ThrowingTypertGateway('TYPERT_METHOD_NOT_FOUND'), permissions(), peer)
  await assert.rejects(unrelatedMissing.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'TYPERT_METHOD_NOT_FOUND')
    return true
  })
})

test('Typert adapter preserves Host rejection after its Peer is disposed on both call paths', async () => {
  const lifetime = new AbortController()
  const scopedPeer: TypertPeerScope = {
    ...peer, signal: lifetime.signal,
    async dispose() { lifetime.abort() },
  }
  const validate = (request: Parameters<TypertGatewayPort['invoke']>[0]) => {
    assert.equal(request.peer, scopedPeer)
    if (request.peer.signal.aborted) {
      throw Object.assign(new Error('the calling Peer has been disposed'), { code: 'gateway/peer-disposed' })
    }
  }
  const gateway = createTypertHarnessGateway({
    async invoke(request) { validate(request); return { items: [] } },
    async stream(request) { validate(request); return values({ type: 'baseline', value: { items: [], archivedSessionIds: [] } }) },
  }, permissions(), scopedPeer)
  assert.deepEqual(await gateway.listSessions(), [])
  await gateway.listWorkspaces()
  await scopedPeer.dispose()
  for (const operation of [() => gateway.listSessions(), () => gateway.listWorkspaces()]) {
    await assert.rejects(operation, (error: unknown) => {
      assert(error instanceof HostRpcError)
      assert.equal(error.code, 'gateway/peer-disposed')
      return true
    })
  }
})

const workspace = {
  workspaceId: 'workspace-1',
  path: 'D:\\workspace',
  title: 'workspace',
  sessionIds: ['session-1'],
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

class RecordingTypertGateway implements TypertGatewayPort {
  readonly invokeCalls: Array<Parameters<TypertGatewayPort['invoke']>[0]> = []
  readonly streamCalls: Array<Parameters<TypertGatewayPort['stream']>[0]> = []

  constructor(private readonly order: string[] = []) {}

  async invoke(request: Parameters<TypertGatewayPort['invoke']>[0]): Promise<unknown> {
    assert.equal(request.peer, peer, 'new Host requires the exact admitted Peer on unary calls')
    this.invokeCalls.push(request)
    this.order.push(`invoke:${request.namespace}.${request.method}`)
    if (request.namespace === 'session' && request.method === 'list') {
      return {
        items: [{
          sessionId: 'session-1', updatedAt: 1, running: false, blank: false,
          projections: { asOfSeq: 8, values: { agentPreset: 'coding' } },
        }],
      }
    }
    if (request.namespace === 'session' && request.method === 'page') {
      return { records: [{ type: 'event', event: event(4) }], hasMore: false }
    }
    if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
    if (request.namespace === 'workspace' && request.method === 'archiveSession') return { archivedSessionIds: ['session-1'] }
    if (request.namespace === 'workspace' && request.method === 'unarchiveSession') return { archivedSessionIds: [] }
    throw new Error(`unexpected invocation ${request.namespace}.${request.method}`)
  }

  async stream(request: Parameters<TypertGatewayPort['stream']>[0]): Promise<AsyncIterable<unknown>> {
    assert.equal(request.peer, peer, 'new Host requires the exact admitted Peer on streams')
    this.streamCalls.push(request)
    if (request.namespace === 'workspace' && request.method === 'follow') {
      return values({ type: 'baseline', value: { items: [workspace], archivedSessionIds: ['archived-1'] } })
    }
    if (request.namespace === 'session' && request.method === 'follow') {
      return values({
        type: 'snapshot',
        cursor: 8,
        records: [{ type: 'event', event: event(8) }],
        hasMore: true,
        projections: { asOfSeq: 8, values: { permissions: { currentValue: 'workspace-write' } } },
      })
    }
    throw new Error(`unexpected stream ${request.namespace}.${request.method}`)
  }
}

class ThrowingTypertGateway implements TypertGatewayPort {
  constructor(private readonly code: string) {}
  async invoke(): Promise<unknown> {
    throw Object.assign(new Error('fixture failure'), { code: this.code, details: { fixture: true } })
  }
  async stream(): Promise<AsyncIterable<unknown>> { return values() }
}

function permissions(): PermissionGatewayFacade {
  let current = 'workspace-write' as const
  const provider: PermissionProvider = {
    async readCurrent() { return current },
    async select(_sessionId, preset) { current = preset as typeof current; return { accepted: true } },
  }
  return new PermissionGatewayFacade(provider)
}

function event(seq: number) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { message: { content: [{ type: 'text', text: `result-${seq}` }] } },
  }
}

async function* values(...items: unknown[]): AsyncGenerator<unknown> {
  yield* items
}
