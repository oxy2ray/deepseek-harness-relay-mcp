import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureAutoBindingWith, type AutoBindClient, type AutoBindDeps,
} from '../src/wake/auto-binding.js'
import { ExistingCodexHost, type ExistingCodexClient } from '../src/wake/existing-codex-host.js'
import { DEFAULT_AUTO_BIND_TTL_MS, readExistingWakeConfig } from '../src/wake/existing-config.js'
import { WakeOutbox } from '../src/wake/outbox.js'
import { WakeStore } from '../src/wake/store.js'
import type { WakeBinding, WakeRunSnapshot } from '../src/wake/schema.js'

const policy = (workspaceRoots: string[], ttlMs = 604_800_000) => ({ workspaceRoots, ttlMs })

class FakeDaemonClient implements AutoBindClient {
  disconnected = false
  closed = false
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  constructor(
    private readonly thread: { id: string; cwd: string; canAcceptDirectInput?: boolean },
    private readonly codexHome = '/tmp/codex-home',
  ) {}

  async initialize(): Promise<unknown> {
    this.calls.push({ method: 'initialize', params: {} })
    return { codexHome: this.codexHome, userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' }
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params: params as Record<string, unknown> })
    if (method === 'thread/read') {
      return {
        thread: {
          id: this.thread.id,
          cwd: this.thread.cwd,
          canAcceptDirectInput: this.thread.canAcceptDirectInput ?? true,
          status: { type: 'idle' },
        },
      } as T
    }
    throw new Error(`unexpected method ${method}`)
  }

  async close(): Promise<void> { this.closed = true }
}

function fakeDeps(thread: { id: string; cwd: string; canAcceptDirectInput?: boolean }) {
  const clients: FakeDaemonClient[] = []
  const deps: AutoBindDeps = {
    connect: () => { const client = new FakeDaemonClient(thread); clients.push(client); return client },
    uid: () => 1000,
  }
  return { deps, clients }
}

function runSnapshot(workspace: string): WakeRunSnapshot {
  return {
    runId: 'run-1', sessionId: 'session-1', workspace, status: 'succeeded',
    lastEventSeq: 3, permissionPreset: 'read-only', taskScope: undefined,
  }
}

async function makeOutbox(enabled = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-bind-')))
  const outbox = new WakeOutbox(new WakeStore(join(base, 'wake-state.json')))
  if (enabled) await outbox.setEnabled(true)
  return { base, outbox }
}

test('a new UUID enrolls once and repeats return the identical persisted binding', async () => {
  const { base, outbox } = await makeOutbox()
  const root = join(base, 'root')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const threadId = randomUUID()
  const { deps, clients } = fakeDeps({ id: threadId, cwd })

  const first = await ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run: runSnapshot(cwd),
  }, deps)
  assert.equal(first.bindingId, `auto-${threadId}`)
  assert.equal(first.threadId, threadId)
  assert.equal(first.workspace, cwd)
  assert.equal(first.principal, 'user-1')
  assert.equal(first.enabled, true)
  assert.deepEqual((await outbox.store.read()).bindings, [first])
  // The short-lived client read the exact thread and was closed.
  assert.deepEqual(clients[0]?.calls.map(call => call.method), ['initialize', 'thread/read'])
  assert.deepEqual(clients[0]?.calls[1]?.params, { threadId, includeTurns: false })
  assert.equal(clients[0]?.closed, true)

  const second = await ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run: runSnapshot(cwd),
  }, fakeDeps({ id: threadId, cwd }).deps)
  assert.deepEqual(second, first)
  assert.deepEqual((await outbox.store.read()).bindings, [first])
})

test('threads whose cwd is outside or escapes the canonical root are denied', async () => {
  const { base, outbox } = await makeOutbox()
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(root, 'escape'))

  const foreign = randomUUID()
  await assert.rejects(ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId: foreign,
    run: runSnapshot(outside),
  }, fakeDeps({ id: foreign, cwd: outside }).deps), /outside the configured auto-bind workspace roots/)

  const escaped = randomUUID()
  await assert.rejects(ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId: escaped,
    run: runSnapshot(join(root, 'escape')),
  }, fakeDeps({ id: escaped, cwd: join(root, 'escape') }).deps), /outside the configured auto-bind workspace roots/)
  assert.deepEqual((await outbox.store.read()).bindings, [])
})

test('a disabled or expired existing binding is returned unchanged, never renewed or re-enabled', async () => {
  const { base, outbox } = await makeOutbox()
  const root = join(base, 'root')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const threadId = randomUUID()
  const input = { outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run: runSnapshot(cwd) }
  const created = await ensureAutoBindingWith(input, fakeDeps({ id: threadId, cwd }).deps)

  // Simulate the operator holding this binding: paused and already past expiry.
  await outbox.store.transaction(state => {
    const row = state.bindings.find(binding => binding.bindingId === created.bindingId)!
    row.enabled = false
    row.expiresAt = 1
  })
  const held = (await outbox.store.read()).bindings[0]!
  const again = await ensureAutoBindingWith(input, fakeDeps({ id: threadId, cwd }).deps)
  assert.deepEqual(again, held)
  assert.equal(again.enabled, false)
  assert.equal(again.expiresAt, 1)
  assert.equal((await outbox.store.read()).bindings.length, 1)

  // A global pause also does not disturb the held row, and blocks a new thread.
  await outbox.setEnabled(false)
  assert.deepEqual(await ensureAutoBindingWith(input, fakeDeps({ id: threadId, cwd }).deps), held)
  const fresh = randomUUID()
  await assert.rejects(ensureAutoBindingWith({
    ...input, threadId: fresh, run: runSnapshot(cwd),
  }, fakeDeps({ id: fresh, cwd }).deps), /globally paused/)
  assert.equal((await outbox.store.read()).bindings.length, 1)
})

test('a thread bound to another principal is rejected instead of replaced', async () => {
  const { base, outbox } = await makeOutbox()
  const root = join(base, 'root')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const threadId = randomUUID()
  await ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run: runSnapshot(cwd),
  }, fakeDeps({ id: threadId, cwd }).deps)
  await assert.rejects(ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-2', policy: policy([root]), threadId, run: runSnapshot(cwd),
  }, fakeDeps({ id: threadId, cwd }).deps), /already bound to a different principal/)
})

test('an incompatible mapped run is rejected before any immutable binding exists', async () => {
  const { base, outbox } = await makeOutbox()
  const root = join(base, 'root')
  const cwd = root
  const relayWorkspace = join(root, 'project')
  await mkdir(relayWorkspace, { recursive: true })
  await writeFile(join(relayWorkspace, 'file.txt'), 'x')
  const threadId = randomUUID()
  const deps = fakeDeps({ id: threadId, cwd })
  const run: WakeRunSnapshot = {
    ...runSnapshot(relayWorkspace),
    taskScope: { reviewTargets: ['file.txt'], contextReadScope: ['file.txt'], excludedPaths: [], writeScope: ['file.txt'], enforcement: 'instruction-only' },
  }
  await assert.rejects(ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run,
  }, deps.deps), /read-only taskScope/)
  assert.deepEqual((await outbox.store.read()).bindings, [])

  // A complete read-only scope physically inside the daemon cwd is accepted.
  const compatible: WakeRunSnapshot = {
    ...run,
    taskScope: { reviewTargets: ['file.txt'], contextReadScope: ['file.txt'], excludedPaths: [], writeScope: [], enforcement: 'instruction-only' },
  }
  const binding = await ensureAutoBindingWith({
    outbox, socket: '/tmp/codex.sock', principal: 'user-1', policy: policy([root]), threadId, run: compatible,
  }, fakeDeps({ id: threadId, cwd }).deps)
  assert.equal(binding.workspace, cwd)
  assert.equal(binding.relayWorkspace, relayWorkspace)
})

class FakeHostClient implements ExistingCodexClient {
  disconnected = false
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  constructor(private readonly workspaces: Map<string, string>) {}
  async initialize(): Promise<unknown> { return {} }
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const p = params as Record<string, unknown>
    this.calls.push({ method, params: p })
    if (['thread/turns/list', 'thread/items/list', 'thread/queue/list'].includes(method)) {
      return { data: [], nextCursor: null } as T
    }
    if (method === 'thread/resume' || method === 'thread/read') {
      const threadId = String(p.threadId)
      return { thread: { id: threadId, cwd: this.workspaces.get(threadId), status: { type: 'idle', activeFlags: [] } } } as T
    }
    throw new Error(`unexpected method ${method}`)
  }
}

test('a host with zero configured threads becomes capable after its first dynamic attach', async () => {
  const client = new FakeHostClient(new Map([['thread-dynamic', '/workspace/dynamic']]))
  const host = await ExistingCodexHost.attach({
    client, socket: '/tmp/codex.sock', codexHome: '/tmp/codex-home', uid: 1000, bindings: [],
  })
  assert.equal((await host.capabilities()).authenticated, false)
  assert.equal((await host.capabilities()).exclusiveIdleAdmission, false)

  await host.attachBindings([{ threadId: 'thread-dynamic', workspace: '/workspace/dynamic' }])
  const capability = await host.capabilities()
  assert.equal(capability.authenticated, true)
  assert.equal(capability.durableHistory, true)

  // Only the exact thread is resumed, with no thread settings read or changed.
  const resumes = client.calls.filter(call => call.method === 'thread/resume')
  assert.deepEqual(resumes.map(call => call.params), [{ threadId: 'thread-dynamic', excludeTurns: true }])
  assert.equal(client.calls.some(call => call.method === 'thread/read'), false)

  const binding: WakeBinding = {
    bindingId: 'auto-thread-dynamic', threadId: 'thread-dynamic', workspace: '/workspace/dynamic',
    principal: 'user-1', serverIdentity: capability.serverIdentity, enabled: true, expiresAt: Date.now() + 1000,
  }
  assert.equal((await host.inspect(binding)).threadId, 'thread-dynamic')

  // Repeating the attachment preserves the recorded thread instead of retargeting it.
  await host.attachBindings([{ threadId: 'thread-dynamic', workspace: '/workspace/dynamic' }])
  assert.equal(client.calls.filter(call => call.method === 'thread/resume').length, 1)
  await assert.rejects(host.attachBindings([{ threadId: 'thread-dynamic', workspace: '/workspace/other' }]), /workspace mismatch/)
})

test('the wake config declares auto-bind only when present, with the default TTL', async () => {
  const { base } = await makeOutbox(false)
  const baseFields = {
    schemaVersion: 1, socket: join(base, 'daemon.sock'), wakeState: join(base, 'state.json'),
    relayDescriptor: join(base, 'relay.json'), principal: 'user-1', enabled: true, bindings: [],
  }
  const plain = join(base, 'plain.json')
  await writeFile(plain, JSON.stringify(baseFields))
  assert.equal((await readExistingWakeConfig(plain))?.autoBind, undefined)

  const auto = join(base, 'auto.json')
  await writeFile(auto, JSON.stringify({ ...baseFields, autoBind: { workspaceRoots: [base] } }))
  const parsed = await readExistingWakeConfig(auto)
  assert.deepEqual(parsed?.autoBind, { workspaceRoots: [base], ttlMs: DEFAULT_AUTO_BIND_TTL_MS })

  const relativeRoot = join(base, 'relative.json')
  await writeFile(relativeRoot, JSON.stringify({ ...baseFields, autoBind: { workspaceRoots: ['relative'] } }))
  await assert.rejects(readExistingWakeConfig(relativeRoot))
})
